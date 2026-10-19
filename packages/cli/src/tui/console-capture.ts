/**
 * While the TUI owns the terminal, nothing else may draw on it: console output
 * from extensions, SDKs and libraries is captured. Everything goes to a log
 * file; warnings, errors and raw stderr writes also surface as one notice line
 * each (a repeat of the previous line is dropped). Restored on exit.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { format } from "node:util";

export interface CaptureOptions {
	logFile: string | undefined;
	onProblem(tone: "warn" | "error", text: string): void;
}

type ConsoleMethod = "log" | "info" | "debug" | "trace" | "warn" | "error";

/** Cursor show/hide sequences: terminal control, passed through rather than reported. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching terminal control is the point
const CURSOR_ONLY = /^(?:\x1b\[\?25[hl])+$/;

export function captureConsole(options: CaptureOptions): () => void {
	let logReady = false;
	const log = (level: string, text: string): void => {
		if (!options.logFile) return;
		try {
			if (!logReady) {
				mkdirSync(dirname(options.logFile), { recursive: true });
				logReady = true;
			}
			appendFileSync(options.logFile, `${new Date().toISOString()} ${level} ${text}\n`);
		} catch {
			// A log that cannot be written must not break the TUI.
		}
	};
	let lastProblem = "";
	const problem = (tone: "warn" | "error", text: string): void => {
		const line = text.trim().split("\n")[0]?.slice(0, 300) ?? "";
		if (line === "" || line === lastProblem) return;
		lastProblem = line;
		options.onProblem(tone, line);
	};

	const originals = new Map<ConsoleMethod, (...args: unknown[]) => void>();
	for (const method of ["log", "info", "debug", "trace", "warn", "error"] as const) {
		originals.set(method, console[method]);
		console[method] = (...args: unknown[]) => {
			const text = format(...args);
			log(method, text);
			if (method === "warn") problem("warn", text);
			else if (method === "error") problem("error", text);
		};
	}
	const originalStderrWrite = process.stderr.write;
	process.stderr.write = ((chunk: string | Uint8Array, ...rest: unknown[]): boolean => {
		const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
		// Ink's log-update hides and shows the cursor through cli-cursor, which writes to stderr.
		if (CURSOR_ONLY.test(text)) return originalStderrWrite.call(process.stderr, chunk, ...(rest as []));
		log("stderr", text.trimEnd());
		problem("warn", text);
		const callback = rest.find((arg): arg is () => void => typeof arg === "function");
		callback?.();
		return true;
	}) as typeof process.stderr.write;

	return () => {
		for (const [method, original] of originals) console[method] = original;
		process.stderr.write = originalStderrWrite;
	};
}

/** ~/.tau/logs/tui-YYYY-MM-DD.log */
export function defaultLogFile(home: string, now = new Date()): string {
	const day = now.toISOString().slice(0, 10);
	return `${home}/.tau/logs/tui-${day}.log`;
}
