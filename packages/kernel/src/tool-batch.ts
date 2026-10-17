import type { AgentEvent } from "./agent.ts";
import { toError } from "./errors.ts";
import type {
	ExtensionContext,
	ExtensionRegistry,
	ExtensionToolContext,
	ToolCallEvent,
	UiCapability,
} from "./extensions.ts";
import type { ToolCall, ToolResultMessage } from "./messages.ts";
import type { TauAbortSignal } from "./platform.ts";
import type { ApprovalRequest, PermissionMode, ToolPolicy } from "./policy.ts";
import {
	errorResult,
	hasToolSchema,
	type Tool,
	type ToolResult,
	type ToolUpdateStream,
	validateToolArgs,
} from "./tools.ts";

/**
 * Tool batch execution, split out of the agent loop (P23b). Structure mirrors
 * pi agent-loop.ts executeToolCalls: a serial preflight per call (tool_call
 * hook, argument validation, policy and approval, tool_execution_start), then
 * sequential or concurrent execution, then tool_result hooks; the agent commits
 * each result through `host.commit` in source order.
 */

/**
 * FIFO lock held for a tool call's whole preflight — tool_call hooks, validation,
 * policy, approval, tool_execution_start — never across execution. One lock serves
 * an agent tree (the root agent's, shared with subagents), so nested calls from a
 * script's Promise.all and parallel subagents never prompt for approval at once
 * (D22-2: hooks and approvals run one at a time).
 */
export class PreflightLock {
	private tail: Promise<void> = Promise.resolve();

	async run<T>(work: () => Promise<T>): Promise<T> {
		const previous = this.tail;
		let release: () => void = () => {};
		this.tail = new Promise<void>((resolve) => {
			release = resolve;
		});
		await previous;
		try {
			return await work();
		} finally {
			release();
		}
	}
}

/** What the runner needs from its agent. */
export interface ToolBatchHost {
	readonly extensions: ExtensionRegistry | undefined;
	readonly policy: ToolPolicy;
	readonly permissionMode: PermissionMode;
	/** The filesystem's working directory, for the accept-edits rule (P26d). */
	readonly cwd?: string;
	readonly onApproval: ((request: ApprovalRequest) => Promise<boolean>) | undefined;
	ui(): UiCapability | undefined;
	readonly preflightLock: PreflightLock;
	/** The context a tool's execute receives: `ctx` plus executeTool/tools bound to this call. */
	toolContext(ctx: ExtensionContext, toolCallId: string, signal: TauAbortSignal | undefined): ExtensionToolContext;
	/** Log one tool result and return its AgentEvent. */
	commit(toolCall: ToolCall, outcome: ToolOutcome, ctx: ExtensionContext, batch: ToolBatch): Promise<AgentEvent>;
}

interface ToolUpdate {
	partialOutput: string;
	stream?: ToolUpdateStream;
}

/** Outcome of the serial preflight stage (P18, mirrors pi's prepareToolCall shapes). */
type PreparedToolCall = {
	kind: "prepared";
	toolCall: ToolCall;
	tool: Tool;
	args: Record<string, unknown>;
	parentToolCallId?: string;
};
type ToolCallPreparation = PreparedToolCall | { kind: "immediate"; toolCall: ToolCall; result: ToolResult };
/** A tool result plus how long tool.execute took (absent when it never ran). */
export type ToolOutcome = ToolResult & { durationMs?: number };

/** What a tool batch committed: result messages, their entry ids, and each result's terminate hint. */
export interface ToolBatch {
	messages: ToolResultMessage[];
	entryIds: string[];
	terminate: boolean[];
}

export class ToolBatchRunner {
	private readonly host: ToolBatchHost;

	constructor(host: ToolBatchHost) {
		this.host = host;
	}

