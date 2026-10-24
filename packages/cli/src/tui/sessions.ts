// Session switches in the TUI (P50: split out of controller.ts): moving to another session
// (/new, /resume, /fork, /clone, /tree's branches) and drawing it again, reloading extensions
// (/reload, P46 moves), /model and /thinking. P57: the hub does the switching (its extensions may
// refuse, and they move with the TUI to the next session); this draws the result.
import type { ThinkingLevel } from "@yophon/tau-kernel";
import { type ClientRequests, ERROR_CODES, type JsonRpcError } from "@yophon/tau-protocol";
import type { TuiController } from "./controller.ts";
import { conversationLength, errorText } from "./format.ts";
import type { TuiInputBox } from "./input-box.ts";
import { messagesToBlocks } from "./replay.ts";
import type { TuiRuns } from "./runs.ts";

/** What session switches use from the controller and the other parts (P51). */
export type SessionsHost = Pick<
	TuiController,
	| "checkShortcuts"
	| "clearScreen"
	| "dispatch"
	| "loadKeybindings"
	| "model"
	| "notice"
	| "refreshStatus"
	| "refreshSurfaces"
	| "session"
	| "state"
	| "thinkingLevel"
> & {
	readonly inputBox: Pick<TuiInputBox, "menuCache">;
	readonly runs: Pick<TuiRuns, "markCustomShown" | "runJob" | "prefetchReplay">;
};

/** How the TUI moves to a session: a new one, a saved one, a file, a copy of this one. */
export type SessionMove =
	| { kind: "new"; parentSession?: string }
	| { kind: "resume"; threadId: string }
	| { kind: "import"; path: string }
	| { kind: "fork"; entryId?: string; position?: "before" | "at" };

export type SwitchResult =
	| { cancelled: true; by: "switch" | "fork" }
	| { cancelled: false; name?: string; id: string; messageCount: number };

export class TuiSessions {
	private readonly host: SessionsHost;

	constructor(host: SessionsHost) {
		this.host = host;
	}

	/** A fresh screen with the current conversation, then a note. */
	showSession(note: string): void {
		this.host.clearScreen();
		this.host.dispatch({ type: "reset" });
		this.host.dispatch({ type: "replay", blocks: messagesToBlocks(this.host.session.messages) });
		this.host.runs.markCustomShown();
		this.host.notice("dim", note);
	}

	/** Move to another session; the extensions of this one may refuse (session_before_switch, session_before_fork). */
	async switchSession(move: SessionMove): Promise<SwitchResult> {
		const { session } = this.host;
		const previousThreadId = session.id;
		const previousModel = this.host.model;
		try {
			if (move.kind === "new") {
				await session.join("thread/start", {
					previousThreadId,
					...(move.parentSession !== undefined ? { parentSession: move.parentSession } : {}),
				});
			} else if (move.kind === "resume") {
				await session.join("thread/resume", { threadId: move.threadId, previousThreadId, ...session.where() });
			} else if (move.kind === "import") {
				await session.join("thread/import", { path: move.path, copy: true, previousThreadId, ...session.where() });
			} else {
				const params: ClientRequests["thread/fork"]["params"] = {
					threadId: previousThreadId,
					...(move.entryId !== undefined ? { entryId: move.entryId } : {}),
					...(move.position !== undefined ? { position: move.position } : {}),
				};
				await session.join("thread/fork", params);
			}
		} catch (error) {
			if ((error as JsonRpcError).code === ERROR_CODES.cancelled) {
				const by = ((error as JsonRpcError).data as { by?: string } | undefined)?.by === "fork" ? "fork" : "switch";
				return { cancelled: true, by };
			}
			throw error;
		}
		this.host.inputBox.menuCache = undefined;
		this.host.checkShortcuts();
		await this.host.runs.prefetchReplay();
		const name = session.state.name;
		const messageCount = conversationLength(session.messages);
		const label = name ? `"${name}"` : `session ${session.id.slice(0, 8)}`;
		this.showSession(
			move.kind === "new"
				? "New session."
				: `${move.kind === "fork" ? "Forked to" : "Resumed"} ${label} (${messageCount} messages).`,
		);
		await this.host.refreshSurfaces();
		// A resumed session went back to its last model (pi, P28): say so as /model does.
		if (this.host.model !== previousModel) this.host.notice("dim", `Model set to ${this.host.model}.`);
		return { cancelled: false, id: session.id, messageCount, ...(name ? { name } : {}) };
	}

	async reloadExtensions(): Promise<void> {
		if (this.host.state.task !== undefined) {
			this.host.notice("dim", "Reload is unavailable while a task is running.");
			return;
		}
		// pi reads keybindings.json again on /reload too (P39e).
		this.host.loadKeybindings();
		try {
			// How it went comes with the job's end (runs.ts), as for a reload the hub starts itself (P46).
			await this.host.runs.runJob("reload", "Reloading extensions", () =>
				this.host.session.request("thread/reload", {}),
			);
			await this.host.session.refreshCommands();
			this.host.inputBox.menuCache = undefined;
			this.host.checkShortcuts();
		} catch (error) {
			// Refused before it began (another job runs): nothing else said so.
			if ((error as JsonRpcError).code === ERROR_CODES.busy) this.host.notice("error", errorText(error));
		}
	}

	async switchModel(requested: string): Promise<void> {
		try {
			const result = await this.host.session.request("thread/setModel", { model: requested });
			if (result.cancelled) {
				this.host.notice(
					"dim",
					`Model switch cancelled${result.cancelled.reason ? `: ${result.cancelled.reason}` : "."}`,
				);
				return;
			}
			await this.host.session.drain();
			await this.host.refreshStatus();
			this.host.notice("dim", `Model set to ${result.model ?? requested}.`);
		} catch (error) {
			this.host.notice("error", errorText(error));
		}
	}

	async switchThinking(requested: ThinkingLevel | undefined): Promise<void> {
		try {
			const result = await this.host.session.request(
				"thread/setThinking",
				requested !== undefined ? { level: requested } : {},
			);
			if (result.cancelled) {
				this.host.notice(
					"dim",
					`Thinking level switch cancelled${result.cancelled.reason ? `: ${result.cancelled.reason}` : "."}`,
				);
				return;
			}
			await this.host.session.drain();
			await this.host.refreshStatus();
			this.host.notice("dim", `Thinking level set to ${result.level ?? "default"}.`);
		} catch (error) {
			this.host.notice("error", errorText(error));
		}
	}
}

export function unique(values: string[]): string[] {
	return [...new Set(values.filter((value) => value !== ""))];
}
