import { TauError } from "./errors.ts";
import { type AgentMessage, type AssistantMessage, messageText, type Usage } from "./messages.ts";
import type { ChatTransport } from "./openai.ts";
import type { TauAbortSignal } from "./platform.ts";
import type { SessionEntry } from "./session.ts";

/**
 * Context compaction, ported from pi
 * (packages/agent/src/harness/compaction/compaction.ts + utils.ts): token
 * estimation, cut-point selection, structured summarization prompts (verbatim),
 * iterative summary updates, split-turn handling, file-operation extraction.
 * Deviations: results throw TauError instead of pi's Result type; summarization
 * runs over the agent's ChatTransport (P16) instead of pi's model registry (D3),
 * so summaries use the same model/protocol as the conversation.
 */

export interface CompactionSettings {
	/** Enable automatic compaction decisions. */
	enabled: boolean;
	/** Tokens reserved for summary prompt and output. */
	reserveTokens: number;
	/** Approximate recent-context tokens to keep after compaction. */
	keepRecentTokens: number;
}

export const DEFAULT_COMPACTION_SETTINGS: CompactionSettings = {
	enabled: true,
	reserveTokens: 16384,
	keepRecentTokens: 20000,
};

export interface CompactionResult {
	/** Summary text that replaces compacted history in future context. */
	summary: string;
	/** Entry id where retained history starts ("" for in-memory compaction without a session). */
	firstKeptEntryId: string;
	/** Estimated context tokens before compaction. */
	tokensBefore: number;
	details?: unknown;
}

export interface ContextUsageEstimate {
	tokens: number;
	usageTokens: number;
	trailingTokens: number;
	lastUsageIndex: number | null;
}

export function calculateContextTokens(usage: Usage): number {
	return usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}

function getAssistantUsage(message: AgentMessage): Usage | undefined {
	if (message.role !== "assistant") return undefined;
	if (message.stopReason === "aborted" || message.stopReason === "error") return undefined;
	return calculateContextTokens(message.usage) > 0 ? message.usage : undefined;
}

const ESTIMATED_IMAGE_CHARS = 4800;
const ESTIMATED_IMAGE_TOKENS = ESTIMATED_IMAGE_CHARS / 4;

/**
 * CJK-aware weighted token estimate. Deviation from pi's chars/4 heuristic (P14):
 * mainstream BPE tokenizers emit roughly one token per CJK character, so chars/4
 * undercounts Chinese/Japanese/Korean text 3-4x and delays compaction badly for
 * tau's primary audience. CJK-range characters count 1 token each; everything
 * else keeps pi's chars/4. Single pass, charCodeAt only (bare-engine friendly;
 * surrogate halves fall into the non-CJK bucket, which is fine for an estimate).
 */
export function estimateStringTokens(text: string): number {
	let cjk = 0;
	let other = 0;
	for (let i = 0; i < text.length; i++) {
		const code = text.charCodeAt(i);
		if (
			(code >= 0x3000 && code <= 0x30ff) || // CJK punctuation, hiragana, katakana
			(code >= 0x3400 && code <= 0x4dbf) || // CJK extension A
			(code >= 0x4e00 && code <= 0x9fff) || // CJK unified ideographs
			(code >= 0xac00 && code <= 0xd7af) || // Hangul syllables
			(code >= 0xf900 && code <= 0xfaff) || // CJK compatibility ideographs
			(code >= 0xff00 && code <= 0xffef) // full/half-width forms
		) {
			cjk++;
		} else {
			other++;
		}
	}
	return cjk + Math.ceil(other / 4);
}

function contentTokens(content: string | { type: string; text?: string; data?: string }[]): number {
	if (typeof content === "string") return estimateStringTokens(content);
	let tokens = 0;
	for (const block of content) {
		if (block.type === "text" && block.text) tokens += estimateStringTokens(block.text);
		else if (block.type === "image") tokens += ESTIMATED_IMAGE_TOKENS;
	}
	return tokens;
}

function safeJsonStringify(value: unknown): string {
	try {
		return JSON.stringify(value) ?? "undefined";
	} catch {
		return "[unserializable]";
	}
}

/** Estimate token count for one message (weighted heuristic, see estimateStringTokens). */
export function estimateTokens(message: AgentMessage): number {
	switch (message.role) {
		case "user":
		case "custom":
		case "toolResult":
			return contentTokens(message.content);
		case "assistant": {
			let tokens = 0;
			for (const block of message.content) {
				if (block.type === "text") tokens += estimateStringTokens(block.text);
				else if (block.type === "thinking") tokens += estimateStringTokens(block.thinking);
				else if (block.type === "toolCall")
					tokens += estimateStringTokens(block.name + safeJsonStringify(block.arguments));
			}
			return tokens;
		}
		case "compactionSummary":
		case "branchSummary":
			return estimateStringTokens(message.summary);
	}
}

