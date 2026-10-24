// The line-based REPL and one-shot runs on readline (P50: split out of main.ts): a prompt on
// stdin and steering while a turn runs, the [y]/[a]/[N] approval question, the REPL's own slash
// commands (/compact, /tree, /fork, /name, /sessions), and OSC 7501 status (P49).

import {
	type Agent,
	type AgentMessage,
	type ApprovalRequest,
	commandPromptContent,
	type ExtensionRegistry,
	messageText,
	restoreSession,
	SessionRecorder,
	type SessionRepo,
	type SessionStore,
	TauError,
	thinkingText,
	toolResultText,
	type UiCapability,
	type UserContent,
	userContentText,
} from "@yophon/tau-kernel";
import { dirtyRepoQuestion, uncommittedFiles } from "../dirty-repo.ts";
import { initialContent, type ProcessedFiles } from "../file-args.ts";
import type { HostApprovalRequest } from "../permissions.ts";
import { autoTitle, autoTitleOn } from "../session-title.ts";
import type { TauSettings } from "../settings.ts";
import { conversationLength } from "../tui/format.ts";
import type { ProgramStatus } from "../tui/terminal-status.ts";
import { ask, cyan, dim, firstLine, type Readline, red } from "../util.ts";
import { finishWorktree, type WorktreeSession } from "../worktree.ts";

// Approvals (P15): "always allow" saves permission rules since P37a (permissions.ts).
export type ApprovalChoice = "once" | "always" | "deny";

export function createUi(readline: Readline): UiCapability {
	return {
		confirm: async (title, message) => {
			if (message) console.log(dim(message));
			const answer = await ask(readline, `${title} [y/N] `);
			return /^y(es)?$/i.test(answer?.trim() ?? "");
		},
		input: async (title) => {
			const answer = await ask(readline, `${title}: `);
			return answer === "" ? undefined : answer;
		},
		select: async (title, options) => {
			console.log(title);
			for (const [i, option] of options.entries()) console.log(`  ${i + 1}. ${option}`);
			const answer = await ask(readline, "> ");
			const index = Number.parseInt(answer?.trim() ?? "", 10) - 1;
			return options[index];
		},
		// P35: numbers separated by spaces or commas; nothing valid = cancelled.
		selectMany: async (title, options) => {
			console.log(title);
			for (const [i, option] of options.entries()) console.log(`  ${i + 1}. ${option}`);
			const answer = await ask(readline, "numbers, separated by spaces > ");
			const picked = [...new Set((answer ?? "").split(/[\s,，、]+/).map((part) => Number.parseInt(part, 10) - 1))]
				.filter((index) => index >= 0 && index < options.length)
				.map((index) => options[index] as string);
			return picked.length > 0 ? picked : undefined;
		},
		notify: (message, level) => {
			const paint = level === "error" ? red : level === "warning" ? cyan : dim;
			console.log(paint(message));
		},
	};
}

/** Abort controller of the currently running turn, if any (consulted by the REPL's SIGINT handling). */
export const turnState: { controller: AbortController | null; lastAborted: boolean } = {
	controller: null,
	lastAborted: false,
};

/** P49: the REPL's status for the terminal (OSC 7501); set only in an interactive REPL with tui.title on. */
export let replStatus: ProgramStatus | undefined;

/** A REPL command holding the agent outside a turn (P23e): extension prompts are refused meanwhile. */
export let hostTask: "compact" | "tree" | undefined;

export let hostTaskController: AbortController | undefined;

/** Approval prompts say when the call came from another tool (a codemode script, P24c). */
export function nestedNote(request: ApprovalRequest): string {
	if (request.subagent !== undefined) return `, called by subagent ${request.subagent}`;
	return request.parentToolCallId === undefined ? "" : ", called by another tool";
}

/** Resolver for the single readline line currently awaited by an approval gate. */
export let pendingApproval: { resolve: (choice: ApprovalChoice) => void } | undefined;

/** Marks the current readline event when an approval answer was consumed. */
export let approvalLineConsumed = false;

export function consumeApprovalLine(line: string): boolean {
	const pending = pendingApproval;
	if (!pending) return false;
	pendingApproval = undefined;
	const answer = line.trim().toLowerCase();
	const choice: ApprovalChoice =
		answer === "a" || answer === "always" ? "always" : answer === "y" || answer === "yes" ? "once" : "deny";
	pending.resolve(choice);
	approvalLineConsumed = true;
	// When a turn owns the readline listener there is no outer REPL loop to clear
	// this marker; let the current event finish before resetting it.
	setTimeout(() => {
		approvalLineConsumed = false;
	}, 0);
	return true;
}

