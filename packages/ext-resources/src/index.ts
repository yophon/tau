import type { Extension, ExtensionContext, FileInfo, FileSystem } from "@yophon/tau-kernel";

export interface Skill {
	name: string;
	description: string;
	content: string;
	filePath: string;
	disableModelInvocation?: boolean;
}

export interface PromptTemplate {
	name: string;
	description?: string;
	argumentHint?: string;
	content: string;
	filePath: string;
}

export interface ResourceDiagnostic {
	type: "warning";
	code: "list_failed" | "read_failed" | "invalid_metadata" | "invalid_frontmatter" | "collision" | "missing_path";
	message: string;
	path: string;
}

/** A list given as is, or read when the resources load (P41: hosts whose settings change on /reload). */
type PathList = string[] | (() => string[]);

export interface ResourcesExtensionOptions {
	/** Explicit skill paths (pi --skill): always loaded, last; a file or a directory. */
	skillPaths?: PathList;
	/** Explicit prompt template paths (pi --prompt-template): always loaded, last. */
	promptPaths?: PathList;
	/** false = no conventional directories (the package's own or the host's). */
	includeDefaults?: boolean;
	/** P41: the host's conventional skill directories, in order, instead of the package's (.tau/.pi under the paths). */
	defaultSkillPaths?: () => string[];
	/** P41: the host's conventional prompt directories, in order, instead of the package's. */
	defaultPromptPaths?: () => string[];
	/** P41: configured skill paths (pi settings `skills`), after the conventional ones. */
	configuredSkillPaths?: () => string[];
	/** P41: configured prompt paths (pi settings `prompts`). */
	configuredPromptPaths?: () => string[];
	/** P41 (pi -ns): only the explicit skill paths load. */
	noSkills?: () => boolean;
	/** P41 (pi -np): only the explicit prompt paths load. */
	noPrompts?: () => boolean;
	/** P41 (pi enableSkillCommands): false keeps /skill:name out of command lists; typing it still works. */
	skillCommands?: () => boolean;
}

const readList = (list: PathList | undefined): string[] => (typeof list === "function" ? list() : (list ?? []));

/**
 * The registries a skills package already serves (P41): the CLI has it built in, and a user's
 * own import file adds a second copy, possibly another installed copy of this module. One per
 * registry, keyed by its event bus (one object per registry), shared across copies.
 */
const SERVED_KEY = Symbol.for("tau.ext-resources.served");
function servedRegistries(): WeakSet<object> {
	const holder = globalThis as unknown as Record<symbol, WeakSet<object> | undefined>;
	holder[SERVED_KEY] ??= new WeakSet<object>();
	return holder[SERVED_KEY];
}

interface LoadedResources {
	skills: Skill[];
	promptTemplates: PromptTemplate[];
	skillPaths: string[];
	promptPaths: string[];
	diagnostics: ResourceDiagnostic[];
	reason: ResourceDiscoverReason;
}

type ResourceDiscoverReason = "startup" | "reload";

interface FrontmatterResult {
	metadata: Record<string, string | boolean>;
	body: string;
	/** The text opened a frontmatter block that never closed (pi 0.84.3 warns instead of treating it as body silently). */
	unclosed?: boolean;
}

/** Remove a leading UTF-8 byte order mark (pi stripBom): Windows editors write one, and it hid the frontmatter. */
function stripBom(text: string): string {
	return text.startsWith("\uFEFF") ? text.slice(1) : text;
}

/** Join path parts with the base's own separator, so a Windows base stays one spelling (dedup, diagnostics). */
function joinPath(base: string, ...parts: string[]): string {
	const separator = base.includes("\\") && !base.includes("/") ? "\\" : "/";
	let current = base.replace(/[\\/]+$/g, "");
	for (const part of parts) {
		const clean = part.replace(/^[\\/]+|[\\/]+$/g, "");
		if (clean !== "") current = `${current}${separator}${clean}`;
	}
	return current;
}

function basename(path: string): string {
	return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}

function withoutMd(name: string): string {
	return name.replace(/\.md$/i, "");
}

