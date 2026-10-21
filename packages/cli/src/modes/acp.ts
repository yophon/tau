/**
 * `tau --mode acp` (P29): the agent side of the Agent Client Protocol
 * (agentclientprotocol.com, protocol version 1), JSON-RPC 2.0 over stdio,
 * written from the schema without the SDK. Each session/new opens a workspace
 * at the client's cwd; tool approvals become session/request_permission; reads
 * and writes go through the client's fs methods when it offers them (so the
 * agent sees unsaved buffers and edits land in the editor); todo_write becomes
 * a plan; permission modes become session modes. bash still runs locally.
 */
import { isAbsolute, resolve } from "node:path";
import { createMcpExtension, type McpServerConfig } from "@yophon/tau-ext-mcp";
import { NodeFileSystem } from "@yophon/tau-host-node";
import {
	type AgentEvent,
	type AgentMessage,
	type ApprovalRequest,
	type FileInfo,
	type FileSystem,
	type ImageContent,
	type PermissionMode,
	restoreSession,
	SessionRecorder,
	type TextContent,
	type ToolCall,
	type ToolResult,
	type UiCapability,
	type UserContent,
} from "@yophon/tau-kernel";
import { openAlwaysOptions } from "../permissions.ts";
import { stdioServer } from "../secrets.ts";
import { editPairs } from "../tui/render/tool-views.ts";
import { HeadlessSession, type HeadlessWorkspace, type ModelSwitch } from "./headless.ts";
import { type RecordWriter, readRecords } from "./jsonl.ts";

export const ACP_PROTOCOL_VERSION = 1;

type Json = Record<string, unknown>;

/** JSON-RPC over the record stream: requests both ways, notifications, responses. */
export class AcpConnection {
	private nextId = 1;
	private readonly waiting = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
	private readonly out: RecordWriter;

	constructor(out: RecordWriter) {
		this.out = out;
	}

	notify(method: string, params: Json): void {
		this.out.write({ jsonrpc: "2.0", method, params });
	}

	request(method: string, params: Json): Promise<unknown> {
		const id = this.nextId++;
		return new Promise((resolveRequest, reject) => {
			this.waiting.set(id, { resolve: resolveRequest, reject });
			this.out.write({ jsonrpc: "2.0", id, method, params });
		});
	}

	respond(id: unknown, result: unknown): void {
		this.out.write({ jsonrpc: "2.0", id, result: result ?? null });
	}

	fail(id: unknown, code: number, message: string): void {
		this.out.write({ jsonrpc: "2.0", id, error: { code, message } });
	}

	/** A response to one of our requests; false when it is not one. */
	settle(record: Json): boolean {
		if (record.method !== undefined || typeof record.id !== "number") return false;
		const waiter = this.waiting.get(record.id);
		if (!waiter) return false;
		this.waiting.delete(record.id);
		const error = record.error as { message?: string } | undefined;
		if (error) waiter.reject(new Error(error.message ?? "ACP client error"));
		else waiter.resolve(record.result);
		return true;
	}

	rejectAll(reason: string): void {
		for (const [id, waiter] of this.waiting) {
			this.waiting.delete(id);
			waiter.reject(new Error(reason));
		}
	}
}

/**
 * The workspace filesystem with reads and writes through the client (fs/read_text_file,
 * fs/write_text_file) when it offers them; listing, stat, binary reads stay local.
 */
export class ClientFileSystem implements FileSystem {
	readonly cwd: string;
	sessionId = "";
	private readonly local: FileSystem;
	private readonly connection: AcpConnection;
	private readonly can: { read: boolean; write: boolean };

	constructor(local: FileSystem, connection: AcpConnection, can: { read: boolean; write: boolean }) {
		this.local = local;
		this.connection = connection;
		this.can = can;
		this.cwd = local.cwd;
	}

	private absolute(path: string): string {
		return isAbsolute(path) ? path : resolve(this.cwd, path);
	}

