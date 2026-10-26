/**
 * `tau --mode rpc` (P29, pi rpc.md / rpc-commands.md / rpc-extension-ui.md): a
 * long-lived child process driven by JSONL commands on stdin. Every command may
 * carry an `id`; its single `response` repeats it. Session events stream as in
 * JSON mode (no header). `ctx.ui` dialogs and tool approvals go to the client as
 * `extension_ui_request` records; an approval is a `select` with an extra
 * `approval` field (D20 has no pi counterpart). Closing stdin shuts down.
 * P57: an adapter over tau's protocol — the session lives in an in-process hub (rpc-hub.ts).
 */
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
	type ApprovalRequest,
	askFormStepByStep,
	type ImageContent,
	messageText,
	type PermissionMode,
	type UiCapability,
	type UserContent,
} from "@yophon/tau-kernel";
import { type ClientRequests, ERROR_CODES, type JsonRpcError, type ServerRequests } from "@yophon/tau-protocol";
import { sessionHtml } from "../tui/export-html.ts";
import { type TuiSession, usageOf } from "../tui/session-client.ts";
import { fromWireEvent, fromWireForm, toWireObject } from "../wire.ts";
import { agentEventRecord } from "./events.ts";
import { THINKING_LEVELS } from "./headless.ts";
import { type RecordWriter, readRecords } from "./jsonl.ts";

export type ApprovalChoice = "once" | "always" | "deny";

const APPROVAL_OPTIONS = ["Allow once", "Always allow", "Deny"] as const;
const MODES: readonly PermissionMode[] = ["read-only", "supervised", "ci", "accept-edits", "autonomous", "bypass"];

/** The client side of ctx.ui and approvals: requests out, responses in. */
export class RpcUiBridge {
	private nextId = 1;
	private readonly pending = new Map<string, (response: Record<string, unknown> | undefined) => void>();
	private readonly out: RecordWriter;
	readonly ui: UiCapability;
	/** Whether stdin is being read (listen ran). */
	listening = false;
	/** stdin closed: dialogs are answered "cancelled" at once. */
	private ended = false;
	/** Commands read before the loop took them. */
	private readonly queued: unknown[] = [];
	private onCommand: ((value: unknown) => void) | undefined;
	private onEnd: (() => void) | undefined;

	constructor(out: RecordWriter) {
		this.out = out;
		this.ui = {
			confirm: async (title, message) => {
				const response = await this.request({ method: "confirm", title, ...(message ? { message } : {}) });
				return response?.confirmed === true;
			},
			select: async (title, options) => {
				const response = await this.request({ method: "select", title, options });
				return typeof response?.value === "string" ? response.value : undefined;
			},
			// P35: tau's own method (pi's RPC has none): the client answers { values: string[] }.
			selectMany: async (title, options) => {
				const response = await this.request({ method: "multiselect", title, options });
				const values = Array.isArray(response?.values)
					? response.values.filter((value): value is string => typeof value === "string")
					: undefined;
				return values && values.length > 0 ? values : undefined;
			},
			input: async (title, placeholder) => {
				const response = await this.request({ method: "input", title, ...(placeholder ? { placeholder } : {}) });
				return typeof response?.value === "string" ? response.value : undefined;
			},
			editor: async (title, prefill) => {
				const response = await this.request({ method: "editor", title, ...(prefill !== undefined ? { prefill } : {}) });
				return typeof response?.value === "string" ? response.value : undefined;
			},
			notify: (message, level) => {
				this.out.write({
					type: "extension_ui_request",
					id: `ui-${this.nextId++}`,
					method: "notify",
					message,
					notifyType: level ?? "info",
				});
			},
		};
	}

	/**
	 * A tool approval as a select; the structured request rides along in `approval`. The option
	 * strings stay fixed; the title says what "Always allow" does for this call (P37a), and the
	 * option is left out when only a single approval fits.
	 */
	async approve(request: ApprovalRequest & { always?: { label: string } }): Promise<ApprovalChoice> {
		const who = request.subagent ? ` (subagent ${request.subagent})` : "";
		const always = request.always ? `. "Always allow" = ${request.always.label}` : "";
		const response = await this.request({
			method: "select",
			title: `${request.toolName} wants to run${who}: ${summarizeArgs(request.args)} (${request.risk} risk)${always}`,
			options: request.always ? [...APPROVAL_OPTIONS] : APPROVAL_OPTIONS.filter((option) => option !== "Always allow"),
			approval: {
				toolCallId: request.toolCallId,
				toolName: request.toolName,
				args: request.args,
				risk: request.risk,
				...(request.reason ? { reason: request.reason } : {}),
				...(request.subagent ? { subagent: request.subagent } : {}),
			},
		});
		const value = typeof response?.value === "string" ? response.value : undefined;
		return value === "Allow once" ? "once" : value === "Always allow" ? "always" : "deny";
	}

