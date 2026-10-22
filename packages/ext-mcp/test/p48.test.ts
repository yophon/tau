// P48c (tech debt #23): sign-in uses the server's challenge — resource metadata only at the URL a
// 401 names (conformance auth/metadata-var3) — and a 403 insufficient_scope steps the grant up
// (auth/scope-step-up), as pi 1.2's OAuth runtime does.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { McpClient, McpHttpError, StreamableHttpTransport } from "@yophon/tau-ext-mcp-http";
import { defaultPlatform } from "@yophon/tau-kernel";
import {
	createMcpOAuth,
	McpOAuthAuthorizationRequiredError,
	McpOAuthFileStore,
	probeOAuthChallenge,
	signInMcpServer,
} from "../src/index.ts";

/** An MCP endpoint whose resource metadata is only at the URL its 401 names; tools/call needs `write`. */
async function startScopedServer(options: { forbidWithoutChallenge?: boolean } = {}) {
	const state = {
		scopes: new Map<string, string>(),
		codes: new Map<string, { challenge: string; scope: string }>(),
		authorizeScopes: [] as string[],
		issued: 0,
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
			const metadata = `${base}/meta/prm`;
			if (url.pathname === "/meta/prm") {
				json(200, { resource: `${base}/mcp`, authorization_servers: [base] });
			} else if (url.pathname.startsWith("/.well-known/oauth-authorization-server")) {
				json(200, {
					issuer: base,
					authorization_endpoint: `${base}/authorize`,
					token_endpoint: `${base}/token`,
					registration_endpoint: `${base}/register`,
					response_types_supported: ["code"],
					code_challenge_methods_supported: ["S256"],
					token_endpoint_auth_methods_supported: ["none"],
				});
			} else if (url.pathname === "/register") {
				const request = JSON.parse(body) as { redirect_uris: string[] };
				json(201, { client_id: "client-1", redirect_uris: request.redirect_uris, token_endpoint_auth_method: "none" });
			} else if (url.pathname === "/authorize") {
				const scope = url.searchParams.get("scope") ?? "";
				state.authorizeScopes.push(scope);
				const code = `code-${state.codes.size + 1}`;
				state.codes.set(code, { challenge: url.searchParams.get("code_challenge") ?? "", scope });
				const target = new URL(url.searchParams.get("redirect_uri") ?? "");
				target.searchParams.set("code", code);
				target.searchParams.set("state", url.searchParams.get("state") ?? "");
				res.writeHead(302, { location: target.href }).end();
			} else if (url.pathname === "/token") {
				const form = new URLSearchParams(body);
				const entry = state.codes.get(form.get("code") ?? "");
				const verifier = createHash("sha256")
					.update(form.get("code_verifier") ?? "")
					.digest("base64url");
				if (form.get("grant_type") !== "authorization_code" || !entry || entry.challenge !== verifier) {
					return json(400, { error: "invalid_grant" });
				}
				const token = `access-${++state.issued}`;
				state.scopes.set(token, entry.scope);
				json(200, {
					access_token: token,
					refresh_token: `refresh-${state.issued}`,
					token_type: "Bearer",
					scope: entry.scope,
				});
			} else if (url.pathname === "/mcp") {
				const token = (req.headers.authorization ?? "").replace(/^Bearer /, "");
				const granted = state.scopes.get(token);
				if (granted === undefined) {
					res.writeHead(401, { "www-authenticate": `Bearer resource_metadata="${metadata}", scope="read"` }).end();
					return;
				}
				const message = JSON.parse(body) as { id?: number; method: string };
				if (message.id === undefined) return res.writeHead(202).end();
				if (message.method === "tools/call" && !granted.split(" ").includes("write")) {
					res
						.writeHead(403, {
							"www-authenticate": options.forbidWithoutChallenge
								? `Bearer error="invalid_token"`
								: `Bearer error="insufficient_scope", scope="write", resource_metadata="${metadata}"`,
						})
						.end();
					return;
				}
				const reply = (result: unknown) =>
					json(200, { jsonrpc: "2.0", id: message.id, result }, { "mcp-session-id": "s" });
				if (message.method === "initialize") {
					reply({
						protocolVersion: "2025-06-18",
						capabilities: { tools: {} },
						serverInfo: { name: "o", version: "1" },
					});
				} else if (message.method === "tools/list") {
					reply({ tools: [{ name: "edit", description: "Edit", inputSchema: { type: "object", properties: {} } }] });
				} else if (message.method === "tools/call") {
					reply({ content: [{ type: "text", text: "edited" }] });
				} else reply({});
			} else {
				res.writeHead(404).end();
			}
		});
	});
	await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
	const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
	return { state, base, url: `${base}/mcp`, close: () => new Promise<void>((done) => server.close(() => done())) };
}

