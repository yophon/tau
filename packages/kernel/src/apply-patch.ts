// apply_patch (P55a): Codex's file-oriented patch format, ported from codex-rs/apply-patch
// (parser.rs, streaming_parser.rs, seek_sequence.rs, file_update.rs, text_file.rs, lib.rs at
// openai/codex ca9d103f, Apache-2.0). Lenient parsing (whitespace around markers, a heredoc
// wrapper), chunk location with decreasing strictness, line endings kept per line, files
// applied in order with earlier changes left in place when a later one fails (Codex
// scenario 015). Deviation: the failure result also names the files already changed.
import type { FileSystem } from "./capabilities.ts";
import { editDiff, type LocatedEdit } from "./edit-diff.ts";

const BEGIN_PATCH = "*** Begin Patch";
const END_PATCH = "*** End Patch";
const ADD_FILE = "*** Add File: ";
const DELETE_FILE = "*** Delete File: ";
const UPDATE_FILE = "*** Update File: ";
const MOVE_TO = "*** Move to: ";
const END_OF_FILE = "*** End of File";
const CHANGE_CONTEXT = "@@ ";
const EMPTY_CHANGE_CONTEXT = "@@";

export interface PatchChunk {
	/** A line (usually a class or function definition) the chunk comes after. */
	changeContext?: string;
	oldLines: string[];
	newLines: string[];
	/** Index pairs of lines parsed as context, so they keep their own endings. */
	contextLineIndices: Array<[number, number]>;
	/** `oldLines` must be at the end of the file. */
	isEndOfFile: boolean;
}

export type PatchHunk =
	| { kind: "add"; path: string; contents: string }
	| { kind: "delete"; path: string }
	| { kind: "update"; path: string; movePath?: string; chunks: PatchChunk[] };

/** A patch that does not parse; the message is Codex's. */
export class PatchParseError extends Error {}

const emptyChunk = (changeContext?: string): PatchChunk => ({
	...(changeContext !== undefined ? { changeContext } : {}),
	oldLines: [],
	newLines: [],
	contextLineIndices: [],
	isEndOfFile: false,
});

const invalidPatch = (message: string): PatchParseError => new PatchParseError(`Invalid patch: ${message}`);
const invalidHunk = (message: string, line: number): PatchParseError =>
	new PatchParseError(`Invalid patch hunk on line ${line}: ${message}`);
const notAHeader = (trimmed: string, line: number): PatchParseError =>
	invalidHunk(
		`'${trimmed}' is not a valid hunk header. Valid hunk headers: '*** Add File: {path}', '*** Delete File: {path}', '*** Update File: {path}'`,
		line,
	);
const unexpectedUpdateLine = (line: string, number: number): PatchParseError =>
	invalidHunk(
		`Unexpected line found in update hunk: '${line}'. Every line should start with ' ' (context line), '+' (added line), or '-' (removed line)`,
		number,
	);

/** Codex's lenient boundaries: the patch trimmed, optionally wrapped in a `<<'EOF'` heredoc. */
function patchLines(patch: string): string[] {
	const lines = patch.trim().split(/\r?\n/);
	const bounded = (candidate: string[]): boolean =>
		candidate[0]?.trim() === BEGIN_PATCH && candidate.at(-1)?.trim() === END_PATCH;
	if (bounded(lines)) return lines;
	const first = lines[0];
	if (
		lines.length >= 4 &&
		(first === "<<EOF" || first === "<<'EOF'" || first === '<<"EOF"') &&
		lines.at(-1)?.endsWith("EOF") &&
		bounded(lines.slice(1, -1))
	) {
		return lines.slice(1, -1);
	}
	if (first?.trim() !== BEGIN_PATCH) throw invalidPatch("The first line of the patch must be '*** Begin Patch'");
	throw invalidPatch("The last line of the patch must be '*** End Patch'");
}

