// Runs in the TUI (P50: split out of controller.ts): submitting the input, the queue of
// steering, follow-ups and commands typed mid-turn (P38c), one task at a time (a turn, a
// compaction, a `!` command, a navigation), the session's events and drawing its messages, and
// extension shortcuts. P57: the session lives in the hub — turns and jobs (this TUI's or another
// client's) arrive as notifications, renderers answer requests.
import type {
	AgentEvent,
	AgentMessage,
	AssistantMessage,
	CustomMessage,
	RegisteredToolRenderEvent,
	Usage,
	UserContent,
} from "@yophon/tau-kernel";
import { userContentText } from "@yophon/tau-kernel";
import type { CommandOutcome, TaskKind as HubTaskKind, NativeMessage, Rendered } from "@yophon/tau-protocol";
import type { CommandHost } from "./commands.ts";
import { runCommand, whenCommandRuns } from "./commands.ts";
import type { TuiController } from "./controller.ts";
import type { TuiDialogs } from "./dialogs.ts";
import { renderedLines } from "./extensions.ts";
import { conversationLength, errorText, firstLine, fmtCost, fmtElapsed, fmtInt } from "./format.ts";
import * as ed from "./input/editor.ts";
import { expandPastes } from "./input/paste.ts";
import type { TuiInputBox } from "./input-box.ts";
import { type PendingInput, queuedInput } from "./input-box.ts";
import { diagnosticsBlock, type TaskKind } from "./model.ts";
import { markdownTransformsChanged } from "./render/markdown.ts";
import type { StyledLine } from "./render/spans.ts";
import { type MarkdownKind, type SessionNotification, usageOf } from "./session-client.ts";
import type { TuiSessions } from "./sessions.ts";

/** What runs use from the controller and the other parts (P51). Runs execute commands, so they need all a command may use. */
export type RunsHost = CommandHost &
	Pick<
		TuiController,
		| "attention"
		| "columns"
		| "dispatch"
		| "now"
		| "refreshStatus"
		| "refreshWidgets"
		| "setEditor"
		| "setInput"
		| "stopped"
		| "terminalStatus"
		| "turnFailed"
	> & {
		readonly dialogs: Pick<
			TuiDialogs,
			"closePrompt" | "dismissRequest" | "nextDialogId" | "settleOpenApprovals" | "settlePrompt"
		>;
		readonly inputBox: Pick<
			TuiInputBox,
			| "files"
			| "filesEpoch"
			| "forgetEdits"
			| "history"
			| "historyIndex"
			| "pastes"
			| "restoreQueuedInput"
			| "takeInput"
		>;
		readonly sessions: Pick<TuiSessions, "reloadExtensions" | "showSession">;
	};

/** The tool calls Ctrl+B can move to the background while they run. */
const COMMAND_TOOLS = new Set(["bash", "powershell"]);

export class TuiRuns {
	private readonly host: RunsHost;

	constructor(host: RunsHost) {
		this.host = host;
	}

	/** Prompts asked for at start (command-line prompts): started one after another (P36c). */
	readonly pendingStarts: UserContent[] = [];

	/**
	 * Custom messages already drawn (by content key). One that arrives between runs
	 * (a background subagent's result) is drawn before the next run; counting
	 * messages instead races with a result landing while a turn wraps up.
	 */
	private readonly shownCustom = new Set<string>();

	private readonly toolOutput = new Map<string, string>();

	/** The bash and PowerShell calls running now (Ctrl+B moves them to the background). */
	readonly runningCommands = new Set<string>();

	/** The turn shown now: when it began and what had been used by then (the "Worked for" line). */
	private turn: { id?: string; startedAt: number; before: Usage | undefined; failure?: string } | undefined;

	/** Prompts this TUI sent, by turn id: settled when the turn ends. */
	private readonly turnWaiters = new Map<string, () => void>();

	/** The hub said a job of ours started (a job it refused never does). */
	private hubTask: HubTaskKind | undefined;

