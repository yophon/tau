// Minimal stdio MCP server for tests: newline-delimited JSON-RPC, no SDK.
import { createInterface } from "node:readline";

const tools = [
	{
		name: "echo",
		description: "Echo text with an MCP prefix",
		inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
	},
	{ name: "snapshot", description: "Return an image", inputSchema: { type: "object", properties: {} } },
	{ name: "a-b", description: "Dash name", inputSchema: { type: "object", properties: {} } },
	{ name: "a_b", description: "Underscore name", inputSchema: { type: "object", properties: {} } },
	{
		name: "stats",
		description: "Structured result",
		inputSchema: { type: "object", properties: {} },
		outputSchema: { type: "object", properties: { count: { type: "number" } }, required: ["count"] },
	},
	{ name: "drop", description: "Withdraw the snapshot tool", inputSchema: { type: "object", properties: {} } },
];
const initializeDelayMs = Number(process.env.MOCK_INITIALIZE_DELAY_MS ?? 0);

function send(message) {
	process.stdout.write(`${JSON.stringify(message)}\n`);
}

function callTool(name, args) {
	if (name === "echo") return { content: [{ type: "text", text: `mcp:${args.text}` }] };
	if (name === "snapshot") {
		return {
			content: [
				{ type: "text", text: "see image" },
				{ type: "image", data: "A".repeat(4096), mimeType: "image/png" },
			],
		};
	}
	if (name === "stats") return { content: [{ type: "text", text: "{\"count\":3}" }], structuredContent: { count: 3 } };
	if (name === "drop") {
		tools.splice(
			tools.findIndex((tool) => tool.name === "snapshot"),
			1,
		);
		send({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
		return { content: [{ type: "text", text: "dropped" }] };
	}
	return { content: [{ type: "text", text: name }] };
}

// P47: MOCK_ERA=modern answers MCP 2026-07-28 only (server/discover, the envelope required);
// "exit" and "silent" are 2025 servers that exit on, or ignore, anything sent before initialize.
const era = process.env.MOCK_ERA;
let initialized = false;
const VERSION_KEY = "io.modelcontextprotocol/protocolVersion";

function modern(message) {
	if (message.params?._meta?.[VERSION_KEY] !== "2026-07-28") {
		send({ jsonrpc: "2.0", id: message.id, error: { code: -32602, message: "Missing the request envelope" } });
		return;
	}
	const result = (value) => send({ jsonrpc: "2.0", id: message.id, result: { resultType: "complete", ...value } });
	switch (message.method) {
		case "server/discover":
			result({
				supportedVersions: ["2026-07-28"],
				capabilities: { tools: {} },
				instructions: "Modern mock tools.",
				_meta: { "io.modelcontextprotocol/serverInfo": { name: "tau-mock-modern", version: "0.0.1" } },
				ttlMs: 0,
				cacheScope: "private",
			});
			break;
		case "tools/list":
			result({ tools, ttlMs: 0, cacheScope: "private" });
			break;
		case "tools/call":
			result(callTool(message.params.name, message.params.arguments ?? {}));
			break;
		default:
			send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `Method not found: ${message.method}` } });
	}
}

createInterface({ input: process.stdin }).on("line", (line) => {
	if (!line.trim()) return;
	const message = JSON.parse(line);
	if (message.id === undefined) return; // notifications
	if (era === "modern") {
		modern(message);
		return;
	}
	if (message.method === "initialize") initialized = true;
	else if (!initialized && era === "exit") process.exit(0);
	else if (!initialized && era === "silent") return;
	switch (message.method) {
		case "initialize":
			setTimeout(() => send({
				jsonrpc: "2.0",
				id: message.id,
				result: {
					protocolVersion: message.params.protocolVersion,
					capabilities: { tools: {} },
					serverInfo: { name: "tau-mock-mcp", version: "0.0.1" },
					instructions: "Mock tools for tests.",
				},
			}), initializeDelayMs);
			break;
		case "tools/list":
			send({ jsonrpc: "2.0", id: message.id, result: { tools } });
			break;
		case "tools/call":
			send({ jsonrpc: "2.0", id: message.id, result: callTool(message.params.name, message.params.arguments ?? {}) });
			break;
		default:
			send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `Method not found: ${message.method}` } });
	}
});
