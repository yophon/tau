/**
 * Permission rules (P37a), copied from Claude Code's `permissions.allow/ask/deny`:
 * `Tool` or `Tool(specifier)`, evaluated deny → ask → allow with the first match
 * deciding. pi has no counterpart (it leaves approval to extensions); the rule
 * syntax, matching and precedence follow code.claude.com/docs/en/permissions.
 *
 * Rules reduce prompts and accidents; like Claude Code's, they are not a
 * security boundary (`sh -c`, absolute binaries and the like get past a deny).
 * Pure ES: hosts read and write the settings files, the kernel only matches.
 */

import { patchTargets } from "./apply-patch.ts";
import { canonicalPowerShellPattern, parsePowerShellCommand } from "./powershell-command.ts";
import { escapeRegExp } from "./search-tools.ts";
import { tokenize, type Word } from "./shell-tokens.ts";

export type PermissionRuleKind = "allow" | "ask" | "deny";

export interface PermissionRule {
	/** As written, e.g. "Bash(npm test *)". */
	text: string;
	kind: PermissionRuleKind;
	/** Lower-cased tool names or name globs the rule covers ("*" for every tool). */
	tools: readonly string[];
	/** The text inside the parentheses; undefined for a whole-tool rule. */
	specifier?: string;
	/** What "/path" patterns are relative to (the settings file's root). */
	base?: string;
	/** Where it came from, shown in /permissions and audit records. */
	source?: string;
	/** A "!pattern" path rule: excludes matches of the same kind from the same source. */
	negated?: boolean;
}

export interface PermissionRules {
	allow: readonly PermissionRule[];
	ask: readonly PermissionRule[];
	deny: readonly PermissionRule[];
}

export interface PermissionRuleCall {
	toolName: string;
	args: Record<string, unknown>;
	/** The working directory relative paths resolve against. */
	cwd?: string;
	/** The home directory "~/" resolves to. */
	home?: string;
}

export interface PermissionRuleMatch {
	kind: PermissionRuleKind;
	rule: PermissionRule;
}

export const EMPTY_PERMISSION_RULES: PermissionRules = { allow: [], ask: [], deny: [] };

/**
 * Claude Code tool names → tau tools. Edit rules cover write as well (Claude Code
 * applies Edit rules to every file-editing tool); Read rules cover the search tools.
 */
const TOOL_ALIASES: Record<string, readonly string[]> = {
	bash: ["bash", "monitor"],
	monitor: ["monitor"],
	powershell: ["powershell"],
	// P45: Claude Code applies Read rules to its LSP tool.
	read: ["read", "grep", "find", "ls", "lsp"],
	edit: ["edit", "write", "apply_patch"],
	write: ["write"],
	grep: ["grep"],
	glob: ["find"],
	ls: ["ls"],
	webfetch: ["web_fetch"],
	websearch: ["web_search"],
	agent: ["subagent"],
	task: ["subagent"],
	todowrite: ["todo_write"],
};

/** Claude Code accepts path rules for these but never consults them; so does tau. */
const UNCONSULTED_PATH_TOOLS: Record<string, string> = {
	write: "Edit",
	glob: "Read",
	notebookedit: "Edit",
	multiedit: "Edit",
};

/** P44: Claude Code applies Bash rules to Monitor commands too. */
const BASH_TOOLS = new Set(["bash", "monitor"]);
/** P40b: Claude Code's PowerShell rules (same shape as Bash; aliases resolved; case ignored). */
const POWERSHELL_TOOLS = new Set(["powershell"]);
const READ_PATH_TOOLS = new Set(["read", "grep", "find", "ls", "lsp"]);
const EDIT_PATH_TOOLS = new Set(["edit", "write", "apply_patch"]);
/** Main content fields a parameter rule may not name (Claude Code). */
const MAIN_FIELDS = new Set(["command", "file_path", "path", "notebook_path", "url"]);
const PATH_KEYS = ["path", "file_path", "filePath", "file", "filename", "dest", "target"] as const;

/**
 * Parse one rule string. `kind` matters for validation: allow rules may not use an
 * unanchored tool-name glob, parameter rules are for deny and ask only.
 */
