/**
 * Per-tool views (from yo-agent surface-cli render/tool-views.ts, rewritten
 * for tau's tools): a tool block → a one-line head such as `read(src/a.ts)`
 * plus body lines — a short tail by default, the expanded body when verbose
 * (Ctrl+O). Unknown tools get the generic view; `mcp__server__tool` shows as
 * `server:tool`. Pure.
 */
import { firstLine, readLineNumber } from "../format.ts";
import type { Block } from "../model.ts";
import { renderDiff, renderNumberedDiff } from "./diff.ts";
import { highlightCode, languageOf } from "./highlight.ts";
import { parsePartialJson } from "./partial-json.ts";
import { plainLine, type StyledLine, span } from "./spans.ts";

export type ToolBlock = Extract<Block, { kind: "tool" }>;

export interface ToolView {
	head: string;
	body: StyledLine[];
}

const str = (args: Record<string, unknown>, field: string): string => {
	const value = args[field];
	return typeof value === "string" ? value : "";
};

/** The text to preview: the final result once there is one, else what streamed so far. */
function outputText(tool: ToolBlock): string {
	return (tool.result ?? tool.output).trimEnd();
}

/**
 * The last `n` lines of the output, after "… N more lines" (P38d): taken from the end, so a
 * command printing megabytes does not split all of it on every frame.
 */
function tailOf(tool: ToolBlock, n: number, dim = true): StyledLine[] {
	return tailText(outputText(tool), n, dim);
}

function tailText(text: string, n: number, dim = true): StyledLine[] {
	if (text === "") return [];
	let total = 1;
	for (let at = text.indexOf("\n"); at !== -1; at = text.indexOf("\n", at + 1)) total++;
	if (total <= n) return tail(text.split("\n"), n, dim);
	let start = text.length;
	for (let k = 0; k < n; k++) start = text.lastIndexOf("\n", start - 1);
	const shown = text
		.slice(start + 1)
		.split("\n")
		.map((line) => plainLine(line, dim ? { dim: true } : {}));
	return [plainLine(`… ${total - n} more lines`, { dim: true }), ...shown];
}

function outputLines(tool: ToolBlock): string[] {
	const text = outputText(tool);
	return text === "" ? [] : text.split("\n");
}

function tail(lines: string[], n: number, dim = true): StyledLine[] {
	const shown = lines.slice(-n).map((line) => plainLine(line, dim ? { dim: true } : {}));
	if (lines.length > n) shown.unshift(plainLine(`… ${lines.length - n} more lines`, { dim: true }));
	return shown;
}

function head(lines: string[], n: number): StyledLine[] {
	const shown = lines.slice(0, n).map((line) => plainLine(line, { dim: true }));
	if (lines.length > n) shown.push(plainLine(`… ${lines.length - n} more lines`, { dim: true }));
	return shown;
}

/**
 * Expanded (Ctrl+O, a click): all of it (P38b, Claude Code's transcript view). A finished result
 * is capped for the model already; a command still running shows its newest lines.
 */
const FULL = 2000;

/** Rows a collapsed edit or write shows before "… N more lines" (Ctrl+O or a click shows all). */
export const FILE_PREVIEW_ROWS = { edit: 16, write: 10 };

function clip(rows: StyledLine[], n: number): StyledLine[] {
	if (rows.length <= n) return rows;
	return [...rows.slice(0, n), plainLine(`… ${rows.length - n} more lines`, { dim: true })];
}

function errorBody(tool: ToolBlock, verbose: boolean): StyledLine[] {
	return tailOf(tool, verbose ? FULL : 3, false).map((line) =>
		line.map((part) => (part.dim ? part : { ...part, color: "red" })),
	);
}

type Renderer = (tool: ToolBlock, verbose: boolean) => ToolView;

export interface EditPair {
	oldText: string;
	newText: string;
}

/** An edit call's replacements: `edits[]` (pi 1.x) or the single oldText/newText pair. */
export function editPairs(args: Record<string, unknown>): EditPair[] {
	if (Array.isArray(args.edits)) {
		return args.edits.map((item) => {
			const edit = (item ?? {}) as Record<string, unknown>;
			return {
				oldText: typeof edit.oldText === "string" ? edit.oldText : "",
				newText: typeof edit.newText === "string" ? edit.newText : "",
			};
		});
	}
	return [{ oldText: str(args, "oldText"), newText: str(args, "newText") }];
}

/** The diffs of all replacements, separated by a dim marker. */
export function editDiff(edits: readonly EditPair[]): StyledLine[] {
	const lines: StyledLine[] = [];
	edits.forEach((edit, index) => {
		if (index > 0) lines.push(plainLine("···", { dim: true, color: "cyan" }));
		lines.push(...renderDiff(edit.oldText, edit.newText));
	});
	return lines;
}

