/**
 * Permission and approval policy (P15). pi has no counterpart — it leaves
 * approval to extensions. tau ships a kernel-level gate because a
 * distributable kernel cannot treat safety as an optional install; concept
 * shapes follow yo-agent's PolicyEngine/assessRisk, rewritten pure-ES (D20).
 *
 * The static rules reduce accidents; they do not defend against a malicious
 * model or user. Defense in depth comes from the mode ladder, not from
 * pattern exhaustiveness.
 */

import {
	canonicalPath,
	deniesWholeTool,
	matchPermissionRules,
	type PermissionRuleKind,
	type PermissionRules,
} from "./permission-rules.ts";

/** How much the host trusts the agent. Kernel default: autonomous; interactive hosts should pick supervised. */
export type PermissionMode = "read-only" | "supervised" | "ci" | "accept-edits" | "autonomous" | "bypass";

export type RiskLevel = "low" | "medium" | "high";

export type PolicyAction = "allow" | "ask" | "deny";

export interface PolicyDecision {
	risk: RiskLevel;
	action: PolicyAction;
	/** The rule that fired; feeds approval prompts and deny tool results. */
	reason?: string;
	/** The permission rule that decided, when one did (P37a). */
	rule?: { kind: PermissionRuleKind; text: string; source?: string };
	/** The built-in protected path a write touches; allow rules never pre-approve these (Claude Code). */
	protectedPath?: string;
}

/** A tool call as the policy sees it: name, (hook-rewritten) arguments, and any registration-time risk. */
export interface ToolPolicyCall {
	toolName: string;
	args: Record<string, unknown>;
	/**
	 * Risk self-declared via registerTool(tool, { risk }). Consulted only for
	 * tools without built-in rules — an extension overriding "bash" cannot
	 * lower the built-in classification.
	 */
	declaredRisk?: RiskLevel;
	/** The working directory edits are relative to (accept-edits allows edits inside it, P26d). */
	cwd?: string;
	/** The call being assessed, for hosts that record which rule decided it (P37a). */
	toolCallId?: string;
}

export interface ToolPolicy {
	assess(call: ToolPolicyCall, mode: PermissionMode): PolicyDecision;
	/** Whether a whole-tool deny rule takes this tool off the model's list (Claude Code). */
	deniesTool?(toolName: string): boolean;
}

/** Handed to AgentOptions.onApproval (and, by default, UiCapability.confirm) when a call needs approval. */
export interface ApprovalRequest {
	toolCallId: string;
	toolName: string;
	args: Record<string, unknown>;
	risk: RiskLevel;
	reason?: string;
	/** The ask rule that forced the approval, if one did (P37a). */
	rule?: { kind: PermissionRuleKind; text: string; source?: string };
	/** The built-in protected path a write touches (no "always allow" for it). */
	protectedPath?: string;
	/** Set for a call another tool made (ctx.executeTool), e.g. from a codemode script. */
	parentToolCallId?: string;
	/** The subagent that made the call (AgentSpawnOptions.label, P26b). */
	subagent?: string;
	/** Made by a child that outlives the parent's run (AgentSpawnOptions.detached). */
	detached?: boolean;
}

/**
 * Modes from strictest to most permissive. ci allows what accept-edits does but never asks, so it sits
 * between supervised and accept-edits: a ci parent keeps an accept-edits child from asking (P53c).
 */
const MODE_ORDER: readonly PermissionMode[] = ["read-only", "supervised", "ci", "accept-edits", "autonomous", "bypass"];

/** The stricter of two permission modes (a subagent never outranks its parent). */
export function stricterMode(a: PermissionMode, b: PermissionMode | undefined): PermissionMode {
	if (b === undefined) return a;
	return MODE_ORDER.indexOf(b) < MODE_ORDER.indexOf(a) ? b : a;
}

/**
 * mode × risk → action. read-only denies everything non-read, supervised asks
 * for medium and high, autonomous asks only for high, bypass allows all.
 * accept-edits is supervised here; the default policy additionally allows file
 * edits inside the working directory in it (P26d, yo-agent / Claude Code). ci (P53c,
 * yo-agent's unattended mode) is accept-edits whose asks are denied instead (the tool batch).
 */
