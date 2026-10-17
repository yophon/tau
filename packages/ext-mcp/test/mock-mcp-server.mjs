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
];

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
	return { content: [{ type: "text", text: name }] };
}

createInterface({ input: process.stdin }).on("line", (line) => {
	if (!line.trim()) return;
	const message = JSON.parse(line);
	if (message.id === undefined) return; // notifications
	switch (message.method) {
		case "initialize":
			send({
				jsonrpc: "2.0",
				id: message.id,
				result: {
					protocolVersion: message.params.protocolVersion,
					capabilities: { tools: {} },
					serverInfo: { name: "tau-mock-mcp", version: "0.0.1" },
					instructions: "Mock tools for tests.",
				},
			});
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
