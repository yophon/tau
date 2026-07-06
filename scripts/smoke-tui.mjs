#!/usr/bin/env node
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const cliPath = join(repoRoot, "packages", "cli", "src", "main.ts");
const resourcesUrl = pathToFileURL(join(repoRoot, "packages", "ext-resources", "src", "index.ts")).href;

async function main() {
	await requireTmux();
	const root = await realpath(await mkdtemp(join(tmpdir(), "tau-tui-smoke-")));
	const mock = await startMockOpenAI();
	try {
		await runStartupConfirmSmoke(root, mock.baseUrl);
		await runPromptToolAbortSmoke(root, mock.baseUrl);
		await runExtensionAndReloadSmoke(root, mock.baseUrl);
		await runSelectorSmoke(root, mock.baseUrl);
		console.log("TUI smoke passed");
	} finally {
		await mock.close();
		await rm(root, { recursive: true, force: true });
	}
}

async function runStartupConfirmSmoke(root, baseUrl) {
	const dirs = await createSandbox(root, "startup-confirm", false);
	await writeSmokeExtension(dirs.cwd);
	const session = await startTui("startup-confirm", dirs, baseUrl, ["--no-session"]);
	try {
		await session.waitFor("Trust this directory", 10_000);
		await session.send("y", "Enter");
		await session.waitFor("SMOKE_HEADER", 10_000);
		await session.waitFor("Loaded diagnostics", 10_000);
		await session.send("exit", "Enter");
		await session.waitForExit();
		console.log("ok startup confirm");
	} finally {
		await session.kill();
	}
}

async function runPromptToolAbortSmoke(root, baseUrl) {
	const dirs = await createSandbox(root, "prompt-tool-abort", true);
	await writeSmokeExtension(dirs.cwd);
	const session = await startTui("prompt-tool-abort", dirs, baseUrl, ["--no-session"]);
	try {
		await session.waitFor("SMOKE_WIDGET", 10_000);

		await session.send("stream smoke", "Enter");
		await session.waitFor("SMOKE_STREAM_OK", 10_000);

		await session.send("bash smoke", "Enter");
		await session.waitFor("BASH_SMOKE_LINE_1", 10_000);
		await session.waitFor("SMOKE_BASH_DONE", 15_000);

		await session.send("custom smoke tool", "Enter");
		await session.waitFor("SMOKE_TOOL_RENDER_result", 15_000);
		await session.waitFor("SMOKE_CUSTOM_TOOL_DONE", 15_000);

		await session.send("hang smoke", "Enter");
		await session.waitFor("SMOKE_ABORT_STREAM", 10_000);
		await session.send("C-c");
		await session.waitFor("Turn aborted.", 10_000);

		await session.send("exit", "Enter");
		await session.waitForExit();
		console.log("ok prompt tool abort");
	} finally {
		await session.kill();
	}
}

async function runExtensionAndReloadSmoke(root, baseUrl) {
	const dirs = await createSandbox(root, "extension-reload", true);
	await writeSmokeExtension(dirs.cwd);
	const session = await startTui("extension-reload", dirs, baseUrl, ["--no-session"]);
	try {
		await session.waitFor("SMOKE_FOOTER", 10_000);
		await session.send("C-g");
		await session.waitFor("SMOKE_SHORTCUT_OK", 10_000);

		await session.send("/smoke-ui", "Enter");
		await session.waitFor("SMOKE_UI_CONFIRM", 10_000);
		await session.send("y", "Enter");
		await session.waitFor("SMOKE_UI_CONFIRMED", 10_000);

		await mkdir(join(dirs.cwd, ".tau", "reload-prompts"), { recursive: true });
		await writeFile(
			join(dirs.cwd, ".tau", "reload-prompts", "reload-smoke.md"),
			"---\ndescription: Reload smoke\n---\nSMOKE_RELOAD_PROMPT $ARGUMENTS\n",
			"utf8",
		);
		await session.send("/reload", "Enter");
		await session.waitFor("Extensions reloaded.", 15_000);
		await session.send("/reload-smoke after", "Enter");
		await session.waitFor("SMOKE_RELOAD_RESPONSE", 15_000);

		await session.send("exit", "Enter");
		await session.waitForExit();
		console.log("ok extension reload");
	} finally {
		await session.kill();
	}
}

async function runSelectorSmoke(root, baseUrl) {
	const dirs = await createSandbox(root, "selector", true);
	await writeSmokeExtension(dirs.cwd);
	const session = await startTui("selector", dirs, baseUrl, []);
	try {
		await session.waitFor("Loaded diagnostics", 10_000);
		await session.send("selector first", "Enter");
		await session.waitFor("SMOKE_SELECTOR_FIRST", 10_000);
		await session.send("/smoke-render", "Enter");
		await session.waitFor("SMOKE_MESSAGE_RENDERED", 10_000);
		await session.send("/tree", "Enter");
		await session.waitFor("SMOKE_ENTRY_RENDERED", 10_000);
		await session.send("Escape");
		await session.waitFor("Navigation cancelled.", 10_000);
		await session.send("/fork", "Enter");
		await session.waitFor("Fork from", 10_000);
		await session.send("Enter");
		await session.waitFor("Forked to", 10_000);
		await session.send("exit", "Enter");
		await session.waitForExit();
		console.log("ok selector");
	} finally {
		await session.kill();
	}
}

