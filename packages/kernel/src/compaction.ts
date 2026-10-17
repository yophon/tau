import { TauError } from "./errors.ts";
import {
	type AgentMessage,
	type AssistantMessage,
	combineUsage,
	emptyUsage,
	messageText,
	type Usage,
} from "./messages.ts";
import type { ChatTransport } from "./openai.ts";
import type { TauAbortSignal } from "./platform.ts";
import {
	buildSessionProjection,
	getCurrentSystemMessage,
	type ProjectedEntry,
	type SessionProjection,
	sessionEntryToContextMessages,
} from "./projection.ts";
import { type RetryCallbacks, type RetrySettings, retryAssistantCall } from "./retry.ts";
import type { SessionEntry } from "./session.ts";

/**
 * Context compaction, ported from pi 1.2.0
 * (packages/coding-agent/src/core/compaction/compaction.ts + utils.ts; the
 * harness copy lags behind it, P22): token estimation, cut-point selection over
 * the session projection, structured summarization prompts (verbatim),
 * iterative summary updates, split-turn handling, file-operation extraction,
 * summary usage. Deviations: results throw TauError instead of pi's Result
 * type; summarization runs over the agent's ChatTransport (P16) instead of pi's
 * model registry (D3), so summaries use the same model/protocol as the
 * conversation; the two split-turn calls run sequentially (pi used Promise.all
 * until 0.80.4).
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
	/** Entry id where retained history starts. */
	firstKeptEntryId: string;
	/** Estimated context tokens before compaction. */
	tokensBefore: number;
	/** Usage of the summarization call(s) (pi 0.81.0). */
	usage?: Usage;
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
	if (message.stopReason === "aborted" || message.stopReason === "error" || message.stopReason === "pending") {
		return undefined;
	}
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
		case "system": {
			// pi estimateTokens: content, live sections, and the declared tools' JSON.
			let tokens = contentTokens(message.content);
			for (const section of Object.values(message.sections ?? {})) {
				if (section) tokens += estimateStringTokens(section);
			}
			if (message.toolsAdded) tokens += estimateStringTokens(safeJsonStringify(message.toolsAdded));
			return tokens;
		}
	}
}

