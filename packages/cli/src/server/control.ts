// Session control in the hub (P57): what the TUI did on its own Agent, now done here for any client —
// model and reasoning switches with their extension hooks, permission mode, names and labels, tools,
// compaction and moves in the tree (jobs), `!` commands, /btw, /reload, /handoff, checkpoints.
// Each follows the TUI code it replaces (tui/sessions.ts, tui/runs.ts, tui/commands.ts).
import {
	type PermissionMode,
	TauError,
	type ThinkingLevel,
	type ToolCall,
	type UserContent,
	userContentText,
} from "@yophon/tau-kernel";
import { type ClientRequests, ERROR_CODES, JsonRpcError, type NativeEvent } from "@yophon/tau-protocol";
import { isPermissionMode } from "../args.ts";
import { generateHandoffPrompt } from "../handoff.ts";
import { THINKING_LEVELS } from "../modes/headless.ts";
import type { HubThread } from "./thread.ts";

type Result<M extends keyof ClientRequests> = ClientRequests[M]["result"];

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

function isAbort(error: unknown): boolean {
	if (!(error instanceof Error)) return false;
	if (error.name === "AbortError") return true;
	return "code" in error && error.code === "aborted";
}

/** /model (tui/sessions.ts switchModel): the table may switch provider and protocol; extensions may refuse or rewrite. */
export async function setModel(thread: HubThread, requested: string): Promise<Result<"thread/setModel">> {
	const { session, host } = thread;
	const resolved = host.resolveModelSwitch?.(requested);
	if (resolved && "error" in resolved) throw new JsonRpcError(ERROR_CODES.invalidParams, resolved.error);
	const previous = session.agent.model;
	const target = resolved ? resolved.model : requested;
	const decision = await session.extensions.runModelSelectBefore(
		{ currentModel: previous, requestedModel: target },
		session.agent.extensionContext(),
	);
	if (decision.cancel) return { cancelled: decision.reason ? { reason: decision.reason } : {} };
	// An extension that rewrote the choice gets exactly its id, on the current provider.
	const followsTable = resolved !== undefined && decision.model === target;
	if (followsTable) resolved.commit();
	else host.setHostModel?.(decision.model);
	session.modelDisplay = followsTable ? resolved.display : decision.model;
	thread.modelChoices = [...new Set([session.modelDisplay, ...thread.modelChoices])];
	// The agent sends the model with each request and logs a model_change entry (P23d).
	session.agent.setModel(decision.model, followsTable ? resolved.options : {});
	await session.extensions.notifyModelSelected(
		{ previousModel: previous, requestedModel: target, selectedModel: decision.model },
		session.agent.extensionContext(),
	);
	thread.emitState();
	return { model: session.modelDisplay };
}

/** /thinking (tui/sessions.ts switchThinking). */
export async function setThinking(
	thread: HubThread,
	requested: string | undefined,
): Promise<Result<"thread/setThinking">> {
	if (requested !== undefined && !(THINKING_LEVELS as readonly string[]).includes(requested)) {
		throw new JsonRpcError(ERROR_CODES.invalidParams, `Unknown reasoning level ${requested}`);
	}
	const { session } = thread;
	const previous = session.agent.thinkingLevel;
	const level = requested as ThinkingLevel | undefined;
	const decision = await session.extensions.runThinkingLevelSelectBefore(
		{ currentLevel: previous, requestedLevel: level },
		session.agent.extensionContext(),
	);
	if (decision.cancel) return { cancelled: decision.reason ? { reason: decision.reason } : {} };
	session.setThinking(decision.level);
	await session.extensions.notifyThinkingLevelSelected(
		{ previousLevel: previous, requestedLevel: level, selectedLevel: decision.level },
		session.agent.extensionContext(),
	);
	thread.emitState();
	return decision.level !== undefined ? { level: decision.level } : {};
}

export function setPermissionMode(thread: HubThread, mode: string): void {
	if (!isPermissionMode(mode)) throw new JsonRpcError(ERROR_CODES.invalidParams, `Unknown permission mode ${mode}`);
	thread.session.setPermissionMode(mode as PermissionMode);
	thread.emitState();
}

export async function setName(thread: HubThread, name: string): Promise<void> {
	const recorder = thread.session.recorder;
	if (!recorder) throw new JsonRpcError(ERROR_CODES.invalidRequest, "No session file (--no-session)");
	await recorder.setName(name);
	await thread.session.extensions.notifySessionInfoChanged(name, thread.session.agent.extensionContext());
	thread.renamed(name);
}

export async function entries(thread: HubThread): Promise<Result<"thread/entries">> {
	const store = thread.session.store;
	if (!store) return { entries: [], leafId: null };
	return {
		entries: (await store.getEntries()) as unknown as Result<"thread/entries">["entries"],
		leafId: await store.getLeafId(),
	};
}

