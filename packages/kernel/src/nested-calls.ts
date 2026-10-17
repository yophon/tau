// Tool calls that a tool makes while it runs (`ctx.executeTool()`), for example
// from codemode scripts (pi coding-agent core/nested-tool-calls.ts). The loop does
// not know about them: each runs through the agent's tool pipeline — tool_call
// hooks, validation, policy and approval, tool_result hooks — with events that
// carry `parentToolCallId`, and the calls and their usage are recorded on the
// model-issued call's tool result message.
//
// Deviations from pi, written down (D7): durations use Date.now() (no monotonic
// clock in pure ES); UTF-8 sizes are computed in pure ES (no TextEncoder, D5);
// read/write/edit keep their `path` when their arguments are omitted for size
// (D29), so compaction still lists the files a script touched.
import {
	combineUsage,
	type JsonObject,
	type NestedToolCallRecord,
	type NestedToolCalls,
	type ToolCall,
	type Usage,
} from "./messages.ts";
import type { TauAbortSignal } from "./platform.ts";
import type { Tool, ToolResult, ToolUpdateStream } from "./tools.ts";
import { utf8ByteLength } from "./utf8.ts";

/**
 * Limits of the nested-call record on a tool result: arguments over the per-call
 * or total size are omitted, calls beyond the count are dropped (they still run),
 * and the record is marked incomplete when any of that happens (pi).
 */
export const NESTED_CALL_LIMITS = {
	maxCalls: 256,
	maxArgumentBytesPerCall: 8 * 1024,
	maxArgumentBytesTotal: 32 * 1024,
	maxErrorChars: 500,
} as const;

/** Longest path kept for read/write/edit calls whose arguments were omitted (D29). */
const MAX_KEPT_PATH_CHARS = 4096;
const PATH_TOOLS: ReadonlySet<string> = new Set(["read", "write", "edit"]);

/** What a nested call returns (pi AgentToolCallOutcome). */
export interface ToolCallOutcome {
	toolCall: ToolCall;
	result: ToolResult;
	isError: boolean;
	durationMs?: number;
}

export interface ExecuteToolOptions {
	/** Defaults to the calling tool's signal. */
	signal?: TauAbortSignal;
	/** Partial output of the nested tool, in addition to tool_execution_update events. */
	onUpdate?: (partialOutput: string, stream?: ToolUpdateStream) => void;
}

/** What the nested calls of one model-issued tool call leave on its tool result message. */
export interface NestedCallSummary {
	/** Becomes `nestedCalls`; undefined when no nested call was made. */
	calls: NestedToolCalls | undefined;
	/** Summed usage of the nested results, added to the message's `usage`. */
	usage: Usage | undefined;
}

