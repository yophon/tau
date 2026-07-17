// VM 侧真 HTTP fetch 桥（QuickJS 内运行，纯 ES）。宿主注入同步原语
// `__hostHttp(op, payloadJson)`，异步结果经宿主回调 `__HTTP_DELIVER(id, kind, json)`
// 送回来；本模块把这对原语组装成 PlatformFetch——chunk 推转拉队列 + abort 双向桥
// 照抄 host-weapp 的适配器范式（development.md 硬规则 8）。
// 这是 Flutter Platform 桥（Dart↔JS）形状的预演：同样的推转拉、同样的信号义务。

import type { PlatformBodyReader, PlatformFetch, PlatformResponse } from "../../packages/kernel/src/index.ts";
import { createIncrementalUtf8Decoder } from "../../packages/kernel/src/index.ts";

type HostHttp = (op: "start" | "abort", payloadJson: string) => string;

interface PendingRead {
	resolve(result: { done: boolean; value?: Uint8Array }): void;
	reject(reason: unknown): void;
}

interface RequestState {
	chunks: number[][];
	done: boolean;
	error?: string;
	pendingRead?: PendingRead;
	respond?: { resolve(response: PlatformResponse): void; reject(reason: unknown): void };
	status?: number;
	headers?: Record<string, string>;
	aborted: boolean;
}

interface BridgeGlobals {
	__hostHttp?: HostHttp;
	__HTTP_DELIVER?: (id: number, kind: string, payloadJson: string) => void;
}

export function installBridgedFetch(): PlatformFetch {
	const globals = globalThis as BridgeGlobals;
	const host = globals.__hostHttp;
	if (typeof host !== "function") throw new Error("__hostHttp was not injected by the VM host");
	const states = new Map<number, RequestState>();
	let nextId = 1;

	const settleRead = (state: RequestState): void => {
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
			pending.resolve({ done: false, value: new Uint8Array(chunk) });
			return;
		}
		if (state.done) {
			state.pendingRead = undefined;
			pending.resolve({ done: true });
		}
	};

	globals.__HTTP_DELIVER = (id, kind, payloadJson) => {
		const state = states.get(id);
		if (!state) return;
		const payload = payloadJson ? (JSON.parse(payloadJson) as Record<string, unknown>) : {};
		if (kind === "response") {
			state.status = payload.status as number;
			state.headers = (payload.headers as Record<string, string>) ?? {};
			const respond = state.respond;
			state.respond = undefined;
			respond?.resolve(makeResponse(id, state));
		} else if (kind === "chunk") {
			state.chunks.push(payload.bytes as number[]);
			settleRead(state);
		} else if (kind === "end") {
			state.done = true;
			settleRead(state);
		} else if (kind === "error") {
			state.error = String(payload.message ?? "bridged request failed");
			const respond = state.respond;
			state.respond = undefined;
			respond?.reject(new Error(state.error));
			settleRead(state);
		}
	};

	const makeReader = (id: number, state: RequestState): PlatformBodyReader => ({
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
			host("abort", JSON.stringify({ id, reason: String(reason ?? "cancel") }));
			return undefined;
		},
	});

	const makeResponse = (id: number, state: RequestState): PlatformResponse => {
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
	};

	return (url, init) =>
		new Promise<PlatformResponse>((resolve, reject) => {
			const id = nextId++;
			const state: RequestState = { chunks: [], done: false, aborted: false, respond: { resolve, reject } };
			states.set(id, state);
			const signal = init?.signal;
			const onAbort = (): void => {
				state.aborted = true;
				state.error = "aborted";
				host("abort", JSON.stringify({ id, reason: "abort" }));
				const respond = state.respond;
				state.respond = undefined;
				// abort 必须让 pending 环节 reject 浮出，内核才能转成 aborted 消息（硬规则 8）
				respond?.reject(new Error("aborted"));
				settleRead(state);
			};
			if (signal?.aborted) {
				onAbort();
				return;
			}
			signal?.addEventListener("abort", onAbort, { once: true });
			host(
				"start",
				JSON.stringify({ id, url, method: init?.method ?? "GET", headers: init?.headers ?? {}, body: init?.body }),
			);
		});
}
