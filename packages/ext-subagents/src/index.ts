/**
 * The `subagent` tool (P26b). Shape from pi's subagent example
 * (examples/extensions/subagent/index.ts): single `{agent, task}`, parallel
 * `{tasks: [...]}` (at most 8, 4 at a time) and chain `{chain: [...]}` with
 * `{previous}` replaced by the prior step's output, over agent definitions
 * (agents.ts). From yo-agent: `background` (returns at once; the result comes
 * back as a follow-up message), definitions can only tighten the parent's
 * permissions, and a subagent never gets this tool (no recursive spawning).
 *
 * P46 (Claude Code's SendMessage and TaskStop): every subagent gets an ID (and,
 * optionally, a name); `send_message` resumes a finished one in the background
 * with its whole history, or steers a running one; a background subagent can be
 * stopped by ID (the host's task_stop asks through SUBAGENT_STOP_CHANNEL). Each
 * subagent's messages are saved next to the session (`<session>/subagents/`), so
 * a resumed session can still continue them.
 *
 * Deviation from pi: children run in-process through ctx.runSubagent rather
 * than as separate pi processes, so every host can run them and their
 * approvals use the parent's prompt.
 */
import type {
	AgentEvent,
	AgentMessage,
	AgentRunResult,
	Extension,
	ExtensionAPI,
	ExtensionContext,
	FileSystem,
	JsonObject,
	PermissionMode,
	SubagentHandle,
	TauAbortSignal,
	Usage,
} from "@yophon/tau-kernel";
import { type AgentDefinition, type AgentDirectories, DEFAULT_AGENT, discoverAgents } from "./agents.ts";

export {
	type AgentDefinition,
	type AgentDirectories,
	builtinAgents,
	discoverAgents,
	parseAgentFile,
} from "./agents.ts";

export const MAX_PARALLEL_TASKS = 8;
export const MAX_CONCURRENCY = 4;
export const SEND_MESSAGE_TOOL = "send_message";

export interface SubagentsOptions {
	toolName?: string;
	maxTurnsPerPrompt?: number;
	/** Override where agent definitions are looked up (defaults come from ctx.capabilities.paths). */
	directories?: AgentDirectories;
	/**
	 * Register /tasks (default true). A host that lists background subagents together with
	 * its own background work turns it off and follows {@link SUBAGENT_TASK_CHANNEL} instead.
	 */
	tasksCommand?: boolean;
	/**
	 * Parent tools a child never inherits (P44: the CLI's scheduling and monitor tools, whose
	 * tasks would outlive the child). Agents naming them in `tools` still get them.
	 */
	parentOnlyTools?: readonly string[];
	/** Register send_message (P46, default true; the gateway turns it off). */
	sendMessage?: boolean;
	/** Save subagents next to the session so a resumed session can continue them (default true). */
	persist?: boolean;
}

/** Event bus channel (api.events) carrying a {@link BackgroundTask} copy whenever one starts or ends (P36a). */
export const SUBAGENT_TASK_CHANNEL = "subagents:task";

/**
 * Event bus channel (P46): a host asks to stop a background subagent by ID or name. A
 * subagent this extension knows sets `reply.result`; "model" stops (task_stop) can be
 * resumed with send_message, "user" stops (/tasks) cannot (Claude Code).
 */
export const SUBAGENT_STOP_CHANNEL = "subagents:stop";

export interface SubagentStopRequest {
	id: string;
	by: "model" | "user";
	reply: { result?: Promise<string> };
}

interface Step {
	agent: string;
	task: string;
	name?: string;
}

export interface BackgroundTask {
	id: string;
	name?: string;
	agent: string;
	task: string;
	/** stopped: by the model, can be resumed; cancelled: by the user, cannot. */
	status: "running" | "done" | "failed" | "stopped" | "cancelled";
	startedAt: number;
	endedAt?: number;
	result?: string;
}

