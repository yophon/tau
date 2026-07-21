// P19：Quick Tunnel URL 解析纯函数单测（不真连 Cloudflare）。
import assert from "node:assert/strict";
import { test } from "node:test";
import { extractTryCloudflareUrl } from "../tunnel.mjs";

test("extracts the URL from cloudflared's banner box line", () => {
	const line = "2026-07-21T03:00:00Z INF |  https://neat-random-words-here.trycloudflare.com                                    |";
	assert.equal(extractTryCloudflareUrl(line), "https://neat-random-words-here.trycloudflare.com");
});

test("returns null for unrelated log lines", () => {
	assert.equal(extractTryCloudflareUrl("2026-07-21T03:00:00Z INF Requesting new quick Tunnel on trycloudflare.com..."), null);
	assert.equal(extractTryCloudflareUrl(""), null);
	assert.equal(extractTryCloudflareUrl("https://example.com"), null);
});

test("rejects lookalike hosts and http scheme", () => {
	assert.equal(extractTryCloudflareUrl("http://foo.trycloudflare.com"), null);
	assert.equal(extractTryCloudflareUrl("https://foo.trycloudflare.com.evil.example"), null);
});
