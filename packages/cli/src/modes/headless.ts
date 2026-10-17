/**
 * One conversation without a terminal UI (P29): what the RPC and ACP modes
 * drive. It owns the agent of a workspace, runs prompts one at a time (queued
 * input steers or follows up), switches sessions the way the TUI does
 * (session_before_switch, rebuild, session_start), and runs the slash commands
 * that make sense without a screen.
 */
import {
	type Agent,
	type AgentEvent,
	type AgentMessage,
	type ExtensionRegistry,
	messageText,
	type PermissionMode,
	restoreSession,
	SessionRecorder,
	type SessionStore,
	type SetModelOptions,
	type Shell,
	type ThinkingLevel,
	type UserContent,
	userContentText,
} from "@yophon/tau-kernel";

/** What a workspace (main.ts openWorkspace) gives a headless session. */
export interface HeadlessWorkspace {
	cwd: string;
	extensions: ExtensionRegistry;
	sessionRepo: {
		create(): Promise<SessionStore>;
		open(metadata: { id: string; cwd: string; timestamp: string; filePath?: string }): Promise<SessionStore>;
		list(): Promise<Array<{ id: string; cwd: string; timestamp: string; filePath?: string; name?: string }>>;
		fork(
			source: { id: string; cwd: string; timestamp: string; filePath?: string },
			options?: { entryId?: string; position?: "before" | "at" },
		): Promise<SessionStore>;
	};
	shell: Shell;
	buildAgent(
		messages: AgentMessage[] | undefined,
		session: SessionRecorder | undefined,
		extensions: ExtensionRegistry,
	): Agent;
}

export type ModelSwitch =
	| { model: string; display: string; options: SetModelOptions; commit(): void }
	| { error: string };

export interface HeadlessOptions {
	workspace: HeadlessWorkspace;
	/** Every AgentEvent of every run, in order. */
	onEvent?: (event: AgentEvent) => void;
	/** Something the user should see that is not part of the conversation. */
	onNotice?: (level: "info" | "warning" | "error", text: string) => void;
	modelDisplay: string;
	modelChoices: readonly string[];
	resolveModelSwitch?: (requested: string) => ModelSwitch;
	/** Later agents (session switches) use these; the host keeps them. */
	setHostModel?: (model: string) => void;
	setHostThinking?: (level: ThinkingLevel | undefined) => void;
	setHostPermissionMode?: (mode: PermissionMode) => void;
}

export interface RunOutcome {
	stopReason: string;
	aborted: boolean;
	errorMessage?: string;
}

export const THINKING_LEVELS: readonly ThinkingLevel[] = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];
const MODES: readonly PermissionMode[] = ["read-only", "supervised", "accept-edits", "autonomous", "bypass"];

export class HeadlessSession {
	agent: Agent;
	store: SessionStore | undefined;
	recorder: SessionRecorder | undefined;
	modelDisplay: string;
	readonly options: HeadlessOptions;
	private controller: AbortController | undefined;
	private running: Promise<RunOutcome> | undefined;
	private readonly pending: (UserContent | null)[] = [];
	private compacting = false;
	private bashController: AbortController | undefined;
	private stopped = false;

	constructor(
		options: HeadlessOptions,
		agent: Agent,
		store: SessionStore | undefined,
		recorder: SessionRecorder | undefined,
	) {
		this.options = options;
		this.agent = agent;
		this.store = store;
		this.recorder = recorder;
		this.modelDisplay = options.modelDisplay;
	}

	get extensions(): ExtensionRegistry {
		return this.options.workspace.extensions;
	}

	get isRunning(): boolean {
		return this.running !== undefined;
	}

	get isCompacting(): boolean {
		return this.compacting;
	}

	/** Host actions first, then session_start (P23e order). */
	async start(reason: "startup" | "resume"): Promise<void> {
		this.extensions.attachHostActions({
			submitPrompt: (content) => {
				if (this.running) this.pending.push(content);
				else void this.run(content);
			},
			resumeTurn: () => {
				if (this.running) {
					if (!this.pending.includes(null)) this.pending.push(null);
				} else void this.run(null);
			},
			shutdown: () => {
				void this.stop();
			},
		});
		await this.extensions.notifySessionStart(reason, this.agent.extensionContext());
	}

	async stop(): Promise<void> {
		if (this.stopped) return;
		this.stopped = true;
		this.controller?.abort();
		await this.running?.catch(() => undefined);
		await this.extensions.notifySessionShutdown("quit", this.agent.extensionContext());
	}

