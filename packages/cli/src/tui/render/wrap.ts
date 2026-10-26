/**
 * wrap-ansi 10.0.2 (MIT, Sindre Sorhus), ported for the one mode Ink uses: `{ trim: false, hard: true }`
 * (Ink 8's wrap-text). Same rows and escapes — words split on spaces, long words broken between
 * grapheme clusters, tabs to the next multiple of 8, every row closing the styles and link open at
 * its end and the next reopening them — with shortcuts that change nothing in the output: ASCII text
 * skips Unicode normalization, printable ASCII is one cell a character, a line that stays one row
 * keeps its escapes as they are, and parsed SGR parameters are kept (P62; the port of 9.0.2 had the
 * same fast paths, P33/P42d). tui-wrap.test.ts compares it with wrap-ansi on generated text.
 */
import stringWidth from "string-width";
import { cellWidth } from "../input/width.ts";

const ESC = "\u001B";
const BELL = "\u0007";
const TAB_SIZE = 8;

// A CSI (SGR captured), or an OSC: a hyperlink (parameters and URI captured) or any other complete one.
const ANSI =
	// biome-ignore lint/suspicious/noControlCharactersInRegex: escape sequences are what this matches
	/(?:\u001B\[|\u009B)(?:(?<sgr>[0-9;:]*)m|[0-?]*[ -/]*[@-~])|\u001B\](?:8;(?<parameters>[^;\u0000-\u001F\u007F-\u009F]*);(?<uri>[^\u0000-\u001F\u007F-\u009F]*)(?:\u0007|\u001B\\)|[^\u0000-\u001F\u007F-\u009F]*(?:\u0007|\u001B\\))/y;
// biome-ignore lint/suspicious/noControlCharactersInRegex: the characters that can start a sequence
const INTRODUCER = /[\u001B\u009B]/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: row breaks and sequence starts
const ROW_BOUNDARY = /[\n\u001B\u009B]/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: any character that can start a sequence
const HAS_INTRODUCER = /[\u001B\u009B]/;
const PRINTABLE_ASCII = /^[\x20-\x7e]*$/;
// biome-ignore lint/suspicious/noControlCharactersInRegex: ASCII, which normalization leaves alone
const ASCII = /^[\x00-\x7f]*$/;

/** ansi-styles' open → close codes. */
const CLOSE = new Map<number, number>([
	[0, 0],
	[1, 22],
	[2, 22],
	[3, 23],
	[4, 24],
	[53, 55],
	[7, 27],
	[8, 28],
	[9, 29],
]);
for (let code = 30; code <= 37; code++) CLOSE.set(code, 39);
for (let code = 90; code <= 97; code++) CLOSE.set(code, 39);
for (let code = 40; code <= 47; code++) CLOSE.set(code, 49);
for (let code = 100; code <= 107; code++) CLOSE.set(code, 49);
/** Close codes that end modifiers (wrap-ansi: every ansi-styles close code but 0). */
const MODIFIER_CLOSE = new Set([...CLOSE.values()].filter((code) => code !== 0));

const sgrCode = (code: number | string) => `${ESC}[${code}m`;
const hyperlink = (uri: string, parameters = "") => `${ESC}]8;${parameters};${uri}${BELL}`;

/** A complete sequence starting at `index`, or undefined. */
function escapeAt(text: string, index: number): RegExpExecArray | undefined {
	const character = text[index];
	if (character !== ESC && character !== "\u009B") return undefined;
	ANSI.lastIndex = index;
	return ANSI.exec(text) ?? undefined;
}

/** The text as plain runs and complete sequences; an introducer that starts none is plain text. */
function forEachSegment(text: string, onPlain: (plain: string) => void, onEscape?: (sequence: string) => void): void {
	let plainStart = 0;
	let index = 0;
	while (index < text.length) {
		INTRODUCER.lastIndex = index;
		const introducer = INTRODUCER.exec(text);
		if (!introducer) break;
		const sequence = escapeAt(text, introducer.index);
		if (!sequence) {
			index = introducer.index + 1;
			continue;
		}
		if (introducer.index > plainStart) onPlain(text.slice(plainStart, introducer.index));
		onEscape?.(sequence[0]);
		index = introducer.index + sequence[0].length;
		plainStart = index;
	}
	if (plainStart < text.length) onPlain(text.slice(plainStart));
}