export function parsePermissionRule(
	text: string,
	kind: PermissionRuleKind,
	options: { base?: string; source?: string } = {},
): { rule: PermissionRule } | { error: string } {
	const trimmed = text.trim();
	if (trimmed === "") return { error: "empty rule" };
	const open = trimmed.indexOf("(");
	let name: string;
	let specifier: string | undefined;
	if (open === -1) {
		name = trimmed;
	} else {
		if (!trimmed.endsWith(")")) return { error: `"${trimmed}": missing ")"` };
		name = trimmed.slice(0, open).trim();
		specifier = trimmed.slice(open + 1, -1).trim();
		if (specifier === "" || specifier === "*") specifier = undefined;
	}
	if (name === "") return { error: `"${trimmed}": missing tool name` };
	const lower = name.toLowerCase();
	const meta = { text: trimmed, kind, ...options };
	if (lower.includes("*")) {
		if (specifier !== undefined) return { error: `"${trimmed}": a tool-name glob takes no specifier` };
		const anchored = /^mcp__[^*]+__/.test(lower);
		if (kind === "allow" && !anchored) {
			return { error: `"${trimmed}": allow rules accept a glob only after mcp__<server>__` };
		}
		return { rule: { ...meta, tools: [lower] } };
	}
	if (lower.startsWith("mcp__")) {
		if (specifier !== undefined) return { error: `"${trimmed}": MCP rules take no specifier in settings` };
		// mcp__server covers the whole server, like mcp__server__*.
		const parts = lower.split("__");
		return { rule: { ...meta, tools: parts.length === 2 ? [`${lower}__*`] : [lower] } };
	}
	if (specifier !== undefined && UNCONSULTED_PATH_TOOLS[lower] && !isParamSpecifier(specifier)) {
		return {
			error: `"${trimmed}": path rules for ${name} are never consulted (Claude Code); use ${UNCONSULTED_PATH_TOOLS[lower]}(${specifier})`,
		};
	}
	const tools = TOOL_ALIASES[lower] ?? [lower];
	if (specifier === undefined) return { rule: { ...meta, tools } };
	const param = paramRule(specifier, lower);
	if (param) {
		if (MAIN_FIELDS.has(param.key)) {
			return { error: `"${trimmed}": "${param.key}" is the tool's main field; write ${name}(<pattern>) instead` };
		}
		if (kind === "allow") return { error: `"${trimmed}": parameter rules work in deny and ask only` };
	}
	if (specifier.startsWith("!")) {
		if (kind === "allow") return { error: `"${trimmed}": "!" works in deny and ask only` };
		return { rule: { ...meta, tools, specifier: specifier.slice(1).trim(), negated: true } };
	}
	return { rule: { ...meta, tools, specifier } };
}

function isParamSpecifier(specifier: string): boolean {
	return /^[A-Za-z_]\w*:/.test(specifier) && !specifier.startsWith("domain:") && !/^[A-Za-z]:[\\/]/.test(specifier);
}

/** `key:value` (Claude Code parameter rules). `domain:` is WebFetch's own form; Bash's legacy `prefix:*` is a prefix. */
function paramRule(specifier: string, toolName: string): { key: string; value: string } | undefined {
	const match = /^([A-Za-z_]\w*):(.*)$/s.exec(specifier);
	if (!match) return undefined;
	if (match[1] === "domain") return undefined;
	// A Windows drive path (C:/Users/…), not a parameter.
	if (match[1].length === 1 && /^[\\/]/.test(match[2])) return undefined;
	if ((BASH_TOOLS.has(toolName) || POWERSHELL_TOOLS.has(toolName)) && specifier.endsWith(":*")) return undefined;
	return { key: match[1], value: match[2] };
}

/**
 * Whether a rule's tool list covers a tool name (case-insensitive; globs with "*"). A
 * Read path deny also covers edit and write (Claude Code: "a Read(...) deny also blocks
 * Edit and Write there").
 */
function coversTool(rule: PermissionRule, toolName: string): boolean {
	const name = toolName.toLowerCase();
	if (
		rule.kind === "deny" &&
		rule.specifier !== undefined &&
		EDIT_PATH_TOOLS.has(name) &&
		rule.tools.includes("read")
	) {
		return true;
	}
	return rule.tools.some((tool) => (tool.includes("*") ? ruleGlobToRegExp(tool, false).test(name) : tool === name));
}

