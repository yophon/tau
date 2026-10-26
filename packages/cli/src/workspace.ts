// A workspace (P29; P50: split out of main.ts): everything rooted at one working directory —
// the extensions and the project trust decision, settings, the file system and shells,
// permissions, hooks, the audit, project context, the session repo, and building agents.
// The CLI opens one for its working directory; the session hub one per session.
import { existsSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { SUBAGENT_STOP_CHANNEL, type SubagentStopRequest } from "@yophon/tau-ext-subagents";
import {
	findPowerShell,
	NodeBackgroundShell,
	NodeFileSystem,
	NodeImageProcessor,
	NodeShell,
} from "@yophon/tau-host-node";
import type { FallbackOptions, FallbackRoute, SummaryModel, ToolExecutionMode } from "@yophon/tau-kernel";
import {
	Agent,
	type AgentMessage,
	type ApprovalRequest,
	createCodingTools,
	createDefaultPolicy,
	type ExtensionRegistry,
	JsonlSessionRepo,
	loadProjectContextFiles,
	type ModelPricing,
	type PermissionMode,
	type Platform,
	renderProjectContext,
	type SessionRecorder,
	sessionDirSlug,
	type ThinkingLevel,
	type ToolPolicy,
	textResult,
	type UiCapability,
} from "@yophon/tau-kernel";
import type { CliOptions } from "./args.ts";
import { createAskUserExtension } from "./ask-user.ts";
import {
	ApprovalLog,
	type AuditHost,
	AuditLedger,
	type AuditTrigger,
	auditedApproval,
	auditedPolicy,
	createAuditExtension,
} from "./audit.ts";
import { createBackgroundExtension, MONITOR_MAX_MS, MONITOR_PRINT_MAX_MS } from "./background.ts";
import { attachPromptAgent, setSubagentIsolation } from "./builtins.ts";
import { CredentialStore, credentialsPath } from "./credentials.ts";
import type { ActiveEndpoint } from "./endpoint.ts";
import {
	type ClientMcpServer,
	defaultSystemPrompt,
	loadExtensionRegistry,
	resolveExtensionFlags,
	systemPromptSources,
} from "./extension-loading.ts";
import { shadowedContextFile } from "./git-paths.ts";
import { HookRunner } from "./hooks.ts";
import { postToolBatch, withHookApprovals } from "./hooks-extension.ts";
import { createPermissionsExtension } from "./permission-commands.ts";
import { openAlwaysOptions, powershellAllowedBy, WorkspacePermissions } from "./permissions.ts";
import { saveProjectTrust } from "./project-trust.ts";
import { createPushNotificationExtension } from "./push-notification.ts";
import { registerEnvSecrets, scrubEnv } from "./secrets.ts";
import { agentOptionsFromSettings, loadSettings, readSettings, type TauSettings } from "./settings.ts";
import { createStatusLineExtension } from "./statusline.ts";
import { dim, firstLine, userHome } from "./util.ts";
import { followMainTrust, openWorktree, removeWorktree, type WorktreeSession, worktreeState } from "./worktree.ts";
import { type CurrentWorktree, createWorktreeToolsExtension, type WorktreeHost } from "./worktree-tools.ts";

/** What main() and the workspaces share and change during the run (P50). */
export interface RunState {
	/** The host's mode: flag, env, settings, then supervised (P15); /mode changes it. */
	permissionMode: PermissionMode;
	thinkingLevel: ThinkingLevel | undefined;
	/** P37d: the --worktree session, or the one enter_worktree moved into (P46). */
	worktreeSession: WorktreeSession | undefined;
	/** P46: where the session was before enter_worktree. */
	worktreeOriginal: string | undefined;
}

/** What every workspace of the run is opened with: the run's options, endpoint and shared state. */
export interface WorkspaceContext {
	options: CliOptions;
	userSettings: TauSettings;
	platform: Platform;
	endpoint: ActiveEndpoint;
	run: RunState;
	pricing: (model: string) => ModelPricing | undefined;
	/** TAU_MAX_RETRIES / TAU_RETRY_BASE_DELAY_MS. */
	retry: { maxRetries?: number; enabled?: boolean; baseDelayMs?: number };
	toolExecution: ToolExecutionMode | undefined;
	/** The mode came from the flag or the environment (it wins over settings). */
	explicitMode: boolean;
	/** Whether a model takes images (P36d); P61: `model` is the session's own (provider/id or id), absent = the process's. */
	modelTakesImages: (model?: string) => boolean;
	auditHost: AuditHost;
	defaultTrigger: AuditTrigger;
	/** A models.json model (provider/id) as a transport and model, as /model resolves it without switching: compaction.model (P53c), fallback models (P54c). */
	resolveModel?: (ref: string) => (SummaryModel & { label: string }) | { error: string };
}

/** One workspace's directory, UI and host-specific choices. */
export type WorkspaceSpec = {
	cwd: string;
	ui: UiCapability | undefined;
	onApproval: ((request: ApprovalRequest) => Promise<boolean>) | undefined;
	/** A mode for this workspace's agents instead of the host's (a hub session's own, P56). */
	permissionMode?: PermissionMode;
	/** P32b: load ~/.tau/mcp.json servers (default true; the hub's catalog workspace does not). */
	mcp?: boolean;
	/** P60: MCP servers a client brought for this workspace's session (an editor's); a name wins over the configured one. */
	extraMcpServers?: ClientMcpServer[];
	/** P61: the model this workspace's session uses now (the hub's sessions switch models on their own). */
	sessionModel?: () => string | undefined;
	/** P35: ask the trust question through `ui` (default true; false when no client opened the session, P56). */
	trustPrompt?: boolean;
};

/**
 * Everything rooted at one working directory (P29): the extensions and the
 * project trust decision, the filesystem and shell, the project context, the
 * session repo, and building agents. The CLI opens one for process.cwd();
 * ACP opens one per session/new (its cwd, its file access through the client).
 */
export async function openWorkspaceIn(context: WorkspaceContext, spec: WorkspaceSpec) {
	const {
		options,
		userSettings,
		platform,
		endpoint,
		run,
		pricing,
		retry,
		toolExecution,
		explicitMode,
		modelTakesImages,
		auditHost,
		defaultTrigger,
	} = context;
	let cwd = spec.cwd;
	let workspaceMode = spec.permissionMode;
	/** Whether read may send images: the session's model when the hub says which (P61), else the process's. */
	const supportsImages = () => modelTakesImages(spec.sessionModel?.());
	// The audit ledger (P32c): who decided each approval, and a record per run and tool call.
	const approvals = new ApprovalLog();
	const settings = readSettings(join(userHome(), ".tau", "settings.json"));
	// P40c: the settings in force. The user's until the trust decision below, then the layers;
	// ask_user reads askUser.wait from it while it loads.
	let workspaceSettings: TauSettings = settings;
	const auditExtension = createAuditExtension({
		ledger: AuditLedger.at(userHome()),
		host: auditHost,
		workspace: cwd,
		approvals,
		details: settings.auditDetails ?? "summary",
		current: () => ({ trigger: defaultTrigger }),
	});
	const workspaceHost = auditHost;
	const hookRunner = new HookRunner({
		cwd,
		permissionMode: () => workspaceMode ?? run.permissionMode ?? "supervised",
		log: (level, text) => process.stderr.write(`${level === "warning" ? "warning: " : ""}${text}\n`),
		// Notification hooks are for a person at this machine.
		notifications: spec.ui !== undefined,
		idleNotification: workspaceHost === "tui" || workspaceHost === "repl",
		onHookApproval: (toolCallId) => approvals.record(toolCallId, { source: "hook_allow" }),
		// P44 (Claude Code): SessionEnd's reason on exit; Stop and SubagentStop see the background work.
		exitReason: workspaceHost === "tui" || workspaceHost === "repl" ? "prompt_input_exit" : "other",
		backgroundTasks: () =>
			background.list().map((task) => ({
				id: task.id,
				command: task.command,
				status: task.status,
				...(task.description ? { description: task.description } : {}),
			})),
		sessionCrons: () =>
			(scheduling?.scheduler.list() ?? []).map((job) => ({
				id: job.id,
				cron: job.cron,
				prompt: job.prompt,
				recurring: job.recurring,
			})),
	});
	// ask_user (P35) leads the host's extensions: wherever there is someone to ask.
	const askUser =
		spec.ui !== undefined
			? createAskUserExtension({
					wait: () => workspaceSettings.askUserWait === true,
					freeAnswer: true,
					onAsk: () => hookRunner.notify("Tau has a question for you", "elicitation_dialog"),
				})
			: undefined;
	// P43 (pi): the shell tools' commands see their session (TAU_SESSION_*).
	let sessionAgent: Agent | undefined;
	const commandEnv = () => sessionEnvironment(sessionAgent);
	// P36a: background commands, one list per workspace.
	const background = new NodeBackgroundShell(cwd, { env: modelEnvironment(), commandEnv });
	// P44 (Claude Code): /loop and the cron tools in the TUI and the REPL (-p ends before a task
	// could fire); TAU_DISABLE_CRON=1 turns them off. Monitor 10 min at most in -p.
	const scheduling =
		(workspaceHost === "tui" || workspaceHost === "repl") && process.env.TAU_DISABLE_CRON !== "1"
			? (await import("./loop.ts")).createSchedulerExtension({
					home: userHome(),
					cwd,
					projectTrusted: () => projectTrusted,
				})
			: undefined;
	/** P46: what enter_worktree and exit_worktree move; the worktree itself is tracked for the whole process. */
	const worktreeHost: WorktreeHost = {
		cwd: () => cwd,
		current: (): CurrentWorktree | undefined =>
			run.worktreeSession
				? { session: run.worktreeSession, original: run.worktreeOriginal ?? run.worktreeSession.mainRoot }
				: undefined,
		move: async (target, worktree) => {
			if (worktree) await followMainTrust(worktree.session.path, worktree.session.mainRoot);
			run.worktreeSession = worktree?.session;
			run.worktreeOriginal = worktree?.original;
			await moveTo(target);
		},
		settings: () => userSettings.worktree ?? {},
		permissionMode: () => workspaceMode ?? run.permissionMode ?? "supervised",
	};
	const hostExtensions = [
		...(askUser ? [askUser] : []),
		createBackgroundExtension(background, {
			...(scheduling ? { scheduler: scheduling.scheduler } : {}),
			// Like bash, which read-only mode leaves out (createCodingTools).
			...((workspaceMode ?? run.permissionMode) !== "read-only"
				? {
						monitor: {
							maxTimeoutMs:
								workspaceHost === "print" || workspaceHost === "json" ? MONITOR_PRINT_MAX_MS : MONITOR_MAX_MS,
						},
					}
				: {}),
		}),
		...(scheduling ? [scheduling.extension] : []),
		// P46 (Claude Code's EnterWorktree / ExitWorktree).
		...((workspaceHost === "tui" ||
			workspaceHost === "repl" ||
			workspaceHost === "print" ||
			workspaceHost === "json") &&
		(workspaceMode ?? run.permissionMode) !== "read-only"
			? [createWorktreeToolsExtension(worktreeHost)]
			: []),
		// P46 (Claude Code's PushNotification): where a terminal can show it.
		...(workspaceHost === "tui" || workspaceHost === "repl" ? [createPushNotificationExtension()] : []),
	];
	const trustUi = spec.trustPrompt === false ? undefined : spec.ui;
	const loaded = await loadExtensionRegistry(
		cwd,
		trustUi,
		hostExtensions,
		(spec.mcp ?? true) && options.noMcp !== true,
		auditExtension,
		hookRunner,
		workspaceHost === "tui",
		spec.extraMcpServers ?? [],
	);
	const extensions = loaded.registry;
	/** P46: the language servers in use (a reload brings new ones). */
	let currentLsp = loaded.lsp;
	// The trust decision for project resources (ctx.isProjectTrusted, project paths); /reload re-decides.
	let projectTrusted = loaded.projectTrusted;
	// P40c (pi): settings.json in layers, the user's then a trusted project's; /reload reads them again.
	const readWorkspaceSettings = (): TauSettings => loadSettings({ home: userHome(), cwd, projectTrusted });
	workspaceSettings = readWorkspaceSettings();
	// P41b (pi): what replaces and extends the system prompt.
	const readPromptSources = (): { system?: string; append: string[] } =>
		systemPromptSources(cwd, userHome(), projectTrusted, {
			...(options.system !== undefined ? { system: options.system } : {}),
			...(options.appendSystemPrompt ? { append: options.appendSystemPrompt } : {}),
		});
	let promptSources = readPromptSources();
	// Permission rules (P37a): settings files, flags, /permissions; "always allow" saves rules.
	let currentAgent: Agent | undefined;
	const permissions = new WorkspacePermissions({
		home: userHome(),
		cwd,
		// P37d: in a tau worktree, local rules live in the main checkout (Claude Code).
		...(run.worktreeSession && cwd === resolve(run.worktreeSession.path)
			? { localRoot: run.worktreeSession.mainRoot }
			: {}),
		projectTrusted: () => projectTrusted,
		allowedTools: options.allowedTools ?? [],
		disallowedTools: options.disallowedTools ?? [],
		addDirs: options.addDirs ?? [],
		// This session only: other sessions and later ones keep their own mode (Claude Code).
		acceptEdits: () => currentAgent?.setPermissionMode("accept-edits"),
		mode: () => currentAgent?.getPermissionMode() ?? workspaceMode ?? run.permissionMode ?? "supervised",
		onProjectFileWritten: () => {
			if (projectTrusted) void saveProjectTrust(cwd, true);
		},
	});
	for (const diagnostic of permissions.diagnostics()) console.error(dim(`permissions: ${diagnostic}`));
	await extensions.add([createPermissionsExtension(permissions), createStatusLineExtension(userHome())]);
	const policy: ToolPolicy = auditedPolicy(
		createDefaultPolicy({
			rules: () => permissions.rules(),
			workingDirectories: () => permissions.workingDirectories(),
			home: userHome(),
		}),
		approvals,
	);
	// The host's prompt learns what "always allow" would save for each open approval.
	const withAlwaysOption = (handler: ((request: ApprovalRequest) => Promise<boolean>) | undefined): typeof handler =>
		handler
			? async (request) => {
					const option = permissions.alwaysOption(request);
					if (option) openAlwaysOptions.set(request.toolCallId, option);
					try {
						return await handler(request);
					} finally {
						openAlwaysOptions.delete(request.toolCallId);
					}
				}
			: handler;
	// After the hooks are loaded: PermissionRequest hooks may answer before the host asks (P35).
	const onWorkspaceApproval = auditedApproval(
		withHookApprovals(withAlwaysOption(spec.onApproval), hookRunner),
		approvals,
	);
	extensions.setFlagValues(resolveExtensionFlags(extensions, options.extras).values);
	const reloadExtensions = async (reloadUi: UiCapability | undefined): Promise<ExtensionRegistry> => {
		// /reload also re-reads AGENTS.md / CLAUDE.md, as pi's resource loader does.
		projectContext = await loadProjectContext();
		const next = await loadExtensionRegistry(
			cwd,
			spec.trustPrompt === false ? undefined : reloadUi,
			hostExtensions,
			(spec.mcp ?? true) && options.noMcp !== true,
			auditExtension,
			hookRunner,
			workspaceHost === "tui",
			spec.extraMcpServers ?? [],
		);
		projectTrusted = next.projectTrusted;
		currentLsp = next.lsp;
		workspaceSettings = readWorkspaceSettings();
		promptSources = readPromptSources();
		applyShellSettings();
		await next.registry.add([createPermissionsExtension(permissions), createStatusLineExtension(userHome())]);
		next.registry.setFlagValues(resolveExtensionFlags(next.registry, options.extras).values);
		return next.registry;
	};

	const fs = new NodeFileSystem(cwd);
	/** P36d: converts and shrinks images for read and `@file` (pi); P40c: settings' images.autoResize. */
	const imageProcessor = new NodeImageProcessor({
		autoResize: () => workspaceSettings.images?.autoResize !== false,
	});
	// The user's own `!` commands get the full environment; the tools the model calls get it
	// without secret-looking variables (P32b). Secrets are registered first so their values go too.
	const shell = new NodeShell(cwd);
	const toolShell = new NodeShell(cwd, { env: modelEnvironment(), commandEnv });
	// P40b: pi's powershell tool on Windows when PowerShell is installed (Claude Code: on by default).
	const powershellShell =
		findPowerShell() !== undefined
			? new NodeShell(cwd, { env: modelEnvironment(), interpreter: "powershell", commandEnv })
			: undefined;
	const powershellBackground = powershellShell ? background.forPowerShell() : undefined;
	// P46 (Claude Code's isolation: worktree): a subagent's own worktree, with file, bash and PowerShell
	// tools bound there (no background commands, so no monitor); removed when it changed nothing. A
	// resumed subagent reopens the worktree its last run kept.
	setSubagentIsolation(async (agentId, kept) => {
		const settings = userSettings.worktree ?? {};
		// Ids restart in every session, so an earlier session's kept agent-sub-1 is never reopened by a new sub-1.
		const session =
			kept !== undefined && existsSync(kept)
				? openWorktree({ cwd, name: basename(kept), settings })
				: openWorktree({ cwd, name: `agent-${agentId}`, unique: true, settings });
		const childFs = new NodeFileSystem(session.path);
		const childShell = new NodeShell(session.path, { env: modelEnvironment(), commandEnv });
		childShell.options = toolShell.options;
		const childPowershell =
			powershellShell && powershellAllowed()
				? new NodeShell(session.path, { env: modelEnvironment(), interpreter: "powershell", commandEnv })
				: undefined;
		const tools = createCodingTools(
			{
				fs: childFs,
				shell: childShell,
				images: imageProcessor,
				...(childPowershell ? { powershell: { shell: childPowershell } } : {}),
			},
			{ mode: workspaceMode ?? run.permissionMode ?? "supervised", supportsImages },
		);
		return {
			cwd: session.path,
			tools,
			capabilities: {
				fs: childFs,
				shell: childShell,
				paths: { cwd: session.path, userTauDir: join(userHome(), ".tau") },
			},
			unavailable: ["monitor"],
			finish: async () => {
				const state = worktreeState(session);
				if (state.unknown === undefined && state.changedFiles === 0 && state.newCommits === 0) {
					removeWorktree(session);
					return { kept: false, path: session.path, branch: session.branch };
				}
				return { kept: true, path: session.path, branch: session.branch };
			},
		};
	});
	/** P46: a move asked for a reload (settings, AGENTS.md, extensions), which the TUI does when the turn ends. */
	let reloadPending = false;
	/**
	 * P46 (Claude Code's EnterWorktree): the session's working directory moves now — files,
	 * commands, background tasks, permissions, hooks, language servers.
	 */
	const moveTo = async (target: string): Promise<void> => {
		cwd = resolve(target);
		process.chdir(cwd);
		if (fs instanceof NodeFileSystem) fs.moveTo(cwd);
		toolShell.moveTo(cwd);
		powershellShell?.moveTo(cwd);
		background.moveTo(cwd);
		permissions?.moveTo(cwd);
		hookRunner.moveTo(cwd);
		await currentLsp?.moveTo(cwd).catch(() => undefined);
		reloadPending = true;
	};
	/** P40b (pi): shellPath and shellCommandPrefix for bash (the tool, `!` commands, background commands); hooks take the path. */
	function applyShellSettings(): void {
		const { shellPath, shellCommandPrefix } = workspaceSettings;
		if (shellPath !== undefined && !existsSync(shellPath)) throw new Error(`Custom shell path not found: ${shellPath}`);
		const shellOptions = {
			...(shellPath !== undefined ? { shellPath } : {}),
			...(shellCommandPrefix !== undefined ? { commandPrefix: shellCommandPrefix } : {}),
		};
		shell.options = shellOptions;
		toolShell.options = shellOptions;
		background.setShellOptions(shellOptions);
		hookRunner.setShellPath(shellPath);
	}
	applyShellSettings();
	const powershellAllowed = (): boolean => {
		const rules = permissions?.rules();
		return rules === undefined || powershellAllowedBy(rules);
	};
	// Project context files (P21a, pi loadProjectContextFiles): ~/.tau first, then
	// every directory from the root down to cwd. Appended to any system prompt.
	const loadProjectContext = async (): Promise<string> => {
		if (options.noContextFiles) return "";
		const globalDir = join(userHome(), ".tau");
		const files = await loadProjectContextFiles(fs, {
			cwd,
			globalDir,
			// P37d (pi): a nested worktree's own AGENTS.md shadows the main checkout's.
			skip: [shadowedContextFile(cwd)].filter((path): path is string => path !== undefined),
		});
		// P44 (Claude Code): InstructionsLoaded for each file, for the record only.
		for (const file of files) {
			hookRunner.fire(
				"InstructionsLoaded",
				{
					file_path: file.path,
					memory_type: resolve(file.path).startsWith(resolve(globalDir)) ? "User" : "Project",
					load_reason: "session_start",
				},
				undefined,
				"session_start",
			);
		}
		return renderProjectContext(files);
	};
	let projectContext = await loadProjectContext();
	const sessionRepo = new JsonlSessionRepo(
		new NodeFileSystem("/"),
		platform,
		// P40c (pi): --session-dir, then settings' sessionDir (relative to the working directory).
		options.sessionDir ??
			(workspaceSettings.sessionDir !== undefined
				? resolve(cwd, workspaceSettings.sessionDir)
				: join(userHome(), ".tau", "sessions", sessionDirSlug(cwd))),
		cwd,
	);
	const buildAgent = (
		messages: AgentMessage[] | undefined,
		session: SessionRecorder | undefined,
		agentExtensions = extensions,
	): Agent => {
		const mode = workspaceMode ?? run.permissionMode;
		const codingTools = createCodingTools(
			{
				fs,
				shell: toolShell,
				background,
				images: imageProcessor,
				...(powershellShell && powershellAllowed()
					? {
							powershell: {
								shell: powershellShell,
								...(powershellBackground ? { background: powershellBackground } : {}),
							},
						}
					: {}),
			},
			{ mode, supportsImages },
		);
		// P46 (Claude Code's TaskStop): task_stop also stops a background subagent by ID or name.
		const taskStop = codingTools.find((tool) => tool.name === "task_stop");
		if (taskStop) {
			const stopCommand = taskStop.execute.bind(taskStop);
			taskStop.description = `${taskStop.description} Also stops a background subagent by its agent ID (sub-N) or name; send_message can resume it later.`;
			taskStop.execute = async (args, signal, onUpdate, ctx) => {
				const request: SubagentStopRequest = { id: String(args.task_id ?? ""), by: "model", reply: {} };
				agentExtensions.events.emit(SUBAGENT_STOP_CHANNEL, request);
				if (request.reply.result) return textResult(await request.reply.result);
				return stopCommand(args, signal, onUpdate, ctx);
			};
		}
		// P43 (pi bash/powershell guidelines): the commands see TAU_SESSION_*.
		for (const tool of codingTools) {
			if (tool.name !== "bash" && tool.name !== "powershell") continue;
			tool.promptGuidelines = [
				...(tool.promptGuidelines ?? []),
				"You can inspect TAU_SESSION_* environment variables for current model and session details.",
			];
		}
		const built = new Agent({
			config: endpoint.config,
			transport: endpoint.transport,
			platform,
			systemPrompt: [
				promptSources.system ??
					defaultSystemPrompt(
						cwd,
						codingTools.map((tool) => tool.name),
						permissions?.workingDirectories() ?? [],
					),
				// pi: what is appended goes before the project context.
				...promptSources.append,
				projectContext,
			]
				.filter((part) => part !== "")
				.join("\n\n"),
			tools: codingTools,
			extensions: agentExtensions,
			ui: spec.ui,
			capabilities: {
				fs,
				shell: toolShell,
				paths: {
					get cwd() {
						return cwd;
					},
					userTauDir: join(userHome(), ".tau"),
					// Project paths only for a trusted project (defense in depth; extensions also ask ctx).
					...(projectTrusted ? { projectTauDir: join(cwd, ".tau"), projectPiDir: join(cwd, ".pi") } : {}),
				},
			},
			isProjectTrusted: () => projectTrusted,
			// P43 (pi): images tools return (MCP, extensions) are converted and shrunk before they are logged.
			imageProcessor,
			initialMessages: messages,
			session,
			// P40c (pi): settings' retry, compaction, branch summary, queue modes and turn cap; the env wins for retries.
			...agentOptionsFromSettings(workspaceSettings, retry),
			// P53c (yo-agent): continue a cut-off reply; summaries on another model.
			continueAfterLength: workspaceSettings.continueOnMaxTokens === false ? 0 : 3,
			...summaryModelOption(context, workspaceSettings.compaction?.model),
			...fallbackOption(context, workspaceSettings),
			pricing,
			thinkingLevel: run.thinkingLevel,
			permissionMode: mode,
			toolExecution,
			onApproval: onWorkspaceApproval,
			policy,
			// P44 (Claude Code): PostToolBatch after each batch of tool calls.
			finishTurn: async (turn, signal) => {
				const batch = await postToolBatch(hookRunner, turn, signal);
				const send = agentExtensions.hostAction("sendMessage");
				if (batch.context !== undefined) {
					send?.({ customType: "hook_context", content: batch.context, display: false }, { triggerTurn: false });
				}
				if (batch.stop === undefined) return undefined;
				send?.(
					{ customType: "hook_stop", content: `PostToolBatch hook: ${batch.stop}`, display: true },
					{ triggerTurn: false },
				);
				return { action: "end" as const };
			},
		});
		// --tools / --no-tools narrow the active set; a permission mode's missing tools stay missing (D20).
		const active = selectActiveTools(
			built.getAllTools(),
			built.getActiveTools(),
			// P40c (pi): settings' defaultTools, then --tools on top of it.
			toolSelection(workspaceSettings.defaultTools, options.tools),
			options.noTools === true,
		);
		// pi 1.4 (#10785): tool names or --no-tools choose the tools outright; otherwise the
		// selection is a default that a resumed session's tools win over, with --tools
		// +name/-name applied to them.
		const explicitTools =
			options.noTools === true ||
			(options.tools ?? []).some((entry) => !entry.startsWith("+") && !entry.startsWith("-"));
		if (active && explicitTools) built.setActiveTools(active);
		else if (active) built.setDefaultTools(active, options.tools ?? []);
		attachPromptAgent(built, promptSources.system === undefined);
		currentAgent = built;
		sessionAgent = built;
		return built;
	};
	return {
		cwd,
		extensions,
		fs,
		shell,
		sessionRepo,
		buildAgent,
		reloadExtensions,
		/** P46: whether a move asked for a reload since the last call (the TUI reloads after the turn). */
		consumeReload: (): boolean => {
			const pending = reloadPending;
			reloadPending = false;
			return pending;
		},
		/** P36a: this workspace's background commands. */
		background,
		/** P40c: the settings in force (the user's, then a trusted project's), read again on /reload. */
		settings: (): TauSettings => workspaceSettings,
		/** P36d: images for `@file` arguments, as read converts them. */
		images: imageProcessor,
		/** P37a: this workspace's permission rules. */
		permissions,
		/** P37a: settings' permissions.defaultMode, unless --permission-mode or the env chose (ACP applies it per session). */
		defaultMode: (): PermissionMode | undefined => (explicitMode ? undefined : permissions.defaultMode().mode),
		isProjectTrusted: () => projectTrusted,
		/** Agents built later (session switches) use this mode; only for a workspace opened with one. */
		setPermissionMode: (next: PermissionMode) => {
			if (workspaceMode !== undefined) workspaceMode = next;
			else run.permissionMode = next;
		},
	};
}

export type Workspace = Awaited<ReturnType<typeof openWorkspaceIn>>;

/**
 * The tool list from settings' defaultTools and --tools (P40c, pi): a --tools list of only
 * +name/-name changes the settings' list; one with a plain name replaces it.
 */
function toolSelection(
	settings: readonly string[] | undefined,
	flag: readonly string[] | undefined,
): string[] | undefined {
	if (flag === undefined || flag.length === 0) return settings ? [...settings] : undefined;
	if (settings === undefined) return [...flag];
	const modifiers = flag.every((entry) => entry.startsWith("+") || entry.startsWith("-"));
	return modifiers ? [...settings, ...flag] : [...flag];
}

/**
 * The active tool names for --tools/--no-tools (pi 0.84.2 semantics): plain names
 * (or "*") pick the built-in tools; "+name" adds and "-name" removes a tool.
 * Choosing built-ins never drops active extension tools implicitly — only "-name"
 * or --no-tools does. Inactive ones (tool_search, codemode) need "+name" (P24e).
 */
function selectActiveTools(
	all: readonly { name: string; source: "builtin" | "extension" }[],
	active: readonly string[],
	spec: readonly string[] | undefined,
	noTools: boolean,
): string[] | undefined {
	if (noTools) return [];
	if (!spec || spec.length === 0) return undefined;
	const plain = spec.filter((entry) => !entry.startsWith("+") && !entry.startsWith("-"));
	const builtinsKept =
		plain.length === 0 || plain.includes("*")
			? new Set(all.filter((tool) => tool.source === "builtin").map((tool) => tool.name))
			: new Set(plain);
	const wasActive = new Set(active);
	const selected = new Set(
		all
			.filter((tool) => (tool.source === "extension" ? wasActive.has(tool.name) : builtinsKept.has(tool.name)))
			.map((tool) => tool.name),
	);
	for (const entry of spec) {
		if (entry.startsWith("+")) selected.add(entry.slice(1));
		else if (entry.startsWith("-")) selected.delete(entry.slice(1));
	}
	return [...selected];
}

/**
 * The session a shell tool's command runs in (P43): pi's PI_SESSION_ID, PI_SESSION_FILE,
 * PI_PROVIDER, PI_MODEL and PI_REASONING_LEVEL, named TAU_SESSION_* because TAU_PROVIDER and
 * TAU_MODEL already configure tau. Worked out when each command starts; an unset value
 * removes an inherited one (pi), as for a session that is not saved (no file).
 */
function sessionEnvironment(agent: Agent | undefined): Record<string, string | undefined> {
	const session = agent?.extensionContext().sessionManager;
	const level = agent?.thinkingLevel;
	return {
		TAU_SESSION_ID: session?.getSessionId() || undefined,
		TAU_SESSION_FILE: session?.getSessionFile(),
		TAU_SESSION_PROVIDER: agent?.provider,
		TAU_SESSION_MODEL: agent?.model,
		// pi's word for no thinking.
		TAU_SESSION_REASONING_LEVEL: level === "none" ? "off" : level,
	};
}

/**
 * The environment for processes the model drives (P32b): secrets registered for masking
 * (secret-looking variables, the credential store), then scrubbed out.
 */
function modelEnvironment(): Record<string, string> {
	registerEnvSecrets(process.env);
	try {
		new CredentialStore(credentialsPath(userHome())).registerAll();
	} catch {
		// A broken store is reported by tau credentials; the guard still masks what it knows.
	}
	return scrubEnv(process.env, readSettings(join(userHome(), ".tau", "settings.json")).shellEnvAllow);
}

/** compaction.model resolved to a summary model; a model that cannot be resolved is reported once and skipped. */
const reportedSummaryModels = new Set<string>();
function summaryModelOption(context: WorkspaceContext, ref: string | undefined): { summaryModel?: SummaryModel } {
	if (ref === undefined || !context.resolveModel) return {};
	const resolved = context.resolveModel(ref);
	if ("error" in resolved) {
		if (!reportedSummaryModels.has(ref)) {
			reportedSummaryModels.add(ref);
			console.error(dim(`settings: compaction.model "${ref}": ${resolved.error}; summaries use the current model.`));
		}
		return {};
	}
	const { label: _label, ...summaryModel } = resolved;
	return { summaryModel };
}

/** --fallback-model (wins) or settings' fallbackModels, with fallback.on and fallback.enabled (P54c). */
const reportedFallbackModels = new Set<string>();
function fallbackOption(context: WorkspaceContext, settings: TauSettings): { fallback?: FallbackOptions } {
	if (settings.fallback?.enabled === false || !context.resolveModel) return {};
	const refs = context.options.fallbackModels ?? settings.fallbackModels ?? [];
	const routes: FallbackRoute[] = [];
	for (const ref of refs) {
		const resolved = context.resolveModel(ref);
		if ("error" in resolved) {
			if (!reportedFallbackModels.has(ref)) {
				reportedFallbackModels.add(ref);
				console.error(dim(`fallback model "${ref}": ${resolved.error}; skipped.`));
			}
			continue;
		}
		routes.push({ transport: resolved.transport, model: resolved.model, label: resolved.label });
	}
	if (routes.length === 0) return {};
	return {
		fallback: {
			routes,
			...(settings.fallback?.on ? { on: settings.fallback.on } : {}),
			onSwitch: (event) =>
				console.error(
					dim(`Model fallback: ${event.from} → ${event.to} (${event.reason}): ${firstLine(event.message, 120)}`),
				),
		},
	};
}
