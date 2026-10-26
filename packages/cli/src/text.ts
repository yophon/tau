// Text helpers the CLI's modules and the TUI share (P62). No imports and nothing done at load, so
// the TUI can use them from an installed layout (the pack smoke copies only what the TUI imports).

/** The first line, cut to `max` characters with an ellipsis. */
export function firstLine(text: string, max = 60): string {
	const line = text.split("\n")[0] ?? "";
	return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

export function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
