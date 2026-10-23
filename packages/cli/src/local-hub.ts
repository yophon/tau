// tau's own session hub, in this process (P57): the TUI and `--mode rpc` are clients of it over the
// memory transport, as Codex's TUI and exec are clients of an in-process app-server. What both
// need: the hub with the CLI's workspaces, a connected session client, and the first session chosen
// as tau always chose it (a new one, the latest with -c, one named with --session). P58 puts a
// resident hub behind a socket instead.
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { ThinkingLevel } from "@yophon/tau-kernel";
import { type ClientRequests, createMemoryTransportPair, type ServerRequests, TauClient } from "@yophon/tau-protocol";
import type { CliOptions } from "./args.ts";
import { checkpointBackend } from "./builtins.ts";
import type { ModelSwitch } from "./modes/headless.ts";
import type { SessionHub } from "./server/hub.ts";
import type { HubThread } from "./server/thread.ts";
import { autoTitleOn, findSession } from "./session-title.ts";
import { savedSessions, TuiSession } from "./tui/session-client.ts";
import { CLI_VERSION } from "./util.ts";
import type { Workspace, WorkspaceSpec } from "./workspace.ts";

/** What the CLI gives its hub (the same host \`tau serve\` builds). */
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

export interface LocalHub {
	hub: SessionHub;
	session: TuiSession;
	/** The hub's side of the session shown (main.ts reads its workspace: flags, images, settings). */
	thread(): HubThread;
}

/**
 * The hub and one connected client. \`startupUi\` answers the session's dialogs until the client
 * takes them over (the project trust question asked while the first session opens).
 */
export async function startLocalHub(
	context: LocalHubContext,
	client: {
		name: string;
		capabilities: NonNullable<ClientRequests["initialize"]["params"]["capabilities"]>;
		startupUi: (params: ServerRequests["ui/request"]["params"]) => Promise<ServerRequests["ui/request"]["result"]>;
	},
): Promise<LocalHub> {
	const { options } = context;
	const { SessionHub } = await import("./server/hub.ts");
	const hub = new SessionHub(
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
		{ version: CLI_VERSION },
	);
	const [clientEnd, serverEnd] = createMemoryTransportPair();
	hub.connect(serverEnd);
	const tauClient = new TauClient(clientEnd, { name: client.name, version: CLI_VERSION });
	await tauClient.initialize(client.capabilities);
	const session = new TuiSession(tauClient);
	tauClient.handle("ui/request", client.startupUi);
	return {
		hub,
		session,
		thread: () => {
			const held = hub.loadedThreads.find((candidate) => candidate.id === session.id);
			if (!held) throw new Error("The session closed as it opened.");
			return held;
		},
	};
}

/** The first session: one named with --session (a file, an id or a name), the latest with -c, else a new one. */
export async function openFirstSession(session: TuiSession, options: CliOptions): Promise<void> {
	if (options.sessionPath !== undefined) {
		// A file path, else an id or name of this directory's sessions, matched as /resume <session> does (P53a, pi).
		const filePath = resolve(options.sessionPath);
		if (existsSync(filePath)) {
			await session.join("thread/import", { path: filePath, copy: false });
			return;
		}
		const found = findSession(savedSessions((await session.client.listThreads()).threads), options.sessionPath);
		if (found === undefined || found === "ambiguous") {
			console.error(
				found === "ambiguous"
					? `Error: several sessions match "${options.sessionPath}"; use a longer id or the file path.`
					: `Error: no session matches "${options.sessionPath}" (a file path, or an id or name of this directory's sessions).`,
			);
			process.exit(1);
		}
		await session.join("thread/resume", { threadId: found.id });
		return;
	}
	if (options.continue) {
		const [latest] = savedSessions((await session.client.listThreads()).threads);
		if (latest) {
			await session.join("thread/resume", { threadId: latest.id });
			return;
		}
	}
	await session.join("thread/start", {});
}