async function createSandbox(root, name, trusted) {
	const projectPath = join(root, name, "project");
	const home = join(root, name, "home");
	await mkdir(projectPath, { recursive: true });
	await mkdir(home, { recursive: true });
	const cwd = await realpath(projectPath);
	if (trusted) await writeTrust(home, cwd, true);
	return { cwd, home };
}

async function writeTrust(home, cwd, trusted) {
	await mkdir(join(home, ".tau"), { recursive: true });
	await writeFile(join(home, ".tau", "trust.json"), `${JSON.stringify({ trusted: { [cwd]: trusted } })}\n`, "utf8");
}

async function writeSmokeExtension(cwd) {
	const extensionDir = join(cwd, ".tau", "extensions");
	await mkdir(extensionDir, { recursive: true });
	await writeFile(
		join(extensionDir, "smoke.mjs"),
		`
import resources from ${JSON.stringify(resourcesUrl)};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export default async function smoke(api) {
	await resources(api);
	api.registerCommand("smoke-ui", {
		description: "Exercise TUI UI capability.",
		handler: async (_args, ctx) => {
			const confirmed = await ctx.ui?.confirm("SMOKE_UI_CONFIRM", "confirm smoke UI");
			return confirmed ? "SMOKE_UI_CONFIRMED" : "SMOKE_UI_CANCELLED";
		},
	});
	api.registerCommand("smoke-render", {
		description: "Exercise custom message and entry renderers.",
		handler: () => {
			api.sendMessage({ customType: "smoke_custom", content: "custom payload", display: true });
			api.appendEntry("smoke_entry", { ok: true });
			return "SMOKE_RENDER_COMMAND_OK";
		},
	});
	api.registerShortcut("smoke-shortcut", {
		key: "ctrl+g",
		description: "Exercise extension shortcut dispatch.",
		handler: () => "SMOKE_SHORTCUT_OK",
	});
	api.registerHeaderItem("smoke-header", { handler: () => "SMOKE_HEADER" });
	api.registerFooterItem("smoke-footer", { handler: () => "SMOKE_FOOTER" });
	api.registerWidget("smoke-widget", { placement: "above-editor", handler: () => "SMOKE_WIDGET" });
	api.registerDiagnostic("smoke-diagnostic", { handler: () => ({ label: "smoke", value: "SMOKE_DIAGNOSTIC_OK" }) });
	api.registerMessageRenderer("smoke-message", {
		customTypes: ["smoke_custom"],
		handler: () => "SMOKE_MESSAGE_RENDERED",
	});
	api.registerEntryRenderer("smoke-entry", {
		customTypes: ["smoke_entry"],
		handler: () => ({ label: "SMOKE_ENTRY_RENDERED", description: "custom entry renderer" }),
	});
	api.registerTool({
		name: "smoke_tool",
		description: "Smoke test custom tool.",
		parameters: { type: "object", properties: {} },
		execute: async (_args, _signal, onUpdate) => {
			onUpdate?.("SMOKE_TOOL_UPDATE_1\\n", "stdout");
			await sleep(50);
			onUpdate?.("SMOKE_TOOL_UPDATE_2\\n", "stdout");
			return { output: "SMOKE_TOOL_OUTPUT" };
		},
	});
	api.registerToolRenderer("smoke-tool-renderer", {
		toolNames: ["smoke_tool"],
		handler: (event) => "SMOKE_TOOL_RENDER_" + event.phase,
	});
	api.on("resources_discover", (event, ctx) => {
		if (event.reason !== "reload") return undefined;
		const projectTauDir = ctx.capabilities?.paths?.projectTauDir;
		return projectTauDir ? { promptPaths: [projectTauDir + "/reload-prompts"] } : undefined;
	});
}
`,
		"utf8",
	);
}

async function startTui(label, dirs, baseUrl, args) {
	const name = `tau-smoke-${label}-${process.pid}-${Math.random().toString(16).slice(2)}`;
	const command = [
		"env",
		`HOME=${shellQuote(dirs.home)}`,
		`TAU_BASE_URL=${shellQuote(baseUrl)}`,
		"TAU_MODEL=mock-model",
		"TAU_API_KEY=test",
		shellQuote(process.execPath),
		"--disable-warning=ExperimentalWarning",
		shellQuote(cliPath),
		"--tui",
		...args.map(shellQuote),
	].join(" ");
	await tmux(["new-session", "-d", "-x", "120", "-y", "38", "-s", name, "-c", dirs.cwd, command]);
	return new TmuxSession(name);
}