export function cancelPendingApproval(): void {
	const pending = pendingApproval;
	if (!pending) return;
	pendingApproval = undefined;
	pending.resolve("deny");
}

/**
 * Run one prompt in the REPL or -p. Returns false when it failed: the last reply
 * errored, was aborted or was cut off by the output limit, or the run threw —
 * -p turns that into exit code 1 (pi print mode). Failures go to stderr.
 */
/**
 * P61: lines from a pipe (stdin is not a terminal), queued from the start. Lines read before a turn
 * starts wait their turn, one after another (`printf 'a\nb\nexit\n' | tau --repl` runs both); a
 * line that arrives while a turn runs is steering, as typed in a terminal. The end of the input
 * waits for the queued lines.
 */
export class PipedLines {
	private readonly lines: string[] = [];
	private ended = false;
	private wake: (() => void) | undefined;
	/** A turn runs: a new line is steering (runTurn's listener), not queued. */
	turnRunning = false;

	constructor(readline: Readline) {
		readline.on("line", (line) => {
			if (this.turnRunning) return;
			this.lines.push(line);
			this.wake?.();
		});
		readline.on("close", () => {
			this.ended = true;
			this.wake?.();
		});
	}

	/** The next queued line; undefined once the input ended and nothing is left. */
	async next(): Promise<string | undefined> {
		while (this.lines.length === 0 && !this.ended) {
			await new Promise<void>((resolve) => {
				this.wake = resolve;
			});
		}
		this.wake = undefined;
		return this.lines.shift();
	}
}

/** The REPL's piped input, when stdin is not a terminal (P61). */
let pipedLines: PipedLines | undefined;

