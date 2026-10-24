// tau's own session hub, in this process (P57): the TUI and `--mode rpc` are clients of it over the
// memory transport, as Codex's TUI and exec are clients of an in-process app-server. What both
// need: the hub with the CLI's workspaces, a connected session client, and the first session chosen
// as tau always chose it (a new one, the latest with -c, one named with --session). P58: the TUI
// uses the resident server instead when it can (tui-link.ts); this is what runs when it does not.
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { ThinkingLevel } from "@yophon/tau-kernel";
import { type ClientRequests, createMemoryTransportPair, type ServerRequests, TauClient } from "@yophon/tau-protocol";
import type { CliOptions } from "./args.ts";
import { checkpointBackend } from "./builtins.ts";
import { resolveExtensionFlags } from "./extension-loading.ts";
import type { ModelSwitch } from "./modes/headless.ts";
import type { SessionHub } from "./server/hub.ts";
import type { HubHost, HubThread } from "./server/thread.ts";
import { autoTitleOn, findSession } from "./session-title.ts";
import { savedSessions, TuiSession } from "./tui/session-client.ts";
import { CLI_VERSION } from "./util.ts";
import type { Workspace, WorkspaceSpec } from "./workspace.ts";

/** What the CLI gives its hub (the same host `tau serve` builds). */
export interface LocalHubContext {
	options: CliOptions;
	cwd: string;
	explicitMode: boolean;
	openWorkspace(spec: WorkspaceSpec): Promise<Workspace>;
	modelDisplay(): string;
	modelChoices: readonly string[];
	resolveModelSwitch?: (requested: string) => ModelSwitch;
	setHostModel(model: string): void;
	setHostThinking(level: ThinkingLevel | undefined): void;
}

/** The client of the hub: its name and capabilities, and who answers dialogs until it can. */
export interface LocalHubClient {
	name: string;
	capabilities: NonNullable<ClientRequests["initialize"]["params"]["capabilities"]>;
	/** Answers the session's dialogs until the client takes them over (the trust question while the first session opens). */
	startupUi: (params: ServerRequests["ui/request"]["params"]) => Promise<ServerRequests["ui/request"]["result"]>;
}

export interface LocalHub {
	hub: SessionHub;
	session: TuiSession;
	/** The hub's side of the session shown (rpc reads its workspace). */
	thread(): HubThread;
	/** The command line's words without the extensions' --flags (the extensions are in this process). */
	messages(extras: string[]): string[];
	/** The workspace's background commands (a --worktree's exit asks about running ones). */
	background(): Workspace["background"];
}

/** What a hub in this process is given (the host `tau serve` builds; P60: `--mode acp` builds the same). */
export type InProcessHost = HubHost;

/** P60: a hub in this process, and a client of it over the memory transport. */
export async function startHub(
	host: InProcessHost,
	client: { name: string; capabilities: LocalHubClient["capabilities"] },
): Promise<{ hub: SessionHub; client: TauClient }> {
	const { SessionHub } = await import("./server/hub.ts");
	const hub = new SessionHub(host, { version: CLI_VERSION });
	const [clientEnd, serverEnd] = createMemoryTransportPair();
	hub.connect(serverEnd);
	const tauClient = new TauClient(clientEnd, { name: client.name, version: CLI_VERSION });
	await tauClient.initialize(client.capabilities);
	return { hub, client: tauClient };
}

export async function startLocalHub(context: LocalHubContext, client: LocalHubClient): Promise<LocalHub> {
	const { options } = context;
	const { hub, client: tauClient } = await startHub(
		{
			cwd: context.cwd,
			openWorkspace: context.openWorkspace,
			modelDisplay: context.modelDisplay,
			modelChoices: context.modelChoices,
			...(context.resolveModelSwitch ? { resolveModelSwitch: context.resolveModelSwitch } : {}),
			setHostModel: context.setHostModel,
			setHostThinking: context.setHostThinking,
			restoreSessionModel: !options.model,
			autoTitle: (workspace) => autoTitleOn(workspace.settings().autoTitle),
			checkpoints: checkpointBackend,
			applyDefaultMode: !context.explicitMode,
			...(options.noSession ? { noSession: true } : {}),
		},
		client,
	);
	const session = new TuiSession(tauClient, { cwd: context.cwd });
	tauClient.handle("ui/request", client.startupUi);
	const thread = (): HubThread => {
		const held = hub.loadedThreads.find((candidate) => candidate.id === session.id);
		if (!held) throw new Error("The session closed as it opened.");
		return held;
	};
	return {
		hub,
		session,
		thread,
		messages: (extras) => resolveExtensionFlags(thread().session.extensions, extras).messages,
		background: () => thread().workspace.background,
	};
}

/**
 * The first session: one named with --session (a file, an id or a name), the latest with -c, else a
 * new one. P58: in this client's directory; `opening` (-m, --permission-mode) applies to a session
 * a resident server opens for it.
 */
export async function openFirstSession(
	session: TuiSession,
	options: CliOptions,
	opening: { model?: string; permissionMode?: string } = {},
): Promise<void> {
	const where = session.where();
	if (options.sessionPath !== undefined) {
		// A file path, else an id or name of this directory's sessions, matched as /resume <session> does (P53a, pi).
		const filePath = resolve(options.sessionPath);
		if (existsSync(filePath)) {
			await session.join("thread/import", { path: filePath, copy: false, ...where });
			return;
		}
		const found = findSession(
			savedSessions((await session.client.listThreads(session.cwd)).threads),
			options.sessionPath,
		);
		if (found === undefined || found === "ambiguous") {
			console.error(
				found === "ambiguous"
					? `Error: several sessions match "${options.sessionPath}"; use a longer id or the file path.`
					: `Error: no session matches "${options.sessionPath}" (a file path, or an id or name of this directory's sessions).`,
			);
			process.exit(1);
		}
		await session.join("thread/resume", { threadId: found.id, ...where, ...opening });
		return;
	}
	if (options.continue) {
		const [latest] = savedSessions((await session.client.listThreads(session.cwd)).threads);
		if (latest) {
			await session.join("thread/resume", { threadId: latest.id, ...where, ...opening });
			return;
		}
	}
	await session.join("thread/start", { ...where, ...opening, ...(options.noSession ? { ephemeral: true } : {}) });
}
