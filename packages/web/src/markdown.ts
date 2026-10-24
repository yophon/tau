// A small Markdown reader for the phone (P59): enough for what agents write — paragraphs, headings,
// fenced code, lists, quotes, inline code, bold, italic, links. It makes plain data (blocks and
// spans) that the page draws as elements, never HTML: agent output is untrusted text.

export type Span =
	| { kind: "text"; text: string }
	| { kind: "code"; text: string }
	| { kind: "strong"; children: Span[] }
	| { kind: "em"; children: Span[] }
	| { kind: "link"; href: string; children: Span[] };

export type Block =
	| { kind: "paragraph"; spans: Span[] }
	| { kind: "heading"; level: number; spans: Span[] }
	| { kind: "code"; language: string; text: string }
	| { kind: "list"; ordered: boolean; items: Span[][] }
	| { kind: "quote"; blocks: Block[] }
	| { kind: "rule" };

const FENCE = /^\s{0,3}(```+|~~~+)\s*([\w+-]*)/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const BULLET = /^\s{0,3}[-*+]\s+(.*)$/;
const ORDERED = /^\s{0,3}\d{1,9}[.)]\s+(.*)$/;
const RULE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;

export function parseMarkdown(text: string): Block[] {
	const lines = text.replace(/\r\n?/g, "\n").split("\n");
	const blocks: Block[] = [];
	let i = 0;
	while (i < lines.length) {
		const line = lines[i] ?? "";
		const fence = FENCE.exec(line);
		if (fence) {
			const marker = fence[1] ?? "```";
			const body: string[] = [];
			i++;
			while (i < lines.length && !(lines[i] ?? "").trimStart().startsWith(marker)) body.push(lines[i++] ?? "");
			i++;
			blocks.push({ kind: "code", language: fence[2] ?? "", text: body.join("\n") });
			continue;
		}
		if (line.trim() === "") {
			i++;
			continue;
		}
		const heading = HEADING.exec(line);
		if (heading) {
			blocks.push({ kind: "heading", level: heading[1]?.length ?? 1, spans: parseInline(heading[2] ?? "") });
			i++;
			continue;
		}
		if (RULE.test(line)) {
			blocks.push({ kind: "rule" });
			i++;
			continue;
		}
		if (/^\s{0,3}>/.test(line)) {
			const quoted: string[] = [];
			while (i < lines.length && /^\s{0,3}>/.test(lines[i] ?? ""))
				quoted.push((lines[i++] ?? "").replace(/^\s{0,3}>\s?/, ""));
			blocks.push({ kind: "quote", blocks: parseMarkdown(quoted.join("\n")) });
			continue;
		}
		const ordered = ORDERED.test(line);
		if (ordered || BULLET.test(line)) {
			const pattern = ordered ? ORDERED : BULLET;
			const items: Span[][] = [];
			while (i < lines.length && pattern.test(lines[i] ?? "")) {
				let item = pattern.exec(lines[i++] ?? "")?.[1] ?? "";
				// Continuation lines (indented) belong to the item.
				while (i < lines.length && /^\s{2,}\S/.test(lines[i] ?? "") && !pattern.test(lines[i] ?? "")) {
					item += ` ${(lines[i++] ?? "").trim()}`;
				}
				items.push(parseInline(item));
			}
			blocks.push({ kind: "list", ordered, items });
			continue;
		}
		const paragraph: string[] = [];
		while (i < lines.length) {
			const next = lines[i] ?? "";
			if (next.trim() === "" || FENCE.test(next) || HEADING.test(next) || BULLET.test(next) || ORDERED.test(next))
				break;
			if (/^\s{0,3}>/.test(next) || RULE.test(next)) break;
			paragraph.push(next.trim());
			i++;
		}
		blocks.push({ kind: "paragraph", spans: parseInline(paragraph.join("\n")) });
	}
	return blocks;
}

/**
 * Inline code first (nothing inside it is markup), then links, bold, italic. Only asterisks mark
 * emphasis: underscores are left alone (snake_case names in agent output).
 */
export function parseInline(text: string): Span[] {
	const spans: Span[] = [];
	let rest = text;
	const pattern = /`([^`]+)`|\[([^\]]+)\]\(([^)\s]+)\)|\*\*([^*]+)\*\*|\*([^*\s][^*]*)\*/;
	while (rest.length > 0) {
		const match = pattern.exec(rest);
		if (!match) {
			spans.push({ kind: "text", text: rest });
			break;
		}
		if (match.index > 0) spans.push({ kind: "text", text: rest.slice(0, match.index) });
		const [whole, code, label, href, strong, em] = match;
		if (code !== undefined) spans.push({ kind: "code", text: code });
		else if (label !== undefined && href !== undefined) {
			// Only web and mail links open; anything else stays text.
			if (/^(https?:|mailto:)/i.test(href)) spans.push({ kind: "link", href, children: parseInline(label) });
			else spans.push({ kind: "text", text: whole });
		} else if (strong !== undefined) spans.push({ kind: "strong", children: parseInline(strong) });
		else spans.push({ kind: "em", children: parseInline(em ?? "") });
		rest = rest.slice(match.index + whole.length);
	}
	return spans;
}