	/** An `extension_ui_response` from the client; false when no request has that id. */
	settle(record: Record<string, unknown>): boolean {
		const id = typeof record.id === "string" ? record.id : undefined;
		const resolveRequest = id ? this.pending.get(id) : undefined;
		if (!id || !resolveRequest) return false;
		this.pending.delete(id);
		resolveRequest(record.cancelled === true ? undefined : record);
		return true;
	}

	/**
	 * Read stdin from now on. Dialogs asked while tau starts (the project trust question,
	 * session_start handlers) are answered right away; commands wait for takeCommands. Reading
	 * only once the loop ran left a startup dialog waiting for an answer nobody read.
	 */
	listen(input: NodeJS.ReadableStream): void {
		if (this.listening) return;
		this.listening = true;
		readRecords(
			input,
			(value) => {
				const record = value as Record<string, unknown> | null;
				if (typeof record === "object" && record !== null && record.type === "extension_ui_response") {
					this.settle(record);
				} else if (this.onCommand) this.onCommand(value);
				else this.queued.push(value);
			},
			() => {
				this.ended = true;
				this.cancelAll();
				this.onEnd?.();
			},
		);
	}

	/** Hand commands to the loop, those read so far first, and tell it when stdin closes. */
	takeCommands(onCommand: (value: unknown) => void, onEnd: () => void): void {
		this.onCommand = onCommand;
		this.onEnd = onEnd;
		for (const value of this.queued.splice(0)) onCommand(value);
		if (this.ended) onEnd();
	}

	/** Answer every open dialog with "cancelled" (stdin closed). */
	cancelAll(): void {
		for (const [id, resolveRequest] of this.pending) {
			this.pending.delete(id);
			resolveRequest(undefined);
		}
	}

	private request(fields: Record<string, unknown>): Promise<Record<string, unknown> | undefined> {
		if (this.ended) return Promise.resolve(undefined);
		const id = `ui-${this.nextId++}`;
		return new Promise((resolveRequest) => {
			this.pending.set(id, resolveRequest);
			this.out.write({ type: "extension_ui_request", id, ...fields });
		});
	}
}

function summarizeArgs(args: Record<string, unknown>): string {
	const first = Object.values(args).find((value): value is string => typeof value === "string");
	const text = first ?? JSON.stringify(args);
	return text.length > 120 ? `${text.slice(0, 117)}...` : text;
}

export interface RpcModelEntry {
	provider: string;
	id: string;
	name?: string;
	contextWindow?: number;
	maxTokens?: number;
	reasoning?: boolean;
}

export interface RpcModeOptions {
	/** The session shown, already joined (P57: a client of the in-process hub, rpc-hub.ts). */
	session: TuiSession;
	bridge: RpcUiBridge;
	out: RecordWriter;
	input?: NodeJS.ReadableStream;
	cwd: string;
	models: readonly RpcModelEntry[];
}

class CommandError extends Error {}

function text(value: unknown, field: string): string {
	if (typeof value !== "string") throw new CommandError(`"${field}" must be a string`);
	return value;
}

function promptContent(message: string, images: unknown): UserContent {
	if (!Array.isArray(images) || images.length === 0) return message;
	const blocks: ImageContent[] = images.flatMap((image) => {
		const record = (image ?? {}) as Record<string, unknown>;
		return typeof record.data === "string" && typeof record.mimeType === "string"
			? [{ type: "image" as const, data: record.data, mimeType: record.mimeType }]
			: [];
	});
	return [{ type: "text", text: message }, ...blocks];
}