	submit(): void {
		// Sending something brings the full-screen view back to the end.
		if (this.host.state.scroll.top !== undefined) this.host.dispatch({ type: "scroll" });
		const raw = this.host.state.editor.text;
		// A trailing backslash continues the line (Claude Code habit).
		if (raw.endsWith("\\")) {
			this.host.setEditor(ed.fromText(`${raw.slice(0, -1)}\n`));
			return;
		}
		const prompt = this.host.state.prompt;
		if (prompt) {
			const text = expandPastes(this.host.inputBox.pastes, this.host.state.editor.text).trim();
			if (text === "" && prompt.kind === "tell") return;
			this.host.inputBox.forgetEdits();
			this.host.dialogs.closePrompt(prompt.id);
			this.host.dialogs.settlePrompt(prompt.id, text === "" ? undefined : text);
			return;
		}
		const text = this.host.inputBox.takeInput();
		if (text === "") return;
		this.host.inputBox.history.push(text);
		this.host.inputBox.historyIndex = this.host.inputBox.history.list().length;
		const task = this.host.state.task;
		if (task === undefined && (text === "exit" || text === "quit")) {
			void this.host.stop();
			return;
		}
		if (text.startsWith("/")) {
			// While a task works, only commands that show something run now; the rest wait (P38c).
			if (task !== undefined && whenCommandRuns(this.host, text) === "later") {
				this.queueCommand(text);
				return;
			}
			void this.runSlash(text);
			return;
		}
		// `#fact` saves a memory instead of prompting (yo-agent #remember, P26c).
		if (/^#[^#\s]/.test(text) && !text.includes("\n") && this.host.session.commands.has("remember")) {
			void this.runSlash(`/remember ${text.slice(1).trim()}`);
			return;
		}
		if (task === "turn") {
			this.sendQueued("steer", text);
			return;
		}
		if (task !== undefined) {
			this.host.setEditor(ed.fromText(text));
			this.host.notice("dim", `A ${task} task is running. Press Esc to interrupt it; your input stays in the editor.`);
			return;
		}
		const bash = parseUserBash(text);
		if (bash) {
			void this.runUserBash(bash.command, bash.record);
			return;
		}
		void this.runPrompt(text);
	}

	queueFollowUp(): void {
		// An open prompt (deny and tell, a question) is answered: the turn is waiting for it.
		if (this.host.state.prompt) {
			this.submit();
			return;
		}
		const text = this.host.inputBox.takeInput();
		if (text === "") return;
		this.host.inputBox.history.push(text);
		this.host.inputBox.historyIndex = this.host.inputBox.history.list().length;
		if (text.startsWith("/") && whenCommandRuns(this.host, text) !== "unknown") {
			this.queueCommand(text);
			return;
		}
		// Behind a waiting command a follow-up waits too: the queue runs in the order it shows.
		if (this.pending.length > 0) {
			this.queuePending({ kind: "prompt", text });
			return;
		}
		this.sendQueued("followUp", text);
	}

	/**
	 * Input waiting for the running task to end, run in order then (P38c): slash commands, and
	 * follow-ups queued after one (Claude Code runs its queue in order).
	 */
	readonly pending: PendingInput[] = [];

	private runningPending = false;

	private queueCommand(text: string): void {
		this.queuePending({ kind: "command", text });
	}

	private queuePending(item: PendingInput): void {
		this.pending.push(item);
		this.host.dispatch({ type: "queue-add", input: queuedInput(item) });
	}

	private async runPendingCommands(): Promise<void> {
		if (this.runningPending) return;
		this.runningPending = true;
		try {
			while (this.pending.length > 0 && this.host.state.task === undefined && !this.host.stopped) {
				const item = this.pending.shift() as PendingInput;
				this.host.dispatch({ type: "queue-remove", input: queuedInput(item) });
				if (item.kind === "command") await this.runSlash(item.text);
				else await this.runPrompt(item.text);
			}
		} finally {
			this.runningPending = false;
			this.startPending();
		}
	}