/** Estimate context tokens: last valid assistant usage + heuristic for trailing messages. */
export function estimateContextTokens(messages: AgentMessage[]): ContextUsageEstimate {
	let usageInfo: { usage: Usage; index: number } | undefined;
	for (let i = messages.length - 1; i >= 0; i--) {
		const usage = getAssistantUsage(messages[i]);
		if (usage) {
			usageInfo = { usage, index: i };
			break;
		}
	}
	if (!usageInfo) {
		let estimated = 0;
		for (const message of messages) estimated += estimateTokens(message);
		return { tokens: estimated, usageTokens: 0, trailingTokens: estimated, lastUsageIndex: null };
	}
	const usageTokens = calculateContextTokens(usageInfo.usage);
	let trailingTokens = 0;
	for (let i = usageInfo.index + 1; i < messages.length; i++) trailingTokens += estimateTokens(messages[i]);
	return { tokens: usageTokens + trailingTokens, usageTokens, trailingTokens, lastUsageIndex: usageInfo.index };
}

export function shouldCompact(contextTokens: number, contextWindow: number, settings: CompactionSettings): boolean {
	if (!settings.enabled) return false;
	return contextTokens > contextWindow - settings.reserveTokens;
}

// ---------------------------------------------------------------------------
// Cut-point selection over session entries (tau's entry subset of pi v3).
// ---------------------------------------------------------------------------

function entryMessage(entry: SessionEntry): AgentMessage | undefined {
	if (entry.type === "message") return entry.message;
	if (entry.type === "branch_summary") {
		return {
			role: "branchSummary",
			summary: entry.summary,
			fromId: entry.fromId,
			timestamp: Date.parse(entry.timestamp) || 0,
		};
	}
	if (entry.type === "custom_message") {
		return {
			role: "custom",
			customType: entry.customType,
			content: entry.content,
			display: entry.display,
			details: entry.details,
			timestamp: Date.parse(entry.timestamp) || 0,
		};
	}
	return undefined;
}

function findValidCutPoints(entries: SessionEntry[], startIndex: number, endIndex: number): number[] {
	const cutPoints: number[] = [];
	for (let i = startIndex; i < endIndex; i++) {
		const entry = entries[i];
		if (entry.type === "message" && entry.message.role !== "toolResult") cutPoints.push(i);
		else if (entry.type === "custom_message" || entry.type === "branch_summary") cutPoints.push(i);
	}
	return cutPoints;
}

/** Find the user-visible message that starts the turn containing an entry. */
export function findTurnStartIndex(entries: SessionEntry[], entryIndex: number, startIndex: number): number {
	for (let i = entryIndex; i >= startIndex; i--) {
		const entry = entries[i];
		if (entry.type === "custom_message" || entry.type === "branch_summary") return i;
		if (entry.type === "message" && entry.message.role === "user") return i;
	}
	return -1;
}

export interface CutPointResult {
	firstKeptEntryIndex: number;
	turnStartIndex: number;
	isSplitTurn: boolean;
}

/** Find the compaction cut point that keeps approximately the requested recent-token budget. */
export function findCutPoint(
	entries: SessionEntry[],
	startIndex: number,
	endIndex: number,
	keepRecentTokens: number,
): CutPointResult {
	const cutPoints = findValidCutPoints(entries, startIndex, endIndex);
	if (cutPoints.length === 0) {
		return { firstKeptEntryIndex: startIndex, turnStartIndex: -1, isSplitTurn: false };
	}
	let accumulatedTokens = 0;
	let cutIndex = cutPoints[0];
	for (let i = endIndex - 1; i >= startIndex; i--) {
		const entry = entries[i];
		if (entry.type !== "message") continue;
		accumulatedTokens += estimateTokens(entry.message);
		if (accumulatedTokens >= keepRecentTokens) {
			for (const candidate of cutPoints) {
				if (candidate >= i) {
					cutIndex = candidate;
					break;
				}
			}
			break;
		}
	}
	while (cutIndex > startIndex) {
		const prevEntry = entries[cutIndex - 1];
		if (prevEntry.type === "compaction" || prevEntry.type === "message") break;
		cutIndex--;
	}
	const cutEntry = entries[cutIndex];
	const isUserMessage = cutEntry.type === "message" && cutEntry.message.role === "user";
	const turnStartIndex = isUserMessage ? -1 : findTurnStartIndex(entries, cutIndex, startIndex);
	return {
		firstKeptEntryIndex: cutIndex,
		turnStartIndex,
		isSplitTurn: !isUserMessage && turnStartIndex !== -1,
	};
}

