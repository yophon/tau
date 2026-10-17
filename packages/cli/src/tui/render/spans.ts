/**
 * Styled spans: the output of every pure renderer (markdown, diff, tool views,
 * approval bodies). blocks.ts turns them into Ink <Text>; tests read them as
 * plain data.
 */
export interface Span {
	text: string;
	bold?: boolean;
	italic?: boolean;
	underline?: boolean;
	dim?: boolean;
	inverse?: boolean;
	/** Ink color name. */
	color?: string;
}

export type StyledLine = Span[];

export function span(text: string, style: Omit<Span, "text"> = {}): Span {
	return { text, ...style };
}

export function plainLine(text: string, style: Omit<Span, "text"> = {}): StyledLine {
	return [span(text, style)];
}

export function lineText(line: StyledLine): string {
	return line.map((part) => part.text).join("");
}

/** Text that may carry ANSI escapes (extension renderers) as one span per line; Ink keeps the escapes. */
export function rawLines(text: string): StyledLine[] {
	return text.split("\n").map((line) => [span(line)]);
}