export async function runTurn(agent: Agent, input: UserContent | null, readline: Readline): Promise<boolean> {
	const controller = new AbortController();
	turnState.controller = controller;
	if (pipedLines) pipedLines.turnRunning = true;
	const onSigint = (): void => {
		controller.abort();
	};
	process.on("SIGINT", onSigint);
	// Lines typed while the turn is running become steering messages.
	const onLine = (line: string): void => {
		const text = line.trim();
		// An approval question uses the same readline stream.  Do not turn its
		// answer into a steering message for the agent that is waiting on it.
		if (approvalLineConsumed || consumeApprovalLine(text) || pendingApproval) return;
		if (text !== "") void agent.steer(text);
	};
	readline.on("line", onLine);
	let sawReasoning = false;
	let lastStop: string | undefined;
	let threw = false;
	replStatus?.set("working", { msg: "Working" });
	try {
		// input null = continuation without new user input (extension triggerTurn).
		const stream = input === null ? agent.resume(controller.signal) : agent.prompt(input, controller.signal);
		for await (const event of stream) {
			switch (event.type) {
				case "reasoning_delta":
					sawReasoning = true;
					process.stdout.write(dim(event.delta));
					break;
				case "text_delta":
					if (sawReasoning) {
						sawReasoning = false;
						process.stdout.write("\n\n");
					}
					process.stdout.write(event.delta);
					break;
				case "assistant_message":
					lastStop = event.message.stopReason;
					if (event.message.stopReason === "aborted") {
						process.stderr.write(`\n${dim("Turn aborted.")}\n`);
						break;
					}
					if (event.message.stopReason === "error") {
						process.stderr.write(`\n${red(`Error: ${event.message.errorMessage ?? "unknown provider error"}`)}\n`);
						break;
					}
					if (messageText(event.message) !== "" || thinkingText(event.message) !== "") process.stdout.write("\n");
					if (event.message.stopReason === "length") {
						// The partial text is already printed (pi 1.2.0 #10799).
						process.stderr.write(`${dim("[warning: the reply hit the output token limit and is incomplete]")}\n`);
					}
					break;
				case "user_message":
					process.stdout.write(dim(`↳ steered: ${firstLine(messageText(event.message))}\n`));
					break;
				case "tool_start":
					process.stdout.write(
						`${cyan(`⚙ ${event.toolCall.name}`)} ${dim(firstLine(JSON.stringify(event.toolCall.arguments)))}\n`,
					);
					break;
				case "tool_update":
					break;
				case "compaction":
					process.stdout.write(dim(`[compacted: ~${event.result.tokensBefore} tokens summarized]\n`));
					break;
				case "compaction_failed":
					process.stdout.write(
						dim(
							event.aborted
								? `[${event.reason} compaction aborted]\n`
								: `[${event.reason} compaction failed${event.reason === "overflow" ? "" : ", continuing"}: ${firstLine(event.errorMessage ?? "")}]\n`,
						),
					);
					break;
				case "auto_retry_start":
					process.stdout.write(
						dim(
							`[retry ${event.attempt}/${event.maxAttempts} in ${Math.round(event.delayMs / 1000)}s: ${firstLine(event.errorMessage)}]\n`,
						),
					);
					break;
				case "auto_retry_end":
					if (!event.success && event.finalError !== undefined) {
						process.stdout.write(dim(`[retry gave up after ${event.attempt}: ${firstLine(event.finalError)}]\n`));
					}
					break;
				case "tool_result": {
					const marker = event.result.isError ? red("✗") : dim("✓");
					process.stdout.write(`${marker} ${dim(firstLine(toolResultText(event.result)))}\n`);
					break;
				}
				case "agent_end": {
					const last = agent.messages.at(-1);
					if (last?.role === "assistant" && last.usage.totalTokens > 0) {
						// Cache hits are no longer part of `input` (P23d, pi usage).
						const cached = last.usage.cacheRead > 0 ? ` (+${last.usage.cacheRead} cached)` : "";
						process.stdout.write(dim(`[tokens: ${last.usage.input} in${cached}, ${last.usage.output} out]\n`));
					}
					break;
				}
			}
		}
	} catch (error) {
		threw = true;
		const message = error instanceof Error ? error.message : String(error);
		process.stderr.write(`\n${red(`Error: ${message}`)}\n`);
	} finally {
		replStatus?.set(threw || lastStop === "error" ? "error" : "done", {
			msg: threw || lastStop === "error" ? "Failed" : "Done",
		});
		cancelPendingApproval();
		turnState.controller = null;
		turnState.lastAborted = lastStop === "aborted";
		if (pipedLines) pipedLines.turnRunning = false;
		readline.removeListener("line", onLine);
		process.removeListener("SIGINT", onSigint);
		// Queues survive an abort (kernel contract): drop what the run left instead of
		// replaying it into the next prompt, and say so — a REPL has no editor to refill.
		const { steering, followUp } = agent.clearQueue();
		for (const message of [...steering, ...followUp]) {
			const text = message.role === "user" ? userContentText(message.content) : `[${message.customType}]`;
			process.stdout.write(dim(`[dropped queued message: ${firstLine(text)}]\n`));
		}
	}
	return !threw && lastStop !== "error" && lastStop !== "aborted" && lastStop !== "length";
}

export async function runCommand(
	agent: Agent,
	extensions: ExtensionRegistry,
	input: string,
	readline: Readline,
): Promise<void> {
	const spaceIndex = input.indexOf(" ");
	const name = (spaceIndex === -1 ? input : input.slice(0, spaceIndex)).slice(1);
	const args = spaceIndex === -1 ? "" : input.slice(spaceIndex + 1).trim();
	if (name === "help") {
		const commands = [...extensions.commands.values()].filter((command) => !command.hidden);
		if (commands.length === 0) console.log(dim("No extension commands registered."));
		for (const command of commands) console.log(`/${command.name} — ${command.description}`);
		return;
	}
	const command = extensions.commands.get(name);
	if (!command) {
		console.log(red(`Unknown command: /${name} (try /help)`));
		return;
	}
	try {
		const output = await command.handler(args, agent.extensionContext());
		// Extension actions (sendMessage, appendEntry, …) append to the log asynchronously (P22).
		await agent.flush();
		if (typeof output === "string") {
			console.log(output);
		} else if (output?.action === "prompt") {
			// P44: UserPromptExpansion hooks may stop the prompt the command expands to.
			const expansion = await extensions.runCommandPrompt(
				{ command: name, args, source: command.source ?? "extension", text: output.text },
				agent.extensionContext(),
			);
			if (expansion.cancel) {
				console.log(red(`/${name} blocked${expansion.reason ? `: ${expansion.reason}` : "."}`));
				return;
			}
			await runTurn(agent, commandPromptContent(output), readline);
		}
	} catch (error) {
		console.log(red(`Command failed: ${error instanceof Error ? error.message : String(error)}`));
	}
}