	async readTextFile(path: string): Promise<string> {
		if (!this.can.read) return this.local.readTextFile(path);
		const result = (await this.connection.request("fs/read_text_file", {
			sessionId: this.sessionId,
			path: this.absolute(path),
		})) as { content?: unknown };
		return typeof result?.content === "string" ? result.content : "";
	}

	async writeTextFile(path: string, content: string): Promise<void> {
		if (!this.can.write) return this.local.writeTextFile(path, content);
		await this.connection.request("fs/write_text_file", {
			sessionId: this.sessionId,
			path: this.absolute(path),
			content,
		});
	}

	readBinaryFile(path: string): Promise<Uint8Array> {
		if (!this.local.readBinaryFile) throw new Error("binary reads are not available");
		return this.local.readBinaryFile(path);
	}

	appendFile(path: string, content: string): Promise<void> {
		return this.local.appendFile(path, content);
	}

	listDir(path: string): Promise<FileInfo[]> {
		return this.local.listDir(path);
	}

	stat(path: string): Promise<FileInfo> {
		return this.local.stat(path);
	}

	remove(path: string): Promise<void> {
		return this.local.remove(path);
	}
}

/** ACP tool kinds (read, edit, delete, move, search, execute, think, fetch, other). */
export function toolKind(name: string): string {
	if (name === "read" || name === "ls") return "read";
	if (name === "grep" || name === "find" || name === "tool_search") return "search";
	if (name === "edit" || name === "write") return "edit";
	if (name === "bash" || name === "powershell") return "execute";
	if (name === "web_fetch" || name === "web_search") return "fetch";
	if (name === "todo_write" || name === "subagent") return "think";
	return "other";
}

export function toolTitle(name: string, args: Record<string, unknown>): string {
	const str = (key: string): string => (typeof args[key] === "string" ? (args[key] as string) : "");
	switch (name) {
		case "read":
		case "edit":
		case "write":
			return `${name} ${str("path")}`;
		case "ls":
			return `ls ${str("path") || "."}`;
		case "bash":
		case "powershell":
			return str("command").split("\n")[0] ?? name;
		case "grep":
			return `grep "${str("pattern")}"`;
		case "find":
			return `find ${str("pattern")}`;
		case "web_fetch":
			return `fetch ${str("url")}`;
		case "web_search":
			return `search "${str("query")}"`;
		default:
			return name;
	}
}

function resultText(result: ToolResult): string {
	return result.content.map((block) => (block.type === "text" ? block.text : `[${block.type}]`)).join("\n");
}

/** ACP content blocks of a prompt → tau user content. */
export function promptToContent(blocks: unknown): UserContent {
	const parts: (TextContent | ImageContent)[] = [];
	for (const block of Array.isArray(blocks) ? blocks : []) {
		const item = (block ?? {}) as Json;
		if (item.type === "text" && typeof item.text === "string") parts.push({ type: "text", text: item.text });
		else if (item.type === "image" && typeof item.data === "string" && typeof item.mimeType === "string") {
			parts.push({ type: "image", data: item.data, mimeType: item.mimeType });
		} else if (item.type === "resource") {
			const resource = (item.resource ?? {}) as Json;
			const uri = typeof resource.uri === "string" ? resource.uri : "";
			if (typeof resource.text === "string") {
				parts.push({ type: "text", text: `<context ref="${uri}">\n${resource.text}\n</context>` });
			}
		} else if (item.type === "resource_link" && typeof item.uri === "string") {
			parts.push({ type: "text", text: `@${item.uri.replace(/^file:\/\//, "")}` });
		}
	}
	if (parts.every((part) => part.type === "text")) return parts.map((part) => (part as TextContent).text).join("\n\n");
	return parts;
}

