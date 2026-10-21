// P40: the proxy-aware dispatcher (40a), the PowerShell tool and shell settings (40b),
// the settings layers (40c) and the rest of pi's extension surface (40d).
import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { mockTextTurn, mockToolCallTurn, startMockOpenAI } from "../../../test-fixtures/mock-openai.ts";

const CLI_PATH = fileURLToPath(new URL("../src/main.ts", import.meta.url));
const children: ChildProcess[] = [];
after(() => {
	for (const child of children) if (child.exitCode === null && !child.killed) child.kill("SIGKILL");
});

const PROXY_VARIABLES = ["HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy"];

/** Run `tau -p <prompt>` to its end; every proxy variable is cleared unless `env` sets it. */
function runPrint(
	prompt: string,
	options: { home: string; baseUrl: string; env?: Record<string, string> },
): Promise<{ code: number | null; output: string }> {
	const env: Record<string, string | undefined> = {
		...process.env,
		HOME: options.home,
		USERPROFILE: options.home,
		TAU_BASE_URL: options.baseUrl,
		TAU_MODEL: "mock-model",
		TAU_API_KEY: "test",
		TAU_PERMISSION_MODE: "autonomous",
		TAU_AUTO_TITLE: "0",
		TAU_MAX_RETRIES: "0",
	};
	for (const name of PROXY_VARIABLES) delete env[name];
	Object.assign(env, options.env);
	const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", CLI_PATH, "-p", prompt], {
		cwd: options.home,
		env,
		stdio: ["ignore", "pipe", "pipe"],
	});
	children.push(child);
	let output = "";
	child.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
		output += chunk;
	});
	child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
		output += chunk;
	});
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`tau -p did not exit. Output:\n${output}`)), 30_000);
		child.on("exit", (code) => {
			clearTimeout(timer);
			resolve({ code, output });
		});
	});
}

/** A CONNECT proxy that records the targets it tunnels to. */
async function startProxy(): Promise<{ url: string; targets: string[]; close(): Promise<void> }> {
	const targets: string[] = [];
	const server: Server = createServer((_req, res) => {
		res.writeHead(405).end();
	});
	server.on("connect", (req, socket, head) => {
		targets.push(req.url ?? "");
		const [host, port] = (req.url ?? "").split(":");
		const upstream = connect(Number(port), host, () => {
			socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
			upstream.write(head);
			upstream.pipe(socket);
			socket.pipe(upstream);
		});
		upstream.on("error", () => socket.destroy());
		socket.on("error", () => upstream.destroy());
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (address === null || typeof address === "string") throw new Error("no proxy address");
	return {
		url: `http://127.0.0.1:${address.port}`,
		targets,
		close: () =>
			new Promise((resolve) => {
				server.closeAllConnections();
				server.close(() => resolve());
			}),
	};
}

function tempHome(settings?: Record<string, unknown>): string {
	const home = mkdtempSync(join(tmpdir(), "tau-p40-"));
	if (settings) {
		mkdirSync(join(home, ".tau"), { recursive: true });
		writeFileSync(join(home, ".tau", "settings.json"), JSON.stringify(settings));
	}
	return home;
}

describe("P40a: proxy and HTTP idle timeout", () => {
	it("model requests go through HTTPS_PROXY / HTTP_PROXY", async () => {
		const mock = await startMockOpenAI([() => mockTextTurn("through the proxy")]);
		const proxy = await startProxy();
		try {
			const host = new URL(mock.baseUrl).host;
			const result = await runPrint("hi", {
				home: tempHome(),
				baseUrl: mock.baseUrl,
				env: { HTTP_PROXY: proxy.url, HTTPS_PROXY: proxy.url },
			});
			assert.equal(result.code, 0, result.output);
			assert.match(result.output, /through the proxy/);
			assert.ok(proxy.targets.includes(host), `proxy saw ${proxy.targets.join(", ")}`);
		} finally {
			await proxy.close();
			await mock.close();
		}
	});

	it("web_fetch goes through the same proxy", async () => {
		const page = createServer((_req, res) => {
			res.writeHead(200, { "content-type": "text/html" }).end("<html><body><p>proxied page</p></body></html>");
		});
		await new Promise<void>((resolve) => page.listen(0, "127.0.0.1", resolve));
		const address = page.address();
		if (address === null || typeof address === "string") throw new Error("no address");
		const pageHost = `127.0.0.1:${address.port}`;
		const mock = await startMockOpenAI([
			() => mockToolCallTurn("web_fetch", { url: `http://${pageHost}/` }),
			() => mockTextTurn("fetched"),
		]);
		const proxy = await startProxy();
		try {
			const result = await runPrint("fetch it", {
				home: tempHome(),
				baseUrl: mock.baseUrl,
				env: { HTTP_PROXY: proxy.url, HTTPS_PROXY: proxy.url },
			});
			assert.equal(result.code, 0, result.output);
			assert.ok(proxy.targets.includes(pageHost), `proxy saw ${proxy.targets.join(", ")}`);
			assert.match(JSON.stringify(mock.requests[1]), /proxied page/);
		} finally {
			await proxy.close();
			await mock.close();
			page.closeAllConnections();
			page.close();
		}
	});

	it("settings.json httpProxy stands in for the variables; NO_PROXY goes direct", async () => {
		const mock = await startMockOpenAI([() => mockTextTurn("ok")]);
		const proxy = await startProxy();
		try {
			const host = new URL(mock.baseUrl).host;
			const viaSettings = await runPrint("hi", { home: tempHome({ httpProxy: proxy.url }), baseUrl: mock.baseUrl });
			assert.equal(viaSettings.code, 0, viaSettings.output);
			assert.deepEqual(proxy.targets, [host]);
			const bypassed = await runPrint("hi", {
				home: tempHome({ httpProxy: proxy.url }),
				baseUrl: mock.baseUrl,
				env: { NO_PROXY: "127.0.0.1" },
			});
			assert.equal(bypassed.code, 0, bypassed.output);
			assert.deepEqual(proxy.targets, [host], "NO_PROXY: no second tunnel");
		} finally {
			await proxy.close();
			await mock.close();
		}
	});

	it("httpIdleTimeoutMs bounds the wait for response headers", async () => {
		const server = createServer((_req, res) => {
			setTimeout(() => res.writeHead(200).end(), 3_000);
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const address = server.address();
		if (address === null || typeof address === "string") throw new Error("no address");
		try {
			const started = Date.now();
			const result = await runPrint("hi", {
				home: tempHome({ httpIdleTimeoutMs: 300 }),
				baseUrl: `http://127.0.0.1:${address.port}/v1`,
			});
			assert.ok(Date.now() - started < 2_900, "gave up before the server answered");
			assert.match(result.output, /timeout/i);
		} finally {
			server.closeAllConnections();
			server.close();
		}
	});
});
