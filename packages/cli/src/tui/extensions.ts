/**
 * What an extension's renderer, widget or status item drew, as the hub sends it → styled lines.
 * Results are TUI-library neutral (D9/D10). P57: the renderers run in the hub; a component arrives
 * as the lines it drew at the width the TUI gave (its handleInput is never called, P25, open
 * question 5), text and markdown as text the TUI lays out at its width.
 */
import type { ClientRequests, Rendered } from "@yophon/tau-protocol";
import { renderMarkdown } from "./render/markdown.ts";
import { rawLines, type StyledLine, span } from "./render/spans.ts";

export function renderedLines(rendered: Rendered, width: number): StyledLine[] {
	if (rendered.kind === "lines") return rawLines(rendered.lines.join("\n"));
	return rendered.kind === "markdown" ? renderMarkdown(rendered.text, width) : rawLines(rendered.text);
}

/**
 * The widgets the hub drew, as the blocks above and below the input box (P35): which widget each
 * row above belongs to (for clicks), and which have an onClick. A widget that failed says so in red.
 */
export function widgetLines(
	widgets: ClientRequests["surfaces/read"]["result"]["widgets"],
	width: number,
): { above: StyledLine[][]; below: StyledLine[][]; rows: string[]; clickable: Set<string> } {
	const above: StyledLine[][] = [];
	const below: StyledLine[][] = [];
	const rows: string[] = [];
	const clickable = new Set<string>();
	for (const widget of widgets) {
		const target = widget.placement === "below-editor" ? below : above;
		const lines =
			widget.error !== undefined
				? [[span(`Widget ${widget.name} failed: ${widget.error}`, { color: "red" })]]
				: widget.rendered
					? renderedLines(widget.rendered, width)
					: undefined;
		if (!lines) continue;
		target.push(lines);
		if (target === above) rows.push(...lines.map(() => widget.name));
		if (widget.clickable) clickable.add(widget.name);
	}
	return { above, below, rows, clickable };
}