/**
 * The [y]/[a]/[N] approval question on the terminal: shared by the REPL and one-shot TTY runs
 * (the TUI replaces it with its approval panel). The answer arrives as the next line typed.
 */
export async function readlineApprovalPrompt(request: HostApprovalRequest): Promise<ApprovalChoice> {
	console.log(`${cyan(`Approval: ${request.toolName}`)} ${dim(`(${request.risk} risk${nestedNote(request)})`)}`);
	if (request.reason) console.log(dim(request.reason));
	console.log(dim(firstLine(JSON.stringify(request.args), 200)));
	process.stdout.write(
		request.always ? `\nAllow? [y]es once / [a] ${request.always.label} / [N]o ` : "\nAllow? [y]es once / [N]o ",
	);
	replStatus?.set("blocked", { kind: "permission", msg: `Approval: ${request.toolName}` });
	const choice = await new Promise<ApprovalChoice>((resolve) => {
		// Tool preflight is serial, but resolving a stale gate defensively keeps
		// an aborted/closed turn from blocking the next one forever.
		cancelPendingApproval();
		pendingApproval = { resolve };
	});
	if (turnState.controller) replStatus?.set("working", { msg: "Working" });
	return choice;
}

/** What the REPL runs with (P50: the part of main() after the workspace opened). */
export interface ReplContext {
	readline: Readline;
	agent: Agent;
	buildAgent(messages: AgentMessage[] | undefined, session: SessionRecorder | undefined): Agent;
	extensions: ExtensionRegistry;
	workspace: { settings(): TauSettings; background: { stopAll(): void } };
	ui: UiCapability | undefined;
	sessionRepo: SessionRepo;
	store: SessionStore | undefined;
	recorder: SessionRecorder | undefined;
	sessionReason: "startup" | "resume";
	/** `@file` arguments and further messages from the command line (P36c). */
	files: ProcessedFiles;
	messages: string[];
	/** The startup line. */
	banner: { model: string; baseUrl: string; provider: string; cwd: string; permissionMode: string | undefined };
	contextWindow: number | undefined;
	/** tui.title: OSC 7501 status for the terminal (P49). */
	terminalStatus: boolean;
	/** Sessions already given a title (P34f). */
	titled: Set<string>;
	worktreeSession: WorktreeSession | undefined;
	/** P61: stdin is a pipe — its lines, queued since tau started reading. */
	pipedLines?: PipedLines;
}

