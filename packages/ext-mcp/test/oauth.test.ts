// P32b: OAuth for MCP servers against a mock authorization server and protected MCP endpoint.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { McpClient, StreamableHttpTransport } from "@yophon/tau-ext-mcp-http";
import { defaultPlatform } from "@yophon/tau-kernel";
import {
	createMcpOAuth,
	McpOAuthAuthorizationRequiredError,
	McpOAuthFileStore,
	signInMcpServer,
} from "../src/index.ts";

async function startOAuthServer() {
	const state = {
		valid: new Set<string>(),
		issued: 0,
		refreshes: 0,
		codes: new Map<string, { challenge: string; redirect: string }>(),
	};
	const server = createServer((req, res) => {
		let body = "";
		req.on("data", (chunk) => {
			body += chunk;
		});
		req.on("end", () => {
			const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
			const url = new URL(req.url ?? "/", base);
			const json = (status: number, value: unknown, headers: Record<string, string> = {}) => {
				res.writeHead(status, { "content-type": "application/json", ...headers });
				res.end(JSON.stringify(value));
			};
			if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) {
				json(200, { resource: `${base}/mcp`, authorization_servers: [base] });
			} else if (url.pathname.startsWith("/.well-known/oauth-authorization-server")) {
				json(200, {
					issuer: base,
					authorization_endpoint: `${base}/authorize`,
					token_endpoint: `${base}/token`,
					registration_endpoint: `${base}/register`,
					response_types_supported: ["code"],
					grant_types_supported: ["authorization_code", "refresh_token"],
					code_challenge_methods_supported: ["S256"],
					token_endpoint_auth_methods_supported: ["none"],
				});
			} else if (url.pathname === "/register") {
				const request = JSON.parse(body) as { redirect_uris: string[] };
				json(201, { client_id: "client-1", redirect_uris: request.redirect_uris, token_endpoint_auth_method: "none" });
			} else if (url.pathname === "/authorize") {
				// The user approves at once: back to the redirect URI with a code.
				const code = `code-${state.codes.size + 1}`;
				const redirect = url.searchParams.get("redirect_uri") ?? "";
				state.codes.set(code, { challenge: url.searchParams.get("code_challenge") ?? "", redirect });
				const target = new URL(redirect);
				target.searchParams.set("code", code);
				target.searchParams.set("state", url.searchParams.get("state") ?? "");
				res.writeHead(302, { location: target.href }).end();
			} else if (url.pathname === "/token") {
				const form = new URLSearchParams(body);
				const issue = () => {
					const token = `access-${++state.issued}`;
					state.valid.add(token);
					json(200, {
						access_token: token,
						refresh_token: `refresh-${state.issued}`,
						token_type: "Bearer",
						expires_in: 3600,
					});
				};
				if (form.get("grant_type") === "authorization_code") {
					const entry = state.codes.get(form.get("code") ?? "");
					const verifier = form.get("code_verifier") ?? "";
					const challenge = createHash("sha256").update(verifier).digest("base64url");
					if (!entry || entry.challenge !== challenge) return json(400, { error: "invalid_grant" });
					issue();
				} else if (form.get("grant_type") === "refresh_token") {
					state.refreshes++;
					issue();
				} else json(400, { error: "unsupported_grant_type" });
			} else if (url.pathname === "/mcp") {
				const token = (req.headers.authorization ?? "").replace(/^Bearer /, "");
				if (!state.valid.has(token)) {
					res.writeHead(401, {
						"www-authenticate": `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource"`,
					});
					res.end();
					return;
				}
				const message = JSON.parse(body) as { id?: number; method: string };
				if (message.id === undefined) return res.writeHead(202).end();
				const reply = (result: unknown) =>
					json(200, { jsonrpc: "2.0", id: message.id, result }, { "mcp-session-id": "s" });
				if (message.method === "initialize") {
					reply({
						protocolVersion: "2025-06-18",
						capabilities: { tools: {} },
						serverInfo: { name: "o", version: "1" },
					});
				} else if (message.method === "tools/list") {
					reply({
						tools: [{ name: "issues", description: "List issues", inputSchema: { type: "object", properties: {} } }],
					});
				} else reply({});
			} else {
				res.writeHead(404).end();
			}
		});
	});
	await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
	const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
	return { state, url: `${base}/mcp`, close: () => new Promise<void>((done) => server.close(() => done())) };
}

