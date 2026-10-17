/**
 * The `subagent` tool (P26b). Shape from pi's subagent example
 * (examples/extensions/subagent/index.ts): single `{agent, task}`, parallel
 * `{tasks: [...]}` (at most 8, 4 at a time) and chain `{chain: [...]}` with
 * `{previous}` replaced by the prior step's output, over agent definitions
 * (agents.ts). From yo-agent: `background` (returns at once; the result comes
 * back as a follow-up message), definitions can only tighten the parent's
 * permissions, and a subagent never gets this tool (no recursive spawning).
 *
 * Deviation from pi: children run in-process through ctx.runSubagent rather
 * than as separate pi processes, so every host can run them and their
 * approvals use the parent's prompt.
 */
import type {
	AgentEvent,
	AgentRunResult,
	Extension,
	ExtensionAPI,
	ExtensionContext,
	JsonObject,
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

export interface SubagentsOptions {
	toolName?: string;
	maxTurnsPerPrompt?: number;
	/** Override where agent definitions are looked up (defaults come from ctx.capabilities.paths). */
	directories?: AgentDirectories;
}

interface Step {
	agent: string;
	task: string;
}

export interface BackgroundTask {
	id: string;
	agent: string;
	task: string;
	status: "running" | "done" | "failed";
	startedAt: number;
	endedAt?: number;
	result?: string;
}

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
		`Subagents cannot call ${toolName}. Available agents:`,
		list,
	].join("\n");
}

const PARAMETERS = {
	type: "object",
	properties: {
		agent: { type: "string", description: `Name of the agent to invoke (single mode; default "${DEFAULT_AGENT}")` },
		task: { type: "string", description: "Task to delegate (single mode)" },
		tasks: {
			type: "array",
			description: `Array of {agent, task} to run in parallel (at most ${MAX_PARALLEL_TASKS})`,
			items: {
				type: "object",
				properties: { agent: { type: "string" }, task: { type: "string" } },
				required: ["task"],
			},
		},
		chain: {
			type: "array",
			description: "Array of {agent, task} to run in order; {previous} in a task is the prior step's output",
			items: {
				type: "object",
				properties: { agent: { type: "string" }, task: { type: "string" } },
				required: ["task"],
			},
		},
		background: { type: "boolean", description: "Return immediately; the result arrives later as a follow-up message" },
	},
};

