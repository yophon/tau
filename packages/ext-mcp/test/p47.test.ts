// P47 over real stdio processes: a 2026-07-28 server, and 2025 servers that answer the probe
// with an error, exit on it, or ignore it.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { createMcpServers, MCP_PROTOCOL_VERSION, McpClient, type McpServerConfig } from "@yophon/tau-ext-mcp-http";
import { defaultPlatform, ExtensionRegistry } from "@yophon/tau-kernel";
import { StdioTransport } from "../src/index.ts";

const MOCK_SERVER = fileURLToPath(new URL("./mock-mcp-server.mjs", import.meta.url));
const transportFor = (era?: string) =>
	new StdioTransport({
		command: process.execPath,
		args: [MOCK_SERVER],
		env: era ? { MOCK_ERA: era } : {},
	});

async function connected(era?: string, timeoutMs = 5000) {
	const mcp = new McpClient({ name: "tau", version: "test", platform: defaultPlatform(), protocolNegotiation: "auto" });
	await mcp.connect(transportFor(era), { timeoutMs });
	return mcp;
}

describe("P47 over stdio", () => {
	it("a 2026-07-28 server speaks the modern revision end to end", async () => {
		const mcp = await connected("modern");
		try {
			assert.equal(mcp.protocolEra, "modern");
			assert.equal(mcp.protocolVersion, "2026-07-28");
			assert.equal(mcp.instructions, "Modern mock tools.");
			assert.equal(mcp.serverInfo?.name, "tau-mock-modern");
			assert.ok((await mcp.listTools()).some((tool) => tool.name === "echo"));
			assert.equal((await mcp.callTool("echo", { text: "hi" })).content[0]?.text, "mcp:hi");
		} finally {
			await mcp.close();
		}
	});

	it("a 2025 server that answers the probe with method-not-found shakes hands", async () => {
		const mcp = await connected();
		try {
			assert.equal(mcp.protocolEra, "legacy");
			assert.equal(mcp.protocolVersion, MCP_PROTOCOL_VERSION);
			assert.equal((await mcp.callTool("echo", { text: "hi" })).content[0]?.text, "mcp:hi");
		} finally {
			await mcp.close();
		}
	});

	it("a 2025 server that ignores the probe shakes hands after the probe timeout", async () => {
		const started = Date.now();
		const mcp = await connected("silent", 600);
		try {
			assert.equal(mcp.protocolEra, "legacy");
			assert.ok(Date.now() - started >= 550);
		} finally {
			await mcp.close();
		}
	});

	it("a 2025 server that exits on the probe is started again on the handshake", async () => {
		const configs: McpServerConfig[] = [
			{ name: "exits", command: process.execPath, args: [MOCK_SERVER], env: { MOCK_ERA: "exit" } },
		];
		let spawned = 0;
		const handle = createMcpServers({
			servers: configs,
			platform: defaultPlatform(),
			clientInfo: { name: "tau", version: "test" },
			protocolNegotiation: "auto",
			createTransport: (config) => {
				spawned++;
				return new StdioTransport({ command: config.command ?? "", args: config.args, env: config.env });
			},
		});
		await ExtensionRegistry.load([handle.extension]);
		try {
			const [status] = await handle.connect();
			assert.equal(status?.state, "connected", status?.error);
			assert.equal(status?.protocolVersion, MCP_PROTOCOL_VERSION);
			assert.equal(status?.toolCount, 6);
			assert.equal(spawned, 2);
		} finally {
			await handle.close();
		}
	});
});
