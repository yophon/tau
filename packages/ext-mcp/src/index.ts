import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Extension, JsonSchema, TauAbortSignal, Tool, ToolResult } from "@tau/kernel";

export interface McpServerConfig {
	name: string;
	command?: string;
	args?: string[];
	url?: string;
	headers?: Record<string, string>;
	toolPrefix?: string;
	cwd?: string;
	env?: Record<string, string>;
}

export interface McpExtensionOptions {
	servers: McpServerConfig[];
}

type McpClient = Client;

interface ConnectedServer {
	config: McpServerConfig;
	client: McpClient;
	toolsByTauName: Map<string, string>;
}

interface McpToolContent {
	type: string;
	text?: string;
	data?: string;
	mimeType?: string;
	resource?: { uri?: string; text?: string; blob?: string; mimeType?: string };
	uri?: string;
	name?: string;
}

interface McpCallResult {
	content?: McpToolContent[];
	structuredContent?: Record<string, unknown>;
	toolResult?: unknown;
	isError?: boolean;
}

function sanitizeToolPart(value: string): string {
	const sanitized = value.replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "");
	return sanitized === "" ? "mcp" : sanitized;
}

function tauToolName(server: McpServerConfig, mcpToolName: string): string {
	return `${sanitizeToolPart(server.toolPrefix ?? server.name)}_${sanitizeToolPart(mcpToolName)}`;
}

function toolOutput(result: McpCallResult): string {
	if (result.toolResult !== undefined) return JSON.stringify(result.toolResult);
	const parts: string[] = [];
	for (const block of result.content ?? []) {
		if (block.type === "text" && block.text !== undefined) {
			parts.push(block.text);
		} else if (block.type === "resource" && block.resource?.text !== undefined) {
			parts.push(`[resource ${block.resource.uri ?? ""}]\n${block.resource.text}`);
		} else if (block.type === "resource_link") {
			parts.push(`[resource link ${block.uri ?? ""}${block.name ? ` ${block.name}` : ""}]`);
		} else {
			parts.push(JSON.stringify(block));
		}
	}
	if (result.structuredContent) parts.push(JSON.stringify(result.structuredContent));
	return parts.join("\n").trim() || "(empty MCP tool result)";
}

async function connectServer(config: McpServerConfig): Promise<ConnectedServer> {
	const client = new Client({ name: "tau-ext-mcp", version: "0.0.1" });
	if (config.command) {
		await client.connect(
			new StdioClientTransport({
				command: config.command,
				args: config.args,
				cwd: config.cwd,
				env: config.env,
				stderr: "pipe",
			}),
		);
	} else if (config.url) {
		await client.connect(
			new StreamableHTTPClientTransport(new URL(config.url), { requestInit: { headers: config.headers } }),
		);
	} else {
		throw new Error(`MCP server "${config.name}" must define command or url`);
	}
	return { config, client, toolsByTauName: new Map() };
}

export function createMcpExtension(options: McpExtensionOptions): Extension {
	return (api) => {
		const servers = new Map<string, ConnectedServer>();
		let initialized: Promise<void> | undefined;

		const initialize = async (): Promise<void> => {
			if (initialized) return initialized;
			initialized = (async () => {
				for (const config of options.servers) {
					const connected = await connectServer(config);
					servers.set(config.name, connected);
					const listed = await connected.client.listTools();
					for (const tool of listed.tools) {
						const name = tauToolName(config, tool.name);
						connected.toolsByTauName.set(name, tool.name);
						api.registerTool(createTauTool(connected, name, tool.name, tool.description, tool.inputSchema));
					}
				}
			})();
			return initialized;
		};

		api.on("session_start", async () => {
			await initialize();
		});

		api.on("session_shutdown", async () => {
			for (const server of servers.values()) {
				await server.client.close();
			}
			servers.clear();
			initialized = undefined;
		});
	};
}

function createTauTool(
	server: ConnectedServer,
	name: string,
	mcpToolName: string,
	description: string | undefined,
	parameters: JsonSchema,
): Tool {
	return {
		name,
		description: description ?? `MCP tool ${mcpToolName} from ${server.config.name}`,
		parameters,
		execute: async (args, signal): Promise<ToolResult> => {
			if (isAborted(signal)) return { output: "MCP tool call aborted", isError: true };
			try {
				const abortSignal = toAbortSignal(signal);
				const result = (await server.client.callTool(
					{ name: mcpToolName, arguments: args },
					undefined,
					abortSignal ? { signal: abortSignal } : undefined,
				)) as McpCallResult;
				return { output: toolOutput(result), isError: result.isError === true };
			} catch (cause) {
				return { output: cause instanceof Error ? cause.message : String(cause), isError: true };
			}
		},
	};
}

function isAborted(signal: TauAbortSignal | undefined): boolean {
	return signal?.aborted === true;
}

function toAbortSignal(signal: TauAbortSignal | undefined): AbortSignal | undefined {
	if (!signal) return undefined;
	const controller = new AbortController();
	if (signal.aborted) {
		controller.abort(signal.reason);
		return controller.signal;
	}
	signal.addEventListener("abort", () => controller.abort(signal.reason), { once: true });
	return controller.signal;
}

export default createMcpExtension({ servers: [] });
