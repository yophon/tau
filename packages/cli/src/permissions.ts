/**
 * Permission rules for one workspace (P37a), Claude Code's settings layout:
 * `permissions.allow/ask/deny/additionalDirectories/defaultMode` in
 * ~/.tau/settings.json, <project>/.tau/settings.json and
 * <project>/.tau/settings.local.json, plus --allowed-tools / --disallowed-tools /
 * --add-dir for one run. The kernel matches; this module reads, writes and turns
 * "always allow" into rules.
 *
 * Trust (Claude Code): deny and ask apply from every file; allow,
 * additionalDirectories and defaultMode from a project file only once the project
 * is trusted. The local file is the user's own unless git tracks it or `.tau` is a
 * symlink, in which case it counts as a project file.
 */
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
	type ApprovalRequest,
	hostOf,
	matchPermissionRules,
	type PermissionMode,
	type PermissionRule,
	type PermissionRuleKind,
	type PermissionRules,
	parsePermissionRule,
	parsePowerShellCommand,
	parseShellCommand,
} from "@yophon/tau-kernel";
import { readSettingsKey, settingsParseError, writeSettings } from "./settings.ts";

export type RuleSource = "user" | "project" | "local" | "flag";
export type RuleDestination = "local" | "project" | "user";

export interface ListedRule {
	kind: PermissionRuleKind;
	text: string;
	source: RuleSource;
	/** The settings file it lives in (flags have none). */
	path?: string;
}

export interface ListedDirectory {
	path: string;
	source: RuleSource | "session";
}

/** What "always allow" means for one approval, shown on the option and applied when picked. */
export interface AlwaysOption {
	kind: "rules" | "edits";
	label: string;
	/** The rules it saves (kind "rules"). */
	rules: string[];
	apply(): void;
}

/** An approval request as the host's prompt sees it: with the "always" option, when there is one. */
export interface HostApprovalRequest extends ApprovalRequest {
	always?: { label: string; kind: AlwaysOption["kind"] };
}

/** The "always allow" options of the approvals open now, by tool call id; hosts' prompts read them. */
export const openAlwaysOptions = new Map<string, AlwaysOption>();

const KINDS: readonly PermissionRuleKind[] = ["allow", "ask", "deny"];
const EDIT_TOOLS = new Set(["write", "edit"]);
const RUNNERS = new Set(["npm", "pnpm", "yarn", "bun"]);
export const LOCAL_SETTINGS = join(".tau", "settings.local.json");
const LOCAL_EXCLUDE = "**/.tau/settings.local.json";

/** Claude Code's permission mode names, accepted in defaultMode next to tau's. */
const MODE_ALIASES: Record<string, PermissionMode> = {
	"read-only": "read-only",
	supervised: "supervised",
	"accept-edits": "accept-edits",
	autonomous: "autonomous",
	bypass: "bypass",
	default: "supervised",
	manual: "supervised",
	acceptedits: "accept-edits",
	plan: "read-only",
	bypasspermissions: "bypass",
};

interface FileState {
	mtimeMs: number;
	rules: Record<PermissionRuleKind, PermissionRule[]>;
	directories: string[];
	defaultMode?: string;
	diagnostics: string[];
}

interface SettingsFile {
	source: Exclude<RuleSource, "flag">;
	path: string;
	/** What "/path" patterns are relative to. */
	base: string;
}

export interface WorkspacePermissionsOptions {
	home: string;
	cwd: string;
	/** Where the project's local file lives (the main checkout for a tau worktree, P37d). */
	localRoot?: string;
	projectTrusted: () => boolean;
	allowedTools?: readonly string[];
	disallowedTools?: readonly string[];
	addDirs?: readonly string[];
	/** Switch this session to accept-edits ("Allow all edits this session"). */
	acceptEdits?: () => void;
	/** The session's permission mode now (the edits option only helps in supervised). */
	mode?: () => PermissionMode;
	/** tau wrote the project's settings.json: refresh the trust digest so its own change does not ask again. */
	onProjectFileWritten?: () => void;
}

