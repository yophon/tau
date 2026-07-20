// Flutter demo 的 JS bundle 入口（esbuild iife，同 weapp demo 模式：产物提交进
// 仓库 assets/tau.js，clone 即可跑，CI 不含 Flutter 也不断链）。内核 + 静态注册
// createHttpMcpExtension（D8：无动态加载）+ guard 审批扩展。Platform 全部经 Dart
// 侧桥注入——fetch 用推转拉 chunk 队列 + abort 双向桥（硬规则 8），sleep/randomBytes
// 走 Dart 原语。暴露 prompt/steer/abort/connect + 事件回调给 Dart。
//
// Dart↔JS 通道（flutter_js）：JS→Dart 用 sendMessage(channel, jsonPayload)；
// Dart→JS 用 evaluate 调 globalThis.__tau.* 方法。异步结果经回调 id 配对。
import "../../../../test-fixtures/quickjs/polyfills.ts"; // 必须最先——补齐 flutter_js QuickJS 缺的 ES2022+ 内置，内核加载前就位（P17 单源化：与 smoke:quickjs:legacy 同一 fixture）
import { createHttpMcpExtension, type HttpMcpStatus } from "@yophon/tau-ext-mcp-http";
import {
	AbortHandle,
	Agent,
	createIncrementalUtf8Decoder,
	type Extension,
	ExtensionRegistry,
	type Platform,
	type PlatformBodyReader,
	type PlatformResponse,
	type TauAbortSignal,
	type UiCapability,
} from "@yophon/tau-kernel";

// flutter_js 注入的宿主桥（Dart 侧实现）。sendMessage 是 flutter_js 的 JS→Dart 通道。
interface FlutterHost {
	sendMessage(channel: string, message: string): void;
}
const host = (globalThis as typeof globalThis & { sendMessage?: FlutterHost["sendMessage"] }).sendMessage;
function emit(channel: string, payload: unknown): void {
	if (host) host(channel, JSON.stringify(payload));
}

// ---- HTTP 桥：JS 发起 → Dart 执行 → chunk/结果回送。推转拉队列照抄 host-weapp。----
interface HttpRequestState {
	chunks: Uint8Array[];
	done: boolean;
	error?: string;
	status?: number;
	headers?: Record<string, string>;
	pendingRead?: { resolve(r: { done: boolean; value?: Uint8Array }): void; reject(e: unknown): void };
	respond?: { resolve(r: PlatformResponse): void; reject(e: unknown): void };
}
const httpStates = new Map<number, HttpRequestState>();
let nextHttpId = 1;

function settleRead(state: HttpRequestState): void {
	const pending = state.pendingRead;
	if (!pending) return;
	if (state.error !== undefined) {
		state.pendingRead = undefined;
		pending.reject(new Error(state.error));
		return;
	}
	const chunk = state.chunks.shift();
	if (chunk) {
		state.pendingRead = undefined;
		pending.resolve({ done: false, value: chunk });
		return;
	}
	if (state.done) {
		state.pendingRead = undefined;
		pending.resolve({ done: true });
	}
}

function makeReader(id: number, state: HttpRequestState): PlatformBodyReader {
	return {
		read: () =>
			new Promise((resolve, reject) => {
				if (state.pendingRead) {
					reject(new Error("concurrent read on a bridged body"));
					return;
				}
				state.pendingRead = { resolve, reject };
				settleRead(state);
			}),
		cancel: (reason) => {
			state.done = true;
			emit("tau_http", { op: "abort", id, reason: String(reason ?? "cancel") });
			return undefined;
		},
	};
}

function makeResponse(id: number, state: HttpRequestState): PlatformResponse {
	const status = state.status ?? 0;
	const headers = state.headers ?? {};
	return {
		ok: status >= 200 && status < 300,
		status,
		headers: { get: (name) => headers[name.toLowerCase()] ?? null },
		body: { getReader: () => makeReader(id, state) },
		text: async () => {
			const reader = makeReader(id, state);
			const decoder = createIncrementalUtf8Decoder();
			let text = "";
			while (true) {
				const { done, value } = await reader.read();
				if (value) text += decoder.decode(value);
				if (done) return text + decoder.flush();
			}
		},
	};
}

const bridgedFetch: Platform["fetch"] = (url, init) =>
	new Promise<PlatformResponse>((resolve, reject) => {
		const id = nextHttpId++;
		const state: HttpRequestState = { chunks: [], done: false, respond: { resolve, reject } };
		httpStates.set(id, state);
		const signal = init?.signal;
		const onAbort = (): void => {
			state.error = "aborted";
			emit("tau_http", { op: "abort", id, reason: "abort" });
			const respond = state.respond;
			state.respond = undefined;
			// abort 后 pending 环节必须 reject 浮出，内核才能转成 aborted 消息（硬规则 8）
			respond?.reject(new Error("aborted"));
			settleRead(state);
		};
		if (signal?.aborted) {
			onAbort();
			return;
		}
		signal?.addEventListener("abort", onAbort, { once: true });
		emit("tau_http", {
			op: "start",
			id,
			url,
			method: init?.method ?? "GET",
			headers: init?.headers ?? {},
			body: init?.body,
		});
	});

