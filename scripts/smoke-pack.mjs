// Pack smoke: prove the published artifact works for a real consumer. Packs
// @yophon/tau-kernel, installs the tarball into a bare temp project, then (1)
// runs a two-turn scripted agent loop through the built JS and (2) typechecks a
// consumer TS file against the shipped d.ts. (3) P24e: packs ext-tool-search and
// ext-codemode too and runs a codemode script from the installed layout, so the
// pi-codemode worker and wasm resolve as they will after `npm i` (needs the
// registry for @earendil-works/pi-codemode).
// The full cli path needs the registry (pi-tui) and is exercised after real
// publishes instead.
import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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

	console.log(
		"pack smoke passed: tarball installs, runs, and typechecks for a bare consumer; codemode runs from packed tarballs",
	);
} finally {
	rmSync(workDir, { recursive: true, force: true });
}