export class WorkspacePermissions {
	private readonly cache = new Map<string, FileState>();
	private readonly flagRules: Record<PermissionRuleKind, PermissionRule[]> = { allow: [], ask: [], deny: [] };
	private readonly flagDiagnostics: string[] = [];
	private readonly sessionDirectories: string[] = [];
	private readonly files: SettingsFile[];
	private localTracked: { mtimeMs: number; repoFile: boolean } | undefined;
	private readonly options: WorkspacePermissionsOptions;
	cwd: string;
	readonly localRoot: string;

	constructor(options: WorkspacePermissionsOptions) {
		this.options = options;
		this.cwd = options.cwd;
		this.localRoot = options.localRoot ?? options.cwd;
		this.files = [
			{ source: "user", path: join(options.home, ".tau", "settings.json"), base: join(options.home, ".tau") },
			{ source: "project", path: join(options.cwd, ".tau", "settings.json"), base: options.cwd },
			{ source: "local", path: join(this.localRoot, LOCAL_SETTINGS), base: options.cwd },
		];
		for (const [kind, values] of [
			["allow", options.allowedTools ?? []],
			["deny", options.disallowedTools ?? []],
		] as const) {
			for (const text of values) {
				const parsed = parsePermissionRule(text, kind, { base: options.cwd, source: "command line" });
				if ("error" in parsed) this.flagDiagnostics.push(`command line: ${parsed.error}`);
				else this.flagRules[kind].push(parsed.rule);
			}
		}
		for (const dir of options.addDirs ?? []) this.sessionDirectories.push(this.resolveDir(dir));
	}

	/**
	 * The session moved (P46, Claude Code's EnterWorktree): the project's settings and the
	 * relative rules follow; local rules stay where they live (the main checkout, P37d).
	 */
	moveTo(cwd: string): void {
		this.cwd = cwd;
		for (const file of this.files) {
			if (file.source === "project") file.path = join(cwd, ".tau", "settings.json");
			if (file.source !== "user") file.base = cwd;
		}
		this.cache.clear();
	}

	/** The rules in force now (files re-read when they change). */
	rules(): PermissionRules {
		const out: Record<PermissionRuleKind, PermissionRule[]> = { allow: [], ask: [], deny: [] };
		for (const file of this.files) {
			const state = this.read(file);
			const trusted = this.allowsTrustedKeys(file);
			for (const kind of KINDS) {
				if (kind === "allow" && !trusted) continue;
				out[kind].push(...state.rules[kind]);
			}
		}
		for (const kind of KINDS) out[kind].push(...this.flagRules[kind]);
		return out;
	}

	/** The additional working directories in force (settings, --add-dir, /add-dir). */
	workingDirectories(): string[] {
		return this.listDirectories().map((entry) => entry.path);
	}

	listDirectories(): ListedDirectory[] {
		const out: ListedDirectory[] = [];
		const seen = new Set<string>();
		const add = (path: string, source: ListedDirectory["source"]) => {
			const key = process.platform === "win32" ? path.toLowerCase() : path;
			if (seen.has(key)) return;
			seen.add(key);
			out.push({ path, source });
		};
		for (const file of this.files) {
			if (!this.allowsTrustedKeys(file)) continue;
			for (const dir of this.read(file).directories) add(this.resolveDir(dir), file.source);
		}
		for (const dir of this.sessionDirectories) add(dir, "session");
		return out;
	}

	list(): ListedRule[] {
		const out: ListedRule[] = [];
		for (const file of this.files) {
			const state = this.read(file);
			const trusted = this.allowsTrustedKeys(file);
			for (const kind of KINDS) {
				if (kind === "allow" && !trusted) continue;
				for (const rule of state.rules[kind]) out.push({ kind, text: rule.text, source: file.source, path: file.path });
			}
		}
		for (const kind of KINDS) {
			for (const rule of this.flagRules[kind]) out.push({ kind, text: rule.text, source: "flag" });
		}
		return out;
	}

	/** Rules that could not be read, and project allow rules waiting for trust. */
	diagnostics(): string[] {
		const out = [...this.flagDiagnostics];
		for (const file of this.files) {
			const state = this.read(file);
			out.push(...state.diagnostics);
			if (!this.allowsTrustedKeys(file) && (state.rules.allow.length > 0 || state.directories.length > 0)) {
				out.push(`${file.path}: allow rules and additionalDirectories wait until the project is trusted (/trust)`);
			}
		}
		return out;
	}

