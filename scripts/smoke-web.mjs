#!/usr/bin/env node
// Web client smoke (P59): the real resident server (mock model, throwaway HOME, remote access on a free
// port) and the built web client in a headless Chromium at phone size, driven over the DevTools
// protocol. Pairs from the QR link, opens the session a local client runs, sends a prompt, answers
// the write's approval card, then `tau serve restart` and checks that the page reconnects and
// shows the conversation again. Screenshots go to SMOKE_WEB_SHOTS when set.
//
//   BROWSER_BIN=/path/to/chrome node scripts/smoke-web.mjs
import { execFile, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { buildWeb } from "./build-web.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const cliPath = join(root, "packages", "cli", "src", "main.ts");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const browser = [
	process.env.BROWSER_BIN,
	"C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
	"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
	"/usr/bin/google-chrome",
	"/usr/bin/chromium",
	"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
].find((candidate) => candidate && existsSync(candidate));
if (!browser) throw new Error("No Chromium-compatible browser found. Set BROWSER_BIN to run the web smoke.");

// ── a mock model: replies by the last user message ─────────────────────────────
function turnFor(request) {
	const messages = request.messages ?? [];
	const last = messages.at(-1);
	const lastUser = [...messages].reverse().find((message) => message.role === "user");
	const content = typeof lastUser?.content === "string" ? lastUser.content : JSON.stringify(lastUser?.content ?? "");
	const text = (value) => [{ choices: [{ delta: { content: value }, finish_reason: "stop" }] }];
	if (last?.role === "tool") return text("WEB_WRITE_DONE");
	if (content.includes("web write")) {
		return [
			{
				choices: [
					{
						delta: {
							tool_calls: [
								{
									index: 0,
									id: "call_w",
									function: {
										name: "write",
										arguments: JSON.stringify({ path: "web.txt", content: "FROM THE WEB\n" }),
									},
								},
							],
						},
						finish_reason: "tool_calls",
					},
				],
			},
		];
	}
	if (content.includes("web hello")) return text("WEB_HELLO_OK — **bold** and `code`.");
	return text("WEB_DEFAULT");
}
const mock = createServer((req, res) => {
	let body = "";
	req.on("data", (chunk) => {
		body += chunk;
	});
	req.on("end", () => {
		res.writeHead(200, { "content-type": "text/event-stream" });
		for (const payload of turnFor(JSON.parse(body))) res.write(`data: ${JSON.stringify(payload)}\n\n`);
		res.end("data: [DONE]\n\n");
	});
});
await new Promise((resolve) => mock.listen(0, "127.0.0.1", resolve));

