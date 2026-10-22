// codemode on Node: pi-codemode's CodemodeSandbox runs each script's QuickJS VM in
// a worker thread (D30: consumed, pinned, not mirrored). The sandbox runtime and
// the wasm load on the first script, not at startup. Live workers are capped across
// sessions (pi 1.4): scripts queue for a free one. Truncated outputs are saved to new
// 0600 temp files (pi 1.0.3 output files).
import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Extension, TauAbortSignal } from "@yophon/tau-kernel";
import {
	type CodemodeExtensionOptions,
	type CodemodeSandboxFactory,
	type CodemodeSlot,
	createCodemodeExtension,
} from "./index.ts";

export * from "./index.ts";

// Shared across calls and sessions. Allow one replacement while a cancelled worker is still exiting (pi 1.4).
const DEFAULT_MAX_CODEMODE_WORKERS = 2;

/** `TAU_CODEMODE_MAX_WORKERS` if it is a positive integer (pi PI_CODEMODE_MAX_WORKERS); read per call. */
export function maxCodemodeWorkers(): number {
	const value = Number(process.env.TAU_CODEMODE_MAX_WORKERS);
	return Number.isInteger(value) && value > 0 ? value : DEFAULT_MAX_CODEMODE_WORKERS;
}

let activeCodemodeWorkers = 0;
/** Scripts waiting for a worker, in arrival order. */
const codemodeWorkerWaiters: (() => void)[] = [];

/** Give free slots to waiting scripts in arrival order. */
function admitCodemodeWorkers(): void {
	while (codemodeWorkerWaiters.length > 0 && activeCodemodeWorkers < maxCodemodeWorkers()) {
		activeCodemodeWorkers++;
		codemodeWorkerWaiters.shift()?.();
	}
}

function releaseCodemodeWorker(): void {
	activeCodemodeWorkers--;
	admitCodemodeWorkers();
}

/** One reserved worker: the sandbox takes it when it starts the worker, freed when that worker exits. */
class WorkerSlot implements CodemodeSlot {
	private held = true;

	take(): () => void {
		if (!this.held) throw new Error("The script already settled");
		// From here the sandbox releases the slot when the worker actually exits (pi 1.3 acquireWorker).
		this.held = false;
		return releaseCodemodeWorker;
	}

	release(): void {
		if (!this.held) return;
		this.held = false;
		releaseCodemodeWorker();
	}
}

/** The worker-thread QuickJS sandbox of @earendil-works/pi-codemode, loaded on first use. */
export const nodeCodemodeSandbox: CodemodeSandboxFactory = {
	reserve(signal, timeoutMs) {
		if (signal?.aborted) return Promise.resolve("aborted");
		return new Promise((resolve) => {
			const settle = (outcome: WorkerSlot | "aborted" | "timeout") => {
				clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
				const index = codemodeWorkerWaiters.indexOf(grant);
				if (index >= 0) codemodeWorkerWaiters.splice(index, 1);
				resolve(outcome);
			};
			const grant = () => settle(new WorkerSlot());
			const onAbort = () => settle("aborted");
			const timer = setTimeout(() => settle("timeout"), timeoutMs);
			codemodeWorkerWaiters.push(grant);
			signal?.addEventListener("abort", onAbort, { once: true });
			admitCodemodeWorkers();
		});
	},
	maxConcurrent: maxCodemodeWorkers,
	async create({ slot, ...options }) {
		const { CodemodeSandbox, loadQuickJSWasm } = await import("@earendil-works/pi-codemode");
		const sandbox = new CodemodeSandbox({
			...options,
			wasm: loadQuickJSWasm(),
			...(slot instanceof WorkerSlot ? { acquireWorker: () => slot.take() } : {}),
		});
		return {
			execute: (code, { signal, store }) => sandbox.execute(code, { signal: toAbortSignal(signal), store }),
			close: () => sandbox.close(),
		};
	},
};

/** The worker sandbox wants a real AbortSignal; the kernel hands out a structural one (hard rule 8). */
function toAbortSignal(signal: TauAbortSignal | undefined): AbortSignal | undefined {
	if (!signal) return undefined;
	const controller = new AbortController();
	if (signal.aborted) controller.abort(signal.reason);
	else signal.addEventListener("abort", () => controller.abort(signal.reason));
	return controller.signal;
}

/** Save a truncated output's full text: a new 0600 file, never following a planted link (`wx`). */
export async function saveCodemodeOutput(text: string): Promise<string> {
	const path = join(tmpdir(), `tau-codemode-${randomBytes(8).toString("hex")}.txt`);
	await writeFile(path, text, { mode: 0o600, flag: "wx" });
	return path;
}

export function createNodeCodemodeExtension(
	options: Omit<CodemodeExtensionOptions, "sandbox" | "saveFullOutput"> = {},
): Extension {
	return createCodemodeExtension({ ...options, sandbox: nodeCodemodeSandbox, saveFullOutput: saveCodemodeOutput });
}
