import assert from "node:assert/strict";
import { test } from "node:test";
import { SseParser } from "../src/sse.ts";

test("parses events split across arbitrary chunk boundaries", () => {
	const parser = new SseParser();
	const events = [
		...parser.push("da"),
		...parser.push("ta: hel"),
		...parser.push("lo\n\nda"),
		...parser.push("ta: world\n\n"),
	];
	assert.deepEqual(
		events.map((event) => event.data),
		["hello", "world"],
	);
});

test("handles CRLF, comments, event names, and multi-line data", () => {
	const parser = new SseParser();
	const events = parser.push(": comment\r\nevent: message\r\ndata: line1\r\ndata: line2\r\n\r\n");
	assert.equal(events.length, 1);
	assert.equal(events[0].event, "message");
	assert.equal(events[0].data, "line1\nline2");
});

test("flush emits a trailing event without terminating blank line", () => {
	const parser = new SseParser();
	assert.deepEqual(parser.push("data: incomplete"), []);
	const events = parser.flush();
	assert.equal(events.length, 1);
	assert.equal(events[0].data, "incomplete");
});