/** Estimate context tokens: last valid assistant usage + heuristic for trailing messages. */
export function estimateContextTokens(messages: readonly AgentMessage[]): ContextUsageEstimate {
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

/**
 * Estimate the projected context without trusting usage captured before a
 * later context edit or compaction on the branch (pi 1.2.0
 * estimateProjectedContextTokens): the kept tail of a compaction still carries
 * assistant usage from the pre-compaction context, and a /compact right below
 * the threshold would otherwise compact again on the next turn.
 */
export function estimateProjectedContextTokens(
	projection: SessionProjection,
	branchEntries: readonly SessionEntry[],
): ContextUsageEstimate {
	const estimate = estimateContextTokens(projection.messages);
	if (estimate.lastUsageIndex !== null) {
		let projectedMessageIndex = 0;
		let usageEntryId: string | undefined;
		for (const entry of projection.entries) {
			const nextMessageIndex = projectedMessageIndex + entry.messages.length;
			if (estimate.lastUsageIndex < nextMessageIndex) {
				usageEntryId = entry.sourceEntry.id;
				break;
			}
			projectedMessageIndex = nextMessageIndex;
		}
		const usageEntryIndex = usageEntryId ? branchEntries.findIndex((entry) => entry.id === usageEntryId) : -1;
		let latestInvalidatingEntryIndex = -1;
		for (let i = branchEntries.length - 1; i >= 0; i--) {
			const entry = branchEntries[i];
			if (entry.type === "context_edit" || entry.type === "compaction") {
				latestInvalidatingEntryIndex = i;
				break;
			}
		}
		if (usageEntryIndex > latestInvalidatingEntryIndex) return estimate;
	}
	const currentSystem = getCurrentSystemMessage(projection.messages);
	let tokens = currentSystem ? estimateTokens(currentSystem) : 0;
	for (const message of projection.messages) {
		if (message.role !== "system") tokens += estimateTokens(message);
	}
	return { tokens, usageTokens: 0, trailingTokens: tokens, lastUsageIndex: null };
}

/**
 * The settings in effect for a context window. tau deviation: pi applies the
 * configured reserve/keep budgets as they are, which on a small window (local
 * 8K–32K endpoints, which tau recommends) means a summary request before every
 * turn that cannot free enough room. Both budgets are capped at a quarter of the
 * window; from 80K tokens up nothing changes.
 */
export function compactionSettingsForWindow(
	settings: CompactionSettings,
	contextWindow: number | undefined,
): CompactionSettings {
	if (contextWindow === undefined || contextWindow <= 0) return settings;
	const cap = Math.floor(contextWindow / 4);
	return {
		...settings,
		reserveTokens: Math.min(settings.reserveTokens, cap),
		keepRecentTokens: Math.min(settings.keepRecentTokens, cap),
	};
}

export function shouldCompact(contextTokens: number, contextWindow: number, settings: CompactionSettings): boolean {
	if (!settings.enabled) return false;
	return contextTokens > contextWindow - settings.reserveTokens;
}

// ---------------------------------------------------------------------------
// Cut-point selection (pi 1.2.0 coding-agent compaction.ts). Entries count by
// what they contribute to context, so custom messages and branch summaries
// take part in the keep budget and in turn detection.
// ---------------------------------------------------------------------------

function isCutPointMessage(message: AgentMessage): boolean {
	switch (message.role) {
		case "user":
		case "assistant":
		case "custom":
		case "branchSummary":
		case "compactionSummary":
			return true;
		default:
			return false;
	}
}

function isTurnStartMessage(message: AgentMessage): boolean {
	switch (message.role) {
		case "user":
		case "custom":
		case "branchSummary":
		case "compactionSummary":
			return true;
		default:
			return false;
	}
}

function isTurnStartEntry(entry: SessionEntry): boolean {
	if (entry.type === "compaction") return false;
	return sessionEntryToContextMessages(entry).some(isTurnStartMessage);
}

function entryTokens(entry: SessionEntry): number {
	return sessionEntryToContextMessages(entry).reduce((sum, message) => sum + estimateTokens(message), 0);
}

/** Never cut at tool results: they must follow their tool call. */
function findValidCutPoints(entries: readonly SessionEntry[], startIndex: number, endIndex: number): number[] {
	const cutPoints: number[] = [];
	for (let i = startIndex; i < endIndex; i++) {
		const entry = entries[i];
		if (entry.type === "compaction") continue;
		if (sessionEntryToContextMessages(entry).some(isCutPointMessage)) cutPoints.push(i);
	}
	return cutPoints;
}

/** Find the context-visible user-role message that starts the turn containing an entry. */
export function findTurnStartIndex(entries: readonly SessionEntry[], entryIndex: number, startIndex: number): number {
	for (let i = entryIndex; i >= startIndex; i--) {
		if (isTurnStartEntry(entries[i])) return i;
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
	entries: readonly SessionEntry[],
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
		const messageTokens = entryTokens(entries[i]);
		if (messageTokens === 0) continue;
		accumulatedTokens += messageTokens;
		if (accumulatedTokens >= keepRecentTokens) {
			// Prefer the closest valid cut point at or after this entry. If trailing tool
			// results exceed the budget by themselves, keep their preceding assistant tool
			// call instead of falling back to the first message (pi 0.86.0, #9740).
			cutIndex = cutPoints.find((candidate) => candidate >= i) ?? cutPoints[cutPoints.length - 1];
			break;
		}
	}
	while (cutIndex > startIndex) {
		const prevEntry = entries[cutIndex - 1];
		if (prevEntry.type === "compaction" || sessionEntryToContextMessages(prevEntry).length > 0) break;
		cutIndex--;
	}
	const startsTurn = isTurnStartEntry(entries[cutIndex]);
	const turnStartIndex = startsTurn ? -1 : findTurnStartIndex(entries, cutIndex, startIndex);
	return {
		firstKeptEntryIndex: cutIndex,
		turnStartIndex,
		isSplitTurn: !startsTurn && turnStartIndex !== -1,
	};
}

function isProjectedTurnStart(entry: ProjectedEntry): boolean {
	if (entry.sourceEntry.type === "compaction") return false;
	return entry.messages.some(isTurnStartMessage);
}

function findProjectedTurnStartIndex(
	entries: readonly ProjectedEntry[],
	entryIndex: number,
	startIndex: number,
): number {
	for (let i = entryIndex; i >= startIndex; i--) {
		if (isProjectedTurnStart(entries[i])) return i;
	}
	return -1;
}

/**
 * findCutPoint over the session projection (pi findProjectedCutPoint): context
 * edits count, so omitted entries are invisible to the budget.
 */
function findProjectedCutPoint(
	entries: readonly ProjectedEntry[],
	startIndex: number,
	endIndex: number,
	keepRecentTokens: number,
): CutPointResult {
	const cutPoints: number[] = [];
	for (let i = startIndex; i < endIndex; i++) {
		const entry = entries[i];
		if (entry.sourceEntry.type !== "compaction" && entry.messages.some(isCutPointMessage)) cutPoints.push(i);
	}
	if (cutPoints.length === 0) {
		return { firstKeptEntryIndex: startIndex, turnStartIndex: -1, isSplitTurn: false };
	}
	let accumulatedTokens = 0;
	let exceededBudget = false;
	let cutIndex = cutPoints[0];
	for (let i = endIndex - 1; i >= startIndex; i--) {
		const messageTokens = entries[i].messages.reduce((sum, message) => sum + estimateTokens(message), 0);
		if (messageTokens === 0) continue;
		accumulatedTokens += messageTokens;
		if (accumulatedTokens >= keepRecentTokens) {
			exceededBudget = true;
			cutIndex = cutPoints.find((candidate) => candidate >= i) ?? cutPoints[cutPoints.length - 1];
			break;
		}
	}
	// A recovery attempt and its omission edits are context-invisible after the last
	// visible input. Advance only for a closed suffix containing an omitted assistant
	// attempt; arbitrary metadata must not move the cut past unsent input.
	const suffix = entries.slice(cutIndex + 1, endIndex);
	const isIntrinsicallyVisible = (entry: ProjectedEntry): boolean =>
		entry.sourceEntry.type !== "context_edit" && sessionEntryToContextMessages(entry.sourceEntry).length > 0;
	const isOmitted = (entry: ProjectedEntry): boolean => isIntrinsicallyVisible(entry) && entry.messages.length === 0;
	const omittedSuffixIds = new Set(suffix.filter(isOmitted).map((entry) => entry.sourceEntry.id));
	const hasExternalReplacement = suffix.some(
		(entry) =>
			entry.sourceEntry.type === "context_edit" &&
			entry.sourceEntry.replacement !== null &&
			!omittedSuffixIds.has(entry.sourceEntry.targetId),
	);
	const isRecoveryOmissionSuffix =
		exceededBudget &&
		!hasExternalReplacement &&
		suffix.some(
			(entry) =>
				entry.sourceEntry.type === "message" && entry.sourceEntry.message.role === "assistant" && isOmitted(entry),
		) &&
		suffix.every(
			(entry) => entry.sourceEntry.type !== "compaction" && (!isIntrinsicallyVisible(entry) || isOmitted(entry)),
		);
	if (isRecoveryOmissionSuffix) cutIndex++;
	while (cutIndex > startIndex) {
		const previous = entries[cutIndex - 1];
		if (previous.sourceEntry.type === "compaction" || previous.messages.length > 0) break;
		cutIndex--;
	}
	const startsTurn = isProjectedTurnStart(entries[cutIndex]);
	const turnStartIndex = startsTurn ? -1 : findProjectedTurnStartIndex(entries, cutIndex, startIndex);
	return {
		firstKeptEntryIndex: cutIndex,
		turnStartIndex,
		isSplitTurn: !startsTurn && turnStartIndex !== -1,
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

// pi 0.87.1 (#9908): the turn prefix is framed as "earlier context to continue
// from", in # Conversation / # Instructions sections, so models do not refuse it.
const TURN_PREFIX_SUMMARIZATION_PROMPT = `The messages above are earlier context from an ongoing conversation. Later messages are stored separately and do not need to be reconstructed.

Create a concise checkpoint of the user's request and the progress shown above. This checkpoint will be placed before the later messages so the conversation can continue with the necessary context.

## Original Request
[What did the user ask for?]

## Progress So Far
- [Key decisions and work completed in these messages]

## Context Needed to Continue
- [Information from these messages needed to understand the later work]

Only summarize information explicitly present above. Do not infer or recreate later messages.`;

// ---------------------------------------------------------------------------
// Conversation serialization and file-operation extraction (pi's utils.ts).
// ---------------------------------------------------------------------------

const TOOL_RESULT_MAX_CHARS = 2000;

function truncateForSummary(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	return `${text.slice(0, maxChars)}\n\n[... ${text.length - maxChars} more characters truncated]`;
}

/**
 * Serialize messages to plain text for summarization prompts. Thinking is
 * omitted (pi 1.2.0): providers return summaries of the real reasoning and
 * replayed thinking is often not part of the live context, so including it can
 * make the summary request larger than the context it summarizes. System
 * messages are prompt state, not conversation.
 */
export function serializeConversation(messages: readonly AgentMessage[]): string {
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
				const toolCalls: string[] = [];
				for (const block of message.content) {
					if (block.type === "text") textParts.push(block.text);
					else if (block.type === "toolCall") {
						const argsStr = Object.entries(block.arguments)
							.map(([k, v]) => `${k}=${safeJsonStringify(v)}`)
							.join(", ");
						toolCalls.push(`${block.name}(${argsStr})`);
					}
				}
				if (textParts.length > 0) parts.push(`[Assistant]: ${textParts.join("\n")}`);
				if (toolCalls.length > 0) parts.push(`[Assistant tool calls]: ${toolCalls.join("; ")}`);
				break;
			}
			case "toolResult": {
				const content = messageText(message);
				if (content) parts.push(`[Tool result]: ${truncateForSummary(content, TOOL_RESULT_MAX_CHARS)}`);
				break;
			}
			case "system":
				break;
		}
	}
	return parts.join("\n\n");
}

