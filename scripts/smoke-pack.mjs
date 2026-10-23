// Pack smoke: prove the published artifact works for a real consumer. Packs
// @yophon/tau-kernel, installs the tarball into a bare temp project, then (1)
// runs a two-turn scripted agent loop through the built JS and (2) typechecks a
// consumer TS file against the shipped d.ts. (3) P24e: packs ext-tool-search and
// ext-codemode too and runs a codemode script from the installed layout, so the
// pi-codemode worker and wasm resolve as they will after `npm i` (needs the
// registry for @earendil-works/pi-codemode).
// (4) P25: the CLI's TUI from an installed layout — its built tui/ modules next
// to the packed kernel and protocol (P57: the TUI is a protocol client; a small
// scripted server answers it here) and the exact ink/react/string-width versions
// the CLI pins, loaded and rendered once. The CLI tarball itself pins its internal deps
// to registry URLs (shrinkwrap), so the full cli install runs after publishing.
// (5) P30: the Feishu channel plugin installs the way docs/gateway.md says
// (npm install --prefix <gateway dir>) and the packed gateway loads it from
// there; the CLI's shrinkwrap carries no Feishu SDK.
// (6) P36: host-node from its tarball (smoke-pack-host-node.mjs): photon's wasm
// and the image worker resolve from dist, and a background command runs.
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { withPublishManifest } from "./release-lib.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const kernelDir = join(root, "packages/kernel");
const packageDir = (dir) => join(root, "packages", dir);
const workDir = join(tmpdir(), `tau-pack-smoke-${Date.now()}`);
mkdirSync(workDir, { recursive: true });

function commandForPlatform(command) {
	return process.platform === "win32" && (command === "npm" || command === "npx") ? `${command}.cmd` : command;
}

function run(command, args, options = {}) {
	const result = spawnSync(commandForPlatform(command), args, {
		cwd: options.cwd,
		encoding: "utf8",
		shell: process.platform === "win32",
		stdio: ["inherit", "pipe", "pipe"],
	});
	if (result.status !== 0) {
		throw new Error(`Command failed: ${command} ${args.join(" ")}\n${result.stdout}\n${result.stderr}`);
	}
	return result;
}

const CONSUMER_MJS = `
import { Agent, createIncrementalUtf8Decoder } from "@yophon/tau-kernel";

const encoder = new TextEncoder();
function sse(payloads) {
	const bytes = encoder.encode([...payloads.map((p) => \`data: \${JSON.stringify(p)}\\n\\n\`), "data: [DONE]\\n\\n"].join(""));
	const chunks = [];
	for (let i = 0; i < bytes.length; i += 3) chunks.push(bytes.slice(i, i + 3));
	let index = 0;
	return {
		ok: true,
		status: 200,
		text: async () => "",
		body: {
			getReader: () => ({
				read: async () => (index >= chunks.length ? { done: true } : { done: false, value: chunks[index++] }),
				cancel: () => undefined,
			}),
		},
	};
}

const turns = [
	sse([{ choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "echo", arguments: '{"text":"你好"}' } }] }, finish_reason: "tool_calls" }] }]),
	sse([{ choices: [{ delta: { content: "回声：你好 ☀️" }, finish_reason: "stop" }] }]),
];
let call = 0;
const platform = {
	fetch: async () => turns[call++],
	createUtf8Decoder: createIncrementalUtf8Decoder,
	randomBytes: (n) => new Uint8Array(n),
};
let echoed;
const agent = new Agent({
	config: { baseUrl: "https://fake.test/v1", model: "m" },
	platform,
	tools: [{
		name: "echo",
		description: "echo",
		parameters: { type: "object", properties: { text: { type: "string" } } },
		execute: async (args) => { echoed = args.text; return { content: [{ type: "text", text: String(args.text) }] }; },
	}],
});
let text = "";
for await (const event of agent.prompt("说你好")) {
	if (event.type === "text_delta") text += event.delta;
}
if (text !== "回声：你好 ☀️" || echoed !== "你好") {
	throw new Error(\`unexpected result: text=\${text} echoed=\${echoed}\`);
}
console.log("pack smoke runtime ok");
`;

