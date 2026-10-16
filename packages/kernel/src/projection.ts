import {
	type AgentMessage,
	combineUsage,
	contentText,
	emptyUsage,
	type SystemMessage,
	type ToolDefinition,
	type Usage,
} from "./messages.ts";
import type { SessionEntry } from "./session.ts";

/**
 * The session log is the only source of model context (P22, pi 1.2.0). This
 * module holds the pure functions that turn a log into what the model sees:
 * transcript replay (system messages → current prompt and tools; pi
 * ai/utils/transcript.ts + text.ts) and the session projection (path →
 * compaction-aware entries → context edits → messages with their source
 * entries; pi coding-agent session-manager.ts).
 */

// ---------------------------------------------------------------------------
// Transcript replay.
// ---------------------------------------------------------------------------

function isSystemMessage(message: { role: string }): message is SystemMessage {
	return message.role === "system";
}

/** Render a system message as a complete prompt: its content followed by its live sections. */
export function getSystemMessageText(message: SystemMessage): string {
	const parts = [contentText(message.content, "\n")];
	for (const text of Object.values(message.sections ?? {})) {
		if (text !== null) parts.push(text);
	}
	return parts.filter((part) => part.length > 0).join("\n\n");
}

/**
 * Render a later system message for endpoints that accept system messages
 * mid-conversation. Section changes are framed by name so the model can relate
 * them to the leading prompt. Request-time only.
 */
export function renderSystemMessageUpdate(message: SystemMessage): string {
	const parts: string[] = [];
	const text = contentText(message.content, "\n");
	if (text.length > 0) parts.push(text);
	for (const [name, value] of Object.entries(message.sections ?? {})) {
		parts.push(
			value === null
				? `Removed system prompt section "${name}".`
				: `Updated system prompt section "${name}":\n\n${value}`,
		);
	}
	return parts.join("\n\n");
}

/** Tools available after applying every transcript delta in order. */
export function getCurrentTools(messages: readonly { role: string }[]): ToolDefinition[] {
	const tools = new Map<string, ToolDefinition>();
	for (const message of messages) {
		if (!isSystemMessage(message)) continue;
		for (const tool of message.toolsRemoved ?? []) tools.delete(tool.name);
		for (const tool of message.toolsAdded ?? []) tools.set(tool.name, tool);
	}
	return [...tools.values()];
}

/**
 * Replay every system message into one system message holding the current
 * prompt and tools: later `content` is appended, `sections` are patched by
 * name, tools are resolved with getCurrentTools.
 */
export function getCurrentSystemMessage(messages: readonly { role: string }[]): SystemMessage | undefined {
	const content: string[] = [];
	const sections = new Map<string, string>();
	let timestamp: number | undefined;
	for (const message of messages) {
		if (!isSystemMessage(message)) continue;
		timestamp ??= message.timestamp;
		const text = contentText(message.content, "\n");
		if (text.length > 0) content.push(text);
		for (const [name, value] of Object.entries(message.sections ?? {})) {
			if (value === null) sections.delete(name);
			else sections.set(name, value);
		}
	}
	const tools = getCurrentTools(messages);
	if (timestamp === undefined && tools.length === 0) return undefined;
	return {
		role: "system",
		content: content.join("\n\n"),
		...(sections.size > 0 ? { sections: Object.fromEntries(sections) } : {}),
		...(tools.length > 0 ? { toolsAdded: tools } : {}),
		timestamp: timestamp ?? 0,
	};
}

/** The current system prompt text after replaying every system message. */
export function getCurrentSystemPrompt(messages: readonly { role: string }[]): string {
	const message = getCurrentSystemMessage(messages);
	return message ? getSystemMessageText(message) : "";
}

/**
 * Rebuild a transcript for endpoints without mid-conversation system
 * messages: the replayed system message leads, every other system message is
 * dropped. Transports fold the head into their own prompt field.
 */
export function collapseSystemMessages(messages: readonly AgentMessage[]): AgentMessage[] {
	const head = getCurrentSystemMessage(messages);
	const rest = messages.filter((message) => message.role !== "system");
	return head ? [head, ...rest] : rest;
}

