// Small helpers the CLI's modules share (P50: split out of main.ts): where ~/.tau is, the CLI's
// version, terminal colors for plain console output, and a message's first line.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import type { createInterface } from "node:readline/promises";

/**
 * User-level tau directory root. Honors `HOME` when set (tests and sandboxes
 * override it); on Windows `os.homedir()` reads USERPROFILE and ignores HOME,
 * which made e2e runs load the real ~/.tau/extensions.
 */
export function userHome(): string {
	const home = process.env.HOME?.trim();
	return home ? home : homedir();
}

export const dim = (text: string): string => `\x1b[2m${text}\x1b[0m`;

export const cyan = (text: string): string => `\x1b[36m${text}\x1b[0m`;

export const red = (text: string): string => `\x1b[31m${text}\x1b[0m`;

export function firstLine(text: string, max = 120): string {
	const line = text.split("\n")[0];
	return line.length > max ? `${line.slice(0, max)}…` : line;
}

/** The CLI package version (src/ and dist/ both sit one level below package.json). */
export const CLI_VERSION = (
	JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }
).version;

export type Readline = ReturnType<typeof createInterface>;

/**
 * A line from the terminal; undefined once the input has ended (Ctrl+D, a closed pipe), which
 * readline's own question never reports (the promise stays pending and Node exits with 13).
 */
export function ask(readline: Readline, prompt: string): Promise<string | undefined> {
	return new Promise((resolve) => {
		const ended = () => resolve(undefined);
		readline.once("close", ended);
		readline.question(prompt).then(
			(answer) => {
				readline.off("close", ended);
				resolve(answer);
			},
			() => {
				readline.off("close", ended);
				resolve(undefined);
			},
		);
	});
}
