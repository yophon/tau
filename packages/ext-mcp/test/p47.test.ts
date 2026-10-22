// P47 over real stdio processes: a 2026-07-28 server, and 2025 servers that answer the probe
// with an error, exit on it, or ignore it.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { createMcpServers, MCP_PROTOCOL_VERSION, McpClient, type McpServerConfig } from "@yophon/tau-ext-mcp-http";
import { defaultPlatform, ExtensionRegistry } from "@yophon/tau-kernel";
import { StdioTransport } from "../src/index.ts";
import { authorizeMcp, McpOAuthProvider, type McpOAuthState, MemoryOAuthStateStore } from "../src/oauth/index.ts";

const MOCK_SERVER = fileURLToPath(new URL("./mock-mcp-server.mjs", import.meta.url));
const transportFor = (era?: string) =>
	new StdioTransport({
		command: process.execPath,
		args: [MOCK_SERVER],
		env: era ? { MOCK_ERA: era } : {},
	});

async function connected(era?: string, timeoutMs = 5000) {
	const mcp = new McpClient({ name: "tau", version: "test", platform: defaultPlatform(), protocolNegotiation: "auto" });
	await mcp.connect(transportFor(era), { timeoutMs });
	return mcp;
}

describe("P47 over stdio", () => {
	it("a 2026-07-28 server speaks the modern revision end to end", async () => {
		const mcp = await connected("modern");
		try {
			assert.equal(mcp.protocolEra, "modern");
			assert.equal(mcp.protocolVersion, "2026-07-28");
			assert.equal(mcp.instructions, "Modern mock tools.");
			assert.equal(mcp.serverInfo?.name, "tau-mock-modern");
			assert.ok((await mcp.listTools()).some((tool) => tool.name === "echo"));
			assert.equal((await mcp.callTool("echo", { text: "hi" })).content[0]?.text, "mcp:hi");
		} finally {
			await mcp.close();
		}
	});

	it("a 2025 server that answers the probe with method-not-found shakes hands", async () => {
		const mcp = await connected();
		try {
			assert.equal(mcp.protocolEra, "legacy");
			assert.equal(mcp.protocolVersion, MCP_PROTOCOL_VERSION);
			assert.equal((await mcp.callTool("echo", { text: "hi" })).content[0]?.text, "mcp:hi");
		} finally {
			await mcp.close();
		}
	});

	it("a 2025 server that ignores the probe shakes hands after the probe timeout", async () => {
		const started = Date.now();
		const mcp = await connected("silent", 600);
		try {
			assert.equal(mcp.protocolEra, "legacy");
			assert.ok(Date.now() - started >= 550);
		} finally {
			await mcp.close();
		}
	});

	it("a 2025 server that exits on the probe is started again on the handshake", async () => {
		const configs: McpServerConfig[] = [
			{ name: "exits", command: process.execPath, args: [MOCK_SERVER], env: { MOCK_ERA: "exit" } },
		];
		let spawned = 0;
		const handle = createMcpServers({
			servers: configs,
			platform: defaultPlatform(),
			clientInfo: { name: "tau", version: "test" },
			protocolNegotiation: "auto",
			createTransport: (config) => {
				spawned++;
				return new StdioTransport({ command: config.command ?? "", args: config.args, env: config.env });
			},
		});
		await ExtensionRegistry.load([handle.extension]);
		try {
			const [status] = await handle.connect();
			assert.equal(status?.state, "connected", status?.error);
			assert.equal(status?.protocolVersion, MCP_PROTOCOL_VERSION);
			assert.equal(status?.toolCount, 6);
			assert.equal(spawned, 2);
		} finally {
			await handle.close();
		}
	});
});

describe("P47c OAuth credentials keyed by issuer (SEP-2352)", () => {
	const SERVER = "https://mcp.test/mcp";
	const metadataFor = (issuer: string) => ({
		issuer,
		authorization_endpoint: `${issuer}/authorize`,
		token_endpoint: `${issuer}/token`,
		registration_endpoint: `${issuer}/register`,
		response_types_supported: ["code"],
		code_challenge_methods_supported: ["S256"],
		token_endpoint_auth_methods_supported: ["none"],
	});

	/** The server now names https://new-as.test; the store holds a client registered with `storedIssuer`. */
	async function signIn(storedIssuer: string | undefined) {
		const registrations: string[] = [];
		const fetch = async (input: string | URL) => {
			const url = new URL(String(input));
			if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) {
				return Response.json({ resource: SERVER, authorization_servers: ["https://new-as.test"] });
			}
			if (url.pathname.startsWith("/.well-known/oauth-authorization-server"))
				return Response.json(metadataFor(url.origin));
			if (url.pathname === "/register") {
				registrations.push(url.origin);
				return Response.json(
					{ client_id: "new-client", redirect_uris: ["http://127.0.0.1:1/cb"], token_endpoint_auth_method: "none" },
					{ status: 201 },
				);
			}
			return new Response("", { status: 404 });
		};
		const store = new MemoryOAuthStateStore();
		store.save({
			serverUrl: SERVER,
			clientInformation: { client_id: "old-client" },
			...(storedIssuer ? { clientIssuer: storedIssuer } : {}),
			tokens: { access_token: "old-token", token_type: "Bearer" },
		});
		let redirect: URL | undefined;
		const provider = new McpOAuthProvider({
			serverUrl: SERVER,
			redirectUrl: "http://127.0.0.1:1/cb",
			clientMetadata: { client_name: "tau" },
			store,
			onRedirect: (url) => {
				redirect = url;
			},
		});
		const result = await authorizeMcp(provider, { serverUrl: SERVER, fetch, skipRefresh: true });
		return {
			result,
			registrations,
			clientId: redirect?.searchParams.get("client_id"),
			state: store.load() as McpOAuthState,
		};
	}

	it("a client registered with another authorization server is dropped with its tokens and registered again", async () => {
		const { result, registrations, clientId, state } = await signIn("https://old-as.test");
		assert.equal(result, "REDIRECT");
		assert.deepEqual(registrations, ["https://new-as.test"]);
		assert.equal(clientId, "new-client");
		assert.equal(state.clientIssuer, "https://new-as.test");
		assert.equal(state.tokens, undefined);
	});

	it("the same authorization server, or one not recorded yet, keeps the client", async () => {
		for (const issuer of ["https://new-as.test", undefined]) {
			const { registrations, clientId, state } = await signIn(issuer);
			assert.deepEqual(registrations, [], String(issuer));
			assert.equal(clientId, "old-client");
			assert.equal(state.tokens?.access_token, "old-token");
		}
	});
});
