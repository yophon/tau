// Language server configuration in Claude Code's .lsp.json shape (plugins/components
// "LSP servers", plugins/manifest-reference "lspServers"): a flat map of server name
// to config. Each config is a strict object — an unknown key or a bad value makes the
// whole file invalid, as Claude Code skips the file.

export interface LspServerConfig {
	/** Program started by name from PATH (or an absolute path); arguments go in `args`. */
	command: string;
	args?: string[];
	/** File extension (with the dot) → LSP language id. At least one entry. */
	extensionToLanguage: Record<string, string>;
	/** Accepted for Claude Code compatibility; every server runs over stdio, as there. */
	transport?: "stdio" | "socket";
	env?: Record<string, string>;
	/** Sent in the `initialize` request. */
	initializationOptions?: unknown;
	/** Sent with `workspace/didChangeConfiguration` after `initialized`. */
	settings?: unknown;
	/** Working directory and root of the server; defaults to the session's directory. */
	workspaceFolder?: string;
	/** ms the `initialize` handshake may take (default 30000). */
	startupTimeout?: number;
	/** ms between `shutdown` and killing the process (default 5000). */
	shutdownTimeout?: number;
	/** ms each request may take (default 60000). */
	requestTimeout?: number;
	/** Restart a crashed server on its next use (default true). */
	restartOnCrash?: boolean;
	/** Restarts before giving up (default 3). */
	maxRestarts?: number;
	/** false: ignore the server's diagnostics; the lsp tool still uses it (default true). */
	diagnostics?: boolean;
}

export const DEFAULT_STARTUP_TIMEOUT_MS = 30_000;
export const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5_000;
export const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
export const DEFAULT_MAX_RESTARTS = 3;

export interface ParsedLspConfig {
	servers: Record<string, LspServerConfig>;
	/** Why the file was not loaded; `servers` is empty then. */
	error?: string;
}

const KNOWN_KEYS = new Set([
	"command",
	"args",
	"extensionToLanguage",
	"transport",
	"env",
	"initializationOptions",
	"settings",
	"workspaceFolder",
	"startupTimeout",
	"shutdownTimeout",
	"requestTimeout",
	"restartOnCrash",
	"maxRestarts",
	"diagnostics",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringRecord(value: unknown): value is Record<string, string> {
	return isRecord(value) && Object.values(value).every((item) => typeof item === "string");
}

function isPositiveInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && value > 0;
}

/** An absolute path may contain spaces; a bare command name may not (its arguments belong in `args`). */
function isAbsoluteCommand(command: string): boolean {
	return command.startsWith("/") || /^[A-Za-z]:[\\/]/.test(command) || command.startsWith("\\\\");
}

/** Why one server config is invalid, or undefined when it is valid. */
function problemOf(config: unknown): string | undefined {
	if (!isRecord(config)) return "must be an object";
	for (const key of Object.keys(config)) {
		if (!KNOWN_KEYS.has(key)) return `unknown field "${key}"`;
	}
	const { command, args, extensionToLanguage } = config;
	if (typeof command !== "string" || command.trim() === "") return '"command" must be a non-empty string';
	if (/\s/.test(command) && !isAbsoluteCommand(command)) {
		return '"command" must not contain spaces; put arguments in "args"';
	}
	if (args !== undefined && !(Array.isArray(args) && args.every((arg) => typeof arg === "string"))) {
		return '"args" must be an array of strings';
	}
	if (!isStringRecord(extensionToLanguage) || Object.keys(extensionToLanguage).length === 0) {
		return '"extensionToLanguage" must map at least one extension to a language id';
	}
	for (const extension of Object.keys(extensionToLanguage)) {
		if (!extension.startsWith(".") || extension.length < 2) {
			return `extension "${extension}" must start with "." (for example ".ts")`;
		}
	}
	if (config.transport !== undefined && config.transport !== "stdio" && config.transport !== "socket") {
		return '"transport" must be "stdio" or "socket"';
	}
	if (config.env !== undefined && !isStringRecord(config.env)) return '"env" must map names to strings';
	if (config.workspaceFolder !== undefined && typeof config.workspaceFolder !== "string") {
		return '"workspaceFolder" must be a string';
	}
	for (const key of ["startupTimeout", "shutdownTimeout", "requestTimeout"] as const) {
		if (config[key] !== undefined && !isPositiveInteger(config[key])) return `"${key}" must be a positive integer (ms)`;
	}
	for (const key of ["restartOnCrash", "diagnostics"] as const) {
		if (config[key] !== undefined && typeof config[key] !== "boolean") return `"${key}" must be true or false`;
	}
	const { maxRestarts } = config;
	if (
		maxRestarts !== undefined &&
		!(typeof maxRestarts === "number" && Number.isInteger(maxRestarts) && maxRestarts >= 0)
	) {
		return '"maxRestarts" must be a whole number';
	}
	return undefined;
}

/**
 * Validate a parsed .lsp.json (Claude Code): all servers or none. `source` names the
 * file in the error.
 */
export function parseLspConfig(value: unknown, source: string): ParsedLspConfig {
	if (!isRecord(value)) {
		return { servers: {}, error: `Invalid LSP server config for "${source}": expected an object of servers` };
	}
	const servers: Record<string, LspServerConfig> = {};
	for (const [name, config] of Object.entries(value)) {
		const problem = problemOf(config);
		if (problem !== undefined) {
			return { servers: {}, error: `Invalid LSP server config for "${source}": server "${name}" ${problem}` };
		}
		servers[name] = config as unknown as LspServerConfig;
	}
	return { servers };
}

/** The extension Claude Code routes a file by: the last dot of the name on, lowercased. */
export function fileExtension(path: string): string {
	const name = path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1);
	const dot = name.lastIndexOf(".");
	return dot <= 0 ? "" : name.slice(dot).toLowerCase();
}