	/** Run one prompt (or resume with null) to the end; runs queue behind each other. */
	run(content: UserContent | null): Promise<RunOutcome> {
		if (this.running) {
			return this.running.then(() => this.run(content));
		}
		const controller = new AbortController();
		this.controller = controller;
		const task = (async (): Promise<RunOutcome> => {
			let last: AgentMessage | undefined;
			let aborted = false;
			try {
				const events =
					content === null ? this.agent.resume(controller.signal) : this.agent.prompt(content, controller.signal);
				for await (const event of events) {
					if (event.type === "assistant_message") last = event.message;
					if (event.type === "agent_settled") aborted = event.aborted;
					this.options.onEvent?.(event);
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				this.options.onNotice?.("error", message);
				return { stopReason: "error", aborted: controller.signal.aborted, errorMessage: message };
			}
			const stopReason = last?.role === "assistant" ? last.stopReason : "stop";
			const errorMessage = last?.role === "assistant" ? last.errorMessage : undefined;
			return {
				stopReason,
				aborted: aborted || stopReason === "aborted",
				...(errorMessage ? { errorMessage } : {}),
			};
		})();
		this.running = task;
		void task.finally(() => {
			if (this.running === task) this.running = undefined;
			if (this.controller === controller) this.controller = undefined;
			const next = this.pending.shift();
			if (next !== undefined && !this.stopped) void this.run(next);
		});
		return task;
	}

	/**
	 * pi's RPC prompt: while a run is in flight the input must say whether it
	 * steers or follows up; otherwise it starts a run.
	 */
	async submit(
		content: UserContent,
		behavior: "steer" | "followUp" | undefined,
	): Promise<{ disposition: "started" | "queued" | "handled"; run?: Promise<RunOutcome> }> {
		if (this.running) {
			if (!behavior) throw new Error('The agent is running: pass streamingBehavior "steer" or "followUp".');
			const disposition = await (behavior === "steer" ? this.agent.steer(content) : this.agent.followUp(content));
			return { disposition };
		}
		return { disposition: "started", run: this.run(content) };
	}

	abort(): void {
		this.controller?.abort();
		this.bashController?.abort();
	}

	async compact(instructions?: string): Promise<{ summary: string; tokensBefore: number } | undefined> {
		this.compacting = true;
		try {
			const result = await this.agent.compact(instructions, "manual");
			return result ? { summary: result.summary, tokensBefore: result.tokensBefore } : undefined;
		} finally {
			this.compacting = false;
		}
	}

	/** `!cmd` (record) / `!!cmd`: run in the workspace shell; recorded output joins the context (TUI runUserBash). */
	async bash(command: string, record = true): Promise<{ output: string; exitCode: number; cancelled: boolean }> {
		const decision = await this.extensions.runUserBash(
			{ command, recordInContext: record, cwd: this.options.workspace.cwd },
			this.agent.extensionContext(),
		);
		if (decision.cancel)
			return { output: decision.reason ?? "cancelled by an extension", exitCode: -1, cancelled: true };
		const controller = new AbortController();
		this.bashController = controller;
		try {
			const result = await this.options.workspace.shell.exec(decision.command, { signal: controller.signal });
			const output = [result.stdout, result.stderr]
				.filter((part) => part !== "")
				.join("\n")
				.trimEnd();
			if (decision.recordInContext) {
				await this.agent.appendMessage({
					role: "custom",
					customType: "user_bash",
					content: [`$ ${decision.command}`, output].join("\n\n"),
					display: true,
					details: {
						command: decision.command,
						stdout: result.stdout,
						stderr: result.stderr,
						exitCode: result.exitCode,
					},
					timestamp: Date.now(),
				});
			}
			return { output, exitCode: result.exitCode, cancelled: false };
		} catch (error) {
			if (controller.signal.aborted) return { output: "", exitCode: -1, cancelled: true };
			throw error;
		} finally {
			this.bashController = undefined;
		}
	}

	/** Switch to another session the way the TUI does (session_before_switch, rebuild, session_start). */
	async switchTo(store: SessionStore, reason: "resume" | "fork" | "new"): Promise<{ cancelled: boolean }> {
		const target = await store.getMetadata();
		const decision = await this.extensions.runSessionBeforeSwitch(
			{
				reason: reason === "new" ? "new" : "resume",
				...(target.filePath !== undefined ? { targetSessionFile: target.filePath } : {}),
			},
			this.agent.extensionContext(),
		);
		if (decision.cancelled) return { cancelled: true };
		const restored = await restoreSession(store);
		this.store = store;
		this.recorder = await SessionRecorder.open(store);
		this.agent = this.options.workspace.buildAgent(restored.messages, this.recorder, this.extensions);
		await this.extensions.notifySessionStart(reason === "new" ? "startup" : "resume", this.agent.extensionContext());
		return { cancelled: false };
	}

	async newSession(): Promise<{ cancelled: boolean }> {
		return this.switchTo(await this.options.workspace.sessionRepo.create(), "new");
	}

	setModel(requested: string): { display: string } | { error: string } {
		const resolved = this.options.resolveModelSwitch?.(requested);
		if (resolved && "error" in resolved) return resolved;
		if (resolved) {
			resolved.commit();
			this.agent.setModel(resolved.model, resolved.options);
			this.modelDisplay = resolved.display;
		} else {
			this.options.setHostModel?.(requested);
			this.agent.setModel(requested);
			this.modelDisplay = requested;
		}
		return { display: this.modelDisplay };
	}

	setThinking(level: ThinkingLevel | undefined): void {
		this.agent.setThinkingLevel(level);
		this.options.setHostThinking?.(level);
	}

	setPermissionMode(mode: PermissionMode): void {
		this.agent.setPermissionMode(mode);
		this.options.setHostPermissionMode?.(mode);
	}

	/**
	 * A `/command`: extension commands run (a prompt they return starts a run);
	 * the built-ins that make sense without a screen run here. Returns undefined
	 * when the text is not a known command (it is then sent as a prompt).
	 */
	async command(text: string): Promise<{ output?: string; run?: Promise<RunOutcome> } | undefined> {
		const match = /^\/([\w:-]+)(?:\s+([\s\S]*))?$/.exec(text.trim());
		if (!match) return undefined;
		const name = match[1] ?? "";
		const args = (match[2] ?? "").trim();
		const command = this.extensions.commands.get(name);
		if (command) {
			const output = await command.handler(args, this.agent.extensionContext());
			if (typeof output === "string") return { output };
			if (output?.action === "prompt") return { run: this.run(output.text) };
			return {};
		}
		switch (name) {
			case "compact": {
				const result = await this.compact(args === "" ? undefined : args);
				return { output: result ? `Compacted (was ~${result.tokensBefore} tokens).` : "Nothing to compact." };
			}
			case "model": {
				if (args === "") return { output: `Model: ${this.modelDisplay}` };
				const result = this.setModel(args);
				return { output: "error" in result ? result.error : `Model set to ${result.display}.` };
			}
			case "thinking": {
				if (args === "") return { output: `Reasoning effort: ${this.agent.thinkingLevel ?? "default"}` };
				const level = args === "default" ? undefined : (args as ThinkingLevel);
				if (level !== undefined && !THINKING_LEVELS.includes(level)) return { output: `Unknown level "${args}".` };
				this.setThinking(level);
				return { output: `Reasoning effort: ${level ?? "default"}.` };
			}
			case "mode": {
				if (args === "") return { output: `Permission mode: ${this.agent.getPermissionMode()}` };
				if (!(MODES as readonly string[]).includes(args)) return { output: `Unknown mode "${args}".` };
				this.setPermissionMode(args as PermissionMode);
				return { output: `Permission mode: ${args}.` };
			}
			case "name": {
				if (!this.recorder || args === "") return { output: "Usage: /name <name>" };
				await this.recorder.setName(args);
				await this.extensions.notifySessionInfoChanged(args, this.agent.extensionContext());
				return { output: `Session named "${args}".` };
			}
			case "new": {
				const result = await this.newSession();
				return { output: result.cancelled ? "New session cancelled by an extension." : "New session." };
			}
			case "help":
			case "hotkeys":
			case "clear":
			case "copy":
			case "tools":
			case "settings":
			case "reasoning":
			case "quit":
			case "exit":
				return { output: `/${name} is a terminal command; it does nothing here.` };
			default:
				return undefined;
		}
	}

	/** The last assistant answer's text (pi get_last_assistant_text). */
	lastAssistantText(): string | undefined {
		const last = this.agent.messages.findLast((message) => message.role === "assistant");
		return last ? messageText(last) : undefined;
	}

	/** User and custom message text of the session, for previews. */
	static contentText(content: UserContent): string {
		return userContentText(content);
	}
}
