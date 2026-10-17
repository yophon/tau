// MCP extension for Node hosts: the pure-ES core of @yophon/tau-ext-mcp-http plus
// a stdio transport (P24a; the official SDK is retired). Servers with `command`
// run as child processes, servers with `url` use Streamable HTTP.
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createMcpServers,
	type McpServerConfig,
	type McpServerStatus,
	StreamableHttpTransport,
} from "@yophon/tau-ext-mcp-http";
import { defaultPlatform, type Extension } from "@yophon/tau-kernel";
import { StdioTransport } from "./stdio.ts";

export { MCP_OUTPUT_MAX_BYTES } from "@yophon/tau-ext-mcp-http";
export { StdioTransport, type StdioTransportOptions } from "./stdio.ts";
export type { McpServerConfig, McpServerStatus };

const CLIENT_INFO = { name: "tau-ext-mcp", version: "0.4.0" };

/** Save a truncated result's full text where the model can read it: a new 0600 temp file (pi 1.0.3 output files). */
function saveFullOutput(text: string): string {
	try {
		const path = join(tmpdir(), `tau-mcp-${randomBytes(8).toString("hex")}.txt`);
		// `wx` never follows a link someone else placed at the path.
		writeFileSync(path, text, { mode: 0o600, flag: "wx" });
		return `[Full output: ${path} (read it with offset/limit)]`;
	} catch (error) {
		return `[Could not save the full output: ${error instanceof Error ? error.message : String(error)}]`;
	}
}

export interface McpExtensionOptions {
	servers: McpServerConfig[];
	onStatus?: (status: McpServerStatus) => void;
}

/**
 * Connects the servers at session_start, in parallel; one unreachable server does
 * not cost the others their tools, and session_start then fails with every
 * failure listed so the host can report it (HF-12).
 */
export function createMcpExtension(options: McpExtensionOptions): Extension {
	const platform = defaultPlatform();
	return createMcpServers({
		servers: options.servers,
		platform,
		clientInfo: CLIENT_INFO,
		onStatus: options.onStatus,
		saveFullOutput,
		failOnUnavailable: true,
		createTransport: (config) => {
			if (config.command) {
				return new StdioTransport({ command: config.command, args: config.args, cwd: config.cwd, env: config.env });
			}
			if (config.url) return new StreamableHttpTransport({ url: config.url, platform, headers: config.headers });
			throw new Error(`MCP server "${config.name}" must define command or url`);
		},
	}).extension;
}

export default createMcpExtension({ servers: [] });
