/**
 * The schedule and goal tools (P31), bound to one owner's conversation. The
 * gateway hands them to the host through ConversationHooks.extensions. All are
 * low risk: creating a schedule runs nothing; a firing goes through the
 * conversation's permissions and approvals like any message.
 */
import type { Extension } from "@yophon/tau-kernel";
import type { Goal, Schedule, ScheduleStore } from "./schedule.ts";
import { formatLocalTime } from "./time.ts";
import type { ConversationKey } from "./types.ts";

export interface ScheduleToolsHost {
	store: ScheduleStore;
	key: ConversationKey;
	/** Checked on every call: a revoked owner's resident conversation keeps the tools until it reloads. */
	isOwner(): boolean;
	/** After a schedule is saved: the gateway's confirmation message and timer. */
	created(schedule: Schedule): void;
}

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

const ok = (text: string): ToolResult => ({ content: [{ type: "text", text }] });
const fail = (text: string): ToolResult => ({ content: [{ type: "text", text }], isError: true });
const str = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

const RESULT_TEXT: Record<string, string> = {
	replied: "replied",
	silent: "nothing to report",
	failed: "failed",
	skipped: "skipped",
};

export function describeSchedule(store: ScheduleStore, entry: Schedule, now: number): string {
	const parts = [`#${entry.id} 「${entry.title}」 ${store.describeTiming(entry)}`];
	if (entry.nextAt !== undefined && entry.state === "active")
		parts.push(`next ${formatLocalTime(entry.nextAt, store.timeZone, now)}`);
	if (entry.state !== "active") parts.push(entry.state);
	if (entry.goalId) parts.push(`goal #${entry.goalId}`);
	if (entry.runs > 0) parts.push(`${entry.runs} run(s)`);
	if (entry.lastResult) parts.push(`last: ${RESULT_TEXT[entry.lastResult] ?? entry.lastResult}`);
	return parts.join(" · ");
}

export function describeGoal(store: ScheduleStore, goal: Goal, now: number): string {
	const lines = [`#${goal.id} 「${goal.title}」 ${goal.state}`];
	if (goal.detail) lines.push(`  ${goal.detail}`);
	for (const note of goal.notes.slice(-3))
		lines.push(`  ${formatLocalTime(note.at, store.timeZone, now)} ${note.text}`);
	return lines.join("\n");
}

