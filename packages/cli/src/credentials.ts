// The credential store (P32b): ~/.tau/credentials.json, 0600, written only by
// `tau credentials`. Configuration refers to a credential as ${cred:<name>}; the
// host resolves it when it connects or calls a provider, and the value is
// registered for masking, so it does not reach the model in tool output.
// Like pi's auth.json and Claude Code off macOS, it is a plain file: the OS
// keychain is a possible later backend, not part of P32.
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { registerSecret, SECRET_NAME_RE } from "./secrets.ts";

const CREDENTIAL_NAME_RE = /^[a-z0-9_-]{1,64}$/;

export interface CredentialEntry {
	value: string;
	note?: string;
	createdAt: number;
}

interface CredentialFile {
	version: 1;
	credentials: Record<string, CredentialEntry>;
}

export function credentialsPath(home: string): string {
	return join(home, ".tau", "credentials.json");
}

function writePrivate(path: string, content: string): void {
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const temp = `${path}.${process.pid}.tmp`;
	writeFileSync(temp, content, { encoding: "utf8", mode: 0o600 });
	try {
		chmodSync(temp, 0o600);
	} catch {
		// Windows has no POSIX modes.
	}
	renameSync(temp, path);
}

export class CredentialStore {
	readonly file: string;

	constructor(file: string) {
		this.file = file;
	}

