// `tau credentials …` and `tau mcp …` (P32b): commands that manage configuration and need
// neither a model nor the agent.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { auditCredentials, CredentialStore, credentialsPath, credentialUsage } from "./credentials.ts";
import type { LoadedMcpServer } from "./mcp-config.ts";
import { openUrl } from "./open-url.ts";
import { maskSecrets } from "./secrets.ts";
import { readSettings } from "./settings.ts";

const CREDENTIALS_USAGE = `tau credentials - secrets referenced from configuration as \${cred:<name>}

Usage:
  tau credentials set <name> [--note <text>]   Store a value (typed without echo, or piped on stdin)
  tau credentials list                         Names, notes and which config files use them (never values)
  tau credentials remove <name>                Delete one
  tau credentials audit                        Find secrets written out in config files, and unresolved references

Stored in ~/.tau/credentials.json (0600). Use them in ~/.tau/models.json (apiKey, headers),
and ~/.tau/mcp.json (command, args, env, url, headers).`;

/** Read a secret: hidden typing on a terminal, else all of stdin (trailing newline trimmed). */
async function readSecret(prompt: string): Promise<string> {
	if (!process.stdin.isTTY) {
		let data = "";
		for await (const chunk of process.stdin) data += chunk;
		return data.replace(/\r?\n$/, "");
	}
	return await new Promise((resolve) => {
		const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
		// readline's undocumented echo hook: overriding it hides a secret as it is typed (the common Node idiom).
		const output = rl as unknown as { _writeToOutput?: (text: string) => void };
		let prompted = false;
		output._writeToOutput = (text: string) => {
			// Show the prompt once; swallow the echo of what is typed.
			if (!prompted) {
				process.stdout.write(text);
				prompted = true;
			}
		};
		rl.question(prompt, (answer) => {
			process.stdout.write("\n");
			rl.close();
			resolve(answer);
		});
	});
}

async function credentialsCommand(args: string[], home: string): Promise<number> {
	const store = new CredentialStore(credentialsPath(home));
	const [command = "help", ...rest] = args;
	switch (command) {
		case "help":
		case "--help":
			console.log(CREDENTIALS_USAGE);
			return 0;
		case "set": {
			const name = rest[0];
			const noteIndex = rest.indexOf("--note");
			const note = noteIndex >= 0 ? rest[noteIndex + 1] : undefined;
			if (!name || name.startsWith("--")) {
				console.error("Usage: tau credentials set <name> [--note <text>]");
				return 1;
			}
			const value = await readSecret(`Value for ${name}: `);
			try {
				store.set(name, value, note);
			} catch (error) {
				console.error(error instanceof Error ? error.message : String(error));
				return 1;
			}
			console.log(`Saved ${name} in ${store.file}. Refer to it as \${cred:${name}}.`);
			return 0;
		}
		case "list": {
			const names = store.names();
			if (names.length === 0) {
				console.log(`No credentials (${store.file}). Add one with tau credentials set <name>.`);
				return 0;
			}
			const usage = credentialUsage(home);
			for (const entry of names) {
				const used = usage.get(entry.name);
				console.log(
					`${entry.name}${entry.note ? `  — ${entry.note}` : ""}  (added ${new Date(entry.createdAt).toLocaleDateString()}; ${used ? `used in ${used.join(", ")}` : "not referenced"})`,
				);
			}
			return 0;
		}
		case "remove": {
			const name = rest[0];
			if (!name) {
				console.error("Usage: tau credentials remove <name>");
				return 1;
			}
			const removed = store.remove(name);
			console.log(removed ? `Removed ${name}.` : `No credential named ${name}.`);
			return removed ? 0 : 1;
		}
		case "audit": {
			const findings = auditCredentials(home, store);
			if (findings.length === 0) {
				console.log("No plaintext secrets or unresolved references found.");
				return 0;
			}
			for (const finding of findings)
				console.log(`${finding.code}  ${finding.file}  ${finding.where}  ${finding.detail}`);
			return 1;
		}
		default:
			console.error(`Unknown credentials command "${command}".\n\n${CREDENTIALS_USAGE}`);
			return 1;
	}
}

