/**
 * Web tools for tau (P28): `web_fetch` reads a page as markdown over
 * Platform.fetch (pure ES, every host; browsers are subject to CORS), and
 * `web_search` asks a search API with the user's own key (BYOK: Brave, Tavily,
 * Exa, or a self-hosted SearXNG).
 */
import {
	AbortHandle,
	type Extension,
	encodeBase64,
	type Platform,
	type PlatformResponse,
	type TauAbortSignal,
	type Tool,
	type ToolResult,
	utf8CodePointLength,
} from "@yophon/tau-kernel";
import { htmlToMarkdown } from "./html.ts";

export { decodeEntities, type HtmlToMarkdownResult, htmlToMarkdown, resolveUrl } from "./html.ts";

export type WebSearchProvider = "brave" | "tavily" | "exa" | "searxng";

export interface WebSearchConfig {
	provider: WebSearchProvider;
	/** Required except for searxng. */
	apiKey?: string;
	/** Required for searxng (the instance); optional elsewhere (a proxy). */
	baseUrl?: string;
}

export interface WebExtensionOptions {
	/** Registers web_search when set. */
	search?: WebSearchConfig;
	/** Fallback when a tool call carries no context platform (tests, bare hosts). */
	platform?: Platform;
	/** Sent where the host lets it be set (not in browsers). */
	userAgent?: string;
	/** Per request; default 30 s. Needs Platform.sleep, otherwise only the call's signal stops it. */
	timeoutMs?: number;
}

/** Output cap of one web_fetch result, as read's (50 KB). */
export const WEB_FETCH_MAX_BYTES = 50 * 1024;
/** Download cap: bodies beyond it are cut off. */
export const WEB_FETCH_MAX_DOWNLOAD = 5 * 1024 * 1024;
export const WEB_SEARCH_DEFAULT_RESULTS = 5;
export const WEB_SEARCH_MAX_RESULTS = 10;

const IMAGE_TYPES: Record<string, string> = {
	"image/png": "image/png",
	"image/jpeg": "image/jpeg",
	"image/jpg": "image/jpeg",
	"image/gif": "image/gif",
	"image/webp": "image/webp",
};

const errorResult = (text: string): ToolResult => ({ content: [{ type: "text", text }], isError: true });

/** An abort handle that follows the call's signal and fires after `ms` when the platform has timers. */
function timedSignal(platform: Platform, signal: TauAbortSignal | undefined, ms: number): AbortHandle {
	const handle = new AbortHandle();
	handle.follow(signal);
	if (platform.sleep && ms > 0) {
		platform.sleep(ms, handle.signal).then(
			() => handle.abort(new Error(`timed out after ${Math.round(ms / 1000)}s`)),
			() => undefined,
		);
	}
	return handle;
}

async function readBody(
	response: Pick<PlatformResponse, "body" | "text">,
	limit: number,
): Promise<{ bytes: Uint8Array; cut: boolean } | { text: string }> {
	if (!response.body) return { text: await response.text() };
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	let cut = false;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		if (!value) continue;
		if (size + value.length > limit) {
			chunks.push(value.subarray(0, limit - size));
			size = limit;
			cut = true;
			await Promise.resolve(reader.cancel()).catch(() => undefined);
			break;
		}
		chunks.push(value);
		size += value.length;
	}
	const bytes = new Uint8Array(size);
	let at = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, at);
		at += chunk.length;
	}
	return { bytes, cut };
}

function decodeText(platform: Platform, bytes: Uint8Array): string {
	const decoder = platform.createUtf8Decoder();
	return decoder.decode(bytes) + decoder.flush();
}

/** The page from `offset` (characters), held to WEB_FETCH_MAX_BYTES, with pi-style continuation notice. */
export function pageWindow(text: string, offset: number): string {
	const chars = Array.from(text);
	const start = Math.min(Math.max(0, Math.floor(offset)), chars.length);
	let end = start;
	let bytes = 0;
	while (end < chars.length) {
		const size = utf8CodePointLength(chars[end]?.codePointAt(0) ?? 0);
		if (bytes + size > WEB_FETCH_MAX_BYTES) break;
		bytes += size;
		end++;
	}
	const body = chars.slice(start, end).join("");
	if (start === 0 && end === chars.length) return body;
	if (end === chars.length) return `${body}\n\n[Characters ${start}–${end} of ${chars.length}: the end of the page.]`;
	return `${body}\n\n[Characters ${start}–${end} of ${chars.length}. Use offset=${end} to read more.]`;
}