class TmuxSession {
	constructor(name) {
		this.name = name;
	}

	async send(...keys) {
		await tmux(["send-keys", "-t", this.name, ...keys]);
	}

	async capture() {
		return await tmux(["capture-pane", "-t", this.name, "-p", "-J", "-S", "-"]);
	}

	async waitFor(needle, timeoutMs = 10_000) {
		const started = Date.now();
		let screen = "";
		while (Date.now() - started < timeoutMs) {
			screen = await this.capture();
			if (screen.includes(needle)) return;
			await sleep(100);
		}
		throw new Error(`Timed out waiting for ${JSON.stringify(needle)} in tmux ${this.name}:\n${screen}`);
	}

	async waitForExit(timeoutMs = 10_000) {
		const started = Date.now();
		while (Date.now() - started < timeoutMs) {
			try {
				await tmux(["has-session", "-t", this.name]);
			} catch {
				return;
			}
			await sleep(100);
		}
		throw new Error(`Timed out waiting for tmux ${this.name} to exit:\n${await this.capture()}`);
	}

	async kill() {
		try {
			await tmux(["kill-session", "-t", this.name]);
		} catch {
			// Already exited.
		}
	}
}

async function startMockOpenAI() {
	const requests = [];
	const server = createServer((req, res) => {
		let body = "";
		req.on("data", (chunk) => {
			body += chunk;
		});
		req.on("end", async () => {
			const parsed = JSON.parse(body);
			requests.push(parsed);
			const response = responseFor(parsed);
			res.writeHead(200, { "content-type": "text/event-stream" });
			for (const payload of response.payloads) {
				res.write(`data: ${JSON.stringify(payload)}\n\n`);
				if (response.chunkDelayMs) await sleep(response.chunkDelayMs);
			}
			if (!response.hold) res.end("data: [DONE]\n\n");
		});
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Mock server did not bind a TCP port");
	return {
		baseUrl: `http://127.0.0.1:${address.port}/v1`,
		requests,
		close: () =>
			new Promise((resolve) => {
				server.closeAllConnections();
				server.close(() => resolve());
			}),
	};
}

function responseFor(request) {
	const messages = Array.isArray(request.messages) ? request.messages : [];
	const lastMessage = messages.at(-1);
	if (lastMessage?.role === "tool") {
		const content = String(lastMessage.content ?? "");
		if (content.includes("BASH_SMOKE_LINE_3")) return textTurn("SMOKE_BASH_DONE");
		if (content.includes("SMOKE_TOOL_OUTPUT")) return textTurn("SMOKE_CUSTOM_TOOL_DONE");
	}
	const lastUser = messages.findLast((message) => message.role === "user");
	const content = String(lastUser?.content ?? "");
	if (content.includes("stream smoke")) return textTurn("SMOKE_STREAM_OK", 40);
	if (content.includes("bash smoke")) {
		return toolCallTurn("bash", {
			command:
				"node -e 'let i=0; const timer=setInterval(() => { i++; console.log(\"BASH_SMOKE_LINE_\" + i); if (i === 3) clearInterval(timer); }, 120)'",
		});
	}
	if (content.includes("custom smoke tool")) return toolCallTurn("smoke_tool", {});
	if (content.includes("hang smoke")) {
		return { payloads: [{ choices: [{ delta: { content: "SMOKE_ABORT_STREAM " } }] }], hold: true };
	}
	if (content.includes("selector first")) return textTurn("SMOKE_SELECTOR_FIRST");
	if (content.includes("SMOKE_RELOAD_PROMPT")) return textTurn("SMOKE_RELOAD_RESPONSE");
	return textTurn("SMOKE_DEFAULT_RESPONSE");
}

function textTurn(text, chunkDelayMs = 0) {
	return { payloads: [{ choices: [{ delta: { content: text }, finish_reason: "stop" }] }], chunkDelayMs };
}

function toolCallTurn(name, args) {
	return {
		payloads: [
			{
				choices: [
					{
						delta: {
							tool_calls: [{ index: 0, id: `call_${name}`, function: { name, arguments: JSON.stringify(args) } }],
						},
						finish_reason: "tool_calls",
					},
				],
			},
		],
	};
}

async function requireTmux() {
	try {
		await execFileP("tmux", ["-V"]);
	} catch (error) {
		throw new Error(`tmux is required for TUI smoke tests: ${error.message}`);
	}
}

async function tmux(args) {
	return await execFileP("tmux", args);
}

function execFileP(command, args) {
	return new Promise((resolve, reject) => {
		execFile(command, args, { maxBuffer: 1024 * 1024 * 10 }, (error, stdout, stderr) => {
			if (error) {
				error.message = `${error.message}\n${stderr}`;
				reject(error);
				return;
			}
			resolve(stdout);
		});
	});
}

function shellQuote(value) {
	return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((error) => {
	console.error(error instanceof Error ? error.stack || error.message : String(error));
	process.exitCode = 1;
});
