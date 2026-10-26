// The audit ledger (P32c, after OpenClaw's audit ledger and Claude Code's tool
// decision events): ~/.tau/audit/YYYY-MM-DD.jsonl, one line per run start/end,
// tool call. Metadata only — who triggered the run, which tools ran, who
// approved them, tokens and cost — plus the session file and entry to read the
// content from. Kept 30 days. The kernel is unchanged: a built-in extension
// watches the run and the host's approval wrapper says who decided. Records the
// archived gateway wrote (host gateway, chat and schedule triggers) still read.
import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
	type AssistantMessage,
	createDefaultPolicy,
	type Extension,
	type RiskLevel,
	type ToolPolicy,
} from "@yophon/tau-kernel";
import { maskSecrets } from "./secrets.ts";

const AUDIT_KEEP_DAYS = 30;
const MAX_LINE = 4096;

export type AuditHost = "tui" | "repl" | "print" | "json" | "rpc" | "acp" | "gateway";

export type AuditTrigger =
	| { type: "user" }
	| { type: "chat"; channel: string; account: string; peer: string; role: "owner" | "allowed" }
	| { type: "schedule"; scheduleId: string; goalId?: string; channel: string; account: string; peer: string }
	| { type: "rpc" | "acp" };

export type DecisionSource =
	| "mode"
	| "policy_deny"
	| "user_once"
	| "user_session"
	| "user_reject"
	| "chat_owner"
	| "chat_reject"
	| "timeout"
	| "non_owner"
	| "hook"
	/** P35: a hook approved the call (PreToolUse permissionDecision allow, PermissionRequest allow). */
	| "hook_allow"
	/** P37a: a permission rule allowed or denied the call. */
	| "rule_allow"
	| "rule_deny"
	| "no_approver";

interface Base {
	v: 1;
	at: number;
	runId: string;
	host: AuditHost;
	pid: number;
}

export interface RunRecord extends Base {
	kind: "run";
	phase: "start" | "end";
	trigger: AuditTrigger;
	workspace: string;
	session?: { file: string; entry?: string };
	model?: string;
	usage?: { input: number; output: number; cacheRead: number; cacheWrite: number };
	cost?: number | null;
	status?: "ok" | "error" | "aborted";
	durationMs?: number;
	toolCalls?: number;
}

export interface ToolRecord extends Base {
	kind: "tool";
	toolCallId: string;
	name: string;
	risk?: RiskLevel;
	summary?: string;
	decision: { source: DecisionSource; by?: string; rule?: string };
	external?: boolean;
	durationMs?: number;
	ok: boolean;
}

export interface MessageRecord extends Base {
	kind: "message";
	channel: string;
	account: string;
	peer: string;
	type: "text" | "progress" | "notice";
}

export type AuditRecord = RunRecord | ToolRecord | MessageRecord;

const pad = (value: number) => String(value).padStart(2, "0");
const dayOf = (at: number) => {
	const date = new Date(at);
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
};

export class AuditLedger {
	readonly dir: string;
	private pruned = false;
	private failed = false;

	constructor(dir: string) {
		this.dir = dir;
	}

	static at(home: string): AuditLedger {
		return new AuditLedger(join(home, ".tau", "audit"));
	}

	/** Append one record; a failure is reported once and never stops the run. */
	write(record: AuditRecord): void {
		try {
			mkdirSync(this.dir, { recursive: true, mode: 0o700 });
			if (!this.pruned) {
				this.pruned = true;
				this.prune(record.at);
			}
			let line = JSON.stringify(record);
			if (line.length > MAX_LINE && record.kind === "tool" && record.summary) {
				line = JSON.stringify({ ...record, summary: `${record.summary.slice(0, 200)}…` });
			}
			appendFileSync(join(this.dir, `${dayOf(record.at)}.jsonl`), `${line}\n`, { mode: 0o600 });
		} catch (error) {
			if (!this.failed) process.stderr.write(`audit: ${error instanceof Error ? error.message : String(error)}\n`);
			this.failed = true;
		}
	}

	prune(now = Date.now()): void {
		const keep = dayOf(now - AUDIT_KEEP_DAYS * 86_400_000);
		try {
			for (const name of readdirSync(this.dir)) {
				const day = /^(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(name)?.[1];
				if (day && day < keep) rmSync(join(this.dir, name), { force: true });
			}
		} catch {
			// Best effort.
		}
	}

	/** Records from `since` on, oldest first; lines that do not parse are skipped. */
	read(since = 0, until = Number.POSITIVE_INFINITY): AuditRecord[] {
		let names: string[];
		try {
			names = readdirSync(this.dir)
				.filter((name) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name))
				.sort();
		} catch {
			return [];
		}
		const from = dayOf(since);
		const records: AuditRecord[] = [];
		for (const name of names) {
			if (name.slice(0, 10) < from) continue;
			for (const line of readFileSync(join(this.dir, name), "utf8").split("\n")) {
				if (line.trim() === "") continue;
				try {
					const record = JSON.parse(line) as AuditRecord;
					if (record.at >= since && record.at <= until) records.push(record);
				} catch {
					// A torn line from two writers: skip it.
				}
			}
		}
		return records.sort((a, b) => a.at - b.at);
	}
}