/** Parse a patch into hunks (Codex's StreamingPatchParser, run over the whole text). */
export function parsePatch(patch: string): PatchHunk[] {
	const lines = patchLines(patch);
	const hunks: PatchHunk[] = [];
	// Object-held: the closures below change it, which control-flow narrowing does not see.
	const state: { mode: "started" | "add" | "delete" | "update" | "ended" | "none" } = { mode: "none" };
	let hunkLine = 0;

	const lastUpdate = (): Extract<PatchHunk, { kind: "update" }> | undefined => {
		const last = hunks.at(-1);
		return last?.kind === "update" ? last : undefined;
	};
	const ensureUpdateNotEmpty = (line: string, number: number): void => {
		const update = lastUpdate();
		if (!update || state.mode !== "update") return;
		if (update.chunks.length === 0) {
			throw invalidHunk(`Update file hunk for path '${update.path}' is empty`, hunkLine);
		}
		const last = update.chunks.at(-1) as PatchChunk;
		if (last.oldLines.length === 0 && last.newLines.length === 0) {
			if (line === END_PATCH) throw invalidHunk("Update hunk does not contain any lines", number);
			throw unexpectedUpdateLine(line, number);
		}
	};
	/** Hunk headers and the end marker, valid after any hunk. */
	const header = (trimmed: string, number: number): boolean => {
		if (trimmed === END_PATCH) {
			ensureUpdateNotEmpty(trimmed, number);
			state.mode = "ended";
			return true;
		}
		if (trimmed.startsWith(ADD_FILE)) {
			ensureUpdateNotEmpty(trimmed, number);
			hunks.push({ kind: "add", path: trimmed.slice(ADD_FILE.length), contents: "" });
			state.mode = "add";
			return true;
		}
		if (trimmed.startsWith(DELETE_FILE)) {
			ensureUpdateNotEmpty(trimmed, number);
			hunks.push({ kind: "delete", path: trimmed.slice(DELETE_FILE.length) });
			state.mode = "delete";
			return true;
		}
		if (trimmed.startsWith(UPDATE_FILE)) {
			ensureUpdateNotEmpty(trimmed, number);
			hunks.push({ kind: "update", path: trimmed.slice(UPDATE_FILE.length), chunks: [] });
			state.mode = "update";
			hunkLine = number;
			return true;
		}
		return false;
	};

	lines.forEach((line, index) => {
		const number = index + 1;
		const trimmed = line.trim();
		// The last line is matched trimmed even inside an update hunk (Codex finish()).
		if (index === lines.length - 1 && trimmed === END_PATCH && state.mode !== "none") {
			ensureUpdateNotEmpty(trimmed, number);
			state.mode = "ended";
			return;
		}
		switch (state.mode) {
			case "none":
				if (trimmed !== BEGIN_PATCH) throw invalidPatch("The first line of the patch must be '*** Begin Patch'");
				state.mode = "started";
				return;
			case "started":
			case "delete":
				if (!header(trimmed, number)) throw notAHeader(trimmed, number);
				return;
			case "add": {
				if (header(trimmed, number)) return;
				const added = hunks.at(-1);
				if (line.startsWith("+") && added?.kind === "add") {
					added.contents += `${line.slice(1)}\n`;
					return;
				}
				throw notAHeader(trimmed, number);
			}
			case "ended":
				if (trimmed !== "") throw invalidPatch("The last line of the patch must be '*** End Patch'");
				return;
			case "update":
				updateLine(line, number);
				return;
		}
	});
	if (state.mode !== "ended") throw invalidPatch("The last line of the patch must be '*** End Patch'");
	return hunks;

	function updateLine(line: string, number: number): void {
		const updateText = line.trimEnd();
		if (header(updateText, number)) return;
		const update = lastUpdate() as Extract<PatchHunk, { kind: "update" }>;
		const chunks = update.chunks;
		const last = chunks.at(-1);
		const lastEmpty = last !== undefined && last.oldLines.length === 0 && last.newLines.length === 0;
		const isContext = updateText === EMPTY_CHANGE_CONTEXT || updateText.startsWith(CHANGE_CONTEXT);
		if (last?.isEndOfFile) {
			if (updateText === "") return;
			if (!isContext) {
				throw invalidHunk(`Expected update hunk to start with a @@ context marker, got: '${line}'`, number);
			}
		}
		if (chunks.length === 0 && update.movePath === undefined && updateText.startsWith(MOVE_TO)) {
			update.movePath = updateText.slice(MOVE_TO.length);
			return;
		}
		if (isContext && lastEmpty) throw unexpectedUpdateLine(line, number);
		if (updateText === EMPTY_CHANGE_CONTEXT) {
			chunks.push(emptyChunk());
			return;
		}
		if (updateText.startsWith(CHANGE_CONTEXT)) {
			chunks.push(emptyChunk(updateText.slice(CHANGE_CONTEXT.length)));
			return;
		}
		if (updateText === END_OF_FILE) {
			if (lastEmpty) throw invalidHunk("Update hunk does not contain any lines", number);
			if (last) last.isEndOfFile = true;
			return;
		}
		const chunk = (): PatchChunk => {
			if (chunks.length === 0) chunks.push(emptyChunk());
			return chunks.at(-1) as PatchChunk;
		};
		const pushContext = (text: string): void => {
			const target = chunk();
			target.contextLineIndices.push([target.oldLines.length, target.newLines.length]);
			target.oldLines.push(text);
			target.newLines.push(text);
		};
		if (line === "" || line.startsWith(" ")) {
			pushContext(line.slice(1));
			return;
		}
		if (line.startsWith("+")) {
			chunk().newLines.push(line.slice(1));
			return;
		}
		if (line.startsWith("-")) {
			chunk().oldLines.push(line.slice(1));
			return;
		}
		if (last && !lastEmpty) {
			throw invalidHunk(`Expected update hunk to start with a @@ context marker, got: '${line}'`, number);
		}
		throw unexpectedUpdateLine(line, number);
	}
}