export function createScheduleTools(host: ScheduleToolsHost): Extension {
	const { store, key } = host;
	const now = () => store.now();
	const nowLine = () => `Now: ${formatLocalTime(now(), store.timeZone, now())} (${store.timeZone}).`;
	const guard = (): ToolResult | undefined =>
		host.isOwner() ? undefined : fail("Only the owner's conversation can manage schedules and goals.");

	return (api) => {
		api.registerTool(
			{
				name: "schedule_create",
				description: [
					"Schedule a one-off reminder or a recurring task in this chat. When it fires, the prompt is handed to you as a message and your reply is sent to the user.",
					"Give exactly one of: at (local time like 2026-10-18T15:00, for 'at 3pm', 'tomorrow 9:00'), in (like 90m, 2h, 1d, for 'in half an hour'), cron (5 fields, minute hour day month weekday, for 'every day at 9', 'every Monday'; at least 5 minutes apart).",
					"The gateway confirms the stored time to the user itself.",
				].join(" "),
				promptSnippet: "Schedule reminders and recurring tasks in this chat",
				promptGuidelines: [
					"If you agree to remind the user or to do something later or regularly, you must call schedule_create; saying so is not enough.",
					"Write the prompt as a complete task you will understand on its own when it fires, possibly days later, after the chat has moved on or been compacted.",
					"Nobody is watching when a schedule fires: write prompts that use read-only tools (read, ls, find, grep) where they can, since anything needing approval asks the owner at every firing.",
					"For work towards an outcome (wait until CI is green, until a file appears), create a goal with goal_create, attach the schedule with goal_id, and mark the goal done with goal_update when it is reached; that stops its schedules.",
				],
				parameters: {
					type: "object",
					properties: {
						title: { type: "string", description: "A few words for the user, e.g. 'Summarize yesterday's commits'" },
						prompt: { type: "string", description: "The task to carry out when it fires" },
						at: { type: "string", description: "One-off, local time: 2026-10-18T15:00" },
						in: { type: "string", description: "One-off, from now: 90m, 2h, 1d, 1h30m" },
						cron: { type: "string", description: "Recurring, 5-field cron in local time: '0 9 * * *'" },
						goal_id: { type: "string", description: "Attach to this goal (from goal_create)" },
					},
					required: ["title", "prompt"],
				},
				execute: async (args) => {
					const denied = guard();
					if (denied) return denied;
					try {
						const entry = store.addSchedule({
							key,
							title: str(args.title) ?? "",
							prompt: str(args.prompt) ?? "",
							...(str(args.at) ? { at: str(args.at) } : {}),
							...(str(args.in) ? { in: str(args.in) } : {}),
							...(str(args.cron) ? { cron: str(args.cron) } : {}),
							...(str(args.goal_id) ? { goalId: str(args.goal_id) } : {}),
						});
						host.created(entry);
						return ok(
							`Scheduled ${describeSchedule(store, entry, now())}. ${nowLine()} The user has been sent a confirmation.`,
						);
					} catch (error) {
						return fail(`Not scheduled: ${error instanceof Error ? error.message : String(error)}. ${nowLine()}`);
					}
				},
			},
			{ risk: "low" },
		);

		api.registerTool(
			{
				name: "schedule_list",
				description: "List the schedules of this chat: id, timing, next firing, last result.",
				parameters: { type: "object", properties: {} },
				execute: async () => {
					const denied = guard();
					if (denied) return denied;
					store.reload();
					const entries = store.schedules(key).filter((entry) => entry.state === "active");
					if (entries.length === 0) return ok(`No active schedules. ${nowLine()}`);
					return ok([...entries.map((entry) => describeSchedule(store, entry, now())), nowLine()].join("\n"));
				},
			},
			{ risk: "low" },
		);

		api.registerTool(
			{
				name: "schedule_cancel",
				description: "Cancel one of this chat's schedules by id.",
				parameters: {
					type: "object",
					properties: { id: { type: "string", description: "The schedule id, e.g. k3f9" } },
					required: ["id"],
				},
				execute: async (args) => {
					const denied = guard();
					if (denied) return denied;
					const id = (str(args.id) ?? "").replace(/^#/, "").trim();
					const entry = store.cancelSchedule(id, key);
					return entry
						? ok(`Cancelled #${entry.id} 「${entry.title}」.`)
						: fail(`No active schedule #${id} in this chat.`);
				},
			},
			{ risk: "low" },
		);

		api.registerTool(
			{
				name: "goal_create",
				description:
					"Create a goal in this chat: an outcome to work towards over time, with a state (active, done, abandoned) and progress notes. Attach schedules to it with schedule_create's goal_id.",
				parameters: {
					type: "object",
					properties: {
						title: { type: "string", description: "The outcome, in a few words" },
						detail: { type: "string", description: "What counts as reached, and anything worth remembering" },
					},
					required: ["title"],
				},
				execute: async (args) => {
					const denied = guard();
					if (denied) return denied;
					try {
						const goal = store.addGoal({
							key,
							title: str(args.title) ?? "",
							...(str(args.detail) ? { detail: str(args.detail) } : {}),
						});
						return ok(`Created goal #${goal.id} 「${goal.title}」.`);
					} catch (error) {
						return fail(`Not created: ${error instanceof Error ? error.message : String(error)}`);
					}
				},
			},
			{ risk: "low" },
		);

		api.registerTool(
			{
				name: "goal_update",
				description:
					"Record progress on a goal and/or change its state. Setting state to done or abandoned ends the schedules attached to it.",
				parameters: {
					type: "object",
					properties: {
						id: { type: "string", description: "The goal id" },
						state: { type: "string", enum: ["active", "done", "abandoned"] },
						note: { type: "string", description: "A short progress note" },
					},
					required: ["id"],
				},
				execute: async (args) => {
					const denied = guard();
					if (denied) return denied;
					const id = (str(args.id) ?? "").replace(/^#/, "").trim();
					const state = str(args.state);
					const note = str(args.note);
					if (state !== undefined && !["active", "done", "abandoned"].includes(state)) {
						return fail("state must be active, done or abandoned");
					}
					if (state === undefined && !note?.trim()) return fail("give a state, a note, or both");
					const updated = store.updateGoal(
						id,
						{ ...(state ? { state: state as Goal["state"] } : {}), ...(note ? { note } : {}) },
						key,
					);
					if (!updated) return fail(`No goal #${id} in this chat.`);
					const ended = updated.ended.map((entry) => `#${entry.id} 「${entry.title}」`);
					return ok(
						[
							`Goal #${updated.goal.id} 「${updated.goal.title}」 is ${updated.goal.state}.`,
							...(ended.length > 0 ? [`Ended its schedules: ${ended.join(", ")}.`] : []),
						].join(" "),
					);
				},
			},
			{ risk: "low" },
		);

		api.registerTool(
			{
				name: "goal_list",
				description: "List this chat's goals with their latest notes (active ones unless all is true).",
				parameters: {
					type: "object",
					properties: { all: { type: "boolean", description: "Include finished goals" } },
				},
				execute: async (args) => {
					const denied = guard();
					if (denied) return denied;
					store.reload();
					const goals = store.goals(key).filter((goal) => args.all === true || goal.state === "active");
					if (goals.length === 0) return ok(args.all === true ? "No goals." : "No active goals.");
					return ok(goals.map((goal) => describeGoal(store, goal, now())).join("\n"));
				},
			},
			{ risk: "low" },
		);
	};
}