export function createSubagentsExtension(options: SubagentsOptions = {}): Extension {
	const toolName = options.toolName ?? "subagent";
	return (api: ExtensionAPI) => {
		const background = new Map<string, BackgroundTask>();
		const controllers = new Set<AbortController>();
		let nextId = 1;

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
						const runSubagent = ctx.runSubagent;
						try {
							const available = await discoverAgents(
								ctx.capabilities?.fs,
								options.directories ?? defaultDirectories(ctx),
							);
							const byName = new Map(available.map((agent) => [agent.name, agent]));
							const parentTools = api.getActiveTools().filter((name) => name !== toolName);
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
							}

							let usage: Usage | undefined;
							const runStep = async (
								step: Step,
								prefix: string,
								stepSignal: TauAbortSignal | undefined,
								detached = false,
							): Promise<AgentRunResult> => {
								const agent = byName.get(step.agent) as AgentDefinition;
								const toolNames = (agent.tools ?? parentTools).filter((name) => name !== toolName);
								const result = await runSubagent(
									step.task,
									{
										appendSystemPrompt: agent.systemPrompt,
										toolNames,
										label: agent.name,
										...(detached ? { detached: true } : {}),
										...(agent.model !== undefined ? { model: agent.model } : {}),
										...(agent.mode !== undefined ? { permissionMode: agent.mode } : {}),
										...(options.maxTurnsPerPrompt !== undefined
											? { maxTurnsPerPrompt: options.maxTurnsPerPrompt }
											: {}),
										onEvent: (event: AgentEvent) => {
											if (event.type === "tool_start") {
												onUpdate?.(`${prefix}● ${event.toolCall.name}(${argSummary(event.toolCall.arguments)})\n`);
											}
										},
									},
									stepSignal,
								);
								usage = addUsage(usage, result.usage);
								return result;
							};
							const answer = (result: AgentRunResult): string =>
								result.text.trim() === "" ? "(no answer)" : result.text.trim();

							if (args.background === true) {
								const started: string[] = [];
								for (const step of plan) {
									const id = `sub-${nextId++}`;
									const record: BackgroundTask = {
										id,
										agent: step.agent,
										task: step.task,
										status: "running",
										startedAt: Date.now(),
									};
									background.set(id, record);
									const controller = new AbortController();
									controllers.add(controller);
									started.push(`${id} (${step.agent})`);
									void runStep(step, "", controller.signal as unknown as TauAbortSignal, true)
										.then(
											(result) => {
												record.status = "done";
												record.result = answer(result);
											},
											(error: unknown) => {
												record.status = "failed";
												record.result = error instanceof Error ? error.message : String(error);
											},
										)
										.finally(() => {
											controllers.delete(controller);
											record.endedAt = Date.now();
											if (controller.signal.aborted) return;
											api.sendMessage(
												{
													customType: "subagent_result",
													content: `Background subagent ${id} (${record.agent}) ${record.status === "done" ? "finished" : "failed"}: ${firstLine(record.task)}\n\n${record.result ?? ""}`,
													display: true,
													details: { id, agent: record.agent, status: record.status },
												},
												{ deliverAs: "followUp", triggerTurn: true },
											);
										});
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
									const result = await runStep(
										{ agent: step.agent, task: step.task.replace(/\{previous\}/g, previous) },
										`[${index + 1}/${chain.length} ${step.agent}] `,
										signal,
									);
									previous = answer(result);
									parts.push(`## Step ${index + 1}/${chain.length}: ${step.agent}\n${previous}`);
								}
								text = parts.join("\n\n");
							} else if (tasks) {
								const results = await mapWithConcurrency(tasks, MAX_CONCURRENCY, async (step, index) => {
									try {
										return answer(await runStep(step, `[${index + 1}/${tasks.length} ${step.agent}] `, signal));
									} catch (error) {
										return `(failed: ${error instanceof Error ? error.message : String(error)})`;
									}
								});
								text = results
									.map(
										(result, index) =>
											`## [${index + 1}/${tasks.length}] ${tasks[index]?.agent}: ${firstLine(tasks[index]?.task ?? "")}\n${result}`,
									)
									.join("\n\n");
							} else {
								text = answer(await runStep(plan[0] as Step, "", signal));
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
		api.on("session_start", async (_event, ctx) => {
			register(await discoverAgents(ctx.capabilities?.fs, options.directories ?? defaultDirectories(ctx)));
		});
		api.on("session_shutdown", () => {
			for (const controller of controllers) controller.abort();
			controllers.clear();
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

		api.registerCommand("tasks", {
			description: "Show background subagents and their results",
			handler: async (_args, ctx) => {
				const list = [...background.values()];
				if (list.length === 0) return "No background subagents in this session.";
				const label = (task: BackgroundTask): string => {
					const seconds = Math.round(((task.endedAt ?? Date.now()) - task.startedAt) / 1000);
					return `${task.status === "running" ? "◐" : task.status === "done" ? "●" : "✗"} ${task.id} ${task.agent} · ${task.status} · ${seconds}s · ${firstLine(task.task, 50)}`;
				};
				if (!ctx.ui) return list.map(label).join("\n");
				const labels = list.map(label);
				const picked = await ctx.ui.select("Background subagents", labels);
				const task = picked === undefined ? undefined : list[labels.indexOf(picked)];
				if (!task) return undefined;
				return task.status === "running"
					? `${task.id} is still running: ${task.task}`
					: `${task.id} (${task.agent}) ${task.status}:\n\n${task.result ?? ""}`;
			},
		});
	};
}

export default createSubagentsExtension();
