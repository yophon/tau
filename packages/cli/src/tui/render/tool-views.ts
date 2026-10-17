/**
 * Per-tool views (from yo-agent surface-cli render/tool-views.ts, rewritten
 * for tau's tools): a tool block → a one-line head such as `read(src/a.ts)`
 * plus body lines — a short tail by default, the expanded body when verbose
 * (Ctrl+O). Unknown tools get the generic view; `mcp__server__tool` shows as
 * `server:tool`. Pure.
 */
import { firstLine } from "../format.ts";
import type { Block } from "../model.ts";
import { diffStat, diffStrings, renderDiff } from "./diff.ts";
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
	return (tool.result ?? tool.output).replace(/\s+$/, "");
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

function errorBody(tool: ToolBlock, verbose: boolean): StyledLine[] {
	return tail(outputLines(tool), verbose ? 30 : 3, false).map((line) =>
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

const RENDERERS: Record<string, Renderer> = {
	read: (tool, verbose) => {
		const range =
			typeof tool.args.offset === "number" || typeof tool.args.limit === "number"
				? `:${typeof tool.args.offset === "number" ? tool.args.offset : 1}${typeof tool.args.limit === "number" ? `+${tool.args.limit}` : ""}`
				: "";
		const view = { head: `read(${str(tool.args, "path")}${range})`, body: [] as StyledLine[] };
		if (tool.status === "error") return { ...view, body: errorBody(tool, verbose) };
		if (tool.status !== "ok") return view;
		const lines = outputLines(tool).filter((line) => !/^\[\d+ more lines; continue with offset=\d+\]$/.test(line));
		// A file ending in a newline reads back with an empty last numbered line.
		// (The trailing-whitespace trim leaves just the number.)
		if (/^\s*\d+\t?$/.test(lines.at(-1) ?? "")) lines.pop();
		const body = [plainLine(`${lines.length} line${lines.length === 1 ? "" : "s"}`, { dim: true })];
		if (verbose) body.push(...head(lines, 40));
		return { ...view, body };
	},

	write: (tool, verbose) => {
		const content = str(tool.args, "content");
		const lines = content === "" ? [] : content.split("\n");
		const view = { head: `write(${str(tool.args, "path")})`, body: [] as StyledLine[] };
		if (tool.status === "error") return { ...view, body: errorBody(tool, verbose) };
		const body = [plainLine(`${lines.length} line${lines.length === 1 ? "" : "s"}`, { dim: true })];
		if (verbose) body.push(...head(lines, 20));
		return { ...view, body };
	},

	edit: (tool, verbose) => {
		const edits = editPairs(tool.args);
		const view = { head: `edit(${str(tool.args, "path")})`, body: [] as StyledLine[] };
		if (tool.status === "error") return { ...view, body: errorBody(tool, verbose) };
		if (verbose) return { ...view, body: editDiff(edits) };
		let add = 0;
		let del = 0;
		for (const edit of edits) {
			const stat = diffStat(diffStrings(edit.oldText, edit.newText));
			add += stat.add;
			del += stat.del;
		}
		const where = edits.length > 1 ? [span(` in ${edits.length} places`, { dim: true })] : [];
		return { ...view, body: [[span(`+${add} `, { color: "green" }), span(`-${del}`, { color: "red" }), ...where]] };
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
				...head(lines, verbose ? 50 : 3),
			],
		};
	},

	find: (tool, verbose) => {
		const view = `find(${str(tool.args, "pattern")}${tool.args.path ? `, ${str(tool.args, "path")}` : ""})`;
		if (tool.status === "error") return { head: view, body: errorBody(tool, verbose) };
		if (tool.status !== "ok") return { head: view, body: [] };
		const lines = resultLines(tool).filter((line) => line !== "No files found matching pattern");
		const body = [plainLine(`${lines.length} file${lines.length === 1 ? "" : "s"}`, { dim: true })];
		if (lines.length > 0) body.push(...head(lines, verbose ? 50 : 3));
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

	bash: (tool, verbose) => {
		const lines = outputLines(tool).filter((line) => !/^Exit code -?\d+$/.test(line));
		const body = tail(lines, verbose ? 30 : 5);
		if (tool.exitCode !== undefined && tool.exitCode !== 0) {
			body.push(plainLine(`exit ${tool.exitCode}`, { color: "red" }));
		} else if (tool.status === "error" && tool.exitCode === undefined && lines.length === 0) {
			body.push(...errorBody(tool, verbose));
		}
		return { head: `bash(${firstLine(str(tool.args, "command"), 80)})`, body };
	},

	codemode: (tool, verbose) => {
		const code = str(tool.args, "code");
		const codeLines = code.split("\n").length;
		const body: StyledLine[] = [];
		if (verbose) body.push(...code.split("\n").map((line) => plainLine(line, { color: "cyan" })));
		body.push(...(tool.status === "error" ? errorBody(tool, verbose) : tail(outputLines(tool), verbose ? 30 : 5)));
		return { head: `codemode(${codeLines} line${codeLines === 1 ? "" : "s"} of JavaScript)`, body };
	},

	tool_search: (tool, verbose) => ({
		head: `tool_search(${firstLine(str(tool.args, "query"), 60)})`,
		body: tool.status === "error" ? errorBody(tool, verbose) : tail(outputLines(tool), verbose ? 30 : 3),
	}),
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

export function toolView(tool: ToolBlock, verbose: boolean): ToolView {
	const renderer = RENDERERS[tool.name];
	if (renderer) return renderer(tool, verbose);
	const body = tool.status === "error" ? errorBody(tool, verbose) : tail(outputLines(tool), verbose ? 30 : 5);
	return { head: `${displayToolName(tool.name)}(${genericArgs(tool.args)})`, body };
}
