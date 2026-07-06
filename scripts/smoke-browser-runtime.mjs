import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";

const browserCandidates = [
	process.env.BROWSER_BIN,
	"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
	"/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
	"/Applications/Chromium.app/Contents/MacOS/Chromium",
].filter((candidate) => candidate !== undefined);

async function firstExisting(paths) {
	for (const path of paths) {
		try {
			await readFile(path);
			return path;
		} catch {
			// Try the next candidate.
		}
	}
	return undefined;
}

const browser = await firstExisting(browserCandidates);
if (!browser) {
	throw new Error("No Chromium-compatible browser found. Set BROWSER_BIN to run the browser runtime smoke.");
}

const temp = await mkdtemp(join(tmpdir(), "tau-browser-runtime-"));
const entry = join(temp, "entry.ts");
const bundle = join(temp, "app.js");
const userDataDir = join(temp, "profile");
let server;

try {
	await writeFile(
		entry,
		`
import { Agent, createCodingTools, messageText } from "@tau/kernel";
import { OpfsFileSystem } from "@tau/host-browser";

function makeSseResponse(payloads) {
	const encoder = new TextEncoder();
	const chunks = [...payloads.map((payload) => \`data: \${JSON.stringify(payload)}\\n\\n\`), "data: [DONE]\\n\\n"].map(
		(text) => encoder.encode(text),
	);
	return {
		ok: true,
		status: 200,
		text: async () => "",
		body: new ReadableStream({
			start(controller) {
				for (const chunk of chunks) controller.enqueue(chunk);
				controller.close();
			},
		}),
	};
}

function toolCallTurn(name, args) {
	return [{
		choices: [{
			delta: { tool_calls: [{ index: 0, id: "call_1", function: { name, arguments: JSON.stringify(args) } }] },
			finish_reason: "tool_calls",
		}],
	}];
}

function textTurn(text) {
	return [{ choices: [{ delta: { content: text }, finish_reason: "stop" }] }];
}

const responses = [
	makeSseResponse(toolCallTurn("write", { path: "runtime.txt", content: "opfs browser runtime" })),
	makeSseResponse(toolCallTurn("read", { path: "runtime.txt" })),
	makeSseResponse(textTurn("runtime done")),
];
let call = 0;
const platform = {
	fetch: async () => responses[call++],
	createUtf8Decoder: () => {
		const decoder = new TextDecoder("utf-8");
		return {
			decode: (chunk) => decoder.decode(chunk, { stream: true }),
			flush: () => decoder.decode(),
		};
	},
	randomBytes: (length) => {
		const bytes = new Uint8Array(length);
		crypto.getRandomValues(bytes);
		return bytes;
	},
};

async function main() {
async function report(text) {
	document.body.textContent = text;
	await fetch("/result", { method: "POST", body: text });
}

try {
	const fs = new OpfsFileSystem({ cwd: "/tau-browser-runtime-smoke" });
	const tools = createCodingTools({ fs });
	if (tools.map((tool) => tool.name).join(",") !== "read,write,edit") {
		throw new Error("unexpected tools: " + tools.map((tool) => tool.name).join(","));
	}
	const agent = new Agent({
		config: { baseUrl: "https://browser-smoke.invalid/v1", model: "browser-smoke" },
		platform,
		tools,
		maxTurnsPerPrompt: 5,
	});
	for await (const _event of agent.prompt("write and read a file in OPFS")) {
		// drain
	}
	const file = await fs.readTextFile("runtime.txt");
	const toolResults = agent.messages.filter((message) => message.role === "toolResult").map(messageText);
	if (file !== "opfs browser runtime") throw new Error("file mismatch: " + file);
	if (toolResults[1] !== "1\\topfs browser runtime") throw new Error("read result mismatch: " + toolResults[1]);
	if (messageText(agent.messages.at(-1)) !== "runtime done") throw new Error("assistant mismatch");
	await report("PASS tau browser runtime OPFS");
} catch (error) {
	await report("FAIL " + (error instanceof Error ? error.stack : String(error)));
}
}

void main();
`,
		"utf8",
	);

	await build({
		entryPoints: [entry],
		bundle: true,
		format: "iife",
		platform: "browser",
		target: "es2023",
		nodePaths: [join(process.cwd(), "node_modules")],
		outfile: bundle,
		logLevel: "silent",
	});

	let resolveResult;
	const resultPromise = new Promise((resolve) => {
		resolveResult = resolve;
	});
	const bundledScript = await readFile(bundle, "utf8");
	server = createServer((req, res) => {
		if (req.url === "/result") {
			let body = "";
			req.setEncoding("utf8");
			req.on("data", (chunk) => {
				body += chunk;
			});
			req.on("end", () => {
				res.writeHead(204);
				res.end();
				resolveResult(body);
			});
			return;
		}
		res.writeHead(200, { "content-type": "text/html" });
		res.end(`<!doctype html><meta charset="utf-8"><body>loading</body><script>${bundledScript}</script>`);
	});
	await new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address();
	if (address === null || typeof address === "string") throw new Error("Failed to bind browser smoke server");
	const url = `http://127.0.0.1:${address.port}/`;
	const result = await new Promise((resolve, reject) => {
		const child = spawn(browser, [
			"--headless",
			"--disable-gpu",
			"--no-first-run",
			`--user-data-dir=${userDataDir}`,
			url,
		]);
		let stderr = "";
		const timeout = setTimeout(() => {
			child.kill("SIGKILL");
			reject(new Error(`Browser smoke timed out. stderr:\\n${stderr}`));
		}, 20_000);
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
		});
		child.on("error", (error) => {
			clearTimeout(timeout);
			reject(error);
		});
		child.on("close", (code) => {
			if (code !== 0 && code !== null) {
				clearTimeout(timeout);
				reject(new Error(`Browser exited before reporting with ${code}. stderr:\\n${stderr}`));
			}
		});
		resultPromise.then((text) => {
			clearTimeout(timeout);
			child.kill("SIGTERM");
			child.once("close", () => resolve(text));
			setTimeout(() => {
				if (!child.killed) child.kill("SIGKILL");
				resolve(text);
			}, 2_000);
		});
	});
	if (!String(result).startsWith("PASS tau browser runtime OPFS")) {
		throw new Error(`Browser runtime smoke failed:\\n${result}`);
	}
	console.log("browser runtime smoke ok");
} finally {
	if (server) {
		await new Promise((resolve) => server.close(() => resolve()));
	}
	await rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
