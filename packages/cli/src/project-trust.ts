// Project trust (P50: split out of main.ts, like pi's cli/project-trust.ts). Project resources
// are arbitrary code, so they load only from a directory the user trusted; the record pins a
// digest of what was reviewed, and changed content asks again (P15, D20).
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { digestDirectory, listExtensionFiles } from "@yophon/tau-host-node";
import type { ExtensionRegistry, UiCapability } from "@yophon/tau-kernel";
import { localSettingsIsRepoFile } from "./permissions.ts";
import { dim, userHome } from "./util.ts";

// ---------------------------------------------------------------------------
// Project trust gate: project extensions are arbitrary code, so loading them
// from an untrusted directory would be remote code execution by `cd`. Since
// P15 a trusted record also pins a content digest of the extensions directory;
// changed content re-triggers the question (a trust decision covers what was
// reviewed, not whatever lands there later).
// ---------------------------------------------------------------------------

/** Legacy entries were plain booleans (no digest); they are upgraded on first load. */
export type TrustEntry = boolean | { trusted: boolean; digest?: string };

export interface TrustStore {
	trusted: Record<string, TrustEntry>;
}

export function trustStorePath(): string {
	return join(userHome(), ".tau", "trust.json");
}

export function readTrustStore(): TrustStore {
	try {
		// Strip a BOM: an unreadable store reads as empty, and the next write would erase every other record.
		const parsed = JSON.parse(readFileSync(trustStorePath(), "utf8").replace(/^\uFEFF/, "")) as TrustStore;
		return { trusted: parsed.trusted ?? {} };
	} catch {
		return { trusted: {} };
	}
}

export function writeTrustStore(store: TrustStore): void {
	const path = trustStorePath();
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(store, null, "\t")}\n`, "utf8");
}

/**
 * Project-local resources that load only from a trusted directory (P23c, pi): code,
 * settings that pick endpoints or credentials, and skills/prompts that reach the
 * system prompt.
 */
export const GATED_PROJECT_RESOURCES = [
	".tau/extensions",
	".tau/settings.json",
	// P37a: the project's MCP servers were read only when trusted but never asked about.
	".tau/mcp.json",
	// P45: language servers are programs the project would start.
	".tau/lsp.json",
	".tau/skills",
	".tau/prompts",
	".pi/settings.json",
	".pi/skills",
	".pi/prompts",
	// P41 (pi): the Agent Skills directory and the system prompt files.
	".agents/skills",
	".tau/SYSTEM.md",
	".tau/APPEND_SYSTEM.md",
] as const;

export function presentGatedResources(cwd: string): string[] {
	const present: string[] = GATED_PROJECT_RESOURCES.filter((relative) => existsSync(join(cwd, relative)));
	// P41a (pi hasTrustRequiringProjectResources): .agents/skills in a parent directory counts too,
	// except the user's own ~/.agents/skills ($HOME's, and the system's home when HOME points elsewhere).
	const userAgentsSkills = new Set([resolve(userHome(), ".agents", "skills"), resolve(homedir(), ".agents", "skills")]);
	for (let dir = resolve(cwd); dirname(dir) !== dir; ) {
		dir = dirname(dir);
		const skills = join(dir, ".agents", "skills");
		if (!userAgentsSkills.has(resolve(skills)) && existsSync(skills)) {
			present.push(relative(cwd, skills).replaceAll("\\", "/"));
		}
	}
	// The local permissions file counts when the repository supplies it (git tracks it, P37a).
	if (localSettingsIsRepoFile(cwd)) present.push(".tau/settings.local.json");
	return present;
}

/**
 * Content digest of the gated resources (D20-5: a change asks again). A project
 * with only .tau/extensions keeps the pre-P23 digest of that directory, so
 * existing trust records stay valid.
 */
export async function digestProjectResources(cwd: string, present: readonly string[]): Promise<string | undefined> {
	if (present.length === 1 && present[0] === ".tau/extensions") return digestDirectory(join(cwd, ".tau/extensions"));
	const hash = createHash("sha256");
	for (const relative of present) {
		const path = join(cwd, relative);
		const digest = statSync(path).isDirectory()
			? await digestDirectory(path)
			: createHash("sha256").update(readFileSync(path)).digest("hex");
		hash.update(`${relative}\0${digest ?? ""}\n`);
	}
	return hash.digest("hex");
}

export async function isProjectTrusted(
	registry: ExtensionRegistry,
	cwd: string,
	ui: UiCapability | undefined,
	present: readonly string[],
): Promise<boolean> {
	const store = readTrustStore();
	const digest = await digestProjectResources(cwd, present);
	const recorded = store.trusted[cwd];
	if (recorded !== undefined) {
		const entry = typeof recorded === "boolean" ? { trusted: recorded } : recorded;
		// A denial needs no integrity check — nothing was loaded, nothing changes that.
		if (!entry.trusted) return false;
		if (entry.digest === undefined) {
			// Pre-P15 record: backfill the digest without re-asking, once.
			store.trusted[cwd] = { trusted: true, digest };
			writeTrustStore(store);
			console.log(dim("Recorded a content digest for this project's extensions (older trust entry had none)."));
			return true;
		}
		if (entry.digest === digest) return true;
		console.log(dim("Project resources changed since they were last trusted — confirming again."));
	}

	// Global (always-trusted) extensions may decide via the project_trust event.
	const decision = await registry.runProjectTrust(cwd, { ui, messages: [] });
	if (decision.trusted !== "undecided") {
		const trusted = decision.trusted === "yes";
		if (decision.remember) {
			store.trusted[cwd] = { trusted, digest };
			writeTrustStore(store);
		}
		return trusted;
	}

	if (!ui) return false; // headless + no valid record = reject
	const approved = await ui.confirm(
		"Trust this directory and load its project resources?",
		`${cwd}\n${present.join(", ")}`,
	);
	store.trusted[cwd] = { trusted: approved, digest };
	writeTrustStore(store);
	return approved;
}

/** Record a trust decision for the project's current resources (the TUI's /trust); applies from the next start or /reload. */
export async function saveProjectTrust(cwd: string, trusted: boolean): Promise<string[]> {
	const projectFiles = await listExtensionFiles(join(cwd, ".tau", "extensions"));
	const present = presentGatedResources(cwd).filter(
		(relative) => relative !== ".tau/extensions" || projectFiles.length > 0,
	);
	const store = readTrustStore();
	store.trusted[cwd] = { trusted, digest: await digestProjectResources(cwd, present) };
	writeTrustStore(store);
	return present;
}
