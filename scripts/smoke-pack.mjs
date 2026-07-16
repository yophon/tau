// Pack smoke: prove the published artifact works for a real consumer. Packs
// @yophon/tau-kernel (zero deps → offline-safe), installs the tarball into a
// bare temp project, then (1) runs a two-turn scripted agent loop through the
// built JS and (2) typechecks a consumer TS file against the shipped d.ts.
// The full cli path needs the registry (pi-tui) and is exercised after real
// publishes instead.
import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withPublishManifest } from "./release-lib.mjs";

const root = new URL("..", import.meta.url).pathname;
const kernelDir = join(root, "packages/kernel");
const workDir = join(tmpdir(), `tau-pack-smoke-${Date.now()}`);
mkdirSync(workDir, { recursive: true });

function run(command, args, options = {}) {
	const result = spawnSync(command, args, { cwd: options.cwd, encoding: "utf8", stdio: ["inherit", "pipe", "pipe"] });
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
		execute: async (args) => { echoed = args.text; return { output: String(args.text) }; },
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
	execute: async () => ({ output: "" }),
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

	console.log("pack smoke passed: tarball installs, runs, and typechecks for a bare consumer");
} finally {
	rmSync(workDir, { recursive: true, force: true });
}
