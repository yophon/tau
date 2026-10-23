// `tau serve` (P56): the session hub over stdio — one JSON-RPC message per line on stdin and stdout,
// logs on stderr, nothing printed at start (Codex's `app-server --listen stdio://`, Claude Code's
// `mcp serve`). The local socket comes with P58, WebSocket with P59.
import { createLineTransport } from "@yophon/tau-protocol";
import { SessionHub, type SessionHubOptions } from "./hub.ts";
import type { HubHost } from "./thread.ts";

export const LISTEN_VALUES = ["stdio"] as const;

export async function runServe(options: { listen: string; host: HubHost; hub: SessionHubOptions }): Promise<void> {
	if (options.listen !== "stdio" && options.listen !== "stdio://") {
		throw new Error(`--listen ${options.listen} is not supported yet (stdio only; a local socket comes later)`);
	}
	const hub = new SessionHub(options.host, options.hub);
	const transport = createLineTransport({
		write: (line) => {
			process.stdout.write(line);
		},
		onError: (error, line) =>
			console.error(`tau serve: dropped a line that is not JSON (${error.message}): ${line.slice(0, 200)}`),
	});
	hub.connect(transport);
	process.stdin.setEncoding("utf8");
	process.stdin.on("data", (chunk: string) => transport.feed(chunk));
	await new Promise<void>((resolve) => {
		process.stdin.on("end", () => {
			transport.end();
			resolve();
		});
		process.stdin.on("close", () => resolve());
	});
	await hub.close();
}
