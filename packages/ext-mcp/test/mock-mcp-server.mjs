import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "tau-mock-mcp", version: "0.0.1" });

server.registerTool(
	"echo",
	{
		description: "Echo text with an MCP prefix",
		inputSchema: { text: z.string() },
	},
	async ({ text }) => ({
		content: [{ type: "text", text: `mcp:${text}` }],
	}),
);

server.registerTool(
	"snapshot",
	{ description: "Return an image", inputSchema: {} },
	async () => ({
		content: [
			{ type: "text", text: "see image" },
			{ type: "image", data: "A".repeat(4096), mimeType: "image/png" },
		],
	}),
);

await server.connect(new StdioServerTransport());
