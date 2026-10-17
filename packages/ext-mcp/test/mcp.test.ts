import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
	Agent,
	type AgentEvent,
	type Extension,
	ExtensionRegistry,
	messageText,
	type PlatformResponse,
	textResult,
} from "@yophon/tau-kernel";
import { fakePlatform, makeSseResponse, textTurn, toolCallTurn } from "../../kernel/test/helpers.ts";
import { createMcpExtension, type McpServerConfig, type McpServerStatus, StdioTransport } from "../src/index.ts";

const MOCK_SERVER = fileURLToPath(new URL("./mock-mcp-server.mjs", import.meta.url));
const mock = (name = "mock", extra: Partial<McpServerConfig> = {}): McpServerConfig => ({
	name,
	command: process.execPath,
	args: [MOCK_SERVER],
	...extra,
});

async function drain(events: AsyncGenerator<AgentEvent>): Promise<void> {
	for await (const _event of events) {
		// drain
	}
}

/** A session over the MCP extension; `settled()` waits until every server has a final status. */
async function session(
	servers: McpServerConfig[],
	responses: PlatformResponse[] = [],
	options: { extensions?: Extension[]; startupWaitMs?: number } = {},
) {
	const statuses: McpServerStatus[] = [];
	const requests: unknown[] = [];
	const registry = await ExtensionRegistry.load([
		createMcpExtension({ servers, onStatus: (status) => statuses.push(status), startupWaitMs: options.startupWaitMs }),
		...(options.extensions ?? []),
	]);
	const agent = new Agent({
		config: { baseUrl: "https://fake.test/v1", model: "fake-model" },
		platform: fakePlatform(responses, requests),
		extensions: registry,
	});
	await registry.notifySessionStart("startup", agent.extensionContext());
	const final = (server: string) =>
		statuses.findLast((status) => status.server === server && status.state !== "connecting");
	const settled = async () => {
		for (let i = 0; i < 250 && servers.some((server) => !final(server.name)); i++) {
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
	};
	const end = () => registry.notifySessionShutdown("quit", agent.extensionContext());
	return { registry, agent, statuses, requests, settled, final, end };
}

function wireTools(request: unknown): string[] {
	return ((request as { tools?: { function: { name: string } }[] }).tools ?? []).map((tool) => tool.function.name);
}

test("MCP stdio server tools are registered and callable; the first prompt waits for direct servers", async () => {
	const s = await session(
		[mock("mock", { env: { MOCK_INITIALIZE_DELAY_MS: "300" } })],
		[makeSseResponse(toolCallTurn("mcp__mock__echo", { text: "hello" })), makeSseResponse(textTurn("parent done"))],
	);
	try {
		// session_start returned before the (slow) server connected.
		assert.equal(s.registry.tools.has("mcp__mock__echo"), false);
		await drain(s.agent.prompt("use mcp"));
	} finally {
		await s.end();
	}
	assert.ok(wireTools(s.requests[0]).includes("mcp__mock__echo"), JSON.stringify(s.requests[0]));
	const toolResult = s.agent.messages.find((message) => message.role === "toolResult");
	assert.ok(toolResult?.role === "toolResult");
	assert.equal(messageText(toolResult), "mcp:hello");
	assert.equal(messageText(s.agent.messages.at(-1) ?? toolResult), "parent done");
});

test("a server that never answers does not hold the first prompt past the startup wait", async () => {
	const s = await session(
		[{ name: "silent", command: process.execPath, args: ["-e", "setInterval(() => {}, 1000)"] }],
		[makeSseResponse(textTurn("no tools"))],
		{ startupWaitMs: 200 },
	);
	const started = Date.now();
	try {
		await drain(s.agent.prompt("go"));
	} finally {
		await s.end();
	}
	assert.ok(Date.now() - started < 5_000);
	assert.equal(messageText(s.agent.messages.at(-1) ?? s.agent.messages[0]), "no tools");
});

test("one unreachable server does not cost the others their tools; images become placeholders (HF-12/15)", async () => {
	const s = await session(
		[{ name: "broken", command: process.execPath, args: ["-e", "process.exit(3)"] }, mock()],
		[makeSseResponse(toolCallTurn("mcp__mock__snapshot", {})), makeSseResponse(textTurn("done"))],
	);
	try {
		await s.settled();
		assert.equal(s.final("broken")?.state, "offline");
		assert.equal(s.final("mock")?.state, "connected");
		assert.ok(s.registry.tools.has("mcp__mock__echo"));
		await drain(s.agent.prompt("snap"));
	} finally {
		await s.end();
	}
	const toolResult = s.agent.messages.find((message) => message.role === "toolResult");
	assert.ok(toolResult);
	const text = messageText(toolResult);
	assert.match(text, /see image/);
	assert.match(text, /\[image image\/png, ~3 KiB omitted\]/);
	assert.ok(!text.includes("AAAA"), text);
});

test("tools whose names sanitize alike both get a hash suffix (pi createMcpToolName)", async () => {
	const s = await session([mock()]);
	try {
		await s.settled();
		const names = [...s.registry.tools.keys()].filter((name) => name.startsWith("mcp__mock__a_b"));
		assert.equal(names.length, 2, names.join(","));
		for (const name of names) assert.match(name, /^mcp__mock__a_b_[0-9a-f]{8}$/);
		assert.notEqual(names[0], names[1]);
		const results = await Promise.all(names.map((name) => s.registry.tools.get(name)?.execute({})));
		assert.deepEqual(results.map((result) => (result?.content[0] as { text: string }).text).sort(), ["a-b", "a_b"]);
	} finally {
		await s.end();
	}
});

test("server names that differ only in - and _ clash; the second is reported", async () => {
	const s = await session([mock("my-srv"), mock("my_srv")]);
	try {
		await s.settled();
		assert.equal(s.final("my_srv")?.state, "offline");
		assert.match(s.final("my_srv")?.error ?? "", /server "my_srv" conflicts with "my-srv"/);
		assert.ok(s.registry.tools.has("mcp__my_srv__echo"), "the first server's tools");
	} finally {
		await s.end();
	}
});

test("exposure: deferred tools are not declared, the mcp_servers section lists the server, tool_search activates", async () => {
	const toolSearch: Extension = (api) => {
		api.registerTool({
			name: "tool_search",
			description: "search",
			parameters: { type: "object", properties: {} },
			exposure: "model-only",
			defaultActive: false,
			reachesTools: () => "all",
			execute: async () => textResult("searched"),
		});
	};
	const s = await session(
		[
			mock("docs", {
				exposure: "deferred",
				toolExposure: { echo: "direct", "a*": "hidden" },
				description: "Docs server",
			}),
		],
		[makeSseResponse(textTurn("ok"))],
		{ extensions: [toolSearch] },
	);
	try {
		await s.settled();
		const exposures = Object.fromEntries(s.agent.getAllTools().map((info) => [info.name, info.exposure]));
		assert.equal(exposures.mcp__docs__echo, "direct");
		assert.equal(exposures.mcp__docs__snapshot, "deferred");
		assert.ok(
			Object.entries(exposures).some(([name, exposure]) => name.startsWith("mcp__docs__a_b") && exposure === "hidden"),
		);
		const info = s.agent.getAllTools().find((entry) => entry.name === "mcp__docs__snapshot");
		assert.deepEqual(info?.namespace, {
			name: "mcp__docs",
			aliases: ["docs"],
			description: "Docs server",
			instructions: "Mock tools for tests.",
		});
		await drain(s.agent.prompt("go"));
	} finally {
		await s.end();
	}
	assert.deepEqual(wireTools(s.requests[0]).sort(), ["mcp__docs__echo", "tool_search"]);
	const system = (s.requests[0] as { messages: { role: string; content: string }[] }).messages[0];
	assert.equal(system.role, "system");
	assert.match(system.content, /MCP servers whose tools are not declared to you\./);
	assert.match(system.content, /- mcp__docs \(tool_search\): Docs server/);
});

test("scripts get the whole CallToolResult as structuredContent; the model gets the text", async () => {
	let structured: unknown;
	const caller: Extension = (api) => {
		api.registerTool({
			name: "script",
			description: "calls stats",
			parameters: { type: "object", properties: {} },
			exposure: "model-only",
			execute: async (_args, _signal, _onUpdate, ctx) => {
				const outcome = await ctx?.executeTool?.("mcp__mock__stats", {});
				structured = outcome?.result.structuredContent;
				return textResult("ok");
			},
		});
	};
	const s = await session(
		[mock("mock", { exposure: "codemode" })],
		[makeSseResponse(toolCallTurn("script", {})), makeSseResponse(textTurn("done"))],
		{ extensions: [caller] },
	);
	try {
		await s.settled();
		const stats = s.agent.getAllTools().find((entry) => entry.name === "mcp__mock__stats");
		assert.equal(stats?.exposure, "deferred", "MCP codemode exposure registers deferred (pi 0.99.2)");
		const output = stats?.outputSchema as { properties: { structuredContent: unknown } };
		assert.deepEqual(output.properties.structuredContent, {
			type: "object",
			properties: { count: { type: "number" } },
			required: ["count"],
		});
		await drain(s.agent.prompt("go"));
	} finally {
		await s.end();
	}
	assert.deepEqual(structured, { content: [{ type: "text", text: '{"count":3}' }], structuredContent: { count: 3 } });
});

test("tools/list_changed withdraws a dropped tool: it becomes hidden and unreachable", async () => {
	const s = await session([mock()]);
	try {
		await s.settled();
		assert.equal(s.agent.getAllTools().find((info) => info.name === "mcp__mock__snapshot")?.exposure, "direct");
		await s.registry.tools.get("mcp__mock__drop")?.execute({});
		for (let i = 0; i < 100; i++) {
			if (s.agent.getAllTools().find((info) => info.name === "mcp__mock__snapshot")?.exposure === "hidden") break;
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
		assert.equal(s.agent.getAllTools().find((info) => info.name === "mcp__mock__snapshot")?.exposure, "hidden");
		assert.ok(!s.agent.getActiveTools().includes("mcp__mock__snapshot"));
	} finally {
		await s.end();
	}
});

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

test("StdioTransport.close() ends the server process", async () => {
	const transport = new StdioTransport({ command: process.execPath, args: ["-e", "setInterval(() => {}, 1000)"] });
	await transport.start();
	const pid = transport.pid;
	assert.ok(pid);
	assert.ok(isAlive(pid));
	await transport.close();
	for (let i = 0; i < 50 && isAlive(pid); i++) await new Promise((resolve) => setTimeout(resolve, 20));
	assert.equal(isAlive(pid), false);
});

test("shutdown while a server is still connecting closes it instead of registering its tools", async () => {
	const s = await session([{ name: "silent", command: process.execPath, args: ["-e", "setInterval(() => {}, 1000)"] }]);
	await new Promise((resolve) => setTimeout(resolve, 100));
	await s.end();
	await s.settled();
	assert.equal([...s.registry.tools.keys()].filter((name) => name.startsWith("mcp__")).length, 0);
	assert.equal(s.final("silent")?.state, "offline");
});

test(
	"a .cmd shim starts as a stdio server on Windows (cross-spawn)",
	{ skip: process.platform !== "win32" },
	async () => {
		const dir = mkdtempSync(join(tmpdir(), "tau-mcp-cmd-"));
		const shim = join(dir, "mock server.cmd");
		writeFileSync(shim, ["@echo off", `"${process.execPath}" "${MOCK_SERVER}" %*`, ""].join("\r\n"));
		const s = await session([{ name: "shim", command: shim }]);
		try {
			await s.settled();
			const result = await s.registry.tools.get("mcp__shim__echo")?.execute({ text: "via cmd" });
			assert.equal((result?.content[0] as { text: string }).text, "mcp:via cmd");
		} finally {
			await s.end();
		}
	},
);

test("a tool that reaches a connecting server waits for it (reachesTools)", async () => {
	let echoed: string | undefined;
	const caller: Extension = (api) => {
		api.registerTool({
			name: "script",
			description: "calls echo",
			parameters: { type: "object", properties: { code: { type: "string" } } },
			exposure: "model-only",
			reachesTools: (input) => String(input.code ?? "").match(/\w+/g) ?? [],
			execute: async (_args, _signal, _onUpdate, ctx) => {
				const outcome = await ctx?.executeTool?.("mcp__slow__echo", { text: "late" });
				echoed = outcome?.result.content.map((block) => (block.type === "text" ? block.text : "")).join("");
				return textResult("ok");
			},
		});
	};
	const s = await session(
		[mock("slow", { exposure: "codemode", env: { MOCK_INITIALIZE_DELAY_MS: "400" } })],
		[makeSseResponse(toolCallTurn("script", { code: "tools.mcp__slow__echo()" })), makeSseResponse(textTurn("done"))],
		{ extensions: [caller] },
	);
	try {
		await drain(s.agent.prompt("go"));
	} finally {
		await s.end();
	}
	assert.equal(echoed, "mcp:late");
});
