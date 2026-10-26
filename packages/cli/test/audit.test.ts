// P32c: the audit ledger, grouping and filtering, and who decided each approval.
import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import type { ApprovalRequest } from "@yophon/tau-kernel";
import {
	ApprovalLog,
	AuditLedger,
	type AuditRecord,
	auditedApproval,
	classifyRefusal,
	costText,
	filterRuns,
	formatRuns,
	groupRuns,
	noteApprovalSource,
	summarizeToolArgs,
} from "../src/audit.ts";
import { registerSecret, resetSecrets } from "../src/secrets.ts";

afterEach(() => resetSecrets());

const base = (runId: string, at: number) => ({ v: 1 as const, at, runId, host: "gateway" as const, pid: 1 });

function sample(at: number): AuditRecord[] {
	const chat = { type: "chat" as const, channel: "weixin", account: "a", peer: "boss", role: "owner" as const };
	const schedule = { type: "schedule" as const, scheduleId: "k3f9", channel: "weixin", account: "a", peer: "boss" };
	return [
		{ ...base("r1", at), kind: "run", phase: "start", trigger: chat, workspace: "/w", session: { file: "/s/1.jsonl" } },
		{
			...base("r1", at + 10),
			kind: "tool",
			toolCallId: "c1",
			name: "bash",
			risk: "medium",
			summary: "npm test",
			decision: { source: "chat_owner", by: "boss" },
			ok: true,
		},
		{ ...base("r1", at + 20), kind: "message", channel: "weixin", account: "a", peer: "boss", type: "text" },
		{
			...base("r1", at + 30),
			kind: "run",
			phase: "end",
			trigger: chat,
			workspace: "/w",
			session: { file: "/s/1.jsonl", entry: "e9" },
			model: "deepseek-flash",
			usage: { input: 1000, output: 200, cacheRead: 3000, cacheWrite: 0 },
			cost: 0.0042,
			status: "ok",
			durationMs: 12_000,
			toolCalls: 1,
		},
		{ ...base("r2", at + 100), kind: "run", phase: "start", trigger: schedule, workspace: "/w" },
		{
			...base("r2", at + 110),
			kind: "tool",
			toolCallId: "c2",
			name: "mcp__gh__list_issues",
			decision: { source: "mode" },
			external: true,
			ok: true,
		},
		{
			...base("r2", at + 120),
			kind: "run",
			phase: "end",
			trigger: schedule,
			workspace: "/w",
			usage: { input: 500, output: 50, cacheRead: 0, cacheWrite: 0 },
			cost: null,
			status: "ok",
			toolCalls: 1,
		},
	];
}

describe("audit ledger", () => {
	it("appends daily files, reads them back in order, skips torn lines and prunes after 30 days", () => {
		const dir = join(mkdtempSync(join(tmpdir(), "tau-audit-")), "audit");
		const ledger = new AuditLedger(dir);
		const now = new Date(2026, 9, 19, 10, 0).getTime();
		for (const record of sample(now)) ledger.write(record);
		const file = join(dir, "2026-10-19.jsonl");
		appendFileSync(file, '{"v":1,"at":\n');
		const read = ledger.read(now - 1000);
		assert.equal(read.length, 7);
		assert.deepEqual(
			read.map((record) => record.kind),
			["run", "tool", "message", "run", "run", "tool", "run"],
		);
		writeFileSync(join(dir, "2026-09-01.jsonl"), "");
		writeFileSync(join(dir, "2026-09-25.jsonl"), "");
		new AuditLedger(dir).write({ ...sample(now)[2], at: now } as AuditRecord);
		assert.equal(existsSync(join(dir, "2026-09-01.jsonl")), false, "older than 30 days is removed");
		assert.equal(existsSync(join(dir, "2026-09-25.jsonl")), true);
	});

	it("groups runs, filters by trigger, schedule, tool and decision, and totals them", () => {
		const now = Date.now();
		const runs = groupRuns(sample(now));
		assert.deepEqual(
			runs.map((run) => run.runId),
			["r2", "r1"],
		);
		assert.deepEqual(
			filterRuns(runs, { trigger: "schedule" }).map((run) => run.runId),
			["r2"],
		);
		assert.deepEqual(
			filterRuns(runs, { schedule: "k3f9" }).map((run) => run.runId),
			["r2"],
		);
		assert.deepEqual(
			filterRuns(runs, { decision: "chat_owner" }).map((run) => run.runId),
			["r1"],
		);
		assert.deepEqual(
			filterRuns(runs, { external: true }).map((run) => run.runId),
			["r2"],
		);
		assert.equal(filterRuns(runs, { tool: "bash", decision: "mode" }).length, 0);
		const text = formatRuns(runs);
		assert.match(
			text,
			/gateway {2}weixin\/boss {2}deepseek-flash {2}1 tool\(s\) {2}4\.2k tok {2}\$0\.0042 {2}ok 12s {2}1 msg out/,
		);
		assert.match(text, /\n {4}✓ bash \(medium\) {2}chat_owner by boss {2}npm test/);
		assert.match(text, /\n {4}session \/s\/1\.jsonl #e9/);
		assert.match(text, /schedule #k3f9 weixin\/boss/);
		assert.match(text, /✓ mcp__gh__list_issues {2}mode {2}external/);
		assert.match(text, /cost \?/);
		assert.equal(costText(1.5), "$1.50");
	});

	it("classifies calls that never ran and masks summaries", () => {
		assert.equal(classifyRefusal("Tool call blocked: Blocked: credentials.json holds tau's credentials."), "hook");
		assert.equal(
			classifyRefusal("Denied by policy: approval required (medium), but no approval handler is available"),
			"no_approver",
		);
		assert.equal(classifyRefusal("Denied by policy: rm -rf is dangerous"), "policy_deny");
		registerSecret("sk-secret-1234567890", "OPENAI_API_KEY");
		assert.equal(
			summarizeToolArgs("bash", { command: "curl -H 'k: sk-secret-1234567890'  x" }),
			"curl -H 'k: [已隐藏:OPENAI_API_KEY]' x",
		);
		assert.equal(summarizeToolArgs("read", { path: "src/a.ts" }), "src/a.ts");
	});
});

describe("approval sources", () => {
	const request = (id: string): ApprovalRequest => ({ toolCallId: id, toolName: "bash", args: {}, risk: "medium" });

	it("records terminal decisions, including a session-wide allow", async () => {
		const log = new ApprovalLog();
		const answers = [true, false, true];
		const handler = auditedApproval(async (req) => {
			const answer = answers.shift() ?? false;
			if (req.toolCallId === "t3") noteApprovalSource("t3", "user_session");
			return answer;
		}, log);
		assert.equal(await handler?.(request("t1")), true);
		assert.equal(await handler?.(request("t2")), false);
		await handler?.(request("t3"));
		assert.deepEqual(log.take("t1"), { source: "user_once", risk: "medium" });
		assert.deepEqual(log.take("t2"), { source: "user_reject", risk: "medium" });
		assert.equal(log.take("t3")?.source, "user_session");
		assert.equal(log.take("t1"), undefined, "read once");
		assert.equal(auditedApproval(undefined, log), undefined);
	});
});
