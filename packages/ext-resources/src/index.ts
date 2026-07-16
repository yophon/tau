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
	code: "list_failed" | "read_failed" | "invalid_metadata" | "collision";
	message: string;
	path: string;
}

export interface ResourcesExtensionOptions {
	skillPaths?: string[];
	promptPaths?: string[];
	includeDefaults?: boolean;
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
}

function joinPath(base: string, ...parts: string[]): string {
	let current = base.replace(/[\\/]+$/g, "");
	for (const part of parts) {
		const clean = part.replace(/^[\\/]+|[\\/]+$/g, "");
		if (clean !== "") current = `${current}/${clean}`;
	}
	return current;
}

function basename(path: string): string {
	return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}

function withoutMd(name: string): string {
	return name.replace(/\.md$/i, "");
}

function parseFrontmatter(text: string): FrontmatterResult {
	if (!text.startsWith("---\n") && !text.startsWith("---\r\n")) return { metadata: {}, body: text };
	const newline = text.startsWith("---\r\n") ? "\r\n" : "\n";
	const end = text.indexOf(`${newline}---${newline}`, 4);
	if (end === -1) return { metadata: {}, body: text };
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

async function scanSkillDir(fs: FileSystem, dir: string, diagnostics: ResourceDiagnostic[]): Promise<Skill[]> {
	const entries = await safeListDir(fs, dir, diagnostics);
	const skillFile = entries.find((entry) => entry.kind === "file" && entry.name === "SKILL.md");
	if (skillFile) {
		const skill = await loadSkillFromFile(fs, skillFile.path, basename(dir), diagnostics);
		return skill ? [skill] : [];
	}
	const skills: Skill[] = [];
	for (const entry of entries) {
		if (entry.kind === "file" && /\.md$/i.test(entry.name)) {
			const skill = await loadSkillFromFile(fs, entry.path, withoutMd(entry.name), diagnostics);
			if (skill) skills.push(skill);
		}
	}
	for (const entry of entries) {
		if (entry.kind === "directory") skills.push(...(await scanSkillDir(fs, entry.path, diagnostics)));
	}
	return skills;
}

export async function loadSkills(
	fs: FileSystem,
	dirs: string[],
): Promise<{ skills: Skill[]; diagnostics: ResourceDiagnostic[] }> {
	const diagnostics: ResourceDiagnostic[] = [];
	const byName = new Map<string, Skill>();
	for (const dir of dirs) {
		for (const skill of await scanSkillDir(fs, dir, diagnostics)) {
			if (byName.has(skill.name)) {
				diagnostics.push({
					type: "warning",
					code: "collision",
					message: `Skill ${skill.name} was overwritten by ${skill.filePath}`,
					path: skill.filePath,
				});
			}
			byName.set(skill.name, skill);
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
	const firstLine = parsed.body.trim().split(/\r?\n/, 1)[0] ?? "";
	return {
		name,
		description: metadataString(parsed.metadata, "description") ?? firstLine.slice(0, 60),
		argumentHint: metadataString(parsed.metadata, "argument-hint"),
		content: parsed.body,
		filePath,
	};
}

export async function loadPromptTemplates(
	fs: FileSystem,
	paths: string[],
): Promise<{ promptTemplates: PromptTemplate[]; diagnostics: ResourceDiagnostic[] }> {
	const diagnostics: ResourceDiagnostic[] = [];
	const byName = new Map<string, PromptTemplate>();
	for (const path of paths) {
		const entries = await safeListDir(fs, path, diagnostics);
		for (const entry of entries) {
			if (entry.kind !== "file" || !/\.md$/i.test(entry.name)) continue;
			const template = await loadPromptTemplateFromFile(fs, entry.path, diagnostics);
			if (!template) continue;
			if (byName.has(template.name)) {
				diagnostics.push({
					type: "warning",
					code: "collision",
					message: `Prompt template ${template.name} was overwritten by ${template.filePath}`,
					path: template.filePath,
				});
			}
			byName.set(template.name, template);
		}
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

export function parseCommandArgs(argsString: string): string[] {
	const args: string[] = [];
	let current = "";
	let inQuote: string | null = null;

	for (let i = 0; i < argsString.length; i++) {
		const char = argsString[i]!;
		if (inQuote) {
			if (char === inQuote) inQuote = null;
			else current += char;
		} else if (char === '"' || char === "'") {
			inQuote = char;
		} else if (char === " " || char === "\t") {
			if (current) {
				args.push(current);
				current = "";
			}
		} else {
			current += char;
		}
	}
	if (current) args.push(current);
	return args;
}

export function substituteArgs(content: string, args: string[]): string {
	let result = content;
	result = result.replace(/\$(\d+)/g, (_, num: string) => args[Number.parseInt(num, 10) - 1] ?? "");
	result = result.replace(/\$\{@:(\d+)(?::(\d+))?\}/g, (_, startStr: string, lengthStr?: string) => {
		let start = Number.parseInt(startStr, 10) - 1;
		if (start < 0) start = 0;
		if (lengthStr) return args.slice(start, start + Number.parseInt(lengthStr, 10)).join(" ");
		return args.slice(start).join(" ");
	});
	const allArgs = args.join(" ");
	result = result.replace(/\$ARGUMENTS/g, allArgs);
	result = result.replace(/\$@/g, allArgs);
	return result;
}

export function formatPromptTemplateInvocation(template: PromptTemplate, args: string[] = []): string {
	return substituteArgs(template.content, args);
}

function unique(values: string[]): string[] {
	return [...new Set(values.filter((value) => value !== ""))];
}

export function createResourcesExtension(options: ResourcesExtensionOptions = {}): Extension {
	return (api) => {
		let loaded: Promise<LoadedResources> | undefined;

		api.on("session_start", async (event, ctx) => {
			await load(ctx, event.reason === "reload" ? "reload" : "startup");
		});

		api.on("before_agent_start", async (event, ctx) => {
			const resources = await load(ctx);
			const block = formatSkillsForSystemPrompt(resources.skills);
			return block === "" ? undefined : { systemPrompt: `${event.systemPrompt}\n\n${block}`.trim() };
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
				const discovered = await ctx.discoverResources?.(reason);
				const skillPaths = unique([
					...(defaultsEnabled && paths?.userTauDir ? [joinPath(paths.userTauDir, "skills")] : []),
					...(defaultsEnabled && paths?.projectTauDir ? [joinPath(paths.projectTauDir, "skills")] : []),
					...(defaultsEnabled && paths?.projectPiDir ? [joinPath(paths.projectPiDir, "skills")] : []),
					...(discovered?.skillPaths ?? []),
					...(options.skillPaths ?? []),
				]);
				const promptPaths = unique([
					...(defaultsEnabled && paths?.userTauDir ? [joinPath(paths.userTauDir, "prompts")] : []),
					...(defaultsEnabled && paths?.projectTauDir ? [joinPath(paths.projectTauDir, "prompts")] : []),
					...(defaultsEnabled && paths?.projectPiDir ? [joinPath(paths.projectPiDir, "prompts")] : []),
					...(discovered?.promptPaths ?? []),
					...(options.promptPaths ?? []),
				]);
				const skills = await loadSkills(fs, skillPaths);
				const prompts = await loadPromptTemplates(fs, promptPaths);
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
						handler: (args) => ({
							action: "prompt",
							text: formatPromptTemplateInvocation(template, parseCommandArgs(args)),
						}),
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