// ---------------------------------------------------------------------------
// Summarization prompts (verbatim from pi).
// ---------------------------------------------------------------------------

export const SUMMARIZATION_SYSTEM_PROMPT = `You are a context summarization assistant. Your task is to read a conversation between a user and an AI assistant, then produce a structured summary following the exact format specified.

Do NOT continue the conversation. Do NOT respond to any questions in the conversation. ONLY output the structured summary.`;

// Prompts copied verbatim from pi, with one appended rule (P14 deviation): the
// opaque-identifier preservation clause (via yo-agent, originally OpenClaw's
// IDENTIFIER_PRESERVATION) — summaries that shorten UUIDs/hashes/URLs strand the
// agent after compaction. Appears in both SUMMARIZATION and UPDATE prompts.
const SUMMARIZATION_PROMPT = `The messages above are a conversation to summarize. Create a structured context checkpoint summary that another LLM will use to continue the work.

Use this EXACT format:

## Goal
[What is the user trying to accomplish? Can be multiple items if the session covers different tasks.]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned by user]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Ordered list of what should happen next]

## Critical Context
- [Any data, examples, or references needed to continue]
- [Or "(none)" if not applicable]

Keep each section concise. Preserve exact file paths, function names, and error messages.
Preserve all opaque identifiers exactly as written (UUIDs, commit hashes, file paths, URLs, session ids, tokens). Never shorten, reconstruct, or paraphrase them.`;

const UPDATE_SUMMARIZATION_PROMPT = `The messages above are NEW conversation messages to incorporate into the existing summary provided in <previous-summary> tags.

Update the existing structured summary with new information. RULES:
- PRESERVE all existing information from the previous summary
- ADD new progress, decisions, and context from the new messages
- UPDATE the Progress section: move items from "In Progress" to "Done" when completed
- UPDATE "Next Steps" based on what was accomplished
- PRESERVE exact file paths, function names, and error messages
- If something is no longer relevant, you may remove it

Use this EXACT format:

## Goal
[Preserve existing goals, add new ones if the task expanded]

## Constraints & Preferences
- [Preserve existing, add new ones discovered]

## Progress
### Done
- [x] [Include previously done items AND newly completed items]

### In Progress
- [ ] [Current work - update based on progress]

### Blocked
- [Current blockers - remove if resolved]

## Key Decisions
- **[Decision]**: [Brief rationale] (preserve all previous, add new)

## Next Steps
1. [Update based on current state]

## Critical Context
- [Preserve important context, add new if needed]

Keep each section concise. Preserve exact file paths, function names, and error messages.
Preserve all opaque identifiers exactly as written (UUIDs, commit hashes, file paths, URLs, session ids, tokens). Never shorten, reconstruct, or paraphrase them.`;

const TURN_PREFIX_SUMMARIZATION_PROMPT = `This is the PREFIX of a turn that was too large to keep. The SUFFIX (recent work) is retained.

Summarize the prefix to provide context for the retained suffix:

## Original Request
[What did the user ask for in this turn?]

## Early Progress
- [Key decisions and work done in the prefix]

## Context for Suffix
- [Information needed to understand the retained recent work]

Be concise. Focus on what's needed to understand the kept suffix.`;

// ---------------------------------------------------------------------------
// Conversation serialization and file-operation extraction (pi's utils.ts).
// ---------------------------------------------------------------------------

const TOOL_RESULT_MAX_CHARS = 2000;

function truncateForSummary(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	return `${text.slice(0, maxChars)}\n\n[... ${text.length - maxChars} more characters truncated]`;
}