const never = (signal: AbortSignal) =>
	new Promise<string | undefined>((resolve) => signal.addEventListener("abort", () => resolve(undefined)));

/** The "browser": follows the authorization redirect to the loopback callback. */
const browser = {
	showAuthorizationUrl: (url: URL) => {
		void fetch(url, { redirect: "follow" }).catch(() => undefined);
	},
	promptForRedirectUrl: never,
};

async function connect(url: string, auth: ReturnType<typeof createMcpOAuth>): Promise<McpClient> {
	const platform = defaultPlatform();
	const client = new McpClient({ name: "t", version: "1", platform, requestTimeoutMs: 5000 });
	await client.connect(new StreamableHttpTransport({ url, platform, auth }));
	return client;
}

describe("P48 MCP OAuth challenges", () => {
	it("probes the challenge: metadata only at the 401's URL, the challenged scope requested", async () => {
		const server = await startScopedServer();
		try {
			const challenge = await probeOAuthChallenge(server.url);
			assert.equal(challenge?.resourceMetadataUrl?.href, `${server.base}/meta/prm`);
			assert.equal(challenge?.scope, "read");
			const store = new McpOAuthFileStore(join(mkdtempSync(join(tmpdir(), "tau-oauth-")), "mcp-auth.json"));
			await signInMcpServer({
				serverUrl: server.url,
				store: store.forServer("s", server.url),
				settings: {},
				prompt: browser,
			});
			assert.deepEqual(server.state.authorizeScopes, ["read"]);
			assert.equal(store.tokens("s", server.url)?.access_token, "access-1");
		} finally {
			await server.close();
		}
	});

	it("a 403 insufficient_scope asks for sign-in; the next sign-in adds the scope to the grant", async () => {
		const server = await startScopedServer();
		try {
			const store = new McpOAuthFileStore(join(mkdtempSync(join(tmpdir(), "tau-oauth-")), "mcp-auth.json"));
			const serverStore = store.forServer("s", server.url);
			await signInMcpServer({ serverUrl: server.url, store: serverStore, settings: {}, prompt: browser });
			const auth = createMcpOAuth({ serverUrl: server.url, store: serverStore, settings: {} });
			const client = await connect(server.url, auth);
			try {
				assert.deepEqual(
					(await client.listTools()).map((tool) => tool.name),
					["edit"],
				);
				const error = await client.callTool("edit", {}).then(
					() => assert.fail("expected a sign-in request"),
					(failure: unknown) => failure,
				);
				assert.ok(error instanceof McpOAuthAuthorizationRequiredError);
				assert.equal(error.challenge?.error, "insufficient_scope");
				assert.equal(error.challenge?.scope, "write");
				assert.equal((await serverStore.load())?.requiredScope, "write");
			} finally {
				await client.close();
			}

			// `tau mcp login` runs apart from the connection: the remembered scope steps the grant up.
			await signInMcpServer({ serverUrl: server.url, store: serverStore, settings: {}, prompt: browser });
			assert.deepEqual(server.state.authorizeScopes, ["read", "read write"]);
			assert.equal((await serverStore.load())?.requiredScope, undefined);
			const again = await connect(
				server.url,
				createMcpOAuth({ serverUrl: server.url, store: serverStore, settings: {} }),
			);
			try {
				const result = await again.callTool("edit", {});
				assert.deepEqual(result.content, [{ type: "text", text: "edited" }]);
			} finally {
				await again.close();
			}
		} finally {
			await server.close();
		}
	});

	it("a 403 without insufficient_scope is an HTTP error, not a sign-in", async () => {
		const server = await startScopedServer({ forbidWithoutChallenge: true });
		try {
			const store = new McpOAuthFileStore(join(mkdtempSync(join(tmpdir(), "tau-oauth-")), "mcp-auth.json"));
			const serverStore = store.forServer("s", server.url);
			await signInMcpServer({ serverUrl: server.url, store: serverStore, settings: {}, prompt: browser });
			const client = await connect(
				server.url,
				createMcpOAuth({ serverUrl: server.url, store: serverStore, settings: {} }),
			);
			try {
				await assert.rejects(client.callTool("edit", {}), McpHttpError);
				assert.equal((await serverStore.load())?.requiredScope, undefined);
			} finally {
				await client.close();
			}
		} finally {
			await server.close();
		}
	});
});