/** Whether a whole-tool deny rule takes this tool off the model's list (Claude Code). */
export function deniesWholeTool(rules: PermissionRules, toolName: string): boolean {
	return rules.deny.some((rule) => rule.specifier === undefined && !rule.negated && coversTool(rule, toolName));
}

/**
 * The rule that decides a call, deny → ask → allow, first match wins. For bash an
 * allow needs every subcommand matched (by any allow rules); deny and ask fire on
 * any subcommand. Read/Edit deny and ask rules also apply to bash's file commands
 * and redirections.
 */
export function matchPermissionRules(
	rules: PermissionRules,
	call: PermissionRuleCall,
): PermissionRuleMatch | undefined {
	const tool = call.toolName.toLowerCase();
	const command = BASH_TOOLS.has(tool) || POWERSHELL_TOOLS.has(tool) ? commandOf(call.args) : undefined;
	const parsed =
		command === undefined
			? undefined
			: POWERSHELL_TOOLS.has(tool)
				? parsePowerShellCommand(command)
				: parseShellCommand(command);
	for (const kind of ["deny", "ask"] as const) {
		const hit =
			firstMatch(rules[kind], call, parsed) ?? (parsed ? bashFileTargetMatch(rules[kind], call, parsed) : undefined);
		if (hit) return { kind, rule: hit };
	}
	if (parsed) {
		// Every subcommand must be allowed; a command we cannot parse is never allowed by a rule.
		if (!parsed.ok || parsed.segments.length === 0) return undefined;
		let first: PermissionRule | undefined;
		for (const segment of parsed.segments) {
			const rule = rules.allow.find(
				(candidate) => coversTool(candidate, tool) && shellRuleMatches(tool, candidate, segment),
			);
			if (!rule) return undefined;
			first ??= rule;
		}
		return first ? { kind: "allow", rule: first } : undefined;
	}
	const allow = firstMatch(rules.allow, call, undefined);
	return allow ? { kind: "allow", rule: allow } : undefined;
}

function firstMatch(
	list: readonly PermissionRule[],
	call: PermissionRuleCall,
	parsed: ParsedCommand | undefined,
): PermissionRule | undefined {
	const tool = call.toolName.toLowerCase();
	for (const rule of list) {
		if (rule.negated || !coversTool(rule, tool)) continue;
		if (ruleMatches(rule, call, parsed) && !negatedBy(list, rule, call, parsed)) return rule;
	}
	return undefined;
}

/** A "!pattern" rule of the same kind and source excludes what it matches. */
function negatedBy(
	list: readonly PermissionRule[],
	rule: PermissionRule,
	call: PermissionRuleCall,
	parsed: ParsedCommand | undefined,
): boolean {
	return list.some(
		(other) =>
			other.negated &&
			other.source === rule.source &&
			coversTool(other, call.toolName) &&
			ruleMatches(other, call, parsed),
	);
}

function ruleMatches(rule: PermissionRule, call: PermissionRuleCall, parsed: ParsedCommand | undefined): boolean {
	const spec = rule.specifier;
	if (spec === undefined) return true;
	const tool = call.toolName.toLowerCase();
	const param = paramRule(spec, tool);
	if (param) {
		const value = call.args[param.key];
		if (value === undefined || value === null || typeof value === "object") return false;
		return ruleGlobToRegExp(param.value, true).test(String(value));
	}
	if (spec.startsWith("domain:")) {
		const url = typeof call.args.url === "string" ? call.args.url : undefined;
		const host = url ? hostOf(url) : undefined;
		return host !== undefined && domainMatches(spec.slice("domain:".length), host);
	}
	if (BASH_TOOLS.has(tool) || POWERSHELL_TOOLS.has(tool)) {
		if (!parsed) return false;
		// Deny and ask: any subcommand. An unparseable command is matched as a whole.
		const segments = parsed.ok ? parsed.segments : [parsed.raw];
		return segments.some((segment) => shellRuleMatches(tool, rule, segment));
	}
	if (READ_PATH_TOOLS.has(tool) || EDIT_PATH_TOOLS.has(tool)) {
		const targets = pathTargets(call);
		return targets.some((target) => pathRuleMatches(rule, target, call));
	}
	// Other tools: a specifier we do not understand never matches.
	return false;
}