	/** Sequential batch: the pre-P18 behavior — full hook chain, execute, result, one tool at a time. */
	async *runSequential(
		toolCalls: ToolCall[],
		tools: ReadonlyMap<string, Tool>,
		ctx: ExtensionContext,
		signal: TauAbortSignal | undefined,
		batch: ToolBatch,
	): AsyncGenerator<AgentEvent> {
		for (const toolCall of toolCalls) {
			yield { type: "tool_start", toolCall };
			const updates: ToolUpdate[] = [];
			let wakeUpdate: (() => void) | undefined;
			let executionDone = false;
			const execution = this.executeToolCall(toolCall, tools, ctx, signal, (update) => {
				updates.push(update);
				wakeUpdate?.();
				wakeUpdate = undefined;
			});
			execution.then(
				() => {
					executionDone = true;
					wakeUpdate?.();
					wakeUpdate = undefined;
				},
				() => {
					executionDone = true;
					wakeUpdate?.();
					wakeUpdate = undefined;
				},
			);
			while (!executionDone || updates.length > 0) {
				const update = updates.shift();
				if (update) {
					yield { type: "tool_update", toolCall, partialOutput: update.partialOutput, stream: update.stream };
					continue;
				}
				await new Promise<void>((resolve) => {
					wakeUpdate = resolve;
				});
			}
			const { result } = await execution;
			yield await this.host.commit(toolCall, result, ctx, batch);
		}
	}

	/**
	 * Parallel batch (P18, structure mirrors pi executeToolCallsParallel):
	 * phase 1 — preflight serially in source order (tool_call hook, validation,
	 * policy/approval, tool_execution_start; immediate outcomes settle here);
	 * phase 2 — execute prepared tools concurrently, tool_execution_end and
	 * tool_update stream in completion/arrival order; phase 3 — tool results
	 * commit to messages/session in assistant source order (stable wire order).
	 * Deviation from pi: no break on abort mid-preflight — every tool call gets
	 * a result (existing tau sequential semantics; tools observe the signal and
	 * settle fast), keeping the wire's call/result pairing always complete.
	 */
	async *runParallel(
		toolCalls: ToolCall[],
		tools: ReadonlyMap<string, Tool>,
		ctx: ExtensionContext,
		signal: TauAbortSignal | undefined,
		batch: ToolBatch,
	): AsyncGenerator<AgentEvent> {
		const preps: ToolCallPreparation[] = [];
		for (const toolCall of toolCalls) {
			yield { type: "tool_start", toolCall };
			preps.push(await this.preflightToolCall(toolCall, tools, ctx, signal));
		}

		type PumpItem = { kind: "update"; toolCall: ToolCall; update: ToolUpdate } | { kind: "done" };
		const pump: PumpItem[] = [];
		let wake: (() => void) | undefined;
		const push = (item: PumpItem): void => {
			pump.push(item);
			wake?.();
			wake = undefined;
		};
		const outcomes: ToolOutcome[] = new Array(preps.length);
		let running = 0;
		preps.forEach((prep, index) => {
			if (prep.kind === "immediate") {
				outcomes[index] = prep.result;
				return;
			}
			running++;
			this.executePreparedToolCall(prep, ctx, signal, (update) => {
				push({ kind: "update", toolCall: prep.toolCall, update });
			}).then(
				(result) => {
					outcomes[index] = result;
					running--;
					push({ kind: "done" });
				},
				(cause) => {
					outcomes[index] = errorResult(toError(cause).message);
					running--;
					push({ kind: "done" });
				},
			);
		});
		while (running > 0 || pump.length > 0) {
			const item = pump.shift();
			if (item) {
				if (item.kind === "update") {
					yield {
						type: "tool_update",
						toolCall: item.toolCall,
						partialOutput: item.update.partialOutput,
						stream: item.update.stream,
					};
				}
				continue;
			}
			await new Promise<void>((resolve) => {
				wake = resolve;
			});
		}

		for (let index = 0; index < preps.length; index++) {
			yield await this.host.commit(preps[index].toolCall, outcomes[index], ctx, batch);
		}
	}

	private async executeToolCall(
		toolCall: ToolCall,
		tools: ReadonlyMap<string, Tool>,
		ctx: ExtensionContext,
		signal?: TauAbortSignal,
		onUpdate?: (update: ToolUpdate) => void,
	): Promise<{ result: ToolOutcome }> {
		const prep = await this.preflightToolCall(toolCall, tools, ctx, signal);
		if (prep.kind === "immediate") return { result: prep.result };
		return { result: await this.executePreparedToolCall(prep, ctx, signal, onUpdate) };
	}

