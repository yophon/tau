import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Agent, ExtensionRegistry, messageText } from "@yophon/tau-kernel";
import { fakePlatform, makeSseResponse, textTurn, toolCallTurn } from "../../kernel/test/helpers.ts";
import { createMcpExtension, StdioTransport } from "../src/index.ts";

const MOCK_SERVER = fileURLToPath(new URL("./mock-mcp-server.mjs", import.meta.url));

test("MCP stdio server tools are registered and callable as tau tools", async () => {
	const requests: unknown[] = [];
	const registry = await ExtensionRegistry.load([
		createMcpExtension({
			servers: [{ name: "mock", command: process.execPath, args: [MOCK_SERVER] }],
		}),
	]);
	const agent = new Agent({
		config: { baseUrl: "https://fake.test/v1", model: "fake-model" },
		platform: fakePlatform(
			[makeSseResponse(toolCallTurn("mcp__mock__echo", { text: "hello" })), makeSseResponse(textTurn("parent done"))],
			requests,
		),
		extensions: registry,
	});

	await registry.notifySessionStart("startup", agent.extensionContext());
	try {
		for await (const _event of agent.prompt("use mcp")) {
			// drain
		}
	} finally {
		await registry.notifySessionShutdown("quit", agent.extensionContext());
	}

	const firstRequest = requests[0] as { tools?: { function: { name: string } }[] };
	assert.ok(
		firstRequest.tools?.some((tool) => tool.function.name === "mcp__mock__echo"),
		JSON.stringify(firstRequest.tools),
	);
	const toolResult = agent.messages.find((message) => message.role === "toolResult");
	assert.ok(toolResult?.role === "toolResult");
	assert.equal(messageText(toolResult), "mcp:hello");
	assert.equal(messageText(agent.messages.at(-1) ?? toolResult), "parent done");
});

test("one unreachable server does not cost the others their tools; images become placeholders (HF-12/15)", async () => {
	const requests: unknown[] = [];
	const registry = await ExtensionRegistry.load([
		createMcpExtension({
			servers: [
				{ name: "broken", command: process.execPath, args: ["-e", "process.exit(3)"] },
				{ name: "mock", command: process.execPath, args: [MOCK_SERVER] },
			],
		}),
	]);
	const agent = new Agent({
		config: { baseUrl: "https://fake.test/v1", model: "fake-model" },
		platform: fakePlatform(
			[makeSseResponse(toolCallTurn("mcp__mock__snapshot", {})), makeSseResponse(textTurn("done"))],
			requests,
		),
		extensions: registry,
	});
	const errors: string[] = [];
	registry.setErrorSink(({ error }) => errors.push(error.message));
	await registry.notifySessionStart("startup", agent.extensionContext());
	try {
		assert.equal(errors.length, 1);
		assert.match(errors[0], /broken/);
		assert.ok(registry.tools.has("mcp__mock__echo"));
		for await (const _event of agent.prompt("snap")) {
			// drain
		}
	} finally {
		await registry.notifySessionShutdown("quit", agent.extensionContext());
	}
	const toolResult = agent.messages.find((message) => message.role === "toolResult");
	assert.ok(toolResult);
	const text = messageText(toolResult);
	assert.match(text, /see image/);
	assert.match(text, /[image image/png, ~3 KiB omitted]/);
	assert.ok(!text.includes("AAAA"), text);
});

test("tools whose names sanitize alike both get a hash suffix (pi createMcpToolName)", async () => {
	const registry = await ExtensionRegistry.load([
		createMcpExtension({ servers: [{ name: "mock", command: process.execPath, args: [MOCK_SERVER] }] }),
	]);
	const agent = new Agent({
		config: { baseUrl: "https://fake.test/v1", model: "fake-model" },
		platform: fakePlatform([], []),
		extensions: registry,
	});
	await registry.notifySessionStart("startup", agent.extensionContext());
	try {
		const names = [...registry.tools.keys()].filter((name) => name.startsWith("mcp__mock__a_b"));
		assert.equal(names.length, 2, names.join(","));
		for (const name of names) assert.match(name, /^mcp__mock__a_b_[0-9a-f]{8}$/);
		assert.notEqual(names[0], names[1]);
		const results = await Promise.all(names.map((name) => registry.tools.get(name)?.execute({})));
		assert.deepEqual(results.map((result) => (result?.content[0] as { text: string }).text).sort(), ["a-b", "a_b"]);
	} finally {
		await registry.notifySessionShutdown("quit", agent.extensionContext());
	}
});

test("server names that differ only in - and _ clash; the second is reported", async () => {
	const registry = await ExtensionRegistry.load([
		createMcpExtension({
			servers: [
				{ name: "my-srv", command: process.execPath, args: [MOCK_SERVER] },
				{ name: "my_srv", command: process.execPath, args: [MOCK_SERVER] },
			],
		}),
	]);
	const agent = new Agent({
		config: { baseUrl: "https://fake.test/v1", model: "fake-model" },
		platform: fakePlatform([], []),
		extensions: registry,
	});
	const errors: string[] = [];
	registry.setErrorSink(({ error }) => errors.push(error.message));
	await registry.notifySessionStart("startup", agent.extensionContext());
	try {
		assert.equal(errors.length, 1);
		assert.match(errors[0], /my_srv: server "my_srv" conflicts with "my-srv"/);
		assert.ok(registry.tools.has("mcp__my_srv__echo"));
	} finally {
		await registry.notifySessionShutdown("quit", agent.extensionContext());
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
	const registry = await ExtensionRegistry.load([
		createMcpExtension({
			servers: [{ name: "silent", command: process.execPath, args: ["-e", "setInterval(() => {}, 1000)"] }],
		}),
	]);
	const agent = new Agent({
		config: { baseUrl: "https://fake.test/v1", model: "fake-model" },
		platform: fakePlatform([], []),
		extensions: registry,
	});
	const errors: string[] = [];
	registry.setErrorSink(({ error }) => errors.push(error.message));
	const starting = registry.notifySessionStart("startup", agent.extensionContext());
	await new Promise((resolve) => setTimeout(resolve, 100));
	await registry.notifySessionShutdown("quit", agent.extensionContext());
	await starting;
	assert.equal([...registry.tools.keys()].filter((name) => name.startsWith("mcp__")).length, 0);
	assert.match(errors.join(" "), /silent/);
});

test(
	"a .cmd shim starts as a stdio server on Windows (cross-spawn)",
	{ skip: process.platform !== "win32" },
	async () => {
		const dir = mkdtempSync(join(tmpdir(), "tau-mcp-cmd-"));
		const shim = join(dir, "mock server.cmd");
		writeFileSync(shim, ["@echo off", `"${process.execPath}" "${MOCK_SERVER}" %*`, ""].join("\r\n"));
		const registry = await ExtensionRegistry.load([createMcpExtension({ servers: [{ name: "shim", command: shim }] })]);
		const agent = new Agent({
			config: { baseUrl: "https://fake.test/v1", model: "fake-model" },
			platform: fakePlatform([], []),
			extensions: registry,
		});
		await registry.notifySessionStart("startup", agent.extensionContext());
		try {
			const result = await registry.tools.get("mcp__shim__echo")?.execute({ text: "via cmd" });
			assert.equal((result?.content[0] as { text: string }).text, "mcp:via cmd");
		} finally {
			await registry.notifySessionShutdown("quit", agent.extensionContext());
		}
	},
);
