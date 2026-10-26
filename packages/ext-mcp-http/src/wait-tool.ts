// wait_for_mcp_servers (P46, Claude Code's WaitForMcpServers; P62: split out of servers.ts): waits
// for servers still connecting in the background and says how each one stands. Pure ES.
import { AbortHandle, type ExtensionContext, type Platform, type Tool } from "@yophon/tau-kernel";

export const WAIT_FOR_MCP_SERVERS_TOOL = "wait_for_mcp_servers";
const WAIT_TOOL_DEFAULT_S = 60;
const WAIT_TOOL_MAX_S = 300;

/** A promise that settles when `signal` aborts (never, without one). */
export function aborted(signal: ExtensionContext["signal"]): Promise<void> {
	return new Promise((resolve) => signal?.addEventListener("abort", () => resolve()));
}

/** What the tool reads of a configured server. */
export interface WaitServer {
	config: { name: string };
	connecting?: Promise<unknown>;
	client?: { connectionState: string };
	tools: ReadonlySet<string>;
}

export function createWaitTool(
	servers: readonly WaitServer[],
	lastStatus: ReadonlyMap<string, { error?: string }>,
	sleep: Platform["sleep"],
): Tool {
	return {
		name: WAIT_FOR_MCP_SERVERS_TOOL,
		description:
			"Wait for MCP servers that are still connecting in the background, so their tools become available in this conversation. Call it when a server you need is not connected yet. Returns each server's state and how many tools it offers.",
		promptSnippet: "Wait for MCP servers still connecting",
		parameters: {
			type: "object",
			properties: {
				servers: {
					type: "array",
					items: { type: "string" },
					description: "Server names to wait for; all servers still connecting when omitted",
				},
				timeout_seconds: {
					type: "number",
					description: `How long to wait at most (default ${WAIT_TOOL_DEFAULT_S}, at most ${WAIT_TOOL_MAX_S})`,
				},
			},
		},
		execute: async (args, signal) => {
			const named = Array.isArray(args.servers)
				? args.servers.filter((name): name is string => typeof name === "string" && name.trim() !== "")
				: undefined;
			const unknown = (named ?? []).filter((name) => !servers.some((server) => server.config.name === name));
			const targets = named
				? servers.filter((server) => named.includes(server.config.name))
				: servers.filter((server) => server.connecting);
			const seconds = Math.min(
				WAIT_TOOL_MAX_S,
				Math.max(1, typeof args.timeout_seconds === "number" ? args.timeout_seconds : WAIT_TOOL_DEFAULT_S),
			);
			const pending = targets.flatMap((server) => (server.connecting ? [server.connecting] : []));
			if (pending.length > 0) {
				const timer = new AbortHandle();
				await Promise.race([
					Promise.all(pending),
					aborted(signal),
					...(sleep ? [sleep(seconds * 1000, timer.signal).catch(() => undefined)] : []),
				]);
				timer.abort();
			}
			const line = (server: WaitServer): string => {
				const name = server.config.name;
				if (server.connecting) return `${name}: still connecting`;
				if (server.client?.connectionState === "connected") {
					return `${name}: connected (${server.tools.size} tool${server.tools.size === 1 ? "" : "s"})`;
				}
				const status = lastStatus.get(name);
				return `${name}: offline${status?.error ? ` — ${status.error}` : ""}`;
			};
			const lines = [
				...(targets.length === 0 && !named ? ["No MCP server is connecting."] : []),
				...targets.map(line),
				...unknown.map(
					(name) =>
						`${name}: no such server (configured: ${servers.map((server) => server.config.name).join(", ") || "none"})`,
				),
			];
			return { content: [{ type: "text", text: lines.join("\n") }] };
		},
	};
}
