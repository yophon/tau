// `tau credentials …` and `tau mcp …` (P32b): commands that manage configuration and need
// neither a model nor the agent.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { auditCredentials, CredentialStore, credentialsPath, credentialUsage } from "./credentials.ts";
import type { LoadedMcpServer } from "./mcp-config.ts";
import { maskSecrets } from "./secrets.ts";
import { readSettings } from "./settings.ts";

const CREDENTIALS_USAGE = `tau credentials - secrets referenced from configuration as \${cred:<name>}

Usage:
  tau credentials set <name> [--note <text>]   Store a value (typed without echo, or piped on stdin)
  tau credentials list                         Names, notes and which config files use them (never values)
  tau credentials remove <name>                Delete one
  tau credentials audit                        Find secrets written out in config files, and unresolved references

Stored in ~/.tau/credentials.json (0600). Use them in ~/.tau/models.json (apiKey, headers),
~/.tau/mcp.json (command, args, env, url, headers) and ~/.tau/gateway/config.json (channels).`;

/** Read a secret: hidden typing on a terminal, else all of stdin (trailing newline trimmed). */
async function readSecret(prompt: string): Promise<string> {
	if (!process.stdin.isTTY) {
		let data = "";
		for await (const chunk of process.stdin) data += chunk;
		return data.replace(/\r?\n$/, "");
	}
	return await new Promise((resolve) => {
		const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
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
	const [{ McpClient, StreamableHttpTransport }, { StdioTransport }, { defaultPlatform }] = await Promise.all([
		import("@yophon/tau-ext-mcp-http"),
		import("@yophon/tau-ext-mcp"),
		import("@yophon/tau-kernel"),
	]);
	const platform = defaultPlatform();
	const client = new McpClient({ name: "tau", version: "0.4.0", platform, requestTimeoutMs: 10_000 });
	const transport = server.command
		? new StdioTransport({
				command: server.command,
				args: server.args,
				cwd: server.cwd,
				env: server.env,
				...(server.inheritEnv === false ? { inheritEnv: false } : {}),
			})
		: new StreamableHttpTransport({ url: server.url ?? "", platform, headers: server.headers });
	try {
		await client.connect(transport);
		const tools = await client.listTools();
		return `ok, ${tools.length} tool(s)`;
	} catch (error) {
		return `failed: ${maskSecrets(error instanceof Error ? error.message : String(error))}`;
	} finally {
		await client.close().catch(() => undefined);
	}
}

async function mcpCommand(args: string[], context: { home: string; cwd: string }): Promise<number> {
	const [command = "help", ...rest] = args;
	if (command === "help" || command === "--help") {
		console.log(MCP_USAGE);
		return 0;
	}
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
			server.auth === "oauth" ? "OAuth" : "",
		].filter(Boolean);
		let line = `${server.name}  ${transport}  (${server.source}${extras.length > 0 ? `; ${extras.join("; ")}` : ""})`;
		if (rest.includes("--check")) line += `  → ${await checkServer(server)}`;
		console.log(line);
	}
	for (const diagnostic of diagnostics) console.log(`! ${diagnostic}`);
	return diagnostics.length > 0 ? 1 : 0;
}

export async function runToolCommand(
	name: string,
	args: string[],
	context: { home: string; cwd: string },
): Promise<number> {
	if (name === "credentials") return credentialsCommand(args, context.home);
	if (name === "mcp") return mcpCommand(args, context);
	console.error(`Unknown command ${name}`);
	return 1;
}
