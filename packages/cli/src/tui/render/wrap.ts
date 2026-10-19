/**
 * wrap-ansi 9.0.2 (MIT, Sindre Sorhus), ported for the one mode Ink uses:
 * `{ trim: false, hard: true }` (ink/build/wrap-text.js). Same rows, same escape
 * handling — including its quirks, such as reopening only the last simple SGR
 * code on the next row — but widths come from a printable-ASCII fast path, and
 * the escape scan is one sticky regex instead of a new RegExp and a slice per
 * escape. tui-wrap.test.ts compares it with wrap-ansi on generated text.
 */
import { strWidth } from "../input/width.ts";

const ESC = "\u001B";
const CSI8 = "\u009B";
const BELL = "\u0007";
const LINK = "]8;;";
const END_CODE = 39;

/** ansi-styles' open → close codes, the ones wrap-ansi reopens and closes. */
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

const isEscape = (character: string) => character === ESC || character === CSI8;

const PRINTABLE_ASCII = /^[\x20-\x7e]*$/;
// SGR codes as ansi-regex matches them (strip-ansi, inside string-width).
// biome-ignore lint/suspicious/noControlCharactersInRegex: SGR codes are what this strips
const SGR = /\u001B\[(?:\d{1,4}(?:;\d{0,4})*)?m/g;

/** string-width, with a fast path: printable ASCII around SGR codes is one cell a character. */
export function visibleWidth(text: string): number {
	if (PRINTABLE_ASCII.test(text)) return text.length;
	const plain = text.includes(ESC) ? text.replace(SGR, "") : text;
	return PRINTABLE_ASCII.test(plain) ? plain.length : strWidth(text);
}

const width = visibleWidth;

function wrapWord(rows: string[], word: string, columns: number): void {
	const characters = [...word];
	let insideEscape = false;
	let insideLink = false;
	let visible = width(rows[rows.length - 1] ?? "");
	for (let index = 0; index < characters.length; index++) {
		const character = characters[index] as string;
		const characterLength = width(character);
		if (visible + characterLength <= columns) rows[rows.length - 1] += character;
		else {
			rows.push(character);
			visible = 0;
		}
		if (isEscape(character)) {
			insideEscape = true;
			insideLink = characters.slice(index + 1, index + 1 + LINK.length).join("") === LINK;
		}
		if (insideEscape) {
			if (insideLink) {
				if (character === BELL) {
					insideEscape = false;
					insideLink = false;
				}
			} else if (character === "m") insideEscape = false;
			continue;
		}
		visible += characterLength;
		if (visible === columns && index < characters.length - 1) {
			rows.push("");
			visible = 0;
		}
	}
	// The last row may hold only escape codes.
	if (!visible && (rows[rows.length - 1] as string).length > 0 && rows.length > 1) {
		rows[rows.length - 2] += rows.pop();
	}
}

// Unanchored like wrap-ansi's `new RegExp(...).exec(rest)`: the first match at or after the escape.
// biome-ignore lint/suspicious/noControlCharactersInRegex: a hyperlink ends in BEL
const CODE = /(?:\[(?<code>\d+)m|\]8;;(?<uri>.*)\u0007)/g;

function exec(line: string, columns: number): string {
	const words = line.split(" ");
	const lengths = words.map(width);
	const rows = [""];
	for (let index = 0; index < words.length; index++) {
		const word = words[index] as string;
		let rowLength = width(rows[rows.length - 1] as string);
		if (index !== 0) {
			if (rowLength >= columns) {
				rows.push("");
				rowLength = 0;
			}
			rows[rows.length - 1] += " ";
			rowLength++;
		}
		const length = lengths[index] as number;
		if (length > columns) {
			const remaining = columns - rowLength;
			const breaksThisLine = 1 + Math.floor((length - remaining - 1) / columns);
			const breaksNextLine = Math.floor((length - 1) / columns);
			if (breaksNextLine < breaksThisLine) rows.push("");
			wrapWord(rows, word, columns);
			continue;
		}
		if (rowLength + length > columns && rowLength > 0 && length > 0) rows.push("");
		rows[rows.length - 1] += word;
	}

	const pre = rows.join("\n");
	if (!pre.includes(ESC) && !pre.includes(CSI8)) return pre;
	let out = "";
	let escapeCode: number | undefined;
	let escapeUrl: string | undefined;
	const characters = [...pre];
	let offset = 0;
	for (let index = 0; index < characters.length; index++) {
		const character = characters[index] as string;
		out += character;
		if (isEscape(character)) {
			CODE.lastIndex = offset;
			const groups = CODE.exec(pre)?.groups ?? {};
			if (groups.code !== undefined) {
				const code = Number.parseFloat(groups.code);
				escapeCode = code === END_CODE ? undefined : code;
			} else if (groups.uri !== undefined) {
				escapeUrl = groups.uri.length === 0 ? undefined : groups.uri;
			}
		}
		const close = escapeCode === undefined ? undefined : CLOSE.get(escapeCode);
		if (characters[index + 1] === "\n") {
			if (escapeUrl) out += `${ESC}${LINK}${BELL}`;
			if (escapeCode && close) out += `${ESC}[${close}m`;
		} else if (character === "\n") {
			if (escapeCode && close) out += `${ESC}[${escapeCode}m`;
			if (escapeUrl) out += `${ESC}${LINK}${escapeUrl}${BELL}`;
		}
		offset += character.length;
	}
	return out;
}

/** wrapAnsi(text, columns, { trim: false, hard: true }). */
export function wrapText(text: string, columns: number): string {
	return text
		.normalize()
		.replaceAll("\r\n", "\n")
		.split("\n")
		.map((line) => exec(line, columns))
		.join("\n");
}
