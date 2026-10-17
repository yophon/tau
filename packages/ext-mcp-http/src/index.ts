// Pure-ECMAScript MCP client and extension core (P24a). The protocol is
// written against the MCP spec and pi's own SDK-free client (@earendil-works/pi-mcp)
// instead of using @modelcontextprotocol/sdk, which assumes Node/browser globals
// and cannot run on bare engines (QuickJS / JavaScriptCore via flutter_js).
//
// This package is the Streamable HTTP extension; @yophon/tau-ext-mcp builds on
// the same core and adds a stdio transport for Node hosts.
import type { Extension, Platform } from "@yophon/tau-kernel";
import { StreamableHttpTransport } from "./http.ts";
import { createMcpServers, type McpServerConfig, type McpServerStatus } from "./servers.ts";

export {
	type CallToolResult,
	type InitializeResult,
	MCP_PROTOCOL_VERSION,
	McpClient,
	type McpClientOptions,
	type McpContentBlock,
	type McpRequestOptions,
	type McpToolInfo,
} from "./client.ts";
export {
	McpHttpError,
	McpSessionExpiredError,
	StreamableHttpTransport,
	type StreamableHttpTransportOptions,
} from "./http.ts";
export {
	isJsonRpcNotification,
	isJsonRpcRequest,
	isJsonRpcResponse,
	JSON_RPC_ERROR_CODES,
	type JsonRpcId,
	type JsonRpcMessage,
	type JsonRpcNotification,
	type JsonRpcRequest,
	type JsonRpcResponse,
	McpAbortError,
	McpConnectionClosedError,
	McpError,
	McpTimeoutError,
	parseJsonRpcMessage,
} from "./jsonrpc.ts";
export { createMcpToolName, MAX_TOOL_NAME_LENGTH, mcpNamespace, sha256Hex } from "./naming.ts";
export { MCP_OUTPUT_MAX_BYTES, toolOutput } from "./result.ts";
export {
	createMcpServers,
	type McpServerConfig,
	type McpServerStatus,
	type McpServersHandle,
	type McpServersOptions,
} from "./servers.ts";
export {
	type McpTransport,
	type McpTransportCloseListener,
	type McpTransportErrorListener,
	type McpTransportMessageListener,
	type McpTransportSendOptions,
	TransportEvents,
} from "./transport.ts";

const CLIENT_INFO = { name: "tau-ext-mcp-http", version: "0.4.0" };

export interface HttpMcpServerConfig
	extends Pick<McpServerConfig, "name" | "headers" | "timeoutMs" | "riskFromAnnotations"> {
	/** Streamable HTTP endpoint URL. */
	url: string;
}

export type HttpMcpStatus = McpServerStatus;

export interface HttpMcpOptions {
	servers: HttpMcpServerConfig[];
	/**
	 * All HTTP goes through this seam. Injected explicitly (not read from
	 * ExtensionContext) because connect() must be callable outside any event —
	 * reconnect buttons, host entry startup — where no context exists.
	 */
	platform: Platform;
	onStatus?: (status: HttpMcpStatus) => void;
}

export interface HttpMcpHandle {
	extension: Extension;
	/**
	 * Idempotent connect/reconnect: initializes every not-yet-connected server,
	 * registers its tools, and never rejects on server failure (offline is
	 * reported via onStatus). Call after ExtensionRegistry.load; session_start
	 * also triggers it on hosts that emit that event.
	 */
	connect: () => Promise<void>;
}

export function createHttpMcpExtension(options: HttpMcpOptions): HttpMcpHandle {
	const { platform } = options;
	const handle = createMcpServers({
		servers: options.servers,
		platform,
		clientInfo: CLIENT_INFO,
		onStatus: options.onStatus,
		createTransport: (config) => {
			if (!config.url) throw new Error(`MCP server "${config.name}" must define url`);
			return new StreamableHttpTransport({ url: config.url, platform, headers: config.headers });
		},
	});
	return {
		extension: handle.extension,
		connect: async () => {
			await handle.connect();
		},
	};
}