/** A subagent of this session: what /tasks shows plus what resuming it needs. */
interface SubagentRecord extends BackgroundTask {
	background: boolean;
	toolNames: string[];
	systemPrompt: string;
	model?: string;
	mode?: PermissionMode;
	messages: AgentMessage[];
	controller?: AbortController;
	/** The background run in flight (a stopped run is awaited before the agent resumes). */
	run?: Promise<unknown>;
	handle?: SubagentHandle;
	/** Messages sent before the child existed (it is starting). */
	pendingSteer: string[];
	stoppedBy?: "model" | "user";
}

const NAME_RE = /^[A-Za-z0-9][\w.-]{0,63}$/;

function steps(value: unknown, field: string): Step[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value)) throw new Error(`"${field}" must be an array of {agent, task}`);
	return value.map((item, index) => {
		const step = (item ?? {}) as Record<string, unknown>;
		if (typeof step.task !== "string" || step.task.trim() === "")
			throw new Error(`${field}[${index}].task is required`);
		return {
			agent: typeof step.agent === "string" && step.agent.trim() !== "" ? step.agent.trim() : DEFAULT_AGENT,
			task: step.task,
			...(typeof step.name === "string" && step.name.trim() !== "" ? { name: step.name.trim() } : {}),
		};
	});
}

