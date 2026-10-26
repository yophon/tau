// Small helpers the CLI's modules share (P50: split out of main.ts; P62: the copies several modules
// kept): where ~/.tau is, the CLI's version, terminal colors for plain console output, a message's
// first line, an error's text, `~` in a path, a symlink check, and a `!` command's output.
import { lstatSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
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

export { errorText, firstLine } from "./text.ts";

/** `~` and `~/…` (or `~\…`) against the home directory; other paths as given. */
export function expandHome(path: string, home: string = homedir()): string {
	if (path === "~") return home;
	if (path.startsWith("~/") || path.startsWith("~\\")) return join(home, path.slice(2));
	return path;
}

export function isSymlink(path: string): boolean {
	try {
		return lstatSync(path).isSymbolicLink();
	} catch {
		return false;
	}
}

/** A `!` command's output for the conversation: stdout, then stderr, then a non-zero exit code. */
export function formatShellOutput(result: { stdout: string; stderr: string; exitCode: number }): string {
	const parts: string[] = [];
	if (result.stdout !== "") parts.push(result.stdout.trimEnd());
	if (result.stderr !== "") parts.push(result.stderr.trimEnd());
	let output = parts.filter((part) => part !== "").join("\n");
	if (output === "") output = "(no output)";
	if (result.exitCode !== 0) output += `\nExit code ${result.exitCode}`;
	return output;
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
