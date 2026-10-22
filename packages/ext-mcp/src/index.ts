// MCP extension for Node hosts: the pure-ES core of @yophon/tau-ext-mcp-http plus
// a stdio transport (P24a; the official SDK is retired). Servers with `command`
// run as child processes, servers with `url` use Streamable HTTP.
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import {
	createMcpServers,
	type McpElicitHandler,
	type McpServerConfig,
	type McpServerStatus,
	StreamableHttpTransport,
} from "@yophon/tau-ext-mcp-http";
import { defaultPlatform, type Extension } from "@yophon/tau-kernel";
import { StdioTransport } from "./stdio.ts";

export {
	elicitWithUi,
	MCP_OUTPUT_MAX_BYTES,
	type McpElicitation,
	type McpElicitHandler,
	type McpElicitResult,
} from "@yophon/tau-ext-mcp-http";
export { McpOAuthAuthorizationRequiredError } from "./oauth/errors.ts";
export {
	createMcpOAuth,
	McpOAuthFileStore,
	type McpOAuthSettings,
	McpSignInCancelledError,
	type McpSignInPrompt,
	signInMcpServer,
} from "./oauth/session.ts";
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

/** Save a binary MCP resource where the model can read it: a new 0600 temp file (P43, pi saveToTempFile). */
function saveBinary(base64: string, extension: string): string {
	const path = join(tmpdir(), `tau-mcp-${randomBytes(8).toString("hex")}${extension}`);
	writeFileSync(path, Buffer.from(base64, "base64"), { mode: 0o600, flag: "wx" });
	return path;
}

export interface McpExtensionOptions {
	servers: McpServerConfig[];
	onStatus?: (status: McpServerStatus) => void;
	/** How long the first prompt waits for servers with direct tools, ms (default 10000). */
	startupWaitMs?: number;
	/** The working directory, answered to servers' roots/list (P43, pi). Default: no roots. */
	cwd?: string;
	/** Register the resource tools (default true; P43). */
	resourceTools?: boolean;
	/** Pass MCP images to the model (default true; P43). False keeps the placeholder text used before. */
	images?: boolean;
	/** Answer servers' elicitation requests (P44); given, elicitation is declared. */
	elicit?: McpElicitHandler;
	/** Prompts as /mcp__<server>__<prompt> commands (default true; P44). */
	promptCommands?: boolean;
	/** `@server:uri` completion and attachments (default true; P44). */
	resourceMentions?: boolean;
	/** wait_for_mcp_servers while servers connect (default true; P46). */
	waitTool?: boolean;
}

/**
 * Connects the servers in the background at session_start, in parallel; the first
 * prompt waits for servers with direct tools. One unreachable server does not cost
 * the others their tools; it is reported through the UI, or stderr without one.
 */
export function createMcpExtension(options: McpExtensionOptions): Extension {
	const platform = defaultPlatform();
	return createMcpServers({
		servers: options.servers,
		platform,
		clientInfo: CLIENT_INFO,
		onStatus: options.onStatus,
		startupWaitMs: options.startupWaitMs,
		saveFullOutput,
		saveBinary,
		...(options.cwd ? { roots: [{ uri: pathToFileURL(options.cwd).href, name: basename(options.cwd) }] } : {}),
		...(options.resourceTools === false ? { resourceTools: false } : {}),
		...(options.images === false ? { images: false } : {}),
		...(options.elicit ? { elicit: options.elicit } : {}),
		...(options.promptCommands === false ? { promptCommands: false } : {}),
		...(options.resourceMentions === false ? { resourceMentions: false } : {}),
		...(options.waitTool === false ? { waitTool: false } : {}),
		// Without a UI (tau -p, pipes) an unavailable server still gets reported.
		reportUnavailable: (message) => process.stderr.write(`${message}\n`),
		createTransport: (config) => {
			if (config.command) {
				return new StdioTransport({
					command: config.command,
					args: config.args,
					cwd: config.cwd,
					env: config.env,
					...(config.inheritEnv === false ? { inheritEnv: false } : {}),
				});
			}
			if (config.url) {
				return new StreamableHttpTransport({
					url: config.url,
					platform,
					headers: config.headers,
					openGetStream: true,
					...(config.auth ? { auth: config.auth } : {}),
				});
			}
			throw new Error(`MCP server "${config.name}" must define command or url`);
		},
	}).extension;
}

export default createMcpExtension({ servers: [] });