	sendQueued(kind: "steer" | "followUp", text: string): void {
		// Extension commands cannot be queued as model input (pi _throwIfExtensionCommand).
		const name = text.startsWith("/") ? text.slice(1).split(/\s/, 1)[0] : undefined;
		if (name !== undefined && this.host.session.commands.has(name)) {
			this.host.setEditor(ed.fromText(text));
			this.host.notice("dim", `/${name} is an extension command; run it when the turn ends.`);
			return;
		}
		this.host.dispatch({ type: "queue-add", input: { kind, text } });
		// Input handlers see queued input first and may consume it (pi 0.86.0).
		void (kind === "followUp" ? this.host.session.followUp(text) : this.host.session.steer(text)).then(
			(disposition) => {
				if (disposition === "handled") {
					this.host.dispatch({ type: "queue-clear" });
					this.host.notice("dim", `Handled by an extension: ${text}`);
				}
			},
			(error: unknown) => this.host.notice("error", `Input failed: ${errorText(error)}`),
		);
	}

	async runSlash(text: string): Promise<void> {
		try {
			const handled = await runCommand(this.host, text);
			if (handled) return;
		} catch (error) {
			this.host.notice("error", `${text.split(/\s/, 1)[0]} failed: ${errorText(error)}`);
			return;
		}
		// Not a command: send it as a prompt (a path such as /etc/hosts, say).
		if (this.host.state.task === "turn") this.sendQueued("steer", text);
		else if (this.host.state.task === undefined) void this.runPrompt(text);
	}

	interrupt(): void {
		if (this.host.state.task === undefined) return;
		void this.host.session.interrupt().catch(() => undefined);
		this.host.dispatch({ type: "activity", text: "Interrupting" });
	}

	// ── tasks ────────────────────────────────────────────────────────────────

	/** Show the task slot taken (by this TUI's request, or a job the hub reports). */
	private beginTask(task: TaskKind, activity: string): void {
		this.host.dispatch({ type: "task-start", task, activity, at: this.host.now() });
		this.host.terminalStatus?.running();
	}

	/**
	 * P59: back on the resident server after a drop. A turn that ended unseen ends here; the screen
	 * shows the conversation again (a turn still running replays from the notifications that follow).
	 */
	private async reconnected(): Promise<void> {
		const { state } = this.host.session;
		if (!state.running && state.task === undefined) {
			this.turn = undefined;
			for (const [turnId, waiter] of this.turnWaiters) {
				this.turnWaiters.delete(turnId);
				waiter();
			}
			if (this.host.state.task !== undefined) await this.endTask();
		}
		this.host.sessions.showSession("Reconnected to the resident server.");
	}

	/** The task ended: open approvals are void, the surfaces may have changed, waiting input runs. */
	private async endTask(): Promise<void> {
		this.hubTask = undefined;
		this.host.dialogs.settleOpenApprovals();
		this.host.dispatch({ type: "task-end" });
		this.host.terminalStatus?.idle(this.host.turnFailed);
		this.host.turnFailed = false;
		await this.host.refreshSurfaces().catch(() => undefined);
		this.startPending();
	}

	/**
	 * A job this TUI asks the hub for (a compaction, a move in the tree, a reload, …): the slot shows
	 * taken at once, so whoever checks state.task next (a queued command) waits; the hub's
	 * task notifications end it. A job the hub refused (busy) never started: the slot frees here.
	 */
	async runJob<T>(task: HubTaskKind, activity: string, call: () => Promise<T>): Promise<T> {
		this.beginTask(task, activity);
		try {
			const result = await call();
			await this.host.session.drain();
			return result;
		} catch (error) {
			await this.host.session.drain();
			if (this.hubTask === undefined && this.host.state.task === task) await this.endTask();
			throw error;
		}
	}

	/** A prompt an extension command or shortcut asked for went to the hub as a turn. */
	async promptWhenFree(text: UserContent): Promise<void> {
		if (this.host.state.task === undefined) await this.runPrompt(text);
		else this.pendingStarts.push(text);
	}

