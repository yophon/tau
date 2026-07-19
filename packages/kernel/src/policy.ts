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

/** How much the host trusts the agent. Kernel default: autonomous; interactive hosts should pick supervised. */
export type PermissionMode = "read-only" | "supervised" | "autonomous" | "bypass";

export type RiskLevel = "low" | "medium" | "high";

export type PolicyAction = "allow" | "ask" | "deny";

export interface PolicyDecision {
	risk: RiskLevel;
	action: PolicyAction;
	/** The rule that fired; feeds approval prompts and deny tool results. */
	reason?: string;
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
}

export interface ToolPolicy {
	assess(call: ToolPolicyCall, mode: PermissionMode): PolicyDecision;
}

/** Handed to AgentOptions.onApproval (and, by default, UiCapability.confirm) when a call needs approval. */
export interface ApprovalRequest {
	toolCallId: string;
	toolName: string;
	args: Record<string, unknown>;
	risk: RiskLevel;
	reason?: string;
}

/**
 * mode × risk → action. read-only denies everything non-read, supervised asks
 * for medium and high, autonomous asks only for high, bypass allows all.
 */
export function resolvePolicyAction(mode: PermissionMode, risk: RiskLevel): PolicyAction {
	switch (mode) {
		case "bypass":
			return "allow";
		case "read-only":
			return risk === "low" ? "allow" : "deny";
		case "supervised":
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
];

/** Argument keys probed for target paths on write/edit-shaped calls (content fields are deliberately excluded). */
const PATH_PROBE_KEYS = ["path", "file_path", "file", "filename", "dest", "target"] as const;

/** Argument keys probed for the command text on bash-shaped calls. */
const COMMAND_PROBE_KEYS = ["command", "cmd", "script"] as const;

const READ_TOOLS = new Set(["read", "listDir"]);
const WRITE_TOOLS = new Set(["write", "edit"]);
const BASH_TOOLS = new Set(["bash"]);

function pathSegments(path: string): string[] {
	return path
		.replace(/\\/g, "/")
		.toLowerCase()
		.split("/")
		.filter((segment) => segment !== "" && segment !== "." && segment !== "~");
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

/**
 * The default static policy: read tools are low; write/edit are medium unless
 * the target hits a protected path (high); bash is medium unless the command
 * matches a dangerous pattern (high); unknown tools take their declared risk,
 * defaulting to medium. Options append to (never replace) the built-in lists.
 */
export function createDefaultPolicy(options?: { protectedPaths?: string[]; dangerousPatterns?: RegExp[] }): ToolPolicy {
	const protectedEntries = [...DEFAULT_PROTECTED_PATHS, ...(options?.protectedPaths ?? [])].map((entry) => ({
		entry,
		segments: pathSegments(entry),
	}));
	const dangerousPatterns: readonly DangerousPattern[] = [
		...DEFAULT_DANGEROUS_PATTERNS,
		...(options?.dangerousPatterns ?? []).map((pattern) => ({ pattern, label: "custom dangerous pattern" })),
	];

	const classify = (call: ToolPolicyCall): { risk: RiskLevel; reason?: string } => {
		if (READ_TOOLS.has(call.toolName)) return { risk: "low" };
		if (WRITE_TOOLS.has(call.toolName)) {
			for (const target of probeStrings(call.args, PATH_PROBE_KEYS)) {
				const segments = pathSegments(target);
				for (const { entry, segments: entrySegments } of protectedEntries) {
					if (pathHitsEntry(segments, entrySegments)) {
						return { risk: "high", reason: `"${target}" touches protected path "${entry}"` };
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

	return {
		assess(call, mode) {
			const { risk, reason } = classify(call);
			return { risk, action: resolvePolicyAction(mode, risk), reason };
		},
	};
}