	/**
	 * A call another tool made (ctx.executeTool): the same preflight and execution as
	 * a model-issued call, with `parentToolCallId` on its events and approval request.
	 */
	async runNested(
		toolCall: ToolCall,
		tools: ReadonlyMap<string, Tool>,
		ctx: ExtensionContext,
		parentToolCallId: string,
		signal: TauAbortSignal | undefined,
		onUpdate: ((partialOutput: string, stream?: ToolUpdateStream) => void) | undefined,
	): Promise<ToolOutcome> {
		const prep = await this.preflightToolCall(toolCall, tools, ctx, signal, parentToolCallId);
		if (prep.kind === "immediate") return prep.result;
		return this.executePreparedToolCall(
			prep,
			ctx,
			signal,
			onUpdate ? (update) => onUpdate(update.partialOutput, update.stream) : undefined,
		);
	}

	/**
	 * Serial preflight of one tool call: tool_call hook (block/rewrite),
	 * argument validation, policy gate, approval, and — for calls that will
	 * execute — the tool_execution_start notification. Immediate outcomes
	 * (unknown tool, block, invalid args, deny) never see execution hooks.
	 */
	private preflightToolCall(
		toolCall: ToolCall,
		tools: ReadonlyMap<string, Tool>,
		ctx: ExtensionContext,
		signal?: TauAbortSignal,
		parentToolCallId?: string,
	): Promise<ToolCallPreparation> {
		return this.host.preflightLock.run(() => this.preflightLocked(toolCall, tools, ctx, signal, parentToolCallId));
	}

	private async preflightLocked(
		toolCall: ToolCall,
		tools: ReadonlyMap<string, Tool>,
		ctx: ExtensionContext,
		signal: TauAbortSignal | undefined,
		parentToolCallId: string | undefined,
	): Promise<ToolCallPreparation> {
		const parent = parentToolCallId !== undefined ? { parentToolCallId } : {};
		const tool = tools.get(toolCall.name);
		if (!tool) {
			return { kind: "immediate", toolCall, result: errorResult(`Unknown tool: ${toolCall.name}`) };
		}
		// Execution works on a copy so tool_call handlers can rewrite arguments
		// without mutating the stored assistant message.
		// Deep copy: a handler rewriting nested arguments in place must not reach the
		// logged assistant message (P22: the log is what the model saw).
		let args: Record<string, unknown> = JSON.parse(JSON.stringify(toolCall.arguments)) as Record<string, unknown>;
		if (this.host.extensions) {
			const event: ToolCallEvent = {
				type: "tool_call",
				toolCallId: toolCall.id,
				toolName: toolCall.name,
				input: args,
				...parent,
			};
			const decision = await this.host.extensions.runToolCall(event, ctx);
			if (decision.blocked) {
				const blocked = errorResult(`Tool call blocked: ${decision.reason ?? "blocked by extension"}`);
				return { kind: "immediate", toolCall, result: decision.terminate ? { ...blocked, terminate: true } : blocked };
			}
			args = event.input;
		}

		// Abort check (pi v0.80.3 prepareToolCall): once the run is aborted, no further
		// call is validated, approved or started. The call still gets a result so the
		// wire's call/result pairing stays complete.
		if (signal?.aborted) return { kind: "immediate", toolCall, result: abortedResult() };

		// Argument validation before the policy (P15): malformed calls fail fast
		// so the model can self-correct, and policy rules never fire on junk.
		// Preflight guard for schemaless tools that slipped past registration (a host
		// mutating extensions.tools directly): an error result keeps call/result paired.
		if (!hasToolSchema(tool)) {
			return {
				kind: "immediate",
				toolCall,
				result: errorResult(`Tool ${toolCall.name} has no parameters schema and cannot be called`),
			};
		}
		const problems = validateToolArgs(tool.parameters, args);
		if (problems.length > 0) {
			return {
				kind: "immediate",
				toolCall,
				result: errorResult(`Invalid arguments for ${toolCall.name}: ${problems.join("; ")}`),
			};
		}

		// Policy gate (P15): extensions ruled above, the static policy rules here.
		// A denial is a normal error tool result — the loop continues and the
		// model can change course; tool_execution_start never fires for it.
		const policyDecision = this.host.policy.assess(
			{
				toolName: toolCall.name,
				args,
				declaredRisk: tool.risk,
				...(this.host.cwd !== undefined ? { cwd: this.host.cwd } : {}),
			},
			this.host.permissionMode,
		);
		const riskText =
			policyDecision.reason ?? `${policyDecision.risk}-risk tool call in ${this.host.permissionMode} mode`;
		if (policyDecision.action === "deny") {
			return { kind: "immediate", toolCall, result: errorResult(`Denied by policy: ${riskText}`) };
		}
		if (policyDecision.action === "ask") {
			const handler = this.host.onApproval ?? this.uiApprovalHandler();
			if (!handler) {
				return {
					kind: "immediate",
					toolCall,
					result: errorResult(
						`Denied by policy: approval required (${riskText}), but no approval handler is available`,
					),
				};
			}
			const request: ApprovalRequest = {
				toolCallId: toolCall.id,
				toolName: toolCall.name,
				args,
				risk: policyDecision.risk,
				reason: policyDecision.reason,
				...parent,
			};
			let approved: boolean;
			try {
				approved = await this.awaitApproval(handler, request, signal);
			} catch (cause) {
				return {
					kind: "immediate",
					toolCall,
					result: errorResult(`Denied by policy: approval failed (${toError(cause).message})`),
				};
			}
			if (!approved) {
				return {
					kind: "immediate",
					toolCall,
					result: errorResult(`Denied by policy: approval declined (${riskText})`),
				};
			}
		}

		await this.host.extensions?.notifyToolExecutionStart(
			{ toolCallId: toolCall.id, toolName: toolCall.name, args, ...parent },
			ctx,
		);
		return { kind: "prepared", toolCall, tool, args, ...parent };
	}