const MODE_INFO: ReadonlyArray<{ id: PermissionMode; name: string; description: string }> = [
	{ id: "read-only", name: "Read only", description: "Tools that change files or run commands are denied" },
	{ id: "supervised", name: "Supervised", description: "Medium- and high-risk tool calls ask first" },
	{ id: "accept-edits", name: "Accept edits", description: "File edits in the project run; commands still ask" },
	{ id: "autonomous", name: "Autonomous", description: "Tool calls run without asking (high risk still asks)" },
];

const STOP_REASONS: Record<string, string> = {
	stop: "end_turn",
	length: "max_tokens",
	toolUse: "max_turn_requests",
	aborted: "cancelled",
};

/** What main.ts gives the ACP mode: a way to open a workspace at a cwd, and the shared model state. */
export interface AcpHost {
	openWorkspace(spec: {
		cwd: string;
		ui: UiCapability | undefined;
		onApproval: ((request: ApprovalRequest) => Promise<boolean>) | undefined;
		fs?: FileSystem;
		mcp?: boolean;
		askUser?: false | { freeAnswer?: boolean };
	}): Promise<HeadlessWorkspace & { isProjectTrusted(): boolean; defaultMode?(): PermissionMode | undefined }>;
	/** P32b: the ~/.tau/mcp.json servers (and the project's when trusted); the editor's win on a name clash. */
	configuredMcpServers?(cwd: string, projectTrusted: boolean): McpServerConfig[];
	/** P41b (pi --no-mcp): no MCP servers, neither the editor's nor the configured ones. */
	noMcp?: boolean;
	modelDisplay(): string;
	modelChoices: readonly string[];
	resolveModelSwitch?: (requested: string) => ModelSwitch;
	version: string;
}

interface AcpSession {
	id: string;
	headless: HeadlessSession;
	fs: ClientFileSystem | undefined;
	/** Partial output per running tool call, for tool_call_update. */
	partial: Map<string, string>;
}

export interface AcpModeOptions {
	host: AcpHost;
	out: RecordWriter;
	input?: NodeJS.ReadableStream;
}