/** Cells of text with no sequences in it (string-width counting escape bytes as text). */
const plainWidth = (plain: string): number =>
	PRINTABLE_ASCII.test(plain) ? plain.length : stringWidth(plain, { countAnsiEscapeCodes: true });

/** Cells of text, its sequences counting as zero. */
function widthOf(text: string): number {
	if (!HAS_INTRODUCER.test(text)) return plainWidth(text);
	let plain = "";
	forEachSegment(text, (part) => {
		plain += part;
	});
	return plainWidth(plain);
}

/** Sequences (zero width, never split) and grapheme clusters. */
function tokens(word: string): Array<{ value: string; width: number }> {
	const out: Array<{ value: string; width: number }> = [];
	forEachSegment(
		word,
		(plain) => {
			if (PRINTABLE_ASCII.test(plain)) {
				for (const character of plain) out.push({ value: character, width: 1 });
				return;
			}
			segmenter ??= new Intl.Segmenter();
			for (const { segment } of segmenter.segment(plain)) out.push({ value: segment, width: cellWidth(segment) });
		},
		(sequence) => out.push({ value: sequence, width: 0 }),
	);
	return out;
}
let segmenter: Intl.Segmenter | undefined;

/** Words split on spaces outside sequences, each measured once. */
function splitWords(line: string): Array<{ value: string; width: number }> {
	if (!HAS_INTRODUCER.test(line)) return line.split(" ").map((word) => ({ value: word, width: plainWidth(word) }));
	let current = { value: "", plain: "" };
	const words = [current];
	forEachSegment(
		line,
		(plain) => {
			const parts = plain.split(" ");
			current.value += parts[0];
			current.plain += parts[0];
			for (let index = 1; index < parts.length; index++) {
				current = { value: parts[index] as string, plain: parts[index] as string };
				words.push(current);
			}
		},
		(sequence) => {
			current.value += sequence;
		},
	);
	return words.map((word) => ({ value: word.value, width: plainWidth(word.plain) }));
}

// --- SGR state, as wrap-ansi tracks it ---------------------------------------------------------

interface SgrToken {
	code: number;
	open: string;
	hasArguments: boolean;
}

interface ActiveStyle {
	family: string;
	open: string;
	close: number;
}

/** 38/48/58 with colon arguments (`38:5:n`, `38:2::r:g:b`), else undefined. */
function colonColor(parameter: string): SgrToken | undefined {
	const parts = parameter.split(":");
	const code = Number.parseInt(parts[0] as string, 10);
	const mode = Number.parseInt(parts[1] as string, 10);
	if (code !== 38 && code !== 48 && code !== 58) return undefined;
	if (mode === 5 && parts.length === 3 && /^\d+$/.test(parts[2] as string))
		return { code, open: parameter, hasArguments: true };
	if (mode !== 2) return undefined;
	const components = parts.length === 6 ? parts.slice(3) : parts.slice(2);
	const colorSpace = parts.length === 6 ? parts[2] : undefined;
	if (
		components.length === 3 &&
		components.every((component) => /^\d+$/.test(component)) &&
		(colorSpace === undefined || /^\d*$/.test(colorSpace))
	) {
		return { code, open: parameter, hasArguments: true };
	}
	return undefined;
}

const SGR_TOKENS = new Map<string, SgrToken[]>();

/** An SGR's parameters as tokens (kept: a transcript repeats a handful of them). */
function sgrTokens(parameters: string): SgrToken[] {
	const known = SGR_TOKENS.get(parameters);
	if (known) return known;
	const list = parameters.split(";");
	const out: SgrToken[] = [];
	for (let index = 0; index < list.length; index++) {
		const parameter = list[index] as string;
		if (parameter.includes(":")) {
			const color = colonColor(parameter);
			if (color) out.push(color);
			continue;
		}
		const code = parameter === "" ? 0 : Number.parseInt(parameter, 10);
		if (!Number.isFinite(code)) continue;
		if (code === 38 || code === 48 || code === 58) {
			if (index + 1 >= list.length) break;
			const mode = Number.parseInt(list[index + 1] as string, 10);
			const colorIndex = Number.parseInt(list[index + 2] as string, 10);
			if (mode === 5 && Number.isFinite(colorIndex)) {
				out.push({ code, open: [code, mode, colorIndex].join(";"), hasArguments: true });
				index += 2;
				continue;
			}
			const red = Number.parseInt(list[index + 2] as string, 10);
			const green = Number.parseInt(list[index + 3] as string, 10);
			const blue = Number.parseInt(list[index + 4] as string, 10);
			if (mode === 2 && Number.isFinite(red) && Number.isFinite(green) && Number.isFinite(blue)) {
				out.push({ code, open: [code, mode, red, green, blue].join(";"), hasArguments: true });
				index += 4;
				continue;
			}
			break;
		}
		out.push({ code, open: String(code), hasArguments: false });
	}
	if (SGR_TOKENS.size < 1000) SGR_TOKENS.set(parameters, out);
	return out;
}

