#!/usr/bin/env node

import { existsSync, statSync } from "node:fs";

import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";

import {
	type ApprovalRequest,
	defaultPlatform,
	type PermissionMode,
	restoreSession,
	type SessionEntry,
	SessionRecorder,
	type SessionStore,
	type ThinkingLevel,
} from "@yophon/tau-kernel";
import {
	envInt,
	isPermissionMode,
	isToolExecutionMode,
	PERMISSION_MODES,
	parseArgs,
	TOOL_EXECUTION_MODES,
	USAGE,
} from "./args.ts";

import type { AuditHost, AuditTrigger } from "./audit.ts";

import { checkpointBackend, setResourceFlags } from "./builtins.ts";

import {
	type ActiveEndpoint,
	buildEndpoint,
	createModelSwitch,
	createPricing,
	endpointTransport,
	resolveStartupEndpoint,
} from "./endpoint.ts";
import { extensionFlags, resolveExtensionFlags } from "./extension-loading.ts";
import { initialContent, type ProcessedFiles, processFileArguments } from "./file-args.ts";

import {
	availableModels,
	describeModel,
	findModel,
	loadModelsConfig,
	MODELS_EXAMPLE,
	modelRef,
	resolveHeaders,
	type ValueResolver,
} from "./models.ts";
import { HeadlessSession } from "./modes/headless.ts";
import { runJsonMode } from "./modes/json.ts";
import { stdoutWriter } from "./modes/jsonl.ts";
import { type ApprovalChoice, createUi, nestedNote, readlineApprovalPrompt, runRepl, runTurn } from "./modes/repl.ts";
import { RpcUiBridge, runRpcMode } from "./modes/rpc.ts";

import { type HostApprovalRequest, migrateLegacyPermissions, openAlwaysOptions } from "./permissions.ts";
import { saveProjectTrust } from "./project-trust.ts";
import { markActivity } from "./push-notification.ts";

import { autoTitleOn, findSession } from "./session-title.ts";
import { readSettings, tuiScreen, writeSectionKey, writeSettings, writeTuiMode } from "./settings.ts";
import { StatusLineRunner, StatusLineSettings } from "./statusline.ts";
import { conversationLength } from "./tui/format.ts";
import { CLI_VERSION, dim, userHome } from "./util.ts";
import {
	openWorkspaceIn,
	type RunState,
	type Workspace,
	type WorkspaceContext,
	type WorkspaceSpec,
} from "./workspace.ts";
import {
	finishWorktree,
	followMainTrust,
	openWorktree,
	removeWorktree,
	type WorktreeSession,
	worktreeState,
} from "./worktree.ts";

/** All of stdin as text (--mode json takes its prompt there). */
async function readAllStdin(): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of process.stdin) chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
	return Buffer.concat(chunks).toString("utf8");
}

/** The last model_change on a session path (pi restores that model on resume). */
function lastModelChange(path: readonly SessionEntry[]): { provider: string; modelId: string } | undefined {
	for (let i = path.length - 1; i >= 0; i--) {
		const entry = path[i];
		if (entry?.type === "model_change") return { provider: entry.provider, modelId: entry.modelId };
	}
	return undefined;
}