/** /compact (tui/runs.ts runCompact), as a job. */
export function compact(thread: HubThread, instructions: string | undefined): Promise<Result<"thread/compact">> {
	const count = thread.session.agent.messages.filter((message) => message.role !== "system").length;
	return thread.runTask("compaction", `Compacting ${count} messages`, async (signal) => {
		try {
			const result = await thread.session.agent.compact(instructions, "manual", signal);
			return result
				? { compacted: true, summary: result.summary, tokensBefore: result.tokensBefore }
				: { compacted: false };
		} catch (error) {
			if (isAbort(error)) return { compacted: false, cancelled: "interrupted" };
			if (error instanceof TauError && error.code === "cancelled") return { compacted: false, cancelled: "extension" };
			throw new JsonRpcError(ERROR_CODES.internalError, `Compaction failed: ${errorText(error)}`);
		}
	});
}

/**
 * /tree's move (tui/runs.ts navigate), as a job: a failed branch summary asks whether to move without
 * one (P23e).
 */
export function navigate(
	thread: HubThread,
	params: ClientRequests["thread/navigate"]["params"],
): Promise<Result<"thread/navigate">> {
	const summarize = params.summarize !== false;
	return thread.runTask("navigate", summarize ? "Summarizing the branch" : "Moving", async (signal) => {
		const { agent } = thread.session;
		try {
			try {
				return await agent.navigateTo(params.entryId, {
					signal,
					summarize,
					...(params.customInstructions !== undefined ? { customInstructions: params.customInstructions } : {}),
				});
			} catch (error) {
				if (!(error instanceof TauError && error.code === "compaction_failed")) throw error;
				const without = await thread.ui.confirm("Branch summary failed. Navigate without a summary?", error.message);
				if (!without) return { cancelled: true };
				return await agent.navigateTo(params.entryId, { summarize: false, signal });
			}
		} catch (error) {
			if (isAbort(error)) return { cancelled: true, interrupted: true };
			throw new JsonRpcError(ERROR_CODES.internalError, errorText(error));
		}
	});
}

/** /btw (P39c): answered at once, even while a turn runs; the text streams to the asking client only. */
export async function aside(
	thread: HubThread,
	params: ClientRequests["thread/aside"]["params"],
	onText: (delta: string) => void,
): Promise<Result<"thread/aside">> {
	const result = await thread.session.agent.askAside(params.question, {
		...(params.exchanges ? { exchanges: params.exchanges } : {}),
		onText,
	});
	thread.emitState();
	return { text: result.text, toolCalls: result.toolCalls, stopReason: result.stopReason };
}

/**
 * A `!` command (tui/runs.ts runUserBash), as a job: user_bash hooks first; the output streams to
 * native clients as the tool events of a `bash` call; recorded, it joins the context.
 */
