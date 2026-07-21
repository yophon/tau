// Computer-side MCP server for the tau Flutter demo. Deliberately zero tau
// dependency — the phone agent speaks plain MCP (Streamable HTTP), so this
// process is replaceable by any MCP server. Exposes coding tools over a
// work-directory boundary with bearer-token auth; also serves as the fixture
// for the repo's quickjs MCP e2e.
//
// ⚠ run_command executes arbitrary shell commands (inside the work directory)
// for any client holding the token. LAN + token is the only barrier — do not
// expose this beyond a trusted network.
import { execFile } from "node:child_process";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { networkInterfaces } from "node:os";
import { dirname, resolve, sep } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, isInitializeRequest, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { startQuickTunnel } from "./tunnel.mjs";

const MAX_OUTPUT_CHARS = 64_000;
const COMMAND_TIMEOUT_MS = 120_000;

function parseArgs(argv) {
	// Default host is loopback since P19 (breaking change from 0.0.0.0): the
	// remote story is a tunnel over 127.0.0.1; LAN exposure is an explicit
	// opt-in (--host 0.0.0.0) that the banner warns about.
	const options = { dir: process.cwd(), port: 8720, host: "127.0.0.1", token: process.env.MCP_TOKEN, tunnel: false };
	for (let i = 2; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--dir") options.dir = argv[++i];
		else if (arg === "--port") options.port = Number(argv[++i]);
		else if (arg === "--host") options.host = argv[++i];
		else if (arg === "--token") options.token = argv[++i];
		else if (arg === "--tunnel") options.tunnel = true;
		else {
			console.error(
				`Unknown argument: ${arg}\nUsage: node server.mjs [--dir <path>] [--port <n>] [--host <ip>] [--token <secret>] [--tunnel]`,
			);
			process.exit(1);
		}
	}
	if (options.tunnel && options.host !== "127.0.0.1") {
		// The tunnel is the exposure surface; a wider bind would silently add a second one.
		console.error(`--tunnel implies --host 127.0.0.1 (ignoring --host ${options.host})`);
		options.host = "127.0.0.1";
	}
	return options;
}

const options = parseArgs(process.argv);
const rootDir = resolve(options.dir);
const token = options.token ?? randomUUID();

function resolveInRoot(relativePath) {
	const absolute = resolve(rootDir, relativePath ?? ".");
	if (absolute !== rootDir && !absolute.startsWith(rootDir + sep)) {
		throw new Error(`Path escapes the work directory: ${relativePath}`);
	}
	return absolute;
}

function truncate(text) {
	if (text.length <= MAX_OUTPUT_CHARS) return text;
	return `${text.slice(0, MAX_OUTPUT_CHARS)}\n[truncated ${text.length - MAX_OUTPUT_CHARS} chars]`;
}

function textResult(text, isError = false) {
	return { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) };
}

const TOOLS = [
	{
		name: "read_file",
		description: "Read a UTF-8 text file inside the work directory.",
		inputSchema: {
			type: "object",
			properties: { path: { type: "string", description: "Path relative to the work directory" } },
			required: ["path"],
		},
	},
	{
		name: "write_file",
		description: "Write a UTF-8 text file inside the work directory (creating it if absent).",
		inputSchema: {
			type: "object",
			properties: { path: { type: "string" }, content: { type: "string" } },
			required: ["path", "content"],
		},
	},
	{
		name: "list_dir",
		description: "List a directory inside the work directory. Directories are suffixed with '/'.",
		inputSchema: {
			type: "object",
			properties: { path: { type: "string", description: "Defaults to the work directory root" } },
		},
	},
	{
		name: "run_command",
		description: "Run a shell command with the work directory as cwd. Returns stdout and stderr.",
		inputSchema: {
			type: "object",
			properties: { command: { type: "string" } },
			required: ["command"],
		},
	},
];