function firstLine(text: string, max = 80): string {
	const line = text.trim().split("\n")[0] ?? "";
	return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function argSummary(args: JsonObject): string {
	const value = Object.values(args).find((entry): entry is string => typeof entry === "string");
	return value === undefined ? "" : firstLine(value, 60);
}

function addUsage(total: Usage | undefined, more: Usage): Usage {
	if (!total) return more;
	return {
		input: total.input + more.input,
		output: total.output + more.output,
		cacheRead: total.cacheRead + more.cacheRead,
		cacheWrite: total.cacheWrite + more.cacheWrite,
		totalTokens: total.totalTokens + more.totalTokens,
		cost: {
			input: total.cost.input + more.cost.input,
			output: total.cost.output + more.cost.output,
			cacheRead: total.cost.cacheRead + more.cost.cacheRead,
			cacheWrite: total.cost.cacheWrite + more.cost.cacheWrite,
			total: total.cost.total + more.cost.total,
		},
	};
}

async function mapWithConcurrency<T, R>(
	items: readonly T[],
	limit: number,
	run: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
	const results = new Array<R>(items.length);
	let next = 0;
	const worker = async (): Promise<void> => {
		while (next < items.length) {
			const index = next++;
			results[index] = await run(items[index] as T, index);
		}
	};
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
	return results;
}

function defaultDirectories(ctx: ExtensionContext): AgentDirectories {
	const paths = ctx.capabilities?.paths;
	const user: string[] = [];
	const project: string[] = [];
	if (paths?.userTauDir) {
		const home = paths.userTauDir.replace(/[\\/]+$/, "").replace(/[\\/][^\\/]+$/, "");
		user.push(`${home}/.pi/agent/agents`, `${paths.userTauDir}/agents`);
	}
	// The host gives project paths only for a trusted project; ask again anyway (pi confirms project agents).
	if (ctx.isProjectTrusted?.() !== false) {
		if (paths?.projectPiDir) project.push(`${paths.projectPiDir}/agents`);
		if (paths?.projectTauDir) project.push(`${paths.projectTauDir}/agents`);
	}
	return { user, project };
}

function describe(toolName: string, agents: readonly AgentDefinition[]): string {
	const list = agents.map((agent) => `- ${agent.name}: ${agent.description}`).join("\n");
	return [
		"Delegate tasks to subagents, each with its own context window; only their final answers come back.",
		`Modes: single ({agent, task}), parallel ({tasks: [{agent, task}, ...]}, at most ${MAX_PARALLEL_TASKS}, ${MAX_CONCURRENCY} at a time), chain ({chain: [...]}, where {previous} in a task is replaced by the prior step's output).`,
		`Set background: true to return immediately; the result arrives later as a follow-up message. agent defaults to "${DEFAULT_AGENT}".`,
		`Every subagent gets an agent ID (sub-N), shown with its result; give it a name to address it by name. Use ${SEND_MESSAGE_TOOL} with the ID or name to continue a finished subagent with its full history, or to steer one still running in the background.`,
		`Subagents cannot call ${toolName}. Available agents:`,
		list,
	].join("\n");
}

const STEP_ITEM = {
	type: "object",
	properties: {
		agent: { type: "string" },
		task: { type: "string" },
		name: { type: "string", description: "A name to address this subagent by with send_message" },
	},
	required: ["task"],
};

const PARAMETERS = {
	type: "object",
	properties: {
		agent: { type: "string", description: `Name of the agent to invoke (single mode; default "${DEFAULT_AGENT}")` },
		task: { type: "string", description: "Task to delegate (single mode)" },
		name: { type: "string", description: "A name to address the subagent by with send_message (single mode)" },
		tasks: {
			type: "array",
			description: `Array of {agent, task, name?} to run in parallel (at most ${MAX_PARALLEL_TASKS})`,
			items: STEP_ITEM,
		},
		chain: {
			type: "array",
			description: "Array of {agent, task, name?} to run in order; {previous} in a task is the prior step's output",
			items: STEP_ITEM,
		},
		background: { type: "boolean", description: "Return immediately; the result arrives later as a follow-up message" },
	},
};

const SEND_MESSAGE_DESCRIPTION = [
	"Send a message to a subagent by its agent ID (e.g. sub-3) or its name.",
	"- A finished subagent (done, failed, or stopped with task_stop) resumes in the background with its full history and your message; its result arrives as a follow-up message.",
	"- A subagent still running in the background reads your message before its next step.",
	"Messages direct the subagent's task; they cannot approve anything or change its permissions.",
].join("\n");

const SEND_MESSAGE_PARAMETERS = {
	type: "object",
	properties: {
		to: { type: "string", description: "The subagent's agent ID (sub-N) or name" },
		message: { type: "string", description: "What the subagent should do next" },
		summary: { type: "string", description: "A 5-10 word preview of the message, shown to the user" },
	},
	required: ["to", "message"],
};

interface StoredMeta {
	id: string;
	name?: string;
	agent: string;
	task: string;
	status: BackgroundTask["status"];
	startedAt: number;
	endedAt?: number;
	result?: string;
	toolNames: string[];
	systemPrompt: string;
	model?: string;
	mode?: PermissionMode;
}

/** `<session file without .jsonl>/subagents` (Claude Code keeps `<session>/subagents/agent-<id>.jsonl`). */
function storeDirectory(ctx: ExtensionContext): string | undefined {
	const file = ctx.sessionManager?.getSessionFile();
	return file ? `${file.replace(/\.jsonl$/, "")}/subagents` : undefined;
}

export function createSubagentsExtension(options: SubagentsOptions = {}): Extension {
	const toolName = options.toolName ?? "subagent";
	return (api: ExtensionAPI) => {
		const records = new Map<string, SubagentRecord>();
		/** Names in the order they were taken: the newest owner first. */
		const names = new Map<string, string[]>();
		/** The agent each name last reached in this conversation (spawned or messaged). */
		const reached = new Map<string, string>();
		let nextId = 1;
		/** Where this session's subagents are saved, and with what. */
		let store: { fs: FileSystem; dir: string } | undefined;

		const emitTask = (record: SubagentRecord): void => {
			if (!record.background) return;
			const copy: BackgroundTask = {
				id: record.id,
				...(record.name !== undefined ? { name: record.name } : {}),
				agent: record.agent,
				task: record.task,
				status: record.status,
				startedAt: record.startedAt,
				...(record.endedAt !== undefined ? { endedAt: record.endedAt } : {}),
				...(record.result !== undefined ? { result: record.result } : {}),
			};
			api.events.emit(SUBAGENT_TASK_CHANNEL, copy);
		};

		const save = async (record: SubagentRecord): Promise<void> => {
			if (!store || options.persist === false) return;
			const meta: StoredMeta = {
				id: record.id,
				...(record.name !== undefined ? { name: record.name } : {}),
				agent: record.agent,
				task: record.task,
				status: record.status,
				startedAt: record.startedAt,
				...(record.endedAt !== undefined ? { endedAt: record.endedAt } : {}),
				...(record.result !== undefined ? { result: record.result } : {}),
				toolNames: record.toolNames,
				systemPrompt: record.systemPrompt,
				...(record.model !== undefined ? { model: record.model } : {}),
				...(record.mode !== undefined ? { mode: record.mode } : {}),
			};
			try {
				await store.fs.writeTextFile(
					`${store.dir}/${record.id}.jsonl`,
					record.messages.map((message) => JSON.stringify(message)).join("\n") + (record.messages.length ? "\n" : ""),
				);
				await store.fs.writeTextFile(`${store.dir}/${record.id}.meta.json`, `${JSON.stringify(meta, null, 2)}\n`);
			} catch {
				// Not saved: it can still be continued in this run.
			}
		};

		/** A subagent saved by an earlier run of this session. */
		const load = async (id: string): Promise<SubagentRecord | undefined> => {
			if (!store || !/^sub-\d+$/.test(id)) return undefined;
			try {
				const meta = JSON.parse(await store.fs.readTextFile(`${store.dir}/${id}.meta.json`)) as StoredMeta;
				const text = await store.fs.readTextFile(`${store.dir}/${id}.jsonl`).catch(() => "");
				const messages = text
					.split("\n")
					.filter((line) => line.trim() !== "")
					.map((line) => JSON.parse(line) as AgentMessage);
				const record: SubagentRecord = {
					...meta,
					// A run cut off by the process ending counts as stopped.
					status: meta.status === "running" ? "stopped" : meta.status,
					background: true,
					messages,
					pendingSteer: [],
				};
				records.set(id, record);
				if (record.name) names.set(record.name, [...(names.get(record.name) ?? []), id]);
				return record;
			} catch {
				return undefined;
			}
		};

		const newRecord = (
			agent: AgentDefinition,
			step: Step,
			toolNames: string[],
			background: boolean,
		): SubagentRecord => {
			const id = `sub-${nextId++}`;
			const record: SubagentRecord = {
				id,
				...(step.name !== undefined ? { name: step.name } : {}),
				agent: agent.name,
				task: step.task,
				status: "running",
				startedAt: Date.now(),
				background,
				toolNames,
				systemPrompt: agent.systemPrompt,
				...(agent.model !== undefined ? { model: agent.model } : {}),
				...(agent.mode !== undefined ? { mode: agent.mode } : {}),
				messages: [],
				pendingSteer: [],
			};
			records.set(id, record);
			if (step.name !== undefined) {
				names.set(step.name, [id, ...(names.get(step.name) ?? [])]);
				reached.set(step.name, id);
			}
			return record;
		};

		/** Run (or resume) a record's child; the record follows its state, and is saved at the end. */
		const runRecord = async (
			record: SubagentRecord,
			prompt: string,
			ctx: ExtensionContext,
			signal: TauAbortSignal | undefined,
			onUpdate: ((line: string) => void) | undefined,
			prefix: string,
		): Promise<AgentRunResult> => {
			const runSubagent = ctx.runSubagent;
			if (!runSubagent) throw new Error("Subagents are not available in this host.");
			record.status = "running";
			record.stoppedBy = undefined;
			delete record.endedAt;
			emitTask(record);
			try {
				const result = await runSubagent(
					prompt,
					{
						appendSystemPrompt: record.systemPrompt,
						toolNames: record.toolNames,
						label: record.agent,
						...(record.background ? { detached: true } : {}),
						...(record.model !== undefined ? { model: record.model } : {}),
						...(record.mode !== undefined ? { permissionMode: record.mode } : {}),
						...(options.maxTurnsPerPrompt !== undefined ? { maxTurnsPerPrompt: options.maxTurnsPerPrompt } : {}),
						...(record.messages.length > 0 ? { initialMessages: record.messages } : {}),
						onSpawn: (handle) => {
							record.handle = handle;
							for (const message of record.pendingSteer.splice(0)) handle.steer(message);
						},
						onEvent: (event: AgentEvent) => {
							if (event.type === "tool_start") {
								onUpdate?.(`${prefix}● ${event.toolCall.name}(${argSummary(event.toolCall.arguments)})\n`);
							}
						},
					},
					signal,
				);
				record.messages = result.messages;
				record.status = "done";
				record.result = result.text.trim() === "" ? "(no answer)" : result.text.trim();
				return result;
			} catch (error) {
				record.messages = record.handle?.messages() ?? record.messages;
				record.status = signal?.aborted ? (record.stoppedBy === "user" ? "cancelled" : "stopped") : "failed";
				record.result = error instanceof Error ? error.message : String(error);
				throw error;
			} finally {
				record.handle = undefined;
				record.endedAt = Date.now();
				emitTask(record);
				await save(record);
			}
		};

		/** Run a record in the background; its result comes back as a follow-up message. */
		const runInBackground = (record: SubagentRecord, prompt: string, ctx: ExtensionContext, resumed: boolean): void => {
			const controller = new AbortController();
			record.controller = controller;
			const run = runRecord(record, prompt, ctx, controller.signal as unknown as TauAbortSignal, undefined, "")
				.catch(() => undefined)
				.finally(() => {
					record.controller = undefined;
					if (record.run === run) record.run = undefined;
					if (controller.signal.aborted) return;
					const label = record.name ? `${record.id} "${record.name}"` : record.id;
					api.sendMessage(
						{
							customType: "subagent_result",
							content: `Background subagent ${label} (${record.agent}) ${record.status === "done" ? "finished" : "failed"}${resumed ? " (resumed)" : ""}: ${firstLine(record.task)}\n\n${record.result ?? ""}\n\n[agent id: ${record.id}]`,
							display: true,
							details: { id: record.id, agent: record.agent, status: record.status },
						},
						{ deliverAs: "followUp", triggerTurn: true },
					);
				});
			record.run = run;
		};

		/** The record `to` names: an ID, else a name (refused when a newer agent took it since it was last reached). */
		const resolve = async (to: string): Promise<SubagentRecord | string> => {
			const target = to.trim();
			const byId = records.get(target) ?? (await load(target));
			if (byId) return byId;
			const owners = names.get(target);
			if (!owners || owners.length === 0) return `No subagent "${target}".`;
			const newest = owners[0] as string;
			const last = reached.get(target);
			if (last !== undefined && last !== newest) {
				reached.set(target, newest);
				return `The name "${target}" now refers to ${newest}, a newer subagent; ${last} is the one this conversation reached before. Address it by ID (${last}) to reach the earlier one, or send again to reach ${newest}.`;
			}
			reached.set(target, newest);
			return records.get(newest) ?? (await load(newest)) ?? `No subagent "${target}".`;
		};

		const known = (): string => {
			const list = [...records.values()];
			if (list.length === 0) return "There are no subagents in this session yet.";
			return `Subagents you can message: ${list
				.map(
					(record) =>
						`${record.id}${record.name ? ` "${record.name}"` : ""} (${record.agent}, ${record.status}): ${firstLine(record.task, 50)}`,
				)
				.join("; ")}`;
		};

		const stop = (record: SubagentRecord, by: "model" | "user"): string => {
			if (record.status !== "running") return `${record.id} is not running (${record.status}).`;
			if (!record.controller) return `${record.id} runs in the foreground and stops with the turn that started it.`;
			record.stoppedBy = by;
			// Stopped from now on, though the run may take a moment to wind down.
			record.status = by === "user" ? "cancelled" : "stopped";
			record.controller.abort();
			emitTask(record);
			return `Stopped ${record.id} (${record.agent})${by === "model" ? `; ${SEND_MESSAGE_TOOL} can resume it` : ""}.`;
		};

		api.events.on(SUBAGENT_STOP_CHANNEL, (data) => {
			const request = data as SubagentStopRequest;
			if (typeof request?.id !== "string") return;
			const target = request.id.trim();
			const record = records.get(target) ?? records.get(names.get(target)?.[0] ?? "");
			if (record) request.reply.result = Promise.resolve(stop(record, request.by));
		});

		const register = (agents: readonly AgentDefinition[]): void => {
			api.registerTool(
				{
					name: toolName,
					description: describe(toolName, agents),
					promptSnippet: "Delegate focused or parallel work to subagents with their own context",
					parameters: PARAMETERS,
					execute: async (args, signal, onUpdate, ctx) => {
						if (!ctx?.runSubagent) {
							return { content: [{ type: "text", text: "Subagents are not available in this host." }], isError: true };
						}
						try {
							const available = await discoverAgents(
								ctx.capabilities?.fs,
								options.directories ?? defaultDirectories(ctx),
							);
							const byName = new Map(available.map((agent) => [agent.name, agent]));
							const parentOnly = new Set(options.parentOnlyTools ?? []);
							const parentTools = api
								.getActiveTools()
								.filter((name) => name !== toolName && name !== SEND_MESSAGE_TOOL && !parentOnly.has(name));
							const tasks = steps(args.tasks, "tasks");
							const chain = steps(args.chain, "chain");
							const single =
								typeof args.task === "string" && args.task.trim() !== ""
									? [
											{
												agent:
													typeof args.agent === "string" && args.agent.trim() !== ""
														? args.agent.trim()
														: DEFAULT_AGENT,
												task: args.task,
												...(typeof args.name === "string" && args.name.trim() !== "" ? { name: args.name.trim() } : {}),
											},
										]
									: undefined;
							const plan = tasks ?? chain ?? single;
							if (!plan || plan.length === 0) throw new Error("Give task (with optional agent), tasks, or chain");
							if (tasks && tasks.length > MAX_PARALLEL_TASKS) {
								throw new Error(`Too many parallel tasks (${tasks.length}). Max is ${MAX_PARALLEL_TASKS}.`);
							}
							for (const step of plan) {
								if (!byName.has(step.agent)) {
									throw new Error(`Unknown agent "${step.agent}". Available: ${[...byName.keys()].join(", ")}`);
								}
								if (step.name !== undefined && !NAME_RE.test(step.name)) {
									throw new Error(
										`Invalid name "${step.name}": letters, digits, dots, dashes and underscores, at most 64`,
									);
								}
							}

							const background = args.background === true;
							const recordFor = (step: Step): SubagentRecord => {
								const agent = byName.get(step.agent) as AgentDefinition;
								const toolNames = (agent.tools ?? parentTools).filter(
									(name) => name !== toolName && name !== SEND_MESSAGE_TOOL,
								);
								return newRecord(agent, step, toolNames, background);
							};
							const label = (record: SubagentRecord): string =>
								record.name ? `${record.id} "${record.name}"` : record.id;

							let usage: Usage | undefined;
							const runStep = async (record: SubagentRecord, prompt: string, prefix: string): Promise<string> => {
								const result = await runRecord(record, prompt, ctx, signal, onUpdate, prefix);
								usage = addUsage(usage, result.usage);
								return record.result ?? "(no answer)";
							};

							if (background) {
								const started: string[] = [];
								for (const step of plan) {
									const record = recordFor(step);
									started.push(`${label(record)} (${step.agent})`);
									runInBackground(record, step.task, ctx, false);
								}
								return {
									content: [
										{
											type: "text",
											text: `Started ${started.length} background subagent${started.length === 1 ? "" : "s"}: ${started.join(", ")}. Each result arrives as a follow-up message; there is no need to wait for it.`,
										},
									],
								};
							}

							let text: string;
							if (chain) {
								let previous = "";
								const parts: string[] = [];
								for (const [index, step] of chain.entries()) {
									const record = recordFor(step);
									previous = await runStep(
										record,
										step.task.replace(/\{previous\}/g, previous),
										`[${index + 1}/${chain.length} ${step.agent}] `,
									);
									parts.push(`## Step ${index + 1}/${chain.length}: ${step.agent} (${label(record)})\n${previous}`);
								}
								text = parts.join("\n\n");
							} else if (tasks) {
								const records = tasks.map(recordFor);
								const results = await mapWithConcurrency(tasks, MAX_CONCURRENCY, async (step, index) => {
									try {
										return await runStep(
											records[index] as SubagentRecord,
											step.task,
											`[${index + 1}/${tasks.length} ${step.agent}] `,
										);
									} catch (error) {
										return `(failed: ${error instanceof Error ? error.message : String(error)})`;
									}
								});
								text = results
									.map(
										(result, index) =>
											`## [${index + 1}/${tasks.length}] ${tasks[index]?.agent} (${label(records[index] as SubagentRecord)}): ${firstLine(tasks[index]?.task ?? "")}\n${result}`,
									)
									.join("\n\n");
							} else {
								const record = recordFor(plan[0] as Step);
								text = `${await runStep(record, record.task, "")}\n\n[agent id: ${record.id}${record.name ? `, name: ${record.name}` : ""}]`;
							}
							// The children's LLM calls are billed to the session through the tool result (pi 0.81.0).
							return { content: [{ type: "text", text }], ...(usage ? { usage } : {}) };
						} catch (error) {
							return {
								content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
								isError: true,
							};
						}
					},
				},
				// Spawning only delegates: every call a subagent makes passes the same policy and
				// approval gate, in a mode no more permissive than the parent's.
				{ risk: "low" },
			);
		};

		register([]);
		if (options.sendMessage !== false) {
			api.registerTool(
				{
					name: SEND_MESSAGE_TOOL,
					description: SEND_MESSAGE_DESCRIPTION,
					promptSnippet: "Continue a finished subagent or steer a running one",
					parameters: SEND_MESSAGE_PARAMETERS,
					execute: async (args, _signal, _onUpdate, ctx) => {
						const fail = (text: string) => ({ content: [{ type: "text" as const, text }], isError: true });
						if (!ctx?.runSubagent) return fail("Subagents are not available in this host.");
						const to = typeof args.to === "string" ? args.to : "";
						const message = typeof args.message === "string" ? args.message : "";
						if (to.trim() === "" || message.trim() === "")
							return fail('Give "to" (an agent ID or name) and "message".');
						const found = await resolve(to);
						if (typeof found === "string") return fail(found.startsWith("No subagent") ? `${found} ${known()}` : found);
						const record = found;
						const label = record.name ? `${record.id} "${record.name}"` : record.id;
						if (record.status === "cancelled") {
							return fail(`${label} was cancelled by the user; it cannot be resumed.`);
						}
						if (record.status === "running") {
							if (record.handle) record.handle.steer(message);
							else record.pendingSteer.push(message);
							return {
								content: [
									{
										type: "text",
										text: `Sent to ${label} (${record.agent}), which is still running; it reads the message before its next step.`,
									},
								],
								details: { id: record.id, delivered: "steer" },
							};
						}
						// A stopped run winds down first (Claude Code resumes it once it has exited).
						if (record.run) await record.run;
						record.background = true;
						runInBackground(record, message, ctx, true);
						return {
							content: [
								{
									type: "text",
									text: `Resumed ${label} (${record.agent}) in the background with your message; its result arrives as a follow-up message.`,
								},
							],
							details: { id: record.id, delivered: "resume" },
						};
					},
				},
				{ risk: "low" },
			);
		}

		api.on("session_start", async (_event, ctx) => {
			register(await discoverAgents(ctx.capabilities?.fs, options.directories ?? defaultDirectories(ctx)));
			// Another session (or a resumed one): its subagents, numbered after the saved ones.
			for (const [id, record] of records) if (record.status !== "running") records.delete(id);
			names.clear();
			reached.clear();
			const fs = ctx.capabilities?.fs;
			const dir = storeDirectory(ctx);
			store = fs && dir && options.persist !== false ? { fs, dir } : undefined;
			let highest = 0;
			if (store) {
				try {
					for (const entry of await store.fs.listDir(store.dir)) {
						const match = /^sub-(\d+)\.meta\.json$/.exec(entry.name);
						if (match) highest = Math.max(highest, Number(match[1]));
					}
				} catch {
					// No subagents saved yet.
				}
			}
			for (const id of records.keys()) highest = Math.max(highest, Number(id.slice(4)) || 0);
			nextId = highest + 1;
		});
		api.on("session_shutdown", () => {
			for (const record of records.values()) record.controller?.abort();
		});

		api.registerCommand("agents", {
			description: "List the subagents the subagent tool can run",
			handler: async (_args, ctx) => {
				const agents = await discoverAgents(ctx.capabilities?.fs, options.directories ?? defaultDirectories(ctx));
				const label = (agent: AgentDefinition): string =>
					[
						agent.name,
						agent.source,
						agent.tools ? `tools: ${agent.tools.join(", ")}` : "all tools",
						...(agent.model ? [`model: ${agent.model}`] : []),
						...(agent.mode ? [`mode: ${agent.mode}`] : []),
					].join(" · ");
				if (!ctx.ui) return agents.map((agent) => `${label(agent)}\n  ${agent.description}`).join("\n");
				const labels = agents.map(label);
				const picked = await ctx.ui.select("Subagents", labels);
				const agent = picked === undefined ? undefined : agents[labels.indexOf(picked)];
				if (!agent) return undefined;
				return [
					`${agent.name} (${agent.source}${agent.filePath ? `, ${agent.filePath}` : ""})`,
					agent.description,
					"",
					agent.systemPrompt.trim(),
				].join("\n");
			},
		});

		if (options.tasksCommand !== false)
			api.registerCommand("tasks", {
				description: "Show background subagents and their results",
				handler: async (_args, ctx) => {
					const list = [...records.values()].filter((record) => record.background);
					if (list.length === 0) return "No background subagents in this session.";
					const label = (task: SubagentRecord): string => {
						const seconds = Math.round(((task.endedAt ?? Date.now()) - task.startedAt) / 1000);
						return `${task.status === "running" ? "◐" : task.status === "done" ? "●" : "✗"} ${task.id} ${task.agent} · ${task.status} · ${seconds}s · ${firstLine(task.task, 50)}`;
					};
					if (!ctx.ui) return list.map(label).join("\n");
					const labels = list.map(label);
					const picked = await ctx.ui.select("Background subagents", labels);
					const task = picked === undefined ? undefined : list[labels.indexOf(picked)];
					if (!task) return undefined;
					if (task.status === "running") {
						const action = await ctx.ui.select(`${task.id} · ${firstLine(task.task, 50)}`, ["Stop"]);
						return action === "Stop" ? stop(task, "user") : `${task.id} is still running: ${task.task}`;
					}
					return `${task.id} (${task.agent}) ${task.status}:\n\n${task.result ?? ""}`;
				},
			});
	};
}

export default createSubagentsExtension();
