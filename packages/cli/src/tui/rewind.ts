// /rewind (P55c, Claude Code): pick one of your messages, then restore the code (the files the
// file tools changed since, from the checkpoint package), the conversation (back to before that
// message, its text in the input box — /tree's move), or both. Bash changes are not tracked.
import type { CheckpointInfo } from "@yophon/tau-ext-checkpoint";
import { messageText } from "@yophon/tau-kernel";
import type { CommandHost } from "./commands.ts";
import { errorText, firstLine } from "./format.ts";

type RewindHost = Pick<CommandHost, "agent" | "notice" | "options" | "pick" | "runs">;

/** The files changed since each checkpoint began (that one and every later one). */
function filesSince(checkpoints: readonly CheckpointInfo[]): Map<string, number> {
	const counts = new Map<string, number>();
	const seen = new Set<string>();
	for (let i = checkpoints.length - 1; i >= 0; i--) {
		const checkpoint = checkpoints[i] as CheckpointInfo;
		for (const file of checkpoint.files) seen.add(file.path);
		counts.set(checkpoint.id, seen.size);
	}
	return counts;
}

export async function runRewind(tui: RewindHost): Promise<void> {
	const context = tui.agent.extensionContext();
	const session = context.sessionManager;
	if (!session) {
		tui.notice("error", "No active session.");
		return;
	}
	const backend = tui.options.checkpoints?.(session.getSessionId(), context.capabilities?.fs);
	const checkpoints = backend ? await backend.list() : [];
	const changed = filesSince(checkpoints);
	// Your messages on this branch, newest first.
	const messages = session
		.getBranch()
		.flatMap((entry) => (entry.type === "message" && entry.message.role === "user" ? [entry] : []))
		.reverse();
	if (messages.length === 0) {
		tui.notice("dim", "Nothing to rewind to yet.");
		return;
	}
	const picked = await tui.pick(
		"Rewind to before",
		messages.map((entry) => {
			const files = changed.get(entry.id);
			return {
				label: firstLine(messageText(entry.message), 70),
				hint:
					files === undefined
						? "no checkpoint"
						: files === 0
							? "no file changes since"
							: `${files} file${files === 1 ? "" : "s"} changed since`,
				value: entry.id,
			};
		}),
	);
	if (picked === undefined) return;
	const hasCheckpoint = changed.has(picked);
	const choice = await tui.pick("Restore", [
		...(hasCheckpoint ? [{ label: "Restore code and conversation", value: "both" }] : []),
		{ label: "Restore conversation", value: "conversation" },
		...(hasCheckpoint ? [{ label: "Restore code", value: "code" }] : []),
		{ label: "Never mind", value: "cancel" },
	]);
	if (choice === undefined || choice === "cancel") return;
	let restored: string | undefined;
	if ((choice === "both" || choice === "code") && backend) {
		try {
			const result = await backend.restore(picked);
			const total = result.restored.length + result.deleted.length;
			restored =
				total === 0
					? "No files to restore (only changes made with write, edit and apply_patch are tracked)."
					: `Restored ${total} file${total === 1 ? "" : "s"}${result.deleted.length > 0 ? ` (${result.deleted.length} created since, deleted)` : ""}. Changes made through bash are not tracked.`;
		} catch (error) {
			tui.notice("error", `Restoring the code failed: ${errorText(error)}`);
			return;
		}
	}
	if (choice === "both" || choice === "conversation") await tui.runs.navigate(picked, { summarize: false });
	// After the move, which redraws the session.
	if (restored) tui.notice("info", restored);
}
