/**
 * Large-paste folding (ported from yo-agent surface-cli input/paste.ts): a
 * paste of more than FOLD_LINES lines shows as `[Pasted #n · N lines]` in the
 * input box and expands back when the input is submitted.
 */
export const FOLD_LINES = 10;

export interface PasteStore {
	readonly entries: Map<string, string>;
	nextId: number;
}

export function newPasteStore(): PasteStore {
	return { entries: new Map(), nextId: 1 };
}

export function foldPaste(store: PasteStore, text: string): string {
	const lines = text.split("\n").length;
	if (lines <= FOLD_LINES) return text;
	const token = `[Pasted #${store.nextId} · ${lines} lines]`;
	store.entries.set(token, text);
	store.nextId += 1;
	return token;
}

export function expandPastes(store: PasteStore, text: string): string {
	let out = text;
	for (const [token, content] of store.entries) out = out.split(token).join(content);
	return out;
}