export async function runAcpMode(options: AcpModeOptions): Promise<void> {
	const { host, out } = options;
	const connection = new AcpConnection(out);
	const sessions = new Map<string, AcpSession>();
	let clientFs = { read: false, write: false };

	const update = (sessionId: string, value: Json): void =>
		connection.notify("session/update", { sessionId, update: value });

	const modesOf = (current: PermissionMode): Json => ({
		currentModeId: current,
		availableModes: [
			...MODE_INFO,
			...(current === "bypass" ? [{ id: "bypass", name: "Bypass", description: "Every approval skipped" }] : []),
		],
	});

	const commandsOf = (session: AcpSession): Json[] => [
		{ name: "compact", description: "Summarize older conversation context", input: { hint: "optional instructions" } },
		{ name: "model", description: "Show or switch the model", input: { hint: "provider/model" } },
		{ name: "thinking", description: "Show or set the reasoning effort", input: { hint: "level" } },
		{ name: "name", description: "Name this session", input: { hint: "name" } },
		...[...session.headless.extensions.commands]
			.filter(([, command]) => !command.hidden)
			.map(([name, command]) => ({
				name,
				description: command.description ?? "",
			})),
	];

	/** Tool events of a run as ACP updates. */
	const onEvent = (session: AcpSession, event: AgentEvent): void => {
		switch (event.type) {
			case "text_delta":
				update(session.id, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: event.delta } });
				return;
			case "reasoning_delta":
				update(session.id, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: event.delta } });
				return;
			case "tool_start":
				// Announced before the approval gate runs: pending until output or the result arrives.
				update(session.id, toolCallUpdate(event.toolCall, "pending", session.headless.options.workspace.cwd, true));
				return;
			case "tool_update": {
				const text = `${session.partial.get(event.toolCall.id) ?? ""}${event.partialOutput}`;
				session.partial.set(event.toolCall.id, text);
				update(session.id, {
					sessionUpdate: "tool_call_update",
					toolCallId: event.toolCall.id,
					status: "in_progress",
					content: [{ type: "content", content: { type: "text", text: text.slice(-4000) } }],
				});
				return;
			}
			case "tool_result": {
				session.partial.delete(event.toolCall.id);
				const cwd = session.headless.options.workspace.cwd;
				update(session.id, toolResultUpdate(event.toolCall, event.result, cwd));
				if (event.toolCall.name === "todo_write" && event.result.isError !== true) {
					const todos = Array.isArray(event.toolCall.arguments.todos) ? (event.toolCall.arguments.todos as Json[]) : [];
					update(session.id, {
						sessionUpdate: "plan",
						entries: todos.map((todo) => ({
							content: typeof todo.content === "string" ? todo.content : "",
							priority: "medium",
							status: todo.status === "completed" || todo.status === "in_progress" ? todo.status : "pending",
						})),
					});
				}
				return;
			}
			default:
				return;
		}
	};

	const openSession = async (
		cwd: string,
		mcpServers: unknown,
	): Promise<{ session: AcpSession; ws: HeadlessWorkspace & { defaultMode?(): PermissionMode | undefined } }> => {
		const local = new NodeFileSystem(cwd);
		const fs = clientFs.read || clientFs.write ? new ClientFileSystem(local, connection, clientFs) : undefined;
		// The session id exists once the store does; the approval and UI callbacks read it late.
		const holder: { session?: AcpSession } = {};
		const ui = acpUi(connection, () => holder.session?.id ?? "");
		const ws = await host.openWorkspace({
			cwd,
			ui,
			fs,
			mcp: false,
			// ACP has buttons but no text input: ask_user offers only the options (P35).
			askUser: { freeAnswer: false },
			onApproval: async (request) => {
				const sessionId = holder.session?.id ?? "";
				// What "always allow" saves for this call (P37a), or edits for the session.
				const always = openAlwaysOptions.get(request.toolCallId);
				const result = (await connection
					.request("session/request_permission", {
						sessionId,
						toolCall: {
							...toolCallUpdate(
								{
									type: "toolCall",
									id: request.toolCallId,
									name: request.toolName,
									arguments: request.args as ToolCall["arguments"],
								},
								"pending",
								cwd,
								true,
							),
						},
						options: [
							{ optionId: "allow_once", name: "Allow once", kind: "allow_once" },
							...(always ? [{ optionId: "allow_always", name: always.label, kind: "allow_always" }] : []),
							{ optionId: "reject_once", name: "Deny", kind: "reject_once" },
						],
					})
					.catch(() => undefined)) as { outcome?: { outcome?: string; optionId?: string } } | undefined;
				const choice = result?.outcome?.outcome === "selected" ? result.outcome.optionId : undefined;
				if (choice === "allow_always" && always) {
					always.apply();
					if (always.kind === "edits") {
						update(sessionId, { sessionUpdate: "current_mode_update", currentModeId: "accept-edits" });
					}
				}
				return choice === "allow_once" || choice === "allow_always";
			},
		});
		// Stdio servers start from the environment without secrets, plus what the editor declared (P32b).
		const editor = mcpServerConfigs(mcpServers).map((server) => (server.command ? stdioServer(server) : server));
		const names = new Set(editor.map((server) => server.name));
		const configured = (host.configuredMcpServers?.(cwd, ws.isProjectTrusted()) ?? []).filter(
			(server) => !names.has(server.name),
		);
		const servers = host.noMcp === true ? [] : [...editor, ...configured];
		if (servers.length > 0) await ws.extensions.add([createMcpExtension({ servers })]);
		const session = {
			id: "",
			headless: undefined as unknown as HeadlessSession,
			fs,
			partial: new Map<string, string>(),
		};
		holder.session = session;
		return { session, ws };
	};

	const handle = async (record: Json): Promise<void> => {
		const id = record.id;
		const method = typeof record.method === "string" ? record.method : "";
		const params = (record.params ?? {}) as Json;
		const isRequest = id !== undefined && id !== null;
		try {
			switch (method) {
				case "initialize": {
					const capabilities = (params.clientCapabilities ?? {}) as Json;
					const fsCaps = (capabilities.fs ?? {}) as Json;
					clientFs = { read: fsCaps.readTextFile === true, write: fsCaps.writeTextFile === true };
					connection.respond(id, {
						protocolVersion: ACP_PROTOCOL_VERSION,
						agentCapabilities: {
							loadSession: true,
							promptCapabilities: { image: true, audio: false, embeddedContext: true },
							mcpCapabilities: { http: true, sse: false },
						},
						authMethods: [],
						agentInfo: { name: "tau", title: "tau", version: host.version },
					});
					return;
				}
				case "authenticate":
					connection.respond(id, {});
					return;
				case "session/new":
				case "session/load": {
					const cwd = typeof params.cwd === "string" && params.cwd !== "" ? params.cwd : process.cwd();
					const { session, ws } = await openSession(cwd, params.mcpServers);
					let store: Awaited<ReturnType<HeadlessWorkspace["sessionRepo"]["create"]>>;
					if (method === "session/load") {
						const wanted = typeof params.sessionId === "string" ? params.sessionId : "";
						const found = (await ws.sessionRepo.list()).find((candidate) => candidate.id === wanted);
						if (!found) {
							connection.fail(id, -32602, `No session ${wanted} in ${cwd}`);
							return;
						}
						store = await ws.sessionRepo.open(found);
					} else {
						store = await ws.sessionRepo.create();
					}
					const metadata = await store.getMetadata();
					session.id = metadata.id;
					if (session.fs) session.fs.sessionId = metadata.id;
					const restored = method === "session/load" ? await restoreSession(store) : undefined;
					const recorder = await SessionRecorder.open(store);
					const agent = ws.buildAgent(restored?.messages, recorder, ws.extensions);
					// settings' permissions.defaultMode (P37a), per session.
					const startMode = ws.defaultMode?.();
					if (startMode) agent.setPermissionMode(startMode);
					session.headless = new HeadlessSession(
						{
							workspace: ws,
							modelDisplay: host.modelDisplay(),
							modelChoices: host.modelChoices,
							...(host.resolveModelSwitch ? { resolveModelSwitch: host.resolveModelSwitch } : {}),
							onEvent: (event) => onEvent(session, event),
							onNotice: (level, text) => process.stderr.write(`[${level}] ${text}\n`),
						},
						agent,
						store,
						recorder,
					);
					sessions.set(session.id, session);
					await session.headless.start(method === "session/load" ? "resume" : "startup");
					if (restored) replay(session.id, restored.messages, cwd);
					connection.respond(id, {
						...(method === "session/new" ? { sessionId: session.id } : {}),
						modes: modesOf(agent.getPermissionMode()),
					});
					update(session.id, { sessionUpdate: "available_commands_update", availableCommands: commandsOf(session) });
					return;
				}
				case "session/prompt": {
					const session = sessions.get(String(params.sessionId));
					if (!session) {
						connection.fail(id, -32602, `Unknown session ${String(params.sessionId)}`);
						return;
					}
					const content = promptToContent(params.prompt);
					const textPrompt = typeof content === "string" ? content : "";
					if (textPrompt.trim().startsWith("/")) {
						const handled = await session.headless.command(textPrompt);
						if (handled) {
							if (handled.output) {
								update(session.id, {
									sessionUpdate: "agent_message_chunk",
									content: { type: "text", text: handled.output },
								});
							}
							const outcome = handled.run ? await handled.run : undefined;
							connection.respond(id, {
								stopReason: outcome ? (STOP_REASONS[outcome.stopReason] ?? "end_turn") : "end_turn",
							});
							if (textPrompt.trim().startsWith("/mode")) {
								update(session.id, {
									sessionUpdate: "current_mode_update",
									currentModeId: session.headless.agent.getPermissionMode(),
								});
							}
							return;
						}
					}
					const outcome = await session.headless.run(content);
					if (outcome.stopReason === "error" && !outcome.aborted) {
						connection.fail(id, -32603, outcome.errorMessage ?? "The model request failed");
						return;
					}
					connection.respond(id, {
						stopReason: outcome.aborted ? "cancelled" : (STOP_REASONS[outcome.stopReason] ?? "end_turn"),
					});
					return;
				}
				case "session/cancel": {
					sessions.get(String(params.sessionId))?.headless.abort();
					return;
				}
				case "session/set_mode": {
					const session = sessions.get(String(params.sessionId));
					const mode = params.modeId;
					if (!session || !MODE_INFO.some((info) => info.id === mode)) {
						connection.fail(id, -32602, `Unknown session or mode: ${String(mode)}`);
						return;
					}
					session.headless.setPermissionMode(mode as PermissionMode);
					connection.respond(id, {});
					update(session.id, { sessionUpdate: "current_mode_update", currentModeId: mode });
					return;
				}
				default:
					if (isRequest) connection.fail(id, -32601, `Method not found: ${method}`);
			}
		} catch (error) {
			if (isRequest) connection.fail(id, -32603, error instanceof Error ? error.message : String(error));
			else process.stderr.write(`ACP ${method} failed: ${error instanceof Error ? error.message : String(error)}\n`);
		}
	};

	/** session/load: the history as updates (pi-shaped messages → ACP chunks and tool calls). */
	const replay = (sessionId: string, messages: readonly AgentMessage[], cwd: string): void => {
		const calls = new Map<string, ToolCall>();
		for (const message of messages) {
			if (message.role === "user") {
				const text =
					typeof message.content === "string"
						? message.content
						: message.content.map((block) => (block.type === "text" ? block.text : "")).join("");
				if (text !== "") update(sessionId, { sessionUpdate: "user_message_chunk", content: { type: "text", text } });
			} else if (message.role === "assistant") {
				for (const block of message.content) {
					if (block.type === "text" && block.text !== "") {
						update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: block.text } });
					} else if (block.type === "thinking" && block.thinking !== "") {
						update(sessionId, {
							sessionUpdate: "agent_thought_chunk",
							content: { type: "text", text: block.thinking },
						});
					} else if (block.type === "toolCall") {
						calls.set(block.id, block);
						update(sessionId, toolCallUpdate(block, "pending", cwd, true));
					}
				}
			} else if (message.role === "toolResult") {
				const call = calls.get(message.toolCallId);
				if (call) {
					update(sessionId, toolResultUpdate(call, { content: message.content, isError: message.isError }, cwd));
				}
			}
		}
	};

	const input = options.input ?? process.stdin;
	await new Promise<void>((done) => {
		const inFlight = new Set<Promise<void>>();
		readRecords(
			input,
			(value) => {
				if (value instanceof Error || typeof value !== "object" || value === null) {
					connection.fail(null, -32700, "Parse error");
					return;
				}
				const record = value as Json;
				if (connection.settle(record)) return;
				const task = handle(record).finally(() => inFlight.delete(task));
				inFlight.add(task);
			},
			() => {
				connection.rejectAll("The client closed the connection");
				for (const session of sessions.values()) session.headless?.abort();
				void Promise.allSettled([...inFlight]).then(() => done());
			},
		);
	});
	for (const session of sessions.values()) await session.headless?.stop();
}