function removeStyle(active: ActiveStyle[], family: string): void {
	const at = active.findIndex((style) => style.family === family);
	if (at !== -1) active.splice(at, 1);
}

function upsertStyle(active: ActiveStyle[], style: ActiveStyle): void {
	removeStyle(active, style.family);
	active.push(style);
}

/** A reset code's effect; whether it was one. */
function applyReset(code: number, active: ActiveStyle[]): boolean {
	if (code === 0) {
		active.length = 0;
		return true;
	}
	if (code === 39) {
		removeStyle(active, "foreground");
		return true;
	}
	if (code === 49) {
		removeStyle(active, "background");
		return true;
	}
	if (code === 59) {
		removeStyle(active, "underlineColor");
		return true;
	}
	if (MODIFIER_CLOSE.has(code)) {
		for (let index = active.length - 1; index >= 0; index--) {
			const style = active[index] as ActiveStyle;
			if (style.family.startsWith("modifier-") && style.close === code) active.splice(index, 1);
		}
		return true;
	}
	return false;
}

function colorStyle({ code, open, hasArguments }: SgrToken): ActiveStyle | undefined {
	if ((code >= 30 && code <= 37) || (code >= 90 && code <= 97) || (code === 38 && hasArguments))
		return { family: "foreground", open, close: 39 };
	if ((code >= 40 && code <= 47) || (code >= 100 && code <= 107) || (code === 48 && hasArguments))
		return { family: "background", open, close: 49 };
	if (code === 58 && hasArguments) return { family: "underlineColor", open, close: 59 };
	return undefined;
}

function applySgr(parameters: string, active: ActiveStyle[]): void {
	for (const token of sgrTokens(parameters)) {
		if (applyReset(token.code, active)) continue;
		const color = colorStyle(token);
		if (color) {
			upsertStyle(active, color);
			continue;
		}
		const close = CLOSE.get(token.code);
		if (close !== undefined && close !== 0)
			upsertStyle(active, { family: `modifier-${token.code}`, open: token.open, close });
	}
}

/**
 * Before every row break, close the styles and link still open; after it, reopen them (less what
 * the next row's leading SGR codes reset), so each row stands on its own. Empty rows get neither.
 */
function restoreStylesAcrossRows(text: string): string {
	let out = "";
	let link: { parameters: string; uri: string } | undefined;
	const active: ActiveStyle[] = [];
	let index = 0;
	let copied = 0;
	while (index < text.length) {
		ROW_BOUNDARY.lastIndex = index;
		const boundary = ROW_BOUNDARY.exec(text);
		if (!boundary) break;
		index = boundary.index;
		if (boundary[0] !== "\n") {
			const sequence = escapeAt(text, index);
			if (!sequence) {
				index++;
				continue;
			}
			const groups = sequence.groups ?? {};
			if (groups.sgr !== undefined) applySgr(groups.sgr, active);
			else if (groups.uri !== undefined) {
				link = groups.uri.length === 0 ? undefined : { parameters: groups.parameters ?? "", uri: groups.uri };
			}
			index += sequence[0].length;
			continue;
		}
		out += text.slice(copied, index);
		if (index > copied) {
			if (link) out += hyperlink("");
			for (let at = active.length - 1; at >= 0; at--) out += sgrCode((active[at] as ActiveStyle).close);
		}
		out += "\n";
		index++;
		copied = index;
		if (index < text.length && text[index] !== "\n") {
			const opening = [...active];
			// The next row's own leading resets apply before reopening.
			let at = index;
			for (let sequence = escapeAt(text, at); sequence; sequence = escapeAt(text, at)) {
				const sgr = sequence.groups?.sgr;
				if (sgr !== undefined) for (const { code } of sgrTokens(sgr)) applyReset(code, opening);
				at += sequence[0].length;
			}
			for (const style of opening) out += sgrCode(style.open);
			if (link) out += hyperlink(link.uri, link.parameters);
		}
	}
	return out + text.slice(copied);
}