	private read(): CredentialFile {
		if (!existsSync(this.file)) return { version: 1, credentials: {} };
		try {
			const parsed = JSON.parse(readFileSync(this.file, "utf8")) as Partial<CredentialFile>;
			return {
				version: 1,
				credentials: parsed.credentials && typeof parsed.credentials === "object" ? parsed.credentials : {},
			};
		} catch (error) {
			throw new Error(`${this.file}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	names(): Array<{ name: string; note?: string; createdAt: number }> {
		return Object.entries(this.read().credentials)
			.map(([name, entry]) => ({ name, ...(entry.note ? { note: entry.note } : {}), createdAt: entry.createdAt }))
			.sort((a, b) => a.name.localeCompare(b.name));
	}

	/** The value, registered for masking; undefined when there is no such credential. */
	get(name: string): string | undefined {
		const value = this.read().credentials[name]?.value;
		registerSecret(value, `cred:${name}`);
		return value;
	}

	set(name: string, value: string, note?: string): void {
		if (!CREDENTIAL_NAME_RE.test(name))
			throw new Error("A credential name is lowercase letters, digits, - and _ (at most 64)");
		if (value === "") throw new Error("The value is empty");
		const data = this.read();
		data.credentials[name] = { value, ...(note ? { note } : {}), createdAt: Date.now() };
		writePrivate(this.file, `${JSON.stringify(data, null, "\t")}\n`);
	}

	remove(name: string): boolean {
		const data = this.read();
		if (!(name in data.credentials)) return false;
		delete data.credentials[name];
		writePrivate(this.file, `${JSON.stringify(data, null, "\t")}\n`);
		return true;
	}

	/** Register every value for masking (at startup, before any tool runs). */
	registerAll(): void {
		for (const [name, entry] of Object.entries(this.read().credentials)) registerSecret(entry.value, `cred:${name}`);
	}
}

/** The home a ${cred:…} reference resolves against when the caller has none: HOME or USERPROFILE. */
export function defaultCredentialLookup(env: Record<string, string | undefined>): (name: string) => string | undefined {
	return (name) => {
		const home = env.HOME ?? env.USERPROFILE;
		if (!home) return undefined;
		try {
			return new CredentialStore(credentialsPath(home)).get(name);
		} catch {
			return undefined;
		}
	};
}

const REF_RE = /\$\{(cred:[a-z0-9_-]{1,64}|[A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g;

/**
 * Expand ${VAR}, ${VAR:-default} and ${cred:name} inside a string (mcp.json).
 * `allowCredentials` false (a project file) refuses ${cred:…} and reads
 * secret-looking variables as empty, so a cloned repository cannot send your
 * keys to a server it names (Claude Code). Unresolved names are reported.
 */
export function expandRefs(
	text: string,
	options: {
		env: Record<string, string | undefined>;
		credential: (name: string) => string | undefined;
		allowCredentials: boolean;
	},
): { value: string; missing: string[]; blocked: string[] } {
	const missing: string[] = [];
	const blocked: string[] = [];
	const value = text.replace(REF_RE, (_match, ref: string, fallback: string | undefined) => {
		if (ref.startsWith("cred:")) {
			const name = ref.slice(5);
			if (!options.allowCredentials) {
				blocked.push(ref);
				return "";
			}
			const resolved = options.credential(name);
			if (resolved === undefined) missing.push(ref);
			return resolved ?? "";
		}
		if (!options.allowCredentials && SECRET_NAME_RE.test(ref)) {
			blocked.push(ref);
			return fallback ?? "";
		}
		const resolved = options.env[ref];
		if (resolved === undefined || resolved === "") {
			if (fallback !== undefined) return fallback;
			missing.push(ref);
			return "";
		}
		if (SECRET_NAME_RE.test(ref)) registerSecret(resolved, ref);
		return resolved;
	});
	return { value, missing, blocked };
}

/** Every ${cred:name} reference in a text. */
export function credentialRefs(text: string): string[] {
	return [...text.matchAll(/\$\{cred:([a-z0-9_-]{1,64})\}/g)].map((match) => match[1] as string);
}

export interface AuditFinding {
	code: "PLAINTEXT_FOUND" | "REF_UNRESOLVED";
	file: string;
	where: string;
	detail: string;
}

/** A value that is written out rather than referenced ($NAME, ${…}, !command). */
function literal(value: string): boolean {
	return value !== "" && !value.startsWith("$") && !value.startsWith("!") && !value.includes("${");
}

/**
 * Look for secrets written in plain text and references that resolve to nothing
 * (OpenClaw's `secrets audit`), in the user's config files.
 */
export function auditCredentials(home: string, store: CredentialStore): AuditFinding[] {
	const findings: AuditFinding[] = [];
	const names = new Set(store.names().map((entry) => entry.name));
	const files = [
		join(home, ".tau", "models.json"),
		join(home, ".tau", "mcp.json"),
		join(home, ".tau", "settings.json"),
		join(home, ".tau", "gateway", "config.json"),
	];
	for (const file of files) {
		if (!existsSync(file)) continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(readFileSync(file, "utf8").replace(/^﻿/, ""));
		} catch {
			continue;
		}
		const visit = (value: unknown, path: string[]): void => {
			if (typeof value === "string") {
				const key = path.at(-1) ?? "";
				const header = path.includes("headers") && /^authorization$/i.test(key);
				if ((SECRET_NAME_RE.test(key) || header) && literal(value) && value.length >= 8) {
					findings.push({
						code: "PLAINTEXT_FOUND",
						file,
						where: path.join("."),
						detail: "written out; use ${cred:<name>}",
					});
				}
				if (header && /^bearer\s+[^$]/i.test(value)) {
					findings.push({ code: "PLAINTEXT_FOUND", file, where: path.join("."), detail: "bearer token written out" });
				}
				for (const name of credentialRefs(value)) {
					if (!names.has(name)) {
						findings.push({ code: "REF_UNRESOLVED", file, where: path.join("."), detail: `no credential "${name}"` });
					}
				}
				return;
			}
			if (Array.isArray(value)) {
				for (const [index, item] of value.entries()) visit(item, [...path, String(index)]);
			} else if (value && typeof value === "object") {
				for (const [key, item] of Object.entries(value)) visit(item, [...path, key]);
			}
		};
		visit(parsed, []);
	}
	return findings;
}

/** Which config files refer to each credential (for `tau credentials list`). */
export function credentialUsage(home: string): Map<string, string[]> {
	const usage = new Map<string, string[]>();
	for (const file of ["models.json", "mcp.json", "settings.json", join("gateway", "config.json")]) {
		const path = join(home, ".tau", file);
		if (!existsSync(path)) continue;
		for (const name of new Set(credentialRefs(readFileSync(path, "utf8")))) {
			usage.set(name, [...(usage.get(name) ?? []), file]);
		}
	}
	return usage;
}