function parseFrontmatter(input: string): FrontmatterResult {
	const text = stripBom(input);
	if (!text.startsWith("---\n") && !text.startsWith("---\r\n")) return { metadata: {}, body: text };
	const newline = text.startsWith("---\r\n") ? "\r\n" : "\n";
	const end = text.indexOf(`${newline}---${newline}`, 4);
	if (end === -1) return { metadata: {}, body: text, unclosed: true };
	const raw = text.slice(4, end).trim();
	const metadata: Record<string, string | boolean> = {};
	for (const line of raw.split(/\r?\n/)) {
		const colon = line.indexOf(":");
		if (colon === -1) continue;
		const key = line.slice(0, colon).trim();
		let value: string | boolean = line.slice(colon + 1).trim();
		if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
			value = value.slice(1, -1);
		} else if (value === "true") {
			value = true;
		} else if (value === "false") {
			value = false;
		}
		if (key !== "") metadata[key] = value;
	}
	return { metadata, body: text.slice(end + newline.length + 3 + newline.length) };
}

function validName(name: string): boolean {
	return /^[a-z0-9-]{1,64}$/.test(name) && !name.startsWith("-") && !name.endsWith("-") && !name.includes("--");
}

function metadataString(metadata: Record<string, string | boolean>, key: string): string | undefined {
	const value = metadata[key];
	return typeof value === "string" ? value : undefined;
}

async function safeListDir(fs: FileSystem, path: string, diagnostics: ResourceDiagnostic[]): Promise<FileInfo[]> {
	try {
		return await fs.listDir(path);
	} catch (error) {
		// A conventional resource directory that does not exist is normal, not a problem (pi skips it too).
		const message = error instanceof Error ? error.message : String(error);
		if ((error as { code?: unknown } | null)?.code === "ENOENT" || /ENOENT|no such file or directory/i.test(message)) {
			return [];
		}
		diagnostics.push({
			type: "warning",
			code: "list_failed",
			message: error instanceof Error ? error.message : String(error),
			path,
		});
		return [];
	}
}

async function loadSkillFromFile(
	fs: FileSystem,
	filePath: string,
	defaultName: string,
	diagnostics: ResourceDiagnostic[],
): Promise<Skill | undefined> {
	let text: string;
	try {
		text = await fs.readTextFile(filePath);
	} catch (error) {
		diagnostics.push({
			type: "warning",
			code: "read_failed",
			message: error instanceof Error ? error.message : String(error),
			path: filePath,
		});
		return undefined;
	}
	const parsed = parseFrontmatter(text);
	if (parsed.unclosed) {
		diagnostics.push({
			type: "warning",
			code: "invalid_frontmatter",
			message: "Frontmatter opened with --- is never closed",
			path: filePath,
		});
	}
	const name = metadataString(parsed.metadata, "name") ?? defaultName;
	const description = metadataString(parsed.metadata, "description");
	if (!validName(name) || !description || description.length > 1024) {
		diagnostics.push({
			type: "warning",
			code: "invalid_metadata",
			message: `Invalid skill metadata for ${name}`,
			path: filePath,
		});
		return undefined;
	}
	return {
		name,
		description,
		content: parsed.body,
		filePath,
		disableModelInvocation: parsed.metadata["disable-model-invocation"] === true,
	};
}

/**
 * pi 1.2 loadSkillsFromDirInternal: a directory with SKILL.md is one skill and the scan stops
 * there; otherwise subdirectories are scanned (not dot directories or node_modules), and
 * standalone .md skills count only at the top of the directory.
 */
async function scanSkillDir(
	fs: FileSystem,
	dir: string,
	diagnostics: ResourceDiagnostic[],
	root = true,
): Promise<Skill[]> {
	const entries = await safeListDir(fs, dir, diagnostics);
	const skillFile = entries.find((entry) => entry.kind === "file" && entry.name === "SKILL.md");
	if (skillFile) {
		const skill = await loadSkillFromFile(fs, skillFile.path, basename(dir), diagnostics);
		return skill ? [skill] : [];
	}
	const skills: Skill[] = [];
	for (const entry of entries) {
		if (root && entry.kind === "file" && /\.md$/i.test(entry.name)) {
			const skill = await loadSkillFromFile(fs, entry.path, withoutMd(entry.name), diagnostics);
			if (skill) skills.push(skill);
		}
	}
	for (const entry of entries) {
		if (entry.kind !== "directory" || entry.name.startsWith(".") || entry.name === "node_modules") continue;
		skills.push(...(await scanSkillDir(fs, entry.path, diagnostics, false)));
	}
	return skills;
}