function commandOf(args: Record<string, unknown>): string | undefined {
	const value = args.command ?? args.cmd ?? args.script;
	return typeof value === "string" ? value : undefined;
}

function pathTargets(call: PermissionRuleCall): string[] {
	// P55a: apply_patch names its files in the patch; Edit rules apply to each.
	if (call.toolName === "apply_patch") return patchTargets(call.args.input);
	const targets: string[] = [];
	for (const key of PATH_KEYS) {
		const value = call.args[key];
		if (typeof value === "string" && value !== "") targets.push(value);
	}
	// grep/find/ls without a path search the working directory.
	if (targets.length === 0 && (call.toolName === "grep" || call.toolName === "find" || call.toolName === "ls")) {
		targets.push(".");
	}
	return targets;
}

/** Read/Edit deny or ask rules against bash's redirections and file commands (Claude Code, best effort). */
function bashFileTargetMatch(
	list: readonly PermissionRule[],
	call: PermissionRuleCall,
	parsed: ParsedCommand,
): PermissionRule | undefined {
	const check = (toolName: "read" | "edit", target: string): PermissionRule | undefined => {
		const fileCall: PermissionRuleCall = { ...call, toolName, args: { path: target } };
		return firstMatch(list, fileCall, undefined);
	};
	for (const target of parsed.writes) {
		const hit = check("edit", target);
		if (hit) return hit;
	}
	for (const target of parsed.reads) {
		const hit = check("read", target);
		if (hit) return hit;
	}
	return undefined;
}

// --- Bash patterns ---------------------------------------------------------------

/** `*` matches any text (spaces too); a trailing ` *` that is the only wildcard also matches the bare command; `:*` is the legacy trailing form. */
export function bashPatternMatches(pattern: string, input: string): boolean {
	// Runs of whitespace count as one space on both sides, so a saved exact rule for a
	// command with "a  b" or a line break in quotes still matches it.
	const command = input.replace(/\s+/g, " ").trim();
	let spec = pattern.replace(/\s+/g, " ").trim();
	if (spec.endsWith(":*")) spec = `${spec.slice(0, -2)} *`;
	if (spec === "*" || spec === "") return true;
	const wildcards = spec.split("*").length - 1;
	if (wildcards === 1 && spec.endsWith(" *")) {
		const prefix = spec.slice(0, -2);
		return command === prefix || command.startsWith(`${prefix} `);
	}
	return new RegExp(`^${spec.split("*").map(escapeRegExp).join("[\\s\\S]*")}$`).test(command);
}

function bashRuleMatches(rule: PermissionRule, segment: string): boolean {
	return rule.specifier === undefined || bashPatternMatches(rule.specifier, segment);
}

/** A PowerShell pattern: bash's wildcards over the command with aliases resolved, case ignored (Claude Code). */
export function powerShellPatternMatches(pattern: string, segment: string): boolean {
	return bashPatternMatches(canonicalPowerShellPattern(pattern), segment.toLowerCase());
}

function shellRuleMatches(tool: string, rule: PermissionRule, segment: string): boolean {
	if (!POWERSHELL_TOOLS.has(tool)) return bashRuleMatches(rule, segment);
	return rule.specifier === undefined || powerShellPatternMatches(rule.specifier, segment);
}

export interface ParsedCommand {
	/** False when quotes or parentheses do not balance or an operator dangles. */
	ok: boolean;
	raw: string;
	/** Every simple command, wrappers and leading assignments stripped, words joined by one space. */
	segments: string[];
	/** Redirection targets and tee arguments (checked like edits). */
	writes: string[];
	/** Input redirections and cat/head/tail/less/more/sed file arguments (checked like reads). */
	reads: string[];
}

const WRAPPERS = new Set(["time", "nohup", "command", "builtin", "noglob", "nice", "timeout", "stdbuf", "xargs"]);
const READ_COMMANDS = new Set(["cat", "head", "tail", "less", "more", "sed"]);
const LEADING_KEYWORDS = new Set(["{", "!", "if", "then", "else", "elif", "do", "while", "until"]);
const TRAILING_KEYWORDS = new Set(["}", "fi", "done", "esac"]);

/**
 * Split a shell command into its simple commands (POSIX shell rules: `&&`, `||`,
 * `;`, `|`, `|&`, `&`, newlines; commands inside `$(…)`, backticks, `<(…)` and
 * `( … )` count as their own). Best effort, like Claude Code's: it reads text, it
 * does not run a shell.
 */
