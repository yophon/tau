// Background commands in the CLI (P36a, Claude Code's background tasks): the end
// of a command reaches the model as a follow-up message, /tasks lists background
// commands next to background subagents, and a line above the input box counts
// the running ones.
import { closeSync, openSync, readSync, statSync } from "node:fs";
import {
	type BackgroundTask,
	SUBAGENT_STOP_CHANNEL,
	SUBAGENT_TASK_CHANNEL,
	type SubagentStopRequest,
} from "@yophon/tau-ext-subagents";
import type { NodeBackgroundShell } from "@yophon/tau-host-node";
import type { BackgroundTaskInfo, Extension, ExtensionAPI, ExtensionContext } from "@yophon/tau-kernel";
import { formatRunTime } from "./run-time.ts";
import type { Scheduler } from "./scheduler.ts";

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

/** Monitor (P44, Claude Code): the default deadline, the longest, and the longest in -p. */
export const MONITOR_DEFAULT_MS = 5 * 60 * 1000;
export const MONITOR_MAX_MS = 30 * 60 * 1000;
export const MONITOR_PRINT_MAX_MS = 10 * 60 * 1000;
/** Lines within this window go out as one notification (Claude Code). */
export const MONITOR_BATCH_MS = 200;
/** More notifications than this in a minute stop the monitor (tau's number; Claude Code gives none). */
export const MONITOR_MAX_PER_MINUTE = 60;

export interface BackgroundExtensionOptions {
	/** The workspace's scheduled tasks, listed by /tasks (P44). */
	scheduler?: Scheduler;
	/** The Monitor tool (P44); its longest deadline (Claude Code: 30 min, 10 min in -p). Absent: no tool. */
	monitor?: { maxTimeoutMs: number; batchMs?: number; maxPerMinute?: number };
}

interface MonitorState {
	description: string;
	events: number;
	pending: string;
	batch: string[];
	flushTimer?: ReturnType<typeof setTimeout>;
	deadline?: ReturnType<typeof setTimeout>;
	sent: number[];
	/** Why it is being stopped, told once it ended; undefined = stopped by the user (task_stop, /tasks). */
	stopReason?: string;
}

const minutes = (ms: number): number => Math.max(1, Math.round(ms / 60_000));