const never = (signal: AbortSignal) =>
	new Promise<string | undefined>((resolve) => signal.addEventListener("abort", () => resolve(undefined)));

async function listTools(url: string, auth: ReturnType<typeof createMcpOAuth>): Promise<string[]> {
	const platform = defaultPlatform();
	const client = new McpClient({ name: "t", version: "1", platform, requestTimeoutMs: 5000 });
	await client.connect(new StreamableHttpTransport({ url, platform, auth }));
	const tools = await client.listTools();
	await client.close();
	return tools.map((tool) => tool.name);
}

describe("MCP OAuth", () => {
	it("signs in through the browser callback, connects with the token and refreshes after a 401", async () => {
		const oauth = await startOAuthServer();
		try {
			const store = new McpOAuthFileStore(join(mkdtempSync(join(tmpdir(), "tau-oauth-")), "mcp-auth.json"));
			const server = store.forServer("issues", oauth.url);
			// Before sign-in a connection asks for it.
			await assert.rejects(
				createMcpOAuth({ serverUrl: oauth.url, store: server, settings: {} }).token(),
				McpOAuthAuthorizationRequiredError,
			);
			let shown = "";
			await signInMcpServer({
				serverUrl: oauth.url,
				store: server,
				settings: {},
				prompt: {
					showAuthorizationUrl: (url) => {
						shown = url.href;
						// The "browser": follows the redirect to the loopback callback.
						void fetch(url, { redirect: "follow" }).catch(() => undefined);
					},
					promptForRedirectUrl: never,
				},
			});
			assert.match(shown, /\/authorize\?.*code_challenge_method=S256/);
			assert.equal(store.tokens("issues", oauth.url)?.access_token, "access-1");
			const saved = JSON.parse(readFileSync(store.file, "utf8")) as Record<string, unknown>;
			assert.deepEqual(Object.keys(saved), [`issues|${oauth.url}`]);

			const auth = createMcpOAuth({ serverUrl: oauth.url, store: server, settings: {} });
			assert.deepEqual(await listTools(oauth.url, auth), ["issues"]);
			// The server revokes the token: the next request gets 401, refreshes, and retries.
			oauth.state.valid.clear();
			assert.deepEqual(await listTools(oauth.url, auth), ["issues"]);
			assert.equal(oauth.state.refreshes, 1);
			assert.equal(store.tokens("issues", oauth.url)?.access_token, "access-2");
			assert.equal(store.remove("issues", oauth.url), true);
			assert.equal(store.tokens("issues", oauth.url), undefined);
		} finally {
			await oauth.close();
		}
	});

	it("accepts a pasted redirect URL when the browser cannot reach the callback", async () => {
		const oauth = await startOAuthServer();
		try {
			const store = new McpOAuthFileStore(join(mkdtempSync(join(tmpdir(), "tau-oauth-")), "mcp-auth.json"));
			let authorization: URL | undefined;
			await signInMcpServer({
				serverUrl: oauth.url,
				store: store.forServer("issues", oauth.url),
				settings: {},
				prompt: {
					showAuthorizationUrl: (url) => {
						authorization = url;
					},
					promptForRedirectUrl: async () => {
						// The browser on another machine ends on the redirect URL; the user pastes it.
						const response = await fetch(authorization as URL, { redirect: "manual" });
						return response.headers.get("location") ?? undefined;
					},
				},
			});
			assert.equal(store.tokens("issues", oauth.url)?.access_token, "access-1");
		} finally {
			await oauth.close();
		}
	});
});