/** Strip a tool to what the model is told (name, description, parameters), JSON-cloned. */
export function toToolDeclaration(tool: ToolDefinition): ToolDefinition {
	return {
		name: tool.name,
		description: tool.description,
		parameters: JSON.parse(JSON.stringify(tool.parameters)) as ToolDefinition["parameters"],
	};
}

/** Whether two tools declare the same interface to the model (serialized declarations compared). */
export function declarationsEqual(left: ToolDefinition, right: ToolDefinition): boolean {
	return JSON.stringify(toToolDeclaration(left)) === JSON.stringify(toToolDeclaration(right));
}

export interface ToolStateChanges {
	toolsAdded: ToolDefinition[];
	toolsRemoved: { name: string }[];
}

/** Compare two complete tool states. A changed definition is a removal followed by an addition. */
export function getToolStateChanges(
	previous: readonly ToolDefinition[],
	current: readonly ToolDefinition[],
): ToolStateChanges {
	const previousTools = new Map(previous.map((tool) => [tool.name, tool]));
	const currentTools = new Map(current.map((tool) => [tool.name, tool]));
	return {
		toolsAdded: current
			.filter((tool) => {
				const previousTool = previousTools.get(tool.name);
				return previousTool === undefined || !declarationsEqual(previousTool, tool);
			})
			.map(toToolDeclaration),
		toolsRemoved: previous
			.filter((tool) => {
				const currentTool = currentTools.get(tool.name);
				return currentTool === undefined || !declarationsEqual(tool, currentTool);
			})
			.map((tool) => ({ name: tool.name })),
	};
}

/** Patch turning `previous` sections into `current` (pi diffSystemPromptSections); undefined when equal. */
export function diffSystemPromptSections(
	previous: Record<string, string | null>,
	current: Record<string, string>,
): Record<string, string | null> | undefined {
	const patch: Record<string, string | null> = {};
	for (const [name, text] of Object.entries(current)) {
		if (previous[name] !== text) patch[name] = text;
	}
	for (const name of Object.keys(previous)) {
		if (current[name] === undefined) patch[name] = null;
	}
	return Object.keys(patch).length > 0 ? patch : undefined;
}

// ---------------------------------------------------------------------------
// Session projection.
// ---------------------------------------------------------------------------

/**
 * Normalize null/missing content at an ingestion boundary (pi 0.80.4): untyped
 * callers and old files can hand over messages without content.
 */
export function normalizeMessageContent(message: AgentMessage): AgentMessage {
	return sessionEntryToContextMessages({ type: "message", id: "", parentId: null, timestamp: "", message })[0];
}

function entryTime(entry: SessionEntry): number {
	return Date.parse(entry.timestamp) || 0;
}

/**
 * Messages one entry contributes to context. Session files are parsed without
 * validation, so null/missing content is normalized here (pi 0.80.4).
 */
export function sessionEntryToContextMessages(entry: SessionEntry): AgentMessage[] {
	switch (entry.type) {
		case "message": {
			const message = entry.message;
			if (message.role === "system" && message.content == null) return [{ ...message, content: "" }];
			if (
				(message.role === "user" || message.role === "assistant" || message.role === "toolResult") &&
				message.content == null
			) {
				return [{ ...message, content: [] }];
			}
			return [message];
		}
		case "custom_message":
			return [
				{
					role: "custom",
					customType: entry.customType,
					content: entry.content ?? [],
					display: entry.display,
					details: entry.details,
					timestamp: entryTime(entry),
				},
			];
		case "branch_summary":
			return entry.summary
				? [{ role: "branchSummary", summary: entry.summary, fromId: entry.fromId, timestamp: entryTime(entry) }]
				: [];
		case "compaction": {
			const summary: AgentMessage = {
				role: "compactionSummary",
				summary: entry.summary,
				tokensBefore: entry.tokensBefore,
				timestamp: entryTime(entry),
			};
			return entry.systemMessage ? [entry.systemMessage, summary] : [summary];
		}
		default:
			return [];
	}
}

