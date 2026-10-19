// Connectors (P32b): MCP servers from ~/.tau/mcp.json and, in a trusted
// project, .tau/mcp.json — a subset of pi 1.2's format ({ "mcpServers": { … } }).
// Values expand ${VAR}, ${VAR:-default} and ${cred:<name>}. A project file may
// not reference credentials, reads secret-looking variables as empty, and may
// not set toolRisk or auth: a cloned repository cannot send your keys to a
// server it names, or lower the risk of tools it brings (Claude Code, pi).
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { McpServerConfig } from "@yophon/tau-ext-mcp";
import type { RiskLevel } from "@yophon/tau-kernel";
import { CredentialStore, credentialsPath, expandRefs } from "./credentials.ts";
import { stdioServer } from "./secrets.ts";

const EXPOSURES = ["direct", "codemode", "deferred", "hidden"] as const;
const RISKS: readonly RiskLevel[] = ["low", "medium", "high"];
/** Keys a project entry may set on a server of the same name from the user's file (pi). */
const OVERRIDE_KEYS = ["enabled", "exposure", "toolExposure"];

export interface LoadedMcpServer extends McpServerConfig {
	/** Which file declared it. */
	source: string;
	/** Credentials it references (for `tau mcp list`). */
	credentials: string[];
	/** "oauth" for servers that sign in with `tau mcp login`. */
	auth?: "oauth";
	/** Pre-registered OAuth client (optional; dynamic registration otherwise). */
	oauth?: { clientId?: string; clientSecret?: string; scopes?: string[]; callbackPort?: number };
}

export interface McpConfigResult {
	servers: LoadedMcpServer[];
	diagnostics: string[];
}

type Json = Record<string, unknown>;

function readMcpFile(path: string, diagnostics: string[]): Record<string, Json> | undefined {
	if (!existsSync(path)) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(path, "utf8").replace(/^﻿/, ""));
	} catch (error) {
		diagnostics.push(`${path}: ${error instanceof Error ? error.message : String(error)}`);
		return undefined;
	}
	const servers = (parsed as Json | null)?.mcpServers;
	if (!servers || typeof servers !== "object" || Array.isArray(servers)) {
		diagnostics.push(`${path}: expected an object with an "mcpServers" object`);
		return undefined;
	}
	return servers as Record<string, Json>;
}

const strings = (value: unknown): string[] =>
	Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

const stringMap = (value: unknown): Record<string, string> => {
	const out: Record<string, string> = {};
	if (value && typeof value === "object" && !Array.isArray(value)) {
		for (const [key, item] of Object.entries(value)) if (typeof item === "string") out[key] = item;
	}
	return out;
};