const CODEMODE_MJS = `
import { Agent, createIncrementalUtf8Decoder } from "@yophon/tau-kernel";
import { createNodeCodemodeExtension } from "@yophon/tau-ext-codemode/node";
import { ExtensionRegistry } from "@yophon/tau-kernel";

const encoder = new TextEncoder();
const sse = (payloads) => {
	const bytes = encoder.encode([...payloads.map((p) => \`data: \${JSON.stringify(p)}\\n\\n\`), "data: [DONE]\\n\\n"].join(""));
	let sent = false;
	return { ok: true, status: 200, text: async () => "", body: { getReader: () => ({
		read: async () => (sent ? { done: true } : ((sent = true), { done: false, value: bytes })),
		cancel: () => undefined,
	}) } };
};
const code = 'const r = await tools.echo({ text: "hi" }); return r + "!";';
const turns = [
	sse([{ choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "codemode", arguments: JSON.stringify({ code }) } }] }, finish_reason: "tool_calls" }] }]),
	sse([{ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] }]),
];
let call = 0;
const registry = await ExtensionRegistry.load([createNodeCodemodeExtension()]);
const agent = new Agent({
	config: { baseUrl: "https://fake.test/v1", model: "m" },
	platform: { fetch: async () => turns[call++], createUtf8Decoder: createIncrementalUtf8Decoder, randomBytes: (n) => new Uint8Array(n) },
	extensions: registry,
	tools: [{ name: "echo", description: "echo", parameters: { type: "object", properties: { text: { type: "string" } } },
		execute: async (args) => ({ content: [{ type: "text", text: String(args.text) }] }) }],
});
agent.setActiveTools([...agent.getActiveTools(), "codemode"]);
for await (const _event of agent.prompt("go")) {}
const result = agent.messages.find((m) => m.role === "toolResult");
const text = result.content.map((block) => block.text ?? "").join("");
if (!/^Script completed/.test(text) || !text.endsWith("hi!")) throw new Error(\`unexpected codemode result: \${text}\`);
console.log("pack smoke codemode ok");
`;

const TUI_MJS = `
import { PassThrough } from "node:stream";
import React from "react";
import { render } from "ink";
import { createMemoryTransportPair, JsonRpcPeer, TauClient } from "@yophon/tau-protocol";
import { App } from "./tui/app.js";
import { TuiController } from "./tui/controller.js";
import { TuiSession } from "./tui/session-client.js";

// A scripted server with one empty session: what the TUI asks for at start.
const [clientEnd, serverEnd] = createMemoryTransportPair();
const server = new JsonRpcPeer(serverEnd, { idPrefix: "s" });
const extensions = { tools: 0, commands: 0, shortcuts: 0, messageRenderers: 0, entryRenderers: 0, toolRenderers: 0,
	widgets: 0, statusItems: 0, diagnostics: 0, autocompleteProviders: 0, markdownTransformers: 0 };
const state = { id: "s1", cwd: process.cwd(), model: "m", modelChoices: ["m"], permissionMode: "supervised",
	sessionUsage: {}, contextUsage: { tokens: 0 }, tools: { all: [], active: [] }, running: false,
	lastSessionStart: "startup", extensionsVersion: 0, extensions, foregroundCommands: 0, queued: false };
server.onRequest("initialize", () => ({ serverInfo: { name: "pack-smoke", version: "0" }, protocolVersion: "tau/1" }));
server.onRequest("thread/start", () => ({
	thread: { id: "s1", cwd: process.cwd(), model: "m", status: "idle" }, events: [], seq: 0, messages: [], state,
}));
server.onRequest("command/list", () => ({ commands: [], shortcuts: [] }));
server.onRequest("surfaces/read", () => ({ status: [], widgets: [] }));
const client = new TauClient(clientEnd, { name: "pack-smoke" });
await client.initialize({ nativeEvents: true, width: 80 });
const session = new TuiSession(client);
await session.join("thread/start", {});
const controller = new TuiController(
	{ session, cwd: process.cwd() },
	{ columns: () => 80, readBranch: () => undefined },
);
const stdout = new PassThrough();
stdout.columns = 80;
let output = "";
stdout.on("data", (chunk) => { output += chunk; });
const stdin = new PassThrough();
stdin.isTTY = true;
stdin.setRawMode = () => stdin;
stdin.ref = () => stdin;
stdin.unref = () => stdin;
const ink = render(React.createElement(App, { controller }), { stdout, stdin, debug: true, patchConsole: false, exitOnCtrlC: false });
await controller.start();
controller.store.flush();
await new Promise((resolve) => setTimeout(resolve, 100));
ink.unmount();
await controller.stop();
if (!output.includes("tau · /help for commands") || !output.includes("╭")) throw new Error(\`unexpected TUI output: \${output}\`);
console.log("pack smoke tui ok");
`;