async function main(): Promise<void> {
	// P40a (pi): HTTP_PROXY / HTTPS_PROXY / NO_PROXY and settings.json httpProxy apply to every
	// request, subcommands included. The gateway is parked and stays as it was.
	if (process.argv[2] !== "gateway") {
		// P43 (pi setupCli: AI_AGENT=pi, PI_CODING_AGENT=true): child processes can tell they run
		// inside tau — commands, hooks, the status line, stdio MCP servers.
		process.env.AI_AGENT = "tau";
		process.env.TAU_CODING_AGENT = "true";
		const { applyHttpProxySettings, configureHttpDispatcher, DEFAULT_HTTP_IDLE_TIMEOUT_MS } = await import(
			"./http-dispatcher.ts"
		);
		const network = readSettings(join(userHome(), ".tau", "settings.json"));
		applyHttpProxySettings(network.httpProxy);
		configureHttpDispatcher(network.httpIdleTimeoutMs ?? DEFAULT_HTTP_IDLE_TIMEOUT_MS);
	}
	// `tau credentials …`, `tau mcp …` (P32b) and `tau audit …` (P32c) need neither a model nor the usual options.
	const subcommand = process.argv[2];
	if (subcommand === "credentials" || subcommand === "mcp" || subcommand === "audit") {
		const { runToolCommand } = await import("./tool-commands.ts");
		process.exitCode = await runToolCommand(subcommand, process.argv.slice(3), {
			home: userHome(),
			cwd: resolve(process.cwd()),
		});
		return;
	}
	const options = parseArgs(process.argv.slice(2));
	// The JSON, RPC and ACP modes own stdout: everything else goes to stderr (pi json.md).
	if (options.mode) console.log = (...args: unknown[]) => console.error(...args);
	if (options.help && !options.gateway) {
		console.log(USAGE);
		return;
	}
	// P41b (pi -v): the version alone.
	if (options.version) {
		console.log(CLI_VERSION);
		return;
	}
	// `tau gateway status/allow/login/…` need no model (P30); `run` sets the agent up first.
	if (options.gateway && options.gateway.command !== "run") {
		const { runGatewayCommand } = await import("./gateway.ts");
		process.exitCode = await runGatewayCommand(options.gateway, { home: userHome(), cwd: resolve(process.cwd()) });
		return;
	}

	// The model table (P28): ~/.tau/models.json and the settings defaults. Explicit
	// endpoint flags keep the ad-hoc path; env vars only apply without a usable table.
	const home = userHome();
	const modelsConfig = loadModelsConfig(join(home, ".tau", "models.json"));
	for (const diagnostic of modelsConfig.diagnostics) console.error(`Warning: ${diagnostic}`);
	const userSettingsPath = join(home, ".tau", "settings.json");
	// P37a: the old "always allow" store becomes permission rules, once.
	if (!options.gateway) {
		const moved = migrateLegacyPermissions(home);
		if (moved) console.error(dim(moved));
	}
	// Relative paths on the command line mean the directory tau was started in, even when
	// --worktree moves into the worktree below.
	options.addDirs = (options.addDirs ?? []).map((dir) =>
		resolve(dir === "~" ? home : dir.startsWith("~/") ? join(home, dir.slice(2)) : dir),
	);
	for (const path of options.addDirs) {
		if (!existsSync(path) || !statSync(path).isDirectory()) {
			console.error(`--add-dir: ${path} is not a directory`);
			process.exit(1);
		}
	}
	options.files = options.files.map((file) => resolve(file));
	// P41b (pi): resource paths on the command line mean the directory tau was started in.
	options.extensionPaths = (options.extensionPaths ?? []).map((path) => resolve(path));
	extensionFlags.paths = options.extensionPaths;
	extensionFlags.none = options.noExtensions === true;
	setResourceFlags({
		skillPaths: (options.skillPaths ?? []).map((path) => resolve(path)),
		promptPaths: (options.promptPaths ?? []).map((path) => resolve(path)),
		noSkills: options.noSkills === true,
		noPrompts: options.noPrompts === true,
	});
	if (options.sessionDir) options.sessionDir = resolve(options.sessionDir);
	const userSettings = readSettings(userSettingsPath);
	const valueResolver: ValueResolver = { env: process.env };
	const configuredModels = availableModels(modelsConfig, valueResolver);
	if (options.listModels) {
		if (configuredModels.length === 0) {
			console.log(
				modelsConfig.present
					? `No model in ${modelsConfig.path} has a usable API key.`
					: `No models configured. Create ${modelsConfig.path}, for example:\n${MODELS_EXAMPLE}`,
			);
			return;
		}
		const width = Math.max(...configuredModels.map((entry) => modelRef(entry).length));
		for (const entry of configuredModels) console.log(`${modelRef(entry).padEnd(width)}  ${describeModel(entry)}`);
		return;
	}
	const platform = defaultPlatform();
	const {
		activeModel,
		model,
		provider,
		baseUrl,
		apiKey,
		tableEntry,
		contextWindow,
		modelChoices,
		effectiveBaseUrl,
		defaults: endpointDefaults,
	} = resolveStartupEndpoint({ options, userSettings, modelsConfig, configuredModels, valueResolver });
	const startupEndpoint = buildEndpoint(endpointDefaults, {
		kind: provider,
		label: activeModel?.provider,
		baseUrl,
		apiKey,
		model,
		contextWindow,
		maxTokens: tableEntry?.maxTokens,
		headers: activeModel ? resolveHeaders(activeModel, valueResolver) : {},
		...(activeModel ? { input: activeModel.input ?? ["text"], reasoning: activeModel.reasoning } : {}),
	});
	/** The endpoint the session runs on now; /model's commit replaces it (P28). */
	const endpoint: ActiveEndpoint = {
		activeModel,
		config: startupEndpoint.config,
		native: startupEndpoint.native,
		transport: endpointTransport(platform, startupEndpoint, activeModel),
	};
	// The thinking level travels with every request (P23d); /thinking changes it on the agent.
	const thinkingLevel: ThinkingLevel | undefined = userSettings.defaultThinkingLevel;
	const pricing = createPricing({ fixed: options.pricing, pricedModel: model, configuredModels, endpoint });
	let permissionMode = options.permissionMode;
	if (!permissionMode && process.env.TAU_PERMISSION_MODE) {
		const value = process.env.TAU_PERMISSION_MODE;
		if (isPermissionMode(value)) permissionMode = value;
		else console.error(`Ignoring TAU_PERMISSION_MODE="${value}" (expected one of: ${PERMISSION_MODES.join(", ")})`);
	}
	// A mode from the flag or env wins over settings' permissions.defaultMode (P37a).
	const explicitMode = permissionMode !== undefined;
	// Interactive hosts default to supervised (P15 user ruling) — the kernel's
	// own default stays autonomous for library consumers.
	permissionMode ??= "supervised";
	let toolExecution = options.toolExecution;
	if (!toolExecution && process.env.TAU_TOOL_EXECUTION) {
		const value = process.env.TAU_TOOL_EXECUTION;
		if (isToolExecutionMode(value)) toolExecution = value;
		else console.error(`Ignoring TAU_TOOL_EXECUTION="${value}" (expected one of: ${TOOL_EXECUTION_MODES.join(", ")})`);
	}
	const envMaxRetries = envInt("TAU_MAX_RETRIES", 0) ?? Number.NaN;
	const envRetryDelay = envInt("TAU_RETRY_BASE_DELAY_MS", 1) ?? Number.NaN;
	const retry = {
		...(Number.isFinite(envMaxRetries) && envMaxRetries >= 0
			? { maxRetries: envMaxRetries, enabled: envMaxRetries > 0 }
			: {}),
		...(Number.isFinite(envRetryDelay) && envRetryDelay > 0 ? { baseDelayMs: envRetryDelay } : {}),
	};
	// P37d: --worktree makes the worktree the working directory for everything below.
	let worktreeSession: WorktreeSession | undefined;
	/** P46: where the session was before enter_worktree (a --worktree session came from the main checkout). */
	let worktreeOriginal: string | undefined;
	/** The session reached its first prompt (from here on an exit keeps the worktree, as -p does). */
	let worktreeStarted = false;
	if (options.worktree) {
		if (options.mode === "rpc" || options.mode === "acp" || options.gateway) {
			console.error("--worktree works with the TUI, the REPL, -p and --mode json.");
			process.exit(1);
		}
		try {
			worktreeSession = openWorktree({
				cwd: process.cwd(),
				...(options.worktree.name ? { name: options.worktree.name } : {}),
				settings: userSettings.worktree ?? {},
			});
		} catch (error) {
			console.error(`Error creating worktree: ${error instanceof Error ? error.message : String(error)}`);
			process.exit(1);
		}
		process.chdir(worktreeSession.path);
		await followMainTrust(worktreeSession.path, worktreeSession.mainRoot);
		console.error(dim(`Worktree ${worktreeSession.name} on branch ${worktreeSession.branch}: ${worktreeSession.path}`));
		// A worktree made just now that never got a session (tau exited on a bad argument) goes again.
		if (worktreeSession.created && !worktreeSession.named) {
			const made = worktreeSession;
			process.on("exit", () => {
				if (worktreeStarted) return;
				try {
					const state = worktreeState(made);
					if (state.unknown === undefined && state.changedFiles === 0 && state.newCommits === 0) {
						process.chdir(made.mainRoot);
						removeWorktree(made);
					}
				} catch {
					// Left in place: git worktree remove can clean it up.
				}
			});
		}
	}
	const cwd = resolve(process.cwd());
	const terminal = Boolean(process.stdin.isTTY && process.stdout.isTTY);
	if (options.tui && options.print === undefined && !terminal) {
		console.error("--tui requires a TTY stdin/stdout");
		process.exit(1);
	}
	// On a terminal the TUI is the interactive default (P25); --repl keeps the line-based REPL.
	const useTui =
		options.mode === undefined &&
		options.gateway === undefined &&
		options.print === undefined &&
		!options.repl &&
		(options.tui || terminal);
	// -r/--resume (P53a, pi): the TUI opens /resume's picker; other modes name the session instead.
	if (options.resume) {
		const conflicting = [
			options.continue ? "--continue" : undefined,
			options.sessionPath !== undefined ? "--session" : undefined,
			options.noSession ? "--no-session" : undefined,
		].filter((flag): flag is string => flag !== undefined);
		if (conflicting.length > 0) {
			console.error(`Error: --resume cannot be combined with ${conflicting.join(", ")}`);
			process.exit(1);
		}
		if (!useTui) {
			console.error(
				"Error: --resume picks a session in the TUI. Elsewhere name it with --session <id|name|path>, or use --continue for the latest.",
			);
			process.exit(1);
		}
	}
	// The audit's host and default trigger (P32c); the gateway sets its own per conversation.
	const auditHost: AuditHost =
		options.gateway !== undefined
			? "gateway"
			: (options.mode ?? (options.print !== undefined ? "print" : useTui ? "tui" : "repl"));
	const defaultTrigger: AuditTrigger =
		options.mode === "rpc" ? { type: "rpc" } : options.mode === "acp" ? { type: "acp" } : { type: "user" };
	// The JSON, RPC and ACP modes read stdin themselves (or not at all).
	const readline =
		useTui || options.mode !== undefined || options.gateway !== undefined
			? undefined
			: createInterface({ input: process.stdin, output: process.stdout });
	// P46: push_notification is not sent while you are typing at the REPL (any key or pasted
	// text; a line that answers a question emits no "line" event).
	if (readline) process.stdin.on("data", () => markActivity());
	const out = stdoutWriter();
	const rpcBridge = options.mode === "rpc" ? new RpcUiBridge(out) : undefined;
	// Read stdin from the start: the project trust question below is asked through the bridge.
	rpcBridge?.listen(process.stdin);
	// Before anything imports Ink: a shell exporting CI must not leave the TUI blank.
	if (useTui) await (await import("./tui/ink-env.ts")).loadInk();
	// Headless stdin (pipes, CI) cannot answer prompts; omit the UI capability
	// so extensions take their no-UI degradation path instead of hanging.
	const ui = rpcBridge
		? rpcBridge.ui
		: useTui
			? (await import("./tui/startup.ts")).createStartupUi()
			: readline && process.stdin.isTTY
				? createUi(readline)
				: undefined;
	const resolveModelSwitch = createModelSwitch({
		endpoint,
		configuredModels,
		valueResolver,
		contextWindowFlag: options.contextWindow,
		platform,
		defaults: endpointDefaults,
	});
	// Approval plumbing (P15): the kernel decides *when* to ask, the host owns
	// *how*. REPL and TUI install their prompt into approvalPromptRef below;
	// with no UI at all onApproval stays undefined so the kernel's headless
	// degradation (ask → deny) applies.
	const approvalPromptRef: { current?: (request: HostApprovalRequest) => Promise<ApprovalChoice> } = {};
	const onApproval =
		ui === undefined
			? undefined
			: async (request: ApprovalRequest): Promise<boolean> => {
					// What "always allow" means for this call (P37a): rules to save, or edits for the session.
					const always = openAlwaysOptions.get(request.toolCallId);
					const hostRequest: HostApprovalRequest = always
						? { ...request, always: { label: always.label, kind: always.kind } }
						: request;
					const choice = approvalPromptRef.current
						? await approvalPromptRef.current(hostRequest)
						: (await ui.confirm(
									`Allow ${request.toolName}? (${request.risk} risk${nestedNote(request)})`,
									request.reason,
								))
							? "once"
							: "deny";
					if (choice === "always") always?.apply();
					return choice !== "deny";
				};
	// RPC: approvals are a select on the client (P29).
	if (rpcBridge) approvalPromptRef.current = (request) => rpcBridge.approve(request);
	if (readline && ui) {
		// Readline prompt shared by the REPL and one-shot TTY runs; the TUI
		// replaces it with a selector via setApprovalPrompt.
		approvalPromptRef.current = readlineApprovalPrompt;
	}
	/** Whether the current model takes images (P36d: read says so when it does not). */
	const modelTakesImages = (): boolean =>
		endpoint.config.input === undefined || endpoint.config.input.includes("image");
	/** What main() and the workspaces share and change during the run (P50): /mode, /thinking, enter_worktree. */
	const run: RunState = { permissionMode, thinkingLevel, worktreeSession, worktreeOriginal };
	const workspaceContext: WorkspaceContext = {
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
		// compaction.model (P53c) and fallback models (P54c), resolved as /model would (without switching).
		resolveModel: (ref) => {
			const resolved = resolveModelSwitch(ref);
			if ("error" in resolved) return resolved;
			if (!resolved.options.transport) return { error: "not a model in ~/.tau/models.json" };
			return {
				transport: resolved.options.transport,
				model: resolved.model,
				label: resolved.display,
				...(resolved.options.maxOutputTokens !== undefined
					? { maxOutputTokens: resolved.options.maxOutputTokens }
					: {}),
			};
		},
	};
	const openWorkspace = (spec: WorkspaceSpec) => openWorkspaceIn(workspaceContext, spec);
	const modelDisplay = (): string =>
		endpoint.activeModel
			? modelRef({ provider: endpoint.activeModel.provider, id: endpoint.config.model })
			: endpoint.config.model;
	const tableEntries = configuredModels.map((entry) => ({
		provider: entry.provider,
		id: entry.id,
		...(entry.name ? { name: entry.name } : {}),
		...(entry.contextWindow ? { contextWindow: entry.contextWindow } : {}),
		...(entry.maxTokens ? { maxTokens: entry.maxTokens } : {}),
		reasoning: entry.reasoning,
	}));
	const hostSetters = {
		setHostModel: (nextModel: string) => {
			endpoint.config.model = nextModel;
			if (endpoint.native) endpoint.native.config.model = nextModel;
		},
		setHostThinking: (nextLevel: ThinkingLevel | undefined) => {
			run.thinkingLevel = nextLevel;
		},
		setHostPermissionMode: (nextMode: PermissionMode) => {
			run.permissionMode = nextMode;
		},
	};
	if (options.gateway) {
		// One workspace per chat conversation (P30). Loaded on demand with the channels.
		const { runGateway } = await import("./gateway.ts");
		await runGateway(options.gateway, {
			home,
			cwd,
			env: process.env,
			openWorkspace,
			modelDisplay,
			modelChoices,
			...(configuredModels.length > 0 ? { resolveModelSwitch } : {}),
			supportsImages: () => endpoint.activeModel?.input?.includes("image") === true,
		});
		return;
	}
	if (options.mode === "acp") {
		// One workspace per session/new, at the client's cwd (P29). Loaded on demand: it pulls in the MCP client.
		const { runAcpMode } = await import("./modes/acp.ts");
		const { loadMcpConfig, withOAuth } = await import("./mcp-config.ts");
		await runAcpMode({
			out,
			host: {
				openWorkspace,
				// P41b (pi --no-mcp): no servers at all, the editor's included.
				...(options.noMcp === true ? { noMcp: true } : {}),
				configuredMcpServers: (serverCwd, projectTrusted) => {
					const loaded = loadMcpConfig({
						home: userHome(),
						cwd: serverCwd,
						projectTrusted,
						envAllow: readSettings(join(userHome(), ".tau", "settings.json")).shellEnvAllow ?? [],
					});
					for (const diagnostic of loaded.diagnostics) console.error(`mcp: ${diagnostic}`);
					return withOAuth(loaded.servers, userHome());
				},
				modelDisplay,
				modelChoices,
				...(configuredModels.length > 0 ? { resolveModelSwitch } : {}),
				version: CLI_VERSION,
			},
		});
		return;
	}
	const workspace: Workspace = await openWorkspace({ cwd, ui, onApproval });
	const { extensions, sessionRepo, shell, buildAgent, reloadExtensions } = workspace;
	// settings' permissions.defaultMode (P37a), unless --permission-mode or the env chose.
	if (!explicitMode && workspace.permissions) {
		const { mode: settingsMode, warnings } = workspace.permissions.defaultMode();
		for (const warning of warnings) console.error(dim(`permissions: ${warning}`));
		if (settingsMode) run.permissionMode = settingsMode;
	}
	// P36c (pi): `@file` arguments and messages given as words on the command line.
	const messages = resolveExtensionFlags(extensions, options.extras).messages;
	if ((options.mode === "rpc" || options.mode === "json") && messages.length > 0) {
		console.error(`Unexpected argument: ${messages[0]} (--mode ${options.mode} takes the prompt with -p or on stdin)`);
		process.exit(1);
	}
	if (options.mode === "rpc" && options.files.length > 0) {
		console.error("@file arguments are not supported in --mode rpc.");
		process.exit(1);
	}
	let files: ProcessedFiles = { text: "", images: [] };
	if (options.files.length > 0) {
		try {
			files = await processFileArguments(options.files, cwd, workspace.images, {
				pathsOnly: process.env.TAU_DISABLE_FILE_MENTIONS === "1",
			});
		} catch (error) {
			console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
			process.exit(1);
		}
		if (files.images.length > 0 && !modelTakesImages()) {
			console.error(dim("The current model does not take images: they are sent as a placeholder."));
		}
	}
	let store: SessionStore | undefined;
	let sessionReason: "startup" | "resume" = "startup";
	let initialMessages = undefined as Awaited<ReturnType<typeof restoreSession>>["messages"] | undefined;
	if (!options.noSession) {
		if (options.sessionPath !== undefined) {
			// A file path, else an id or name of this directory's sessions, matched as /resume <session> does (P53a, pi).
			const filePath = resolve(options.sessionPath);
			if (existsSync(filePath)) {
				store = await sessionRepo.open({ id: "", cwd, timestamp: "", filePath });
			} else {
				const found = findSession(await sessionRepo.list(), options.sessionPath);
				if (found === undefined || found === "ambiguous") {
					console.error(
						found === "ambiguous"
							? `Error: several sessions match "${options.sessionPath}"; use a longer id or the file path.`
							: `Error: no session matches "${options.sessionPath}" (a file path, or an id or name of this directory's sessions).`,
					);
					process.exit(1);
				}
				store = await sessionRepo.open(found);
			}
			sessionReason = "resume";
		} else if (options.continue) {
			const sessions = await sessionRepo.list();
			if (sessions.length > 0) {
				store = await sessionRepo.open(sessions[0]);
				sessionReason = "resume";
			}
		}
		if (store) {
			const restored = await restoreSession(store);
			initialMessages = restored.messages;
			// The session's last model, when the table has it (pi restores the model on resume).
			const last = lastModelChange(await store.getPathToRoot(await store.getLeafId()));
			if (last && !options.model && configuredModels.length > 0) {
				const entry = configuredModels.find(
					(candidate) => candidate.provider === last.provider && candidate.id === last.modelId,
				);
				if (entry && (entry.provider !== endpoint.activeModel?.provider || entry.id !== endpoint.config.model)) {
					const restoredModel = resolveModelSwitch(modelRef(entry));
					if (!("error" in restoredModel)) restoredModel.commit();
				}
			}
			console.log(
				dim(
					`Resumed session (${conversationLength(restored.messages)} messages${restored.name ? `, "${restored.name}"` : ""}).`,
				),
			);
		} else {
			store = await sessionRepo.create();
		}
	}
	const recorder = store ? await SessionRecorder.open(store) : undefined;
	/** Session ids whose title was requested (P34f). */
	const titled = new Set<string>();

	const agent = buildAgent(initialMessages, recorder);
	worktreeStarted = true;

	if (options.mode === "json") {
		const typed = options.print ?? (process.stdin.isTTY ? "" : (await readAllStdin()).trim());
		const prompt = initialContent(files, typed === "" ? undefined : typed);
		if (prompt === undefined) {
			console.error("--mode json needs a prompt: -p <prompt>, or the prompt on stdin.");
			process.exit(1);
		}
		process.exitCode = await runJsonMode({ agent, extensions, store, cwd, prompt, sessionReason, out });
		return;
	}

	if (options.mode === "rpc" && rpcBridge) {
		const session = new HeadlessSession(
			{
				workspace,
				modelDisplay: modelDisplay(),
				modelChoices,
				...(configuredModels.length > 0 ? { resolveModelSwitch } : {}),
				onNotice: (level, text) => rpcBridge.ui.notify(text, level),
				...hostSetters,
			},
			agent,
			store,
			recorder,
		);
		await runRpcMode({ session, bridge: rpcBridge, out, cwd, models: tableEntries, sessionReason });
		return;
	}

	if (options.print !== undefined) {
		if (!readline) throw new Error("print mode requires readline");
		// -p is one shot: no submitPrompt/resumeTurn, so an extension cannot start a second run.
		await extensions.notifySessionStart(sessionReason, agent.extensionContext());
		// The files and -p first, then any further messages, one run each (pi).
		let ok = await runTurn(agent, initialContent(files, options.print) ?? options.print, readline);
		for (const message of messages) {
			if (!ok) break;
			ok = await runTurn(agent, message, readline);
		}
		await extensions.notifySessionShutdown("quit", agent.extensionContext());
		readline.close();
		// Scripts read the exit code: an error, abort or truncated reply is a failure (pi print mode).
		if (!ok) process.exitCode = 1;
		return;
	}

	if (useTui) {
		const { runTui } = await import("./tui/app.ts");
		const firstPrompt = initialContent(files, messages[0]);
		await runTui({
			agent,
			extensions,
			...(firstPrompt !== undefined ? { initialPrompts: [firstPrompt, ...messages.slice(1)] } : {}),
			...(options.resume ? { openResumePicker: true } : {}),
			screen: tuiScreen(options.screen, userSettings.tuiMode),
			saveTuiMode: (mode) => writeTuiMode(userSettingsPath, mode),
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
				provider: endpoint.activeModel?.provider ?? endpoint.config.provider ?? "openai-compat",
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
			// P55c: /rewind restores code from the session's checkpoints.
			checkpoints: checkpointBackend,
			doubleEscapeAction: userSettings.doubleEscapeAction ?? "tree",
			showReasoning: userSettings.showReasoning ?? false,
			saveSetting: (section, key, value) => writeSectionKey(userSettingsPath, section, key, value),
			autoTitle: autoTitleOn(workspace.settings().autoTitle),
			notify: userSettings.tuiNotify ?? "auto",
			terminalTitle: userSettings.tuiTitle !== false,
			model: endpoint.activeModel
				? modelRef({ provider: endpoint.activeModel.provider, id: endpoint.config.model })
				: endpoint.config.model,
			modelChoices,
			...(configuredModels.length > 0
				? {
						modelHints: Object.fromEntries(configuredModels.map((entry) => [modelRef(entry), describeModel(entry)])),
						resolveModelSwitch,
						saveDefaultModel: (ref: string) => {
							const entry = findModel(configuredModels, ref);
							if (!entry || entry === "ambiguous") return false;
							writeSettings(userSettingsPath, { defaultProvider: entry.provider, defaultModel: entry.id });
							return true;
						},
					}
				: {}),
			baseUrl: endpoint.config.baseUrl,
			cwd,
			contextWindow: endpoint.config.contextWindow,
			permissionMode: run.permissionMode,
			sessionRepo,
			shell,
			store,
			recorder,
			thinkingLevel: run.thinkingLevel,
			setModel: (nextModel) => {
				// Agents built later (/reload, /resume) start from the switched model.
				endpoint.config.model = nextModel;
				if (endpoint.native) endpoint.native.config.model = nextModel;
			},
			setThinkingLevel: (nextLevel) => {
				run.thinkingLevel = nextLevel;
			},
			setPermissionMode: (nextMode) => {
				// Agents built later (/reload, /resume) start from the switched mode.
				run.permissionMode = nextMode;
			},
			saveTrust: (trusted) => saveProjectTrust(cwd, trusted),
			// P39d: Ctrl+B moves the running bash command to the background.
			background: workspace.background,
			// P39e: pi's keybindings.json.
			keybindingsPath: join(home, ".tau", "keybindings.json"),
			// P40c: settings' treeFilterMode, branchSummary.skipPrompt and externalEditor.
			settings: workspace.settings,
			setApprovalPrompt: (prompt) => {
				approvalPromptRef.current = prompt;
			},
			buildAgent,
			reloadExtensions,
			consumeReload: workspace.consumeReload,
			sessionReason,
		});
		if (run.worktreeSession) await finishWorktree(run.worktreeSession, workspace.background);
		return;
	}

	if (!readline) throw new Error("interactive REPL requires readline");
	await runRepl({
		readline,
		agent,
		buildAgent,
		extensions,
		workspace,
		ui,
		sessionRepo,
		store,
		recorder,
		sessionReason,
		files,
		messages,
		banner: { model, baseUrl: effectiveBaseUrl, provider, cwd, permissionMode: run.permissionMode },
		contextWindow,
		terminalStatus: userSettings.tuiTitle !== false,
		titled,
		worktreeSession: run.worktreeSession,
	});
}

await main();