const MCP_USAGE = `tau mcp - connectors (MCP servers) from ~/.tau/mcp.json and a trusted project's .tau/mcp.json

Usage:
  tau mcp list [--check]     Servers, their source and the credentials they use; --check connects and counts tools
  tau mcp login <server>     Sign in to a server with "auth": "oauth" (browser, or paste the redirect URL)
  tau mcp logout <server>    Forget that sign-in

Format (pi's mcp.json): { "mcpServers": { "<name>": { "url": "…", "headers": { "Authorization": "Bearer \${cred:<name>}" } },
                                          "<name>": { "command": "…", "args": […], "env": { … } } } }
Per server: exposure, toolExposure, toolRisk (user file only), enabled, description, timeoutMs. See docs/connectors.md.`;

/** Whether ~/.tau/trust.json records the directory as trusted (the CLI's trust gate, without the digest check). */
function trustedProject(home: string, cwd: string): boolean {
	try {
		const store = JSON.parse(readFileSync(join(home, ".tau", "trust.json"), "utf8")) as {
			trusted?: Record<string, { trusted?: boolean }>;
		};
		return store.trusted?.[cwd]?.trusted === true;
	} catch {
		return false;
	}
}

async function checkServer(server: LoadedMcpServer): Promise<string> {
	const [
		{ McpClient, McpProbeExitedError, StreamableHttpTransport },
		{ StdioTransport },
		{ defaultPlatform },
		{ mcpProtocolNegotiation },
	] = await Promise.all([
		import("@yophon/tau-ext-mcp-http"),
		import("@yophon/tau-ext-mcp"),
		import("@yophon/tau-kernel"),
		import("./mcp-config.ts"),
	]);
	const platform = defaultPlatform();
	// P47: the same negotiation as a session (2026-07-28 first unless TAU_MCP_PROTOCOL_NEGOTIATION=legacy).
	const protocolNegotiation = mcpProtocolNegotiation(process.env);
	let client: InstanceType<typeof McpClient> | undefined;
	const connect = async (era?: "legacy") => {
		client = new McpClient({ name: "tau", version: "0.4.0", platform, requestTimeoutMs: 10_000, protocolNegotiation });
		const transport = server.command
			? new StdioTransport({
					command: server.command,
					args: server.args,
					cwd: server.cwd,
					env: server.env,
					...(server.inheritEnv === false ? { inheritEnv: false } : {}),
				})
			: new StreamableHttpTransport({ url: server.url ?? "", platform, headers: server.headers });
		await client.connect(transport, era ? { era } : {});
		return client;
	};
	try {
		// A stdio server the probe knocked over gets a fresh process on the handshake.
		const connected = await connect().catch((error) => {
			if (error instanceof McpProbeExitedError) return connect("legacy");
			throw error;
		});
		// Servers without the tools capability do not answer tools/list; resources are noted (P43, pi).
		const capabilities = connected.serverCapabilities ?? {};
		const tools = capabilities.tools !== undefined ? await connected.listTools() : [];
		const version = connected.protocolVersion ? `MCP ${connected.protocolVersion}, ` : "";
		return `ok, ${version}${tools.length} tool(s)${capabilities.resources !== undefined ? ", resources" : ""}`;
	} catch (error) {
		return `failed: ${maskSecrets(error instanceof Error ? error.message : String(error))}`;
	} finally {
		await client?.close().catch(() => undefined);
	}
}

