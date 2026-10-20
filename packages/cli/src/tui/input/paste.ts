/**
 * Large-paste folding (ported from yo-agent surface-cli input/paste.ts; P38a
 * thresholds from pi): a paste of more than FOLD_LINES lines or FOLD_CHARS
 * characters shows as `[Pasted #n · N lines]` (`· N chars`) in the input box
 * and expands back when the input is submitted. The marker moves and deletes as
 * one unit (pi's atomic paste markers).
 */
export const FOLD_LINES = 10;
export const FOLD_CHARS = 1000;

export interface PasteStore {
	readonly entries: Map<string, string>;
	nextId: number;
}

export function newPasteStore(): PasteStore {
	return { entries: new Map(), nextId: 1 };
}

export function foldPaste(store: PasteStore, text: string): string {
	const lines = text.split("\n").length;
	if (lines <= FOLD_LINES && text.length <= FOLD_CHARS) return text;
	const size = lines > FOLD_LINES ? `${lines} lines` : `${text.length} chars`;
	const token = `[Pasted #${store.nextId} · ${size}]`;
	store.entries.set(token, text);
	store.nextId += 1;
	return token;
}

export function expandPastes(store: PasteStore, text: string): string {
	let out = text;
	for (const [token, content] of store.entries) out = out.split(token).join(content);
	return out;
}

/** The length of a paste marker ending right at `cursor` (0 for none). */
export function markerBefore(store: PasteStore, text: string, cursor: number): number {
	const before = text.slice(0, cursor);
	for (const token of store.entries.keys()) if (before.endsWith(token)) return token.length;
	return 0;
}

/** The length of a paste marker starting right at `cursor` (0 for none). */
export function markerAfter(store: PasteStore, text: string, cursor: number): number {
	for (const token of store.entries.keys()) if (text.startsWith(token, cursor)) return token.length;
	return 0;
}