/** Serialize messages to plain text for summarization prompts. */
export function serializeConversation(messages: AgentMessage[]): string {
	const parts: string[] = [];
	for (const message of messages) {
		switch (message.role) {
			case "user":
			case "custom": {
				const content = messageText(message);
				if (content) parts.push(`[User]: ${content}`);
				break;
			}
			case "compactionSummary":
			case "branchSummary":
				parts.push(`[User]: ${message.summary}`);
				break;
			case "assistant": {
				const textParts: string[] = [];
				const thinkingParts: string[] = [];
				const toolCalls: string[] = [];
				for (const block of message.content) {
					if (block.type === "text") textParts.push(block.text);
					else if (block.type === "thinking") thinkingParts.push(block.thinking);
					else if (block.type === "toolCall") {
						const argsStr = Object.entries(block.arguments)
							.map(([k, v]) => `${k}=${safeJsonStringify(v)}`)
							.join(", ");
						toolCalls.push(`${block.name}(${argsStr})`);
					}
				}
				if (thinkingParts.length > 0) parts.push(`[Assistant thinking]: ${thinkingParts.join("\n")}`);
				if (textParts.length > 0) parts.push(`[Assistant]: ${textParts.join("\n")}`);
				if (toolCalls.length > 0) parts.push(`[Assistant tool calls]: ${toolCalls.join("; ")}`);
				break;
			}
			case "toolResult": {
				const content = messageText(message);
				if (content) parts.push(`[Tool result]: ${truncateForSummary(content, TOOL_RESULT_MAX_CHARS)}`);
				break;
			}
		}
	}
	return parts.join("\n\n");
}

export interface FileOperations {
	read: Set<string>;
	written: Set<string>;
	edited: Set<string>;
}

export function extractFileOpsFromMessage(message: AgentMessage, fileOps: FileOperations): void {
	if (message.role !== "assistant") return;
	for (const block of message.content) {
		if (block.type !== "toolCall") continue;
		const path = typeof block.arguments.path === "string" ? block.arguments.path : undefined;
		if (!path) continue;
		if (block.name === "read") fileOps.read.add(path);
		else if (block.name === "write") fileOps.written.add(path);
		else if (block.name === "edit") fileOps.edited.add(path);
	}
}

export function computeFileLists(fileOps: FileOperations): { readFiles: string[]; modifiedFiles: string[] } {
	const modified = new Set([...fileOps.edited, ...fileOps.written]);
	const readFiles = [...fileOps.read].filter((f) => !modified.has(f)).sort();
	return { readFiles, modifiedFiles: [...modified].sort() };
}

export function formatFileOperations(readFiles: string[], modifiedFiles: string[]): string {
	const sections: string[] = [];
	if (readFiles.length > 0) sections.push(`<read-files>\n${readFiles.join("\n")}\n</read-files>`);
	if (modifiedFiles.length > 0) sections.push(`<modified-files>\n${modifiedFiles.join("\n")}\n</modified-files>`);
	return sections.length === 0 ? "" : `\n\n${sections.join("\n\n")}`;
}

// ---------------------------------------------------------------------------
// Preparation and orchestration.
// ---------------------------------------------------------------------------

export interface CompactionPreparation {
	firstKeptEntryId: string;
	messagesToSummarize: AgentMessage[];
	turnPrefixMessages: AgentMessage[];
	isSplitTurn: boolean;
	tokensBefore: number;
	previousSummary?: string;
	fileOps: FileOperations;
	settings: CompactionSettings;
}

/** Prepare session-path entries for compaction; undefined when not applicable. */
export function prepareCompaction(
	pathEntries: SessionEntry[],
	settings: CompactionSettings,
	currentMessages: AgentMessage[],
): CompactionPreparation | undefined {
	if (pathEntries.length === 0 || pathEntries[pathEntries.length - 1].type === "compaction") {
		return undefined;
	}
	let prevCompactionIndex = -1;
	for (let i = pathEntries.length - 1; i >= 0; i--) {
		if (pathEntries[i].type === "compaction") {
			prevCompactionIndex = i;
			break;
		}
	}
	let previousSummary: string | undefined;
	let boundaryStart = 0;
	if (prevCompactionIndex >= 0) {
		const prevCompaction = pathEntries[prevCompactionIndex];
		if (prevCompaction.type === "compaction") {
			previousSummary = prevCompaction.summary;
			const firstKeptEntryIndex = pathEntries.findIndex((entry) => entry.id === prevCompaction.firstKeptEntryId);
			boundaryStart = firstKeptEntryIndex >= 0 ? firstKeptEntryIndex : prevCompactionIndex + 1;
		}
	}
	const boundaryEnd = pathEntries.length;
	const tokensBefore = estimateContextTokens(currentMessages).tokens;

	const cutPoint = findCutPoint(pathEntries, boundaryStart, boundaryEnd, settings.keepRecentTokens);
	const firstKeptEntry = pathEntries[cutPoint.firstKeptEntryIndex];
	if (!firstKeptEntry?.id) return undefined;

	const historyEnd = cutPoint.isSplitTurn ? cutPoint.turnStartIndex : cutPoint.firstKeptEntryIndex;
	const messagesToSummarize: AgentMessage[] = [];
	for (let i = boundaryStart; i < historyEnd; i++) {
		const message = entryMessage(pathEntries[i]);
		if (message) messagesToSummarize.push(message);
	}
	const turnPrefixMessages: AgentMessage[] = [];
	if (cutPoint.isSplitTurn) {
		for (let i = cutPoint.turnStartIndex; i < cutPoint.firstKeptEntryIndex; i++) {
			const message = entryMessage(pathEntries[i]);
			if (message) turnPrefixMessages.push(message);
		}
	}
	const fileOps: FileOperations = { read: new Set(), written: new Set(), edited: new Set() };
	for (const message of messagesToSummarize) extractFileOpsFromMessage(message, fileOps);
	for (const message of turnPrefixMessages) extractFileOpsFromMessage(message, fileOps);

	return {
		firstKeptEntryId: firstKeptEntry.id,
		messagesToSummarize,
		turnPrefixMessages,
		isSplitTurn: cutPoint.isSplitTurn,
		tokensBefore,
		previousSummary,
		fileOps,
		settings,
	};
}

