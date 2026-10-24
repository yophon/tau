// What `tau --mode acp` says to the editor (P29; P60 over tau's protocol): the session's AgentEvents
// and its conversation as ACP session updates, ACP prompts and MCP servers as tau's, the session's
// settings as Session Config Options (and the older session modes), and tau's dialogs as
// elicitation forms. Pure functions: modes/acp.ts holds the connections.
import { isAbsolute, resolve } from "node:path";
import type { AgentMessage, ToolCall, ToolResult, UiForm, UiFormField } from "@yophon/tau-kernel";
import type { InputBlock, McpServerSpec, ServerRequests, ThreadState, UserInput } from "@yophon/tau-protocol";
import { editPairs } from "../tui/render/tool-views.ts";
import { THINKING_LEVELS } from "./headless.ts";

export type Json = Record<string, unknown>;

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

/** ACP content blocks of a prompt → what a user sends (text, or text and images). */
export function promptToContent(blocks: unknown): UserInput {
	const parts: InputBlock[] = [];
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
	if (parts.every((part) => part.type === "text"))
		return parts.map((part) => (part as { text: string }).text).join("\n\n");
	return parts;
}

/** What a user sent (another client's prompt, or the history) as ACP content blocks. */
export function inputBlocks(input: UserInput): Json[] {
	if (typeof input === "string") return input === "" ? [] : [{ type: "text", text: input }];
	return input.flatMap((block): Json[] =>
		block.type === "text"
			? block.text === ""
				? []
				: [{ type: "text", text: block.text }]
			: [{ type: "image", data: block.data, mimeType: block.mimeType }],
	);
}

