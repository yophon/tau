// Background commands in the CLI (P36a, Claude Code's background tasks): the end
// of a command reaches the model as a follow-up message, /tasks lists background
// commands next to background subagents, and a line above the input box counts
// the running ones.
import { closeSync, openSync, readSync, statSync } from "node:fs";
import { type BackgroundTask, SUBAGENT_TASK_CHANNEL } from "@yophon/tau-ext-subagents";
import type { NodeBackgroundShell } from "@yophon/tau-host-node";
import type { BackgroundTaskInfo, Extension, ExtensionAPI, ExtensionContext } from "@yophon/tau-kernel";

/** Lines of output the end-of-task message carries. */
const NOTICE_LINES = 20;
/** Lines /tasks shows for one command. */
const VIEW_LINES = 200;
/** Bytes read from the end of an output file to find those lines. */
const TAIL_BYTES = 256 * 1024;

/** The last `lines` lines of a file (empty when it is missing). */
export function readTail(path: string, lines: number): string {
	let fd: number | undefined;
	try {
		const size = statSync(path).size;
		const length = Math.min(size, TAIL_BYTES);
		const buffer = Buffer.alloc(length);
		fd = openSync(path, "r");
		readSync(fd, buffer, 0, length, size - length);
		const text = buffer.toString("utf8").replace(/\r\n/g, "\n").replace(/\n+$/, "");
		const all = text.split("\n");
		// A cut at the start of the window may have split the first line: drop it.
		const whole = length < size ? all.slice(1) : all;
		return whole.slice(-lines).join("\n");
	} catch {
		return "";
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}

function seconds(start: number, end: number | undefined): string {
	const total = Math.round(((end ?? Date.now()) - start) / 1000);
	return total < 60 ? `${total}s` : `${Math.floor(total / 60)}m${String(total % 60).padStart(2, "0")}s`;
}

function label(task: BackgroundTaskInfo): string {
	return task.description ?? task.command;
}

/** The message the model gets when a background command exits on its own (Claude Code's task notification). */
export function taskEndMessage(task: BackgroundTaskInfo, tail: string): string {
	const how =
		task.status === "completed"
			? "completed: exit code 0"
			: `failed${task.exitCode !== undefined ? `: exit code ${task.exitCode}` : ""}`;
	return [
		`[Background task ${task.id} ${how}] ${task.command}`,
		`Output: ${task.outputPath}`,
		...(tail === "" ? [] : [tail]),
	].join("\n");
}

const MARK: Record<BackgroundTaskInfo["status"], string> = { running: "◐", completed: "●", failed: "✗", killed: "■" };

export function createBackgroundExtension(shell: NodeBackgroundShell): Extension {
	// One subscription per workspace; /reload hands it the new api.
	let current: ExtensionAPI | undefined;
	shell.onTaskEnd((task) => {
		// Stopped with task_stop, /tasks or on exit: nobody needs to be told.
		if (task.status === "killed" || !current) return;
		try {
			current.sendMessage(
				{
					customType: "background_task",
					content: taskEndMessage(task, readTail(task.outputPath, NOTICE_LINES)),
					display: true,
					details: { id: task.id, status: task.status, exitCode: task.exitCode, outputPath: task.outputPath },
				},
				{ deliverAs: "followUp", triggerTurn: true },
			);
		} catch {
			// A stale api (the workspace closed meanwhile): the task simply ended.
		}
	});

	return (api) => {
		current = api;
		const subagents = new Map<string, BackgroundTask>();
		api.events.on(SUBAGENT_TASK_CHANNEL, (data) => {
			const task = data as BackgroundTask;
			if (typeof task?.id === "string") subagents.set(task.id, task);
		});

		const stop = (id: string): Promise<string> => stopTask(shell, id);

		/** /tasks: list, then look at or stop one (with a UI), or by arguments (`<id>`, `stop <id>`). */
		const showTasks = async (args: string, ctx: ExtensionContext): Promise<string | undefined> => {
			const commands = shell.list();
			const words = args.trim().split(/\s+/).filter(Boolean);
			if (words[0] === "stop" && words[1]) return stop(words[1]);
			if (words[0]) {
				const command = commands.find((task) => task.id === words[0]);
				if (command) return view(command);
				const subagent = subagents.get(words[0]);
				if (subagent) return subagentText(subagent);
				return `No background task ${words[0]}.`;
			}
			const subagentList = [...subagents.values()];
			if (commands.length === 0 && subagentList.length === 0) return "No background tasks in this session.";
			const rows: Array<{ text: string; command?: BackgroundTaskInfo; subagent?: BackgroundTask }> = [
				...commands.map((task) => ({ text: commandRow(task), command: task })),
				...subagentList.map((task) => ({
					text: `${task.status === "running" ? "◐" : task.status === "done" ? "●" : "✗"} ${task.id} ${task.agent} · ${task.status} · ${seconds(task.startedAt, task.endedAt)} · ${firstLine(task.task)}`,
					subagent: task,
				})),
			];
			if (!ctx.ui) return rows.map((row) => row.text).join("\n");
			const labels = rows.map((row) => row.text);
			const picked = await ctx.ui.select("Background tasks", labels);
			const row = picked === undefined ? undefined : rows[labels.indexOf(picked)];
			if (!row) return undefined;
			if (row.subagent) return subagentText(row.subagent);
			const task = row.command;
			if (!task) return undefined;
			if (task.status !== "running") return view(task);
			const action = await ctx.ui.select(`${task.id} · ${label(task)}`, ["View output", "Stop"]);
			if (action === "Stop") return stop(task.id);
			if (action === "View output") return view(task);
			return undefined;
		};

		api.registerCommand("tasks", {
			description: "Background commands and subagents: view output, stop",
			handler: (args, ctx) => showTasks(args, ctx),
			getArgumentCompletions: (prefix) => {
				const running = shell.list().filter((task) => task.status === "running");
				const options = [
					...shell.list().map((task) => ({ value: task.id, label: task.id, description: label(task) })),
					...running.map((task) => ({
						value: `stop ${task.id}`,
						label: `stop ${task.id}`,
						description: label(task),
					})),
				];
				return options.filter((option) => option.value.startsWith(prefix));
			},
		});

		api.registerWidget("background", {
			placement: "above-editor",
			description: "Background commands still running",
			handler: () => {
				const running = shell.running;
				if (running === 0) return undefined;
				return `● ${running} background command${running === 1 ? "" : "s"}  (/tasks)`;
			},
			onClick: async (ctx) => {
				const text = await showTasks("", ctx);
				if (text) ctx.ui?.notify(text, "info");
			},
		});
	};
}

function commandRow(task: BackgroundTaskInfo): string {
	return `${MARK[task.status]} ${task.id} ${task.status} · ${seconds(task.startedAt, task.endedAt)} · ${label(task)}`;
}

function view(task: BackgroundTaskInfo): string {
	const tail = readTail(task.outputPath, VIEW_LINES);
	const state =
		task.status === "running"
			? "running"
			: `${task.status}${task.exitCode !== undefined ? ` (exit ${task.exitCode})` : ""}`;
	return `${task.id} ${state} · ${seconds(task.startedAt, task.endedAt)} · ${task.command}\n${task.outputPath}\n\n${tail === "" ? "(no output yet)" : tail}`;
}

async function stopTask(shell: NodeBackgroundShell, id: string): Promise<string> {
	try {
		const task = await shell.stop(id);
		return `Stopped ${task.id} (${label(task)}).`;
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
}

/**
 * /tasks as text, for background commands only (P36a: the gateway's chat command,
 * which answers at once, also while a run is going): list, `<id>` shows the output, `stop <id>`.
 */
export async function backgroundTasksText(shell: NodeBackgroundShell, args: string): Promise<string> {
	const words = args.trim().split(/\s+/).filter(Boolean);
	if (words[0] === "stop" && words[1]) return stopTask(shell, words[1]);
	const commands = shell.list();
	if (words[0]) {
		const task = commands.find((candidate) => candidate.id === words[0]);
		return task ? view(task) : `No background task ${words[0]}.`;
	}
	return commands.length === 0 ? "No background commands." : commands.map(commandRow).join("\n");
}

function firstLine(text: string, max = 60): string {
	const line = text.split("\n")[0] ?? "";
	return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function subagentText(task: BackgroundTask): string {
	return task.status === "running"
		? `${task.id} is still running: ${task.task}`
		: `${task.id} (${task.agent}) ${task.status}:\n\n${task.result ?? ""}`;
}
