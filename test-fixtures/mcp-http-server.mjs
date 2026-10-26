// A minimal MCP server over Streamable HTTP for smokes (P62: replaces the archived Flutter demo's
// server in smoke:quickjs:mcp): JSON responses, no SSE, no SDK, a bearer token, and two tools over
// one directory, read_file and list_dir.
//
//   node test-fixtures/mcp-http-server.mjs --dir <dir> [--port 0] [--host 127.0.0.1] [--token <token>]
//
// Prints "endpoint : http://HOST:PORT/mcp" once it listens.
import { readdirSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { isAbsolute, relative, resolve } from "node:path";

const argv = process.argv.slice(2);
const option = (name, fallback) => {
	const at = argv.indexOf(name);
	return at >= 0 && argv[at + 1] !== undefined ? argv[at + 1] : fallback;
};
const dir = resolve(option("--dir", process.cwd()));
const token = option("--token", undefined);

const tools = [
	{
		name: "read_file",
		description: "Read a text file in the shared directory",
		inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
	},
	{
		name: "list_dir",
		description: "List a directory in the shared directory",
		inputSchema: { type: "object", properties: { path: { type: "string" } } },
	},
];

function inside(path = ".") {
	const full = resolve(dir, path);
	const rel = relative(dir, full);
	if (rel.startsWith("..") || isAbsolute(rel)) throw new Error(`${path} is outside the shared directory`);
	return full;
}

function callTool(name, args = {}) {
	try {
		if (name === "read_file") return { content: [{ type: "text", text: readFileSync(inside(args.path), "utf8") }] };
		if (name === "list_dir") return { content: [{ type: "text", text: readdirSync(inside(args.path)).join("\n") }] };
		return { content: [{ type: "text", text: `Unknown tool ${name}` }], isError: true };
	} catch (error) {
		return { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true };
	}
}

function answer(message) {
	switch (message.method) {
		case "initialize":
			return {
				protocolVersion: message.params?.protocolVersion ?? "2025-06-18",
				capabilities: { tools: {} },
				serverInfo: { name: "tau-fixture", version: "0.0.0" },
			};
		case "ping":
			return {};
		case "tools/list":
			return { tools };
		case "tools/call":
			return callTool(message.params?.name, message.params?.arguments);
		default:
			return undefined;
	}
}

const server = createServer((req, res) => {
	if (req.method !== "POST") {
		res.writeHead(405, { allow: "POST" }).end();
		return;
	}
	if (token !== undefined && req.headers.authorization !== `Bearer ${token}`) {
		res.writeHead(401).end();
		return;
	}
	let body = "";
	req.setEncoding("utf8");
	req.on("data", (chunk) => {
		body += chunk;
	});
	req.on("end", () => {
		let message;
		try {
			message = JSON.parse(body);
		} catch {
			res.writeHead(400).end();
			return;
		}
		// A notification (no id) gets no body.
		if (message.id === undefined) {
			res.writeHead(202).end();
			return;
		}
		const result = answer(message);
		const reply =
			result === undefined
				? { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `Method not found: ${message.method}` } }
				: { jsonrpc: "2.0", id: message.id, result };
		res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(reply));
	});
});

server.listen(Number(option("--port", "0")), option("--host", "127.0.0.1"), () => {
	const address = server.address();
	console.log(`endpoint : http://${address.address}:${address.port}/mcp`);
});