/** A path given explicitly (settings, --skill): its kind, or undefined with a warning when it does not exist. */
async function explicitKind(
	fs: FileSystem,
	path: string,
	what: string,
	diagnostics: ResourceDiagnostic[],
): Promise<"file" | "directory" | undefined> {
	try {
		const info = await fs.stat(path);
		if (info.kind === "directory") return "directory";
		if (info.kind === "file") return "file";
	} catch {
		// Reported below.
	}
	diagnostics.push({ type: "warning", code: "missing_path", message: `${what} path does not exist`, path });
	return undefined;
}

/** One spelling per file, so the same file reached twice loads once (pi compares real paths). */
const fileKey = (path: string): string => path.replace(/\\/g, "/").replace(/\/+/g, "/").toLowerCase();

/**
 * Skills from conventional directories (`dirs`, missing ones are fine) and explicit paths
 * (a directory or a .md file; missing ones are reported), in order. A name already taken
 * keeps the first skill (pi 1.2) and the later one is reported.
 */
export async function loadSkills(
	fs: FileSystem,
	dirs: string[],
	explicitPaths: string[] = [],
): Promise<{ skills: Skill[]; diagnostics: ResourceDiagnostic[] }> {
	const diagnostics: ResourceDiagnostic[] = [];
	const byName = new Map<string, Skill>();
	const files = new Set<string>();
	const add = (skill: Skill): void => {
		const key = fileKey(skill.filePath);
		if (files.has(key)) return;
		const existing = byName.get(skill.name);
		if (existing) {
			diagnostics.push({
				type: "warning",
				code: "collision",
				message: `Skill ${skill.name} is already loaded from ${existing.filePath}; ${skill.filePath} is skipped`,
				path: skill.filePath,
			});
			return;
		}
		byName.set(skill.name, skill);
		files.add(key);
	};
	for (const dir of dirs) for (const skill of await scanSkillDir(fs, dir, diagnostics)) add(skill);
	for (const path of explicitPaths) {
		const kind = await explicitKind(fs, path, "skill", diagnostics);
		if (kind === "directory") {
			for (const skill of await scanSkillDir(fs, path, diagnostics)) add(skill);
		} else if (kind === "file") {
			if (!/\.md$/i.test(path)) {
				diagnostics.push({
					type: "warning",
					code: "invalid_metadata",
					message: "skill path is not a markdown file",
					path,
				});
				continue;
			}
			const skill = await loadSkillFromFile(fs, path, withoutMd(basename(path)), diagnostics);
			if (skill) add(skill);
		}
	}
	return { skills: [...byName.values()], diagnostics };
}

async function loadPromptTemplateFromFile(
	fs: FileSystem,
	filePath: string,
	diagnostics: ResourceDiagnostic[],
): Promise<PromptTemplate | undefined> {
	let text: string;
	try {
		text = await fs.readTextFile(filePath);
	} catch (error) {
		diagnostics.push({
			type: "warning",
			code: "read_failed",
			message: error instanceof Error ? error.message : String(error),
			path: filePath,
		});
		return undefined;
	}
	const parsed = parseFrontmatter(text);
	if (parsed.unclosed) {
		diagnostics.push({
			type: "warning",
			code: "invalid_frontmatter",
			message: "Frontmatter opened with --- is never closed; the whole file is the template body",
			path: filePath,
		});
	}
	const name = withoutMd(basename(filePath));
	if (!validName(name)) {
		diagnostics.push({
			type: "warning",
			code: "invalid_metadata",
			message: `Invalid prompt template name ${name}`,
			path: filePath,
		});
		return undefined;
	}
	// pi: frontmatter description, else the first non-empty line held to 60 characters with "...".
	const firstLine = parsed.body.trim().split(/\r?\n/, 1)[0] ?? "";
	const fallback = firstLine.length > 60 ? `${firstLine.slice(0, 60)}...` : firstLine;
	return {
		name,
		description: metadataString(parsed.metadata, "description") || fallback,
		argumentHint: metadataString(parsed.metadata, "argument-hint"),
		content: parsed.body,
		filePath,
	};
}