export async function bash(
	thread: HubThread,
	params: ClientRequests["thread/bash"]["params"],
): Promise<Result<"thread/bash">> {
	const { session } = thread;
	const decision = await session.extensions.runUserBash(
		{ command: params.command, recordInContext: params.record, cwd: thread.cwd },
		session.agent.extensionContext(),
	);
	if (decision.cancel) {
		return {
			output: "",
			exitCode: -1,
			cancelled: true,
			...(decision.reason ? { reason: decision.reason } : {}),
			recorded: false,
		};
	}
	const command = decision.command.trim();
	if (command === "") return { output: "", exitCode: -1, cancelled: true, reason: "empty command", recorded: false };
	const call: ToolCall = {
		type: "toolCall",
		id: `user-bash-${++thread.bashRuns}`,
		name: "bash",
		arguments: { command },
	};
	const event = (value: unknown): void =>
		thread.emit({ method: "thread/event", params: { event: value as NativeEvent } });
	return thread.runTask("bash", "Running command", async (signal) => {
		event({ type: "tool_start", toolCall: call });
		try {
			const result = await session.options.workspace.shell.exec(command, {
				signal,
				onStdout: (chunk) => event({ type: "tool_update", toolCall: call, partialOutput: chunk, stream: "stdout" }),
				onStderr: (chunk) => event({ type: "tool_update", toolCall: call, partialOutput: chunk, stream: "stderr" }),
			});
			const output = formatShellOutput(result);
			event({
				type: "tool_result",
				toolCall: call,
				result: {
					content: [{ type: "text", text: output }],
					isError: result.exitCode !== 0,
					structuredContent: { exit_code: result.exitCode },
				},
			});
			if (decision.recordInContext) {
				await session.agent.appendMessage({
					role: "custom",
					customType: "user_bash",
					content: [`$ ${command}`, output].join("\n\n"),
					display: true,
					details: { command, stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode },
					timestamp: Date.now(),
				});
			}
			return {
				output,
				exitCode: result.exitCode,
				cancelled: false,
				recorded: decision.recordInContext,
				stdout: result.stdout,
				stderr: result.stderr,
			};
		} catch (error) {
			if (isAbort(error) || signal.aborted) {
				event({
					type: "tool_result",
					toolCall: call,
					result: { content: [{ type: "text", text: "(interrupted)" }], isError: true },
				});
				return { output: "", exitCode: -1, cancelled: true, recorded: false };
			}
			throw new JsonRpcError(ERROR_CODES.internalError, `Command failed: ${errorText(error)}`);
		}
	});
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

/** Take queued steering and follow-ups back (pi restoreQueuedMessagesToEditor). */
export function clearQueue(thread: HubThread): Result<"thread/clearQueue"> {
	const { steering, followUp } = thread.session.agent.clearQueue();
	const text = (message: (typeof steering)[number]): string =>
		typeof message.content === "string" ? message.content : userContentText(message.content as UserContent);
	// Your own messages come back; extension messages queued meanwhile are dropped (the TUI always did).
	const own = (messages: typeof steering): string[] => messages.filter((message) => message.role === "user").map(text);
	return { steering: own(steering), followUp: own(followUp) };
}

/**
 * /reload (tui/sessions.ts reloadExtensions), as a job: the extensions shut down, load again and
 * start with reason "reload"; on failure the old ones come back.
 */
export function reload(thread: HubThread): Promise<void> {
	return thread.runTask("reload", "Reloading extensions", async () => {
		const { session, workspace } = thread;
		const previousExtensions = session.extensions;
		const previousAgent = session.agent;
		let previousShutdown = false;
		try {
			await previousExtensions.notifySessionShutdown("quit", previousAgent.extensionContext());
			previousShutdown = true;
			thread.resetAutocomplete();
			const nextExtensions = await workspace.reloadExtensions(thread.ui);
			const nextAgent = workspace.buildAgent([...previousAgent.messages], session.recorder, nextExtensions);
			// Host actions first, then session_start: a handler that submits a prompt there must find
			// the new agent (P23e, pi bindExtensions order).
			session.agent = nextAgent;
			session.adoptRegistry(nextExtensions);
			await thread.ensureSessionEvents();
			await nextExtensions.notifySessionStart("reload", nextAgent.extensionContext());
			// Only now that the new registry took over: an api/ctx captured from the old one throws
			// instead of reaching the new agent (pi runtime invalidate).
			previousExtensions.invalidate();
			thread.lastSessionStart = "reload";
			thread.extensionsVersion++;
		} catch (error) {
			session.agent = previousAgent;
			session.adoptRegistry(previousExtensions);
			if (previousShutdown) {
				await previousExtensions.notifySessionStart("resume", previousAgent.extensionContext()).catch(() => undefined);
			}
			throw new JsonRpcError(ERROR_CODES.internalError, `Reload failed: ${errorText(error)}`);
		}
	});
}

/** /handoff (P37b): the prompt for a new session, as a job; the client then starts that session. */
export function handoff(thread: HubThread, goal: string): Promise<Result<"thread/handoff">> {
	return thread.runTask("handoff", "Generating handoff prompt", async (signal) => {
		const { agent } = thread.session;
		try {
			// Empty when the model wrote nothing: the client says so.
			return { prompt: await generateHandoffPrompt(agent, agent.messages, goal, signal) };
		} catch (error) {
			if (isAbort(error)) return { cancelled: true };
			throw error instanceof JsonRpcError ? error : new JsonRpcError(ERROR_CODES.internalError, errorText(error));
		}
	});
}

function checkpointBackend(thread: HubThread) {
	return thread.host.checkpoints?.(thread.id, thread.session.agent.extensionContext().capabilities?.fs);
}

export async function checkpoints(thread: HubThread): Promise<Result<"thread/checkpoints">> {
	const backend = checkpointBackend(thread);
	if (!backend) return { available: false, checkpoints: [] };
	const list = await backend.list();
	return {
		available: true,
		checkpoints: list.map((checkpoint) => ({
			id: checkpoint.id,
			label: checkpoint.label,
			timestamp: checkpoint.timestamp,
			files: checkpoint.files.map((file) => ({ path: file.path })),
		})),
	};
}

export async function restoreCheckpoint(
	thread: HubThread,
	checkpointId: string,
): Promise<Result<"thread/restoreCheckpoint">> {
	const backend = checkpointBackend(thread);
	if (!backend) throw new JsonRpcError(ERROR_CODES.invalidRequest, "Checkpoints are off");
	const result = await backend.restore(checkpointId);
	return { restored: result.restored, deleted: result.deleted };
}