async function runCommand(command) {
	return new Promise((resolvePromise) => {
		execFile(
			"/bin/sh",
			["-c", command],
			{ cwd: rootDir, timeout: COMMAND_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 },
			(error, stdout, stderr) => {
				const parts = [];
				if (stdout) parts.push(stdout);
				if (stderr) parts.push(`[stderr]\n${stderr}`);
				if (error) parts.push(error.killed ? `[timed out after ${COMMAND_TIMEOUT_MS}ms]` : `[exit ${error.code ?? "signal"}]`);
				resolvePromise(textResult(truncate(parts.join("\n").trim() || "(no output)"), Boolean(error)));
			},
		);
	});
}

async function executeTool(name, args) {
	switch (name) {
		case "read_file":
			return textResult(truncate(await readFile(resolveInRoot(args.path), "utf8")));
		case "write_file": {
			const absolute = resolveInRoot(args.path);
			await writeFile(absolute, args.content, "utf8").catch(async (cause) => {
				if (cause.code !== "ENOENT") throw cause;
				const { mkdir } = await import("node:fs/promises");
				await mkdir(dirname(absolute), { recursive: true });
				await writeFile(absolute, args.content, "utf8");
			});
			return textResult(`Wrote ${args.content.length} chars to ${args.path}`);
		}
		case "list_dir": {
			const entries = await readdir(resolveInRoot(args.path), { withFileTypes: true });
			return textResult(entries.map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name)).join("\n") || "(empty)");
		}
		case "run_command":
			return runCommand(args.command);
		default:
			return textResult(`Unknown tool: ${name}`, true);
	}
}

function createMcpServer() {
	const server = new Server({ name: "tau-flutter-demo-computer", version: "0.0.1" }, { capabilities: { tools: {} } });
	server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
	server.setRequestHandler(CallToolRequestSchema, async (request) => {
		try {
			return await executeTool(request.params.name, request.params.arguments ?? {});
		} catch (cause) {
			return textResult(cause instanceof Error ? cause.message : String(cause), true);
		}
	});
	return server;
}

/** @type {Map<string, StreamableHTTPServerTransport>} */
const transports = new Map();

async function readBody(req) {
	const chunks = [];
	for await (const chunk of req) chunks.push(chunk);
	const raw = Buffer.concat(chunks).toString("utf8");
	return raw === "" ? undefined : JSON.parse(raw);
}

function reject(res, status, message) {
	res.writeHead(status, { "content-type": "application/json" });
	res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message }, id: null }));
}

// ---- Auth hardening (P19): the token is the only barrier once tunneled ----
// Constant-time comparison via sha256 digests (equal length by construction,
// so timingSafeEqual applies and token length never leaks).
const tokenDigest = createHash("sha256").update(token).digest();
function tokenMatches(header) {
	if (typeof header !== "string" || !header.startsWith("Bearer ")) return false;
	const presented = createHash("sha256").update(header.slice("Bearer ".length)).digest();
	return timingSafeEqual(presented, tokenDigest);
}

// Per-IP exponential backoff against online token brute force: after
// AUTH_FAIL_THRESHOLD consecutive failures, further attempts are refused for
// 2^n seconds (capped) — a success clears the slate. In-memory by design
// (resets on restart; the threat model is a single token being ground down).
const AUTH_FAIL_THRESHOLD = 5;
const AUTH_LOCK_CAP_MS = 60_000;
const authFailures = new Map();
function authLockedMs(ip, now) {
	const entry = authFailures.get(ip);
	return entry && entry.lockedUntil > now ? entry.lockedUntil - now : 0;
}
function recordAuthFailure(ip, now) {
	const entry = authFailures.get(ip) ?? { failures: 0, lockedUntil: 0 };
	entry.failures++;
	if (entry.failures >= AUTH_FAIL_THRESHOLD) {
		const lockMs = Math.min(2 ** (entry.failures - AUTH_FAIL_THRESHOLD + 1) * 1000, AUTH_LOCK_CAP_MS);
		entry.lockedUntil = now + lockMs;
	}
	authFailures.set(ip, entry);
}