/**
 * Prompt templates: the .md files directly in each conventional directory (pi), then explicit
 * paths (a .md file or a directory's .md files; missing ones are reported). A name already
 * taken keeps the first template, as skills do.
 */
export async function loadPromptTemplates(
	fs: FileSystem,
	paths: string[],
	explicitPaths: string[] = [],
): Promise<{ promptTemplates: PromptTemplate[]; diagnostics: ResourceDiagnostic[] }> {
	const diagnostics: ResourceDiagnostic[] = [];
	const byName = new Map<string, PromptTemplate>();
	const files = new Set<string>();
	const addFile = async (filePath: string): Promise<void> => {
		const key = fileKey(filePath);
		if (files.has(key)) return;
		const template = await loadPromptTemplateFromFile(fs, filePath, diagnostics);
		if (!template) return;
		const existing = byName.get(template.name);
		if (existing) {
			diagnostics.push({
				type: "warning",
				code: "collision",
				message: `Prompt template ${template.name} is already loaded from ${existing.filePath}; ${template.filePath} is skipped`,
				path: template.filePath,
			});
			return;
		}
		byName.set(template.name, template);
		files.add(key);
	};
	const addDir = async (dir: string): Promise<void> => {
		for (const entry of await safeListDir(fs, dir, diagnostics)) {
			if (entry.kind === "file" && /\.md$/i.test(entry.name)) await addFile(entry.path);
		}
	};
	for (const path of paths) await addDir(path);
	for (const path of explicitPaths) {
		const kind = await explicitKind(fs, path, "prompt template", diagnostics);
		if (kind === "directory") await addDir(path);
		else if (kind === "file") await addFile(path);
	}
	return { promptTemplates: [...byName.values()], diagnostics };
}

export function formatSkillsForSystemPrompt(skills: Skill[]): string {
	const visibleSkills = skills.filter((skill) => !skill.disableModelInvocation);
	if (visibleSkills.length === 0) return "";

	const lines = [
		"The following skills provide specialized instructions for specific tasks.",
		"Read the full skill file when the task matches its description.",
		"When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.",
		"",
		"<available_skills>",
	];
	for (const skill of visibleSkills) {
		lines.push("  <skill>");
		lines.push(`    <name>${escapeXml(skill.name)}</name>`);
		lines.push(`    <description>${escapeXml(skill.description)}</description>`);
		lines.push(`    <location>${escapeXml(skill.filePath)}</location>`);
		lines.push("  </skill>");
	}
	lines.push("</available_skills>");
	return lines.join("\n");
}

function escapeXml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&apos;");
}

/** Split a command's arguments like a shell (pi 1.4 prompt-templates.ts): quoted empty strings ("" or '') are kept (#10867). */
export function parseCommandArgs(argsString: string): string[] {
	const args: string[] = [];
	let current = "";
	// Whether a token has started, so quoted empty strings are kept as arguments.
	let hasToken = false;
	let inQuote: string | null = null;

	for (let i = 0; i < argsString.length; i++) {
		const char = argsString[i]!;
		if (inQuote) {
			if (char === inQuote) inQuote = null;
			else current += char;
		} else if (char === '"' || char === "'") {
			inQuote = char;
			hasToken = true;
		} else if (/\s/.test(char)) {
			if (hasToken) {
				args.push(current);
				current = "";
				hasToken = false;
			}
		} else {
			current += char;
			hasToken = true;
		}
	}
	if (hasToken) args.push(current);
	return args;
}

/**
 * Substitute template arguments, verbatim from pi 1.2.0 (coding-agent
 * prompt-templates.ts): one pass, so an argument containing "$@" is not expanded
 * again; `${N:-default}` / `${@:-default}` / `${ARGUMENTS:-default}` fall back
 * when the argument is missing or empty; `${@:N[:L]}` slices.
 */