/** A tool call as a tool_call (first sighting) or tool_call_update. */
function toolCallUpdate(call: ToolCall, status: string, cwd: string, announce: boolean): Json {
	const args = call.arguments ?? {};
	const path = typeof args.path === "string" ? args.path : undefined;
	return {
		sessionUpdate: announce ? "tool_call" : "tool_call_update",
		toolCallId: call.id,
		title: toolTitle(call.name, args),
		kind: toolKind(call.name),
		status,
		rawInput: args,
		...(path ? { locations: [{ path: isAbsolute(path) ? path : resolve(cwd, path) }] } : {}),
	};
}

/** The finished call: diffs for edit/write, the text output otherwise. */
function toolResultUpdate(call: ToolCall, result: Pick<ToolResult, "content" | "isError">, cwd: string): Json {
	const args = call.arguments ?? {};
	const path =
		typeof args.path === "string" ? (isAbsolute(args.path) ? args.path : resolve(cwd, args.path)) : undefined;
	let content: Json[];
	if (result.isError !== true && path && call.name === "edit") {
		content = editPairs(args).map((pair) => ({ type: "diff", path, oldText: pair.oldText, newText: pair.newText }));
	} else if (result.isError !== true && path && call.name === "write") {
		content = [{ type: "diff", path, oldText: null, newText: typeof args.content === "string" ? args.content : "" }];
	} else {
		const text = resultText(result as ToolResult);
		content = [
			{ type: "content", content: { type: "text", text: text.length > 8000 ? `${text.slice(0, 8000)}\n…` : text } },
		];
	}
	return {
		sessionUpdate: "tool_call_update",
		toolCallId: call.id,
		status: result.isError === true ? "failed" : "completed",
		content,
	};
}