// ── the resident server ────────────────────────────────────────────────────────
const temp = mkdtempSync(join(tmpdir(), "tau-web-smoke-"));
const home = join(temp, "home");
const cwd = join(temp, "project");
mkdirSync(join(home, ".tau"), { recursive: true });
mkdirSync(cwd);
// A fixed port (as 7700 is in real use): the page must find the server again after a restart.
const remotePort = await new Promise((resolve) => {
	const probe = createServer();
	probe.listen(0, "127.0.0.1", () => {
		const { port } = probe.address();
		probe.close(() => resolve(port));
	});
});
writeFileSync(
	join(home, ".tau", "settings.json"),
	JSON.stringify({ daemon: { remote: { listen: `ws://127.0.0.1:${remotePort}` } } }),
);
writeFileSync(join(home, ".tau", "trust.json"), JSON.stringify({ trusted: { [cwd]: true } }));
const env = {
	...process.env,
	HOME: home,
	TAU_BASE_URL: `http://127.0.0.1:${mock.address().port}/v1`,
	TAU_API_KEY: "test",
	TAU_MODEL: "mock-model",
	TAU_PERMISSION_MODE: "supervised",
	TAU_AUTO_TITLE: "0",
	TAU_MAX_RETRIES: "0",
};
delete env.TAU_PROVIDER;
for (const name of ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"]) delete env[name];
const tau = (...args) =>
	new Promise((resolve, reject) =>
		execFile(
			process.execPath,
			["--disable-warning=ExperimentalWarning", cliPath, ...args],
			{ env, cwd },
			(error, stdout, stderr) =>
				error
					? reject(new Error(`tau ${args.join(" ")}: ${stderr || error.message}`))
					: resolve(stdout.trim().split("\n").at(-1)),
		),
	);

let chrome;
const shots = process.env.SMOKE_WEB_SHOTS;
try {
	await buildWeb();
	await tau("serve", "start");
	const status = JSON.parse(await tau("serve", "status"));
	if (!status.remote) throw new Error(`no remote listener: ${JSON.stringify(status)}`);
	const base = status.remote.listen.replace("ws://", "http://");
	const pairing = JSON.parse(await tau("serve", "pair", "--name", "smoke", "--json"));
	if (!pairing.urls[0]?.startsWith(`${base}/#pair=`)) throw new Error(`unexpected pairing link: ${pairing.urls[0]}`);

	// A session the "terminal" runs (a local client over the socket).
	const { defaultAddress, probeDaemon } = await import("../packages/cli/src/daemon.ts");
	const local = await probeDaemon(defaultAddress(home), { name: "smoke-terminal" });
	if (local.state !== "running") throw new Error("local client could not connect");
	const { thread } = await local.client.startThread({ cwd });
	let localDone = false;
	local.client.on("turn/completed", () => {
		localDone = true;
	});
	await local.client.startTurn(thread.id, "web hello from the terminal");
	for (let i = 0; i < 100 && !localDone; i++) await sleep(50);
	if (!localDone) throw new Error("the terminal's turn did not finish");

	// ── the browser ──────────────────────────────────────────────────────────────
	const profile = join(temp, "profile");
	chrome = spawn(browser, [
		"--headless=new",
		"--disable-gpu",
		"--no-first-run",
		"--no-default-browser-check",
		"--remote-debugging-port=0",
		`--user-data-dir=${profile}`,
		"about:blank",
	]);
	let port;
	for (let i = 0; i < 200 && !port; i++) {
		await sleep(50);
		const file = join(profile, "DevToolsActivePort");
		if (existsSync(file)) port = readFileSync(file, "utf8").split("\n")[0]?.trim();
	}
	if (!port) throw new Error("the browser did not open its DevTools port");
	const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
	const page = targets.find((target) => target.type === "page");
	const cdp = new WebSocket(page.webSocketDebuggerUrl);
	await new Promise((resolve, reject) => {
		cdp.once("open", resolve);
		cdp.once("error", reject);
	});
	let nextId = 0;
	const waiting = new Map();
	cdp.on("message", (data) => {
		const message = JSON.parse(String(data));
		if (message.id && waiting.has(message.id)) {
			waiting.get(message.id)(message);
			waiting.delete(message.id);
		}
	});
	const send = (method, params = {}) =>
		new Promise((resolve, reject) => {
			const id = ++nextId;
			waiting.set(id, (message) =>
				message.error ? reject(new Error(message.error.message)) : resolve(message.result),
			);
			cdp.send(JSON.stringify({ id, method, params }));
		});
	const evaluate = async (expression) =>
		(await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true })).result.value;
	const waitFor = async (expression, what, ms = 15_000) => {
		const deadline = Date.now() + ms;
		for (;;) {
			if (await evaluate(expression).catch(() => false)) return;
			if (Date.now() > deadline) {
				const text = await evaluate("document.body.innerText").catch(() => "(no page)");
				throw new Error(`Timed out waiting for ${what}. Page:\n${text}`);
			}
			await sleep(100);
		}
	};
	const bodyHas = (text) => `document.body.textContent.includes(${JSON.stringify(text)})`;
	const click = (selector, text) =>
		evaluate(
			`(() => { const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find((e) => e.innerText.includes(${JSON.stringify(text)})); if (!el) return false; el.click(); return true; })()`,
		);
	const shot = async (name) => {
		if (!shots) return;
		mkdirSync(shots, { recursive: true });
		const { data } = await send("Page.captureScreenshot", { format: "png" });
		writeFileSync(join(shots, `${name}.png`), Buffer.from(data, "base64"));
	};
	await send("Page.enable");
	await send("Runtime.enable");
	await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });

	// Pair from the QR link; the session list shows the terminal's session.
	await send("Page.navigate", { url: pairing.urls[0] });
	await waitFor(bodyHas("Running now"), "the session list");
	await waitFor(bodyHas("web hello from the terminal"), "the terminal's session in the list");
	await shot("1-sessions");
	if (!(await click("button.session", "web hello from the terminal"))) throw new Error("no session row to open");
	await waitFor(bodyHas("WEB_HELLO_OK"), "the conversation");
	if (!(await evaluate(`!!document.querySelector(".agent strong") && !!document.querySelector(".agent code")`))) {
		throw new Error("the reply's markdown was not drawn");
	}

	// A prompt from the phone; its write waits for the approval card.
	await evaluate(
		`(() => { const box = document.querySelector(".composer textarea"); const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set; set.call(box, "web write a file"); box.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`,
	);
	await click("button.send", "↑");
	await waitFor(`!!document.querySelector(".card.approval")`, "the approval card");
	await shot("2-approval");
	await click(".card.approval button", "Allow once");
	await waitFor(bodyHas("WEB_WRITE_DONE"), "the reply after the write");
	if (readFileSync(join(cwd, "web.txt"), "utf8") !== "FROM THE WEB\n") throw new Error("web.txt was not written");
	if (await evaluate(`!!document.querySelector(".card.approval")`)) throw new Error("the approval card stayed");
	await shot("3-conversation");

	// The server restarts: the page reconnects and draws the conversation again.
	local.client.close();
	await tau("serve", "restart");
	await waitFor(bodyHas("reconnecting"), "the reconnect banner", 10_000).catch(() => undefined);
	await waitFor(`!document.querySelector(".banner")`, "the reconnect", 30_000);
	await waitFor(bodyHas("WEB_WRITE_DONE"), "the conversation after the reconnect");
	await shot("4-reconnected");
	cdp.close();
	console.log(
		"web smoke passed: paired from the link, joined the terminal's session, approved a write, came back after a restart",
	);
} finally {
	chrome?.kill();
	await tau("serve", "stop").catch(() => undefined);
	await new Promise((resolve) => mock.close(resolve));
	await sleep(500);
	rmSync(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