	/** permissions.defaultMode (local, then project, then user); project files cannot pick autonomous or bypass. */
	defaultMode(): { mode?: PermissionMode; warnings: string[] } {
		const warnings: string[] = [];
		for (const file of [...this.files].reverse()) {
			const value = this.read(file).defaultMode;
			if (value === undefined) continue;
			const mode = MODE_ALIASES[value.toLowerCase()];
			if (!mode) {
				warnings.push(`${file.path}: defaultMode "${value}" is not supported here`);
				continue;
			}
			if (file.source !== "user" && (mode === "autonomous" || mode === "bypass")) {
				warnings.push(`${file.path}: a project file cannot set defaultMode "${value}"`);
				continue;
			}
			if (!this.allowsTrustedKeys(file)) continue;
			return { mode, warnings };
		}
		return { warnings };
	}

	/** Save rules to a settings file (validated first). */
	addRules(kind: PermissionRuleKind, texts: readonly string[], destination: RuleDestination): { error?: string } {
		for (const text of texts) {
			const parsed = parsePermissionRule(text, kind);
			if ("error" in parsed) return { error: parsed.error };
		}
		const file = this.fileFor(destination);
		return this.updatePermissions(file, (permissions) => {
			const list = Array.isArray(permissions[kind]) ? (permissions[kind] as unknown[]) : [];
			for (const text of texts) if (!list.includes(text)) list.push(text);
			permissions[kind] = list;
		});
	}

	removeRule(rule: ListedRule): { error?: string } {
		if (rule.source === "flag") return { error: "Rules from the command line last for this run only." };
		const file = this.fileFor(rule.source);
		return this.updatePermissions(file, (permissions) => {
			const list = Array.isArray(permissions[rule.kind]) ? (permissions[rule.kind] as unknown[]) : [];
			permissions[rule.kind] = list.filter((entry) => entry !== rule.text);
		});
	}

	/** /add-dir and --add-dir: a directory that must exist; remembered in the local file or for this session. */
	addDirectory(dir: string, remember: boolean): { path?: string; error?: string } {
		const path = this.resolveDir(dir);
		try {
			if (!statSync(path).isDirectory()) return { error: `${path} is not a directory` };
		} catch {
			return { error: `${path} does not exist` };
		}
		if (remember) {
			const saved = this.updatePermissions(this.fileFor("local"), (permissions) => {
				const list = Array.isArray(permissions.additionalDirectories)
					? (permissions.additionalDirectories as unknown[])
					: [];
				if (!list.includes(path)) list.push(path);
				permissions.additionalDirectories = list;
			});
			if (saved.error) return saved;
		} else if (!this.sessionDirectories.includes(path)) {
			this.sessionDirectories.push(path);
		}
		return { path };
	}

	/** What "always allow" offers for this approval (Claude Code), or undefined when only "once" fits. */
	alwaysOption(request: ApprovalRequest): AlwaysOption | undefined {
		if (request.protectedPath) return undefined;
		// An ask rule asks before any allow is looked at: a saved allow could never take effect.
		if (request.rule?.kind === "ask") return undefined;
		if (EDIT_TOOLS.has(request.toolName)) {
			// A subagent's mode is fixed when it starts: switching the session's would not reach it.
			if (request.subagent || !this.options.acceptEdits) return undefined;
			// Only supervised gains from accept-edits; never lower autonomous or bypass to it.
			if (this.options.mode && this.options.mode() !== "supervised") return undefined;
			const acceptEdits = this.options.acceptEdits;
			return { kind: "edits", label: "Allow all edits this session", rules: [], apply: acceptEdits };
		}
		// A local file tau cannot read is not overwritten: only "once" then.
		if (settingsParseError(this.fileFor("local").path)) return undefined;
		const rules = suggestRules(request, this.rules());
		if (rules.length === 0) return undefined;
		const shown = rules.join(", ").replace(/\s+/g, " ");
		return {
			kind: "rules",
			label: `Always allow in this project: ${shown.length > 100 ? `${shown.slice(0, 99)}…` : shown}`,
			rules,
			apply: () => {
				this.addRules("allow", rules, "local");
			},
		};
	}

