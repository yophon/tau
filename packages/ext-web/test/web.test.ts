// P28c: web_fetch, web_search and the HTML-to-markdown converter.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ExtensionRegistry, type Platform, type PlatformRequestInit, type PlatformResponse } from "@yophon/tau-kernel";
import {
	createWebExtension,
	createWebFetchTool,
	createWebSearchTool,
	htmlToMarkdown,
	pageWindow,
	parseSearchResponse,
	resolveUrl,
	searchRequest,
	WEB_FETCH_MAX_BYTES,
	type WebSearchConfig,
} from "../src/index.ts";

const encoder = new TextEncoder();

function response(
	body: string | Uint8Array,
	options: { status?: number; type?: string; chunk?: number } = {},
): PlatformResponse {
	const bytes = typeof body === "string" ? encoder.encode(body) : body;
	const chunk = options.chunk ?? 64 * 1024;
	return {
		ok: (options.status ?? 200) < 400,
		status: options.status ?? 200,
		text: async () => new TextDecoder().decode(bytes),
		headers: { get: (name) => (name.toLowerCase() === "content-type" ? (options.type ?? null) : null) },
		body: {
			getReader() {
				let at = 0;
				return {
					read: async () => {
						if (at >= bytes.length) return { done: true };
						const value = bytes.subarray(at, at + chunk);
						at += chunk;
						return { done: false, value };
					},
					cancel: () => undefined,
				};
			},
		},
	};
}

function platform(
	handler: (url: string, init: PlatformRequestInit | undefined) => Promise<PlatformResponse>,
	extra: Partial<Platform> = {},
): Platform & { calls: Array<{ url: string; init: PlatformRequestInit | undefined }> } {
	const calls: Array<{ url: string; init: PlatformRequestInit | undefined }> = [];
	return {
		calls,
		fetch: async (url, init) => {
			calls.push({ url, init });
			return handler(url, init);
		},
		createUtf8Decoder: () => {
			const decoder = new TextDecoder();
			return { decode: (chunk) => decoder.decode(chunk, { stream: true }), flush: () => decoder.decode() };
		},
		randomBytes: (n) => new Uint8Array(n),
		...extra,
	};
}

const text = (result: { content: Array<{ type: string; text?: string }> }): string =>
	result.content.map((block) => block.text ?? "").join("");