	/** Execute a prepared tool call: updates stream, tool_execution_end, tool_result hook. */
	private async executePreparedToolCall(
		prep: PreparedToolCall,
		ctx: ExtensionContext,
		signal?: TauAbortSignal,
		onUpdate?: (update: ToolUpdate) => void,
	): Promise<ToolOutcome> {
		const { toolCall, tool, args } = prep;
		const parent = prep.parentToolCallId !== undefined ? { parentToolCallId: prep.parentToolCallId } : {};
		const updateNotifications: Promise<void>[] = [];
		// Updates after execute settled are dropped, so none lands after tool_execution_end (pi acceptingUpdates).
		let acceptingUpdates = true;
		const emitUpdate = (partialOutput: string, stream?: ToolUpdateStream): void => {
			if (!acceptingUpdates) return;
			if (this.host.extensions) {
				const notification = this.host.extensions
					.notifyToolExecutionUpdate(
						{ toolCallId: toolCall.id, toolName: toolCall.name, args, partialOutput, stream, ...parent },
						ctx,
					)
					.then(() => {
						onUpdate?.({ partialOutput, stream });
					});
				updateNotifications.push(notification);
			} else {
				onUpdate?.({ partialOutput, stream });
			}
		};

		let result: ToolResult;
		let durationMs: number | undefined;
		if (signal?.aborted) {
			// Prepared before the abort (e.g. while a later call of the parallel batch was
			// waiting for approval): never start it, report it like any aborted call.
			result = abortedResult();
		} else {
			// durationMs covers tool.execute only: preflight and approval ran before (pi 1.1.0).
			const startedAt = Date.now();
			try {
				result = await tool.execute(args, signal, emitUpdate, this.host.toolContext(ctx, toolCall.id, signal));
			} catch (cause) {
				result = errorResult(cause instanceof Error ? cause.message : String(cause));
			}
			durationMs = Math.max(0, Date.now() - startedAt);
		}
		acceptingUpdates = false;
		await Promise.all(updateNotifications);
		await this.host.extensions?.notifyToolExecutionEnd(
			{
				toolCallId: toolCall.id,
				toolName: toolCall.name,
				result,
				...(durationMs !== undefined ? { durationMs } : {}),
				...parent,
			},
			ctx,
		);

		if (this.host.extensions) {
			result = normalizeToolOutcome(toolCall.name, result);
			const finalResult = await this.host.extensions.runToolResult(
				{
					type: "tool_result",
					toolCallId: toolCall.id,
					toolName: toolCall.name,
					...parent,
					input: args,
					content: result.content,
					...(result.details !== undefined ? { details: result.details } : {}),
					isError: result.isError === true,
					...(result.usage ? { usage: result.usage } : {}),
					...(result.structuredContent !== undefined ? { structuredContent: result.structuredContent } : {}),
				},
				ctx,
			);
			// terminate rides through the tool_result chain untouched (pi AfterToolCallResult keeps it).
			result = {
				content: finalResult.content,
				...(finalResult.details !== undefined ? { details: finalResult.details } : {}),
				isError: finalResult.isError,
				...(finalResult.usage ? { usage: finalResult.usage } : {}),
				...(finalResult.structuredContent !== undefined ? { structuredContent: finalResult.structuredContent } : {}),
				...(result.terminate ? { terminate: true } : {}),
			};
		}
		return durationMs !== undefined ? { ...result, durationMs } : result;
	}