/** `tau mcp login|logout <server>`: OAuth sign-in for a server with "auth": "oauth" in ~/.tau/mcp.json. */
async function mcpSignIn(
	command: "login" | "logout",
	name: string | undefined,
	context: { home: string; cwd: string },
): Promise<number> {
	const { loadMcpConfig, mcpAuthStore, oauthSettings } = await import("./mcp-config.ts");
	const { servers } = loadMcpConfig({ home: context.home, cwd: context.cwd, projectTrusted: false });
	const candidates = servers.filter((server) => server.usesOAuth && server.url);
	const server = candidates.find((entry) => entry.name === name);
	if (!name || !server?.url) {
		console.error(
			`Usage: tau mcp ${command} <server>  (servers with "auth": "oauth" in ~/.tau/mcp.json: ${candidates.map((entry) => entry.name).join(", ") || "none"})`,
		);
		return 1;
	}
	const store = mcpAuthStore(context.home);
	if (command === "logout") {
		const removed = store.remove(server.name, server.url);
		console.log(removed ? `Signed out of ${server.name}.` : `${server.name} had no stored sign-in.`);
		return 0;
	}
	const { signInMcpServer, McpSignInCancelledError } = await import("@yophon/tau-ext-mcp");
	const controller = new AbortController();
	const onSignal = () => controller.abort();
	process.once("SIGINT", onSignal);
	try {
		await signInMcpServer({
			serverUrl: server.url,
			store: store.forServer(server.name, server.url),
			settings: oauthSettings(server),
			signal: controller.signal,
			prompt: {
				showAuthorizationUrl: (url) => {
					console.log(`Open this link to sign in to ${server.name}:\n\n  ${url.href}\n`);
					openUrl(url.href);
				},
				promptForRedirectUrl: (signal) =>
					new Promise((resolve) => {
						// On a machine whose browser cannot reach this one, paste the address the browser ended on.
						const rl = createInterface({ input: process.stdin, output: process.stdout });
						signal.addEventListener("abort", () => {
							rl.close();
							resolve(undefined);
						});
						rl.question("Waiting for the browser… or paste the URL the browser was sent to: ", (answer) => {
							rl.close();
							resolve(answer);
						});
					}),
			},
		});
		console.log(`\nSigned in to ${server.name}. Tokens are in ${store.file}.`);
		return 0;
	} catch (error) {
		if (error instanceof McpSignInCancelledError) {
			console.error("Sign-in cancelled.");
			return 1;
		}
		console.error(`Sign-in failed: ${maskSecrets(error instanceof Error ? error.message : String(error))}`);
		return 1;
	} finally {
		process.off("SIGINT", onSignal);
	}
}

async function mcpCommand(args: string[], context: { home: string; cwd: string }): Promise<number> {
	const [command = "help", ...rest] = args;
	if (command === "help" || command === "--help") {
		console.log(MCP_USAGE);
		return 0;
	}
	if (command === "login" || command === "logout") return mcpSignIn(command, rest[0], context);
	if (command !== "list") {
		console.error(`Unknown mcp command "${command}".\n\n${MCP_USAGE}`);
		return 1;
	}
	const { loadMcpConfig } = await import("./mcp-config.ts");
	const { servers, diagnostics } = loadMcpConfig({
		home: context.home,
		cwd: context.cwd,
		projectTrusted: trustedProject(context.home, context.cwd),
		envAllow: readSettings(join(context.home, ".tau", "settings.json")).shellEnvAllow ?? [],
	});
	if (servers.length === 0 && diagnostics.length === 0) {
		console.log(`No MCP servers. Add them to ${join(context.home, ".tau", "mcp.json")}.`);
		return 0;
	}
	for (const server of servers) {
		const transport = server.command ? `stdio: ${server.command}` : `http: ${server.url}`;
		const extras = [
			server.exposure ? `exposure ${server.exposure}` : "",
			server.credentials.length > 0 ? `credentials ${[...new Set(server.credentials)].join(", ")}` : "",
			server.toolRisk
				? `toolRisk ${Object.entries(server.toolRisk)
						.map(([pattern, risk]) => `${pattern}=${risk}`)
						.join(" ")}`
				: "",
			server.usesOAuth ? "OAuth" : "",
		].filter(Boolean);
		let line = `${server.name}  ${transport}  (${server.source}${extras.length > 0 ? `; ${extras.join("; ")}` : ""})`;
		if (rest.includes("--check")) line += `  → ${await checkServer(server)}`;
		console.log(line);
	}
	for (const diagnostic of diagnostics) console.log(`! ${diagnostic}`);
	return diagnostics.length > 0 ? 1 : 0;
}