// --- Wrapping -----------------------------------------------------------------------------------

/** A long word broken across rows from the last row's width; the width of the row it ends on. */
function wrapWord(rows: string[], word: string, columns: number, rowWidth: number): number {
	const parts = tokens(word);
	let visible = rowWidth;
	for (let index = 0; index < parts.length; index++) {
		const part = parts[index] as { value: string; width: number };
		// Sequences and combining marks are zero width: they stay on the current row.
		if (part.width > 0 && visible > 0 && visible + part.width > columns) {
			rows.push("");
			visible = 0;
		}
		rows[rows.length - 1] += part.value;
		visible += part.width;
		if (visible === columns && index < parts.length - 1) {
			rows.push("");
			visible = 0;
		}
	}
	// The last row may hold only sequences.
	if (!visible && (rows[rows.length - 1] as string).length > 0 && rows.length > 1) {
		rows[rows.length - 2] += rows.pop();
	}
	// A cluster split by a sequence was counted once per part: measure the finished row.
	return widthOf(rows[rows.length - 1] as string);
}

function expandTabs(line: string): string {
	if (!line.includes("\t")) return line;
	let visible = 0;
	let out = "";
	let sinceTab = "";
	forEachSegment(
		line,
		(plain) => {
			const segments = plain.split("\t");
			for (let index = 0; index < segments.length; index++) {
				out += segments[index];
				sinceTab += segments[index];
				if (index < segments.length - 1) {
					visible += plainWidth(sinceTab);
					sinceTab = "";
					const spaces = TAB_SIZE - (visible % TAB_SIZE);
					out += " ".repeat(spaces);
					visible += spaces;
				}
			}
		},
		(sequence) => {
			out += sequence;
		},
	);
	return out;
}

function exec(line: string, columns: number): string {
	const rows = [""];
	// The last row's width, kept as words are added.
	let rowLength = 0;
	let first = true;
	for (const word of splitWords(line)) {
		if (first) first = false;
		else {
			if (rowLength >= columns) {
				rows.push("");
				rowLength = 0;
			}
			rows[rows.length - 1] += " ";
			rowLength++;
		}
		if (word.width > columns) {
			const remaining = columns - rowLength;
			const breaksThisLine = 1 + Math.floor((word.width - remaining - 1) / columns);
			const breaksNextLine = Math.floor((word.width - 1) / columns);
			if (breaksNextLine < breaksThisLine) {
				rows.push("");
				rowLength = 0;
			}
			rowLength = wrapWord(rows, word.value, columns, rowLength);
			continue;
		}
		if (rowLength + word.width > columns && rowLength > 0 && word.width > 0) {
			rows.push("");
			rowLength = 0;
		}
		rows[rows.length - 1] += word.value;
		rowLength += word.width;
	}
	// One row: nothing to close or reopen, the text stays as it is.
	return rows.length === 1 ? (rows[0] as string) : restoreStylesAcrossRows(rows.join("\n"));
}

/** Unicode normalization of the text, not of the sequences (a combining mark after one would eat it). */
function normalizeText(text: string): string {
	if (ASCII.test(text)) return text;
	if (!HAS_INTRODUCER.test(text)) return text.normalize();
	let out = "";
	forEachSegment(
		text,
		(plain) => {
			out += plain.normalize();
		},
		(sequence) => {
			out += sequence;
		},
	);
	return out;
}

/** wrapAnsi(text, columns, { trim: false, hard: true }). */
export function wrapText(text: string, columns: number): string {
	return normalizeText(text)
		.replaceAll("\r\n", "\n")
		.split("\n")
		.map((line) => exec(expandTabs(line), columns))
		.join("\n");
}

// SGR codes as ansi-regex matches them (strip-ansi, inside string-width).
// biome-ignore lint/suspicious/noControlCharactersInRegex: SGR codes are what this strips
const SGR = /\u001B\[(?:\d{1,4}(?:;\d{0,4})*)?m/g;

/** string-width, with a fast path: printable ASCII around SGR codes is one cell a character. */
export function visibleWidth(text: string): number {
	if (PRINTABLE_ASCII.test(text)) return text.length;
	const plain = text.includes(ESC) ? text.replace(SGR, "") : text;
	return PRINTABLE_ASCII.test(plain) ? plain.length : stringWidth(text);
}