	private fileFor(destination: RuleDestination): SettingsFile {
		const file = this.files.find((candidate) => candidate.source === destination);
		if (!file) throw new Error(`no settings file for ${destination}`);
		return file;
	}

	/** Change a file's permissions block, keeping its other keys; a file that is not valid JSON is left alone. */
	private updatePermissions(
		file: SettingsFile,
		update: (permissions: Record<string, unknown>) => void,
	): { error?: string } {
		const broken = settingsParseError(file.path);
		if (broken) return { error: `${file.path} is not valid JSON (${broken}); fix it first` };
		const firstLocal = file.source === "local" && !existsSync(file.path);
		const raw = readSettingsKey(file.path, "permissions");
		const permissions: Record<string, unknown> =
			typeof raw === "object" && raw !== null && !Array.isArray(raw) ? { ...(raw as Record<string, unknown>) } : {};
		update(permissions);
		writeSettings(file.path, { permissions });
		this.cache.delete(file.path);
		if (firstLocal) excludeFromGit(this.localRoot, LOCAL_EXCLUDE, file.path);
		if (file.source === "project") this.options.onProjectFileWritten?.();
		return {};
	}

	private allowsTrustedKeys(file: SettingsFile): boolean {
		if (file.source === "user") return true;
		if (file.source === "project") return this.options.projectTrusted();
		return !this.localIsRepoFile() || this.options.projectTrusted();
	}

	/** The local file counts as the repository's when git tracks it or `.tau` is a symlink (Claude Code). */
	localIsRepoFile(): boolean {
		const file = join(this.localRoot, LOCAL_SETTINGS);
		let mtimeMs: number;
		try {
			mtimeMs = statSync(file).mtimeMs;
		} catch {
			return false;
		}
		if (this.localTracked?.mtimeMs === mtimeMs) return this.localTracked.repoFile;
		const repoFile = localSettingsIsRepoFile(this.localRoot);
		this.localTracked = { mtimeMs, repoFile };
		return repoFile;
	}

	private read(file: SettingsFile): FileState {
		let mtimeMs = -1;
		try {
			mtimeMs = statSync(file.path).mtimeMs;
		} catch {
			// Missing file: no rules.
		}
		const cached = this.cache.get(file.path);
		if (cached && cached.mtimeMs === mtimeMs) return cached;
		const state: FileState = { mtimeMs, rules: { allow: [], ask: [], deny: [] }, directories: [], diagnostics: [] };
		const broken = mtimeMs >= 0 ? settingsParseError(file.path) : undefined;
		if (broken) state.diagnostics.push(`${file.path}: not valid JSON (${broken}); none of its rules are in force`);
		if (mtimeMs >= 0 && !broken) {
			const raw = readSettingsKey(file.path, "permissions");
			if (raw !== undefined && (typeof raw !== "object" || raw === null || Array.isArray(raw))) {
				state.diagnostics.push(`${file.path}: "permissions" must be an object`);
			} else if (raw) {
				const permissions = raw as Record<string, unknown>;
				for (const kind of KINDS) {
					const list = permissions[kind];
					if (list === undefined) continue;
					if (!Array.isArray(list)) {
						state.diagnostics.push(`${file.path}: permissions.${kind} must be an array`);
						continue;
					}
					for (const text of list) {
						if (typeof text !== "string") continue;
						const parsed = parsePermissionRule(text, kind, {
							base: file.base,
							source: displayPath(file.path, this.options.home),
						});
						if ("error" in parsed) state.diagnostics.push(`${file.path}: ${parsed.error}`);
						else state.rules[kind].push(parsed.rule);
					}
				}
				if (Array.isArray(permissions.additionalDirectories)) {
					state.directories = permissions.additionalDirectories.filter((dir): dir is string => typeof dir === "string");
				}
				if (typeof permissions.defaultMode === "string") state.defaultMode = permissions.defaultMode;
			}
		}
		this.cache.set(file.path, state);
		return state;
	}

	private resolveDir(dir: string): string {
		const expanded = dir === "~" || dir.startsWith("~/") ? join(this.options.home, dir.slice(1)) : dir;
		return isAbsolute(expanded) ? resolve(expanded) : resolve(this.cwd, expanded);
	}
}