export function substituteArgs(content: string, args: string[]): string {
	const allArgs = args.join(" ");
	return content.replace(
		/\$\{(\d+|ARGUMENTS|@):-([^}]*)\}|\$\{@:(\d+)(?::(\d+))?\}|\$(ARGUMENTS|@|\d+)/g,
		(
			_match: string,
			defaultTarget: string | undefined,
			defaultValue: string | undefined,
			sliceStart: string | undefined,
			sliceLength: string | undefined,
			simple: string | undefined,
		) => {
			if (defaultTarget) {
				const value =
					defaultTarget === "@" || defaultTarget === "ARGUMENTS"
						? allArgs
						: args[Number.parseInt(defaultTarget, 10) - 1];
				return value ? value : (defaultValue ?? "");
			}
			if (sliceStart) {
				let start = Number.parseInt(sliceStart, 10) - 1;
				if (start < 0) start = 0;
				if (sliceLength) return args.slice(start, start + Number.parseInt(sliceLength, 10)).join(" ");
				return args.slice(start).join(" ");
			}
			if (simple === "ARGUMENTS" || simple === "@") return allArgs;
			return args[Number.parseInt(simple ?? "0", 10) - 1] ?? "";
		},
	);
}

/** `/skill:<name> [args]` as the user message (pi _expandSkillCommand). */
export function formatSkillInvocation(skill: Skill, args = ""): string {
	const baseDir = skill.filePath.replace(/[\\/][^\\/]*$/, "");
	const block = `<skill name="${skill.name}" location="${skill.filePath}">\nReferences are relative to ${baseDir}.\n\n${skill.content.trim()}\n</skill>`;
	return args.trim() === "" ? block : `${block}\n\n${args.trim()}`;
}

export function formatPromptTemplateInvocation(template: PromptTemplate, args: string[] = []): string {
	return substituteArgs(template.content, args);
}

function unique(values: string[]): string[] {
	return [...new Set(values.filter((value) => value !== ""))];
}