function textOf(result: ToolResult): string {
	return result.content
		.filter((block): block is { type: "text"; text: string } => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

/** Collects the nested calls of one model-issued tool call, including calls made by nested tools (pi). */
export class NestedCallRecorder {
	private readonly calls: NestedToolCallRecord[] = [];
	private readonly startedAt = new Map<NestedToolCallRecord, number>();
	private complete = true;
	private argumentBytes = 0;
	private usage: Usage | undefined;

	/** Record a call as it starts. Returns undefined when the call is dropped from the record. */
	start(toolCall: ToolCall): NestedToolCallRecord | undefined {
		if (this.calls.length >= NESTED_CALL_LIMITS.maxCalls) {
			this.complete = false;
			return undefined;
		}
		const record: NestedToolCallRecord = { id: toolCall.id, name: toolCall.name, status: "unfinished" };
		const json = JSON.stringify(toolCall.arguments ?? {});
		const bytes = utf8ByteLength(json);
		if (
			bytes > NESTED_CALL_LIMITS.maxArgumentBytesPerCall ||
			this.argumentBytes + bytes > NESTED_CALL_LIMITS.maxArgumentBytesTotal
		) {
			record.argumentsBytes = bytes;
			this.complete = false;
			// D29: a big write must not lose its path, or compaction forgets the file.
			const path = toolCall.arguments?.path;
			if (PATH_TOOLS.has(toolCall.name) && typeof path === "string") {
				record.arguments = { path: path.slice(0, MAX_KEPT_PATH_CHARS) };
			}
		} else {
			record.arguments = JSON.parse(json) as JsonObject;
			this.argumentBytes += bytes;
		}
		this.calls.push(record);
		this.startedAt.set(record, Date.now());
		return record;
	}

	finish(record: NestedToolCallRecord | undefined, isError: boolean, errorText: string): void {
		if (!record) return;
		record.status = isError ? "error" : "ok";
		record.durationMs = Math.max(0, Date.now() - (this.startedAt.get(record) ?? Date.now()));
		this.startedAt.delete(record);
		if (isError && errorText) record.error = errorText.slice(0, NESTED_CALL_LIMITS.maxErrorChars);
	}

	addUsage(usage: Usage): void {
		this.usage = this.usage ? combineUsage(this.usage, usage) : usage;
	}

	get totalUsage(): Usage | undefined {
		return this.usage;
	}

	/** Copy of the record so far, or undefined when no nested call was made. */
	snapshot(): NestedToolCalls | undefined {
		if (this.calls.length === 0 && this.complete) return undefined;
		const calls = this.calls.map((call) => ({ ...call }));
		return { calls, complete: this.complete && calls.every((call) => call.status !== "unfinished") };
	}
}

export interface NestedToolCallHost {
	/** Tools nested calls resolve against: the callable set at call time. */
	getTools(): ReadonlyMap<string, Tool>;
	/** Whether every nested call runs exclusively, as when the agent executes tool calls sequentially. */
	isSequential(): boolean;
	/** Run the call through the tool pipeline, with events that report `parentToolCallId`. */
	runToolCall(
		toolCall: ToolCall,
		tools: ReadonlyMap<string, Tool>,
		parentToolCallId: string,
		signal: TauAbortSignal | undefined,
		onUpdate: ((partialOutput: string, stream?: ToolUpdateStream) => void) | undefined,
	): Promise<ToolResult & { durationMs?: number }>;
}

/** Calls below one model-issued call share its recorder. */
interface CallScope {
	recorder: NestedCallRecorder;
	nextId: number;
	/** Set inside a call that holds the exclusive queue, so its own nested calls do not wait on it. */
	holdsQueue: boolean;
}

/** Runs nested calls and keeps their record per model-issued call (pi NestedToolCallRunner). */
export class NestedToolCallRunner {
	private readonly host: NestedToolCallHost;
	/** Scopes by the id of the calling tool call. */
	private readonly scopes = new Map<string, CallScope>();
	/** Serializes nested calls that must not run concurrently. */
	private queueTail: Promise<void> = Promise.resolve();

	constructor(host: NestedToolCallHost) {
		this.host = host;
	}

	/**
	 * Run `name` on behalf of the call `callerId`; the nested call gets the id
	 * `<callerId>/<n>`. Never rejects for tool failures: they come back as `isError`.
	 */
	async execute(
		callerId: string,
		name: string,
		args: unknown,
		options: ExecuteToolOptions & { signal?: TauAbortSignal } = {},
	): Promise<ToolCallOutcome> {
		let scope = this.scopes.get(callerId);
		if (!scope) {
			scope = { recorder: new NestedCallRecorder(), nextId: 1, holdsQueue: false };
			this.scopes.set(callerId, scope);
		}
		const toolCall: ToolCall = {
			type: "toolCall",
			id: `${callerId}/${scope.nextId++}`,
			name,
			arguments: (args !== null && typeof args === "object" && !Array.isArray(args) ? args : {}) as JsonObject,
		};
		const record = scope.recorder.start(toolCall);
		const tools = this.host.getTools();
		const exclusive =
			!scope.holdsQueue && (this.host.isSequential() || tools.get(name)?.executionMode === "sequential");
		let release: (() => void) | undefined;
		if (exclusive) {
			const previous = this.queueTail;
			this.queueTail = new Promise((resolve) => {
				release = resolve;
			});
			await previous;
		}
		this.scopes.set(toolCall.id, { recorder: scope.recorder, nextId: 1, holdsQueue: scope.holdsQueue || exclusive });
		let outcome: ToolResult & { durationMs?: number };
		try {
			outcome = await this.host.runToolCall(toolCall, tools, callerId, options.signal, options.onUpdate);
		} catch (cause) {
			outcome = {
				content: [{ type: "text", text: cause instanceof Error ? cause.message : String(cause) }],
				isError: true,
			};
		} finally {
			this.scopes.delete(toolCall.id);
			release?.();
		}
		const { durationMs, ...result } = outcome;
		const isError = result.isError === true;
		scope.recorder.finish(record, isError, textOf(result));
		// Nested results are not persisted, so their usage is only counted through the recorder.
		if (result.usage) scope.recorder.addUsage(result.usage);
		return { toolCall, result, isError, ...(durationMs !== undefined ? { durationMs } : {}) };
	}

	/** Remove and return the record of the nested calls a model-issued call made. */
	takeRecord(toolCallId: string): NestedCallSummary | undefined {
		const scope = this.scopes.get(toolCallId);
		this.scopes.delete(toolCallId);
		if (!scope) return undefined;
		return { calls: scope.recorder.snapshot(), usage: scope.recorder.totalUsage };
	}

	clear(): void {
		this.scopes.clear();
	}
}
