import {
	completeText,
	computeFileLists,
	estimateTokens,
	extractFileOpsFromMessage,
	type FileOperations,
	formatFileOperations,
	SUMMARIZATION_SYSTEM_PROMPT,
	serializeConversation,
} from "./compaction.ts";
import { SessionError } from "./errors.ts";
import type { AgentMessage } from "./messages.ts";
import type { OpenAICompatConfig } from "./openai.ts";
import type { Platform, TauAbortSignal } from "./platform.ts";
import type { SessionEntry, SessionStore } from "./session.ts";

/**
 * Branch summarization for session-tree navigation, ported from pi
 * (packages/agent/src/harness/compaction/branch-summarization.ts): collecting
 * the entries a navigation abandons, budgeted message selection with nested
 * summary handling, and the structured summary prompt (verbatim). Deviations:
 * errors throw (TauError/SessionError) instead of pi's Result type, and
 * summarization runs over tau's OpenAICompatConfig (D3), as in compaction.ts.
 */

/** File-operation details stored on generated branch summary entries. */
export interface BranchSummaryDetails {
	/** Files read while exploring the summarized branch. */
	readFiles: string[];
	/** Files modified while exploring the summarized branch. */
	modifiedFiles: string[];
}

/** Prepared branch content for summarization. */
export interface BranchPreparation {
	/** Messages selected for the branch summary. */
	messages: AgentMessage[];
	/** File operations extracted from the branch. */
	fileOps: FileOperations;
	/** Estimated token count for selected messages. */
	totalTokens: number;
}

/** Entries selected for branch summarization. */
export interface CollectEntriesResult {
	/** Entries to summarize in chronological order. */
	entries: SessionEntry[];
	/** Deepest common ancestor between the previous leaf and target entry. */
	commonAncestorId: string | null;
}

export interface BranchSummaryResult {
	summary: string;
	readFiles: string[];
	modifiedFiles: string[];
}

export interface GenerateBranchSummaryOptions {
	signal?: TauAbortSignal;
	/** Optional instructions appended to or replacing the default prompt. */
	customInstructions?: string;
	/** Replace the default prompt with custom instructions instead of appending them. */
	replaceInstructions?: boolean;
	/** Tokens reserved for prompt and model output. Defaults to 16384. */
	reserveTokens?: number;
}

/** Collect entries that should be summarized before navigating to a different session tree entry. */
export async function collectEntriesForBranchSummary(
	store: SessionStore,
	oldLeafId: string | null,
	targetId: string,
): Promise<CollectEntriesResult> {
	if (!oldLeafId) {
		return { entries: [], commonAncestorId: null };
	}
	const oldPath = new Set((await store.getPathToRoot(oldLeafId)).map((entry) => entry.id));
	const targetPath = await store.getPathToRoot(targetId);
	let commonAncestorId: string | null = null;
	for (let i = targetPath.length - 1; i >= 0; i--) {
		if (oldPath.has(targetPath[i].id)) {
			commonAncestorId = targetPath[i].id;
			break;
		}
	}
	const entries: SessionEntry[] = [];
	let current: string | null = oldLeafId;
	while (current && current !== commonAncestorId) {
		const entry = await store.getEntry(current);
		if (!entry) throw new SessionError("invalid_session", `Entry ${current} not found`);
		entries.push(entry);
		current = entry.parentId;
	}
	entries.reverse();
	return { entries, commonAncestorId };
}

function getMessageFromEntry(entry: SessionEntry): AgentMessage | undefined {
	switch (entry.type) {
		case "message":
			if (entry.message.role === "toolResult") return undefined;
			return entry.message;
		case "custom_message":
			return {
				role: "custom",
				customType: entry.customType,
				content: entry.content,
				display: entry.display,
				details: entry.details,
				timestamp: Date.parse(entry.timestamp) || 0,
			};
		case "branch_summary":
			return {
				role: "branchSummary",
				summary: entry.summary,
				fromId: entry.fromId,
				timestamp: Date.parse(entry.timestamp) || 0,
			};
		case "compaction":
			return {
				role: "compactionSummary",
				summary: entry.summary,
				tokensBefore: entry.tokensBefore,
				timestamp: Date.parse(entry.timestamp) || 0,
			};
		case "custom":
		case "session_info":
		case "leaf":
			return undefined;
	}
}