export function resolvePolicyAction(mode: PermissionMode, risk: RiskLevel): PolicyAction {
	switch (mode) {
		case "bypass":
			return "allow";
		case "read-only":
			return risk === "low" ? "allow" : "deny";
		case "supervised":
		case "ci":
		case "accept-edits":
			return risk === "low" ? "allow" : "ask";
		case "autonomous":
			return risk === "high" ? "ask" : "allow";
	}
}

/**
 * Built-in protected paths. Entries are segment sequences matched anywhere in
 * the target path ("~/" is stripped); a trailing "*" prefix-matches a segment.
 * ".env*" therefore hits ".env", ".env.local", and "config/.env.prod".
 */
export const DEFAULT_PROTECTED_PATHS: readonly string[] = [
	".git",
	".ssh",
	".env*",
	"~/.tau/trust.json",
	"~/.tau/permissions.json",
	// Permission rules live here (P37a): the model may not quietly widen its own permissions.
	".tau/settings.json",
	".tau/settings.local.json",
];

interface DangerousPattern {
	pattern: RegExp;
	label: string;
}

const DEFAULT_DANGEROUS_PATTERNS: readonly DangerousPattern[] = [
	{
		pattern: /\brm\s+(?:[^|;&>]*\s)?-(?:[a-z]*[rf][a-z]*|-recursive|-force|-no-preserve-root)\b/i,
		label: "rm with recursive/force flags",
	},
	{ pattern: /\bsudo\b/, label: "sudo" },
	{
		pattern: /\bch(?:mod|own)\b[^|;&]*\s(?:-[a-zA-Z]*R[a-zA-Z]*|--recursive)\b[^|;&]*\s\/(?:\s|$)/,
		label: "recursive chmod/chown on /",
	},
	{
		pattern: /\b(?:curl|wget)\b[^|;&]*\|\s*(?:sudo\s+)?(?:ba|z|da|fi)?sh\b/i,
		label: "pipes a downloaded script into a shell",
	},
	{ pattern: /\bgit\s+push\b[^|;&]*(?:--force\b(?!-)|\s-f\b)/, label: "git push --force" },
	{
		pattern: /(?:>\s*|\bdd\b[^|;&]*\bof=)\/dev\/(?!null\b|stdout\b|stderr\b|tty\b|zero\b)\w/i,
		label: "writes to a raw device",
	},
	{ pattern: /\bmkfs\b/i, label: "mkfs" },
	{
		pattern: /:\(\)\s*\{\s*:\s*\|\s*:|(\w+)\s*\(\)\s*\{[^}]*\b\1\s*\|\s*\1\b/,
		label: "fork bomb",
	},
	// Windows: the Node host routes native commands to cmd.exe, so these run for real there.
	{ pattern: /\b(?:rd|rmdir)\b[^|&\r\n]*\s\/s\b/i, label: "recursive directory removal (rd /s)" },
	{ pattern: /\b(?:del|erase)\b[^|&\r\n]*\s\/[sqf]\b/i, label: "recursive/forced delete (del /s, /q, /f)" },
	{ pattern: /\bformat(?:\.com)?\s+[a-z]:/i, label: "format drive" },
	{ pattern: /\bdiskpart\b/i, label: "diskpart" },
	{ pattern: /\breg(?:\.exe)?\s+delete\b/i, label: "registry delete" },
	{
		pattern: /\b(?:Remove-Item|ri)\b[^|;\r\n]*\s-(?:Recurse|Force|r|fo)\b/i,
		label: "PowerShell Remove-Item -Recurse/-Force",
	},
];

/** Argument keys probed for target paths on write/edit-shaped calls (content fields are deliberately excluded). */
const PATH_PROBE_KEYS = ["path", "file_path", "file", "filename", "dest", "target"] as const;

/** Argument keys probed for the command text on bash-shaped calls. */
const COMMAND_PROBE_KEYS = ["command", "cmd", "script"] as const;

const READ_TOOLS = new Set(["read", "listDir", "grep", "find", "ls"]);
const WRITE_TOOLS = new Set(["write", "edit"]);
/** Tools accept-edits allows without asking (inside the working directory, off protected paths). */
const ACCEPT_EDITS_TOOLS = new Set(["write", "edit", "memory_write"]);

/**
 * Whether a target path stays inside `cwd`: relative without escaping, or absolute
 * under it. Paths are compared in canonical form (P37a): `.`/`..` folded, and on
 * Windows the Git Bash, WSL and Cygwin spellings (`/d/…`, `/mnt/d/…`,
 * `/cygdrive/d/…`) read as the drive path, case-insensitively.
 */
export function isInsideCwd(path: string, cwd: string | undefined): boolean {
	const target = path.replace(/\\/g, "/");
	const absolute = target.startsWith("/") || /^[A-Za-z]:/.test(target);
	if (!absolute && !cwd) {
		let depth = 0;
		for (const segment of target.split("/")) {
			if (segment === "..") depth--;
			else if (segment !== "" && segment !== ".") depth++;
			if (depth < 0) return false;
		}
		return true;
	}
	if (!cwd) return false;
	const base = canonicalPath(cwd, undefined);
	const resolved = canonicalPath(path, cwd);
	return resolved === base || resolved.startsWith(base === "/" ? "/" : `${base}/`);
}

/** Inside the working directory or one of the additional working directories (P37a). */
function isInsideWorkingDirectories(path: string, cwd: string | undefined, extra: readonly string[]): boolean {
	if (isInsideCwd(path, cwd)) return true;
	return extra.some((dir) => {
		const base = canonicalPath(dir, cwd);
		const resolved = canonicalPath(path, cwd);
		return resolved === base || resolved.startsWith(`${base}/`);
	});
}
/** Shell tools: medium, high when the command matches a dangerous pattern (P40b: powershell like bash). */
const BASH_TOOLS = new Set(["bash", "powershell"]);

/** Lower-cased segments with `.` and `..` folded (P37a: `.tau/x/../settings.json` is the protected file it writes). */
function pathSegments(path: string): string[] {
	const out: string[] = [];
	for (const segment of path.replace(/\\/g, "/").toLowerCase().split("/")) {
		if (segment === "" || segment === "." || segment === "~") continue;
		if (segment === "..") {
			// Above the start of a relative path: keep it, so an escape is not mistaken for a protected entry.
			if (out.length > 0 && out[out.length - 1] !== "..") out.pop();
			else out.push(segment);
			continue;
		}
		out.push(segment);
	}
	return out;
}

function segmentMatches(pattern: string, segment: string): boolean {
	if (pattern.endsWith("*")) return segment.startsWith(pattern.slice(0, -1));
	return segment === pattern;
}

function pathHitsEntry(segments: string[], entrySegments: string[]): boolean {
	if (entrySegments.length === 0) return false;
	outer: for (let start = 0; start + entrySegments.length <= segments.length; start++) {
		for (let offset = 0; offset < entrySegments.length; offset++) {
			if (!segmentMatches(entrySegments[offset], segments[start + offset])) continue outer;
		}
		return true;
	}
	return false;
}

function probeStrings(args: Record<string, unknown>, keys: readonly string[]): string[] {
	const found: string[] = [];
	for (const key of keys) {
		const value = args[key];
		if (typeof value === "string" && value !== "") found.push(value);
	}
	return found;
}

export interface DefaultPolicyOptions {
	/** Appended to DEFAULT_PROTECTED_PATHS. */
	protectedPaths?: string[];
	/** Appended to the built-in dangerous bash patterns. */
	dangerousPatterns?: RegExp[];
	/** Permission rules (P37a), read on every assess so edited settings apply from the next call. */
	rules?: () => PermissionRules;
	/** Extra roots that count as inside the working directory for accept-edits (P37a). */
	workingDirectories?: () => readonly string[];
	/** The home directory "~/" in rules resolves to. */
	home?: string;
}

/**
 * The default static policy: read tools are low; write/edit are medium unless
 * the target hits a protected path (high); bash is medium unless the command
 * matches a dangerous pattern (high); unknown tools take their declared risk,
 * defaulting to medium. Options append to (never replace) the built-in lists.
 *
 * Permission rules (P37a, Claude Code) come first: deny denies and ask asks in
 * every mode; allow allows in supervised, accept-edits and autonomous (dangerous
 * commands included), except writes to protected paths, and does not lift
 * read-only. Without a matching rule the mode × risk matrix decides.
 */
export function createDefaultPolicy(options?: DefaultPolicyOptions): ToolPolicy {
	const protectedEntries = [...DEFAULT_PROTECTED_PATHS, ...(options?.protectedPaths ?? [])].map((entry) => ({
		entry,
		segments: pathSegments(entry),
	}));
	const dangerousPatterns: readonly DangerousPattern[] = [
		...DEFAULT_DANGEROUS_PATTERNS,
		...(options?.dangerousPatterns ?? []).map((pattern) => ({ pattern, label: "custom dangerous pattern" })),
	];

	const classify = (call: ToolPolicyCall): { risk: RiskLevel; reason?: string; protectedPath?: string } => {
		if (READ_TOOLS.has(call.toolName)) return { risk: "low" };
		if (WRITE_TOOLS.has(call.toolName)) {
			for (const target of probeStrings(call.args, PATH_PROBE_KEYS)) {
				const segments = pathSegments(target);
				for (const { entry, segments: entrySegments } of protectedEntries) {
					if (pathHitsEntry(segments, entrySegments)) {
						return {
							risk: "high",
							reason: `"${target}" touches protected path "${entry}"`,
							protectedPath: entry,
						};
					}
				}
			}
			return { risk: "medium" };
		}
		if (BASH_TOOLS.has(call.toolName)) {
			for (const command of probeStrings(call.args, COMMAND_PROBE_KEYS)) {
				for (const { pattern, label } of dangerousPatterns) {
					if (pattern.test(command)) return { risk: "high", reason: `command matches: ${label}` };
				}
			}
			return { risk: "medium" };
		}
		return { risk: call.declaredRisk ?? "medium" };
	};

	const workingDirectories = (): readonly string[] => options?.workingDirectories?.() ?? [];

	return {
		assess(call, mode) {
			const { risk, reason, protectedPath } = classify(call);
			const base: Pick<PolicyDecision, "risk" | "protectedPath"> = {
				risk,
				...(protectedPath ? { protectedPath } : {}),
			};
			const rules = options?.rules?.();
			const match = rules
				? matchPermissionRules(rules, { toolName: call.toolName, args: call.args, cwd: call.cwd, home: options?.home })
				: undefined;
			if (match) {
				const rule = {
					kind: match.kind,
					text: match.rule.text,
					...(match.rule.source ? { source: match.rule.source } : {}),
				};
				const from = match.rule.source ? ` in ${match.rule.source}` : "";
				if (match.kind === "deny") return { ...base, action: "deny", reason: `${rule.text} (deny rule${from})`, rule };
				if (match.kind === "ask") return { ...base, action: "ask", reason: `${rule.text} (ask rule${from})`, rule };
				// allow: no say in read-only (still read-only) or bypass (allows anyway); never over protected paths.
				if (mode !== "read-only" && mode !== "bypass" && !protectedPath) {
					return { ...base, action: "allow", reason: reason ?? `${rule.text} (allow rule${from})`, rule };
				}
			}
			if ((mode === "accept-edits" || mode === "ci") && risk !== "high" && ACCEPT_EDITS_TOOLS.has(call.toolName)) {
				const targets = probeStrings(call.args, PATH_PROBE_KEYS);
				const extra = workingDirectories();
				if (targets.every((target) => isInsideWorkingDirectories(target, call.cwd, extra))) {
					return { ...base, action: "allow", reason };
				}
				return { ...base, action: "ask", reason: reason ?? "edit outside the working directory" };
			}
			return { ...base, action: resolvePolicyAction(mode, risk), reason };
		},
		deniesTool(toolName) {
			const rules = options?.rules?.();
			return rules ? deniesWholeTool(rules, toolName) : false;
		},
	};
}
