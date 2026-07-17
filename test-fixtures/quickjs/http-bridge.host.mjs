// Node 宿主侧真 HTTP fetch 桥：把 undici fetch 的流式响应经 __HTTP_DELIVER 回调
// 泵进 QuickJS VM（chunk 以字节数组 JSON 封送——e2e 用，不追性能）。与
// http-bridge.vm.ts 成对；abort 反向桥（VM 发 abort op → AbortController）。
export function attachHttpBridge(context, runtime, { fetchImpl = fetch, onError = console.error } = {}) {
	let inflight = 0;
	const controllers = new Map();

	const pumpJobs = () => {
		while (runtime.hasPendingJob()) {
			const result = runtime.executePendingJobs(50);
			if (result.error) {
				onError(`pending job error: ${JSON.stringify(context.dump(result.error))}`);
				result.error.dispose();
				return;
			}
		}
	};

	const deliver = (id, kind, payload) => {
		const fn = context.getProp(context.global, "__HTTP_DELIVER");
		const args = [context.newNumber(id), context.newString(kind), context.newString(JSON.stringify(payload ?? {}))];
		const result = context.callFunction(fn, context.undefined, ...args);
		for (const arg of args) arg.dispose();
		fn.dispose();
		if (result.error) {
			onError(`__HTTP_DELIVER error: ${JSON.stringify(context.dump(result.error))}`);
			result.error.dispose();
		} else {
			result.value.dispose();
		}
		pumpJobs();
	};

	const start = (payload) => {
		inflight++;
		const controller = new AbortController();
		controllers.set(payload.id, controller);
		(async () => {
			try {
				const response = await fetchImpl(payload.url, {
					method: payload.method,
					headers: payload.headers,
					body: payload.body ?? undefined,
					signal: controller.signal,
				});
				const headers = {};
				response.headers.forEach((value, name) => {
					headers[name.toLowerCase()] = value;
				});
				deliver(payload.id, "response", { status: response.status, headers });
				if (response.body) {
					for await (const chunk of response.body) deliver(payload.id, "chunk", { bytes: [...chunk] });
				}
				deliver(payload.id, "end", {});
			} catch (cause) {
				deliver(payload.id, "error", { message: cause instanceof Error ? cause.message : String(cause) });
			} finally {
				inflight--;
				controllers.delete(payload.id);
			}
		})();
	};

	const hostHttp = context.newFunction("__hostHttp", (opHandle, payloadHandle) => {
		const op = context.getString(opHandle);
		const payload = JSON.parse(context.getString(payloadHandle));
		if (op === "start") start(payload);
		else if (op === "abort") controllers.get(payload.id)?.abort(payload.reason);
		return context.newString("ok");
	});
	context.setProp(context.global, "__hostHttp", hostHttp);
	hostHttp.dispose();

	return { inflightCount: () => inflight, pumpJobs };
}