export function createResourcesExtension(options: ResourcesExtensionOptions = {}): Extension {
	return (api) => {
		// A second copy in the same registry (the CLI's built-in plus a user's import file) does nothing.
		const served = servedRegistries();
		if (served.has(api.events)) return;
		served.add(api.events);
		let loaded: Promise<LoadedResources> | undefined;

		api.on("session_start", async (event, ctx) => {
			await load(ctx, event.reason === "reload" ? "reload" : "startup");
		});

		api.on("before_agent_start", async (event, ctx) => {
			const resources = await load(ctx);
			const block = formatSkillsForSystemPrompt(resources.skills);
			return block === "" ? undefined : { systemPrompt: `${event.systemPrompt}\n\n${block}`.trim() };
		});

		api.registerCommand("skills", {
			description: "List the loaded skills (/skill:<name> runs one)",
			handler: async (_args, ctx) => {
				const resources = await load(ctx);
				if (resources.skills.length === 0) {
					return `No skills loaded. Skill paths: ${resources.skillPaths.length === 0 ? "none" : resources.skillPaths.join(", ")}`;
				}
				return [
					`Skills (${resources.skills.length}) — /skill:<name> [request] runs one`,
					...resources.skills.map(
						(skill) =>
							`${skill.name}${skill.disableModelInvocation ? " (manual only)" : ""}: ${skill.description}\n  ${skill.filePath}`,
					),
				].join("\n");
			},
		});

		api.registerDiagnostic("resources", {
			description: "Loaded skills and prompt templates.",
			handler: async (ctx) => {
				const resources = await load(ctx);
				return {
					label: "resources",
					value: `${resources.skills.length} skills, ${resources.promptTemplates.length} prompts, ${resources.diagnostics.length} warnings`,
					details: [
						`reason: ${resources.reason}`,
						`skill paths: ${resources.skillPaths.length === 0 ? "none" : resources.skillPaths.join(", ")}`,
						`prompt paths: ${resources.promptPaths.length === 0 ? "none" : resources.promptPaths.join(", ")}`,
						...resources.diagnostics.slice(0, 5).map((diagnostic) => `${diagnostic.code}: ${diagnostic.path}`),
					],
				};
			},
		});

		async function load(ctx: ExtensionContext, reason: ResourceDiscoverReason = "startup"): Promise<LoadedResources> {
			if (loaded && reason !== "reload") return loaded;
			loaded = (async () => {
				const fs = ctx.capabilities?.fs;
				if (!fs) return { skills: [], promptTemplates: [], skillPaths: [], promptPaths: [], diagnostics: [], reason };
				const paths = ctx.capabilities?.paths;
				const defaultsEnabled = options.includeDefaults !== false;
				// Project skills and prompts reach the system prompt: only from a trusted project (P23c, pi).
				const projectTrusted = ctx.isProjectTrusted?.() === true;
				const projectTauDir = projectTrusted ? paths?.projectTauDir : undefined;
				const projectPiDir = projectTrusted ? paths?.projectPiDir : undefined;
				const discovered = await ctx.discoverResources?.(reason);
				const noSkills = options.noSkills?.() === true;
				const noPrompts = options.noPrompts?.() === true;
				// Conventional directories (the host's when it names them), configured, discovered; then explicit.
				const defaultSkills = options.defaultSkillPaths
					? options.defaultSkillPaths()
					: [
							...(paths?.userTauDir ? [joinPath(paths.userTauDir, "skills")] : []),
							...(projectTauDir ? [joinPath(projectTauDir, "skills")] : []),
							...(projectPiDir ? [joinPath(projectPiDir, "skills")] : []),
						];
				const defaultPrompts = options.defaultPromptPaths
					? options.defaultPromptPaths()
					: [
							...(paths?.userTauDir ? [joinPath(paths.userTauDir, "prompts")] : []),
							...(projectTauDir ? [joinPath(projectTauDir, "prompts")] : []),
							...(projectPiDir ? [joinPath(projectPiDir, "prompts")] : []),
						];
				const skillDirs = noSkills || !defaultsEnabled ? [] : unique(defaultSkills);
				const skillExplicit = unique([
					...(noSkills ? [] : [...(options.configuredSkillPaths?.() ?? []), ...(discovered?.skillPaths ?? [])]),
					...readList(options.skillPaths),
				]);
				const promptDirs = noPrompts || !defaultsEnabled ? [] : unique(defaultPrompts);
				const promptExplicit = unique([
					...(noPrompts ? [] : [...(options.configuredPromptPaths?.() ?? []), ...(discovered?.promptPaths ?? [])]),
					...readList(options.promptPaths),
				]);
				const skillPaths = [...skillDirs, ...skillExplicit];
				const promptPaths = [...promptDirs, ...promptExplicit];
				const skills = await loadSkills(fs, skillDirs, skillExplicit);
				const prompts = await loadPromptTemplates(fs, promptDirs, promptExplicit);
				const resources = {
					skills: skills.skills,
					promptTemplates: prompts.promptTemplates,
					skillPaths,
					promptPaths,
					diagnostics: [...skills.diagnostics, ...prompts.diagnostics],
					reason,
				};
				for (const template of resources.promptTemplates) {
					api.registerCommand(template.name, {
						description: template.description ?? `Prompt template ${template.name}`,
						source: "prompt",
						handler: (args) => ({
							action: "prompt",
							text: formatPromptTemplateInvocation(template, parseCommandArgs(args)),
						}),
					});
				}
				// `/skill:<name> [args]` sends the skill to the model (pi _expandSkillCommand); with
				// enableSkillCommands off (pi) the command stays out of command lists but still works.
				const listed = options.skillCommands?.() !== false;
				for (const skill of resources.skills) {
					api.registerCommand(`skill:${skill.name}`, {
						description: skill.description,
						source: "skill",
						...(listed ? {} : { hidden: true }),
						handler: (args) => ({ action: "prompt", text: formatSkillInvocation(skill, args) }),
					});
				}
				for (const diagnostic of resources.diagnostics) {
					ctx.ui?.notify(`${diagnostic.code}: ${diagnostic.message}`, "warning");
				}
				return resources;
			})();
			return loaded;
		}
	};
}

export default createResourcesExtension();