	private startPending(): void {
		if (this.host.state.task !== undefined || this.host.stopped) return;
		if (this.pending.length > 0) {
			void this.runPendingCommands();
			return;
		}
		if (this.runningPending) return;
		const next = this.pendingStarts.shift();
		if (next !== undefined) void this.runPrompt(next);
	}

	/** Send a prompt; resolves when its turn has ended and been drawn. */
	async runPrompt(input: UserContent): Promise<void> {
		// The slot is taken before anything is awaited: whoever checks state.task next (a queued
		// command, /follow) sees this turn and waits for it.
		if (this.host.state.task === undefined) this.beginTask("turn", "Thinking");
		let turnId: string;
		try {
			({ turnId } = await this.host.session.startTurn(input));
		} catch (error) {
			this.host.notice("error", `Error: ${errorText(error)}`);
			await this.host.session.drain();
			if (this.turn === undefined && this.host.state.task === "turn") await this.endTask();
			return;
		}
		await this.waitForTurn(turnId);
	}

	/** Until the turn has ended and been drawn (a prompt this TUI or an extension command sent). */
	waitForTurn(turnId: string): Promise<void> {
		return new Promise((resolve) => {
			if (this.finishedTurns.delete(turnId)) resolve();
			else this.turnWaiters.set(turnId, resolve);
		});
	}

	/** Turns that ended before their prompt's answer came back (the hub answers after it started them). */
	private readonly finishedTurns = new Set<string>();

	/** A notification of the session (in order; the next waits for this one). */
	async handleNotification(notification: SessionNotification): Promise<void> {
		switch (notification.method) {
			case "client/reconnected":
				await this.reconnected();
				return;
			case "turn/started":
				await this.turnStarted(notification.params.turnId, notification.params.input as UserContent | undefined);
				return;
			case "thread/event":
				await this.handleEvent(notification.params.event as unknown as AgentEvent);
				return;
			case "turn/completed":
				await this.turnCompleted(notification.params);
				return;
			case "thread/task/started":
				this.hubTask = notification.params.kind;
				if (this.host.state.task === undefined) this.beginTask(notification.params.kind, notification.params.activity);
				return;
			case "thread/task/ended":
				if (this.host.state.task !== undefined) await this.endTask();
				// A reload, this TUI's /reload or the hub's own after a worktree move (P46), says how it went.
				if (notification.params.kind === "reload") {
					if (notification.params.error !== undefined) this.host.notice("error", notification.params.error);
					else this.host.notice("info", "Extensions reloaded.");
				}
				return;
			case "thread/messages/appended":
				// Outside a task (an extension command's sendMessage, a background result): drawn now.
				if (this.host.state.task === undefined) await this.renderUnshownMessages(notification.params.start);
				return;
			case "thread/notice": {
				const { level, text, turnError } = notification.params;
				if (turnError) this.host.turnFailed = true;
				this.host.notice(
					level === "error" ? "error" : level === "warning" ? "warn" : "info",
					turnError ? `Error: ${text}` : text,
				);
				// What a widget shows may follow what the extension just did (ask_user's waiting question).
				if (this.host.session.state.extensions.widgets > 0) void this.host.refreshWidgets().catch(() => undefined);
				return;
			}
			case "thread/state/changed":
				void this.host.refreshStatus().catch(() => undefined);
				return;
			case "serverRequest/resolved":
				// Answered elsewhere (another client, a timeout, an interrupt): its dialog closes here.
				this.host.dialogs.dismissRequest(notification.params.requestId);
				return;
			case "thread/closed":
				// An extension asked to shut down (ctx.shutdown).
				void this.host.stop();
				return;
			default:
		}
	}

	private async turnStarted(turnId: string, input: UserContent | undefined): Promise<void> {
		if (this.host.state.task === undefined) this.beginTask("turn", "Thinking");
		this.turn = { id: turnId, startedAt: this.host.now(), before: this.usage() };
		// Messages that arrived since the last run (a background subagent's result) show first.
		await this.renderUnshownMessages();
		if (input !== undefined) {
			const text = userContentText(input);
			await this.prefetchMarkdown([{ text, kind: "user" }]);
			const images = typeof input === "string" ? 0 : input.filter((part) => part.type === "image").length;
			this.host.dispatch({ type: "user", text, images });
		}
	}

