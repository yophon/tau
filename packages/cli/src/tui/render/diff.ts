/**
 * Line diff for the edit tool's oldText/newText (ported from yo-agent
 * surface-cli render/diff.ts): LCS line diff, green additions, red deletions,
 * dimmed context with new-side line numbers, long unchanged runs folded.
 */
import { plainLine, type StyledLine, span } from "./spans.ts";

export interface DiffLine {
	kind: "add" | "del" | "ctx" | "meta";
	text: string;
	/** Line number on the new side (add/ctx). */
	newNo?: number;
}

/** Line-level LCS; very large inputs degrade to delete-all/add-all. */
export function diffStrings(oldText: string, newText: string): DiffLine[] {
	const a = oldText.split("\n");
	const b = newText.split("\n");
	if (a.length * b.length > 250_000) {
		return [
			...a.map((text): DiffLine => ({ kind: "del", text })),
			...b.map((text, i): DiffLine => ({ kind: "add", text, newNo: i + 1 })),
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
	const out: DiffLine[] = [];
	let i = 0;
	let j = 0;
	while (i < m && j < n) {
		if (a[i] === b[j]) {
			out.push({ kind: "ctx", text: a[i] ?? "", newNo: j + 1 });
			i++;
			j++;
		} else if (at(i + 1, j) >= at(i, j + 1)) {
			out.push({ kind: "del", text: a[i] ?? "" });
			i++;
		} else {
			out.push({ kind: "add", text: b[j] ?? "", newNo: j + 1 });
			j++;
		}
	}
	while (i < m) out.push({ kind: "del", text: a[i++] ?? "" });
	while (j < n) {
		out.push({ kind: "add", text: b[j] ?? "", newNo: j + 1 });
		j++;
	}
	return out;
}

export function diffStat(lines: DiffLine[]): { add: number; del: number } {
	let add = 0;
	let del = 0;
	for (const line of lines) {
		if (line.kind === "add") add++;
		else if (line.kind === "del") del++;
	}
	return { add, del };
}

/** Keep `keep` context lines around each change; fold longer unchanged runs. */
export function collapseContext(lines: DiffLine[], keep = 2): DiffLine[] {
	const out: DiffLine[] = [];
	let run: DiffLine[] = [];
	const flush = (isTail: boolean): void => {
		const isHead = out.length === 0;
		if (run.length <= keep * 2 || (isHead && run.length <= keep) || (isTail && run.length <= keep)) {
			out.push(...run);
		} else {
			const lead = isHead ? [] : run.slice(0, keep);
			const tail = isTail ? [] : run.slice(-keep);
			const skipped = run.length - lead.length - tail.length;
			out.push(...lead, { kind: "meta", text: `··· ${skipped} unchanged lines` }, ...tail);
		}
		run = [];
	};
	for (const line of lines) {
		if (line.kind === "ctx") {
			run.push(line);
		} else {
			flush(false);
			out.push(line);
		}
	}
	flush(true);
	return out;
}

/**
 * DiffLine → styled lines. Line numbers are off by default: the edit tool's
 * oldText/newText are snippets, so their line numbers are not the file's.
 */
export function toStyled(lines: DiffLine[], options: { numbers?: boolean } = {}): StyledLine[] {
	const numberWidth = String(Math.max(1, ...lines.map((line) => line.newNo ?? 0))).length;
	return lines.map((line): StyledLine => {
		if (line.kind === "meta") return plainLine(line.text, { dim: true, color: "cyan" });
		const mark = line.kind === "add" ? "+" : line.kind === "del" ? "-" : " ";
		const color = line.kind === "add" ? "green" : line.kind === "del" ? "red" : undefined;
		const body = span(`${mark} ${line.text}`, color ? { color } : { dim: true });
		if (!options.numbers) return [body];
		const number = line.newNo !== undefined ? String(line.newNo).padStart(numberWidth) : " ".repeat(numberWidth);
		return [span(`${number} `, { dim: true }), body];
	});
}

export function renderDiff(oldText: string, newText: string, keep = 2): StyledLine[] {
	return toStyled(collapseContext(diffStrings(oldText, newText), keep));
}

/** Words, runs of spaces and single symbols: the units a changed line is compared in. */
function words(text: string): string[] {
	return text.match(/\s+|[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]/gu) ?? [];
}

/**
 * pi's renderIntraLineDiff: a line changed into one other line shows the words that
 * changed in inverse (leading indentation is never highlighted).
 */
function intraLine(oldText: string, newText: string): { removed: StyledLine; added: StyledLine } {
	const a = words(oldText);
	const b = words(newText);
	if (a.length * b.length > 40_000) {
		return { removed: [span(oldText, { color: "red" })], added: [span(newText, { color: "green" })] };
	}
	const dp: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
	const at = (i: number, j: number): number => (dp[i] as number[])[j] as number;
	for (let i = a.length - 1; i >= 0; i--) {
		for (let j = b.length - 1; j >= 0; j--) {
			(dp[i] as number[])[j] = a[i] === b[j] ? at(i + 1, j + 1) + 1 : Math.max(at(i + 1, j), at(i, j + 1));
		}
	}
	const removed: StyledLine = [];
	const added: StyledLine = [];
	const push = (line: StyledLine, text: string, changed: boolean): void => {
		const color = line === removed ? "red" : "green";
		// Indentation before the first change stays plain.
		const highlight = changed && !(line.length === 0 && text.trim() === "");
		const last = line.at(-1);
		if (last && (last.inverse === true) === highlight) last.text += text;
		else line.push(span(text, highlight ? { color, inverse: true } : { color }));
	};
	let i = 0;
	let j = 0;
	while (i < a.length && j < b.length) {
		if (a[i] === b[j]) {
			push(removed, a[i] as string, false);
			push(added, b[j] as string, false);
			i++;
			j++;
		} else if (at(i + 1, j) >= at(i, j + 1)) {
			push(removed, a[i++] as string, true);
		} else {
			push(added, b[j++] as string, true);
		}
	}
	while (i < a.length) push(removed, a[i++] as string, true);
	while (j < b.length) push(added, b[j++] as string, true);
	return { removed, added };
}

/**
 * The edit tool's numbered diff (P38b, pi's renderDiff): `-12 old` red, `+12 new`
 * green, context dim, and a line changed into one other line has its changed words
 * in inverse.
 */
export function renderNumberedDiff(diff: string): StyledLine[] {
	// A carriage return would send the row back to column 1 (diffs saved before the kernel dropped them).
	const lines = diff.replace(/\r(?=\n|$)/g, "").split("\n");
	const rows = lines.map((line) => {
		const match = /^([+\- ])(\s*\d*) (.*)$/.exec(line);
		return match
			? { mark: match[1] as string, number: match[2] as string, text: (match[3] as string).replace(/\t/g, "   ") }
			: undefined;
	});
	const out: StyledLine[] = [];
	const gutter = (mark: string, number: string, color?: string): StyledLine => [
		span(`${mark}${number} `, color ? { color } : { dim: true }),
	];
	for (let i = 0; i < rows.length; i++) {
		const row = rows[i];
		if (!row) {
			out.push(plainLine(lines[i] ?? "", { dim: true }));
			continue;
		}
		if (row.mark === "-") {
			const removed: NonNullable<typeof row>[] = [];
			while (rows[i]?.mark === "-") removed.push(rows[i++] as NonNullable<typeof row>);
			const added: NonNullable<typeof row>[] = [];
			while (rows[i]?.mark === "+") added.push(rows[i++] as NonNullable<typeof row>);
			i--;
			if (removed.length === 1 && added.length === 1) {
				const old = removed[0] as NonNullable<typeof row>;
				const next = added[0] as NonNullable<typeof row>;
				const changed = intraLine(old.text, next.text);
				out.push([...gutter("-", old.number, "red"), ...changed.removed]);
				out.push([...gutter("+", next.number, "green"), ...changed.added]);
				continue;
			}
			for (const line of removed) out.push([...gutter("-", line.number, "red"), span(line.text, { color: "red" })]);
			for (const line of added) out.push([...gutter("+", line.number, "green"), span(line.text, { color: "green" })]);
			continue;
		}
		if (row.mark === "+") {
			out.push([...gutter("+", row.number, "green"), span(row.text, { color: "green" })]);
			continue;
		}
		out.push([...gutter(" ", row.number), span(row.text, { dim: true })]);
	}
	return out;
}