export function parseShellCommand(command: string): ParsedCommand {
	const result: ParsedCommand = { ok: true, raw: command.trim(), segments: [], writes: [], reads: [] };
	collect(command, result, 0);
	return result;
}

function collect(command: string, result: ParsedCommand, depth: number): void {
	if (depth > 8) {
		result.ok = false;
		return;
	}
	const nested: string[] = [];
	const tokens = tokenize(command, nested);
	if (!tokens) {
		result.ok = false;
		return;
	}
	let words: Word[] = [];
	// Whether a command (or a closed group) precedes: a binary operator needs one on each side.
	let haveOperand = false;
	let expectCommand = false;
	const flush = (): void => {
		if (words.length > 0) addSegment(words, result);
		words = [];
	};
	for (let index = 0; index < tokens.length; index++) {
		const token = tokens[index];
		if (token.type === "word") {
			words.push(token.word);
			haveOperand = true;
			expectCommand = false;
			continue;
		}
		if (token.type === "redirect") {
			const next = tokens[index + 1];
			if (next?.type !== "word") {
				result.ok = false;
				return;
			}
			index++;
			const target = next.word.value;
			if (/^&?\d*$/.test(target) && token.op.endsWith("&")) continue; // fd duplication (2>&1)
			// The null device and the standard streams are not files anyone edits (Claude Code).
			if (/^(?:\/dev\/(?:null|stdout|stderr|tty)|nul)$/i.test(target)) continue;
			if (token.op.startsWith("<")) {
				if (token.op === "<") result.reads.push(target);
			} else {
				result.writes.push(target);
			}
			continue;
		}
		// Operators: separators end a command; a dangling binary operator is an error.
		if (token.op === "(" || token.op === ")") {
			flush();
			haveOperand = token.op === ")";
			if (token.op === ")") expectCommand = false;
			continue;
		}
		const binary = token.op === "&&" || token.op === "||" || token.op === "|" || token.op === "|&";
		if (binary && !haveOperand) {
			result.ok = false;
			return;
		}
		flush();
		haveOperand = false;
		expectCommand = binary;
	}
	flush();
	if (expectCommand) result.ok = false;
	for (const inner of nested) collect(inner, result, depth + 1);
}

function addSegment(input: Word[], result: ParsedCommand): void {
	let words = input;
	// Loop and case headers run nothing themselves (their substitutions were collected).
	if (words[0].raw === "for" || words[0].raw === "case" || words[0].raw === "select") return;
	// Leading assignments (FOO=bar cmd), grouping braces and shell keywords.
	while (words.length > 0 && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0].raw) || LEADING_KEYWORDS.has(words[0].raw))) {
		words = words.slice(1);
	}
	words = stripWrappers(words);
	while (words.length > 0 && TRAILING_KEYWORDS.has(words[words.length - 1].raw)) words = words.slice(0, -1);
	if (words.length === 0) return;
	result.segments.push(words.map((word) => word.raw).join(" "));
	const name = basename(words[0].value);
	const args = words.slice(1).filter((word) => !word.value.startsWith("-"));
	if (name === "tee") {
		for (const word of args) result.writes.push(word.value);
	} else if (READ_COMMANDS.has(name)) {
		// sed's first operand is the script unless -e/-f gave it.
		const scriptGiven = words.some((word) => word.value === "-e" || word.value === "-f");
		const files = name === "sed" && !scriptGiven ? args.slice(1) : args;
		for (const word of files) result.reads.push(word.value);
	}
}