const AUDIT_USAGE = `tau audit - what tau did: runs, tool calls, approvals, messages (~/.tau/audit, kept 30 days)

Usage: tau audit [options]
  --since <1d|24h|2026-10-18>   From (default 1d)        --until <…>       To
  --host <tui|repl|print|json|rpc|acp|gateway>           --trigger <user|chat|schedule|rpc|acp>
  --schedule <id>   --channel <name>   --tool <name>   --decision <source>   --status <ok|error|aborted>
  --external        only runs with calls that reached outside (MCP, web)
  --kind <run|tool|message>   with --json: only that kind of record
  --json            records as JSON lines        --limit <n>   most runs to show (default 50)

Decision sources: mode, policy_deny, rule_allow, rule_deny, user_once, user_session, user_reject, chat_owner,
chat_reject, timeout, non_owner, hook, hook_allow, no_approver.`;

async function auditCommand(args: string[], home: string): Promise<number> {
	const { AuditLedger, filterRuns, formatRuns, groupRuns } = await import("./audit.ts");
	const { parseSince } = await import("./session-search.ts");
	const value = (flag: string) => {
		const index = args.indexOf(flag);
		return index >= 0 ? args[index + 1] : undefined;
	};
	if (args.includes("--help") || args[0] === "help") {
		console.log(AUDIT_USAGE);
		return 0;
	}
	let since: number;
	let until = Number.POSITIVE_INFINITY;
	try {
		since = parseSince(value("--since") ?? "1d");
		const untilText = value("--until");
		if (untilText) until = parseSince(untilText);
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		return 1;
	}
	const records = AuditLedger.at(home).read(since, until);
	const filter = {
		...(value("--host") ? { host: value("--host") } : {}),
		...(value("--trigger") ? { trigger: value("--trigger") } : {}),
		...(value("--schedule") ? { schedule: value("--schedule")?.replace(/^#/, "") } : {}),
		...(value("--channel") ? { channel: value("--channel") } : {}),
		...(value("--tool") ? { tool: value("--tool") } : {}),
		...(value("--decision") ? { decision: value("--decision") } : {}),
		...(value("--status") ? { status: value("--status") } : {}),
		...(args.includes("--external") ? { external: true } : {}),
	};
	const limit = Number(value("--limit") ?? 50);
	const runs = filterRuns(groupRuns(records), filter).slice(0, Number.isFinite(limit) && limit > 0 ? limit : 50);
	if (args.includes("--json")) {
		const kind = value("--kind");
		const ids = new Set(runs.map((run) => run.runId));
		const tools = new Set(runs.flatMap((run) => run.tools.map((tool) => `${run.runId}:${tool.toolCallId}`)));
		for (const record of records) {
			if (!ids.has(record.runId) || (kind && record.kind !== kind)) continue;
			if (record.kind === "tool" && !tools.has(`${record.runId}:${record.toolCallId}`)) continue;
			console.log(JSON.stringify(record));
		}
		return 0;
	}
	console.log(runs.length === 0 ? "Nothing recorded for that range." : formatRuns(runs));
	return 0;
}

export async function runToolCommand(
	name: string,
	args: string[],
	context: { home: string; cwd: string },
): Promise<number> {
	if (name === "credentials") return credentialsCommand(args, context.home);
	if (name === "mcp") return mcpCommand(args, context);
	if (name === "audit") return auditCommand(args, context.home);
	console.error(`Unknown command ${name}`);
	return 1;
}