describe("htmlToMarkdown", () => {
	it("keeps the main content and drops scripts, styles and page chrome", () => {
		const html = `<!doctype html><html><head><title>Guide &amp; API</title><style>p{}</style></head>
			<body><nav><a href="/">Home</a></nav><main><h1>Install</h1><p>Run <code>npm i tau</code>, then <strong>start</strong>.</p>
			<script>alert(1)</script></main><footer>© 2026</footer></body></html>`;
		const { title, markdown } = htmlToMarkdown(html, "https://docs.example.com/guide/index.html");
		assert.equal(title, "Guide & API");
		assert.equal(markdown, "# Install\n\nRun `npm i tau`, then **start**.");
	});

	it("converts links (absolute), images, lists, code blocks, quotes and tables", () => {
		const html = `<article>
			<p>See <a href="../api/run.html#opts">run()</a> and <a href="javascript:void 0">nothing</a>.</p>
			<img src="/img/a.png" alt="diagram">
			<ul><li>one</li><li>two<ol><li>nested</li></ol></li></ul>
			<pre><code class="language-ts">const a = 1;
if (a &lt; 2) {}</code></pre>
			<blockquote><p>Quoted line</p></blockquote>
			<table><tr><th>Flag</th><th>Meaning</th></tr><tr><td>-p</td><td>print | once</td></tr></table>
		</article>`;
		const { markdown } = htmlToMarkdown(html, "https://docs.example.com/guide/start.html");
		assert.match(markdown, /See \[run\(\)\]\(https:\/\/docs\.example\.com\/api\/run\.html#opts\) and nothing\./);
		assert.match(markdown, /!\[diagram\]\(https:\/\/docs\.example\.com\/img\/a\.png\)/);
		assert.match(markdown, /- one\n- two\n {2}1\. nested/);
		assert.match(markdown, /```ts\nconst a = 1;\nif \(a < 2\) \{\}\n```/);
		assert.match(markdown, /> Quoted line/);
		assert.match(markdown, /\| Flag \| Meaning \|\n\| --- \| --- \|\n\| -p \| print \\\| once \|/);
	});

	it("finds the content on pages without <main>: chrome by id/class/role goes, repeated sections stay together", () => {
		const docs = `<!DOCTYPE html><body><div class="layout with-sidebar">
			<div id="column2" class="sidenav"><ul><li><a href="/a">Assert</a></li><li><a href="/b">Buffer</a></li></ul></div>
			<div role="navigation"><a href="/x">Home</a></div>
			<div id="apicontent"><h2>path.join</h2><p>Joins all given path segments together using the platform separator.</p></div>
		</div></body>`;
		assert.equal(
			htmlToMarkdown(docs).markdown,
			"## path.join\n\nJoins all given path segments together using the platform separator.",
		);
		const sections = `<main><section class="content-section"><h2>One</h2><p>First part of the page, long enough to count as text.</p></section>
			<section class="content-section"><h2>Two</h2><p>Second part of the page, also long enough to count.</p></section></main>`;
		const markdown = htmlToMarkdown(sections).markdown;
		assert.match(markdown, /## One[\s\S]*## Two/);
	});

	it("resolves references like a browser does", () => {
		const base = "https://a.example/x/y/page.html?q=1#top";
		assert.equal(resolveUrl("z.html", base), "https://a.example/x/y/z.html");
		assert.equal(resolveUrl("../z.html", base), "https://a.example/x/z.html");
		assert.equal(resolveUrl("/root", base), "https://a.example/root");
		assert.equal(resolveUrl("//cdn.example/l.js", base), "https://cdn.example/l.js");
		assert.equal(resolveUrl("#sec", base), "https://a.example/x/y/page.html?q=1#sec");
		assert.equal(resolveUrl("?p=2", base), "https://a.example/x/y/page.html?p=2");
		assert.equal(resolveUrl("mailto:x@example.com", base), "mailto:x@example.com");
	});
});

describe("web_fetch", () => {
	it("returns HTML as markdown with title and source", async () => {
		const p = platform(async () =>
			response("<title>T</title><p>Hello <a href='/b'>b</a></p>", { type: "text/html; charset=utf-8" }),
		);
		const result = await createWebFetchTool({ platform: p, userAgent: "tau-test" }).execute({
			url: "https://x.example/a",
		});
		assert.equal(text(result), "# T\n\nSource: https://x.example/a\n\nHello [b](https://x.example/b)");
		assert.equal(p.calls[0]?.init?.headers?.["User-Agent"], "tau-test");
	});

	it("passes text and JSON through, returns images as image blocks, refuses other binaries", async () => {
		const bodies: Record<string, PlatformResponse> = {
			"https://x.example/t.txt": response("plain text", { type: "text/plain" }),
			"https://x.example/d.json": response('{"a":1}', { type: "application/json" }),
			"https://x.example/i.png": response(new Uint8Array([137, 80, 78, 71]), { type: "image/png" }),
			"https://x.example/f.pdf": response("%PDF-1.7", { type: "application/pdf" }),
		};
		const tool = createWebFetchTool({ platform: platform(async (url) => bodies[url] as PlatformResponse) });
		assert.equal(text(await tool.execute({ url: "https://x.example/t.txt" })), "plain text");
		assert.equal(text(await tool.execute({ url: "https://x.example/d.json" })), '{"a":1}');
		const image = await tool.execute({ url: "https://x.example/i.png" });
		assert.deepEqual(image.content[0], { type: "image", data: "iVBORw==", mimeType: "image/png" });
		const pdf = await tool.execute({ url: "https://x.example/f.pdf" });
		assert.equal(pdf.isError, true);
		assert.match(text(pdf), /application\/pdf: web_fetch reads HTML, text, JSON and images only/);
	});

	it("reports HTTP errors and refuses non-http URLs", async () => {
		const tool = createWebFetchTool({ platform: platform(async () => response("gone", { status: 404 })) });
		const missing = await tool.execute({ url: "https://x.example/missing" });
		assert.equal(missing.isError, true);
		assert.equal(text(missing), "HTTP 404 for https://x.example/missing: gone");
		const file = await tool.execute({ url: "file:///etc/passwd" });
		assert.equal(file.isError, true);
		assert.match(text(file), /absolute http:\/\/ or https:\/\/ URL/);
	});

	it("cuts long pages at 50KB and continues from offset", async () => {
		const long = "x".repeat(WEB_FETCH_MAX_BYTES + 100);
		const first = pageWindow(long, 0);
		assert.match(
			first,
			new RegExp(
				`\\[Characters 0–${WEB_FETCH_MAX_BYTES} of ${long.length}\\. Use offset=${WEB_FETCH_MAX_BYTES} to read more\\.\\]$`,
			),
		);
		const second = pageWindow(long, WEB_FETCH_MAX_BYTES);
		assert.match(second, /^x{100}\n\n\[Characters 51200–51300 of 51300: the end of the page\.\]$/);
		const tool = createWebFetchTool({ platform: platform(async () => response(long, { type: "text/plain" })) });
		assert.match(
			text(await tool.execute({ url: "https://x.example/l", offset: WEB_FETCH_MAX_BYTES })),
			/the end of the page/,
		);
	});

	it("times out through Platform.sleep", async () => {
		let release: (() => void) | undefined;
		const p = platform(
			(_url, init) =>
				new Promise((_resolve, reject) => {
					init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
				}),
			{
				sleep: (_ms, _signal) =>
					new Promise<void>((resolve) => {
						release = resolve;
					}),
			},
		);
		const pending = createWebFetchTool({ platform: p, timeoutMs: 5 }).execute({ url: "https://slow.example" });
		await new Promise((resolve) => setTimeout(resolve, 5));
		release?.();
		const result = await pending;
		assert.equal(result.isError, true);
		assert.match(text(result), /timed out/);
	});
});

describe("web_search", () => {
	const cases: Array<[WebSearchConfig, string, unknown]> = [
		[
			{ provider: "brave", apiKey: "bk" },
			"https://api.search.brave.com/res/v1/web/search?q=tau%20agent&count=3",
			{ web: { results: [{ title: "Tau", url: "https://t.example", description: "an agent" }] } },
		],
		[
			{ provider: "tavily", apiKey: "tk" },
			"https://api.tavily.com/search",
			{ results: [{ title: "Tau", url: "https://t.example", content: "an agent" }] },
		],
		[
			{ provider: "exa", apiKey: "ek" },
			"https://api.exa.ai/search",
			{ results: [{ title: "Tau", url: "https://t.example", text: "an agent" }] },
		],
		[
			{ provider: "searxng", baseUrl: "https://searx.example/" },
			"https://searx.example/search?q=tau%20agent&format=json",
			{ results: [{ title: "Tau", url: "https://t.example", content: "an agent" }] },
		],
	];

	for (const [config, url, body] of cases) {
		it(`${config.provider}: request shape and result parsing`, async () => {
			const request = searchRequest(config, "tau agent", 3);
			assert.equal(request.url, url);
			if (config.provider === "brave") assert.equal(request.init.headers["X-Subscription-Token"], "bk");
			if (config.provider === "tavily") {
				assert.equal(request.init.headers.Authorization, "Bearer tk");
				assert.deepEqual(JSON.parse(request.init.body ?? ""), { query: "tau agent", max_results: 3 });
			}
			if (config.provider === "exa") assert.equal(request.init.headers["x-api-key"], "ek");
			assert.deepEqual(parseSearchResponse(config.provider, body), [
				{ title: "Tau", url: "https://t.example", snippet: "an agent" },
			]);
			const p = platform(async () => response(JSON.stringify(body), { type: "application/json" }));
			const result = await createWebSearchTool(config, { platform: p }).execute({ query: "tau agent", maxResults: 3 });
			assert.equal(text(result), "1. Tau\n   https://t.example\n   an agent");
		});
	}

	it("clamps maxResults, reports provider errors and empty results", async () => {
		const p = platform(async () => response('{"results":[]}', { type: "application/json" }));
		const tool = createWebSearchTool({ provider: "tavily", apiKey: "k" }, { platform: p });
		assert.equal(text(await tool.execute({ query: "nothing", maxResults: 50 })), 'No results for "nothing".');
		assert.deepEqual(JSON.parse(p.calls[0]?.init?.body ?? "{}").max_results, 10);
		const failing = createWebSearchTool(
			{ provider: "brave", apiKey: "bad" },
			{ platform: platform(async () => response("unauthorized", { status: 401 })) },
		);
		const result = await failing.execute({ query: "x" });
		assert.equal(result.isError, true);
		assert.equal(text(result), "brave search failed: HTTP 401 unauthorized");
	});

	it("the extension registers web_search only with a provider; web_fetch is medium risk, web_search low", async () => {
		const bare = await ExtensionRegistry.load([createWebExtension()]);
		assert.deepEqual([...bare.tools.keys()], ["web_fetch"]);
		const full = await ExtensionRegistry.load([createWebExtension({ search: { provider: "exa", apiKey: "k" } })]);
		assert.deepEqual([...full.tools.keys()], ["web_fetch", "web_search"]);
		assert.equal((full.tools.get("web_fetch") as { risk?: string }).risk, "medium");
		assert.equal((full.tools.get("web_search") as { risk?: string }).risk, "low");
	});
});