/** "~/.tau/settings.json" style, for messages and audit records. */
export function displayPath(path: string, home: string): string {
	return path.startsWith(home) ? `~${path.slice(home.length).replaceAll("\\", "/")}` : path.replaceAll("\\", "/");
}

/** Whether <root>/.tau/settings.local.json exists and the repository supplies it (git tracks it, or `.tau` is a symlink). */
export function localSettingsIsRepoFile(root: string): boolean {
	if (!existsSync(join(root, LOCAL_SETTINGS))) return false;
	return isSymlink(join(root, ".tau")) || gitTracks(root, LOCAL_SETTINGS);
}

function isSymlink(path: string): boolean {
	try {
		return lstatSync(path).isSymbolicLink();
	} catch {
		return false;
	}
}

function git(cwd: string, args: string[]): string | undefined {
	try {
		return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000 });
	} catch {
		return undefined;
	}
}

function gitTracks(cwd: string, relative: string): boolean {
	return git(cwd, ["ls-files", "--error-unmatch", "--", relative.replaceAll("\\", "/")]) !== undefined;
}

/**
 * Keep a file tau writes for this machine out of commits: one line in the repository's
 * info/exclude (works in linked worktrees too), unless git already ignores the file.
 */
export function excludeFromGit(root: string, pattern: string, file: string): void {
	const excludePath = git(root, ["rev-parse", "--git-path", "info/exclude"])?.trim();
	if (!excludePath) return;
	if (git(root, ["check-ignore", "-q", "--", file]) !== undefined) return;
	const target = isAbsolute(excludePath) ? excludePath : join(root, excludePath);
	try {
		// A repository made without templates has no info/ directory yet.
		mkdirSync(dirname(target), { recursive: true });
		const current = existsSync(target) ? readFileSync(target, "utf8") : "";
		if (current.split(/\r?\n/).includes(pattern)) return;
		appendFileSync(target, `${current === "" || current.endsWith("\n") ? "" : "\n"}${pattern}\n`);
	} catch {
		// A read-only repository: the file just shows up as untracked.
	}
}

/**
 * Whether the PowerShell tool is on under these rules (P40b, Claude Code): a Bash deny rule,
 * whole-tool or scoped, turns it off for the session, unless some rule names PowerShell.
 */
export function powershellAllowedBy(rules: PermissionRules): boolean {
	const all = [...rules.allow, ...rules.ask, ...rules.deny];
	if (all.some((rule) => rule.tools.includes("powershell"))) return true;
	return !rules.deny.some((rule) => rule.tools.includes("bash"));
}

/** The rules "always allow" saves for a call, leaving out what the current rules already allow. */
export function suggestRules(request: ApprovalRequest, current: PermissionRules): string[] {
	const name = request.toolName;
	if (name === "bash" || name === "monitor") {
		const command = typeof request.args.command === "string" ? request.args.command : undefined;
		if (command === undefined) return [];
		const parsed = parseShellCommand(command);
		if (!parsed.ok) return [];
		const allowOnly: PermissionRules = { allow: current.allow, ask: [], deny: [] };
		const out: string[] = [];
		for (const segment of parsed.segments) {
			if (matchPermissionRules(allowOnly, { toolName: "bash", args: { command: segment } })) continue;
			const rule = `Bash(${bashRulePattern(segment)})`;
			if (!out.includes(rule)) out.push(rule);
		}
		return out;
	}
	// P40b: PowerShell rules have bash's shape (Claude Code); a segment is already the cmdlet name.
	if (name === "powershell") {
		const command = typeof request.args.command === "string" ? request.args.command : undefined;
		if (command === undefined) return [];
		const parsed = parsePowerShellCommand(command);
		if (!parsed.ok) return [];
		const allowOnly: PermissionRules = { allow: current.allow, ask: [], deny: [] };
		const out: string[] = [];
		for (const segment of parsed.segments) {
			if (matchPermissionRules(allowOnly, { toolName: "powershell", args: { command: segment } })) continue;
			const rule = `PowerShell(${bashRulePattern(segment)})`;
			if (!out.includes(rule)) out.push(rule);
		}
		return out;
	}
	if (name === "web_fetch") {
		const url = typeof request.args.url === "string" ? request.args.url : "";
		const host = hostOf(url);
		return host ? [`WebFetch(domain:${host})`] : [];
	}
	if (name === "web_search") return ["WebSearch"];
	return [name];
}

