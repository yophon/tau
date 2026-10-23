// The TUI on an in-process session hub (P57): the TUI is a client of tau/1 like any other — a hub
// in this process, the memory transport, a session client (local-hub.ts, tui/session-client.ts).
// The first session is chosen as it always was; the hub opens it, asking the project trust question
// through the startup dialogs before the TUI is on screen. P58 puts a resident hub behind a socket.
import { join } from "node:path";
import type { UiCapability } from "@yophon/tau-kernel";
import type { ServerRequests } from "@yophon/tau-protocol";
import { resolveExtensionFlags } from "./extension-loading.ts";
import { initialContent, type ProcessedFiles, processFileArguments } from "./file-args.ts";
import { type LocalHubContext, openFirstSession, startLocalHub } from "./local-hub.ts";
import { type ConfiguredModel, describeModel, findModel, modelRef } from "./models.ts";
import { saveProjectTrust } from "./project-trust.ts";
import { type TauSettings, tuiScreen, writeSectionKey, writeSettings, writeTuiMode } from "./settings.ts";
import { StatusLineRunner, StatusLineSettings } from "./statusline.ts";
import { conversationLength } from "./tui/format.ts";
import { CLI_VERSION, dim } from "./util.ts";
import type { RunState } from "./workspace.ts";
import { finishWorktree } from "./worktree.ts";

export interface TuiHubContext extends LocalHubContext {
	home: string;
	userSettings: TauSettings;
	userSettingsPath: string;
	run: RunState;
	configuredModels: readonly ConfiguredModel[];
	/** What the status line says about the provider (P37c). */
	provider(): string;
	/** Whether the current model takes images (P36d). */
	modelTakesImages(): boolean;
	/** The startup dialogs (the project trust question before the TUI is on screen). */
	ui: UiCapability | undefined;
	/** The session reached its first prompt: from here an exit keeps a --worktree (main.ts). */
	started(): void;
}

export async function runTuiOnHub(context: TuiHubContext): Promise<void> {
	const { options, cwd, home, userSettings, run } = context;
	const local = await startLocalHub(context, {
		name: "tau-tui",
		capabilities: { nativeEvents: true, width: process.stdout.columns ?? 80 },
		startupUi: (params) => startupAnswer(context.ui, params),
	});
	const { hub, session } = local;
	try {
		await openFirstSession(session, options);
	} catch (error) {
		await hub.close();
		throw error;
	}
	if (session.state.lastSessionStart === "resume") {
		const name = session.state.name;
		console.log(dim(`Resumed session (${conversationLength(session.messages)} messages${name ? `, "${name}"` : ""}).`));
	}
	const thread = local.thread();
	const workspace = thread.workspace;
	// P36c (pi): \`@file\` arguments and messages given as words on the command line.
	const messages = resolveExtensionFlags(thread.session.extensions, options.extras).messages;
	let files: ProcessedFiles = { text: "", images: [] };
	if (options.files.length > 0) {
		try {
			files = await processFileArguments(options.files, cwd, workspace.images, {
				pathsOnly: process.env.TAU_DISABLE_FILE_MENTIONS === "1",
			});
		} catch (error) {
			await hub.close();
			console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
			process.exit(1);
		}
		if (files.images.length > 0 && !context.modelTakesImages()) {
			console.error(dim("The current model does not take images: they are sent as a placeholder."));
		}
	}
	context.started();
	const { runTui } = await import("./tui/app.ts");
	const firstPrompt = initialContent(files, messages[0]);
	const configured = context.configuredModels;
	try {
		await runTui({
			session,
			...(firstPrompt !== undefined ? { initialPrompts: [firstPrompt, ...messages.slice(1)] } : {}),
			...(options.resume ? { openResumePicker: true } : {}),
			screen: tuiScreen(options.screen, userSettings.tuiMode),
			saveTuiMode: (mode) => writeTuiMode(context.userSettingsPath, mode),
			dirtyRepoGuard: workspace.settings().dirtyRepoGuard === true,
			// P37c: Claude Code's statusLine, the user's own environment like hooks.
			statusLine: (onLines) =>
				new StatusLineRunner({
					settings: new StatusLineSettings({ home, cwd, projectTrusted: () => workspace.isProjectTrusted() }),
					cwd,
					env: process.env,
					size: () => ({ columns: process.stdout.columns ?? 80, rows: process.stdout.rows ?? 24 }),
					onLines,
				}),
			statusLineContext: () => ({
				projectDir: cwd,
				addedDirs: workspace.permissions?.workingDirectories() ?? [],
				provider: context.provider(),
				version: CLI_VERSION,
				...(run.worktreeSession
					? {
							projectDir: run.worktreeSession.mainRoot,
							worktree: {
								name: run.worktreeSession.name,
								path: run.worktreeSession.path,
								branch: run.worktreeSession.branch,
								originalCwd: run.worktreeSession.mainRoot,
								...(run.worktreeSession.originalBranch ? { originalBranch: run.worktreeSession.originalBranch } : {}),
							},
						}
					: {}),
			}),
			doubleEscapeAction: userSettings.doubleEscapeAction ?? "tree",
			showReasoning: userSettings.showReasoning ?? false,
			saveSetting: (section, key, value) => writeSectionKey(context.userSettingsPath, section, key, value),
			notify: userSettings.tuiNotify ?? "auto",
			terminalTitle: userSettings.tuiTitle !== false,
			...(configured.length > 0
				? {
						modelHints: Object.fromEntries(configured.map((entry) => [modelRef(entry), describeModel(entry)])),
						saveDefaultModel: (ref: string) => {
							const entry = findModel(configured, ref);
							if (!entry || entry === "ambiguous") return false;
							writeSettings(context.userSettingsPath, { defaultProvider: entry.provider, defaultModel: entry.id });
							return true;
						},
					}
				: {}),
			cwd,
			saveTrust: (trusted) => saveProjectTrust(cwd, trusted),
			// P39e: pi's keybindings.json.
			keybindingsPath: join(home, ".tau", "keybindings.json"),
			// P40c: settings' treeFilterMode, branchSummary.skipPrompt and externalEditor.
			settings: workspace.settings,
		});
	} finally {
		// The session ends here: session_shutdown, MCP servers stopped.
		await hub.close();
	}
	if (run.worktreeSession) await finishWorktree(run.worktreeSession, workspace.background);
}

/** A dialog while the session opens (the trust question): the startup dialogs answer it. */
async function startupAnswer(
	ui: UiCapability | undefined,
	params: ServerRequests["ui/request"]["params"],
): Promise<ServerRequests["ui/request"]["result"]> {
	if (!ui) return { cancelled: true };
	const value = (answer: string | undefined) => (answer === undefined ? { cancelled: true } : { value: answer });
	switch (params.kind) {
		case "confirm":
			return { confirmed: await ui.confirm(params.title, params.message) };
		case "select":
			return value(await ui.select(params.title, params.options ?? []));
		case "input":
			return value(await ui.input(params.title, params.placeholder));
		default:
			return { cancelled: true };
	}
}
