/**
 * Session titles (P34f): sessions are listed by name, else by the first message
 * (pi's session list), and after the first turn the model names the session in
 * the background (Claude Code). The title is a session_info entry, as /name
 * writes, so pi reads it too; a name the user gave is never replaced.
 */
import type { Agent, AgentMessage, SessionMetadata, SessionRecorder } from "@yophon/tau-kernel";

export const TITLE_SYSTEM_PROMPT =
	"You name conversations. Reply with only a title for the conversation you are shown: in the language the user writes in, at most 12 characters for Chinese, Japanese or Korean, otherwise at most 6 words. No quotes, no trailing punctuation, nothing else.";

/** settings session.autoTitle, overridden by TAU_AUTO_TITLE=0/1 (scripts and tests that count requests). */
export function autoTitleOn(
	setting: boolean | undefined,
	env: string | undefined = process.env.TAU_AUTO_TITLE,
): boolean {
	if (env === "0" || env === "false") return false;
	if (env === "1" || env === "true") return true;
	return setting !== false;
}

/** Characters a title keeps at most. */
export const TITLE_MAX = 40;

/** The model's reply as a title: its first non-empty line, unquoted, without end punctuation; undefined if nothing is left. */
export function titleFromReply(text: string): string | undefined {
	const line = text
		.split("\n")
		.map((part) => part.trim())
		.find((part) => part !== "");
	if (!line) return undefined;
	let title = line
		.replace(/^(?:title|标题)\s*[:：]\s*/i, "")
		.replace(/^["'“”‘’「」『』《》`*_]+|["'“”‘’「」『』《》`*_]+$/g, "")
		.replace(/[.。!！?？,，;；:：、…]+$/u, "")
		.trim();
	if ([...title].length > TITLE_MAX) title = `${[...title].slice(0, TITLE_MAX - 1).join("")}…`;
	return title === "" ? undefined : title;
}

/** How a session is listed: its name, else the first line of its first message. */
export function sessionLabel(session: SessionMetadata): string {
	if (session.name) return session.name;
	const first = session.firstMessage
		?.split("\n")
		.map((line) => line.trim())
		.find((line) => line !== "");
	return first ?? "(empty)";
}

/** "just now", "5 min ago", "3 h ago", "yesterday", "4 days ago", or the date after a week. */
export function relativeTime(iso: string, now: Date = new Date()): string {
	const then = new Date(iso);
	const ms = now.getTime() - then.getTime();
	if (Number.isNaN(ms)) return iso;
	const minutes = Math.floor(ms / 60_000);
	if (minutes < 1) return "just now";
	if (minutes < 60) return `${minutes} min ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours} h ago`;
	const day = (date: Date) => Math.floor((date.getTime() - date.getTimezoneOffset() * 60_000) / 86_400_000);
	const days = day(now) - day(then);
	if (days <= 1) return "yesterday";
	if (days < 7) return `${days} days ago`;
	return then.toISOString().slice(0, 10);
}

function textOf(message: AgentMessage): string {
	if (message.role !== "user" && message.role !== "assistant") return "";
	const content = message.content;
	if (typeof content === "string") return content;
	return content
		.filter((part): part is { type: "text"; text: string } => part.type === "text")
		.map((part) => part.text)
		.join(" ");
}

/** What the title request shows the model: the first message and the start of the first answer. */
export function titlePrompt(messages: readonly AgentMessage[]): string | undefined {
	const user = messages.find((message) => message.role === "user" && textOf(message).trim() !== "");
	const answer = messages.find((message) => message.role === "assistant" && textOf(message).trim() !== "");
	if (!user || !answer) return undefined;
	return `<user>\n${textOf(user).trim().slice(0, 2000)}\n</user>\n<assistant>\n${textOf(answer).trim().slice(0, 500)}\n</assistant>`;
}

/**
 * Name the session after its first turn if it has no name yet: one small request, once
 * per session (`attempted` holds the session ids already tried). Returns the title set,
 * or undefined (nothing to do, or the request failed — failures are only logged).
 */
export async function autoTitle(
	agent: Agent,
	recorder: SessionRecorder,
	attempted: Set<string>,
	log: (message: string) => void = () => undefined,
): Promise<string | undefined> {
	const metadata = await recorder.store.getMetadata();
	if (attempted.has(metadata.id) || metadata.name) return undefined;
	const prompt = titlePrompt(agent.messages);
	if (prompt === undefined) return undefined;
	attempted.add(metadata.id);
	try {
		const title = titleFromReply(await agent.completeText(TITLE_SYSTEM_PROMPT, prompt, { maxTokens: 200 }));
		if (!title) return undefined;
		// The user may have named it while the request ran.
		if ((await recorder.store.getMetadata()).name) return undefined;
		// Through the agent: in turn with its own writes (a prompt saved meanwhile, P58).
		await agent.setSessionName(title);
		return title;
	} catch (error) {
		log(`session title: ${error instanceof Error ? error.message : String(error)}`);
		return undefined;
	}
}

/** A session by id, time, name, file or title: exact, then prefix, then (P34f) a piece of its title. */
export function findSession(sessions: SessionMetadata[], selector: string): SessionMetadata | "ambiguous" | undefined {
	const values = (session: SessionMetadata): string[] => {
		const fileName = session.filePath?.split(/[\\/]/).at(-1);
		return [session.id, session.timestamp, session.name, sessionLabel(session), session.filePath, fileName].filter(
			(value): value is string => value !== undefined && value !== "",
		);
	};
	const needle = selector.toLowerCase();
	const tiers: Array<(value: string) => boolean> = [
		(value) => value === selector,
		(value) => value.startsWith(selector),
		(value) => value.toLowerCase().includes(needle),
	];
	for (const test of tiers) {
		const found = sessions.filter((session) => values(session).some(test));
		if (found.length === 1) return found[0];
		if (found.length > 1) return "ambiguous";
	}
	return undefined;
}