export function createWebFetchTool(options: WebExtensionOptions = {}): Tool {
	return {
		name: "web_fetch",
		description:
			"Fetch a web page or file over HTTP(S). HTML comes back as markdown (main content, absolute links); text and JSON as is; png/jpg/gif/webp as an image. Long pages are cut at 50KB: pass offset to read on.",
		promptSnippet: "Fetch a web page as markdown",
		promptGuidelines: [
			"Use web_fetch for documentation, issues and pages the user links; prefer it over guessing APIs.",
			"Never put secrets, tokens or file contents into a URL you fetch.",
		],
		parameters: {
			type: "object",
			properties: {
				url: { type: "string", description: "Absolute http:// or https:// URL" },
				offset: { type: "number", description: "Character offset to continue a long page from (default 0)" },
			},
			required: ["url"],
		},
		execute: async (args, signal, _onUpdate, ctx) => {
			const url = typeof args.url === "string" ? args.url.trim() : "";
			if (!/^https?:\/\/[^\s/]/i.test(url)) return errorResult("web_fetch needs an absolute http:// or https:// URL.");
			const platform = ctx?.capabilities?.platform ?? options.platform;
			if (!platform) return errorResult("web_fetch is not available: the host provides no Platform.");
			const offset = typeof args.offset === "number" && args.offset > 0 ? args.offset : 0;
			const handle = timedSignal(platform, signal, options.timeoutMs ?? 30_000);
			try {
				const response = await platform.fetch(url, {
					method: "GET",
					headers: {
						Accept: "text/html,application/xhtml+xml,text/markdown;q=0.9,text/plain;q=0.8,*/*;q=0.5",
						...(options.userAgent ? { "User-Agent": options.userAgent } : {}),
					},
					signal: handle.signal,
				});
				const type = (response.headers?.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
				if (!response.ok) {
					const body = await response.text().catch(() => "");
					return errorResult(
						`HTTP ${response.status} for ${url}${body ? `: ${body.replace(/\s+/g, " ").slice(0, 200)}` : ""}`,
					);
				}
				const image = IMAGE_TYPES[type];
				const read = await readBody(response, WEB_FETCH_MAX_DOWNLOAD);
				if (image) {
					if (!("bytes" in read) || read.cut) return errorResult(`The image at ${url} is over 5MB or unreadable.`);
					return { content: [{ type: "image", data: encodeBase64(read.bytes), mimeType: image }] };
				}
				const textBody = "text" in read ? read.text : decodeText(platform, read.bytes);
				const cutNote = "bytes" in read && read.cut ? "\n\n[The download stopped at 5MB.]" : "";
				const looksHtml =
					type === "text/html" || type === "application/xhtml+xml" || (type === "" && /^\s*</.test(textBody));
				const textual =
					looksHtml || type === "" || type.startsWith("text/") || /json|xml|javascript|yaml|toml/.test(type);
				if (!textual) {
					return errorResult(`${url} is ${type}: web_fetch reads HTML, text, JSON and images only.`);
				}
				let page: string;
				if (looksHtml) {
					const converted = htmlToMarkdown(textBody, url);
					page = `${converted.title ? `# ${converted.title}\n\n` : ""}Source: ${url}\n\n${converted.markdown}`;
				} else {
					page = textBody;
				}
				return { content: [{ type: "text", text: `${pageWindow(page, offset)}${cutNote}` }] };
			} catch (error) {
				if (signal?.aborted) return errorResult("web_fetch aborted");
				const message = error instanceof Error ? error.message : String(error);
				return errorResult(
					`web_fetch failed for ${url}: ${handle.signal.aborted && !signal?.aborted ? "timed out" : message}`,
				);
			} finally {
				handle.abort();
			}
		},
	};
}

interface SearchHit {
	title: string;
	url: string;
	snippet: string;
}

const asString = (value: unknown): string => (typeof value === "string" ? value : "");

function hits(list: unknown, snippetKeys: readonly string[]): SearchHit[] {
	if (!Array.isArray(list)) return [];
	return list.flatMap((item) => {
		if (typeof item !== "object" || item === null) return [];
		const record = item as Record<string, unknown>;
		const url = asString(record.url);
		if (url === "") return [];
		const snippet = snippetKeys.map((key) => asString(record[key])).find((value) => value !== "") ?? "";
		return [{ title: asString(record.title) || url, url, snippet }];
	});
}

/** The request one provider needs (exported for tests). */
export function searchRequest(
	config: WebSearchConfig,
	query: string,
	count: number,
): { url: string; init: { method: string; headers: Record<string, string>; body?: string } } {
	const q = encodeURIComponent(query);
	const base = (fallback: string): string => (config.baseUrl ?? fallback).replace(/\/+$/, "");
	switch (config.provider) {
		case "brave":
			return {
				url: `${base("https://api.search.brave.com")}/res/v1/web/search?q=${q}&count=${count}`,
				init: { method: "GET", headers: { Accept: "application/json", "X-Subscription-Token": config.apiKey ?? "" } },
			};
		case "tavily":
			return {
				url: `${base("https://api.tavily.com")}/search`,
				init: {
					method: "POST",
					headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.apiKey ?? ""}` },
					body: JSON.stringify({ query, max_results: count }),
				},
			};
		case "exa":
			return {
				url: `${base("https://api.exa.ai")}/search`,
				init: {
					method: "POST",
					headers: { "Content-Type": "application/json", "x-api-key": config.apiKey ?? "" },
					body: JSON.stringify({ query, numResults: count, contents: { text: { maxCharacters: 400 } } }),
				},
			};
		case "searxng":
			return {
				url: `${base("http://localhost:8080")}/search?q=${q}&format=json`,
				init: { method: "GET", headers: { Accept: "application/json" } },
			};
	}
}

/** The hits in one provider's response (exported for tests). */
export function parseSearchResponse(provider: WebSearchProvider, body: unknown): SearchHit[] {
	const record = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
	switch (provider) {
		case "brave": {
			const web = record.web;
			return hits(typeof web === "object" && web !== null ? (web as Record<string, unknown>).results : undefined, [
				"description",
			]);
		}
		case "tavily":
			return hits(record.results, ["content"]);
		case "exa":
			return hits(record.results, ["text", "summary"]);
		case "searxng":
			return hits(record.results, ["content"]);
	}
}

export function createWebSearchTool(config: WebSearchConfig, options: WebExtensionOptions = {}): Tool {
	return {
		name: "web_search",
		description: `Search the web (${config.provider}). Returns titles, URLs and snippets; fetch a result with web_fetch to read it.`,
		promptSnippet: "Search the web",
		promptGuidelines: [
			"Use web_search for current information, error messages and documentation you do not know; then web_fetch the best results.",
		],
		parameters: {
			type: "object",
			properties: {
				query: { type: "string", description: "The search query" },
				maxResults: {
					type: "number",
					description: `How many results (default ${WEB_SEARCH_DEFAULT_RESULTS}, at most ${WEB_SEARCH_MAX_RESULTS})`,
				},
			},
			required: ["query"],
		},
		execute: async (args, signal, _onUpdate, ctx) => {
			const query = typeof args.query === "string" ? args.query.trim() : "";
			if (query === "") return errorResult("web_search needs a query.");
			const platform = ctx?.capabilities?.platform ?? options.platform;
			if (!platform) return errorResult("web_search is not available: the host provides no Platform.");
			const requested = typeof args.maxResults === "number" ? Math.floor(args.maxResults) : WEB_SEARCH_DEFAULT_RESULTS;
			const count = Math.min(Math.max(1, requested), WEB_SEARCH_MAX_RESULTS);
			const { url, init } = searchRequest(config, query, count);
			const handle = timedSignal(platform, signal, options.timeoutMs ?? 30_000);
			try {
				const response = await platform.fetch(url, { ...init, signal: handle.signal });
				const text = await response.text();
				if (!response.ok) {
					return errorResult(
						`${config.provider} search failed: HTTP ${response.status} ${text.replace(/\s+/g, " ").slice(0, 200)}`,
					);
				}
				let body: unknown;
				try {
					body = JSON.parse(text);
				} catch {
					return errorResult(`${config.provider} search returned something other than JSON.`);
				}
				const found = parseSearchResponse(config.provider, body).slice(0, count);
				if (found.length === 0) return { content: [{ type: "text", text: `No results for "${query}".` }] };
				const lines = found.map(
					(hit, index) =>
						`${index + 1}. ${hit.title}\n   ${hit.url}${hit.snippet ? `\n   ${hit.snippet.replace(/\s+/g, " ").trim().slice(0, 300)}` : ""}`,
				);
				return { content: [{ type: "text", text: lines.join("\n\n") }] };
			} catch (error) {
				if (signal?.aborted) return errorResult("web_search aborted");
				return errorResult(
					`${config.provider} search failed: ${error instanceof Error ? error.message : String(error)}`,
				);
			} finally {
				handle.abort();
			}
		},
	};
}

/**
 * web_fetch always; web_search when a provider is configured. web_fetch is
 * medium risk (a URL can carry data out), web_search low (D20).
 */
export function createWebExtension(options: WebExtensionOptions = {}): Extension {
	return (api) => {
		api.registerTool(createWebFetchTool(options), { risk: "medium" });
		if (options.search) api.registerTool(createWebSearchTool(options.search, options), { risk: "low" });
	};
}

export default createWebExtension();