// Dart 递 base64 编码的 chunk 字节回来（封送简单可靠，e2e/demo 用不追性能）。
function base64ToBytes(b64: string): Uint8Array {
	const binary = atobPolyfill(b64);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}
// JSC/QuickJS 未必有 atob；手写解码（Dart 侧 base64 标准字母表）。
const B64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
function atobPolyfill(input: string): string {
	const clean = input.replace(/=+$/, "");
	let output = "";
	let buffer = 0;
	let bits = 0;
	for (const ch of clean) {
		const index = B64_ALPHABET.indexOf(ch);
		if (index === -1) continue;
		buffer = (buffer << 6) | index;
		bits += 6;
		if (bits >= 8) {
			bits -= 8;
			output += String.fromCharCode((buffer >> bits) & 0xff);
		}
	}
	return output;
}

// ---- sleep 桥（Dart Timer；启用重试与停滞看门狗，D15）----
interface SleepState {
	resolve(): void;
	reject(e: unknown): void;
}
const sleepStates = new Map<number, SleepState>();
let nextSleepId = 1;
const bridgedSleep = (ms: number, signal?: TauAbortSignal): Promise<void> =>
	new Promise<void>((resolve, reject) => {
		const id = nextSleepId++;
		sleepStates.set(id, { resolve, reject });
		const onAbort = (): void => {
			if (sleepStates.delete(id)) {
				emit("tau_sleep", { op: "cancel", id });
				reject(new Error("sleep aborted"));
			}
		};
		if (signal?.aborted) {
			onAbort();
			return;
		}
		signal?.addEventListener("abort", onAbort, { once: true });
		emit("tau_sleep", { op: "start", id, ms });
	});

const platform: Platform = {
	fetch: bridgedFetch,
	createUtf8Decoder: createIncrementalUtf8Decoder,
	randomBytes: (length) => {
		// Dart 侧 Random.secure() 预填一批熵，注入到 __ENTROPY；不足时降级 LCG（demo）。
		const entropy = (globalThis as typeof globalThis & { __ENTROPY?: number[] }).__ENTROPY;
		const bytes = new Uint8Array(length);
		if (entropy && entropy.length >= length) {
			for (let i = 0; i < length; i++) bytes[i] = entropy.shift() ?? 0;
			return bytes;
		}
		let state = length * 2654435761;
		for (let i = 0; i < length; i++) {
			state = (state * 1103515245 + 12345) & 0x7fffffff;
			bytes[i] = state & 0xff;
		}
		return bytes;
	},
	sleep: bridgedSleep,
};

// ---- UI 桥（Dart 弹窗）：guard 审批扩展经 ctx.ui.confirm 调用 ----
interface UiState {
	resolve(value: boolean): void;
}
const uiStates = new Map<number, UiState>();
let nextUiId = 1;
const bridgedUi: UiCapability = {
	confirm: (title, message) =>
		new Promise<boolean>((resolve) => {
			const id = nextUiId++;
			uiStates.set(id, { resolve });
			emit("tau_ui", { op: "confirm", id, title, message: message ?? "" });
		}),
	input: async () => undefined,
	select: async () => undefined,
	notify: (message, level) => emit("tau_ui", { op: "notify", message, level: level ?? "info" }),
};

// ---- guard 审批扩展（P1 guard 模式）：run_command/write_file 前弹窗确认 ----
const SENSITIVE = /(run_command|write_file)$/;
const guardExtension: Extension = (api) => {
	api.on("tool_call", async (event, ctx) => {
		if (!SENSITIVE.test(event.toolName)) return undefined;
		const ok = await ctx.ui?.confirm(`允许执行 ${event.toolName}？`, JSON.stringify(event.input));
		if (ok === false) return { block: true, reason: "用户拒绝了该工具调用" };
		return undefined;
	});
};

// ---- Agent 装配 ----
interface ChatConfig {
	baseUrl: string;
	apiKey?: string;
	model: string;
	mcpUrl?: string;
	mcpToken?: string;
	stallTimeoutMs?: number;
}

let agent: Agent | undefined;
let currentAbort: AbortHandle | undefined;
let mcpConnect: (() => Promise<void>) | undefined;