	/** Default approval handler over the host UI; no UI means no handler (ask degrades to deny). */
	private uiApprovalHandler(): ((request: ApprovalRequest) => Promise<boolean>) | undefined {
		const ui = this.host.ui();
		if (!ui) return undefined;
		return (request) => {
			const summary = JSON.stringify(request.args) ?? "{}";
			const detail = summary.length > 400 ? `${summary.slice(0, 400)}…` : summary;
			return ui.confirm(
				`Allow ${request.toolName}? (${request.risk} risk${request.parentToolCallId === undefined ? "" : ", called by another tool"})`,
				request.reason ? `${request.reason}\n${detail}` : detail,
			);
		};
	}

	/** Wait for an approval decision; an abort while waiting counts as a rejection. */
	private awaitApproval(
		handler: (request: ApprovalRequest) => Promise<boolean>,
		request: ApprovalRequest,
		signal?: TauAbortSignal,
	): Promise<boolean> {
		if (signal?.aborted) return Promise.resolve(false);
		const decision = handler(request);
		if (!signal) return decision;
		return new Promise<boolean>((resolve, reject) => {
			let settled = false;
			const onAbort = (): void => {
				if (settled) return;
				settled = true;
				resolve(false);
			};
			signal.addEventListener("abort", onAbort, { once: true });
			decision.then(
				(value) => {
					if (settled) return;
					settled = true;
					signal.removeEventListener("abort", onAbort);
					resolve(value);
				},
				(cause) => {
					if (settled) return;
					settled = true;
					signal.removeEventListener("abort", onAbort);
					reject(cause);
				},
			);
		});
	}
}

/** Result for a tool call that was never started because its run was aborted. */
function abortedResult(): ToolResult {
	return errorResult("Operation aborted");
}

/**
 * Validate what a tool (or a tool_result handler) returned. A result without a
 * `content` array — e.g. an extension still returning the pre-P23 `{ output }`
 * — becomes an error result the model can see, instead of an empty success.
 */
export function normalizeToolOutcome(toolName: string, outcome: ToolOutcome): ToolOutcome {
	if (Array.isArray(outcome?.content)) return outcome;
	const legacy = typeof (outcome as { output?: unknown } | undefined)?.output === "string";
	return {
		...errorResult(
			legacy
				? `Tool ${toolName} returned { output } — tools return { content: [{ type: "text", text }] } since P23`
				: `Tool ${toolName} returned an invalid result (expected { content })`,
		),
		...(outcome?.durationMs !== undefined ? { durationMs: outcome.durationMs } : {}),
	};
}
