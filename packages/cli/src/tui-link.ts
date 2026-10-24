// How the TUI reaches its session (P58), Codex's TUI policy: the resident server when one runs
// (started first when settings daemon.autoStart allows, the default), else a hub in this process
// (P57). --no-daemon, and options that set the session's endpoint, prompt, tools, extensions or
// permission rules (the server's were fixed when it started), run in this process; so does a
// terminal running as administrator on Windows. A server that cannot be used falls back to this
// process with a line saying why; a server of another version is used with a line saying so.
// P60: `tau --mode acp` follows the same policy (residentAllowed, residentClient).
import { spawnSync } from "node:child_process";
import type { ClientRequests, TauClient } from "@yophon/tau-protocol";
import type { CliOptions } from "./args.ts";
import { connectTo, defaultAddress, probeDaemon, startDaemon } from "./daemon.ts";
import { type LocalHub, type LocalHubClient, type LocalHubContext, startLocalHub } from "./local-hub.ts";
import { firstLine } from "./tui/format.ts";
import { TuiSession } from "./tui/session-client.ts";
import { CLI_VERSION } from "./util.ts";

export interface TuiLink {
	session: TuiSession;
	/** The hub in this process (no resident server): what only it can give (extension flags, the worktree). */
	local?: LocalHub;
	/** Lines the TUI shows as it starts (why not the resident server, that it was started, versions). */
	notices: string[];
	/** Leave: a hub in this process stops the session; a resident server keeps it. */
	close(): Promise<void>;
}

/** What decides whether a run uses the resident server, and starts it. */
export interface ResidentContext {
	options: CliOptions;
	home: string;
	/** settings daemon.autoStart (default true, Codex's daemon_auto_start). */
	autoStart: boolean;
	/** Starts the resident server (default: `tau serve start`'s startDaemon; tests serve one themselves). */
	start?: (home: string) => Promise<unknown>;
}

export interface TuiLinkContext extends LocalHubContext, ResidentContext {}

/** The resident server's client, and a new connection to it after a drop (P59). */
export interface ResidentClient {
	client: TauClient;
	reconnect: () => Promise<TauClient | undefined>;
}

/** The options that keep the TUI off the resident server (they configure what the server fixed at its start). */
const EXCLUDING: ReadonlyArray<[keyof CliOptions, string]> = [
	["baseUrl", "--base-url"],
	["apiKey", "--api-key"],
	["provider", "--provider"],
	["models", "--models"],
	["system", "--system-prompt"],
	["appendSystemPrompt", "--append-system-prompt"],
	["contextWindow", "--context-window"],
	["pricing", "--pricing"],
	["allowedTools", "--allowed-tools"],
	["disallowedTools", "--disallowed-tools"],
	["addDirs", "--add-dir"],
	["toolExecution", "--tool-execution"],
	["worktree", "--worktree"],
	["sessionDir", "--session-dir"],
	["fallbackModels", "--fallback-model"],
	["noContextFiles", "--no-context-files"],
	["extensionPaths", "--extension"],
	["noExtensions", "--no-extensions"],
	["noMcp", "--no-mcp"],
	["skillPaths", "--skill"],
	["noSkills", "--no-skills"],
	["promptPaths", "--prompt-template"],
	["noPrompts", "--no-prompt-templates"],
	["tools", "--tools"],
	["noTools", "--no-tools"],
];

/** The option that keeps this run off the resident server, if any (Codex's daemon exclusion). */
export function daemonExclusion(options: CliOptions): string | undefined {
	for (const [key, flag] of EXCLUDING) {
		const value = options[key];
		if (value === undefined || value === false || (Array.isArray(value) && value.length === 0)) continue;
		return flag;
	}
	// An extension's own --flag: extensions are loaded in the server.
	const extensionFlag = options.extras.find((token) => token.startsWith("--"));
	return extensionFlag?.split("=")[0];
}

/** Windows: a terminal running as administrator (high integrity) does not share the server (Codex). */
function elevatedOnWindows(): boolean {
	if (process.platform !== "win32") return false;
	const groups = spawnSync("whoami", ["/groups"], { encoding: "utf8", windowsHide: true });
	return groups.status === 0 && groups.stdout.includes("S-1-16-12288");
}

/** Whether this run may use the resident server; why not goes to `notices` (when it matters). */
export async function residentAllowed(context: ResidentContext, notices: string[]): Promise<boolean> {
	const { options } = context;
	const excluded = options.noDaemon ? undefined : daemonExclusion(options);
	if (!options.noDaemon && excluded === undefined) {
		if (!elevatedOnWindows()) return true;
		notices.push("Running as administrator: the resident server is not used (start tau in a terminal without it).");
	} else if (excluded !== undefined) {
		const running = await connectTo(defaultAddress(context.home), 500);
		if (running) {
			running.socket.destroy();
			notices.push(`Running without the resident server: ${excluded} is set when the server starts.`);
		}
	}
	return false;
}

export async function linkTui(context: TuiLinkContext, client: LocalHubClient): Promise<TuiLink> {
	const notices: string[] = [];
	if (await residentAllowed(context, notices)) {
		const resident = await attach(context, client, notices);
		if (resident) return resident;
	}
	const local = await startLocalHub(context, client);
	return {
		session: local.session,
		local,
		notices,
		close: async () => {
			local.session.leaving = true;
			await local.hub.close();
		},
	};
}

/** The resident server as the TUI's hub, if it can be used. */
async function attach(
	context: TuiLinkContext,
	client: LocalHubClient,
	notices: string[],
): Promise<TuiLink | undefined> {
	const resident = await residentClient(context, client, notices);
	if (!resident) return undefined;
	const tauClient = resident.client;
	const session = new TuiSession(tauClient, { cwd: context.cwd, resident: true, reconnect: resident.reconnect });
	// The project trust question while the first session opens, before the TUI is on screen.
	tauClient.handle("ui/request", client.startupUi);
	return {
		session,
		notices,
		close: async () => {
			session.leaving = true;
			tauClient.close();
		},
	};
}

/** The resident server's client, starting the server first when settings allow; undefined to run here. */
export async function residentClient(
	context: ResidentContext,
	client: { name: string; capabilities: NonNullable<ClientRequests["initialize"]["params"]["capabilities"]> },
	notices: string[],
): Promise<ResidentClient | undefined> {
	const address = defaultAddress(context.home);
	const ask = () => probeDaemon(address, { name: client.name, capabilities: client.capabilities });
	let probe = await ask();
	if (probe.state === "absent") {
		if (!context.autoStart) return undefined;
		try {
			await (context.start ?? ((home: string) => startDaemon({ home })))(context.home);
		} catch (error) {
			notices.push(
				`Could not start the resident server (${firstLine(String((error as Error).message ?? error), 120)}).`,
			);
			return undefined;
		}
		notices.push(
			"Started the resident server in the background (`tau serve stop` stops it; settings daemon.autoStart: false turns this off).",
		);
		probe = await ask();
	}
	if (probe.state === "incompatible") {
		notices.push(`Running without the resident server: ${probe.error}. \`tau serve restart\` runs this version.`);
		return undefined;
	}
	if (probe.state !== "running") return undefined;
	if (probe.version !== CLI_VERSION)
		notices.push(`Resident server v${probe.version} ≠ tau v${CLI_VERSION} · tau serve restart`);
	// P59: after a drop (the server restarts), a new connection to the same address.
	const reconnect = async () => {
		const again = await ask();
		return again.state === "running" ? again.client : undefined;
	};
	return { client: probe.client, reconnect };
}