/**
 * The compaction-aware entry list of a path (pi buildContextEntries): with a
 * compaction on the path, the latest compaction entry comes first, then the
 * kept entries from its firstKeptEntryId (minus system messages — the
 * compaction's checkpoint replaces them), then everything after it.
 */
export function buildContextEntries(path: readonly SessionEntry[]): SessionEntry[] {
	let compactionIndex = -1;
	for (let i = path.length - 1; i >= 0; i--) {
		if (path[i].type === "compaction") {
			compactionIndex = i;
			break;
		}
	}
	if (compactionIndex < 0) return [...path];
	const compaction = path[compactionIndex];
	if (compaction.type !== "compaction") return [...path];
	const entries: SessionEntry[] = [compaction];
	let foundFirstKept = false;
	for (let i = 0; i < compactionIndex; i++) {
		const entry = path[i];
		if (entry.id === compaction.firstKeptEntryId) foundFirstKept = true;
		if (foundFirstKept && !(entry.type === "message" && entry.message.role === "system")) entries.push(entry);
	}
	entries.push(...path.slice(compactionIndex + 1));
	return entries;
}

export interface ProjectedEntry {
	/** Raw append-only entry that owns this contribution. */
	sourceEntry: SessionEntry;
	/** Model-visible messages after context edits; empty for state-only entries and omissions. */
	messages: AgentMessage[];
}

export interface SessionProjection {
	entries: ProjectedEntry[];
	messages: AgentMessage[];
}

function applyContextEdit(
	messages: AgentMessage[],
	edit: Extract<SessionEntry, { type: "context_edit" }> | undefined,
): AgentMessage[] {
	if (!edit) return messages;
	const replacement = edit.replacement;
	if (replacement === null) return [];
	return messages.map((message) => {
		if (
			message.role !== "user" &&
			message.role !== "assistant" &&
			message.role !== "toolResult" &&
			message.role !== "custom"
		) {
			return message;
		}
		// A string replacement for assistant/toolResult content normalizes to one text block (pi).
		const content =
			(message.role === "assistant" || message.role === "toolResult") && typeof replacement.content === "string"
				? [{ type: "text" as const, text: replacement.content }]
				: replacement.content;
		return { ...message, content } as AgentMessage;
	});
}

/**
 * Provenance-preserving, compaction-aware model context of a path (pi
 * buildSessionProjection). Context edits apply per branch: only edits on the
 * path count, and the latest edit of a target wins.
 */
export function buildSessionProjection(path: readonly SessionEntry[]): SessionProjection {
	const contextEntries = buildContextEntries(path);
	const edits = new Map<string, Extract<SessionEntry, { type: "context_edit" }>>();
	for (const entry of contextEntries) {
		if (entry.type === "context_edit") edits.set(entry.targetId, entry);
	}
	const entries = contextEntries.map(
		(sourceEntry, index): ProjectedEntry => ({
			sourceEntry,
			// An older compaction can be retained when its id lies inside the newest kept
			// range; only the newest one (index 0) contributes a checkpoint and summary.
			messages:
				sourceEntry.type === "compaction" && index > 0
					? []
					: applyContextEdit(sessionEntryToContextMessages(sourceEntry), edits.get(sourceEntry.id)),
		}),
	);
	return { entries, messages: entries.flatMap((entry) => entry.messages) };
}

/**
 * Everything the session was billed for, folded over all entries of every
 * branch (pi getSessionStats / footer): assistant messages, tool results that
 * report usage (e.g. a subagent run), compaction and branch summaries, and
 * `usage` entries. Unlike the context, compaction never makes it smaller (D19).
 */
export function sumSessionUsage(entries: readonly SessionEntry[]): Usage {
	let total = emptyUsage();
	for (const entry of entries) {
		let usage: Usage | undefined;
		if (entry.type === "usage") usage = entry.usage;
		else if (entry.type === "compaction" || entry.type === "branch_summary") usage = entry.usage;
		else if (entry.type === "message") {
			const message = entry.message;
			if (message.role === "assistant") usage = message.usage;
			else if (message.role === "toolResult") usage = message.usage;
		}
		if (usage) total = combineUsage(total, usage);
	}
	return total;
}