/** ctx.ui over ACP: confirm and select become permission requests; input/editor are not offered. */
function acpUi(connection: AcpConnection, sessionId: () => string): UiCapability {
	let next = 1;
	const ask = async (
		title: string,
		options: Array<{ optionId: string; name: string; kind: string }>,
	): Promise<string | undefined> => {
		const result = (await connection
			.request("session/request_permission", {
				sessionId: sessionId(),
				toolCall: { toolCallId: `ui-${next++}`, title, kind: "other", status: "pending" },
				options,
			})
			.catch(() => undefined)) as { outcome?: { outcome?: string; optionId?: string } } | undefined;
		return result?.outcome?.outcome === "selected" ? result.outcome.optionId : undefined;
	};
	return {
		confirm: async (title, message) =>
			(await ask(message ? `${title} — ${message}` : title, [
				{ optionId: "yes", name: "Yes", kind: "allow_once" },
				{ optionId: "no", name: "No", kind: "reject_once" },
			])) === "yes",
		select: async (title, values) => {
			const picked = await ask(
				title,
				values.map((value, index) => ({ optionId: String(index), name: value, kind: "allow_once" })),
			);
			return picked === undefined ? undefined : values[Number(picked)];
		},
		input: async () => undefined,
		notify: (message, level) => process.stderr.write(`[${level ?? "info"}] ${message}\n`),
	};
}