/** Prepare branch entries for summarization within an optional token budget. */
export function prepareBranchEntries(entries: SessionEntry[], tokenBudget = 0): BranchPreparation {
	const messages: AgentMessage[] = [];
	const fileOps: FileOperations = { read: new Set(), written: new Set(), edited: new Set() };
	let totalTokens = 0;
	// Nested branch summaries carry their branch's file lists; inherit them.
	for (const entry of entries) {
		if (entry.type === "branch_summary" && !entry.fromHook && entry.details) {
			const details = entry.details as BranchSummaryDetails;
			if (Array.isArray(details.readFiles)) {
				for (const file of details.readFiles) fileOps.read.add(file);
			}
			if (Array.isArray(details.modifiedFiles)) {
				for (const file of details.modifiedFiles) fileOps.edited.add(file);
			}
		}
	}
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		const message = getMessageFromEntry(entry);
		if (!message) continue;
		extractFileOpsFromMessage(message, fileOps);

		const tokens = estimateTokens(message);
		if (tokenBudget > 0 && totalTokens + tokens > tokenBudget) {
			// Over budget: still take a compaction/branch summary if we are under
			// 90% of the budget — it stands in for everything before it.
			if (entry.type === "compaction" || entry.type === "branch_summary") {
				if (totalTokens < tokenBudget * 0.9) {
					messages.unshift(message);
					totalTokens += tokens;
				}
			}
			break;
		}

		messages.unshift(message);
		totalTokens += tokens;
	}

	return { messages, fileOps, totalTokens };
}

/** Prefix prepended to generated branch summaries (verbatim from pi). */
export const BRANCH_SUMMARY_PREAMBLE = `The user explored a different conversation branch before returning here.
Summary of that exploration:

`;

const BRANCH_SUMMARY_PROMPT = `Create a structured summary of this conversation branch for context when returning later.

Use this EXACT format:

## Goal
[What was the user trying to accomplish in this branch?]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Work that was started but not finished]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [What should happen next to continue this work]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

/** Generate a summary for abandoned branch entries (pi's generateBranchSummary). */
export async function generateBranchSummary(
	platform: Platform,
	config: OpenAICompatConfig,
	entries: SessionEntry[],
	options?: GenerateBranchSummaryOptions,
): Promise<BranchSummaryResult> {
	const reserveTokens = options?.reserveTokens ?? 16384;
	const contextWindow = config.contextWindow || 128000;
	const tokenBudget = contextWindow - reserveTokens;

	const { messages, fileOps } = prepareBranchEntries(entries, tokenBudget);
	if (messages.length === 0) {
		return { summary: "No content to summarize", readFiles: [], modifiedFiles: [] };
	}
	const conversationText = serializeConversation(messages);
	let instructions: string;
	if (options?.replaceInstructions && options.customInstructions) {
		instructions = options.customInstructions;
	} else if (options?.customInstructions) {
		instructions = `${BRANCH_SUMMARY_PROMPT}\n\nAdditional focus: ${options.customInstructions}`;
	} else {
		instructions = BRANCH_SUMMARY_PROMPT;
	}
	const promptText = `<conversation>\n${conversationText}\n</conversation>\n\n${instructions}`;

	let summary = await completeText(platform, config, SUMMARIZATION_SYSTEM_PROMPT, promptText, 2048, options?.signal);
	summary = BRANCH_SUMMARY_PREAMBLE + summary;
	const { readFiles, modifiedFiles } = computeFileLists(fileOps);
	summary += formatFileOperations(readFiles, modifiedFiles);

	return { summary: summary || "No summary generated", readFiles, modifiedFiles };
}
