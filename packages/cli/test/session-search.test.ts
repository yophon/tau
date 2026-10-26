// P32a: session_search / session_read over a person's own session files.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { parseSince, readSessionAround, type SessionRoot, searchSessions } from "../src/session-search.ts";

let seq = 0;
function entry(role: "user" | "assistant" | "toolResult", text: string, at: string): string {
	const content = role === "user" ? text : [{ type: "text", text }];
	return JSON.stringify({
		type: "message",
		id: `e${++seq}`,
		parentId: null,
		timestamp: at,
		message: { role, content },
	});
}

function session(path: string, lines: string[], mtime?: Date): void {
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(
		path,
		`${[JSON.stringify({ type: "session", version: 3, id: "s", cwd: "/w" }), ...lines].join("\n")}\n`,
	);
	if (mtime) utimesSync(path, mtime, mtime);
}

function fixture() {
	const home = mkdtempSync(join(tmpdir(), "tau-search-"));
	const cli = join(home, "sessions");
	const elsewhere = join(home, "elsewhere");
	session(
		join(cli, "proj", "old.jsonl"),
		[
			entry("user", "我们讨论一下部署方案：用 rsync 推到 yophon 服务器", "2026-10-01T02:00:00Z"),
			entry("assistant", "好的，部署方案定为 rsync + systemd 重启", "2026-10-01T02:01:00Z"),
			entry("toolResult", "部署方案 tool output must not match", "2026-10-01T02:02:00Z"),
		],
		new Date("2026-10-01T03:00:00Z"),
	);
	session(
		join(cli, "proj", "new.jsonl"),
		[entry("user", "Deploy plan v2: blue/green", "2026-10-15T02:00:00Z")],
		new Date("2026-10-15T03:00:00Z"),
	);
	session(join(cli, "other", "mid.jsonl"), [entry("user", "老板说部署方案周五上线", "2026-10-12T02:00:00Z")]);
	// Not among the roots searched: never read.
	session(join(elsewhere, "chat.jsonl"), [entry("user", "bob 的部署方案秘密", "2026-10-12T03:00:00Z")]);
	const owner: SessionRoot[] = [{ dir: cli }];
	const bob: SessionRoot[] = [{ dir: elsewhere }];
	return { home, cli, elsewhere, owner, bob };
}

describe("session search", () => {
	it("finds messages with every word, newest first, in user and assistant text only", () => {
		const { owner } = fixture();
		const result = searchSessions(owner, "部署方案");
		assert.equal(result.complete, true);
		const snippets = result.hits.map((hit) => hit.snippet);
		assert.ok(snippets.some((text) => text.includes("老板说部署方案周五上线")));
		assert.ok(snippets.some((text) => text.includes("rsync + systemd")));
		assert.ok(!snippets.some((text) => text.includes("tool output")), "tool results are not searched");
		assert.ok(!snippets.some((text) => text.includes("bob")), "a directory outside the roots is not searched");
		assert.match(result.text, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2} · (user|assistant) · .*\.jsonl · entry e\d+\n {2}/);
		assert.match(result.text, /Read more around a hit with session_read\.$/);
		const both = searchSessions(owner, "部署方案 rsync");
		assert.equal(both.hits.length, 2);
		assert.equal(searchSessions(owner, "DEPLOY plan").hits.length, 1, "case-insensitive");
	});

	it("honours since, limit and the excluded current session", () => {
		const { owner, cli } = fixture();
		const since = searchSessions(owner, "部署方案", { since: "2026-10-10", now: Date.parse("2026-10-19T00:00:00Z") });
		assert.ok(since.hits.every((hit) => !hit.snippet.includes("rsync")));
		assert.equal(searchSessions(owner, "部署方案", { limit: 1 }).hits.length, 1);
		const excluded = searchSessions(owner, "deploy", { exclude: join(cli, "proj", "new.jsonl") });
		assert.equal(excluded.hits.length, 0);
		assert.match(excluded.text, /No earlier session mentions "deploy"\./);
		assert.throws(() => searchSessions(owner, "   "), /query is empty/);
		assert.equal(parseSince("7d", Date.parse("2026-10-19T00:00:00Z")), Date.parse("2026-10-12T00:00:00Z"));
		assert.throws(() => parseSince("soon"), /not like 7d/);
	});

	it("searches only its own roots", () => {
		const { bob } = fixture();
		const hits = searchSessions(bob, "部署方案").hits;
		assert.deepEqual(
			hits.map((hit) => hit.snippet),
			["bob 的部署方案秘密"],
		);
	});

	it("stops at the scan budget and says so", () => {
		const { owner } = fixture();
		const result = searchSessions(owner, "部署方案", { maxBytes: 0 });
		assert.equal(result.complete, false);
		assert.match(result.text, /stopped early/);
	});

	it("reads around a hit, only in files the person may search", () => {
		const { owner, bob, elsewhere, cli } = fixture();
		const hit = searchSessions(owner, "rsync 推到").hits[0];
		assert.ok(hit);
		const around = readSessionAround(owner, hit.file, hit.entry, { before: 0, after: 1 });
		assert.match(around, /^▶ \d{4}-\d{2}-\d{2} \d{2}:\d{2} user: 我们讨论一下部署方案/);
		assert.match(around, /assistant: 好的，部署方案定为/);
		assert.throws(() => readSessionAround(owner, join(elsewhere, "chat.jsonl"), "e1"), /not one of the sessions/);
		assert.throws(() => readSessionAround(bob, join(cli, "proj", "old.jsonl"), hit.entry), /not one of the sessions/);
		assert.throws(() => readSessionAround(owner, hit.file, "nope"), /is not a message/);
	});
});
