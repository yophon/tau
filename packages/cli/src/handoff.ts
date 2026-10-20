/**
 * /handoff <goal> (P37b), ported from pi's examples/extensions/handoff.ts: instead
 * of compacting (lossy, and it stays in this session), extract what matters for the
 * next task into a prompt that stands on its own, and start a new session with it
 * in the input box. The system prompt and the request are pi's, word for word.
 */
import {
	type AgentMessage,
	compactionSettingsForWindow,
	DEFAULT_COMPACTION_SETTINGS,
	serializeConversation,
} from "@yophon/tau-kernel";

export const HANDOFF_SYSTEM_PROMPT = `You are a context transfer assistant. Given a conversation history and the user's goal for a new thread, generate a focused prompt that:

1. Summarizes relevant context from the conversation (decisions made, approaches taken, key findings)
2. Lists any relevant files that were discussed or modified
3. Clearly states the next task based on the user's goal
4. Is self-contained - the new thread should be able to proceed without the old conversation

Format your response as a prompt the user can send to start the new thread. Be concise but include all necessary context. Do not include any preamble like "Here's the prompt" - just output the prompt itself.

Example output format:
## Context
We've been working on X. Key decisions:
- Decision 1
- Decision 2

Files involved:
- path/to/file1.ts
- path/to/file2.ts

## Task
[Clear description of what to do next based on user's goal]`;

/** The same output cap as a compaction summary: 0.8 × the reserve, which a small context window scales down. */
export function handoffMaxTokens(contextWindow: number | undefined): number {
	return Math.floor(0.8 * compactionSettingsForWindow(DEFAULT_COMPACTION_SETTINGS, contextWindow).reserveTokens);
}

/**
 * pi's request: the conversation (already compaction-aware: the latest summary plus
 * what it kept) and the goal.
 */
export function handoffRequest(messages: readonly AgentMessage[], goal: string): string {
	return `## Conversation History\n\n${serializeConversation(messages)}\n\n## User's Goal for New Thread\n\n${goal}`;
}

export async function generateHandoffPrompt(
	agent: {
		completeText(
			systemPrompt: string,
			prompt: string,
			options?: { maxTokens?: number; signal?: AbortSignal },
		): Promise<string>;
		getContextUsage(): { contextWindow?: number };
	},
	messages: readonly AgentMessage[],
	goal: string,
	signal?: AbortSignal,
): Promise<string> {
	const text = await agent.completeText(HANDOFF_SYSTEM_PROMPT, handoffRequest(messages, goal), {
		maxTokens: handoffMaxTokens(agent.getContextUsage().contextWindow),
		...(signal ? { signal } : {}),
	});
	return text.trim();
}
