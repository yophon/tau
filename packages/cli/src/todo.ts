// todo_write (P26c): the model keeps a checklist for multi-step work. Shape
// from yo-agent / Claude Code: every call sends the whole list. The list is a
// `todos` custom entry, so --continue and /tree restore the one on the active
// branch; a widget above the input box shows the item in progress.
import type { Extension, ExtensionContext, SessionEntry } from "@yophon/tau-kernel";

export type TodoStatus = "pending" | "in_progress" | "completed";

export interface TodoItem {
	content: string;
	status: TodoStatus;
}

const MAX_TODOS = 50;
const STATUSES: readonly TodoStatus[] = ["pending", "in_progress", "completed"];

/** Validate the tool arguments; throws a message the model can act on. */
export function parseTodos(value: unknown): TodoItem[] {
	if (!Array.isArray(value)) throw new Error('"todos" must be an array of {content, status}');
	if (value.length > MAX_TODOS) throw new Error(`At most ${MAX_TODOS} todos (got ${value.length})`);
	const todos = value.map((item, index) => {
		const todo = (item ?? {}) as Record<string, unknown>;
		const content = typeof todo.content === "string" ? todo.content.trim() : "";
		if (content === "") throw new Error(`todos[${index}].content is empty`);
		const status = todo.status;
		if (typeof status !== "string" || !(STATUSES as readonly string[]).includes(status)) {
			throw new Error(`todos[${index}].status must be pending, in_progress or completed`);
		}
		return { content, status: status as TodoStatus };
	});
	const active = todos.filter((todo) => todo.status === "in_progress").length;
	if (active > 1)
		throw new Error(`Only one todo can be in_progress at a time (got ${active}); finish or pause the others`);
	return todos;
}

function formatTodos(todos: readonly TodoItem[]): string {
	return todos
		.map((todo) => `${todo.status === "completed" ? "☑" : todo.status === "in_progress" ? "◐" : "☐"} ${todo.content}`)
		.join("\n");
}

/** The latest `todos` entry on a branch. */
export function todosFromEntries(entries: readonly SessionEntry[]): TodoItem[] {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i] as SessionEntry;
		if (entry.type !== "custom" || entry.customType !== "todos") continue;
		try {
			return parseTodos((entry.data as { todos?: unknown } | undefined)?.todos);
		} catch {
			return [];
		}
	}
	return [];
}

/** One line for the widget: the item in progress and how far along the list is. */
export function todoSummary(todos: readonly TodoItem[]): string | undefined {
	if (todos.length === 0 || todos.every((todo) => todo.status === "completed")) return undefined;
	const done = todos.filter((todo) => todo.status === "completed").length;
	const current =
		todos.find((todo) => todo.status === "in_progress") ?? todos.find((todo) => todo.status === "pending");
	return `◐ ${current?.content ?? ""} · ${done}/${todos.length} done`;
}

export const todoExtension: Extension = (api) => {
	// The list this process wrote last: the log is written in the background, so a
	// widget refresh right after the tool may not see the entry yet. Another session
	// or branch starts from the log again.
	let written: TodoItem[] | undefined;
	const current = (ctx: ExtensionContext): TodoItem[] =>
		written ?? todosFromEntries(ctx.sessionManager?.getBranch() ?? []);
	api.on("session_start", () => {
		written = undefined;
	});
	api.on("session_tree", () => {
		written = undefined;
	});

	api.registerTool(
		{
			name: "todo_write",
			description:
				"Create or update the todo list for the current task. Send the complete list every time; each item has content and a status (pending, in_progress, completed).",
			promptSnippet: "Plan and track multi-step work as a todo list",
			promptGuidelines: [
				"Use todo_write for tasks with three or more distinct steps; skip it for simple requests.",
				"Send the whole list on every call, keep exactly one item in_progress while you work, and mark items completed as soon as they are done.",
			],
			parameters: {
				type: "object",
				properties: {
					todos: {
						type: "array",
						description: "The complete todo list",
						items: {
							type: "object",
							properties: {
								content: { type: "string", description: "What to do, in a few words" },
								status: { type: "string", enum: ["pending", "in_progress", "completed"] },
							},
							required: ["content", "status"],
						},
					},
				},
				required: ["todos"],
			},
			execute: async (args) => {
				let todos: TodoItem[];
				try {
					todos = parseTodos(args.todos);
				} catch (error) {
					return {
						content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
						isError: true,
					};
				}
				written = todos;
				api.appendEntry("todos", { todos });
				const text = todos.length === 0 ? "The todo list is empty." : `Todo list updated:\n${formatTodos(todos)}`;
				return { content: [{ type: "text", text }] };
			},
		},
		{ risk: "low" },
	);

	api.registerCommand("todos", {
		description: "Show the todo list",
		handler: (_args, ctx) => {
			const todos = current(ctx);
			if (todos.length === 0) return "The todo list is empty.";
			const done = todos.filter((todo) => todo.status === "completed").length;
			return `Todos (${done}/${todos.length} done)\n${formatTodos(todos)}`;
		},
	});

	api.registerWidget("todos", {
		placement: "above-editor",
		description: "The todo item in progress",
		handler: (ctx) => todoSummary(current(ctx)),
	});
};