export function loadMcpConfig(options: {
	home: string;
	cwd: string;
	projectTrusted: boolean;
	env?: Record<string, string | undefined>;
	/** settings.json shell.envAllow, for stdio servers' environment. */
	envAllow?: readonly string[];
}): McpConfigResult {
	const env = options.env ?? process.env;
	const diagnostics: string[] = [];
	const store = new CredentialStore(credentialsPath(options.home));
	const userPath = join(options.home, ".tau", "mcp.json");
	const projectPath = join(options.cwd, ".tau", "mcp.json");
	const entries = new Map<string, { raw: Json; source: string; user: boolean }>();

	const user = readMcpFile(userPath, diagnostics);
	for (const [name, raw] of Object.entries(user ?? {})) entries.set(name, { raw, source: userPath, user: true });
	if (options.projectTrusted && projectPath !== userPath) {
		for (const [name, raw] of Object.entries(readMcpFile(projectPath, diagnostics) ?? {})) {
			const existing = entries.get(name);
			if (existing) {
				// A project may switch a user server off or change its exposure, nothing else.
				const extra = Object.keys(raw).filter((key) => !OVERRIDE_KEYS.includes(key));
				if (extra.length > 0) {
					diagnostics.push(
						`${projectPath}: server "${name}": a project can only set ${OVERRIDE_KEYS.join(", ")} on a server from ~/.tau/mcp.json`,
					);
					continue;
				}
				existing.raw = { ...existing.raw, ...raw };
				continue;
			}
			entries.set(name, { raw, source: projectPath, user: false });
		}
	} else if (!options.projectTrusted && existsSync(projectPath)) {
		diagnostics.push(`${projectPath}: ignored, the directory is not trusted`);
	}

	const servers: LoadedMcpServer[] = [];
	for (const [name, { raw, source, user: fromUser }] of entries) {
		if (raw.enabled === false) continue;
		const problems: string[] = [];
		const credentials: string[] = [];
		const expand = (value: string): string => {
			const result = expandRefs(value, {
				env,
				credential: (credential) => {
					credentials.push(credential);
					return store.get(credential);
				},
				allowCredentials: fromUser,
			});
			for (const missing of result.missing) problems.push(`\${${missing}} has no value`);
			for (const blocked of result.blocked) {
				problems.push(
					blocked.startsWith("cred:")
						? `\${${blocked}}: credentials can only be used in ~/.tau/mcp.json`
						: `\${${blocked}} reads as empty in a project file`,
				);
			}
			return result.value;
		};
		const expandMap = (value: unknown) =>
			Object.fromEntries(Object.entries(stringMap(value)).map(([key, item]) => [key, expand(item)]));

		const exposure = EXPOSURES.find((candidate) => candidate === raw.exposure);
		const toolExposure = Object.fromEntries(
			Object.entries(stringMap(raw.toolExposure)).filter(([, value]) =>
				(EXPOSURES as readonly string[]).includes(value),
			),
		) as McpServerConfig["toolExposure"];
		const toolRisk = Object.fromEntries(
			Object.entries(stringMap(raw.toolRisk)).filter(([, value]) => (RISKS as readonly string[]).includes(value)),
		) as Record<string, RiskLevel>;
		if (!fromUser && Object.keys(toolRisk).length > 0)
			diagnostics.push(`${source}: server "${name}": toolRisk is ignored in a project file`);

		const base = {
			name,
			source,
			credentials,
			...(exposure ? { exposure } : {}),
			...(toolExposure && Object.keys(toolExposure).length > 0 ? { toolExposure } : {}),
			...(fromUser && Object.keys(toolRisk).length > 0 ? { toolRisk } : {}),
			...(typeof raw.description === "string" ? { description: raw.description } : {}),
			...(typeof raw.timeoutMs === "number" ? { timeoutMs: raw.timeoutMs } : {}),
		};
		let server: LoadedMcpServer;
		if (typeof raw.command === "string") {
			server = stdioServer(
				{
					...base,
					command: expand(raw.command),
					args: strings(raw.args).map(expand),
					env: expandMap(raw.env),
					...(typeof raw.cwd === "string" ? { cwd: expand(raw.cwd) } : {}),
				},
				options.envAllow,
				env,
			);
		} else if (typeof raw.url === "string") {
			const auth = raw.auth === "oauth" ? "oauth" : undefined;
			if (auth && !fromUser) {
				diagnostics.push(`${source}: server "${name}": auth is only allowed in ~/.tau/mcp.json`);
				continue;
			}
			const oauth = raw.oauth && typeof raw.oauth === "object" ? (raw.oauth as Json) : undefined;
			server = {
				...base,
				url: expand(raw.url),
				headers: expandMap(raw.headers),
				...(auth ? { auth } : {}),
				...(oauth
					? {
							oauth: {
								...(typeof oauth.clientId === "string" ? { clientId: expand(oauth.clientId) } : {}),
								...(typeof oauth.clientSecret === "string" ? { clientSecret: expand(oauth.clientSecret) } : {}),
								...(Array.isArray(oauth.scopes) ? { scopes: strings(oauth.scopes) } : {}),
								...(typeof oauth.callbackPort === "number" ? { callbackPort: oauth.callbackPort } : {}),
							},
						}
					: {}),
			};
		} else {
			diagnostics.push(`${source}: server "${name}" needs "command" or "url"`);
			continue;
		}
		if (problems.length > 0) {
			// A server whose credentials are missing or refused is not started half-configured.
			diagnostics.push(`${source}: server "${name}" skipped: ${[...new Set(problems)].join("; ")}`);
			continue;
		}
		servers.push(server);
	}
	return { servers, diagnostics };
}
