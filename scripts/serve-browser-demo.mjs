import { readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";
import { build } from "esbuild";

const root = join(process.cwd(), "examples", "browser");
const port = Number.parseInt(process.env.PORT ?? "8765", 10);

const contentTypes = new Map([
	[".html", "text/html; charset=utf-8"],
	[".js", "text/javascript; charset=utf-8"],
	[".css", "text/css; charset=utf-8"],
	[".json", "application/json; charset=utf-8"],
]);

function targetUrl(baseUrl, proxyPath) {
	const base = new URL(baseUrl);
	const basePath = base.pathname.replace(/\/+$/, "");
	const suffix = proxyPath.replace(/^\/proxy\/?/, "");
	base.pathname = `${basePath}/${suffix}`.replace(/\/+/g, "/");
	base.search = "";
	return base;
}

async function readBody(req) {
	let body = "";
	req.setEncoding("utf8");
	for await (const chunk of req) body += chunk;
	return body;
}

async function proxy(req, res) {
	if (req.method === "OPTIONS") {
		res.writeHead(204, {
			"access-control-allow-origin": "*",
			"access-control-allow-headers": "content-type, authorization, x-tau-target-base-url",
			"access-control-allow-methods": "POST, OPTIONS",
		});
		res.end();
		return;
	}
	const targetBaseUrl = req.headers["x-tau-target-base-url"];
	if (typeof targetBaseUrl !== "string" || targetBaseUrl.trim() === "") {
		res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
		res.end("Missing x-tau-target-base-url");
		return;
	}
	const upstream = targetUrl(targetBaseUrl, req.url ?? "/proxy");
	const headers = new Headers();
	for (const [name, value] of Object.entries(req.headers)) {
		if (value === undefined || name === "host" || name === "connection" || name === "x-tau-target-base-url") continue;
		headers.set(name, Array.isArray(value) ? value.join(", ") : value);
	}
	const response = await fetch(upstream, {
		method: req.method,
		headers,
		body: req.method === "GET" || req.method === "HEAD" ? undefined : await readBody(req),
	});
	const responseHeaders = {};
	response.headers.forEach((value, name) => {
		if (!["content-encoding", "content-length", "transfer-encoding"].includes(name)) responseHeaders[name] = value;
	});
	res.writeHead(response.status, responseHeaders);
	if (!response.body) {
		res.end(await response.text());
		return;
	}
	const reader = response.body.getReader();
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		res.write(value);
	}
	res.end();
}

async function serveStatic(req, res) {
	const url = new URL(req.url ?? "/", "http://127.0.0.1");
	const safePath = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, "");
	const filePath = join(root, safePath === "/" ? "index.html" : safePath);
	if (!filePath.startsWith(root)) {
		res.writeHead(403);
		res.end("Forbidden");
		return;
	}
	try {
		const info = await stat(filePath);
		if (!info.isFile()) throw new Error("not a file");
		res.writeHead(200, { "content-type": contentTypes.get(extname(filePath)) ?? "application/octet-stream" });
		res.end(await readFile(filePath));
	} catch {
		res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
		res.end("Not found");
	}
}

await build({
	entryPoints: ["examples/browser/src/app.ts"],
	bundle: true,
	format: "esm",
	platform: "browser",
	target: "es2023",
	outfile: "examples/browser/dist/app.js",
	logLevel: "silent",
});

const server = createServer((req, res) => {
	if (req.url?.startsWith("/proxy")) {
		void proxy(req, res).catch((error) => {
			res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
			res.end(error instanceof Error ? error.message : String(error));
		});
		return;
	}
	void serveStatic(req, res);
});

server.listen(port, "127.0.0.1", () => {
	console.log(`tau browser demo: http://127.0.0.1:${port}/`);
	console.log("Remote API requests are proxied through /proxy to avoid browser CORS.");
});
