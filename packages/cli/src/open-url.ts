// Open a link in the user's browser (P34 links; P44 MCP URL elicitation). Kept out
// of the TUI modules so code that main.ts imports statically can use it without
// reaching Ink.
import { spawn } from "node:child_process";

/** Open a URL in the browser (the URL handler on Windows, open on macOS, xdg-open elsewhere), detached. */
export function openUrl(url: string): void {
	if (!/^https?:\/\//i.test(url) && !/^file:/i.test(url)) return;
	// rundll32 takes the URL as one argument: no cmd.exe quoting of & and spaces.
	const [command, args] =
		process.platform === "win32"
			? ["rundll32", ["url.dll,FileProtocolHandler", url]]
			: process.platform === "darwin"
				? ["open", [url]]
				: ["xdg-open", [url]];
	try {
		spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true }).unref();
	} catch {
		// No browser to open: nothing to do.
	}
}
