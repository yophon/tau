/**
 * The edit tool's display diff (P38b; pi core/tools/edit-diff.ts generateDiffString):
 * one line per change, `+`/`-`/` ` then the line number in the file, `...` where
 * unchanged lines are skipped, and the first changed line of the new file. pi diffs
 * the whole file with the `diff` package; the kernel has no dependencies, so it diffs
 * only the lines the edits touch (everything else is unchanged by construction) with
 * a small line LCS, which yields the same output for an edit call.
 */

/** A replacement at a known offset of the original content. */
export interface LocatedEdit {
	at: number;
	oldText: string;
	newText: string;
}

interface Part {
	kind: "same" | "del" | "add";
	lines: string[];
}

/** Line LCS of two small blocks; past the size limit, delete-all then add-all. */
function diffBlock(a: string[], b: string[]): Part[] {
	if (a.length * b.length > 250_000) {
		return [
			{ kind: "del", lines: a },
			{ kind: "add", lines: b },
		];
	}
	const m = a.length;
	const n = b.length;
	const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
	const at = (i: number, j: number): number => (dp[i] as number[])[j] as number;
	for (let i = m - 1; i >= 0; i--) {
		for (let j = n - 1; j >= 0; j--) {
			(dp[i] as number[])[j] = a[i] === b[j] ? at(i + 1, j + 1) + 1 : Math.max(at(i + 1, j), at(i, j + 1));
		}
	}
	const parts: Part[] = [];
	const push = (kind: Part["kind"], line: string): void => {
		const last = parts.at(-1);
		if (last?.kind === kind) last.lines.push(line);
		else parts.push({ kind, lines: [line] });
	};
	let i = 0;
	let j = 0;
	while (i < m && j < n) {
		if (a[i] === b[j]) {
			push("same", a[i] as string);
			i++;
			j++;
		} else if (at(i + 1, j) >= at(i, j + 1)) {
			push("del", a[i++] as string);
		} else {
			push("add", b[j++] as string);
		}
	}
	while (i < m) push("del", a[i++] as string);
	while (j < n) push("add", b[j++] as string);
	return parts;
}

function lineOf(content: string, offset: number): number {
	let line = 0;
	for (let i = content.indexOf("\n"); i !== -1 && i < offset; i = content.indexOf("\n", i + 1)) line++;
	return line;
}

/** The parts of the whole-file diff: unchanged runs between blocks of the lines each edit touches. */
function fileParts(content: string, edits: readonly LocatedEdit[]): Part[] {
	const lines = content.split("\n");
	const ordered = [...edits].sort((a, b) => a.at - b.at);
	// Group edits that touch the same lines into one block.
	const blocks: Array<{ start: number; end: number; edits: LocatedEdit[] }> = [];
	for (const edit of ordered) {
		const start = lineOf(content, edit.at);
		const end = lineOf(content, edit.at + edit.oldText.length);
		const last = blocks.at(-1);
		if (last && start <= last.end) {
			last.end = Math.max(last.end, end);
			last.edits.push(edit);
		} else {
			blocks.push({ start, end, edits: [edit] });
		}
	}
	const parts: Part[] = [];
	const append = (part: Part): void => {
		if (part.lines.length === 0) return;
		const last = parts.at(-1);
		if (last?.kind === part.kind) last.lines.push(...part.lines);
		else parts.push({ kind: part.kind, lines: [...part.lines] });
	};
	let next = 0;
	for (const block of blocks) {
		append({ kind: "same", lines: lines.slice(next, block.start) });
		const before = lines.slice(block.start, block.end + 1);
		// The block's text with its edits applied, back to front so offsets hold.
		const blockStart = block.start === 0 ? 0 : nthLineStart(content, block.start);
		let after = before.join("\n");
		for (const edit of [...block.edits].reverse()) {
			const from = edit.at - blockStart;
			after = after.slice(0, from) + edit.newText + after.slice(from + edit.oldText.length);
		}
		for (const part of diffBlock(before, after.split("\n"))) append(part);
		next = block.end + 1;
	}
	append({ kind: "same", lines: lines.slice(next) });
	// The empty "line" after a final newline is not a line (pi drops each part's trailing "").
	const last = parts.at(-1);
	if (content.endsWith("\n") && last?.kind === "same" && last.lines.at(-1) === "") last.lines.pop();
	return parts.filter((part) => part.lines.length > 0);
}

function nthLineStart(content: string, line: number): number {
	let offset = 0;
	for (let i = 0; i < line; i++) offset = content.indexOf("\n", offset) + 1;
	return offset;
}

/** pi's generateDiffString for an edit call: numbered changes with up to `contextLines` around them. */
export function editDiff(
	content: string,
	edits: readonly LocatedEdit[],
	contextLines = 4,
): { diff: string; firstChangedLine: number | undefined } {
	const parts = fileParts(content, edits);
	const oldCount = content.split("\n").length;
	const newCount = parts.reduce((count, part) => count + (part.kind === "del" ? 0 : part.lines.length), 0);
	const width = String(Math.max(oldCount, newCount)).length;
	const number = (n: number): string => String(n).padStart(width, " ");
	const skipped = ` ${"".padStart(width, " ")} ...`;
	const output: string[] = [];
	let oldLine = 1;
	let newLine = 1;
	let lastWasChange = false;
	let firstChangedLine: number | undefined;
	parts.forEach((part, index) => {
		if (part.kind !== "same") {
			firstChangedLine ??= newLine;
			for (const line of part.lines) {
				if (part.kind === "add") output.push(`+${number(newLine++)} ${line}`);
				else output.push(`-${number(oldLine++)} ${line}`);
			}
			lastWasChange = true;
			return;
		}
		const raw = part.lines;
		const nextIsChange = index < parts.length - 1;
		const context = (shown: string[]): void => {
			for (const line of shown) {
				output.push(` ${number(oldLine)} ${line}`);
				oldLine++;
				newLine++;
			}
		};
		const skip = (count: number): void => {
			oldLine += count;
			newLine += count;
		};
		if (lastWasChange && nextIsChange) {
			if (raw.length <= contextLines * 2) {
				context(raw);
			} else {
				context(raw.slice(0, contextLines));
				output.push(skipped);
				skip(raw.length - contextLines * 2);
				context(raw.slice(raw.length - contextLines));
			}
		} else if (lastWasChange) {
			context(raw.slice(0, contextLines));
			if (raw.length > contextLines) output.push(skipped);
			skip(Math.max(0, raw.length - contextLines));
		} else if (nextIsChange) {
			const shown = raw.slice(Math.max(0, raw.length - contextLines));
			if (raw.length > shown.length) output.push(skipped);
			skip(raw.length - shown.length);
			context(shown);
		} else {
			skip(raw.length);
		}
		lastWasChange = false;
	});
	return { diff: output.join("\n"), firstChangedLine };
}