/** The paths a patch touches (move targets too), for permission checks; none when it does not parse. */
export function patchTargets(patch: unknown): string[] {
	if (typeof patch !== "string") return [];
	try {
		return parsePatch(patch).flatMap((hunk) =>
			hunk.kind === "update" && hunk.movePath !== undefined ? [hunk.path, hunk.movePath] : [hunk.path],
		);
	} catch {
		return [];
	}
}

// --- Locating chunks (seek_sequence.rs) ---------------------------------------------------

/** Typographic punctuation and spaces read as their ASCII forms (Codex's last matching pass). */
function normalise(text: string): string {
	return text
		.trim()
		.replace(/[‐-―−]/g, "-")
		.replace(/[‘-‛]/g, "'")
		.replace(/[“-‟]/g, '"')
		.replace(/[  -   　]/g, " ");
}

/**
 * Where `pattern` starts in `lines`, at or after `start`: exact, then ignoring trailing
 * whitespace, then ignoring both ends, then with punctuation normalised. With `eof`, the end
 * of the file is tried first.
 */
export function seekSequence(
	lines: readonly string[],
	pattern: readonly string[],
	start: number,
	eof: boolean,
): number | undefined {
	if (pattern.length === 0) return start;
	if (pattern.length > lines.length) return undefined;
	const searchStart = eof ? Math.max(lines.length - pattern.length, start) : start;
	const passes: Array<(line: string) => string> = [
		(line) => line,
		(line) => line.trimEnd(),
		(line) => line.trim(),
		normalise,
	];
	for (const pass of passes) {
		for (let i = searchStart; i <= lines.length - pattern.length; i++) {
			if (pattern.every((expected, offset) => pass(lines[i + offset] as string) === pass(expected))) return i;
		}
	}
	return undefined;
}

// --- Line endings (text_file.rs) -----------------------------------------------------------

interface SourceLine {
	text: string;
	ending: "\n" | "\r\n" | "\r" | undefined;
}

/** A file split into lines that keep their own endings; inserted lines use the first one seen. */
class SourceFile {
	lines: SourceLine[] = [];
	preferred: "\n" | "\r\n" | "\r" = "\n";

	constructor(contents: string) {
		let preferred: SourceLine["ending"];
		let lineStart = 0;
		for (let i = 0; i < contents.length; i++) {
			const char = contents[i];
			if (char !== "\r" && char !== "\n") continue;
			const ending = char === "\r" && contents[i + 1] === "\n" ? "\r\n" : char;
			preferred ??= ending;
			this.lines.push({ text: contents.slice(lineStart, i), ending });
			if (ending === "\r\n") i++;
			lineStart = i + 1;
		}
		if (lineStart < contents.length) this.lines.push({ text: contents.slice(lineStart), ending: undefined });
		this.preferred = preferred ?? "\n";
	}