const httpServer = createServer(async (req, res) => {
	try {
		const ip = req.socket.remoteAddress ?? "unknown";
		const now = Date.now();
		const lockedMs = authLockedMs(ip, now);
		if (lockedMs > 0) {
			res.setHeader("retry-after", String(Math.ceil(lockedMs / 1000)));
			reject(res, 429, "Too many failed authentication attempts; retry later");
			return;
		}
		if (!tokenMatches(req.headers.authorization)) {
			recordAuthFailure(ip, now);
			reject(res, 401, "Unauthorized: missing or invalid bearer token");
			return;
		}
		authFailures.delete(ip);
		const sessionId = req.headers["mcp-session-id"];
		const existing = typeof sessionId === "string" ? transports.get(sessionId) : undefined;
		if (existing) {
			await existing.handleRequest(req, res, req.method === "POST" ? await readBody(req) : undefined);
			return;
		}
		const body = req.method === "POST" ? await readBody(req) : undefined;
		if (req.method !== "POST" || !isInitializeRequest(body)) {
			// A session-bearing request whose session we no longer know gets 404,
			// telling the client to re-initialize (Streamable HTTP spec).
			reject(res, sessionId ? 404 : 400, sessionId ? "Unknown session" : "Expected an initialize request");
			return;
		}
		const transport = new StreamableHTTPServerTransport({
			sessionIdGenerator: () => randomUUID(),
			onsessioninitialized: (id) => transports.set(id, transport),
		});
		transport.onclose = () => {
			if (transport.sessionId) transports.delete(transport.sessionId);
		};
		await createMcpServer().connect(transport);
		await transport.handleRequest(req, res, body);
	} catch (cause) {
		console.error("request failed:", cause);
		if (!res.headersSent) reject(res, 500, "Internal error");
	}
});

function lanAddresses() {
	return Object.values(networkInterfaces())
		.flat()
		.filter((iface) => iface && iface.family === "IPv4" && !iface.internal)
		.map((iface) => iface.address);
}

httpServer.listen(options.port, options.host, async () => {
	const actualPort = httpServer.address().port; // differs from options.port when --port 0 (e2e)
	const hosts = options.host === "0.0.0.0" ? lanAddresses() : [options.host];
	console.log("tau Flutter demo — computer-side MCP server");
	console.log(`  work directory : ${rootDir}`);
	for (const host of hosts.length > 0 ? hosts : ["127.0.0.1"]) {
		console.log(`  endpoint       : http://${host}:${actualPort}/`);
	}
	console.log(`  token          : ${token}`);
	console.log("");
	if (options.host === "127.0.0.1" && !options.tunnel) {
		console.log("ℹ Listening on loopback only (the safe default). Reach it from a phone via");
		console.log("  --tunnel (Cloudflare Quick Tunnel, no account) or --host 0.0.0.0 for LAN.");
	}
	if (options.host !== "127.0.0.1") {
		console.log("⚠ run_command executes arbitrary shell commands in the work directory for");
		console.log("  any client holding this token. Network reach + token is the only barrier —");
		console.log("  never expose this server beyond a trusted network.");
	}
	if (options.tunnel) {
		console.log("  starting Cloudflare Quick Tunnel (no account; URL changes every start) ...");
		try {
			const { url } = await startQuickTunnel(actualPort, {
				onExit: (code) => console.error(`⚠ cloudflared exited (code ${code}); the public URL is dead. Restart to get a new one.`),
			});
			console.log("");
			console.log(`  public URL     : ${url}`);
			console.log(`  token          : ${token}`);
			console.log("  Enter both in the phone app's settings. The URL is public internet —");
			console.log("  the token is the only barrier, and run_command is remote code execution.");
			console.log("  Treat the token like a password and rotate it when in doubt.");
		} catch (cause) {
			console.error(cause instanceof Error ? cause.message : String(cause));
			process.exit(1);
		}
	}
});
