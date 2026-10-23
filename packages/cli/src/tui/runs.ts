// Runs in the TUI (P50: split out of controller.ts): submitting the input, the queue of
// steering, follow-ups and commands typed mid-turn (P38c), one task at a time (a turn, a
// compaction, a `!` command, a navigation), the agent's events and drawing its messages, and
// extension shortcuts.
import {
	type AgentEvent,
	type AgentMessage,
	type CustomMessage,
	commandPromptContent,
	TauError,
	type UserContent,
	userContentText,
} from "@yophon/tau-kernel";
import { autoTitle } from "../session-title.ts";
import type { CommandHost } from "./commands.ts";
import { runCommand, whenCommandRuns } from "./commands.ts";
import type { TuiController } from "./controller.ts";
import type { TuiDialogs } from "./dialogs.ts";
import { messageRendererMatches, renderResultLines, toolRendererMatches } from "./extensions.ts";
import { conversationLength, errorText, firstLine, fmtCost, fmtElapsed, fmtInt } from "./format.ts";
import * as ed from "./input/editor.ts";
import { expandPastes } from "./input/paste.ts";
import type { TuiInputBox } from "./input-box.ts";
import { type PendingInput, queuedInput } from "./input-box.ts";
import { diagnosticsBlock, type TaskKind } from "./model.ts";
import type { StyledLine } from "./render/spans.ts";
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
		readonly dialogs: Pick<TuiDialogs, "closePrompt" | "nextDialogId" | "settleOpenApprovals" | "settlePrompt">;
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

export class TuiRuns {
	private readonly host: RunsHost;

	constructor(host: RunsHost) {
		this.host = host;
	}

	controller: AbortController | undefined;

	/** Runs requested while a task ran (extension submits, agent_settled races): started after it (P23e). */
	readonly pendingStarts: (UserContent | null)[] = [];

	/**
	 * Custom messages already drawn (by content key). One that arrives between runs
	 * (a background subagent's result) is drawn before the next run; counting
	 * messages instead races with a result landing while a turn wraps up.
	 */
	private readonly shownCustom = new Set<string>();