/** The line-based REPL until "exit" or the end of input. */
export async function runRepl(context: ReplContext): Promise<void> {
	const { readline, buildAgent, extensions, workspace, ui, sessionRepo, sessionReason, files, messages, titled } =
		context;
	const { model, baseUrl: effectiveBaseUrl, provider, cwd, permissionMode } = context.banner;
	const { contextWindow, worktreeSession } = context;
	let { agent, store, recorder } = context;
	pipedLines = context.pipedLines;
	/** P61: with piped input, whether the last line's turn went well (the exit code; Ctrl+C is no failure). */
	let lastTurnOk = true;
	// P49: the REPL tells the terminal it is working, waiting or done (OSC 7501), with tui.title.
	if (process.stdout.isTTY && context.terminalStatus) {
		const { ProgramStatus } = await import("../tui/terminal-status.ts");
		replStatus = new ProgramStatus((data) => process.stdout.write(data));
	}
	if (contextWindow === undefined) {
		console.log(dim("No --context-window configured: auto-compaction is off (use /compact manually)."));
	}
	// Host actions for extension-triggered runs (sendUserMessage / sendMessage
	// triggerTurn while idle). Closures read the live `agent` binding, so they
	// stay correct across /fork agent swaps.
	// Runs requested while a turn was finishing (agent_settled handlers) start after it.
	const pendingStarts: (UserContent | null)[] = [];
	const startPending = (): void => {
		if (turnState.controller || hostTask) return;
		const next = pendingStarts.shift();
		if (next !== undefined) void runTurn(agent, next, readline).finally(startPending);
	};
	extensions.attachHostActions({
		submitPrompt: (content) => {
			if (turnState.controller) {
				pendingStarts.push(content);
				return;
			}
			// A compaction or navigation holds the REPL: refuse loudly so the caller can retry (HF-11).
			if (hostTask) throw new TauError("busy", `/${hostTask} is running`);
			void runTurn(agent, content, readline).finally(startPending);
		},
		resumeTurn: () => {
			if (turnState.controller || hostTask) {
				if (!pendingStarts.includes(null)) pendingStarts.push(null);
				return;
			}
			void runTurn(agent, null, readline).finally(startPending);
		},
		shutdown: () => {
			readline.close();
		},
	});
	// session_start after the host actions are in place (P23e, pi bindExtensions order).
	await extensions.notifySessionStart(sessionReason, agent.extensionContext());
	const extensionNote = extensions.tools.size + extensions.commands.size > 0 ? " · extensions loaded" : "";
	const providerNote = provider === "anthropic" ? " · anthropic" : "";
	console.log(
		dim(
			`tau · ${model} @ ${effectiveBaseUrl}${providerNote} · cwd ${cwd} · ${permissionMode}${extensionNote} · "exit" or Ctrl+D to quit`,
		),
	);
	// In a TTY, readline intercepts Ctrl+C: abort the running turn if there is
	// one, otherwise quit the REPL.
	readline.on("SIGINT", () => {
		if (turnState.controller) {
			turnState.controller.abort();
		} else if (hostTaskController) {
			hostTaskController.abort();
		} else {
			readline.close();
		}
	});
	// Command-line prompts (P36c) before the first "tau> ".
	const replFirst = initialContent(files, messages[0]);
	if (replFirst !== undefined) {
		for (const prompt of [replFirst, ...messages.slice(1)]) {
			if (!(await runTurn(agent, prompt, readline))) break;
		}
	}
	while (true) {
		let line: string | undefined;
		if (pipedLines) {
			process.stdout.write("tau> ");
			line = await pipedLines.next();
		} else line = await ask(readline, "tau> ");
		if (line === undefined) break;
		replStatus?.active();
		const input = line.trim();
		// A Feishu-triggered run can start while this outer question is pending.
		// Its line listener (above) has already handled the line as steering (or
		// the approval question has consumed it).  Wait for that run to finish
		// before opening another `readline.question`; concurrent questions are what
		// previously caused approval answers to launch a second prompt().
		const approvalConsumed = approvalLineConsumed || consumeApprovalLine(input);
		approvalLineConsumed = false;
		if (turnState.controller || approvalConsumed) {
			while (turnState.controller) await new Promise<void>((resolve) => setTimeout(resolve, 10));
			continue;
		}
		if (input === "") continue;
		if (input === "exit" || input === "quit") break;
		if (input.startsWith("/")) {
			if (input === "/sessions") {
				for (const session of await sessionRepo.list()) {
					console.log(`${session.timestamp}  ${session.name ?? dim("(unnamed)")}  ${dim(session.filePath ?? "")}`);
				}
				continue;
			}
			if (input === "/compact" || input.startsWith("/compact ")) {
				const instructions = input.slice("/compact".length).trim();
				hostTask = "compact";
				hostTaskController = new AbortController();
				try {
					const result = await agent.compact(
						instructions === "" ? undefined : instructions,
						"manual",
						hostTaskController.signal,
					);
					console.log(
						result ? dim(`Compacted: ~${result.tokensBefore} tokens summarized.`) : dim("Nothing to compact."),
					);
				} catch (error) {
					if (error instanceof TauError && error.code === "cancelled") console.log(dim("Compaction cancelled."));
					else if (error instanceof TauError && error.code === "aborted") console.log(dim("Compaction aborted."));
					else console.log(red(`Compaction failed: ${error instanceof Error ? error.message : String(error)}`));
				} finally {
					hostTask = undefined;
					hostTaskController = undefined;
					startPending();
				}
				continue;
			}
			if (input.startsWith("/name ")) {
				const name = input.slice("/name ".length).trim();
				if (recorder && name !== "") {
					await agent.setSessionName(name);
					await extensions.notifySessionInfoChanged(name, agent.extensionContext());
					console.log(dim(`Session named "${name}".`));
				} else {
					console.log(red(recorder ? "Usage: /name <name>" : "No active session (--no-session)."));
				}
				continue;
			}
			if (input === "/tree" || input.startsWith("/tree ")) {
				if (!store) {
					console.log(red("No active session (--no-session)."));
					continue;
				}
				const arg = input.slice("/tree".length).trim();
				if (arg === "") {
					const entries = await store.getEntries();
					const onPath = new Set((await store.getPathToRoot(await store.getLeafId())).map((entry) => entry.id));
					let shown = 0;
					for (const entry of entries) {
						if (entry.type !== "message" || entry.message.role !== "user") continue;
						const marker = onPath.has(entry.id) ? "●" : dim("○");
						console.log(`${marker} ${cyan(entry.id)}  ${firstLine(messageText(entry.message), 80)}`);
						shown++;
					}
					console.log(
						shown === 0
							? dim("No user messages in this session yet.")
							: dim("Jump with /tree <id> (● = on current path)."),
					);
					continue;
				}
				// "/tree <id> --no-summary" navigates without summarizing the abandoned branch.
				const noSummary = arg.endsWith(" --no-summary");
				const target = noSummary ? arg.slice(0, -" --no-summary".length).trim() : arg;
				hostTask = "tree";
				hostTaskController = new AbortController();
				try {
					const result = await agent.navigateTo(target, {
						signal: hostTaskController.signal,
						...(noSummary ? { summarize: false } : {}),
					});
					// Back before one of your messages (pi): its text is shown to send again.
					console.log(
						result.cancelled
							? dim("Navigation cancelled.")
							: result.editorText !== undefined
								? dim(
										`Moved back before that message (${conversationLength(agent.messages)} messages in context). It said:\n${result.editorText}`,
									)
								: dim(`Moved to ${target} (${conversationLength(agent.messages)} messages in context).`),
					);
				} catch (error) {
					console.log(red(`/tree failed: ${error instanceof Error ? error.message : String(error)}`));
					if (error instanceof TauError && error.code === "compaction_failed") {
						console.log(dim(`Navigate without a summary: /tree ${target} --no-summary`));
					}
				} finally {
					hostTask = undefined;
					hostTaskController = undefined;
					startPending();
				}
				continue;
			}
			if (input === "/fork" || input.startsWith("/fork ")) {
				if (!store) {
					console.log(red("No active session (--no-session)."));
					continue;
				}
				const arg = input.slice("/fork".length).trim();
				// pi's dirty-repo-guard (P37b), when session.dirtyRepoGuard turns it on.
				if (workspace.settings().dirtyRepoGuard === true && ui) {
					const count = await uncommittedFiles(cwd);
					if (count) {
						const question = dirtyRepoQuestion(count, "fork");
						if ((await ui.select(question.title, question.options)) !== question.options[0]) {
							console.log(dim("Commit your changes first."));
							continue;
						}
					}
				}
				try {
					// A full copy has no fork point to negotiate over, so the
					// session_before_fork event only fires for entry-targeted forks.
					if (arg !== "") {
						const decision = await extensions.runSessionBeforeFork(
							{ entryId: arg, position: "before" },
							agent.extensionContext(),
						);
						if (decision.cancel) {
							console.log(dim("Fork cancelled."));
							continue;
						}
					}
					const source = await store.getMetadata();
					const newStore = await sessionRepo.fork(source, arg === "" ? undefined : { entryId: arg });
					const meta = await newStore.getMetadata();
					// Switching into the fork is a session switch: extensions may veto it.
					const switchDecision = await extensions.runSessionBeforeSwitch(
						{ reason: "resume", targetSessionFile: meta.filePath },
						agent.extensionContext(),
					);
					if (switchDecision.cancelled) {
						console.log(dim("Session switch cancelled by an extension (fork file kept)."));
						continue;
					}
					const restored = await restoreSession(newStore);
					store = newStore;
					recorder = await SessionRecorder.open(newStore);
					agent = buildAgent(restored.messages, recorder);
					await extensions.notifySessionStart("resume", agent.extensionContext());
					console.log(
						dim(`Forked to ${meta.filePath ?? meta.id} (${conversationLength(restored.messages)} messages).`),
					);
				} catch (error) {
					console.log(red(`/fork failed: ${error instanceof Error ? error.message : String(error)}`));
				}
				continue;
			}
			await runCommand(agent, extensions, input, readline);
			continue;
		}
		lastTurnOk = (await runTurn(agent, input, readline)) || turnState.lastAborted;
		// P34f: name the session after its first turn (in the background; failures are silent).
		if (recorder && autoTitleOn(workspace.settings().autoTitle)) void autoTitle(agent, recorder, titled);
	}
	await extensions.notifySessionShutdown("quit", agent.extensionContext());
	replStatus?.set("clear");
	readline.close();
	if (pipedLines && !lastTurnOk) process.exitCode = 1;
	if (worktreeSession && process.stdin.isTTY) await finishWorktree(worktreeSession, workspace.background);
}