interface AcpMcpConfig {
	name: string;
	command?: string;
	args?: string[];
	env?: Record<string, string>;
	url?: string;
	headers?: Record<string, string>;
}

/** ACP McpServer entries → tau's MCP server configs (stdio and http; sse is not offered). */
export function mcpServerConfigs(value: unknown): AcpMcpConfig[] {
	if (!Array.isArray(value)) return [];
	const pairs = (list: unknown): Record<string, string> => {
		const out: Record<string, string> = {};
		for (const item of Array.isArray(list) ? list : []) {
			const entry = (item ?? {}) as Json;
			if (typeof entry.name === "string" && typeof entry.value === "string") out[entry.name] = entry.value;
		}
		return out;
	};
	return value.flatMap((item): AcpMcpConfig[] => {
		const server = (item ?? {}) as Json;
		const name = typeof server.name === "string" ? server.name : "";
		if (name === "") return [];
		if (typeof server.command === "string") {
			return [
				{
					name,
					command: server.command,
					args: Array.isArray(server.args) ? server.args.filter((arg): arg is string => typeof arg === "string") : [],
					env: pairs(server.env),
				},
			];
		}
		if (server.type === "http" && typeof server.url === "string") {
			return [{ name, url: server.url, headers: pairs(server.headers) }];
		}
		return [];
	});
}