/** The hub's dialogs (ui/request) as the bridge's extension_ui_request records; forms field by field (pi has none). */
export async function answerWithBridge(
	bridge: RpcUiBridge,
	params: ServerRequests["ui/request"]["params"],
): Promise<ServerRequests["ui/request"]["result"]> {
	const value = (answer: string | undefined) => (answer === undefined ? { cancelled: true } : { value: answer });
	switch (params.kind) {
		case "confirm":
			return { confirmed: await bridge.ui.confirm(params.title, params.message) };
		case "select":
			return value(await bridge.ui.select(params.title, params.options ?? []));
		case "selectMany": {
			const values = await bridge.ui.selectMany?.(params.title, params.options ?? []);
			return values === undefined ? { cancelled: true } : { values };
		}
		case "input":
			return value(await bridge.ui.input(params.title, params.placeholder));
		case "editor":
			return value(await bridge.ui.editor?.(params.title, params.prefill));
		case "form": {
			const result = await askFormStepByStep(
				bridge.ui,
				fromWireForm(params.form ?? { title: params.title, fields: [] }),
			);
			return result === undefined ? { cancelled: true } : { form: toWireObject(result) };
		}
		default:
			return { cancelled: true };
	}
}

/** "provider/id" (or a bare id) as get_state's model. */
function modelOf(display: string): { provider: string; id: string } {
	const slash = display.indexOf("/");
	return slash === -1
		? { provider: "", id: display }
		: { provider: display.slice(0, slash), id: display.slice(slash + 1) };
}

/**
 * Run the RPC loop until stdin closes (P57: an adapter over the protocol — pi's commands become
 * requests to the hub, its session records come as thread/sessionEvent, compaction and retry
 * records from thread/event; docs/rpc.md is unchanged).
 */
