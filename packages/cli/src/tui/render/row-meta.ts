/**
 * How a transcript row copies (P38b, Codex): the cells of decoration it starts with (a
 * bar, a bullet, a tool's gutter), and how it joins the row above — a newline (`join`
 * undefined), or for a row a soft wrap made, the text the wrap took out (usually nothing
 * or a space). blockLines registers it for the rows it returns; the transcript reads it.
 * No Ink here: main.ts reaches this module through the controller before Ink may load.
 */
export interface RowMeta {
	indent: number;
	join?: string;
}

const ROW_META = new WeakMap<readonly string[], RowMeta[]>();

export function setRowMeta(rows: readonly string[], meta: RowMeta[]): void {
	ROW_META.set(rows, meta);
}

/** The copy metadata of rows blockLines made (undefined for other rows). */
export function rowMeta(rows: readonly string[]): readonly RowMeta[] | undefined {
	return ROW_META.get(rows);
}