	texts(): string[] {
		return this.lines.map((line) => line.text);
	}

	/** Apply source-ordered replacements; every line ends with a newline afterwards (Codex). */
	apply(replacements: readonly Replacement[]): void {
		const out: SourceLine[] = [];
		let index = 0;
		for (const [start, oldLength, newLines] of replacements) {
			out.push(...this.lines.slice(index, start));
			out.push(...newLines.map((text) => ({ text, ending: this.preferred })));
			index = start + oldLength;
		}
		out.push(...this.lines.slice(index));
		this.lines = out.map((line) => ({ text: line.text, ending: line.ending ?? this.preferred }));
	}

	toString(): string {
		return this.lines.map((line) => line.text + (line.ending ?? "")).join("");
	}
}

type Replacement = [start: number, oldLength: number, newLines: string[]];

/** Where each chunk goes (file_update.rs compute_replacements). */
function computeReplacements(lines: readonly string[], path: string, chunks: readonly PatchChunk[]): Replacement[] {
	const replacements: Replacement[] = [];
	let lineIndex = 0;
	for (const chunk of chunks) {
		if (chunk.changeContext !== undefined) {
			const at = seekSequence(lines, [chunk.changeContext], lineIndex, false);
			if (at === undefined) throw new Error(`Failed to find context '${chunk.changeContext}' in ${path}`);
			lineIndex = at + 1;
		}
		if (chunk.oldLines.length === 0) {
			// A pure addition goes at the end of the file (Codex).
			replacements.push([lines.length, 0, [...chunk.newLines]]);
			continue;
		}
		let pattern = chunk.oldLines;
		let newSlice = chunk.newLines;
		let found = seekSequence(lines, pattern, lineIndex, chunk.isEndOfFile);
		// A trailing empty line stands for the file's final newline: retry without it.
		if (found === undefined && pattern.at(-1) === "") {
			pattern = pattern.slice(0, -1);
			if (newSlice.at(-1) === "") newSlice = newSlice.slice(0, -1);
			found = seekSequence(lines, pattern, lineIndex, chunk.isEndOfFile);
		}
		if (found === undefined) {
			throw new Error(`Failed to find expected lines in ${path}:\n${chunk.oldLines.join("\n")}`);
		}
		// Context lines stay as they are in the file (their own endings survive).
		let oldStart = 0;
		let newStart = 0;
		for (const [oldContext, newContext] of chunk.contextLineIndices) {
			if (oldContext >= pattern.length || newContext >= newSlice.length) break;
			if (oldStart !== oldContext || newStart !== newContext) {
				replacements.push([found + oldStart, oldContext - oldStart, newSlice.slice(newStart, newContext)]);
			}
			oldStart = oldContext + 1;
			newStart = newContext + 1;
		}
		if (oldStart !== pattern.length || newStart !== newSlice.length) {
			replacements.push([found + oldStart, pattern.length - oldStart, newSlice.slice(newStart)]);
		}
		lineIndex = found + pattern.length;
	}
	return replacements.sort((a, b) => a[0] - b[0]);
}

/** The new contents of a file after its chunks. */
export function applyChunks(original: string, path: string, chunks: readonly PatchChunk[]): string {
	return applyChunksWithEdits(original, path, chunks).contents;
}

/** The new contents, and the replacements as offsets into the original (for the display diff). */
function applyChunksWithEdits(
	original: string,
	path: string,
	chunks: readonly PatchChunk[],
): { contents: string; edits: LocatedEdit[] } {
	const file = new SourceFile(original);
	const replacements = computeReplacements(file.texts(), path, chunks);
	const starts: number[] = [];
	let offset = 0;
	for (const line of file.lines) {
		starts.push(offset);
		offset += line.text.length + (line.ending?.length ?? 0);
	}
	starts.push(offset);
	const edits = replacements.map(([start, oldLength, newLines]): LocatedEdit => {
		const at = starts[start] ?? offset;
		return {
			at,
			oldText: original.slice(at, starts[start + oldLength] ?? offset),
			newText: newLines.map((text) => text + file.preferred).join(""),
		};
	});
	file.apply(replacements);
	return { contents: file.toString(), edits };
}

