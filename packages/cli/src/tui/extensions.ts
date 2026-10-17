/**
 * Extension render results → styled lines. Results are TUI-library neutral
 * (D9/D10): a string, `{ text, format }`, or a component with
 * `render(width): string[]`. In this TUI a component only renders; its
 * handleInput is never called (P25, open question 5).
 */
import type {
	AgentMessage,
	ExtensionRenderComponent,
	RegisteredEntryRenderer,
	RegisteredMessageRenderer,
	RegisteredToolRenderEvent,
	RegisteredToolRenderer,
	SessionEntry,
} from "@yophon/tau-kernel";
import { renderMarkdown } from "./render/markdown.ts";
import { rawLines, type StyledLine } from "./render/spans.ts";

export type RenderResult =
	| string
	| { text: string; format?: "text" | "markdown" }
	| ExtensionRenderComponent
	| undefined;

export function isRenderComponent(value: unknown): value is ExtensionRenderComponent {
	return typeof value === "object" && value !== null && "render" in value && typeof value.render === "function";
}

export function renderResultLines(result: RenderResult, width: number): StyledLine[] | undefined {
	if (result === undefined) return undefined;
	if (typeof result === "string") return rawLines(result);
	if (isRenderComponent(result)) return rawLines(result.render(width).join("\n"));
	return result.format === "markdown" ? renderMarkdown(result.text, width) : rawLines(result.text);
}

export function messageRendererMatches(renderer: RegisteredMessageRenderer, message: AgentMessage): boolean {
	if (renderer.roles && !renderer.roles.includes(message.role)) return false;
	if (renderer.customTypes) {
		if (message.role !== "custom") return false;
		if (!renderer.customTypes.includes(message.customType)) return false;
	}
	return true;
}

export function entryCustomType(entry: SessionEntry): string | undefined {
	if (entry.type === "custom" || entry.type === "custom_message") return entry.customType;
	return undefined;
}

export function entryRendererMatches(renderer: RegisteredEntryRenderer, entry: SessionEntry): boolean {
	if (renderer.entryTypes && !renderer.entryTypes.includes(entry.type)) return false;
	const customType = entryCustomType(entry);
	if (renderer.customTypes) {
		if (!customType) return false;
		if (!renderer.customTypes.includes(customType)) return false;
	}
	return true;
}

export function toolRendererMatches(renderer: RegisteredToolRenderer, event: RegisteredToolRenderEvent): boolean {
	if (renderer.toolNames && !renderer.toolNames.includes(event.toolCall.name)) return false;
	if (renderer.phases && !renderer.phases.includes(event.phase)) return false;
	return true;
}