/** How one call was decided; `rule` is the permission rule that did, if one did (P37a). */
interface Decision {
	source: DecisionSource;
	by?: string;
	risk?: RiskLevel;
	rule?: string;
}

/** Who decided each approval, by tool call id: the host's approval wrapper writes, the audit reads. */
export class ApprovalLog {
	private readonly decisions = new Map<string, Decision>();

	record(toolCallId: string, decision: Decision): void {
		this.decisions.set(toolCallId, decision);
	}

	take(toolCallId: string): Decision | undefined {
		const decision = this.decisions.get(toolCallId);
		this.decisions.delete(toolCallId);
		return decision;
	}
}

/** One line for a tool call's arguments (the gateway's summarizeArgs, masked). */
export function summarizeToolArgs(name: string, args: Record<string, unknown>, max = 160): string {
	const pick = (...keys: string[]) => {
		for (const key of keys) {
			const value = args[key];
			if (typeof value === "string" && value.trim() !== "") return value;
		}
		return undefined;
	};
	const specific =
		name === "bash" || name === "powershell"
			? pick("command")
			: name === "web_fetch"
				? pick("url")
				: name === "web_search"
					? pick("query")
					: pick("path", "file_path", "pattern", "url", "query", "command", "content");
	const text = maskSecrets((specific ?? JSON.stringify(args)).replace(/\s+/g, " ").trim());
	return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** How a call that never ran ended, from its result text (the kernel's wording, tool-batch.ts). */
export function classifyRefusal(text: string): DecisionSource {
	if (text.startsWith("Tool call blocked:")) return "hook";
	if (/\(deny rule(?: in [^)]*)?\)$/.test(text)) return "rule_deny";
	if (text.includes("no approval handler is available")) return "no_approver";
	return "policy_deny";
}

const policy = createDefaultPolicy();
const BUILTIN = new Set(["read", "grep", "find", "ls", "write", "edit", "bash", "powershell"]);
const isExternal = (name: string) => name.startsWith("mcp__") || name === "web_fetch" || name === "web_search";

export interface AuditContext {
	ledger: AuditLedger;
	host: AuditHost;
	workspace: string;
	approvals: ApprovalLog;
	details: "summary" | "none";
	/** The current run's id and trigger (fixed per host). */
	current(): { runId?: string; trigger: AuditTrigger };
}

export function createAuditExtension(context: AuditContext): Extension {
	return (api) => {
		let run: { id: string; startedAt: number; toolCalls: number } | undefined;
		const pending = new Map<string, { name: string; summary?: string; startedAt: number }>();
		const base = (runId: string) => ({ v: 1 as const, at: Date.now(), runId, host: context.host, pid: process.pid });

		const writeTool = (toolCallId: string, ok: boolean, refusal?: string) => {
			const entry = pending.get(toolCallId);
			if (!entry) return;
			pending.delete(toolCallId);
			let decided = context.approvals.take(toolCallId);
			// A hook's approval does not get past the policy's own denials (P35): the refusal decides.
			if (refusal !== undefined && decided?.source === "hook_allow") decided = undefined;
			const source: DecisionSource = decided?.source ?? (refusal !== undefined ? classifyRefusal(refusal) : "mode");
			const risk =
				decided?.risk ??
				(BUILTIN.has(entry.name) ? policy.assess({ toolName: entry.name, args: {} }, "supervised").risk : undefined);
			context.ledger.write({
				...base(run?.id ?? "unknown"),
				kind: "tool",
				toolCallId,
				name: entry.name,
				...(risk ? { risk } : {}),
				...(entry.summary !== undefined ? { summary: entry.summary } : {}),
				decision: {
					source,
					...(decided?.by ? { by: decided.by } : {}),
					...(decided?.rule ? { rule: decided.rule } : {}),
				},
				...(isExternal(entry.name) ? { external: true } : {}),
				durationMs: Date.now() - entry.startedAt,
				ok,
			});
		};

		api.on("agent_start", (_event, ctx) => {
			const current = context.current();
			run = { id: current.runId ?? randomUUID(), startedAt: Date.now(), toolCalls: 0 };
			const file = ctx?.sessionManager?.getSessionFile();
			context.ledger.write({
				...base(run.id),
				kind: "run",
				phase: "start",
				trigger: current.trigger,
				workspace: context.workspace,
				...(file ? { session: { file } } : {}),
			});
		});

		api.on("tool_call", (event) => {
			if (run) run.toolCalls++;
			pending.set(event.toolCallId, {
				name: event.toolName,
				...(context.details === "summary" ? { summary: summarizeToolArgs(event.toolName, event.input) } : {}),
				startedAt: Date.now(),
			});
			return undefined;
		});

		api.on("tool_result", (event) => {
			writeTool(event.toolCallId, !event.isError);
			return undefined;
		});

		api.on("turn_end", (event) => {
			// Calls that never ran (blocked, denied, declined) have a result but no tool_result event.
			for (const result of event.toolResults) {
				if (!pending.has(result.toolCallId)) continue;
				const text = result.content
					.filter((block) => block.type === "text")
					.map((block) => (block as { text: string }).text)
					.join("");
				writeTool(result.toolCallId, false, text);
			}
			return undefined;
		});

		api.on("agent_end", (event, ctx) => {
			if (!run) return;
			// A subagent's refused calls end without a parent turn result.
			for (const id of [...pending.keys()]) writeTool(id, false, "");
			const assistants = event.messages.filter((message): message is AssistantMessage => message.role === "assistant");
			const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
			let cost = 0;
			for (const message of assistants) {
				usage.input += message.usage?.input ?? 0;
				usage.output += message.usage?.output ?? 0;
				usage.cacheRead += message.usage?.cacheRead ?? 0;
				usage.cacheWrite += message.usage?.cacheWrite ?? 0;
				cost += message.usage?.cost?.total ?? 0;
			}
			const last = assistants.at(-1);
			const tokens = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
			const file = ctx?.sessionManager?.getSessionFile();
			const entry = ctx?.sessionManager?.getLeafId() ?? undefined;
			context.ledger.write({
				...base(run.id),
				kind: "run",
				phase: "end",
				trigger: context.current().trigger,
				workspace: context.workspace,
				...(file ? { session: { file, ...(entry ? { entry } : {}) } } : {}),
				...(last ? { model: last.model } : {}),
				usage,
				// Unpriced models report zero: that is "unknown", not free.
				cost: cost > 0 ? cost : tokens > 0 ? null : 0,
				status: last?.stopReason === "aborted" ? "aborted" : last?.stopReason === "error" ? "error" : "ok",
				durationMs: Date.now() - run.startedAt,
				toolCalls: run.toolCalls,
			});
			run = undefined;
		});
	};
}

// ───────────────────────── reading ─────────────────────────

export interface RunSummary {
	runId: string;
	host: AuditHost;
	start?: RunRecord;
	end?: RunRecord;
	tools: ToolRecord[];
	messages: number;
	at: number;
}

/** Records grouped by run, newest first. */
export function groupRuns(records: readonly AuditRecord[]): RunSummary[] {
	const runs = new Map<string, RunSummary>();
	for (const record of records) {
		const run =
			runs.get(record.runId) ??
			(() => {
				const created: RunSummary = { runId: record.runId, host: record.host, tools: [], messages: 0, at: record.at };
				runs.set(record.runId, created);
				return created;
			})();
		run.at = Math.min(run.at, record.at);
		if (record.kind === "run") {
			if (record.phase === "start") run.start = record;
			else run.end = record;
		} else if (record.kind === "tool") run.tools.push(record);
		else run.messages++;
	}
	return [...runs.values()].filter((run) => run.start || run.end).sort((a, b) => b.at - a.at);
}

export interface AuditFilter {
	host?: string;
	trigger?: string;
	schedule?: string;
	channel?: string;
	tool?: string;
	decision?: string;
	status?: string;
	external?: boolean;
}

const triggerOf = (run: RunSummary): AuditTrigger | undefined => run.start?.trigger ?? run.end?.trigger;

/** Runs that pass the filters; tool filters also narrow each run's tools to the matching ones. */
export function filterRuns(runs: readonly RunSummary[], filter: AuditFilter): RunSummary[] {
	const toolFilter = filter.tool !== undefined || filter.decision !== undefined || filter.external === true;
	return runs.flatMap((run) => {
		const trigger = triggerOf(run);
		if (filter.host && run.host !== filter.host) return [];
		if (filter.trigger && trigger?.type !== filter.trigger) return [];
		if (filter.schedule && !(trigger?.type === "schedule" && trigger.scheduleId === filter.schedule)) return [];
		if (filter.channel && !(trigger && "channel" in trigger && trigger.channel === filter.channel)) return [];
		if (filter.status && run.end?.status !== filter.status) return [];
		if (!toolFilter) return [run];
		const tools = run.tools.filter(
			(tool) =>
				(filter.tool === undefined || tool.name === filter.tool) &&
				(filter.decision === undefined || tool.decision.source === filter.decision) &&
				(filter.external !== true || tool.external === true),
		);
		return tools.length > 0 ? [{ ...run, tools }] : [];
	});
}

const compact = (value: number) => (value >= 1000 ? `${(value / 1000).toFixed(1)}k` : String(value));

function tokensOf(run: RunSummary): number {
	const usage = run.end?.usage;
	return usage ? usage.input + usage.output + usage.cacheRead + usage.cacheWrite : 0;
}

/** Cost text: dollars when priced, "cost ?" when the model has no prices. */
export function costText(cost: number | null | undefined): string {
	if (cost === undefined) return "";
	if (cost === null) return "cost ?";
	return `$${cost < 0.01 ? cost.toFixed(4) : cost.toFixed(2)}`;
}

function triggerText(trigger: AuditTrigger | undefined): string {
	if (!trigger) return "";
	if (trigger.type === "schedule") return `schedule #${trigger.scheduleId} ${trigger.channel}/${trigger.peer}`;
	if (trigger.type === "chat") return `${trigger.channel}/${trigger.peer}${trigger.role === "owner" ? "" : " (guest)"}`;
	return trigger.type;
}

/** The grouped view of `tau audit`: one line per run, its tools indented, then where to read more. */
export function formatRuns(runs: readonly RunSummary[]): string {
	const lines: string[] = [];
	for (const run of runs) {
		const date = new Date(run.at);
		const when = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
		const end = run.end;
		const parts = [
			when,
			run.host,
			triggerText(triggerOf(run)),
			end?.model ?? "",
			`${run.tools.length} tool(s)`,
			tokensOf(run) > 0 ? `${compact(tokensOf(run))} tok` : "",
			costText(end?.cost),
			end ? `${end.status}${end.durationMs !== undefined ? ` ${Math.round(end.durationMs / 1000)}s` : ""}` : "running",
			run.messages > 0 ? `${run.messages} msg out` : "",
		].filter(Boolean);
		lines.push(parts.join("  "));
		for (const tool of run.tools) {
			const decided = `${tool.decision.source}${tool.decision.by ? ` by ${tool.decision.by}` : ""}`;
			lines.push(
				`    ${tool.ok ? "✓" : "✗"} ${tool.name}${tool.risk ? ` (${tool.risk})` : ""}  ${decided}${tool.external ? "  external" : ""}${tool.summary ? `  ${tool.summary}` : ""}`,
			);
		}
		const session = end?.session ?? run.start?.session;
		if (session) lines.push(`    session ${session.file}${session.entry ? ` #${session.entry}` : ""}`);
	}
	return lines.join("\n");
}

/**
 * A policy that tells the ledger when a permission rule decided a call (P37a):
 * allowed by an allow rule, or denied by a deny rule.
 */
export function auditedPolicy(policy: ToolPolicy, log: ApprovalLog): ToolPolicy {
	return {
		assess(call, mode) {
			const decision = policy.assess(call, mode);
			const rule = decision.rule;
			if (rule && call.toolCallId && (rule.kind === "deny" || decision.action === "allow")) {
				log.record(call.toolCallId, {
					source: rule.kind === "deny" ? "rule_deny" : "rule_allow",
					risk: decision.risk,
					rule: rule.source ? `${rule.text} (${rule.source})` : rule.text,
				});
			}
			return decision;
		},
		deniesTool: (toolName) => policy.deniesTool?.(toolName) ?? false,
	};
}

/** A handler's own word on how it decided ("always allow" = for the session), read once by auditedApproval. */
const sourceHints = new Map<string, DecisionSource>();

export function noteApprovalSource(toolCallId: string, source: DecisionSource): void {
	sourceHints.set(toolCallId, source);
}

/**
 * Wrap an approval handler so the ledger knows who decided: the user at a client (a handler that
 * throws counts as a refusal). The gateway's chat sources (chat_owner, timeout, …) stay readable in
 * old ledgers; nothing writes them since the gateway was archived (P62).
 */
export function auditedApproval(
	handler: ((request: import("@yophon/tau-kernel").ApprovalRequest) => Promise<boolean>) | undefined,
	log: ApprovalLog,
): typeof handler {
	if (!handler) return undefined;
	return async (request) => {
		try {
			const approved = await handler(request);
			const hint = sourceHints.get(request.toolCallId);
			sourceHints.delete(request.toolCallId);
			log.record(request.toolCallId, { source: hint ?? (approved ? "user_once" : "user_reject"), risk: request.risk });
			return approved;
		} catch (error) {
			log.record(request.toolCallId, { source: "user_reject", risk: request.risk });
			throw error;
		}
	};
}