// --- Applying a patch (lib.rs) --------------------------------------------------------------

export interface AppliedFile {
	kind: "add" | "update" | "delete";
	path: string;
	/** Where an update moved the file. */
	movePath?: string;
	/** The numbered diff hosts show (the edit tool's format). */
	diff: string;
}

export interface PatchResult {
	/** Codex's summary: "Success. Updated the following files:" then A/M/D lines. */
	summary: string;
	files: AppliedFile[];
}

/** A failure after some files were already written: they stay (Codex), and are named. */
export class PatchApplyError extends Error {
	readonly applied: readonly AppliedFile[];

	constructor(message: string, applied: readonly AppliedFile[]) {
		super(
			applied.length === 0
				? message
				: `${message}\nApplied before the failure (left in place): ${applied
						.map(
							(file) =>
								`${file.kind === "add" ? "A" : file.kind === "delete" ? "D" : "M"} ${file.movePath ?? file.path}`,
						)
						.join(", ")}`,
		);
		this.applied = applied;
	}
}

const wholeFileDiff = (before: string, after: string): string =>
	editDiff(before, [{ at: 0, oldText: before, newText: after } satisfies LocatedEdit]).diff;

const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Parse and apply a patch through `fs`, file by file in order. */
export async function applyPatch(fs: FileSystem, patch: string): Promise<PatchResult> {
	const hunks = parsePatch(patch);
	if (hunks.length === 0) throw new Error("No files were modified.");
	const files: AppliedFile[] = [];
	const fail = (message: string): never => {
		throw new PatchApplyError(message, files);
	};
	for (const hunk of hunks) {
		if (hunk.kind === "add") {
			let previous = "";
			try {
				previous = await fs.readTextFile(hunk.path);
			} catch {
				// A new file.
			}
			await fs.writeTextFile(hunk.path, hunk.contents).catch((error) => fail(describe(error)));
			files.push({ kind: "add", path: hunk.path, diff: wholeFileDiff(previous, hunk.contents) });
		} else if (hunk.kind === "delete") {
			const info = await fs.stat(hunk.path).catch(() => undefined);
			if (!info) fail(`Failed to delete file ${hunk.path}`);
			if (info?.kind === "directory") fail(`Failed to delete file ${hunk.path}: it is a directory`);
			const content = await fs.readTextFile(hunk.path).catch(() => "");
			await fs.remove(hunk.path).catch((error) => fail(`Failed to delete file ${hunk.path}: ${describe(error)}`));
			files.push({ kind: "delete", path: hunk.path, diff: wholeFileDiff(content, "") });
		} else {
			const original = await fs
				.readTextFile(hunk.path)
				.catch((error) => fail(`Failed to read file to update ${hunk.path}: ${describe(error)}`));
			let updated = "";
			let edits: LocatedEdit[] = [];
			try {
				({ contents: updated, edits } = applyChunksWithEdits(original, hunk.path, hunk.chunks));
			} catch (error) {
				fail(describe(error));
			}
			if (hunk.movePath !== undefined) {
				await fs.writeTextFile(hunk.movePath, updated).catch((error) => fail(describe(error)));
				const info = await fs.stat(hunk.path).catch(() => undefined);
				if (info?.kind === "directory") fail(`Failed to remove original ${hunk.path}`);
				await fs.remove(hunk.path).catch((error) => fail(`Failed to remove original ${hunk.path}: ${describe(error)}`));
			} else {
				await fs
					.writeTextFile(hunk.path, updated)
					.catch((error) => fail(`Failed to write file ${hunk.path}: ${describe(error)}`));
			}
			files.push({
				kind: "update",
				path: hunk.path,
				...(hunk.movePath !== undefined ? { movePath: hunk.movePath } : {}),
				diff: editDiff(original, edits).diff,
			});
		}
	}
	const added = files.filter((file) => file.kind === "add").map((file) => `A ${file.path}`);
	const modified = files.filter((file) => file.kind === "update").map((file) => `M ${file.movePath ?? file.path}`);
	const deleted = files.filter((file) => file.kind === "delete").map((file) => `D ${file.path}`);
	return { summary: ["Success. Updated the following files:", ...added, ...modified, ...deleted].join("\n"), files };
}