/**
 * The prefix a saved bash rule keeps: up to two plain words then ` *`
 * (`npm|pnpm|yarn|bun run <script>` keeps three); the exact command when the second
 * word is not plain (a path, a flag, a quoted string).
 */
export function bashRulePattern(segment: string): string {
	const words = segment.split(" ");
	// Script names like build:prod are plain too; a trailing ":" would read as the legacy ":*".
	const plain = (word: string | undefined): word is string =>
		word !== undefined && /^[A-Za-z0-9_][A-Za-z0-9_+@%:-]*$/.test(word) && !word.endsWith(":");
	if (!plain(words[0])) return segment;
	if (words.length === 1) return `${words[0]} *`;
	if (RUNNERS.has(words[0]) && words[1] === "run") {
		// Never `npm run *`: that would allow every script.
		return plain(words[2]) ? `${words[0]} run ${words[2]} *` : segment;
	}
	if (plain(words[1])) return `${words[0]} ${words[1]} *`;
	return segment;
}

/** Split --allowed-tools values: commas outside parentheses separate rules (Claude Code). */
export function splitRuleList(value: string): string[] {
	const out: string[] = [];
	let depth = 0;
	let current = "";
	for (const c of value) {
		if (c === "(") depth++;
		else if (c === ")") depth = Math.max(0, depth - 1);
		if (c === "," && depth === 0) {
			if (current.trim() !== "") out.push(current.trim());
			current = "";
		} else {
			current += c;
		}
	}
	if (current.trim() !== "") out.push(current.trim());
	return out;
}

/**
 * The old ~/.tau/permissions.json (P15) as rules (P37a): what it allowed keeps being
 * allowed. Its bash entries were keyed by risk level, so they become a whole-tool
 * `Bash`; file edits are dropped (edits are a per-session choice now). Returns the
 * notice to print, or undefined when there was nothing to migrate.
 */
export function migrateLegacyPermissions(home: string): string | undefined {
	const path = join(home, ".tau", "permissions.json");
	if (!existsSync(path)) return undefined;
	let entries: Array<{ tool?: unknown; action?: unknown }> = [];
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8").replace(/^﻿/, "")) as { rules?: unknown };
		if (Array.isArray(parsed.rules)) entries = parsed.rules as typeof entries;
	} catch {
		return undefined;
	}
	const rules: string[] = [];
	for (const entry of entries) {
		if (entry.action !== "allow" || typeof entry.tool !== "string") continue;
		const tool = entry.tool;
		if (EDIT_TOOLS.has(tool)) continue;
		const rule =
			tool === "bash" ? "Bash" : tool === "web_fetch" ? "WebFetch" : tool === "web_search" ? "WebSearch" : tool;
		if (!rules.includes(rule)) rules.push(rule);
	}
	const settings = join(home, ".tau", "settings.json");
	// A settings file tau cannot read is never rewritten: the old store stays until it is fixed.
	const broken = settingsParseError(settings);
	if (broken) {
		return `~/.tau/permissions.json was not migrated: ~/.tau/settings.json is not valid JSON (${broken}).`;
	}
	if (rules.length > 0) {
		const raw = readSettingsKey(settings, "permissions");
		const permissions: Record<string, unknown> =
			typeof raw === "object" && raw !== null && !Array.isArray(raw) ? { ...(raw as Record<string, unknown>) } : {};
		const allow = Array.isArray(permissions.allow) ? (permissions.allow as unknown[]) : [];
		for (const rule of rules) if (!allow.includes(rule)) allow.push(rule);
		permissions.allow = allow;
		writeSettings(settings, { permissions });
	}
	try {
		renameSync(path, `${path}.migrated`);
	} catch {
		return undefined;
	}
	if (rules.length === 0) return undefined;
	const bash = rules.includes("Bash")
		? " Bash allows every command, dangerous ones included (as in Claude Code); add deny or ask rules for the ones to stop."
		: "";
	return `Moved your "always allow" approvals to ~/.tau/settings.json permissions.allow: ${rules.join(", ")}.${bash} See /permissions.`;
}
