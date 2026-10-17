/**
 * HTML → markdown for web_fetch, in pure ES: no DOM, no URL global (QuickJS and
 * mini-program hosts have neither). A tag scanner, not a parser: it keeps what
 * a model needs to read a documentation page or an article — headings,
 * paragraphs, links (made absolute), lists, code, quotes, tables, images — and
 * drops scripts, styles and page chrome.
 */

const NAMED_ENTITIES: Record<string, string> = {
	amp: "&",
	lt: "<",
	gt: ">",
	quot: '"',
	apos: "'",
	nbsp: " ",
	copy: "©",
	reg: "®",
	trade: "™",
	hellip: "…",
	mdash: "—",
	ndash: "–",
	lsquo: "‘",
	rsquo: "’",
	ldquo: "“",
	rdquo: "”",
	laquo: "«",
	raquo: "»",
	times: "×",
	divide: "÷",
	bull: "•",
	middot: "·",
	deg: "°",
	larr: "←",
	rarr: "→",
	uarr: "↑",
	darr: "↓",
	euro: "€",
	pound: "£",
	yen: "¥",
	sect: "§",
	para: "¶",
	shy: "",
	zwj: "",
	zwnj: "",
};

export function decodeEntities(text: string): string {
	return text.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z][a-zA-Z0-9]*);/g, (match, body: string) => {
		if (body.startsWith("#x") || body.startsWith("#X")) {
			const code = Number.parseInt(body.slice(2), 16);
			return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
		}
		if (body.startsWith("#")) {
			const code = Number.parseInt(body.slice(1), 10);
			return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
		}
		return NAMED_ENTITIES[body] ?? NAMED_ENTITIES[body.toLowerCase()] ?? match;
	});
}