	private async turnCompleted(outcome: {
		turnId: string;
		stopReason: string;
		aborted: boolean;
		errorMessage?: string;
	}): Promise<void> {
		const turn = this.turn ?? { startedAt: this.host.now(), before: this.usage() };
		this.turn = undefined;
		const interrupted = outcome.aborted || outcome.stopReason === "aborted";
		const failure = outcome.stopReason === "error" ? outcome.errorMessage : undefined;
		// The run threw (not a model error the store already shows): the hub said so (turnError).
		if (failure !== undefined && !this.lastAssistantFailed()) this.host.turnFailed = true;
		// Queues survive an abort (kernel contract): put queued text back in the editor
		// instead of replaying it into the next prompt (pi restoreQueuedMessagesToEditor).
		await this.host.inputBox.restoreQueuedInput();
		await this.endTask();
		const last = this.host.session.messages.findLast((message) => message.role === "assistant");
		if (interrupted) {
			this.host.notice("warn", "■ Interrupted");
		} else {
			const elapsed = this.host.now() - turn.startedAt;
			if (failure !== undefined || last?.stopReason === "error") {
				this.host.attention("error", failure ?? (last?.role === "assistant" ? (last.errorMessage ?? "") : ""), elapsed);
			} else if (this.pendingStarts.length === 0) {
				const text =
					last?.role === "assistant"
						? last.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join(" ")
						: "";
				this.host.attention("done", firstLine(text).slice(0, 80), elapsed);
			}
			// Claude Code's past-tense line after a turn, with what it used.
			const after = this.usage();
			const parts = [`Worked for ${fmtElapsed(elapsed)}`];
			if (turn.before) {
				const inTokens =
					after.input +
					after.cacheRead +
					after.cacheWrite -
					(turn.before.input + turn.before.cacheRead + turn.before.cacheWrite);
				const outTokens = after.output - turn.before.output;
				if (inTokens > 0 || outTokens > 0) parts.push(`↑${fmtInt(inTokens)} ↓${fmtInt(outTokens)}`);
				const cost = fmtCost(after.cost.total - turn.before.cost.total);
				if (cost) parts.push(cost);
			}
			this.host.notice("dim", parts.join(" · "));
		}
		const waiter = this.turnWaiters.get(outcome.turnId);
		if (waiter) {
			this.turnWaiters.delete(outcome.turnId);
			waiter();
		} else this.finishedTurns.add(outcome.turnId);
	}

	/** The last assistant message failed: the store writes that error itself at the end of the turn. */
	private lastAssistantFailed(): boolean {
		const last = this.host.session.messages.findLast((message) => message.role === "assistant");
		return last?.role === "assistant" && last.stopReason === "error";
	}

	/** The session's usage as the hub last said (kernel Usage). */
	private usage(): Usage {
		return usageOf(this.host.session.state);
	}

