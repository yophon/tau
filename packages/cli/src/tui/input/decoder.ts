/**
 * Raw input chunks → input events (ported from yo-agent surface-cli
 * input/decoder.ts). Handles bracketed paste and the pseudo-terminal habit of
 * delivering "text + Enter" in one chunk; everything else passes through to
 * the keymap.
 *
 * It depends on how Ink 5 parses keypresses (measured in yo-agent 4.6b):
 * - Ink strips the first ESC of a chunk, so a paste start arrives as `[200~`
 *   (or `\x1b[200~` when not first); an end marker alone in a chunk arrives as
 *   `[201~`, inside content as `\x1b[201~`.
 * - A lone \r or \t becomes key.return / key.tab with empty input; inside a
 *   paste they are restored as literal characters.
 * - Alt+Enter arrives as ch '\r' without key.return; Ctrl+J as ch '\n'.
 */
import type { KeyLike } from "../keymap.ts";

const START = "[200~";
const START_RAW = "\x1b[200~";
const END = "\x1b[201~";
const END_STRIPPED = "[201~";

export type InputEvent =
	| { kind: "paste"; text: string }
	| { kind: "text"; text: string }
	| { kind: "enter" }
	| { kind: "key"; ch: string; key: KeyLike };

export class InputDecoder {
	private buffer: string | undefined;

	get pasting(): boolean {
		return this.buffer !== undefined;
	}

	feed(raw: string, key: KeyLike = {}): InputEvent[] {
		if (this.buffer !== undefined) {
			let text = raw;
			if (text === "" && key.return) text = "\r";
			if (text === "" && key.tab) text = "\t";
			return this.consume(text);
		}
		const index = indexOfStart(raw);
		if (index !== -1) {
			const out: InputEvent[] = [];
			const prefix = raw.slice(0, index);
			if (prefix !== "") out.push(...this.plain(prefix, {}));
			const rest = raw.slice(index).replace(START_RAW, "").replace(START, "");
			this.buffer = "";
			out.push(...this.consume(rest));
			return out;
		}
		return this.plain(raw, key);
	}

	private consume(text: string): InputEvent[] {
		const end = earliestEnd(text);
		if (end === undefined) {
			this.buffer = (this.buffer ?? "") + text;
			return [];
		}
		const content = (this.buffer ?? "") + text.slice(0, end.pos);
		this.buffer = undefined;
		const out: InputEvent[] = [{ kind: "paste", text: content }];
		const rest = text.slice(end.pos + end.len);
		if (rest !== "") out.push(...this.feed(rest, {}));
		return out;
	}

	private plain(raw: string, key: KeyLike): InputEvent[] {
		if (!key.return && raw.length > 1 && /[\r\n]/.test(raw)) {
			const parts = raw.split(/\r\n|\r|\n/);
			const out: InputEvent[] = [];
			for (let i = 0; i < parts.length; i++) {
				const part = parts[i] ?? "";
				if (part !== "") out.push({ kind: "text", text: part });
				if (i < parts.length - 1) out.push({ kind: "enter" });
			}
			return out;
		}
		return [{ kind: "key", ch: raw, key }];
	}
}

function indexOfStart(text: string): number {
	const a = text.indexOf(START_RAW);
	const b = text.indexOf(START);
	if (a === -1) return b;
	if (b === -1) return a;
	return Math.min(a, b);
}

function earliestEnd(text: string): { pos: number; len: number } | undefined {
	const a = text.indexOf(END);
	const b = text.startsWith(END_STRIPPED) ? 0 : -1;
	if (a === -1 && b === -1) return undefined;
	if (b !== -1 && (a === -1 || b < a)) return { pos: b, len: END_STRIPPED.length };
	return { pos: a, len: END.length };
}