export interface FileOperations {
	read: Set<string>;
	written: Set<string>;
	edited: Set<string>;
}

/**
 * File operations of the tool calls in an assistant message, or of the nested calls
 * recorded on a tool result (pi: calls made from codemode scripts).
 */
export function extractFileOpsFromMessage(message: AgentMessage, fileOps: FileOperations): void {
	if (message.role === "toolResult") {
		for (const call of message.nestedCalls?.calls ?? []) addFileOp(call.name, call.arguments, fileOps);
		return;
	}
	if (message.role !== "assistant") return;
	for (const block of message.content) {
		if (block.type === "toolCall") addFileOp(block.name, block.arguments, fileOps);
	}
}

function addFileOp(toolName: string, args: Record<string, unknown> | undefined, fileOps: FileOperations): void {
	const path = typeof args?.path === "string" ? args.path : undefined;
	if (!path) return;
	if (toolName === "read") fileOps.read.add(path);
	else if (toolName === "write") fileOps.written.add(path);
	else if (toolName === "edit") fileOps.edited.add(path);
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

/** File operations of the messages plus those a previous kernel-made compaction carried forward (pi). */
function extractFileOperations(
	messages: readonly AgentMessage[],
	previousCompaction: SessionEntry | undefined,
): FileOperations {
	const fileOps: FileOperations = { read: new Set(), written: new Set(), edited: new Set() };
	if (previousCompaction?.type === "compaction" && !previousCompaction.fromHook && previousCompaction.details) {
		const details = previousCompaction.details as { readFiles?: unknown; modifiedFiles?: unknown };
		if (Array.isArray(details.readFiles)) {
			for (const file of details.readFiles) if (typeof file === "string") fileOps.read.add(file);
		}
		if (Array.isArray(details.modifiedFiles)) {
			for (const file of details.modifiedFiles) if (typeof file === "string") fileOps.edited.add(file);
		}
	}
	for (const message of messages) extractFileOpsFromMessage(message, fileOps);
	return fileOps;
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

/** System messages are prompt state; the compaction entry checkpoints their replay (pi). */
function messagesForCompaction(entry: ProjectedEntry): AgentMessage[] {
	if (entry.sourceEntry.type === "compaction") return [];
	return entry.messages.filter((message) => message.role !== "system");
}

/**
 * Prepare a path for compaction over its projection (pi 1.2.0
 * prepareCompaction); undefined when there is nothing to summarize — including
 * a tail whose kept budget already covers everything, which used to send an
 * empty summary request every turn (pi 0.86.0 guard).
 */
export function prepareCompaction(
	pathEntries: readonly SessionEntry[],
	settings: CompactionSettings,
): CompactionPreparation | undefined {
	if (pathEntries.length > 0 && pathEntries[pathEntries.length - 1].type === "compaction") return undefined;
	const projection = buildSessionProjection(pathEntries);
	const projectedEntries = projection.entries;
	// The newest compaction is projected first; older ones in its kept range contribute nothing.
	const prevCompactionIndex = projectedEntries.findIndex(
		(entry) => entry.sourceEntry.type === "compaction" && entry.messages.length > 0,
	);
	let previousSummary: string | undefined;
	let boundaryStart = 0;
	const previousCompaction = prevCompactionIndex >= 0 ? projectedEntries[prevCompactionIndex].sourceEntry : undefined;
	if (previousCompaction?.type === "compaction") {
		previousSummary = previousCompaction.summary;
		// The projection has already selected the previous compaction's kept tail.
		boundaryStart = prevCompactionIndex + 1;
	}
	const tokensBefore = estimateProjectedContextTokens(projection, pathEntries).tokens;
	const cutPoint = findProjectedCutPoint(
		projectedEntries,
		boundaryStart,
		projectedEntries.length,
		settings.keepRecentTokens,
	);
	const firstKeptEntry = projectedEntries[cutPoint.firstKeptEntryIndex]?.sourceEntry;
	if (!firstKeptEntry?.id) return undefined;
	const historyEnd = cutPoint.isSplitTurn ? cutPoint.turnStartIndex : cutPoint.firstKeptEntryIndex;
	const messagesToSummarize = projectedEntries.slice(boundaryStart, historyEnd).flatMap(messagesForCompaction);
	const turnPrefixMessages = cutPoint.isSplitTurn
		? projectedEntries.slice(cutPoint.turnStartIndex, cutPoint.firstKeptEntryIndex).flatMap(messagesForCompaction)
		: [];
	if (messagesToSummarize.length === 0 && turnPrefixMessages.length === 0) return undefined;
	const fileOps = extractFileOperations(messagesToSummarize, previousCompaction);
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

/**
 * Retry policy for summarization calls (pi completeSummarization): the agent's
 * RetrySettings, the host sleep (absent = no retry, D15) and progress callbacks.
 */
export interface SummarizationRetry {
	settings: RetrySettings;
	sleep?: (ms: number, signal?: TauAbortSignal) => Promise<void>;
	callbacks?: RetryCallbacks;
}

/**
 * Error text when a summarization response must not be persisted, verbatim from
 * pi 1.2.0: a length stop holds partial text and must not become a session
 * checkpoint — with a reasoning model it may hold no text at all.
 */
export function getSummarizationFailure(response: AssistantMessage, label: string): string | undefined {
	if (response.stopReason === "error") {
		return `${label} failed: ${response.errorMessage || "Unknown error"}`;
	}
	if (response.stopReason === "length") {
		return `${label} failed: generation hit the token cap and the summary is incomplete`;
	}
	return undefined;
}

/** One summarization request as an assistant message: a transport failure becomes stopReason error/aborted. */
async function requestSummary(
	transport: ChatTransport,
	systemPrompt: string,
	promptText: string,
	maxTokens: number,
	signal: TauAbortSignal | undefined,
): Promise<AssistantMessage> {
	const now = Date.now();
	try {
		const stream = transport({
			messages: [
				{ role: "system", content: systemPrompt, timestamp: now },
				{ role: "user", content: promptText, timestamp: now },
			],
			maxTokens,
			signal,
		});
		for await (const event of stream) {
			if (event.type === "response_end") return event.message;
		}
		throw new TauError("stream_error", "Summarization returned no message");
	} catch (error) {
		const failure = error instanceof TauError ? error : new TauError("stream_error", String(error), error);
		return {
			role: "assistant",
			content: [],
			api: "unknown",
			provider: "unknown",
			model: "unknown",
			usage: emptyUsage(),
			stopReason: failure.code === "aborted" || signal?.aborted ? "aborted" : "error",
			errorMessage: error instanceof Error ? error.message : String(error),
			timestamp: now,
		};
	}
}

/**
 * One summarization call (pi completeSummarization + getSummarizationFailure):
 * retried on transient errors, then judged. A truncated or failed summary throws
 * TauError("compaction_failed"); an abort throws TauError("aborted").
 */
export async function completeText(
	transport: ChatTransport,
	systemPrompt: string,
	promptText: string,
	maxTokens: number,
	signal?: TauAbortSignal,
	options?: { label?: string; retry?: SummarizationRetry },
): Promise<{ text: string; usage: Usage }> {
	const retry = options?.retry;
	const response = await retryAssistantCall(
		() => requestSummary(transport, systemPrompt, promptText, maxTokens, signal),
		retry?.settings,
		retry?.sleep,
		signal,
		retry?.callbacks,
	);
	if (response.stopReason === "aborted") throw new TauError("aborted", "Summarization aborted");
	const failure = getSummarizationFailure(response, options?.label ?? "Summarization");
	if (failure) throw new TauError("compaction_failed", failure);
	return { text: messageText(response), usage: response.usage };
}

/** Generate or update a conversation summary and return its usage (pi generateSummaryWithUsage). */
export async function generateSummaryWithUsage(
	transport: ChatTransport,
	messages: readonly AgentMessage[],
	options: {
		reserveTokens: number;
		customInstructions?: string;
		previousSummary?: string;
		signal?: TauAbortSignal;
		retry?: SummarizationRetry;
	},
): Promise<{ text: string; usage: Usage }> {
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
	return completeText(transport, SUMMARIZATION_SYSTEM_PROMPT, promptText, maxTokens, options.signal, {
		label: "Summarization",
		retry: options.retry,
	});
}

/** Generate or update a conversation summary (pi's generateSummary). */
export async function generateSummary(
	transport: ChatTransport,
	messages: readonly AgentMessage[],
	options: {
		reserveTokens: number;
		customInstructions?: string;
		previousSummary?: string;
		signal?: TauAbortSignal;
	},
): Promise<string> {
	return (await generateSummaryWithUsage(transport, messages, options)).text;
}

/**
 * Run a prepared compaction: summarize (split-turn aware, sequential calls) and
 * assemble the result. The usage of every summarization call is summed into
 * `usage` (pi 0.81.0, D19). Without history before a split turn, the previous
 * summary carries over instead of being replaced by "No prior history." (pi 0.86.0).
 */
export async function runCompaction(
	transport: ChatTransport,
	preparation: CompactionPreparation,
	customInstructions?: string,
	signal?: TauAbortSignal,
	retry?: SummarizationRetry,
): Promise<CompactionResult> {
	const { settings, previousSummary } = preparation;
	let summary: string;
	let usage: Usage;
	if (preparation.isSplitTurn && preparation.turnPrefixMessages.length > 0) {
		let historyText = previousSummary ?? "No prior history.";
		let historyUsage: Usage | undefined;
		if (preparation.messagesToSummarize.length > 0) {
			const history = await generateSummaryWithUsage(transport, preparation.messagesToSummarize, {
				reserveTokens: settings.reserveTokens,
				customInstructions,
				previousSummary,
				signal,
				retry,
			});
			historyText = history.text;
			historyUsage = history.usage;
		}
		const prefixPrompt = `# Conversation\n${serializeConversation(preparation.turnPrefixMessages)}\n\n# Instructions\n${TURN_PREFIX_SUMMARIZATION_PROMPT}`;
		const turnPrefix = await completeText(
			transport,
			SUMMARIZATION_SYSTEM_PROMPT,
			prefixPrompt,
			Math.floor(0.5 * settings.reserveTokens),
			signal,
			{ label: "Turn prefix summarization", retry },
		);
		summary = `${historyText}\n\n---\n\n**Turn Context (split turn):**\n\n${turnPrefix.text}`;
		usage = historyUsage ? combineUsage(historyUsage, turnPrefix.usage) : turnPrefix.usage;
	} else {
		const result = await generateSummaryWithUsage(transport, preparation.messagesToSummarize, {
			reserveTokens: settings.reserveTokens,
			customInstructions,
			previousSummary,
			signal,
			retry,
		});
		summary = result.text;
		usage = result.usage;
	}
	const { readFiles, modifiedFiles } = computeFileLists(preparation.fileOps);
	summary += formatFileOperations(readFiles, modifiedFiles);
	return {
		summary,
		firstKeptEntryId: preparation.firstKeptEntryId,
		tokensBefore: preparation.tokensBefore,
		usage,
		details: { readFiles, modifiedFiles },
	};
}
