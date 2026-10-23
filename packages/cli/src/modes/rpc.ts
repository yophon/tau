/**
 * `tau --mode rpc` (P29, pi rpc.md / rpc-commands.md / rpc-extension-ui.md): a
 * long-lived child process driven by JSONL commands on stdin. Every command may
 * carry an `id`; its single `response` repeats it. Session events stream as in
 * JSON mode (no header). `ctx.ui` dialogs and tool approvals go to the client as
 * `extension_ui_request` records; an approval is a `select` with an extra
 * `approval` field (D20 has no pi counterpart). Closing stdin shuts down.
 */
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type {
	ApprovalRequest,
	ImageContent,
	PermissionMode,
	ThinkingLevel,
	UiCapability,
	UserContent,
} from "@yophon/tau-kernel";
import { sessionHtml } from "../tui/export-html.ts";
import { agentEventRecord, sessionEventStream } from "./events.ts";
import { type HeadlessSession, THINKING_LEVELS } from "./headless.ts";
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
	session: HeadlessSession;
	bridge: RpcUiBridge;
	out: RecordWriter;
	input?: NodeJS.ReadableStream;
	cwd: string;
	models: readonly RpcModelEntry[];
	sessionReason: "startup" | "resume";
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

/** Run the RPC loop until stdin closes. */
export async function runRpcMode(options: RpcModeOptions): Promise<void> {
	const { session, bridge, out } = options;
	await session.extensions.add([sessionEventStream((record) => out.write(record))]);
	await session.start(options.sessionReason);

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

	const state = async (): Promise<Record<string, unknown>> => {
		const metadata = session.store ? await session.store.getMetadata() : undefined;
		const [provider, ...rest] = session.modelDisplay.includes("/")
			? session.modelDisplay.split("/")
			: ["", session.modelDisplay];
		return {
			model: { provider: rest.length > 0 ? provider : "", id: session.agent.model },
			thinkingLevel: session.agent.thinkingLevel ?? "default",
			permissionMode: session.agent.getPermissionMode(),
			isStreaming: session.isRunning,
			isCompacting: session.isCompacting,
			...(metadata?.filePath ? { sessionFile: metadata.filePath } : {}),
			sessionId: metadata?.id ?? session.agent.extensionContext().sessionManager?.getSessionId() ?? "",
			...(metadata?.name ? { sessionName: metadata.name } : {}),
			messageCount: session.agent.messages.filter((message) => message.role !== "system").length,
			pendingMessageCount: session.agent.hasQueuedMessages() ? 1 : 0,
			autoCompactionEnabled: session.agent.getContextUsage().contextWindow !== undefined,
		};
	};

	const handle = async (command: Record<string, unknown>): Promise<void> => {
		const id = command.id;
		const type = typeof command.type === "string" ? command.type : "";
		try {
			switch (type) {
				case "prompt": {
					const message = text(command.message, "message");
					const behavior =
						command.streamingBehavior === "steer" || command.streamingBehavior === "followUp"
							? command.streamingBehavior
							: undefined;
					if (message.trim().startsWith("/")) {
						const handled = await session.command(message);
						if (handled) {
							if (handled.output) bridge.ui.notify(handled.output, "info");
							respond(id, type, { disposition: handled.run ? "started" : "handled" });
							return;
						}
					}
					const result = await session.submit(promptContent(message, command.images), behavior);
					respond(id, type, { disposition: result.disposition });
					return;
				}
				case "steer":
				case "follow_up": {
					const content = promptContent(text(command.message, "message"), command.images);
					const disposition = await (type === "steer" ? session.agent.steer(content) : session.agent.followUp(content));
					respond(id, type, { disposition });
					return;
				}
				case "abort":
					session.abort();
					respond(id, type);
					return;
				case "clear_queue": {
					const cleared = session.agent.clearQueue();
					respond(id, type, {
						steering: cleared.steering.map((message) => message.content),
						followUp: cleared.followUp.map((message) => message.content),
					});
					return;
				}
				case "new_session":
					respond(id, type, await session.newSession());
					return;
				case "get_state":
					respond(id, type, await state());
					return;
				case "get_messages":
					respond(id, type, { messages: session.agent.messages });
					return;
				case "set_model": {
					const ref =
						typeof command.provider === "string" && command.provider !== ""
							? `${command.provider}/${text(command.modelId, "modelId")}`
							: text(command.modelId, "modelId");
					const result = session.setModel(ref);
					if ("error" in result) fail(id, type, result.error);
					else respond(id, type, { model: { id: session.agent.model, display: result.display } });
					return;
				}
				case "get_available_models":
					respond(id, type, {
						models: options.models.length > 0 ? options.models : [{ provider: "", id: session.agent.model }],
					});
					return;
				case "set_thinking_level": {
					const level = command.level === "default" || command.level === "off" ? undefined : command.level;
					if (level !== undefined && !(THINKING_LEVELS as readonly unknown[]).includes(level)) {
						fail(id, type, `Unknown thinking level: ${String(command.level)}`);
						return;
					}
					session.setThinking(level as ThinkingLevel | undefined);
					respond(id, type);
					return;
				}
				case "get_available_thinking_levels":
					respond(id, type, { levels: ["default", ...THINKING_LEVELS] });
					return;
				case "set_permission_mode": {
					const mode = command.mode;
					if (typeof mode !== "string" || !(MODES as readonly string[]).includes(mode)) {
						fail(id, type, `Unknown permission mode: ${String(mode)}`);
						return;
					}
					session.setPermissionMode(mode as PermissionMode);
					respond(id, type);
					return;
				}
				case "get_permission_mode":
					respond(id, type, { mode: session.agent.getPermissionMode() });
					return;
				case "compact": {
					const result = await session.compact(
						typeof command.customInstructions === "string" ? command.customInstructions : undefined,
					);
					respond(id, type, result ?? { compacted: false });
					return;
				}
				case "bash": {
					const result = await session.bash(text(command.command, "command"));
					respond(id, type, result);
					return;
				}
				case "abort_bash":
					session.abort();
					respond(id, type);
					return;
				// P36a: background commands the model started (tau addition, for editor clients).
				case "list_background_tasks":
					respond(id, type, { tasks: session.options.workspace.background?.list() ?? [] });
					return;
				case "stop_background_task": {
					const background = session.options.workspace.background;
					if (!background) throw new Error("This workspace has no background commands.");
					respond(id, type, { task: await background.stop(text(command.taskId, "taskId")) });
					return;
				}
				case "get_session_stats": {
					const usage = session.agent.getSessionUsage();
					const messages = session.agent.messages;
					const metadata = session.store ? await session.store.getMetadata() : undefined;
					respond(id, type, {
						...(metadata?.filePath ? { sessionFile: metadata.filePath } : {}),
						sessionId: metadata?.id ?? "",
						userMessages: messages.filter((message) => message.role === "user").length,
						assistantMessages: messages.filter((message) => message.role === "assistant").length,
						toolResults: messages.filter((message) => message.role === "toolResult").length,
						totalMessages: messages.filter((message) => message.role !== "system").length,
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
					const metadata = session.store ? await session.store.getMetadata() : undefined;
					const target = resolve(
						options.cwd,
						typeof command.outputPath === "string" && command.outputPath !== ""
							? command.outputPath
							: `tau-session-${(metadata?.id ?? "export").slice(0, 8)}.html`,
					);
					await writeFile(
						target,
						sessionHtml(session.agent.messages, {
							title: metadata?.name ?? `tau session ${metadata?.id.slice(0, 8) ?? ""}`.trim(),
							model: session.modelDisplay,
							cwd: options.cwd,
							exportedAt: new Date().toISOString(),
						}),
						"utf8",
					);
					respond(id, type, { path: target });
					return;
				}
				case "switch_session": {
					const filePath = resolve(options.cwd, text(command.sessionPath, "sessionPath"));
					const store = await session.options.workspace.sessionRepo.open({
						id: "",
						cwd: options.cwd,
						timestamp: "",
						filePath,
					});
					respond(id, type, await session.switchTo(store, "resume"));
					return;
				}
				case "fork":
				case "clone": {
					if (!session.store) throw new CommandError("No session file (--no-session)");
					const metadata = await session.store.getMetadata();
					const entryId = type === "fork" ? text(command.entryId, "entryId") : await session.store.getLeafId();
					const forked = await session.options.workspace.sessionRepo.fork(
						metadata,
						entryId ? { entryId, position: type === "fork" ? "before" : "at" } : undefined,
					);
					const entry = type === "fork" && entryId ? await session.store.getEntry(entryId) : undefined;
					const result = await session.switchTo(forked, "fork");
					respond(id, type, {
						...result,
						...(entry?.type === "message" && entry.message.role === "user"
							? { text: typeof entry.message.content === "string" ? entry.message.content : "" }
							: {}),
					});
					return;
				}
				case "get_entries":
					respond(id, type, { entries: session.store ? await session.store.getEntries() : [] });
					return;
				case "get_tree": {
					const entries = session.store ? await session.store.getEntries() : [];
					respond(id, type, {
						leafId: session.store ? await session.store.getLeafId() : null,
						nodes: entries.map((entry) => ({ id: entry.id, parentId: entry.parentId, type: entry.type })),
					});
					return;
				}
				case "get_last_assistant_text":
					respond(id, type, { text: session.lastAssistantText() ?? null });
					return;
				case "set_session_name": {
					const name = text(command.name, "name");
					if (!session.recorder) throw new CommandError("No session file (--no-session)");
					await session.recorder.setName(name);
					await session.extensions.notifySessionInfoChanged(name, session.agent.extensionContext());
					respond(id, type);
					return;
				}
				case "get_commands":
					respond(id, type, {
						commands: [...session.extensions.commands]
							.filter(([, entry]) => !entry.hidden)
							.map(([name, entry]) => ({
								name,
								description: entry.description ?? "",
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

	// Events of the AgentEvent stream that have no extension hook (compaction, retries).
	session.options.onEvent = ((previous) => (event) => {
		previous?.(event);
		const record = agentEventRecord(event);
		if (record) out.write(record);
	})(session.options.onEvent);

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
				const record = value as Record<string, unknown>;
				const task = handle(record).finally(() => inFlight.delete(task));
				inFlight.add(task);
			},
			() => {
				void Promise.allSettled([...inFlight]).then(() => done());
			},
		);
	});
	await session.stop();
}