export async function completeText(
	transport: ChatTransport,
	systemPrompt: string,
	promptText: string,
	maxTokens: number,
	signal?: TauAbortSignal,
): Promise<string> {
	const stream = transport({
		systemPrompt,
		messages: [{ role: "user", content: promptText, timestamp: Date.now() }],
		maxTokens,
		signal,
	});
	let final: AssistantMessage | undefined;
	for await (const event of stream) {
		if (event.type === "response_end") final = event.message;
	}
	if (!final) throw new TauError("compaction_failed", "Summarization returned no message");
	return messageText(final);
}

/** Generate or update a conversation summary (pi's generateSummary). */
export async function generateSummary(
	transport: ChatTransport,
	messages: AgentMessage[],
	options: {
		reserveTokens: number;
		customInstructions?: string;
		previousSummary?: string;
		signal?: TauAbortSignal;
	},
): Promise<string> {
	const maxTokens = Math.floor(0.8 * options.reserveTokens);
	let basePrompt = options.previousSummary ? UPDATE_SUMMARIZATION_PROMPT : SUMMARIZATION_PROMPT;
	if (options.customInstructions) {
		basePrompt = `${basePrompt}\n\nAdditional focus: ${options.customInstructions}`;
	}
	let promptText = `<conversation>\n${serializeConversation(messages)}\n</conversation>\n\n`;
	if (options.previousSummary) {
		promptText += `<previous-summary>\n${options.previousSummary}\n</previous-summary>\n\n`;
	}
	promptText += basePrompt;
	return completeText(transport, SUMMARIZATION_SYSTEM_PROMPT, promptText, maxTokens, options.signal);
}

/** Run a prepared compaction: summarize (split-turn aware) and assemble the result. */
export async function runCompaction(
	transport: ChatTransport,
	preparation: CompactionPreparation,
	customInstructions?: string,
	signal?: TauAbortSignal,
): Promise<CompactionResult> {
	const { settings, previousSummary } = preparation;
	let summary: string;
	if (preparation.isSplitTurn && preparation.turnPrefixMessages.length > 0) {
		const historySummary =
			preparation.messagesToSummarize.length > 0
				? await generateSummary(transport, preparation.messagesToSummarize, {
						reserveTokens: settings.reserveTokens,
						customInstructions,
						previousSummary,
						signal,
					})
				: "No prior history.";
		const prefixPrompt = `<conversation>\n${serializeConversation(preparation.turnPrefixMessages)}\n</conversation>\n\n${TURN_PREFIX_SUMMARIZATION_PROMPT}`;
		const turnPrefixSummary = await completeText(
			transport,
			SUMMARIZATION_SYSTEM_PROMPT,
			prefixPrompt,
			Math.floor(0.5 * settings.reserveTokens),
			signal,
		);
		summary = `${historySummary}\n\n---\n\n**Turn Context (split turn):**\n\n${turnPrefixSummary}`;
	} else {
		summary = await generateSummary(transport, preparation.messagesToSummarize, {
			reserveTokens: settings.reserveTokens,
			customInstructions,
			previousSummary,
			signal,
		});
	}
	const { readFiles, modifiedFiles } = computeFileLists(preparation.fileOps);
	summary += formatFileOperations(readFiles, modifiedFiles);
	return {
		summary,
		firstKeptEntryId: preparation.firstKeptEntryId,
		tokensBefore: preparation.tokensBefore,
		details: { readFiles, modifiedFiles },
	};
}