/** Result lines without the trailing "[limit reached ...]" notice. */
function resultLines(tool: ToolBlock): string[] {
	const lines = outputLines(tool);
	while (lines.length > 0 && (/^\[.*\]$/.test(lines.at(-1) ?? "") || lines.at(-1) === "")) lines.pop();
	return lines;
}

/** bash and powershell (P40b): the output's last lines, a red exit code. */
function shellView(name: string, tool: ToolBlock, verbose: boolean): ToolView {
	// The "Exit code N" line the result ends with shows as the red "exit N" below.
	const body = tailText(outputText(tool).replace(/(^|\n)Exit code -?\d+$/, ""), verbose ? FULL : 5);
	if (tool.exitCode !== undefined && tool.exitCode !== 0) {
		body.push(plainLine(`exit ${tool.exitCode}`, { color: "red" }));
	} else if (tool.status === "error" && tool.exitCode === undefined && body.length === 0) {
		body.push(...errorBody(tool, verbose));
	}
	return { head: `${name}(${firstLine(str(tool.args, "command"), 80)})`, body };
}

const RENDERERS: Record<string, Renderer> = {
	read: (tool, verbose) => {
		// Numbers or numeric strings (pi 1.3, #9887).
		const offset = readLineNumber(tool.args.offset);
		const limit = readLineNumber(tool.args.limit);
		const range =
			offset !== undefined || limit !== undefined ? `:${offset ?? 1}${limit !== undefined ? `+${limit}` : ""}` : "";
		const view = { head: `read(${str(tool.args, "path")}${range})`, body: [] as StyledLine[] };
		if (tool.status === "error") return { ...view, body: errorBody(tool, verbose) };
		if (tool.status !== "ok") return view;
		const lines = outputLines(tool).filter((line) => !/^\[\d+ more lines; continue with offset=\d+\]$/.test(line));
		// A file ending in a newline reads back with an empty last numbered line.
		// (The trailing-whitespace trim leaves just the number.)
		if (/^\s*\d+\t?$/.test(lines.at(-1) ?? "")) lines.pop();
		const body = [plainLine(`${lines.length} line${lines.length === 1 ? "" : "s"}`, { dim: true })];
		if (verbose) body.push(...head(lines, FULL));
		return { ...view, body };
	},

	// pi: a write shows its first lines (all when expanded); an edit shows its diff.
	write: (tool, verbose) => {
		const content = str(tool.args, "content").replace(/\n$/, "");
		const lines = content === "" ? [] : content.split("\n");
		const view = { head: `write(${str(tool.args, "path")})`, body: [] as StyledLine[] };
		if (tool.status === "error") return { ...view, body: errorBody(tool, verbose) };
		// Highlighted by the file's language (pi); only what is shown is highlighted.
		const shown = verbose ? lines : lines.slice(0, FILE_PREVIEW_ROWS.write);
		const rows = highlightCode(shown.join("\n").replace(/\t/g, "   "), languageOf(str(tool.args, "path")), {
			dim: true,
		}).map((line) => (line.length > 0 ? line : plainLine("")));
		if (lines.length > shown.length) rows.push(plainLine(`… ${lines.length - shown.length} more lines`, { dim: true }));
		return { ...view, body: rows };
	},

	// The question, not its JSON; the result is written for the model (P38b).
	ask_user: (tool, verbose) => {
		const questions = Array.isArray(tool.args.questions) ? tool.args.questions : [];
		const first = (questions[0] ?? {}) as Record<string, unknown>;
		const title = typeof first.question === "string" ? firstLine(first.question, 60) : "";
		const more = questions.length > 1 ? ` +${questions.length - 1}` : "";
		const view = { head: `ask_user(${title}${more})`, body: [] as StyledLine[] };
		return tool.status === "error" ? { ...view, body: errorBody(tool, verbose) } : view;
	},

	edit: (tool, verbose) => {
		const view = { head: `edit(${str(tool.args, "path")})`, body: [] as StyledLine[] };
		if (tool.status === "error") return { ...view, body: errorBody(tool, verbose) };
		// The result's numbered diff (file line numbers); before it, the arguments' own diff.
		const rows = tool.diff !== undefined ? renderNumberedDiff(tool.diff) : editDiff(editPairs(tool.args));
		return { ...view, body: verbose ? rows : clip(rows, FILE_PREVIEW_ROWS.edit) };
	},

	grep: (tool, verbose) => {
		const title = `grep("${firstLine(str(tool.args, "pattern"), 50)}"${tool.args.path ? `, ${str(tool.args, "path")}` : ""})`;
		if (tool.status === "error") return { head: title, body: errorBody(tool, verbose) };
		if (tool.status !== "ok") return { head: title, body: [] };
		const lines = resultLines(tool);
		const matches = lines.filter((line) => /^.+:\d+: /.test(line)).length;
		if (matches === 0) return { head: title, body: [plainLine("no matches", { dim: true })] };
		return {
			head: title,
			body: [
				plainLine(`${matches} match${matches === 1 ? "" : "es"}`, { dim: true }),
				...head(lines, verbose ? FULL : 3),
			],
		};
	},

	find: (tool, verbose) => {
		const view = `find(${str(tool.args, "pattern")}${tool.args.path ? `, ${str(tool.args, "path")}` : ""})`;
		if (tool.status === "error") return { head: view, body: errorBody(tool, verbose) };
		if (tool.status !== "ok") return { head: view, body: [] };
		const lines = resultLines(tool).filter((line) => line !== "No files found matching pattern");
		const body = [plainLine(`${lines.length} file${lines.length === 1 ? "" : "s"}`, { dim: true })];
		if (lines.length > 0) body.push(...head(lines, verbose ? FULL : 3));
		return { head: view, body };
	},

	ls: (tool, verbose) => {
		const view = `ls(${str(tool.args, "path") || "."})`;
		if (tool.status === "error") return { head: view, body: errorBody(tool, verbose) };
		if (tool.status !== "ok") return { head: view, body: [] };
		const lines = resultLines(tool).filter((line) => line !== "(empty directory)");
		const body = [plainLine(`${lines.length} entr${lines.length === 1 ? "y" : "ies"}`, { dim: true })];
		if (verbose) body.push(...head(lines, 50));
		return { head: view, body };
	},

	bash: (tool, verbose) => shellView("bash", tool, verbose),
	// P40b: pi's powershell tool, drawn like bash.
	powershell: (tool, verbose) => shellView("powershell", tool, verbose),

	codemode: (tool, verbose) => {
		const code = str(tool.args, "code");
		const codeLines = code.split("\n").length;
		const body: StyledLine[] = [];
		if (verbose) body.push(...code.split("\n").map((line) => plainLine(line, { color: "cyan" })));
		body.push(...(tool.status === "error" ? errorBody(tool, verbose) : tailOf(tool, verbose ? FULL : 5)));
		return { head: `codemode(${codeLines} line${codeLines === 1 ? "" : "s"} of JavaScript)`, body };
	},

	subagent: (tool, verbose) => {
		const list = (field: string): Array<{ agent: string; task: string }> =>
			Array.isArray(tool.args[field])
				? (tool.args[field] as unknown[]).map((item) => {
						const step = (item ?? {}) as Record<string, unknown>;
						return {
							agent: typeof step.agent === "string" && step.agent !== "" ? step.agent : "worker",
							task: typeof step.task === "string" ? step.task : "",
						};
					})
				: [];
		const tasks = list("tasks");
		const chain = list("chain");
		const agent = str(tool.args, "agent") || "worker";
		const what =
			tasks.length > 0
				? `${tasks.length} in parallel: ${tasks.map((step) => step.agent).join(", ")}`
				: chain.length > 0
					? `chain: ${chain.map((step) => step.agent).join(" → ")}`
					: `${agent}: ${firstLine(str(tool.args, "task"), 60)}`;
		const head = `subagent(${what})${tool.args.background === true ? " · background" : ""}`;
		if (tool.status === "error") return { head, body: errorBody(tool, verbose) };
		// While running: the children's tool calls, one line each; then the answer's first lines.
		if (tool.result === undefined) return { head, body: tailOf(tool, verbose ? FULL : 6) };
		const answer = (tool.result ?? "").trim().split("\n");
		const shown = answer.slice(0, verbose ? FULL : 8).map((line) => plainLine(line, { dim: true }));
		if (answer.length > shown.length)
			shown.push(plainLine(`… ${answer.length - shown.length} more lines`, { dim: true }));
		return { head, body: shown };
	},

	todo_write: (tool, verbose) => {
		const todos = Array.isArray(tool.args.todos) ? (tool.args.todos as Array<Record<string, unknown>>) : [];
		const done = todos.filter((todo) => todo.status === "completed").length;
		const head = `todo(${done}/${todos.length} done)`;
		if (tool.status === "error") return { head, body: errorBody(tool, verbose) };
		const body = todos.map((todo): StyledLine => {
			const text = typeof todo.content === "string" ? todo.content : "";
			if (todo.status === "completed") return [span(`☑ ${text}`, { dim: true })];
			if (todo.status === "in_progress") return [span(`◐ ${text}`, { bold: true, color: "cyan" })];
			return [span(`☐ ${text}`)];
		});
		return { head, body };
	},

	web_fetch: (tool, verbose) => {
		const offset = typeof tool.args.offset === "number" && tool.args.offset > 0 ? ` @${tool.args.offset}` : "";
		const view = `web_fetch(${firstLine(str(tool.args, "url"), 80)}${offset})`;
		if (tool.status === "error") return { head: view, body: errorBody(tool, verbose) };
		if (tool.status !== "ok") return { head: view, body: [] };
		const lines = outputLines(tool);
		const title = lines[0]?.startsWith("# ") ? lines[0].slice(2) : undefined;
		const more = lines.some((line) => /^\[Characters \d+–\d+ of \d+\. Use offset=\d+/.test(line));
		const summary = `${title ? `${firstLine(title, 60)} · ` : ""}${lines.length} lines${more ? " · more with offset" : ""}`;
		const body = [plainLine(summary, { dim: true })];
		if (verbose) body.push(...head(lines, 40));
		return { head: view, body };
	},

	web_search: (tool, verbose) => {
		const view = `web_search("${firstLine(str(tool.args, "query"), 60)}")`;
		if (tool.status === "error") return { head: view, body: errorBody(tool, verbose) };
		if (tool.status !== "ok") return { head: view, body: [] };
		const lines = outputLines(tool);
		const titles = lines.filter((line) => /^\d+\. /.test(line));
		if (titles.length === 0) return { head: view, body: [plainLine("no results", { dim: true })] };
		return {
			head: view,
			body: [
				plainLine(`${titles.length} result${titles.length === 1 ? "" : "s"}`, { dim: true }),
				...head(verbose ? lines : titles, verbose ? FULL : 3),
			],
		};
	},

	tool_search: (tool, verbose) => ({
		head: `tool_search(${firstLine(str(tool.args, "query"), 60)})`,
		body: tool.status === "error" ? errorBody(tool, verbose) : tailOf(tool, verbose ? FULL : 3),
	}),

	// P46 (Claude Code's SendMessage): the recipient, and the summary (else the message's first line) as the preview.
	send_message: (tool, verbose) => {
		const summary = str(tool.args, "summary").trim() || firstLine(str(tool.args, "message"), 200);
		const preview = summary.length > 200 ? `${summary.slice(0, 199)}…` : summary;
		const body = preview === "" ? [] : [plainLine(preview, { dim: true })];
		if (tool.status === "error") body.push(...errorBody(tool, verbose));
		else if (verbose) body.push(...tailOf(tool, FULL));
		return { head: `send_message(${str(tool.args, "to")})`, body };
	},
};

/** `name(argument summary)`: the first string argument, else compact JSON. */
function genericArgs(args: Record<string, unknown>): string {
	const firstString = Object.values(args).find((value): value is string => typeof value === "string");
	if (firstString !== undefined) return firstLine(firstString, 50);
	let json: string;
	try {
		json = JSON.stringify(args) ?? "";
	} catch {
		json = "";
	}
	return json === "{}" ? "" : firstLine(json, 50);
}

export function displayToolName(name: string): string {
	const mcp = name.match(/^mcp__(.+?)__(.+)$/);
	return mcp ? `${mcp[1]}:${mcp[2]}` : name;
}

/** The last arguments parsed for a streaming call (one call streams at a time; the text only grows). */
let streamed: { text: string; args: Record<string, unknown> } | undefined;

/**
 * A call whose arguments are still streaming (P38b, pi): its title from what has arrived,
 * and for a write the newest lines of the content as the model writes them.
 */
function streamingView(tool: ToolBlock): ToolView {
	const text = tool.argsText ?? "";
	if (streamed?.text !== text) streamed = { text, args: parsePartialJson(text) };
	const view = toolView({ ...tool, args: streamed.args, status: "running", argsText: undefined }, false);
	if (tool.name !== "write") return { head: view.head, body: [] };
	const content = str(streamed.args, "content");
	const lines = content === "" ? [] : content.split("\n");
	return { head: view.head, body: tail(lines, FILE_PREVIEW_ROWS.write) };
}

export function toolView(tool: ToolBlock, verbose: boolean): ToolView {
	if (tool.status === "streaming") return streamingView(tool);
	const renderer = RENDERERS[tool.name];
	if (renderer) return renderer(tool, verbose);
	const body = tool.status === "error" ? errorBody(tool, verbose) : tailOf(tool, verbose ? FULL : 5);
	return { head: `${displayToolName(tool.name)}(${genericArgs(tool.args)})`, body };
}