/** Resolve `href` against `base` (RFC 3986 reference resolution, the common cases). */
export function resolveUrl(href: string, base: string | undefined): string {
	const ref = href.trim();
	if (ref === "" || base === undefined) return ref;
	if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(ref)) return ref;
	const match = /^([a-zA-Z][a-zA-Z0-9+.-]*:)(\/\/[^/?#]*)?([^?#]*)(\?[^#]*)?(#.*)?$/.exec(base);
	if (!match) return ref;
	const scheme = match[1] as string;
	const authority = match[2] ?? "";
	const basePath = match[3] ?? "";
	const baseQuery = match[4] ?? "";
	if (ref.startsWith("//")) return `${scheme}${ref}`;
	if (ref.startsWith("#")) return `${scheme}${authority}${basePath}${baseQuery}${ref}`;
	if (ref.startsWith("?")) return `${scheme}${authority}${basePath}${ref}`;
	const [pathPart, ...rest] = ref.split(/(?=[?#])/);
	const suffix = rest.join("");
	let path: string;
	if ((pathPart ?? "").startsWith("/")) path = pathPart ?? "/";
	else {
		const dir = basePath.includes("/") ? basePath.slice(0, basePath.lastIndexOf("/") + 1) : "/";
		path = `${dir}${pathPart ?? ""}`;
	}
	const segments: string[] = [];
	const parts = path.split("/");
	parts.forEach((segment, index) => {
		if (segment === "..") {
			if (segments.length > 1) segments.pop();
			if (index === parts.length - 1) segments.push("");
		} else if (segment === ".") {
			if (index === parts.length - 1) segments.push("");
		} else segments.push(segment);
	});
	let normalized = segments.join("/");
	if (!normalized.startsWith("/")) normalized = `/${normalized}`;
	return `${scheme}${authority}${normalized}${suffix}`;
}

/** Elements whose whole content is dropped. */
const DROP = [
	"title",
	"script",
	"style",
	"noscript",
	"svg",
	"template",
	"iframe",
	"canvas",
	"nav",
	"footer",
	"aside",
	"form",
	"button",
	"select",
	"dialog",
];
const VOID = new Set([
	"br",
	"hr",
	"img",
	"input",
	"meta",
	"link",
	"source",
	"wbr",
	"area",
	"base",
	"col",
	"embed",
	"track",
]);
const BLOCK = new Set([
	"p",
	"div",
	"section",
	"article",
	"main",
	"header",
	"figure",
	"figcaption",
	"details",
	"summary",
	"dl",
	"dt",
	"dd",
	"address",
	"center",
]);

function attribute(attrs: string, name: string): string | undefined {
	const match = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(attrs);
	if (!match) return undefined;
	return decodeEntities(match[1] ?? match[2] ?? match[3] ?? "");
}

/** Remove an element (and everything inside it) wherever it appears; tolerant of nesting. */
function dropElements(html: string, tags: readonly string[]): string {
	let out = html;
	for (const tag of tags) {
		const pattern = new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}\\s*>`, "gi");
		let previous: string;
		do {
			previous = out;
			out = out.replace(pattern, " ");
		} while (out !== previous);
		out = out.replace(new RegExp(`<${tag}\\b[^>]*\\/?>`, "gi"), " ");
	}
	return out;
}

interface ElementSpan {
	start: number;
	innerStart: number;
	innerEnd: number;
	end: number;
}

/** The element whose opening tag starts at `start`, matched to its closing tag by depth (unclosed = to the end). */
function elementAt(html: string, start: number): ElementSpan | undefined {
	const open = /^<([a-zA-Z][a-zA-Z0-9-]*)\b(?:[^>"']|"[^"]*"|'[^']*')*>/.exec(html.slice(start, start + 4096));
	if (!open) return undefined;
	const tag = (open[1] ?? "").toLowerCase();
	const innerStart = start + open[0].length;
	if (VOID.has(tag) || open[0].endsWith("/>")) return { start, innerStart, innerEnd: innerStart, end: innerStart };
	const pattern = new RegExp(`<(\\/?)${tag}\\b(?:[^>"']|"[^"]*"|'[^']*')*>`, "gi");
	pattern.lastIndex = innerStart;
	let depth = 1;
	for (let match = pattern.exec(html); match; match = pattern.exec(html)) {
		if (match[1] === "/") depth--;
		else if (!match[0].endsWith("/>")) depth++;
		if (depth === 0) return { start, innerStart, innerEnd: match.index, end: match.index + match[0].length };
	}
	return { start, innerStart, innerEnd: html.length, end: html.length };
}

/** Opening tags whose attributes match `test`, in document order. */
function openingTags(html: string, test: (tag: string, attrs: string) => boolean): number[] {
	const found: number[] = [];
	for (const match of html.matchAll(/<([a-zA-Z][a-zA-Z0-9-]*)\b((?:[^>"']|"[^"]*"|'[^']*')*)>/g)) {
		if (test((match[1] ?? "").toLowerCase(), match[2] ?? "")) found.push(match.index ?? 0);
	}
	return found;
}

/** id, class and role of an opening tag, lowercased, for the chrome and content heuristics. */
function markers(attrs: string): string {
	return [attribute(attrs, "id"), attribute(attrs, "class"), attribute(attrs, "role")]
		.filter((value): value is string => value !== undefined)
		.join(" ")
		.toLowerCase();
}

/** Page chrome by id/class/role: navigation, sidebars, menus, breadcrumbs, cookie banners. */
const CHROME =
	/(?:^|[\s_-])(?:nav|navbar|navigation|sidebar|side-bar|sidenav|menu|menubar|breadcrumbs?|toc|skip-link|cookie|cookies|banner|site-header|site-footer)(?:$|[\s_-])/;
/** Main content by id/class/role. */
const CONTENT =
	/(?:^|[\s_-])(?:main|content|main-content|page-content|apicontent|article|article-body|post|post-content|entry-content|markdown-body|prose|docs?-content|documentation)(?:$|[\s_-])/;

/** Remove page chrome found by id/class/role (balanced, so nested markup goes with it). */
function dropChrome(html: string): string {
	let out = html;
	let total = textLength(out);
	// Elements before `from` were kept: a "chrome" class on a wrapper holding most of
	// the page (class="layout with-sidebar") is a false positive, not navigation.
	let from = 0;
	for (let guard = 0; guard < 300; guard++) {
		const first = openingTags(
			out,
			(tag, attrs) => tag !== "body" && tag !== "html" && CHROME.test(markers(attrs)),
		).find((start) => start >= from);
		if (first === undefined) break;
		const span = elementAt(out, first);
		if (!span || span.end <= span.start) break;
		const length = textLength(out.slice(span.innerStart, span.innerEnd));
		if (length > total * 0.5) {
			from = span.innerStart;
			continue;
		}
		out = `${out.slice(0, span.start)} ${out.slice(span.end)}`;
		total -= length;
		from = span.start;
	}
	return out;
}

function textLength(html: string): number {
	return html
		.replace(/<[^>]*>/g, "")
		.replace(/\s+/g, " ")
		.trim().length;
}

/**
 * The part of the page worth reading. Inside <main> (or role=main) only an
 * <article> narrows it further; without <main>, an element whose id/class says
 * content (markdown-body, apicontent, post-content…) may. Either must hold at
 * least 30% of the text; a class used more than once marks repeated sections,
 * not the content wrapper, and is skipped.
 */
function pickContent(html: string): string {
	const inner = (start: number): string => {
		const span = elementAt(html, start);
		return span ? html.slice(span.innerStart, span.innerEnd) : "";
	};
	const [main] = openingTags(html, (tag, attrs) => tag === "main" || /\brole\s*=\s*["']?main\b/i.test(attrs));
	const bodyTag = openingTags(html, (tag) => tag === "body")[0];
	const container = main !== undefined ? inner(main) : bodyTag !== undefined ? inner(bodyTag) : html;
	const counts = new Map<string, number>();
	for (const match of container.matchAll(/<[a-zA-Z][a-zA-Z0-9-]*\b((?:[^>"']|"[^"]*"|'[^']*')*)>/g)) {
		const key = markers(match[1] ?? "");
		if (key !== "") counts.set(key, (counts.get(key) ?? 0) + 1);
	}
	const isCandidate = (tag: string, attrs: string): boolean => {
		if (tag === "article") return true;
		if (main !== undefined || tag === "main") return false;
		const key = markers(attrs);
		return CONTENT.test(key) && (counts.get(key) ?? 0) === 1;
	};
	const total = textLength(container);
	let best: string | undefined;
	let bestLength = 0;
	for (const start of openingTags(container, isCandidate)) {
		const span = elementAt(container, start);
		if (!span) continue;
		const candidate = container.slice(span.innerStart, span.innerEnd);
		const length = textLength(candidate);
		if (length > bestLength) {
			best = candidate;
			bestLength = length;
		}
	}
	return best !== undefined && bestLength >= total * 0.3 ? best : container;
}

interface ListState {
	ordered: boolean;
	index: number;
}

interface TableState {
	rows: string[][];
	row: string[] | undefined;
}

export interface HtmlToMarkdownResult {
	title?: string;
	markdown: string;
}

export function htmlToMarkdown(html: string, baseUrl?: string): HtmlToMarkdownResult {
	const titleMatch = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(html);
	const title = titleMatch
		? decodeEntities(titleMatch[1] ?? "")
				.replace(/\s+/g, " ")
				.trim() || undefined
		: undefined;
	const baseTag = /<base\b[^>]*>/i.exec(html);
	const base = (baseTag ? attribute(baseTag[0], "href") : undefined) ?? baseUrl;

	let body = html
		.replace(/<!--[\s\S]*?-->/g, " ")
		.replace(/<![^>]*>|<\?[^>]*>/g, " ")
		.replace(/<head\b[\s\S]*?<\/head\s*>/gi, " ");
	body = dropElements(body, DROP);
	body = pickContent(dropChrome(body));

	// Output buffers: blockquotes and table cells collect into their own buffer.
	const buffers: string[] = [""];
	const emit = (text: string): void => {
		buffers[buffers.length - 1] += text;
	};
	const blockBreak = (): void => {
		const current = buffers[buffers.length - 1] ?? "";
		if (current !== "" && !current.endsWith("\n\n")) emit(current.endsWith("\n") ? "\n" : "\n\n");
	};
	const lists: ListState[] = [];
	const links: (string | undefined)[] = [];
	const tables: TableState[] = [];
	let pre = 0;
	let inlineCode = 0;

	const tokens = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g;
	let last = 0;
	const text = (raw: string): void => {
		if (raw === "") return;
		const decoded = decodeEntities(raw);
		if (pre > 0) {
			emit(decoded);
			return;
		}
		const collapsed = decoded.replace(/\s+/g, " ");
		const current = buffers[buffers.length - 1] ?? "";
		// No leading space at the start of a line.
		emit(current === "" || current.endsWith("\n") || current.endsWith(" ") ? collapsed.replace(/^ /, "") : collapsed);
	};

	for (const match of body.matchAll(tokens)) {
		text(body.slice(last, match.index));
		last = (match.index ?? 0) + match[0].length;
		const closing = match[1] === "/";
		const tag = (match[2] ?? "").toLowerCase();
		const attrs = match[3] ?? "";
		if (/^h[1-6]$/.test(tag)) {
			blockBreak();
			if (!closing) emit(`${"#".repeat(Number(tag[1]))} `);
			else emit("\n\n");
		} else if (tag === "br") {
			emit(pre > 0 ? "\n" : "  \n");
		} else if (tag === "hr") {
			blockBreak();
			emit("---\n\n");
		} else if (tag === "pre") {
			if (!closing) {
				blockBreak();
				const language = /language-([\w+-]+)/.exec(attrs)?.[1] ?? "";
				emit(`\`\`\`${language}\n`);
				pre++;
			} else if (pre > 0) {
				pre--;
				const current = buffers[buffers.length - 1] ?? "";
				emit(current.endsWith("\n") ? "```\n\n" : "\n```\n\n");
			}
		} else if (tag === "code") {
			if (pre > 0) {
				// A language class on <pre><code> is common; the fence already opened.
				if (!closing) {
					const language = /language-([\w+-]+)/.exec(attrs)?.[1];
					const current = buffers[buffers.length - 1] ?? "";
					if (language && current.endsWith("```\n")) {
						buffers[buffers.length - 1] = `${current.slice(0, -1)}${language}\n`;
					}
				}
			} else if (!closing) {
				inlineCode++;
				emit("`");
			} else if (inlineCode > 0) {
				inlineCode--;
				emit("`");
			}
		} else if (tag === "strong" || tag === "b") {
			emit("**");
		} else if (tag === "em" || tag === "i") {
			emit("_");
		} else if (tag === "a") {
			if (!closing) {
				const href = attribute(attrs, "href");
				const usable = href && !/^\s*(javascript|data):/i.test(href) ? resolveUrl(href, base) : undefined;
				links.push(usable);
				if (usable) emit("[");
			} else {
				const href = links.pop();
				if (href) emit(`](${href})`);
			}
		} else if (tag === "img") {
			const src = attribute(attrs, "src");
			if (src && !/^\s*data:/i.test(src)) emit(`![${attribute(attrs, "alt") ?? ""}](${resolveUrl(src, base)})`);
		} else if (tag === "ul" || tag === "ol") {
			if (!closing) {
				if (lists.length === 0) blockBreak();
				else emit("\n");
				const start = Number.parseInt(attribute(attrs, "start") ?? "1", 10);
				lists.push({ ordered: tag === "ol", index: Number.isFinite(start) ? start : 1 });
			} else {
				lists.pop();
				if (lists.length === 0) blockBreak();
			}
		} else if (tag === "li") {
			if (!closing) {
				const list = lists[lists.length - 1];
				const current = buffers[buffers.length - 1] ?? "";
				if (current !== "" && !current.endsWith("\n")) emit("\n");
				const indent = "  ".repeat(Math.max(0, lists.length - 1));
				emit(`${indent}${list?.ordered ? `${list.index++}.` : "-"} `);
			}
		} else if (tag === "blockquote") {
			if (!closing) {
				blockBreak();
				buffers.push("");
			} else if (buffers.length > 1) {
				const inner = (buffers.pop() ?? "").trim();
				emit(
					`${inner
						.split("\n")
						.map((line) => (line === "" ? ">" : `> ${line}`))
						.join("\n")}\n\n`,
				);
			}
		} else if (tag === "table") {
			if (!closing) {
				blockBreak();
				tables.push({ rows: [], row: undefined });
			} else {
				const table = tables.pop();
				if (table) emit(renderTable(table.rows));
			}
		} else if (tag === "tr") {
			const table = tables[tables.length - 1];
			if (table && !closing) {
				table.row = [];
				table.rows.push(table.row);
			}
		} else if (tag === "td" || tag === "th") {
			const table = tables[tables.length - 1];
			if (table) {
				if (!closing) buffers.push("");
				else if (buffers.length > 1) {
					const cell = (buffers.pop() ?? "").replace(/\s+/g, " ").replace(/\|/g, "\\|").trim();
					if (!table.row) {
						table.row = [];
						table.rows.push(table.row);
					}
					table.row.push(cell);
				}
			}
		} else if (BLOCK.has(tag)) {
			blockBreak();
		} else if (VOID.has(tag)) {
			// Nothing to emit.
		}
	}
	text(body.slice(last));
	while (buffers.length > 1) {
		const inner = buffers.pop() ?? "";
		emit(inner);
	}
	const markdown = (buffers[0] ?? "")
		.split("\n")
		.map((line) => line.replace(/[ \t]+$/, (spaces) => (spaces === "  " ? spaces : "")))
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
	return { ...(title !== undefined ? { title } : {}), markdown };
}

function renderTable(rows: string[][]): string {
	const filled = rows.filter((row) => row.length > 0);
	if (filled.length === 0) return "";
	const width = Math.max(...filled.map((row) => row.length));
	const pad = (row: string[]): string[] => [...row, ...Array.from({ length: width - row.length }, () => "")];
	const [head, ...rest] = filled.map(pad);
	const line = (row: string[]): string => `| ${row.join(" | ")} |`;
	return `${[line(head as string[]), line(Array.from({ length: width }, () => "---")), ...rest.map(line)].join("\n")}\n\n`;
}
