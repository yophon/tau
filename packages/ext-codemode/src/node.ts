// codemode on Node: pi-codemode's CodemodeSandbox runs each script's QuickJS VM in
// a worker thread (D30: consumed, pinned, not mirrored). The sandbox runtime and
// the wasm load on the first script, not at startup. Truncated outputs are saved
// to new 0600 temp files (pi 1.0.3 output files).
import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Extension, TauAbortSignal } from "@yophon/tau-kernel";
import { type CodemodeExtensionOptions, type CodemodeSandboxFactory, createCodemodeExtension } from "./index.ts";

export * from "./index.ts";

/** The worker-thread QuickJS sandbox of @earendil-works/pi-codemode, loaded on first use. */
export const nodeCodemodeSandbox: CodemodeSandboxFactory = {
	async create(options) {
		const { CodemodeSandbox, loadQuickJSWasm } = await import("@earendil-works/pi-codemode");
		const sandbox = new CodemodeSandbox({ ...options, wasm: loadQuickJSWasm() });
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
