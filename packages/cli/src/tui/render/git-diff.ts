/**
 * A unified git diff as transcript lines (P39b, /diff): file headers bold, hunk
 * headers cyan, additions green, deletions red, git's own metadata dimmed.
 */
import { plainLine, type StyledLine, span } from "./spans.ts";

export interface DiffSummary {
	files: number;
	added: number;
	removed: number;
}

/** Files, added and removed lines of a unified diff (binary files count as files only). */
export function summarizeDiff(text: string): DiffSummary {
	const summary: DiffSummary = { files: 0, added: 0, removed: 0 };
	for (const line of text.split("\n")) {
		if (line.startsWith("diff --git ")) summary.files++;
		else if (line.startsWith("+") && !line.startsWith("+++ ")) summary.added++;
		else if (line.startsWith("-") && !line.startsWith("--- ")) summary.removed++;
	}
	return summary;
}

/** The file a `diff --git a/x b/y` header names: the new side. */
function headerPath(line: string): string {
	const match = /^diff --git (?:"?a\/.*?"?) "?b\/(.*?)"?$/.exec(line);
	return match?.[1] ?? line.slice("diff --git ".length);
}

export function gitDiffLines(text: string): StyledLine[] {
	const lines = text.replace(/\r(?=\n|$)/g, "").split("\n");
	if (lines.at(-1) === "") lines.pop();
	const out: StyledLine[] = [];
	let inHunk = false;
	for (const line of lines) {
		if (line.startsWith("diff --git ")) {
			if (out.length > 0) out.push([]);
			out.push([span(headerPath(line), { bold: true })]);
			inHunk = false;
		} else if (line.startsWith("@@")) {
			const end = line.indexOf("@@", 2);
			const header = end < 0 ? line : line.slice(0, end + 2);
			const context = end < 0 ? "" : line.slice(end + 2);
			out.push(
				context === ""
					? [span(header, { color: "cyan" })]
					: [span(header, { color: "cyan" }), span(context, { dim: true })],
			);
			inHunk = true;
		} else if (!inHunk) {
			// index, ---/+++, new file mode, rename from/to, Binary files … differ.
			out.push(plainLine(line, { dim: true }));
		} else if (line.startsWith("+")) out.push(plainLine(line, { color: "green" }));
		else if (line.startsWith("-")) out.push(plainLine(line, { color: "red" }));
		else if (line.startsWith("\\")) out.push(plainLine(line, { dim: true }));
		else out.push(plainLine(line));
	}
	return out;
}