export async function runRpcMode(options: RpcModeOptions): Promise<void> {
	const { session, bridge, out } = options;
	/** A turn is running (between turn/started and turn/completed, as the hub said). */
	let turnActive = session.state.running;
	session.client.handle("item/tool/requestApproval", async (params) => ({
		decision: await bridge.approve({
			toolCallId: params.toolCallId,
			toolName: params.toolName,
			args: params.args,
			risk: params.risk,
			...(params.reason !== undefined ? { reason: params.reason } : {}),
			...(params.subagent !== undefined ? { subagent: params.subagent } : {}),
			...(params.always !== undefined ? { always: { label: params.always } } : {}),
		}),
	}));
	session.client.handle("ui/request", (params) => answerWithBridge(bridge, params));
	session.attach((notification) => {
		switch (notification.method) {
			case "thread/sessionEvent":
				out.write(notification.params.record);
				return;
			case "thread/event": {
				// The AgentEvents that have no extension hook (compaction, retries).
				const record = agentEventRecord(fromWireEvent(notification.params.event));
				if (record) out.write(record);
				return;
			}
			case "thread/notice":
				bridge.ui.notify(notification.params.text, notification.params.level);
				return;
			case "turn/started":
				turnActive = true;
				return;
			case "turn/completed":
				turnActive = false;
				return;
			default:
		}
	});

	const respond = (id: unknown, command: string, data?: unknown): void =>
		out.write({
			...(typeof id === "string" ? { id } : {}),
			type: "response",
			command,
			success: true,
			...(data !== undefined ? { data } : {}),
		});
	const fail = (id: unknown, command: string, error: string): void =>
		out.write({ ...(typeof id === "string" ? { id } : {}), type: "response", command, success: false, error });
	const messages = () => session.messages;
	const cancelledBy = (error: unknown): boolean => (error as JsonRpcError).code === ERROR_CODES.cancelled;

	// Asked of the hub, not read off the mirror: commands run concurrently, and the hub answers
	// in the order they were sent (a set_permission_mode just before is in it).
	const state = async (): Promise<Record<string, unknown>> => {
		const current = await session.request("thread/state", {});
		await session.drain();
		return {
			model: modelOf(current.model),
			thinkingLevel: current.thinkingLevel ?? "default",
			permissionMode: current.permissionMode,
			isStreaming: turnActive,
			isCompacting: current.task?.kind === "compaction",
			...(current.sessionFile ? { sessionFile: current.sessionFile } : {}),
			sessionId: session.id,
			...(current.name ? { sessionName: current.name } : {}),
			messageCount: messages().filter((message) => message.role !== "system").length,
			pendingMessageCount: current.queued ? 1 : 0,
			autoCompactionEnabled: (current.contextUsage as { contextWindow?: unknown }).contextWindow !== undefined,
		};
	};

	/** Leave this session for another (new, a file, a fork); refused by an extension: cancelled. */
	const move = async (join: () => Promise<unknown>): Promise<{ cancelled: boolean }> => {
		try {
			await join();
			return { cancelled: false };
		} catch (error) {
			if (cancelledBy(error)) return { cancelled: true };
			throw error;
		}
	};

	/**
	 * A `/command` (as HeadlessSession.command did): extension commands run in the hub (a prompt they
	 * ask for is a turn); the built-ins that make sense without a screen run here. Undefined when the
	 * text is not a known command (it is then sent as a prompt).
	 */
	const command = async (message: string): Promise<{ output?: string; started?: boolean } | undefined> => {
		const match = /^\/([\w:-]+)(?:\s+([\s\S]*))?$/.exec(message.trim());
		if (!match) return undefined;
		const name = match[1] ?? "";
		const args = (match[2] ?? "").trim();
		if (!session.commands.has(name)) await session.refreshCommands(true).catch(() => false);
		if (session.commands.has(name)) {
			const outcome = await session.request("command/run", { name, args });
			if (!outcome.unknown) {
				if (outcome.blocked)
					return { output: `/${name} blocked${outcome.blocked.reason ? `: ${outcome.blocked.reason}` : "."}` };
				return {
					...(outcome.output !== undefined ? { output: outcome.output } : {}),
					...(outcome.turn ? { started: true } : {}),
				};
			}
		}
		const { state: current } = session;
		switch (name) {
			case "compact": {
				const result = await session.request("thread/compact", args === "" ? {} : { instructions: args });
				return {
					output: result.compacted ? `Compacted (was ~${result.tokensBefore ?? 0} tokens).` : "Nothing to compact.",
				};
			}
			case "model": {
				if (args === "") return { output: `Model: ${current.model}` };
				try {
					const result = await session.request("thread/setModel", { model: args });
					return {
						output: result.cancelled
							? `Model switch cancelled${result.cancelled.reason ? `: ${result.cancelled.reason}` : "."}`
							: `Model set to ${result.model}.`,
					};
				} catch (error) {
					return { output: error instanceof Error ? error.message : String(error) };
				}
			}
			case "thinking": {
				if (args === "") return { output: `Reasoning effort: ${current.thinkingLevel ?? "default"}` };
				const level = args === "default" ? undefined : args;
				if (level !== undefined && !(THINKING_LEVELS as readonly string[]).includes(level))
					return { output: `Unknown level "${args}".` };
				await session.request("thread/setThinking", level !== undefined ? { level } : {});
				return { output: `Reasoning effort: ${level ?? "default"}.` };
			}
			case "mode": {
				if (args === "") return { output: `Permission mode: ${current.permissionMode}` };
				if (!(MODES as readonly string[]).includes(args)) return { output: `Unknown mode "${args}".` };
				await session.request("thread/setPermissionMode", { mode: args });
				return { output: `Permission mode: ${args}.` };
			}
			case "name": {
				if (!current.sessionFile || args === "") return { output: "Usage: /name <name>" };
				await session.request("thread/setName", { name: args });
				return { output: `Session named "${args}".` };
			}
			case "new": {
				const result = await move(() => session.join("thread/start", { previousThreadId: session.id }));
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
	};

	const handle = async (record: Record<string, unknown>): Promise<void> => {
		const id = record.id;
		const type = typeof record.type === "string" ? record.type : "";
		try {
			switch (type) {
				case "prompt": {
					const message = text(record.message, "message");
					const behavior =
						record.streamingBehavior === "steer" || record.streamingBehavior === "followUp"
							? record.streamingBehavior
							: undefined;
					if (message.trim().startsWith("/")) {
						const handled = await command(message);
						if (handled) {
							if (handled.output) bridge.ui.notify(handled.output, "info");
							respond(id, type, { disposition: handled.started ? "started" : "handled" });
							return;
						}
					}
					const content = promptContent(message, record.images);
					await session.drain();
					if (turnActive) {
						if (!behavior) throw new Error('The agent is running: pass streamingBehavior "steer" or "followUp".');
						const input = content as ClientRequests["turn/steer"]["params"]["input"];
						const result =
							behavior === "steer"
								? await session.request("turn/steer", { input })
								: await session.request("turn/followUp", { input });
						respond(id, type, { disposition: result.disposition ?? "queued" });
						return;
					}
					await session.startTurn(content);
					respond(id, type, { disposition: "started" });
					return;
				}
				case "steer":
				case "follow_up": {
					const input = promptContent(
						text(record.message, "message"),
						record.images,
					) as ClientRequests["turn/steer"]["params"]["input"];
					const result =
						type === "steer"
							? await session.request("turn/steer", { input })
							: await session.request("turn/followUp", { input });
					respond(id, type, { disposition: result.disposition ?? "queued" });
					return;
				}
				case "abort":
				case "abort_bash":
					await session.interrupt();
					respond(id, type);
					return;
				case "clear_queue":
					respond(id, type, await session.request("thread/clearQueue", {}));
					return;
				case "new_session":
					respond(id, type, await move(() => session.join("thread/start", { previousThreadId: session.id })));
					return;
				case "get_state":
					respond(id, type, await state());
					return;
				case "get_messages":
					await session.drain();
					respond(id, type, { messages: messages() });
					return;
				case "set_model": {
					const ref =
						typeof record.provider === "string" && record.provider !== ""
							? `${record.provider}/${text(record.modelId, "modelId")}`
							: text(record.modelId, "modelId");
					const result = await session.request("thread/setModel", { model: ref });
					if (result.cancelled)
						fail(id, type, `Model switch cancelled${result.cancelled.reason ? `: ${result.cancelled.reason}` : ""}`);
					else respond(id, type, { model: { id: modelOf(result.model ?? ref).id, display: result.model ?? ref } });
					return;
				}
				case "get_available_models":
					respond(id, type, {
						models:
							options.models.length > 0
								? options.models
								: [{ provider: "", id: modelOf((await session.request("thread/state", {})).model).id }],
					});
					return;
				case "set_thinking_level": {
					const level = record.level === "default" || record.level === "off" ? undefined : record.level;
					if (level !== undefined && !(THINKING_LEVELS as readonly unknown[]).includes(level)) {
						fail(id, type, `Unknown thinking level: ${String(record.level)}`);
						return;
					}
					await session.request("thread/setThinking", level !== undefined ? { level: level as string } : {});
					respond(id, type);
					return;
				}
				case "get_available_thinking_levels":
					respond(id, type, { levels: ["default", ...THINKING_LEVELS] });
					return;
				case "set_permission_mode": {
					const mode = record.mode;
					if (typeof mode !== "string" || !(MODES as readonly string[]).includes(mode)) {
						fail(id, type, `Unknown permission mode: ${String(mode)}`);
						return;
					}
					await session.request("thread/setPermissionMode", { mode });
					respond(id, type);
					return;
				}
				case "get_permission_mode":
					respond(id, type, {
						mode: (await session.request("thread/state", {})).permissionMode as PermissionMode,
					});
					return;
				case "compact": {
					const result = await session.request(
						"thread/compact",
						typeof record.customInstructions === "string" ? { instructions: record.customInstructions } : {},
					);
					if (result.cancelled)
						throw new Error(result.cancelled === "extension" ? "Compaction cancelled" : "Compaction aborted");
					respond(
						id,
						type,
						result.compacted ? { summary: result.summary, tokensBefore: result.tokensBefore } : { compacted: false },
					);
					return;
				}
				case "bash": {
					const result = await session.request("thread/bash", {
						command: text(record.command, "command"),
						record: true,
					});
					respond(
						id,
						type,
						result.cancelled
							? { output: result.reason ?? "", exitCode: -1, cancelled: true }
							: {
									output: [result.stdout ?? "", result.stderr ?? ""]
										.filter((part) => part !== "")
										.join("\n")
										.trimEnd(),
									exitCode: result.exitCode,
									cancelled: false,
								},
					);
					return;
				}
				// P36a: background commands the model started (tau addition, for editor clients).
				case "list_background_tasks":
					respond(id, type, await session.request("thread/backgroundTasks", {}));
					return;
				case "stop_background_task":
					respond(
						id,
						type,
						await session.request("thread/stopBackgroundTask", { taskId: text(record.taskId, "taskId") }),
					);
					return;
				case "get_session_stats": {
					const current = await session.request("thread/state", {});
					await session.drain();
					const usage = usageOf(current);
					const all = messages();
					respond(id, type, {
						...(current.sessionFile ? { sessionFile: current.sessionFile } : {}),
						sessionId: session.id,
						userMessages: all.filter((message) => message.role === "user").length,
						assistantMessages: all.filter((message) => message.role === "assistant").length,
						toolResults: all.filter((message) => message.role === "toolResult").length,
						totalMessages: all.filter((message) => message.role !== "system").length,
						tokens: {
							input: usage.input,
							output: usage.output,
							cacheRead: usage.cacheRead,
							cacheWrite: usage.cacheWrite,
							total: usage.totalTokens,
						},
						cost: usage.cost.total,
					});
					return;
				}
				case "export_html": {
					const current = await session.request("thread/state", {});
					await session.drain();
					const target = resolve(
						options.cwd,
						typeof record.outputPath === "string" && record.outputPath !== ""
							? record.outputPath
							: `tau-session-${(current.sessionFile ? session.id : "export").slice(0, 8)}.html`,
					);
					await writeFile(
						target,
						sessionHtml(messages(), {
							title: current.name ?? `tau session ${current.sessionFile ? session.id.slice(0, 8) : ""}`.trim(),
							model: current.model,
							cwd: options.cwd,
							exportedAt: new Date().toISOString(),
						}),
						"utf8",
					);
					respond(id, type, { path: target });
					return;
				}
				case "switch_session": {
					const path = resolve(options.cwd, text(record.sessionPath, "sessionPath"));
					respond(
						id,
						type,
						await move(() => session.join("thread/import", { path, copy: false, previousThreadId: session.id })),
					);
					return;
				}
				case "fork":
				case "clone": {
					if (!(await session.request("thread/state", {})).sessionFile)
						throw new CommandError("No session file (--no-session)");
					const { entries, leafId } = await session.entries();
					const entryId = type === "fork" ? text(record.entryId, "entryId") : leafId;
					const entry = type === "fork" ? entries.find((candidate) => candidate.id === entryId) : undefined;
					const result = await move(() =>
						session.join("thread/fork", {
							threadId: session.id,
							...(entryId ? { entryId, position: type === "fork" ? ("before" as const) : ("at" as const) } : {}),
						}),
					);
					respond(id, type, {
						...result,
						...(entry?.type === "message" && entry.message.role === "user"
							? { text: typeof entry.message.content === "string" ? entry.message.content : "" }
							: {}),
					});
					return;
				}
				case "get_entries":
					respond(id, type, { entries: (await session.entries()).entries });
					return;
				case "get_tree": {
					const { entries, leafId } = await session.entries();
					respond(id, type, {
						leafId,
						nodes: entries.map((entry) => ({ id: entry.id, parentId: entry.parentId, type: entry.type })),
					});
					return;
				}
				case "get_last_assistant_text": {
					await session.drain();
					const last = messages().findLast((message) => message.role === "assistant");
					respond(id, type, { text: last ? messageText(last) : null });
					return;
				}
				case "set_session_name":
					await session.request("thread/setName", { name: text(record.name, "name") });
					respond(id, type);
					return;
				case "get_commands":
					await session.refreshCommands(true).catch(() => false);
					respond(id, type, {
						commands: [...session.commands]
							.filter(([, entry]) => !entry.hidden)
							.map(([name, entry]) => ({
								name,
								description: entry.description,
								source: name.startsWith("skill:") ? "skill" : "extension",
							})),
					});
					return;
				default:
					fail(id, type || "unknown", `unsupported command: ${type || "(missing type)"}`);
			}
		} catch (error) {
			fail(id, type, error instanceof Error ? error.message : String(error));
		}
	};

	bridge.listen(options.input ?? process.stdin);
	await new Promise<void>((done) => {
		const inFlight = new Set<Promise<void>>();
		bridge.takeCommands(
			(value) => {
				if (value instanceof Error) {
					out.write({
						type: "response",
						command: "parse",
						success: false,
						error: `Failed to parse command: ${value.message}`,
					});
					return;
				}
				if (typeof value !== "object" || value === null || Array.isArray(value)) {
					out.write({ type: "response", command: "parse", success: false, error: "A command must be a JSON object" });
					return;
				}
				const task = handle(value as Record<string, unknown>).finally(() => inFlight.delete(task));
				inFlight.add(task);
			},
			() => {
				void Promise.allSettled([...inFlight]).then(() => done());
			},
		);
	});
}