/** Drop wrappers Claude Code strips before matching: timeout, time, nice, nohup, stdbuf, command, builtin, noglob, bare xargs. */
function stripWrappers(input: Word[]): Word[] {
	let words = input;
	for (let guard = 0; guard < 16 && words.length > 1; guard++) {
		const name = words[0].value;
		if (!WRAPPERS.has(name)) break;
		let rest = words.slice(1);
		if (name === "command") {
			if (rest[0]?.value === "-v" || rest[0]?.value === "-V") break;
		} else if (name === "xargs") {
			if (rest[0]?.value.startsWith("-")) break;
		} else if (name === "time") {
			if (rest[0]?.value === "-p") rest = rest.slice(1);
		} else if (name === "nice") {
			if (rest[0]?.value === "-n") rest = rest.slice(2);
			else if (/^-\d+$/.test(rest[0]?.value ?? "")) rest = rest.slice(1);
		} else if (name === "timeout") {
			while (rest[0]?.value.startsWith("-")) {
				const option = rest[0].value;
				rest = rest.slice(
					option === "-s" || option === "-k" || option === "--signal" || option === "--kill-after" ? 2 : 1,
				);
			}
			rest = rest.slice(1); // the duration
		} else if (name === "stdbuf") {
			while (rest[0]?.value.startsWith("-")) {
				const option = rest[0].value;
				rest = rest.slice(/^-[ioe]$/.test(option) ? 2 : 1);
			}
		}
		if (rest.length === 0) break;
		words = rest;
	}
	return words;
}

function basename(path: string): string {
	const slash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
	return (slash === -1 ? path : path.slice(slash + 1)).toLowerCase();
}

// --- Paths -------------------------------------------------------------------------

/**
 * One canonical spelling for path matching: forward slashes, `.` and `..` folded, a
 * Windows drive written `/d/…` (Claude Code's form; Git Bash `/d/…`, WSL `/mnt/d/…`
 * and Cygwin `/cygdrive/d/…` spellings map to it when the working directory is a
 * Windows path), lower-cased on Windows. Relative paths resolve against `cwd`.
 */
export function canonicalPath(path: string, cwd: string | undefined, home?: string): string {
	const windows = isWindowsPath(cwd) || isWindowsPath(home) || isWindowsPath(path);
	let p = path.replace(/\\/g, "/");
	if (p === "~" || p.startsWith("~/")) p = home ? `${home.replace(/\\/g, "/")}${p.slice(1)}` : p;
	if (windows) {
		const shell = /^\/(?:mnt\/|cygdrive\/)?([A-Za-z])(\/.*)?$/.exec(p);
		if (shell && !/^[A-Za-z]:/.test(p)) p = `${shell[1]}:${shell[2] ?? "/"}`;
	}
	const absolute = p.startsWith("/") || /^[A-Za-z]:/.test(p);
	if (!absolute && cwd) p = `${cwd.replace(/\\/g, "/").replace(/\/+$/, "")}/${p}`;
	p = p.replace(/^([A-Za-z]):/, (_m, drive: string) => `/${drive.toLowerCase()}`);
	const out: string[] = [];
	for (const segment of p.split("/")) {
		if (segment === "" || segment === ".") continue;
		if (segment === "..") out.pop();
		else out.push(segment);
	}
	const joined = `/${out.join("/")}`;
	return windows ? joined.toLowerCase() : joined;
}

function isWindowsPath(path: string | undefined): boolean {
	return path !== undefined && /^[A-Za-z]:[\\/]/.test(path);
}

/**
 * Claude Code's gitignore-style path patterns: `//abs`, `~/home`, `/relative-to-settings`,
 * `./relative-to-cwd` or bare. `*` stays in a segment, `**` crosses them; a bare name
 * matches at any depth; a bare path with a slash is anchored to cwd in allow rules
 * and matches at any depth in deny and ask. A pattern matching a directory covers
 * what is inside it.
 */
function pathRuleMatches(rule: PermissionRule, target: string, call: PermissionRuleCall): boolean {
	const spec = rule.specifier;
	if (spec === undefined) return true;
	const windows = isWindowsPath(call.cwd) || isWindowsPath(call.home);
	const canonical = canonicalPath(target, call.cwd, call.home);
	const pattern = patternToAbsoluteGlob(spec, rule, call, windows);
	const regex = ruleGlobToRegExp(pattern, false, windows);
	// The path itself or any directory above it.
	let candidate = canonical;
	for (;;) {
		if (regex.test(candidate)) return true;
		const slash = candidate.lastIndexOf("/");
		if (slash <= 0) return false;
		candidate = candidate.slice(0, slash);
	}
}