	private readonly toolOutput = new Map<string, string>();

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
		if (/^#[^#\s]/.test(text) && !text.includes("\n") && this.host.extensions.commands.has("remember")) {
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

	private runningCommands = false;

	private queueCommand(text: string): void {
		this.queuePending({ kind: "command", text });
	}

	private queuePending(item: PendingInput): void {
		this.pending.push(item);
		this.host.dispatch({ type: "queue-add", input: queuedInput(item) });
	}

	private async runPendingCommands(): Promise<void> {
		if (this.runningCommands) return;
		this.runningCommands = true;
		try {
			while (this.pending.length > 0 && this.host.state.task === undefined && !this.host.stopped) {
				const item = this.pending.shift() as PendingInput;
				this.host.dispatch({ type: "queue-remove", input: queuedInput(item) });
				if (item.kind === "command") await this.runSlash(item.text);
				else await this.runPrompt(item.text);
			}
		} finally {
			this.runningCommands = false;
			this.startPending();
		}
	}

	sendQueued(kind: "steer" | "followUp", text: string): void {
		// Extension commands cannot be queued as model input (pi _throwIfExtensionCommand).
		const name = text.startsWith("/") ? text.slice(1).split(/\s/, 1)[0] : undefined;
		if (name !== undefined && this.host.extensions.commands.has(name)) {
			this.host.setEditor(ed.fromText(text));
			this.host.notice("dim", `/${name} is an extension command; run it when the turn ends.`);
			return;
		}
		this.host.dispatch({ type: "queue-add", input: { kind, text } });
		// Input handlers see queued input first and may consume it (pi 0.86.0).
		void (kind === "followUp" ? this.host.agent.followUp(text) : this.host.agent.steer(text)).then(
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
		if (this.controller) {
			this.controller.abort();
			this.host.dispatch({ type: "activity", text: "Interrupting" });
		}
	}

	// ── tasks ────────────────────────────────────────────────────────────────

	/** Hold the task slot for `run`; one task at a time. */
	async runTask(task: TaskKind, activity: string, run: (signal: AbortSignal) => Promise<void>): Promise<void> {
		const controller = new AbortController();
		this.controller = controller;
		this.host.dispatch({ type: "task-start", task, activity, at: this.host.now() });
		this.host.terminalStatus?.running();
		try {
			await run(controller.signal);
		} finally {
			this.controller = undefined;
			this.host.dialogs.settleOpenApprovals();
			this.host.dispatch({ type: "task-end" });
			this.host.terminalStatus?.idle(this.host.turnFailed);
			this.host.turnFailed = false;
			await this.host.refreshSurfaces().catch(() => undefined);
			this.startPending();
		}
	}

	/** A prompt an extension command or shortcut asked for: now, or once the running task ends. */
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
		if (this.runningCommands) return;
		const next = this.pendingStarts.shift();
		if (next !== undefined) void this.runPrompt(next);
	}

	async runPrompt(input: UserContent | null): Promise<void> {
		await this.runPromptOnce(input);
		await this.reloadIfMoved();
	}

	/**
	 * P46: the session moved into or out of a worktree during the turn: its settings, AGENTS.md
	 * and extensions follow now, and the TUI's own directory (footer, completion, `!` commands).
	 */
	async reloadIfMoved(): Promise<void> {
		if (this.host.state.task !== undefined || !this.host.options.consumeReload?.()) return;
		(this.host.options as { cwd: string }).cwd = process.cwd();
		this.host.inputBox.files = undefined;
		this.host.inputBox.filesEpoch++;
		await this.host.sessions.reloadExtensions();
	}

	private async runPromptOnce(input: UserContent | null): Promise<void> {
		const before = this.host.agent.getSessionUsage();
		const startedAt = this.host.now();
		let interrupted = false;
		let failure: string | undefined;
		// The slot is taken before anything is awaited: whoever checks state.task next (a queued
		// command, /follow) sees this turn and waits for it.
		await this.runTask("turn", "Thinking", async (signal) => {
			// Messages that arrived since the last run (a background subagent's result) show first.
			await this.renderUnshownMessages();
			if (input !== null) {
				const images = typeof input === "string" ? 0 : input.filter((part) => part.type === "image").length;
				this.host.dispatch({ type: "user", text: userContentText(input), images });
			}
			try {
				// input null = an extension-triggered continuation without new user input.
				const stream = input === null ? this.host.agent.resume(signal) : this.host.agent.prompt(input, signal);
				for await (const event of stream) await this.handleEvent(event);
			} catch (error) {
				if (isAbortError(error)) interrupted = true;
				else {
					this.host.turnFailed = true;
					failure = errorText(error);
					this.host.notice("error", `Error: ${failure}`);
				}
			}
			if (signal.aborted) interrupted = true;
			// Queues survive an abort (kernel contract): put queued text back in the editor
			// instead of replaying it into the next prompt (pi restoreQueuedMessagesToEditor).
			this.host.inputBox.restoreQueuedInput();
		});
		const last = this.host.agent.messages.findLast((message) => message.role === "assistant");
		if (interrupted || (last?.role === "assistant" && last.stopReason === "aborted")) {
			this.host.notice("warn", "■ Interrupted");
			return;
		}
		const elapsed = this.host.now() - startedAt;
		if (failure !== undefined || last?.stopReason === "error") {
			this.host.attention("error", failure ?? (last?.role === "assistant" ? (last.errorMessage ?? "") : ""), elapsed);
		} else if (this.pendingStarts.length === 0) {
			const text =
				last?.role === "assistant"
					? last.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join(" ")
					: "";
			this.host.attention("done", firstLine(text).slice(0, 80), elapsed);
		}
		const after = this.host.agent.getSessionUsage();
		// Claude Code's past-tense line after a turn, with what it used.
		const parts = [`Worked for ${fmtElapsed(this.host.now() - startedAt)}`];
		const inTokens =
			after.input + after.cacheRead + after.cacheWrite - (before.input + before.cacheRead + before.cacheWrite);
		const outTokens = after.output - before.output;
		if (inTokens > 0 || outTokens > 0) parts.push(`↑${fmtInt(inTokens)} ↓${fmtInt(outTokens)}`);
		const cost = fmtCost(after.cost.total - before.cost.total);
		if (cost) parts.push(cost);
		this.host.notice("dim", parts.join(" · "));
		void this.titleSession();
	}

	/** Session ids whose title was already requested (P34f). */
	private readonly titled = new Set<string>();

	/** After a turn: the model names a session that has no name yet, in the background (P34f). */
	private async titleSession(): Promise<void> {
		const recorder = this.host.recorder;
		if (this.host.options.autoTitle === false || !recorder) return;
		// console.log goes to the TUI log only: a failed title is not worth a notice.
		const title = await autoTitle(this.host.agent, recorder, this.titled, (message) => console.log(message));
		if (!title || recorder !== this.host.recorder) return;
		await this.host.extensions.notifySessionInfoChanged(title, this.host.agent.extensionContext());
		await this.host.refreshSurfaces().catch(() => undefined);
	}

	private async handleEvent(event: AgentEvent): Promise<void> {
		const at = this.host.now();
		switch (event.type) {
			case "assistant_message": {
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
				this.host.dispatch({ type: "agent-event", event, at });
				return;
			}
			case "tool_result": {
				// The result rendering lands before the block finishes: a finished block is committed and final.
				const lines = await this.renderTool(event);
				if (lines) this.host.dispatch({ type: "tool-rendered", callId: event.toolCall.id, lines });
				this.host.dispatch({ type: "agent-event", event, at });
				// A tool may have changed what a widget shows (the todo list, say).
				if (this.host.extensions.widgets.size > 0) void this.host.refreshWidgets().catch(() => undefined);
				return;
			}
			case "tool_start":
			case "tool_update": {
				this.host.dispatch({ type: "agent-event", event, at });
				const lines = await this.renderTool(event);
				if (lines) this.host.dispatch({ type: "tool-rendered", callId: event.toolCall.id, lines });
				return;
			}
			default:
				this.host.dispatch({ type: "agent-event", event, at });
		}
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

	/** Messages an extension command or shortcut appended outside a run (sendMessage while idle). */
	async renderNewMessages(start: number): Promise<void> {
		await this.host.agent.flush();
		for (const message of this.host.agent.messages.slice(start)) {
			if (message.role === "custom" && !this.shownCustom.has(customKey(message))) await this.showMessage(message);
		}
	}

	/** Custom messages in the context that were never drawn. */
	private async renderUnshownMessages(): Promise<void> {
		await this.host.agent.flush();
		for (const message of this.host.agent.messages) {
			if (message.role === "custom" && !this.shownCustom.has(customKey(message))) await this.showMessage(message);
		}
	}

	/** Everything in the context counts as shown (a session's history is replayed, not re-announced). */
	markCustomShown(): void {
		for (const message of this.host.agent.messages) {
			if (message.role === "custom") this.shownCustom.add(customKey(message));
		}
	}

	private async renderMessage(message: AgentMessage): Promise<StyledLine[] | undefined> {
		for (const renderer of this.host.extensions.messageRenderers.values()) {
			if (!messageRendererMatches(renderer, message)) continue;
			try {
				const lines = renderResultLines(
					await renderer.handler(message, this.host.agent.extensionContext()),
					this.host.columns() - 2,
				);
				if (lines) return lines;
			} catch (error) {
				this.host.notice("error", `Message renderer ${renderer.name} failed: ${errorText(error)}`);
				return undefined;
			}
		}
		return undefined;
	}

	private async renderTool(
		event: AgentEvent & { type: "tool_start" | "tool_update" | "tool_result" },
	): Promise<StyledLine[] | undefined> {
		if (this.host.extensions.toolRenderers.size === 0) return undefined;
		const id = event.toolCall.id;
		if (event.type === "tool_update") this.toolOutput.set(id, (this.toolOutput.get(id) ?? "") + event.partialOutput);
		const liveOutput = this.toolOutput.get(id);
		const renderEvent =
			event.type === "tool_start"
				? { phase: "start" as const, toolCall: event.toolCall }
				: event.type === "tool_update"
					? {
							phase: "update" as const,
							toolCall: event.toolCall,
							partialOutput: event.partialOutput,
							...(event.stream !== undefined ? { stream: event.stream } : {}),
							...(liveOutput !== undefined ? { liveOutput } : {}),
						}
					: {
							phase: "result" as const,
							toolCall: event.toolCall,
							result: event.result,
							...(liveOutput !== undefined ? { liveOutput } : {}),
							...(event.durationMs !== undefined ? { durationMs: event.durationMs } : {}),
						};
		if (event.type === "tool_result") this.toolOutput.delete(id);
		for (const renderer of this.host.extensions.toolRenderers.values()) {
			if (!toolRendererMatches(renderer, renderEvent)) continue;
			try {
				const lines = renderResultLines(
					await renderer.handler(renderEvent, this.host.agent.extensionContext()),
					this.host.columns() - 4,
				);
				if (lines) return lines;
			} catch (error) {
				this.host.notice("error", `Tool renderer ${renderer.name} failed: ${errorText(error)}`);
				return undefined;
			}
		}
		return undefined;
	}

	async runShortcut(name: string): Promise<void> {
		const shortcut = this.host.extensions.shortcuts.get(name);
		if (!shortcut) return;
		try {
			await this.host.agent.flush();
			const start = this.host.agent.messages.length;
			const output = await shortcut.handler(this.host.agent.extensionContext());
			await this.renderNewMessages(start);
			await this.host.refreshSurfaces();
			if (typeof output === "string") this.host.notice("info", output);
			else if (output?.action === "prompt") await this.promptWhenFree(commandPromptContent(output));
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
		const decision = await this.host.extensions.runUserBash(
			{ command, recordInContext: record, cwd: this.host.options.cwd },
			this.host.agent.extensionContext(),
		);
		if (decision.cancel) {
			this.host.notice("dim", `Command cancelled${decision.reason ? `: ${decision.reason}` : "."}`);
			return;
		}
		const effective = decision.command.trim();
		if (effective === "") {
			this.host.notice("dim", "Command cancelled: empty command.");
			return;
		}
		const callId = `user-bash-${this.host.dialogs.nextDialogId++}`;
		const call = { type: "toolCall" as const, id: callId, name: "bash", arguments: { command: effective } };
		await this.runTask("bash", "Running command", async (signal) => {
			this.host.dispatch({ type: "agent-event", event: { type: "tool_start", toolCall: call }, at: this.host.now() });
			try {
				const result = await this.host.options.shell.exec(effective, {
					signal,
					onStdout: (chunk) =>
						this.host.dispatch({
							type: "agent-event",
							event: { type: "tool_update", toolCall: call, partialOutput: chunk, stream: "stdout" },
							at: this.host.now(),
						}),
					onStderr: (chunk) =>
						this.host.dispatch({
							type: "agent-event",
							event: { type: "tool_update", toolCall: call, partialOutput: chunk, stream: "stderr" },
							at: this.host.now(),
						}),
				});
				const output = formatShellOutput(result);
				this.host.dispatch({
					type: "agent-event",
					event: {
						type: "tool_result",
						toolCall: call,
						result: {
							content: [{ type: "text", text: output }],
							isError: result.exitCode !== 0,
							structuredContent: { exit_code: result.exitCode },
						} as never,
					},
					at: this.host.now(),
				});
				if (decision.recordInContext) {
					await this.host.agent.appendMessage({
						role: "custom",
						customType: "user_bash",
						content: [`$ ${effective}`, output].join("\n\n"),
						display: true,
						details: { command: effective, stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode },
						timestamp: Date.now(),
					});
					this.host.notice("dim", "Output added to the context.");
				}
			} catch (error) {
				if (!isAbortError(error)) this.host.notice("error", `Command failed: ${errorText(error)}`);
			}
		});
	}

	async runCompact(instructions: string | undefined): Promise<void> {
		const startedAt = this.host.now();
		const messagesBefore = conversationLength(this.host.agent.messages);
		const tokensBefore = this.host.agent.getContextUsage().tokens;
		await this.runTask("compaction", `Compacting ${messagesBefore} messages`, async (signal) => {
			try {
				const result = await this.host.agent.compact(instructions, "manual", signal);
				if (!result) {
					this.host.notice("dim", "Nothing to compact.");
					return;
				}
				const tokensAfter = this.host.agent.getContextUsage().tokens;
				const kept = this.host.agent.messages.filter(
					(message) => message.role !== "system" && message.role !== "compactionSummary",
				).length;
				this.host.notice(
					"info",
					`Compacted ~${fmtInt(Math.max(result.tokensBefore, tokensBefore))} → ~${fmtInt(tokensAfter)} tokens · ${kept}/${messagesBefore} messages kept · ${fmtElapsed(this.host.now() - startedAt)}`,
				);
			} catch (error) {
				this.host.notice(
					isAbortError(error) || (error instanceof TauError && error.code === "cancelled") ? "dim" : "error",
					isAbortError(error)
						? "Compaction interrupted."
						: error instanceof TauError && error.code === "cancelled"
							? "Compaction cancelled."
							: `Compaction failed: ${errorText(error)}`,
				);
			}
		});
	}

	/**
	 * Move to another entry of the session tree with the task slot held (Esc
	 * cancels the branch summary). A failed summary offers moving without one (P23e).
	 */
	/**
	 * Move in the session tree (pi navigateTree). Back to one of your messages, its text
	 * returns to the input box to edit and send again.
	 */
	async navigate(entryId: string, options: { summarize?: boolean; customInstructions?: string } = {}): Promise<void> {
		const summarize = options.summarize !== false;
		await this.runTask("navigate", summarize ? "Summarizing the branch" : "Moving", async (signal) => {
			try {
				let result: { cancelled: boolean; editorText?: string };
				try {
					result = await this.host.agent.navigateTo(entryId, {
						signal,
						summarize,
						...(options.customInstructions !== undefined ? { customInstructions: options.customInstructions } : {}),
					});
				} catch (error) {
					if (!(error instanceof TauError && error.code === "compaction_failed")) throw error;
					const without = await this.host.ui.confirm(
						"Branch summary failed. Navigate without a summary?",
						error.message,
					);
					if (!without) {
						this.host.notice("dim", "Navigation cancelled.");
						return;
					}
					result = await this.host.agent.navigateTo(entryId, { summarize: false, signal });
				}
				if (result.cancelled) {
					this.host.flash("Navigation cancelled.");
					return;
				}
				const count = conversationLength(this.host.agent.messages);
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
				this.host.notice(
					isAbortError(error) ? "dim" : "error",
					isAbortError(error) ? "Navigation cancelled." : `/tree failed: ${errorText(error)}`,
				);
			}
		});
	}
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