	private async handleEvent(event: AgentEvent): Promise<void> {
		const at = this.host.now();
		switch (event.type) {
			case "assistant_message": {
				await this.prefetchMarkdown(assistantTexts(event.message.content));
				this.host.dispatch({ type: "agent-event", event, at });
				const lines = await this.renderMessage(event.message);
				if (lines) this.host.dispatch({ type: "assistant-rendered", lines });
				void this.host.refreshStatus().catch(() => undefined);
				return;
			}
			case "user_message": {
				if (event.message.role === "custom") {
					await this.showMessage(event.message);
					return;
				}
				await this.prefetchMarkdown([{ text: userContentText(event.message.content), kind: "user" }]);
				this.host.dispatch({ type: "agent-event", event, at });
				return;
			}
			case "tool_result": {
				this.runningCommands.delete(event.toolCall.id);
				// The result rendering lands before the block finishes: a finished block is committed and final.
				const lines = await this.renderTool(event);
				if (lines) this.host.dispatch({ type: "tool-rendered", callId: event.toolCall.id, lines });
				this.host.dispatch({ type: "agent-event", event, at });
				// A tool may have changed what a widget shows (the todo list, say).
				if (this.host.session.state.extensions.widgets > 0) void this.host.refreshWidgets().catch(() => undefined);
				return;
			}
			case "tool_start":
			case "tool_update": {
				if (event.type === "tool_start" && COMMAND_TOOLS.has(event.toolCall.name)) {
					this.runningCommands.add(event.toolCall.id);
				}
				this.host.dispatch({ type: "agent-event", event, at });
				const lines = await this.renderTool(event);
				if (lines) this.host.dispatch({ type: "tool-rendered", callId: event.toolCall.id, lines });
				return;
			}
			case "agent_settled":
				this.runningCommands.clear();
				this.host.dispatch({ type: "agent-event", event, at });
				return;
			default:
				this.host.dispatch({ type: "agent-event", event, at });
		}
	}

	/** The extensions' markdown transformers' output for texts about to be drawn (P40d). */
	private async prefetchMarkdown(items: Array<{ text: string; kind: MarkdownKind }>): Promise<void> {
		try {
			if (await this.host.session.prefetchMarkdown(items, this.host.columns() - 1)) markdownTransformsChanged();
		} catch {
			// Drawn as written.
		}
	}

	/** The transformers' output for the whole conversation, before it is drawn again (the start, a switch). */
	async prefetchReplay(): Promise<void> {
		if (this.host.session.state.extensions.markdownTransformers === 0) return;
		const items: Array<{ text: string; kind: MarkdownKind }> = [];
		for (const message of this.host.session.messages) {
			if (message.role === "user") items.push({ text: userContentText(message.content), kind: "user" });
			else if (message.role === "assistant") items.push(...assistantTexts(message.content));
		}
		await this.prefetchMarkdown(items);
	}

	/** A custom message: an extension renderer's output, else its text when it is meant for display. */
	private async showMessage(message: CustomMessage | AgentMessage): Promise<void> {
		if (message.role === "custom") this.shownCustom.add(customKey(message));
		const diagnostics = diagnosticsBlock(message);
		if (diagnostics) {
			this.host.dispatch({ type: "diagnostics", ...diagnostics });
			return;
		}
		const lines = await this.renderMessage(message);
		if (lines) this.host.lines(lines);
		else if (message.role === "custom" && message.display) this.host.notice("dim", userContentText(message.content));
	}

	/** Custom messages in the context (from index `start`) that were never drawn. */
	private async renderUnshownMessages(start = 0): Promise<void> {
		for (const message of this.host.session.messages.slice(start)) {
			if (message.role === "custom" && !this.shownCustom.has(customKey(message))) await this.showMessage(message);
		}
	}

	/** Everything in the context counts as shown (a session's history is replayed, not re-announced). */
	markCustomShown(): void {
		for (const message of this.host.session.messages) {
			if (message.role === "custom") this.shownCustom.add(customKey(message));
		}
	}

	private lines(rendered: Rendered | undefined, width: number): StyledLine[] | undefined {
		return rendered ? renderedLines(rendered, width) : undefined;
	}

	private async renderMessage(message: AgentMessage): Promise<StyledLine[] | undefined> {
		if (this.host.session.state.extensions.messageRenderers === 0) return undefined;
		const width = this.host.columns() - 2;
		try {
			const result = await this.host.session.request("render/message", {
				message: message as unknown as NativeMessage,
				width,
			});
			if (result.failed) {
				this.host.notice("error", `Message renderer ${result.failed.renderer} failed: ${result.failed.error}`);
				return undefined;
			}
			return this.lines(result.rendered, width);
		} catch {
			return undefined;
		}
	}