export function createBackgroundExtension(
	shell: NodeBackgroundShell,
	options: BackgroundExtensionOptions = {},
): Extension {
	// One subscription per workspace; /reload hands it the new api.
	let current: ExtensionAPI | undefined;
	const monitors = new Map<string, MonitorState>();

	const notifyModel = (customType: string, content: string, details: Record<string, unknown>): void => {
		try {
			current?.sendMessage(
				{ customType, content, display: true, details },
				{ deliverAs: "followUp", triggerTurn: true },
			);
		} catch {
			// A stale api (the workspace closed meanwhile).
		}
	};

	/** Send the lines gathered so far as one notification; too many in a minute stop the monitor. */
	const flushMonitor = (id: string, state: MonitorState): void => {
		if (state.flushTimer) clearTimeout(state.flushTimer);
		state.flushTimer = undefined;
		if (state.batch.length === 0) return;
		const lines = state.batch.splice(0);
		state.events += lines.length;
		const at = Date.now();
		state.sent = state.sent.filter((time) => at - time < 60_000);
		state.sent.push(at);
		notifyModel("monitor_event", `[Monitor ${id} "${state.description}"] ${lines.join("\n")}`, {
			id,
			lines: lines.length,
		});
		const maxPerMinute = options.monitor?.maxPerMinute ?? MONITOR_MAX_PER_MINUTE;
		if (state.sent.length > maxPerMinute && state.stopReason === undefined) {
			state.stopReason = `stopped: more than ${maxPerMinute} notifications in a minute; restart it with a tighter filter`;
			void shell.stop(id).catch(() => undefined);
		}
	};

	const onMonitorOutput = (id: string, chunk: string): void => {
		const state = monitors.get(id);
		if (!state || state.stopReason !== undefined) return;
		const lines = (state.pending + chunk).replace(/\r\n/g, "\n").split("\n");
		state.pending = lines.pop() ?? "";
		const fresh = lines.filter((line) => line.trim() !== "");
		if (fresh.length === 0) return;
		state.batch.push(...fresh);
		state.flushTimer ??= setTimeout(() => flushMonitor(id, state), options.monitor?.batchMs ?? MONITOR_BATCH_MS);
	};

	shell.onTaskEnd((task) => {
		const monitor = monitors.get(task.id);
		if (monitor) {
			monitors.delete(task.id);
			if (monitor.deadline) clearTimeout(monitor.deadline);
			if (monitor.stopReason === undefined && monitor.pending.trim() !== "") monitor.batch.push(monitor.pending);
			flushMonitor(task.id, monitor);
			// Stopped by the user (task_stop, /tasks): nobody needs to be told.
			const why =
				monitor.stopReason ?? (task.status === "killed" ? undefined : `ended: exit code ${task.exitCode ?? "unknown"}`);
			if (why !== undefined) {
				notifyModel(
					"monitor_event",
					`[Monitor ${task.id} "${monitor.description}" ${why}; ${monitor.events} event${monitor.events === 1 ? "" : "s"}]`,
					{ id: task.id, ended: true },
				);
			}
			return;
		}
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
		/** P46: you stopping a background subagent (it cannot be resumed afterwards, Claude Code). */
		const stopSubagent = (id: string): Promise<string> | undefined => {
			const request: SubagentStopRequest = { id, by: "user", reply: {} };
			api.events.emit(SUBAGENT_STOP_CHANNEL, request);
			return request.reply.result;
		};

		/** /tasks: list, then look at or stop one (with a UI), or by arguments (`<id>`, `stop <id>`). */
		const showTasks = async (args: string, ctx: ExtensionContext): Promise<string | undefined> => {
			const commands = shell.list();
			const words = args.trim().split(/\s+/).filter(Boolean);
			if (words[0] === "stop" && words[1]) {
				if (options.scheduler?.get(words[1])) return options.scheduler.delete(words[1]) ? `Deleted ${words[1]}.` : "";
				return stopSubagent(words[1]) ?? stop(words[1]);
			}
			if (words[0]) {
				const command = commands.find((task) => task.id === words[0]);
				if (command) return view(command);
				const subagent = subagents.get(words[0]);
				if (subagent) return subagentText(subagent);
				return `No background task ${words[0]}.`;
			}
			const subagentList = [...subagents.values()];
			const scheduled = options.scheduler?.list() ?? [];
			if (commands.length === 0 && subagentList.length === 0 && scheduled.length === 0) {
				return "No background tasks in this session.";
			}
			const rows: Array<{ text: string; command?: BackgroundTaskInfo; subagent?: BackgroundTask; job?: string }> = [
				...commands.map((task) => ({ text: commandRow(task), command: task })),
				...scheduled.map((job) => ({
					text: `⏰ ${job.id} ${job.cron} · next ${formatRunTime(job.nextRun)} · ${job.kind === "wakeup" ? "loop wakeup" : job.recurring ? "recurring" : "once"} · ${firstLine(job.prompt)}`,
					job: job.id,
				})),
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
			if (row.subagent) {
				if (row.subagent.status !== "running") return subagentText(row.subagent);
				const action = await ctx.ui.select(`${row.subagent.id} · ${firstLine(row.subagent.task)}`, ["View", "Stop"]);
				if (action === "Stop") return stopSubagent(row.subagent.id) ?? `${row.subagent.id} has already ended.`;
				return action === "View" ? subagentText(row.subagent) : undefined;
			}
			if (row.job) {
				const action = await ctx.ui.select(`Scheduled task ${row.job}`, ["Delete"]);
				return action === "Delete" && options.scheduler?.delete(row.job) ? `Deleted ${row.job}.` : undefined;
			}
			const task = row.command;
			if (!task) return undefined;
			if (task.status !== "running") return view(task);
			const action = await ctx.ui.select(`${task.id} · ${label(task)}`, ["View output", "Stop"]);
			if (action === "Stop") return stop(task.id);
			if (action === "View output") return view(task);
			return undefined;
		};

		if (options.monitor) {
			const maxTimeoutMs = options.monitor.maxTimeoutMs;
			api.registerTool(
				{
					name: "monitor",
					description: [
						"Start a background monitor that streams events from a long-running script. Each stdout line is an event — you keep working and notifications arrive in the chat. Events arrive on their own schedule and are not replies from the user.",
						"",
						"Pick by how many notifications you need:",
						'- One ("tell me when the server is ready / the build finishes") → use bash with run_in_background and a command that exits when the condition is true, e.g. `until grep -q "Ready in" dev.log; do sleep 0.5; done`.',
						'- One per occurrence, until the monitor expires ("tell me every time an ERROR line appears") → monitor with an unbounded command (`tail -f`, `while true`).',
						'- One per occurrence, until a known end ("emit each CI step result, stop when the run completes") → monitor with a command that emits lines and then exits.',
						"",
						"Your script's stdout is the event stream; exit ends the watch (the exit code is reported). Every pipe stage must flush per line (`grep --line-buffered`, awk with fflush()). Only stdout makes events: stderr goes to the output file — merge it with 2>&1 when its failures should reach your filter. Filter to the lines you would act on, covering failures as well as success: silence is not success. Lines within 200ms arrive as one notification; monitors that produce too many events are stopped — restart with a tighter filter. Poll remote APIs every 30s or more, local checks every 0.5–1s.",
						"",
						`Every monitor expires after timeout_ms (default 5 minutes, at most ${minutes(maxTimeoutMs)} minutes): it is stopped and you get one notice with the event count; re-arm it if you still need the watch. Use task_stop to cancel early. Write a specific description — it appears in every notification.`,
					].join("\n"),
					parameters: {
						type: "object",
						properties: {
							command: {
								type: "string",
								description: "Shell command or script. Each stdout line is an event; exit ends the watch.",
							},
							description: {
								type: "string",
								description: "Short human-readable description of what you are monitoring (shown in notifications).",
							},
							timeout_ms: {
								type: "number",
								description: `Stop the monitor after this deadline. Default 300000ms; deadlines above ${maxTimeoutMs}ms are capped to ${maxTimeoutMs}ms. You are notified at expiry and can re-arm.`,
							},
						},
						required: ["command", "description"],
					},
					execute: async (args) => {
						const command = typeof args.command === "string" ? args.command : "";
						if (command.trim() === "")
							return { content: [{ type: "text", text: "command must not be empty." }], isError: true };
						const description =
							typeof args.description === "string" && args.description.trim() !== ""
								? args.description.trim()
								: command;
						const asked =
							typeof args.timeout_ms === "number" && Number.isFinite(args.timeout_ms)
								? args.timeout_ms
								: MONITOR_DEFAULT_MS;
						const timeoutMs = Math.min(maxTimeoutMs, Math.max(1000, asked));
						const state: MonitorState = { description, events: 0, pending: "", batch: [], sent: [] };
						let id = "";
						// Output that arrives before start() returns the task id.
						const early: string[] = [];
						try {
							const task = await shell.start(command, {
								description: `monitor: ${description}`,
								onStdout: (chunk) => {
									if (id === "") early.push(chunk);
									else onMonitorOutput(id, chunk);
								},
							});
							id = task.id;
							monitors.set(id, state);
							for (const chunk of early.splice(0)) onMonitorOutput(id, chunk);
							state.deadline = setTimeout(() => {
								if (!monitors.has(id)) return;
								state.stopReason = `expired after ${minutes(timeoutMs)} min (re-arm it if you still need the watch)`;
								void shell.stop(id).catch(() => undefined);
							}, timeoutMs);
							(state.deadline as unknown as { unref?: () => void }).unref?.();
							return {
								content: [
									{
										type: "text",
										text: `Monitor ${id} started: "${description}". Each stdout line arrives as a notification; it stops after ${minutes(timeoutMs)} min or when the command exits. Output: ${task.outputPath}`,
									},
								],
							};
						} catch (error) {
							return {
								content: [
									{
										type: "text",
										text: `Could not start the monitor: ${error instanceof Error ? error.message : String(error)}`,
									},
								],
								isError: true,
							};
						}
					},
				},
				{ risk: "high" },
			);
		}

		api.registerCommand("tasks", {
			description: "Background commands, monitors, scheduled tasks and subagents: view, stop",
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