/** ACP McpServer entries → tau's (stdio and http; sse is not offered). */
export function mcpServerConfigs(value: unknown): McpServerSpec[] {
	if (!Array.isArray(value)) return [];
	const pairs = (list: unknown): Record<string, string> => {
		const out: Record<string, string> = {};
		for (const item of Array.isArray(list) ? list : []) {
			const entry = (item ?? {}) as Json;
			if (typeof entry.name === "string" && typeof entry.value === "string") out[entry.name] = entry.value;
		}
		return out;
	};
	return value.flatMap((item): McpServerSpec[] => {
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

/** A tool call as a tool_call (first sighting) or tool_call_update. */
export function toolCallUpdate(call: ToolCall, status: string, cwd: string, announce: boolean): Json {
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

function resultText(result: Pick<ToolResult, "content">): string {
	return result.content.map((block) => (block.type === "text" ? block.text : `[${block.type}]`)).join("\n");
}

/** The finished call: diffs for edit/write, the text output otherwise. */
export function toolResultUpdate(call: ToolCall, result: Pick<ToolResult, "content" | "isError">, cwd: string): Json {
	const args = call.arguments ?? {};
	const path =
		typeof args.path === "string" ? (isAbsolute(args.path) ? args.path : resolve(cwd, args.path)) : undefined;
	let content: Json[];
	if (result.isError !== true && path && call.name === "edit") {
		content = editPairs(args).map((pair) => ({ type: "diff", path, oldText: pair.oldText, newText: pair.newText }));
	} else if (result.isError !== true && path && call.name === "write") {
		content = [{ type: "diff", path, oldText: null, newText: typeof args.content === "string" ? args.content : "" }];
	} else {
		const text = resultText(result);
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

/** todo_write's list as an ACP plan. */
function planUpdate(call: ToolCall): Json {
	const todos = Array.isArray(call.arguments.todos) ? (call.arguments.todos as Json[]) : [];
	return {
		sessionUpdate: "plan",
		entries: todos.map((todo) => ({
			content: typeof todo.content === "string" ? todo.content : "",
			priority: "medium",
			status: todo.status === "completed" || todo.status === "in_progress" ? todo.status : "pending",
		})),
	};
}

/**
 * One of the session's AgentEvents (native data, P57) as ACP updates: text and reasoning chunks, tool
 * calls (announced before the approval gate runs, pending until output or the result arrives) with
 * their output, diffs and todo_write's plan. `partial` keeps each running call's output so far.
 */
export function eventUpdates(event: Json, cwd: string, partial: Map<string, string>): Json[] {
	switch (event.type) {
		case "text_delta":
			return [{ sessionUpdate: "agent_message_chunk", content: { type: "text", text: String(event.delta) } }];
		case "reasoning_delta":
			return [{ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: String(event.delta) } }];
		case "tool_start":
			return [toolCallUpdate(event.toolCall as ToolCall, "pending", cwd, true)];
		case "tool_update": {
			const call = event.toolCall as ToolCall;
			const text = `${partial.get(call.id) ?? ""}${String(event.partialOutput)}`;
			partial.set(call.id, text);
			return [
				{
					sessionUpdate: "tool_call_update",
					toolCallId: call.id,
					status: "in_progress",
					content: [{ type: "content", content: { type: "text", text: text.slice(-4000) } }],
				},
			];
		}
		case "tool_result": {
			const call = event.toolCall as ToolCall;
			const result = event.result as ToolResult;
			partial.delete(call.id);
			const updates = [toolResultUpdate(call, result, cwd)];
			if (call.name === "todo_write" && result.isError !== true) updates.push(planUpdate(call));
			return updates;
		}
		default:
			return [];
	}
}

/** session/load: the history as updates (pi-shaped messages → ACP chunks and tool calls). */
export function replayUpdates(messages: readonly AgentMessage[], cwd: string): Json[] {
	const updates: Json[] = [];
	const calls = new Map<string, ToolCall>();
	for (const message of messages) {
		if (message.role === "user") {
			const text =
				typeof message.content === "string"
					? message.content
					: message.content.map((block) => (block.type === "text" ? block.text : "")).join("");
			if (text !== "") updates.push({ sessionUpdate: "user_message_chunk", content: { type: "text", text } });
		} else if (message.role === "assistant") {
			for (const block of message.content) {
				if (block.type === "text" && block.text !== "") {
					updates.push({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: block.text } });
				} else if (block.type === "thinking" && block.thinking !== "") {
					updates.push({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: block.thinking } });
				} else if (block.type === "toolCall") {
					calls.set(block.id, block);
					updates.push(toolCallUpdate(block, "pending", cwd, true));
				}
			}
		} else if (message.role === "toolResult") {
			const call = calls.get(message.toolCallId);
			if (call) updates.push(toolResultUpdate(call, { content: message.content, isError: message.isError }, cwd));
		}
	}
	return updates;
}

/** The six permission modes (the TUI's /mode). */
export const MODE_INFO: ReadonlyArray<{ id: string; name: string; description: string }> = [
	{ id: "read-only", name: "Read only", description: "Tools that change files or run commands are denied" },
	{ id: "supervised", name: "Supervised", description: "Medium- and high-risk tool calls ask first" },
	{ id: "accept-edits", name: "Accept edits", description: "File edits in the project run; commands still ask" },
	{ id: "autonomous", name: "Autonomous", description: "Tool calls run without asking" },
	{ id: "bypass", name: "Bypass", description: "Every approval skipped, policy rules included" },
	{ id: "ci", name: "CI", description: "Nothing asks: reads and edits in the project run, the rest is denied" },
];

/** The legacy session modes (ACP clients before config options). */
export function modesOf(state: ThreadState): Json {
	return { currentModeId: state.permissionMode, availableModes: MODE_INFO };
}

/** The session's settings as ACP Session Config Options: permission mode, model, reasoning effort. */
export function configOptionsOf(state: ThreadState): Json[] {
	const models = state.modelChoices.includes(state.model) ? state.modelChoices : [state.model, ...state.modelChoices];
	return [
		{
			id: "mode",
			name: "Mode",
			category: "mode",
			type: "select",
			currentValue: state.permissionMode,
			options: MODE_INFO.map((mode) => ({ value: mode.id, name: mode.name, description: mode.description })),
		},
		{
			id: "model",
			name: "Model",
			category: "model",
			type: "select",
			currentValue: state.model,
			options: models.map((model) => ({ value: model, name: model })),
		},
		{
			id: "thought_level",
			name: "Reasoning effort",
			category: "thought_level",
			type: "select",
			currentValue: state.thinkingLevel ?? "default",
			options: ["default", ...THINKING_LEVELS].map((level) => ({ value: level, name: level })),
		},
	];
}

export const STOP_REASONS: Record<string, string> = {
	stop: "end_turn",
	length: "max_tokens",
	toolUse: "max_turn_requests",
	aborted: "cancelled",
};

type UiParams = ServerRequests["ui/request"]["params"];
type UiResult = ServerRequests["ui/request"]["result"];

function fieldSchema(field: UiFormField): Json {
	const optional = (key: string, value: unknown): Json => (value === undefined ? {} : { [key]: value });
	const base = {
		title: field.title,
		...optional("description", field.description),
		...optional("default", field.default),
	};
	const choices = (field.options ?? []).map((option) => ({ const: option.value, title: option.label }));
	switch (field.type) {
		case "select":
			return { ...base, type: "string", oneOf: choices };
		case "multiselect":
			return {
				...base,
				type: "array",
				items: { anyOf: choices },
				...optional("minItems", field.minItems),
				...optional("maxItems", field.maxItems),
			};
		case "number":
		case "integer":
			return {
				...base,
				type: field.type,
				...optional("minimum", field.minimum),
				...optional("maximum", field.maximum),
			};
		case "boolean":
			return { ...base, type: "boolean" };
		default:
			return {
				...base,
				type: "string",
				...optional("minLength", field.minLength),
				...optional("maxLength", field.maxLength),
				...optional("pattern", field.pattern),
				...optional("format", field.format),
			};
	}
}

/**
 * A dialog of the session (ui/request) as an ACP elicitation form: a confirmation has no fields
 * (accept = yes, decline = no), a choice or a text one field, an extension's form its own fields.
 */
export function elicitationForm(params: UiParams): { message: string; requestedSchema: Json } {
	const message = params.message ? `${params.title}\n\n${params.message}` : params.title;
	const answer = (schema: Json): Json => ({ type: "object", properties: { answer: schema }, required: ["answer"] });
	switch (params.kind) {
		case "confirm":
			return { message, requestedSchema: { type: "object", properties: {} } };
		case "select":
			return { message, requestedSchema: answer({ type: "string", title: params.title, enum: params.options ?? [] }) };
		case "selectMany":
			return {
				message,
				requestedSchema: answer({
					type: "array",
					title: params.title,
					items: { type: "string", enum: params.options ?? [] },
					minItems: 1,
				}),
			};
		case "input":
			return {
				message,
				requestedSchema: answer({
					type: "string",
					title: params.title,
					...(params.placeholder ? { description: params.placeholder } : {}),
				}),
			};
		case "editor":
			return {
				message,
				requestedSchema: answer({
					type: "string",
					title: params.title,
					...(params.prefill !== undefined ? { default: params.prefill } : {}),
				}),
			};
		default: {
			const form = (params.form ?? { title: params.title, fields: [] }) as unknown as UiForm;
			return {
				message: form.message ? `${form.title}\n\n${form.message}` : form.title,
				requestedSchema: {
					type: "object",
					properties: Object.fromEntries(form.fields.map((field) => [field.name, fieldSchema(field)])),
					required: form.fields.filter((field) => field.required).map((field) => field.name),
				},
			};
		}
	}
}

/** The editor's answer to elicitationForm as the dialog's result. */
export function elicitationAnswer(params: UiParams, response: unknown): UiResult {
	const { action, content } = (response ?? {}) as { action?: string; content?: Json };
	if (action === "decline") {
		if (params.kind === "confirm") return { confirmed: false };
		if (params.kind === "form") return { form: { action: "decline" } };
		return { cancelled: true };
	}
	if (action !== "accept") return { cancelled: true };
	const answer = content?.answer;
	switch (params.kind) {
		case "confirm":
			return { confirmed: true };
		case "select":
		case "input":
		case "editor":
			return typeof answer === "string" ? { value: answer } : { cancelled: true };
		case "selectMany": {
			const values = Array.isArray(answer) ? answer.filter((value): value is string => typeof value === "string") : [];
			return values.length > 0 ? { values } : { cancelled: true };
		}
		default:
			return { form: { action: "submit", values: content ?? {} } };
	}
}