async function configure(config: ChatConfig): Promise<void> {
	const extensions: Extension[] = [guardExtension];
	if (config.mcpUrl) {
		const mcp = createHttpMcpExtension({
			servers: [
				{
					name: "computer",
					url: config.mcpUrl,
					headers: config.mcpToken ? { authorization: `Bearer ${config.mcpToken}` } : undefined,
				},
			],
			platform,
			onStatus: (status: HttpMcpStatus) => emit("tau_event", { type: "mcp_status", status }),
		});
		extensions.push(mcp.extension);
		mcpConnect = mcp.connect;
	} else {
		mcpConnect = undefined;
	}
	agent = new Agent({
		config: {
			baseUrl: config.baseUrl,
			apiKey: config.apiKey,
			model: config.model,
			stallTimeoutMs: config.stallTimeoutMs,
		},
		platform,
		ui: bridgedUi,
		extensions: await ExtensionRegistry.load(extensions),
	});
	emit("tau_event", { type: "configured" });
}

async function connect(): Promise<void> {
	// 裸引擎宿主无 session_start 发射方——显式 connect()（ext-mcp-http 契约）
	if (mcpConnect) await mcpConnect();
}

async function runPrompt(text: string): Promise<void> {
	if (!agent) {
		emit("tau_event", { type: "error", message: "agent not configured" });
		return;
	}
	currentAbort = new AbortHandle();
	try {
		for await (const event of agent.prompt(text, currentAbort.signal)) {
			if (event.type === "text_delta") emit("tau_event", { type: "text_delta", delta: event.delta });
			else if (event.type === "reasoning_delta") emit("tau_event", { type: "reasoning_delta", delta: event.delta });
			else if (event.type === "tool_start")
				emit("tau_event", { type: "tool_start", name: event.toolCall.name, input: event.toolCall.arguments });
			else if (event.type === "tool_result")
				emit("tau_event", {
					type: "tool_result",
					name: event.toolCall.name,
					output: event.result.output,
					isError: event.result.isError === true,
				});
			else if (event.type === "assistant_message")
				emit("tau_event", {
					type: "assistant_message",
					stopReason: event.message.stopReason,
					error: event.message.errorMessage,
				});
			else if (event.type === "agent_end") emit("tau_event", { type: "agent_end" });
		}
	} catch (cause) {
		emit("tau_event", { type: "error", message: cause instanceof Error ? cause.message : String(cause) });
	} finally {
		currentAbort = undefined;
	}
}

// ---- Dart→JS 入口（Dart 用 evaluate 调用）----
interface TauBridge {
	configure(json: string): void;
	connect(): void;
	prompt(text: string): void;
	steer(text: string): void;
	abort(): void;
	resolveHttp(id: number, kind: string, json: string): void;
	resolveSleep(id: number): void;
	resolveUi(id: number, ok: boolean): void;
}

const tau: TauBridge = {
	configure: (json) => {
		configure(JSON.parse(json) as ChatConfig).catch((cause) =>
			emit("tau_event", { type: "error", message: cause instanceof Error ? cause.message : String(cause) }),
		);
	},
	connect: () => {
		connect().catch((cause) =>
			emit("tau_event", { type: "error", message: cause instanceof Error ? cause.message : String(cause) }),
		);
	},
	prompt: (text) => {
		runPrompt(text);
	},
	steer: (text) => {
		agent?.steer(text);
	},
	abort: () => {
		currentAbort?.abort("user");
	},
	resolveHttp: (id, kind, json) => {
		const state = httpStates.get(id);
		if (!state) return;
		const payload = json ? (JSON.parse(json) as Record<string, unknown>) : {};
		if (kind === "response") {
			state.status = payload.status as number;
			state.headers = (payload.headers as Record<string, string>) ?? {};
			const respond = state.respond;
			state.respond = undefined;
			respond?.resolve(makeResponse(id, state));
		} else if (kind === "chunk") {
			state.chunks.push(base64ToBytes(payload.b64 as string));
			settleRead(state);
		} else if (kind === "end") {
			state.done = true;
			settleRead(state);
			if (state.done && state.chunks.length === 0 && !state.pendingRead) httpStates.delete(id);
		} else if (kind === "error") {
			state.error = String(payload.message ?? "request failed");
			const respond = state.respond;
			state.respond = undefined;
			respond?.reject(new Error(state.error));
			settleRead(state);
		}
	},
	resolveSleep: (id) => {
		const state = sleepStates.get(id);
		if (state && sleepStates.delete(id)) state.resolve();
	},
	resolveUi: (id, ok) => {
		const state = uiStates.get(id);
		if (state && uiStates.delete(id)) state.resolve(ok);
	},
};

(globalThis as typeof globalThis & { __tau?: TauBridge }).__tau = tau;
emit("tau_event", { type: "ready" });