function patternToAbsoluteGlob(spec: string, rule: PermissionRule, call: PermissionRuleCall, windows: boolean): string {
	let p = spec.replace(/\\/g, "/");
	const dirOnly = p.endsWith("/") && p.length > 1;
	if (dirOnly) p = p.replace(/\/+$/, "");
	let absolute: string;
	if (p.startsWith("//")) {
		absolute = p.slice(1);
	} else if (/^[A-Za-z]:\//.test(p)) {
		// A Windows drive path written as is (C:/Users/…).
		absolute = `/${p[0].toLowerCase()}${p.slice(2)}`;
	} else if (p === "~" || p.startsWith("~/")) {
		absolute = joinGlob(canonicalPath(call.home ?? "~", undefined, call.home), p.slice(2));
	} else if (p.startsWith("/")) {
		absolute = joinGlob(canonicalPath(rule.base ?? call.cwd ?? "/", undefined), p.slice(1));
	} else {
		const anchored = p.startsWith("./");
		const rest = anchored ? p.slice(2) : p;
		const cwd = canonicalPath(call.cwd ?? "/", undefined);
		const anyDepth = !anchored && (!rest.includes("/") || rule.kind !== "allow");
		absolute = anyDepth ? joinGlob(cwd, rest.startsWith("**/") ? rest : `**/${rest}`) : joinGlob(cwd, rest);
	}
	if (windows) absolute = absolute.replace(/^\/([A-Za-z]):/, (_m, drive: string) => `/${drive}`).toLowerCase();
	return absolute;
}

function joinGlob(base: string, rest: string): string {
	const trimmed = base.replace(/\/+$/, "");
	return rest === "" ? trimmed || "/" : `${trimmed}/${rest}`;
}

/** `**` crosses path segments, `*` and `?` stay inside one (path mode); in text mode `*` is anything. */
function ruleGlobToRegExp(glob: string, text: boolean, caseInsensitive = false): RegExp {
	if (text) return new RegExp(`^${glob.split("*").map(escapeRegExp).join("[\\s\\S]*")}$`, caseInsensitive ? "i" : "");
	let out = "";
	for (let i = 0; i < glob.length; i++) {
		const c = glob[i];
		if (c === "*") {
			if (glob[i + 1] === "*") {
				// "**/" also matches no directory at all.
				if (glob[i + 2] === "/") {
					out += "(?:.*/)?";
					i += 2;
				} else {
					out += ".*";
					i += 1;
				}
			} else {
				out += "[^/]*";
			}
		} else if (c === "?") {
			out += "[^/]";
		} else {
			out += escapeRegExp(c);
		}
	}
	return new RegExp(`^${out}$`, caseInsensitive ? "i" : "");
}

// --- Domains -----------------------------------------------------------------------

/**
 * The host a fetch of `url` goes to. The WHATWG URL parser where the engine has it (the
 * same one fetch uses: `\` as `/`, percent-decoding, numeric IPv4); a regex in bare
 * engines without URL.
 */
export function hostOf(url: string): string | undefined {
	const UrlClass = (globalThis as { URL?: new (input: string) => { hostname: string } }).URL;
	if (UrlClass) {
		try {
			const host = new UrlClass(url.trim()).hostname.toLowerCase().replace(/\.$/, "");
			return host === "" ? undefined : host.replace(/^\[(.*)\]$/, "$1");
		} catch {
			return undefined;
		}
	}
	const match = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/?#\\]*@)?(\[[^\]]*\]|[^:/?#\\]*)/i.exec(url.trim());
	return match
		? match[1]
				.toLowerCase()
				.replace(/\.$/, "")
				.replace(/^\[(.*)\]$/, "$1")
		: undefined;
}

/** `example.com` exactly; `*.example.com` any subdomain but not the apex; `*` any host; a mid `*` stays in one label. */
function domainMatches(pattern: string, host: string): boolean {
	const p = pattern.trim().toLowerCase().replace(/\.$/, "");
	if (p === "*") return true;
	if (p.startsWith("*.")) {
		const apex = p.slice(2);
		return host.endsWith(`.${apex}`) && host !== apex;
	}
	return new RegExp(`^${p.split("*").map(escapeRegExp).join("[^.]*")}$`).test(host);
}

/** Merge rule lists (settings files and flags); evaluation is deny-first, so order only matters within a kind. */
export function mergePermissionRules(...sets: readonly PermissionRules[]): PermissionRules {
	return {
		allow: sets.flatMap((set) => set.allow),
		ask: sets.flatMap((set) => set.ask),
		deny: sets.flatMap((set) => set.deny),
	};
}