const CONSUMER_TS = `
import { Agent, type AgentEvent, type Platform, type Tool } from "@yophon/tau-kernel";

const platform: Platform = {
	fetch: async () => ({ ok: true, status: 200, text: async () => "", body: null }),
	createUtf8Decoder: () => ({ decode: () => "", flush: () => "" }),
	randomBytes: (n: number) => new Uint8Array(n),
};
const tool: Tool = {
	name: "t",
	description: "d",
	parameters: { type: "object" },
	execute: async () => ({ content: [{ type: "text" as const, text: "" }] }),
};
const agent = new Agent({ config: { baseUrl: "https://x/v1", model: "m" }, platform, tools: [tool] });
const _events: AsyncGenerator<AgentEvent> = agent.prompt("hi");
void _events;
`;

try {
	const tarball = await withPublishManifest(kernelDir, "kernel", async () => {
		run("npm", ["pack", "--ignore-scripts", "--pack-destination", workDir], { cwd: kernelDir });
		const name = readdirSync(workDir).find((file) => file.endsWith(".tgz"));
		if (!name) throw new Error("npm pack produced no tarball");
		return join(workDir, name);
	});

	const consumerDir = join(workDir, "consumer");
	mkdirSync(consumerDir);
	writeFileSync(join(consumerDir, "package.json"), JSON.stringify({ name: "consumer", type: "module" }, null, "\t"));
	run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", tarball], { cwd: consumerDir });

	writeFileSync(join(consumerDir, "main.mjs"), CONSUMER_MJS);
	const runtime = run("node", ["main.mjs"], { cwd: consumerDir });
	if (!runtime.stdout.includes("pack smoke runtime ok")) throw new Error(`runtime smoke failed:\n${runtime.stdout}`);

	writeFileSync(join(consumerDir, "consumer.ts"), CONSUMER_TS);
	run("npx", [
		"tsc",
		"--noEmit",
		"--strict",
		"--target",
		"es2023",
		"--module",
		"preserve",
		"--moduleResolution",
		"bundler",
		join(consumerDir, "consumer.ts"),
	]);

	// P24e: codemode from packed tarballs (kernel + ext-tool-search + ext-codemode).
	const tarballs = [tarball];
	for (const [dir, name] of [
		["ext-tool-search", "ext-tool-search"],
		["ext-codemode", "ext-codemode"],
	]) {
		const before = new Set(readdirSync(workDir));
		await withPublishManifest(packageDir(dir), name, async () => {
			run("npm", ["pack", "--ignore-scripts", "--pack-destination", workDir], { cwd: packageDir(dir) });
		});
		const created = readdirSync(workDir).find((file) => file.endsWith(".tgz") && !before.has(file));
		if (!created) throw new Error(`npm pack produced no tarball for ${dir}`);
		tarballs.push(join(workDir, created));
	}
	const codemodeDir = join(workDir, "codemode-consumer");
	mkdirSync(codemodeDir);
	writeFileSync(
		join(codemodeDir, "package.json"),
		JSON.stringify({ name: "codemode-consumer", type: "module" }, null, "\t"),
	);
	run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", ...tarballs], { cwd: codemodeDir });
	writeFileSync(join(codemodeDir, "main.mjs"), CODEMODE_MJS);
	const codemode = run("node", ["main.mjs"], { cwd: codemodeDir });
	if (!codemode.stdout.includes("pack smoke codemode ok"))
		throw new Error(`codemode smoke failed:\n${codemode.stdout}`);

	// P25: the TUI's modules load and render from an installed layout.
	const cliPkg = JSON.parse(readFileSync(join(packageDir("cli"), "package.json"), "utf8"));
	const tuiDir = join(workDir, "tui-consumer");
	mkdirSync(tuiDir);
	writeFileSync(join(tuiDir, "package.json"), JSON.stringify({ name: "tui-consumer", type: "module" }, null, "\t"));
	const pinned = ["ink", "react", "string-width", "highlight.js"].map((name) => `${name}@${cliPkg.dependencies[name]}`);
	const protocolBefore = new Set(readdirSync(workDir));
	await withPublishManifest(packageDir("protocol"), "protocol", async () => {
		run("npm", ["pack", "--ignore-scripts", "--pack-destination", workDir], { cwd: packageDir("protocol") });
	});
	const protocolTarball = readdirSync(workDir).find((file) => file.endsWith(".tgz") && !protocolBefore.has(file));
	if (!protocolTarball) throw new Error("npm pack produced no tarball for protocol");
	run(
		"npm",
		["install", "--ignore-scripts", "--no-audit", "--no-fund", tarball, join(workDir, protocolTarball), ...pinned],
		{ cwd: tuiDir },
	);
	cpSync(join(packageDir("cli"), "dist", "tui"), join(tuiDir, "tui"), { recursive: true });
	// The TUI also loads the CLI modules it shares with the REPL (P34f: session titles).
	// P37: handoff, the uncommitted-changes check, git paths and the status line JSON; P39: /diff; P44: opening links;
	// P46: presence for push_notification.
	for (const shared of [
		"session-title.js",
		"handoff.js",
		"dirty-repo.js",
		"git-paths.js",
		"statusline-input.js",
		"git-diff.js",
		"open-url.js",
		"push-notification.js",
	]) {
		cpSync(join(packageDir("cli"), "dist", shared), join(tuiDir, shared));
	}
	writeFileSync(join(tuiDir, "main.mjs"), TUI_MJS);
	const tui = run("node", ["main.mjs"], { cwd: tuiDir });
	if (!tui.stdout.includes("pack smoke tui ok")) throw new Error(`tui smoke failed:\n${tui.stdout}`);

	// P36: host-node's image worker, photon wasm and background commands from an installed layout.
	const hostBefore = new Set(readdirSync(workDir));
	await withPublishManifest(packageDir("host-node"), "host-node", async () => {
		run("npm", ["pack", "--ignore-scripts", "--pack-destination", workDir], { cwd: packageDir("host-node") });
	});
	const hostTarball = readdirSync(workDir).find((file) => file.endsWith(".tgz") && !hostBefore.has(file));
	if (!hostTarball) throw new Error("npm pack produced no tarball for host-node");
	const hostDir = join(workDir, "host-node-consumer");
	mkdirSync(hostDir);
	writeFileSync(
		join(hostDir, "package.json"),
		JSON.stringify({ name: "host-node-consumer", type: "module" }, null, "\t"),
	);
	run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", tarball, join(workDir, hostTarball)], {
		cwd: hostDir,
	});
	cpSync(fileURLToPath(new URL("./smoke-pack-host-node.mjs", import.meta.url)), join(hostDir, "main.mjs"));
	const host = run("node", ["main.mjs"], { cwd: hostDir });
	if (!host.stdout.includes("pack smoke host-node ok")) throw new Error(`host-node smoke failed:\n${host.stdout}`);

	// P30: a channel plugin installed under a gateway directory loads through the packed gateway.
	const gatewayTarballs = [tarball];
	for (const [dir, name] of [
		["ext-feishu", "ext-feishu"],
		["gateway", "gateway"],
		["channel-feishu", "channel-feishu"],
	]) {
		const before = new Set(readdirSync(workDir));
		await withPublishManifest(packageDir(dir), name, async () => {
			run("npm", ["pack", "--ignore-scripts", "--pack-destination", workDir], { cwd: packageDir(dir) });
		});
		const created = readdirSync(workDir).find((file) => file.endsWith(".tgz") && !before.has(file));
		if (!created) throw new Error(`npm pack produced no tarball for ${dir}`);
		gatewayTarballs.push(join(workDir, created));
	}
	const gatewayHome = join(workDir, "gateway-home");
	mkdirSync(gatewayHome);
	run("npm", ["install", "--prefix", gatewayHome, "--ignore-scripts", "--no-audit", "--no-fund", ...gatewayTarballs], {
		cwd: workDir,
	});
	writeFileSync(
		join(gatewayHome, "load.mjs"),
		`import { loadChannelPlugin } from "@yophon/tau-gateway";
const plugin = await loadChannelPlugin("@yophon/tau-channel-feishu", process.cwd());
if (plugin.name !== "feishu" || typeof plugin.create !== "function") throw new Error("unexpected plugin");
console.log("pack smoke gateway plugin ok");
`,
	);
	const plugin = run("node", ["load.mjs"], { cwd: gatewayHome });
	if (!plugin.stdout.includes("pack smoke gateway plugin ok"))
		throw new Error(`plugin smoke failed:
${plugin.stdout}`);
	const shrinkwrap = readFileSync(join(packageDir("cli"), "npm-shrinkwrap.json"), "utf8");
	if (shrinkwrap.includes("@larksuiteoapi")) throw new Error("the CLI's shrinkwrap pulls in the Feishu SDK");

	console.log(
		"pack smoke passed: tarball installs, runs, and typechecks for a bare consumer; codemode runs from packed tarballs; the TUI renders from an installed layout; host-node resizes images and runs background commands from its tarball; a channel plugin installs under a gateway directory and loads",
	);
} finally {
	rmSync(workDir, { recursive: true, force: true });
}