	private async renderTool(
		event: AgentEvent & { type: "tool_start" | "tool_update" | "tool_result" },
	): Promise<StyledLine[] | undefined> {
		if (this.host.session.state.extensions.toolRenderers === 0) return undefined;
		const id = event.toolCall.id;
		if (event.type === "tool_update") this.toolOutput.set(id, (this.toolOutput.get(id) ?? "") + event.partialOutput);
		const liveOutput = this.toolOutput.get(id);
		const renderEvent: RegisteredToolRenderEvent =
			event.type === "tool_start"
				? { phase: "start", toolCall: event.toolCall }
				: event.type === "tool_update"
					? {
							phase: "update",
							toolCall: event.toolCall,
							partialOutput: event.partialOutput,
							...(event.stream !== undefined ? { stream: event.stream } : {}),
							...(liveOutput !== undefined ? { liveOutput } : {}),
						}
					: {
							phase: "result",
							toolCall: event.toolCall,
							result: event.result,
							...(liveOutput !== undefined ? { liveOutput } : {}),
							...(event.durationMs !== undefined ? { durationMs: event.durationMs } : {}),
						};
		if (event.type === "tool_result") this.toolOutput.delete(id);
		const width = this.host.columns() - 4;
		try {
			const result = await this.host.session.request("render/tool", {
				event: renderEvent as unknown as { phase: "start" | "update" | "result" } & Record<string, unknown>,
				width,
			});
			if (result.failed) {
				this.host.notice("error", `Tool renderer ${result.failed.renderer} failed: ${result.failed.error}`);
				return undefined;
			}
			return this.lines(result.rendered, width);
		} catch {
			return undefined;
		}
	}

	/** What an extension command or shortcut did, shown: its text, or the prompt it sent (P44: or why not). */
	async showOutcome(name: string, outcome: CommandOutcome): Promise<void> {
		await this.host.session.drain();
		if (outcome.output !== undefined) this.host.notice("info", outcome.output);
		if (outcome.blocked) {
			this.host.notice("warn", `/${name} blocked${outcome.blocked.reason ? `: ${outcome.blocked.reason}` : "."}`);
		}
		await this.host.refreshSurfaces().catch(() => undefined);
	}

	async runShortcut(name: string): Promise<void> {
		try {
			const outcome = await this.host.session.request("shortcut/run", { name });
			await this.showOutcome(name, outcome);
		} catch (error) {
			this.host.notice("error", `Shortcut ${name} failed: ${errorText(error)}`);
		}
	}

	/** `!cmd` runs and records the output in context; `!!cmd` only shows it. */
	async runUserBash(command: string, record: boolean): Promise<void> {
		if (command === "") {
			this.host.notice("error", record ? "Usage: !<command>" : "Usage: !!<command>");
			return;
		}
		try {
			const result = await this.runJob("bash", "Running command", () =>
				this.host.session.request("thread/bash", { command, record }),
			);
			if (result.cancelled && result.reason !== undefined) {
				this.host.notice(
					"dim",
					result.reason === "empty command"
						? "Command cancelled: empty command."
						: `Command cancelled: ${result.reason}`,
				);
			} else if (result.recorded) this.host.notice("dim", "Output added to the context.");
		} catch (error) {
			this.host.notice("error", errorText(error));
		}
	}

	async runCompact(instructions: string | undefined): Promise<void> {
		const startedAt = this.host.now();
		const messagesBefore = conversationLength(this.host.session.messages);
		const tokensBefore = contextTokens(this.host.session.state.contextUsage);
		try {
			const result = await this.runJob("compaction", `Compacting ${messagesBefore} messages`, () =>
				this.host.session.request("thread/compact", instructions !== undefined ? { instructions } : {}),
			);
			if (result.cancelled) {
				this.host.notice(
					"dim",
					result.cancelled === "interrupted" ? "Compaction interrupted." : "Compaction cancelled.",
				);
				return;
			}
			if (!result.compacted) {
				this.host.notice("dim", "Nothing to compact.");
				return;
			}
			const tokensAfter = contextTokens(this.host.session.state.contextUsage);
			const kept = this.host.session.messages.filter(
				(message) => message.role !== "system" && message.role !== "compactionSummary",
			).length;
			this.host.notice(
				"info",
				`Compacted ~${fmtInt(Math.max(result.tokensBefore ?? 0, tokensBefore))} → ~${fmtInt(tokensAfter)} tokens · ${kept}/${messagesBefore} messages kept · ${fmtElapsed(this.host.now() - startedAt)}`,
			);
		} catch (error) {
			this.host.notice("error", errorText(error));
		}
	}

