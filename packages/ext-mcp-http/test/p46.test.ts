// P46 (Claude Code's WaitForMcpServers): wait_for_mcp_servers, registered while a
// server connects in the background, waits for it and reports what it offers.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
	createIncrementalUtf8Decoder,
	type ExtensionContext,
	ExtensionRegistry,
	type ToolResult,
} from "@yophon/tau-kernel";
import {
	createMcpServers,
	type JsonRpcMessage,
	MCP_PROTOCOL_VERSION,
	type McpTransport,
	TransportEvents,
	WAIT_FOR_MCP_SERVERS_TOOL,
} from "../src/index.ts";

/** A server whose initialize answer waits for `gate`; it offers two tools, or fails when told to. */
class SlowTransport extends TransportEvents implements McpTransport {
	private readonly gate: Promise<void>;
	private readonly fail: boolean;
	constructor(gate: Promise<void>, fail = false) {
		super();
		this.gate = gate;
		this.fail = fail;
	}
	async start(): Promise<void> {}
	async send(message: JsonRpcMessage): Promise<void> {
		const record = message as unknown as { id?: number; method?: string };
		if (record.id === undefined || record.method === undefined) return;
		const { id, method } = record as { id: number; method: string };
		queueMicrotask(async () => {
			if (method === "initialize") {
				await this.gate;
				if (this.fail) {
					this.emitMessage({
						jsonrpc: "2.0",
						id,
						error: { code: -32000, message: "server exploded" },
					} as JsonRpcMessage);
					return;
				}
				this.emitMessage({
					jsonrpc: "2.0",
					id,
					result: { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: { tools: {} } },
				} as JsonRpcMessage);
				return;
			}
			const result =
				method === "tools/list"
					? {
							tools: [
								{ name: "search", inputSchema: { type: "object" } },
								{ name: "fetch", inputSchema: { type: "object" } },
							],
						}
					: {};
			this.emitMessage({ jsonrpc: "2.0", id, result } as JsonRpcMessage);
		});
	}
	async close(): Promise<void> {
		this.emitClose();
	}
}

function gate(): { promise: Promise<void>; open(): void } {
	let open: () => void = () => {};
	const promise = new Promise<void>((resolve) => {
		open = resolve;
	});
	return { promise, open };
}

async function setup(transports: Record<string, () => McpTransport>, extra: Record<string, unknown> = {}) {
	const handle = createMcpServers({
		servers: Object.keys(transports).map((name) => ({ name, url: `https://${name}.test/mcp` })),
		platform: {
			sleep: (ms, signal) =>
				new Promise((resolve, reject) => {
					const timer = setTimeout(resolve, ms);
					signal?.addEventListener("abort", () => {
						clearTimeout(timer);
						reject(new Error("aborted"));
					});
				}),
			createUtf8Decoder: createIncrementalUtf8Decoder,
		},
		clientInfo: { name: "test", version: "1" },
		createTransport: (config) => (transports[config.name] as () => McpTransport)(),
		...extra,
	});
	const registry = await ExtensionRegistry.load([handle.extension]);
	registry.attachHostActions({
		getAllTools: () => [],
		getActiveTools: () => [],
		setActiveTools: () => {},
	});
	await registry.notifySessionStart("startup", { messages: [] } as unknown as ExtensionContext);
	return { registry, handle };
}

const run = async (registry: ExtensionRegistry, args: Record<string, unknown>): Promise<string> => {
	const tool = registry.tools.get(WAIT_FOR_MCP_SERVERS_TOOL);
	assert.ok(tool, "the tool is registered");
	const result: ToolResult = await tool.execute(args);
	return result.content.map((part) => (part.type === "text" ? part.text : "")).join("");
};

test("wait_for_mcp_servers waits for a slow server and reports its tools; a failing one says why", async () => {
	const slow = gate();
	const broken = gate();
	const { registry, handle } = await setup({
		slow: () => new SlowTransport(slow.promise),
		broken: () => new SlowTransport(broken.promise, true),
	});
	try {
		setTimeout(() => {
			slow.open();
			broken.open();
		}, 30);
		const text = await run(registry, {});
		assert.match(text, /^slow: connected \(2 tools\)$/m);
		assert.match(text, /^broken: offline — .*server exploded/m);
		// The tool stays for the session; nothing connects any more.
		assert.equal(await run(registry, {}), "No MCP server is connecting.");
		assert.match(
			await run(registry, { servers: ["slow", "ghost"] }),
			/^slow: connected \(2 tools\)\nghost: no such server \(configured: slow, broken\)$/,
		);
	} finally {
		await handle.close();
	}
});

test("wait_for_mcp_servers gives up after timeout_seconds; it comes with any configured server; not in the gateway", async () => {
	const never = gate();
	const { registry, handle } = await setup({ stuck: () => new SlowTransport(never.promise) });
	try {
		const started = Date.now();
		assert.equal(await run(registry, { servers: ["stuck"], timeout_seconds: 1 }), "stuck: still connecting");
		assert.ok(Date.now() - started < 3000);
	} finally {
		never.open();
		await handle.close();
	}

	// Every server starts connecting at session_start, so the tool is there whenever servers are configured.
	const quick = await setup({ quick: () => new SlowTransport(Promise.resolve()) });
	await new Promise((resolve) => setTimeout(resolve, 20));
	assert.ok(quick.registry.tools.has(WAIT_FOR_MCP_SERVERS_TOOL));
	await quick.handle.close();

	// The gateway keeps what it had.
	const off = await setup({ slow: () => new SlowTransport(gate().promise) }, { waitTool: false });
	assert.equal(off.registry.tools.has(WAIT_FOR_MCP_SERVERS_TOOL), false);
	await off.handle.close();
});
