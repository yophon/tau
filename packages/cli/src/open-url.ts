// Open a link in the user's browser (P34 links; P44 MCP URL elicitation; P62: `tau mcp login` too).
// Kept out of the TUI modules so code that main.ts imports statically can use it without reaching Ink.
import { spawn } from "node:child_process";

/**
 * The command that opens `url` on `platform`, or undefined for anything but http(s) and file links:
 * the URL handler on Windows (rundll32 takes the URL as one argument — cmd's `start` would cut it at
 * the first `&`, which every OAuth link has), open on macOS, xdg-open elsewhere.
 */
export function openUrlCommand(url: string, platform: NodeJS.Platform): [string, string[]] | undefined {
	if (!/^https?:\/\//i.test(url) && !/^file:/i.test(url)) return undefined;
	if (platform === "win32") return ["rundll32", ["url.dll,FileProtocolHandler", url]];
	if (platform === "darwin") return ["open", [url]];
	return ["xdg-open", [url]];
}

/** Open a URL in the browser, detached; nothing happens on a machine without one. */
export function openUrl(url: string): void {
	const command = openUrlCommand(url, process.platform);
	if (!command) return;
	try {
		spawn(command[0], command[1], { detached: true, stdio: "ignore", windowsHide: true })
			// A missing opener (no xdg-open) is an error event, not a throw: without a listener it would crash tau.
			.on("error", () => {})
			.unref();
	} catch {
		// No browser to open: nothing to do.
	}
}