	/**
	 * Move in the session tree (pi navigateTree), as a job. Back to one of your messages, its text
	 * returns to the input box to edit and send again. A failed branch summary asks (in the hub)
	 * whether to move without one (P23e).
	 */
	async navigate(entryId: string, options: { summarize?: boolean; customInstructions?: string } = {}): Promise<void> {
		const summarize = options.summarize !== false;
		try {
			const result = await this.runJob("navigate", summarize ? "Summarizing the branch" : "Moving", () =>
				this.host.session.request("thread/navigate", {
					entryId,
					summarize,
					...(options.customInstructions !== undefined ? { customInstructions: options.customInstructions } : {}),
				}),
			);
			if (result.cancelled) {
				if (result.interrupted) this.host.notice("dim", "Navigation cancelled.");
				else this.host.flash("Navigation cancelled.");
				return;
			}
			const count = conversationLength(this.host.session.messages);
			if (result.editorText !== undefined) {
				this.host.sessions.showSession(
					`Back before that message (${count} messages in context); it is in the input box.`,
				);
				// pi puts it in the editor; a draft typed meanwhile stays after it.
				const draft = this.host.state.editor.text;
				this.host.setInput(draft.trim() === "" ? result.editorText : `${result.editorText}\n${draft}`);
			} else {
				this.host.sessions.showSession(`Moved (${count} messages in context).`);
			}
		} catch (error) {
			this.host.notice("error", `/tree failed: ${errorText(error)}`);
		}
	}
}

/** What an assistant message's blocks may hold: each text and thinking part, and all of them together. */
function assistantTexts(content: AssistantMessage["content"]): Array<{ text: string; kind: MarkdownKind }> {
	const texts = content.flatMap((part) => (part.type === "text" ? [part.text] : []));
	const thinking = content.flatMap((part) => (part.type === "thinking" ? [part.thinking] : []));
	return [
		...texts.map((text) => ({ text, kind: "assistant" as const })),
		{ text: texts.join(""), kind: "assistant" as const },
		...thinking.map((text) => ({ text, kind: "assistant-thinking" as const })),
		{ text: thinking.join(""), kind: "assistant-thinking" as const },
	];
}

function contextTokens(usage: Record<string, unknown>): number {
	return typeof usage.tokens === "number" ? usage.tokens : 0;
}

export function customKey(message: CustomMessage): string {
	return `${message.customType}\u0000${message.timestamp}\u0000${userContentText(message.content)}`;
}

/** `!cmd` records the output in context, `!!cmd` does not. */
export function parseUserBash(input: string): { command: string; record: boolean } | undefined {
	if (input.startsWith("!!")) return { command: input.slice(2).trim(), record: false };
	if (input.startsWith("!")) return { command: input.slice(1).trim(), record: true };
	return undefined;
}

export function formatShellOutput(result: { stdout: string; stderr: string; exitCode: number }): string {
	const parts: string[] = [];
	if (result.stdout !== "") parts.push(result.stdout.trimEnd());
	if (result.stderr !== "") parts.push(result.stderr.trimEnd());
	let output = parts.filter((part) => part !== "").join("\n");
	if (output === "") output = "(no output)";
	if (result.exitCode !== 0) output += `\nExit code ${result.exitCode}`;
	return output;
}

export function isAbortError(error: unknown): boolean {
	if (!(error instanceof Error)) return false;
	if (error.name === "AbortError") return true;
	return "code" in error && error.code === "aborted";
}
