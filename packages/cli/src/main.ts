#!/usr/bin/env node

import { existsSync, statSync } from "node:fs";

import { basename, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import {
	ANTHROPIC_DEFAULT_BASE_URL,
	ANTHROPIC_MESSAGES_API,
	type AnthropicTransportConfig,
	createAnthropicTransport,
	defaultMaxTokens,
} from "@yophon/tau-ext-provider-anthropic";
import { SUBAGENT_STOP_CHANNEL, type SubagentStopRequest } from "@yophon/tau-ext-subagents";
import {
	findPowerShell,
	NodeBackgroundShell,
	NodeFileSystem,
	NodeImageProcessor,
	NodeShell,
} from "@yophon/tau-host-node";
import {
	Agent,
	type AgentMessage,
	type ApprovalRequest,
	type ChatTransport,
	createCodingTools,
	createDefaultPolicy,
	createOpenAICompatTransport,
	defaultPlatform,
	type Extension,
	type ExtensionRegistry,
	type FileSystem,
	JsonlSessionRepo,
	loadProjectContextFiles,
	type ModelPricing,
	type OpenAICompatConfig,
	type PermissionMode,
	renderProjectContext,
	restoreSession,
	type SessionEntry,
	SessionRecorder,
	type SessionStore,
	type SetModelOptions,
	sessionDirSlug,
	type ThinkingLevel,
	type ToolPolicy,
	textResult,
	type UiCapability,
} from "@yophon/tau-kernel";
import {
	envInt,
	isPermissionMode,
	isProvider,
	isToolExecutionMode,
	PERMISSION_MODES,
	PROVIDERS,
	type ProviderKind,
	parseArgs,
	parsePricing,
	splitList,
	TOOL_EXECUTION_MODES,
	USAGE,
} from "./args.ts";
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
import { attachPromptAgent, setResourceFlags, setSubagentIsolation } from "./builtins.ts";
import { CredentialStore, credentialsPath } from "./credentials.ts";

import {
	defaultSystemPrompt,
	extensionFlags,
	loadExtensionRegistry,
	resolveExtensionFlags,
	systemPromptSources,
} from "./extension-loading.ts";
import { initialContent, type ProcessedFiles, processFileArguments } from "./file-args.ts";
import { shadowedContextFile } from "./git-paths.ts";
import { HookRunner, postToolBatch, withHookApprovals } from "./hooks.ts";
import type { MemoryScope } from "./memory.ts";
import {
	availableModels,
	type ConfiguredModel,
	chooseStartupModel,
	describeModel,
	findModel,
	loadModelsConfig,
	MODELS_EXAMPLE,
	modelPricing,
	modelRef,
	resolveConfigValue,
	resolveHeaders,
	type ValueResolver,
} from "./models.ts";
import { HeadlessSession } from "./modes/headless.ts";
import { runJsonMode } from "./modes/json.ts";
import { stdoutWriter } from "./modes/jsonl.ts";
import { type ApprovalChoice, createUi, nestedNote, readlineApprovalPrompt, runRepl, runTurn } from "./modes/repl.ts";
import { RpcUiBridge, runRpcMode } from "./modes/rpc.ts";
import { createPermissionsExtension } from "./permission-commands.ts";
import {
	type HostApprovalRequest,
	migrateLegacyPermissions,
	openAlwaysOptions,
	powershellAllowedBy,
	WorkspacePermissions,
} from "./permissions.ts";
import { saveProjectTrust } from "./project-trust.ts";
import { createPushNotificationExtension, markActivity } from "./push-notification.ts";
import { registerEnvSecrets, scrubEnv } from "./secrets.ts";
import { autoTitleOn } from "./session-title.ts";
import {
	agentOptionsFromSettings,
	loadSettings,
	readSettings,
	type TauSettings,
	tuiScreen,
	withoutP40Keys,
	writeSectionKey,
	writeSettings,
	writeTuiMode,
} from "./settings.ts";
import { createStatusLineExtension, StatusLineRunner, StatusLineSettings } from "./statusline.ts";
import { conversationLength } from "./tui/controller.ts";
import { CLI_VERSION, dim, userHome } from "./util.ts";
import {
	finishWorktree,
	followMainTrust,
	openWorktree,
	removeWorktree,
	type WorktreeSession,
	worktreeState,
} from "./worktree.ts";
import { type CurrentWorktree, createWorktreeToolsExtension, type WorktreeHost } from "./worktree-tools.ts";

/**
 * The active tool names for --tools/--no-tools (pi 0.84.2 semantics): plain names
 * (or "*") pick the built-in tools; "+name" adds and "-name" removes a tool.
 * Choosing built-ins never drops active extension tools implicitly — only "-name"
 * or --no-tools does. Inactive ones (tool_search, codemode) need "+name" (P24e).
 */
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

function uniqueStrings(values: string[]): string[] {
	return [...new Set(values)];
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
	if (options.sessionPath) options.sessionPath = resolve(options.sessionPath);
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
	const adHocEndpoint = options.baseUrl !== undefined || options.apiKey !== undefined || options.provider !== undefined;
	const startup = adHocEndpoint
		? ({ kind: "none" } as const)
		: chooseStartupModel(configuredModels, {
				...(options.model !== undefined ? { requested: options.model } : {}),
				...(userSettings.defaultProvider !== undefined ? { defaultProvider: userSettings.defaultProvider } : {}),
				...(userSettings.defaultModel !== undefined ? { defaultModel: userSettings.defaultModel } : {}),
			});
	if (startup.kind === "error") {
		console.error(startup.message);
		process.exit(1);
	}
	/** The table entry the session runs on; undefined on the ad-hoc / env path. */
	let activeModel: ConfiguredModel | undefined = startup.kind === "configured" ? startup.model : undefined;
	const model =
		startup.kind === "configured"
			? (startup.requestedId ?? startup.model.id)
			: (options.model ?? process.env.TAU_MODEL);
	let envProvider: ProviderKind | undefined;
	if (process.env.TAU_PROVIDER) {
		const value = process.env.TAU_PROVIDER;
		if (isProvider(value)) envProvider = value;
		else console.error(`Ignoring TAU_PROVIDER="${value}" (expected one of: ${PROVIDERS.join(", ")})`);
	}
	const provider: ProviderKind = activeModel
		? activeModel.api === "anthropic-messages"
			? "anthropic"
			: "openai"
		: (options.provider ?? envProvider ?? "openai");
	// Endpoint and credential env vars are scoped to one wire protocol, so a key
	// configured for one vendor is never sent to another vendor's host: OPENAI_* only
	// feed openai, ANTHROPIC_* only feed anthropic, and TAU_BASE_URL/TAU_API_KEY only
	// the protocol TAU_PROVIDER names (openai when unset). Explicit flags always win.
	const tauEnvApplies = (envProvider ?? "openai") === provider;
	const vendorEnv =
		provider === "anthropic"
			? { baseUrl: process.env.ANTHROPIC_BASE_URL, apiKey: process.env.ANTHROPIC_API_KEY }
			: { baseUrl: process.env.OPENAI_BASE_URL, apiKey: process.env.OPENAI_API_KEY };
	const baseUrl = activeModel
		? activeModel.baseUrl
		: (options.baseUrl ?? (tauEnvApplies ? process.env.TAU_BASE_URL : undefined) ?? (vendorEnv.baseUrl || undefined));
	const apiKey = activeModel
		? resolveConfigValue(activeModel.apiKey, valueResolver)
		: (options.apiKey ?? (tauEnvApplies ? process.env.TAU_API_KEY : undefined) ?? (vendorEnv.apiKey || undefined));
	// anthropic has a well-known default endpoint; the OpenAI-compatible world does not.
	if (!model || (provider === "openai" && !baseUrl)) {
		if (modelsConfig.present) {
			console.error(`No model in ${modelsConfig.path} has a usable API key, and no --base-url/--model was given.\n`);
		} else {
			console.error(
				`No model configured. Describe your models once in ${modelsConfig.path}, for example:\n\n${MODELS_EXAMPLE}\n\nor pass an endpoint: tau --base-url <url> --model <id> (env: TAU_BASE_URL, TAU_MODEL).\n`,
			);
		}
		console.error(USAGE);
		process.exit(1);
	}
	if (provider === "anthropic" && !apiKey) {
		console.error(
			"--provider anthropic requires an API key (--api-key, ANTHROPIC_API_KEY, or TAU_API_KEY with TAU_PROVIDER=anthropic).",
		);
		process.exit(1);
	}

	// -w beats the table, the table beats TAU_CONTEXT_WINDOW (P28). An id the table
	// lacks (-m on a configured provider) takes none of the entry's per-model values.
	const tableEntry = activeModel && activeModel.id === model ? activeModel : undefined;
	const contextWindow = options.contextWindow ?? tableEntry?.contextWindow ?? envInt("TAU_CONTEXT_WINDOW", 1);
	const modelChoices = activeModel
		? uniqueStrings([modelRef({ provider: activeModel.provider, id: model }), ...configuredModels.map(modelRef)])
		: uniqueStrings([model, ...(options.models ?? []), ...splitList(process.env.TAU_MODELS)]);
	// "120s" used to become a 120 ms watchdog; now it is rejected with a warning.
	const envStall = envInt("TAU_STALL_TIMEOUT_MS", 0);
	const stallTimeout = envStall !== undefined ? { stallTimeoutMs: envStall } : {};
	const effectiveBaseUrl = baseUrl ?? ANTHROPIC_DEFAULT_BASE_URL;
	const platform = defaultPlatform();
	// Output cap for the Anthropic transport (it must send max_tokens; default 8192 is
	// tight once adaptive thinking runs at high/xhigh effort).
	const envMaxTokens = envInt("TAU_MAX_TOKENS", 1);
	// With an injected transport the config's protocol fields are inert; it still
	// carries the message labels (provider/api/model) and contextWindow.
	// Chat Completions dialect knobs (P23d), env only: the output-cap field for summary
	// requests, endpoints that omit finish_reason, text-only models.
	const dialect: Pick<OpenAICompatConfig, "maxTokensField" | "supportsFinishReason" | "input"> = {};
	const envMaxTokensField = process.env.TAU_MAX_TOKENS_FIELD;
	if (envMaxTokensField === "max_tokens" || envMaxTokensField === "max_completion_tokens") {
		dialect.maxTokensField = envMaxTokensField;
	} else if (envMaxTokensField) {
		console.error(
			`Ignoring TAU_MAX_TOKENS_FIELD="${envMaxTokensField}" (expected max_tokens or max_completion_tokens)`,
		);
	}
	const envFinishReason = process.env.TAU_SUPPORTS_FINISH_REASON;
	if (envFinishReason === "0" || envFinishReason === "false") dialect.supportsFinishReason = false;
	else if (envFinishReason && envFinishReason !== "1" && envFinishReason !== "true") {
		console.error(`Ignoring TAU_SUPPORTS_FINISH_REASON="${envFinishReason}" (expected 0 or 1)`);
	}
	const envInput = process.env.TAU_INPUT;
	if (envInput === "text") dialect.input = ["text"];
	else if (envInput && envInput !== "text,image" && envInput !== "image") {
		console.error(`Ignoring TAU_INPUT="${envInput}" (expected text or text,image)`);
	}
	/** The config and transport of one endpoint: the startup one, or a table model /model switches to. */
	const buildEndpoint = (spec: {
		kind: ProviderKind;
		label: string | undefined;
		baseUrl: string | undefined;
		apiKey: string | undefined;
		model: string;
		contextWindow: number | undefined;
		maxTokens: number | undefined;
		headers: Record<string, string>;
		/** P36: a table model's `input` (pi: omitted = text only); undefined for an endpoint from env/flags. */
		input?: ("text" | "image")[];
	}): { config: OpenAICompatConfig; anthropic: AnthropicTransportConfig | undefined } => {
		const headers = Object.keys(spec.headers).length > 0 ? { headers: spec.headers } : {};
		const config: OpenAICompatConfig = {
			baseUrl: spec.baseUrl ?? ANTHROPIC_DEFAULT_BASE_URL,
			apiKey: spec.apiKey,
			model: spec.model,
			contextWindow: spec.contextWindow,
			// Summary requests use the model's output limit when it is known (P48): models.json
			// `maxTokens`, else on Anthropic the cap its turns use; unknown keeps reserveTokens shares.
			maxOutputTokens:
				spec.kind === "anthropic" ? (spec.maxTokens ?? envMaxTokens ?? defaultMaxTokens(spec.model)) : spec.maxTokens,
			...(spec.kind === "anthropic"
				? { provider: spec.label ?? "anthropic", api: ANTHROPIC_MESSAGES_API }
				: spec.label !== undefined
					? { provider: spec.label }
					: {}),
			...headers,
			...stallTimeout,
			// TAU_INPUT (in dialect) still wins over the table.
			...(spec.input ? { input: spec.input } : {}),
			...dialect,
		};
		const anthropic: AnthropicTransportConfig | undefined =
			spec.kind === "anthropic"
				? {
						// The required-key gate ran already; assert for the type system.
						apiKey: spec.apiKey as string,
						model: spec.model,
						...(spec.baseUrl !== undefined ? { baseUrl: spec.baseUrl } : {}),
						...((spec.maxTokens ?? envMaxTokens) !== undefined ? { maxTokens: spec.maxTokens ?? envMaxTokens } : {}),
						...(spec.contextWindow !== undefined ? { contextWindow: spec.contextWindow } : {}),
						...(spec.label !== undefined ? { provider: spec.label } : {}),
						...headers,
						thinkingMode: process.env.TAU_ANTHROPIC_THINKING === "budget" ? "budget" : "adaptive",
						...stallTimeout,
					}
				: undefined;
		return { config, anthropic };
	};
	const startupEndpoint = buildEndpoint({
		kind: provider,
		label: activeModel?.provider,
		baseUrl,
		apiKey,
		model,
		contextWindow,
		maxTokens: tableEntry?.maxTokens,
		headers: activeModel ? resolveHeaders(activeModel, valueResolver) : {},
		...(activeModel ? { input: activeModel.input ?? ["text"] } : {}),
	});
	let config = startupEndpoint.config;
	let anthropicConfig = startupEndpoint.anthropic;
	// The thinking level travels with every request (P23d); /thinking changes it on the agent.
	let thinkingLevel: ThinkingLevel | undefined = userSettings.defaultThinkingLevel;
	let fixedPricing = options.pricing;
	if (!fixedPricing && process.env.TAU_PRICING) {
		const parsed = parsePricing(process.env.TAU_PRICING);
		// Env is a convenience knob: a bad value degrades to "cost unknown" with a
		// warning instead of refusing to start (the explicit flag does exit).
		if (parsed instanceof Error) console.error(`Ignoring TAU_PRICING: ${parsed.message}`);
		else fixedPricing = parsed;
	}
	// The given prices belong to the startup model: after /model the cost is unknown
	// rather than priced at another model's rates (debt #12, D19-3). Table models
	// carry their own prices (P28): the active provider's entry first, then any.
	const pricedModel = model;
	const pricing = (forModel: string): ModelPricing | undefined => {
		if (fixedPricing && forModel === pricedModel) return fixedPricing;
		const entry =
			configuredModels.find((candidate) => candidate.provider === activeModel?.provider && candidate.id === forModel) ??
			configuredModels.find((candidate) => candidate.id === forModel);
		return entry ? modelPricing(entry) : undefined;
	};
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
	let transport: ChatTransport | undefined = anthropicConfig
		? createAnthropicTransport(anthropicConfig, platform)
		: undefined;
	/**
	 * Resolve a /model choice (P28): a table model switches endpoint and protocol
	 * along with the id (D21 addendum); without a table, or for an id the table
	 * lacks, only the id changes, as before.
	 */
	const resolveModelSwitch = (
		requested: string,
	): { model: string; display: string; options: SetModelOptions; commit(): void } | { error: string } => {
		const found = findModel(configuredModels, requested);
		if (found === "ambiguous") return { error: `"${requested}" exists on several providers; use provider/id.` };
		if (!found) {
			const prefix = activeModel ? `${activeModel.provider}/` : undefined;
			const id = prefix && requested.startsWith(prefix) ? requested.slice(prefix.length) : requested;
			return {
				model: id,
				display: activeModel ? modelRef({ provider: activeModel.provider, id }) : id,
				options: {},
				commit: () => {
					config.model = id;
					if (anthropicConfig) anthropicConfig.model = id;
				},
			};
		}
		const key = resolveConfigValue(found.apiKey, valueResolver);
		const kind: ProviderKind = found.api === "anthropic-messages" ? "anthropic" : "openai";
		const window = options.contextWindow ?? found.contextWindow;
		const endpoint = buildEndpoint({
			kind,
			label: found.provider,
			baseUrl: found.baseUrl,
			apiKey: key,
			model: found.id,
			contextWindow: window,
			maxTokens: found.maxTokens,
			headers: resolveHeaders(found, valueResolver),
			input: found.input ?? ["text"],
		});
		const nextTransport = endpoint.anthropic ? createAnthropicTransport(endpoint.anthropic, platform) : undefined;
		return {
			model: found.id,
			display: modelRef(found),
			options: {
				transport: nextTransport ?? createOpenAICompatTransport(platform, endpoint.config),
				provider: endpoint.config.provider ?? "openai-compat",
				api: endpoint.config.api ?? "openai-completions",
				contextWindow: window,
				maxOutputTokens: endpoint.config.maxOutputTokens,
			},
			// Agents built later (/reload, /resume) start from the switched endpoint.
			commit: () => {
				activeModel = found;
				config = endpoint.config;
				anthropicConfig = endpoint.anthropic;
				transport = nextTransport;
			},
		};
	};
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
	const modelTakesImages = (): boolean => config.input === undefined || config.input.includes("image");
	/**
	 * Everything rooted at one working directory (P29): the extensions and the
	 * project trust decision, the filesystem and shell, the project context, the
	 * session repo, and building agents. The CLI opens one for process.cwd();
	 * ACP opens one per session/new (its cwd, its file access through the client).
	 */
	const openWorkspace = async (spec: {
		cwd: string;
		ui: UiCapability | undefined;
		onApproval: ((request: ApprovalRequest) => Promise<boolean>) | undefined;
		fs?: FileSystem;
		/** P30: the gateway keeps each conversation's sessions in its own directory. */
		sessionDir?: string;
		/** P30: a mode for this workspace's agents instead of the host's. */
		permissionMode?: PermissionMode;
		/** P30: appended to the system prompt (who the agent is talking to, and where). */
		promptNote?: string;
		/** P31: extensions the host adds after the built-ins (the gateway's schedule tools); kept across /reload. */
		extensions?: Extension[];
		/** P32a: this workspace's memory scope instead of the project's (a gateway guest's own). */
		memory?: MemoryScope;
		/** P32b: load ~/.tau/mcp.json servers (default true; off for a gateway guest, and ACP merges its own). */
		mcp?: boolean;
		/**
		 * P35: ask_user for this workspace. Offered whenever there is a UI; `freeAnswer: false` when the
		 * UI has no text input (ACP), `unavailable` says when nobody can answer (a gateway schedule), false = none.
		 */
		askUser?: false | { freeAnswer?: boolean; unavailable?: () => string | undefined };
		/** P35: ask the trust question through `ui` (default true; the gateway's chat UI does not). */
		trustPrompt?: boolean;
		/** P37a: permission rules and additional working directories (default true; off in the gateway, which stays as it was). */
		permissionRules?: boolean;
		/** P39d: false keeps a bash command that reaches its timeout stopped instead of moved to the background (the gateway). */
		backgroundOnTimeout?: boolean;
		/** P40: false keeps settings.json to its pre-P40 keys and leaves out the PowerShell tool (the gateway). */
		extendedSettings?: boolean;
		/** P32c: the audit's host, trigger and approval kind for this workspace (the gateway's chats). */
		audit?: {
			host?: AuditHost;
			approvals?: "terminal" | "chat";
			decidedBy?: (toolCallId: string) => string | undefined;
			current?: () => { runId?: string; trigger: AuditTrigger };
		};
	}) => {
		let cwd = spec.cwd;
		let workspaceMode = spec.permissionMode;
		// The audit ledger (P32c): who decided each approval, and a record per run and tool call.
		const approvals = new ApprovalLog();
		const settings = readSettings(join(userHome(), ".tau", "settings.json"));
		// P40c: the settings in force. The user's until the trust decision below, then the layers;
		// ask_user reads askUser.wait from it while it loads.
		let workspaceSettings: TauSettings = settings;
		const auditExtension = createAuditExtension({
			ledger: AuditLedger.at(userHome()),
			host: spec.audit?.host ?? auditHost,
			workspace: cwd,
			approvals,
			details: settings.auditDetails ?? "summary",
			current: spec.audit?.current ?? (() => ({ trigger: defaultTrigger })),
		});
		const workspaceHost = spec.audit?.host ?? auditHost;
		const hookRunner = new HookRunner({
			cwd,
			permissionMode: () => workspaceMode ?? permissionMode ?? "supervised",
			log: (level, text) => process.stderr.write(`${level === "warning" ? "warning: " : ""}${text}\n`),
			// The gateway tells its owners in chat; Notification hooks are for a person at this machine.
			notifications: spec.ui !== undefined && (spec.audit?.approvals ?? "terminal") !== "chat",
			idleNotification: workspaceHost === "tui" || workspaceHost === "repl",
			onHookApproval: (toolCallId) => approvals.record(toolCallId, { source: "hook_allow" }),
			// P44 (Claude Code): SessionEnd's reason on exit; Stop and SubagentStop see the background work.
			exitReason: workspaceHost === "tui" || workspaceHost === "repl" ? "prompt_input_exit" : "other",
			// The parked gateway keeps its hooks as they were before P44.
			...(spec.extendedSettings === false ? { legacy: true } : {}),
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
			spec.ui !== undefined && spec.askUser !== false
				? createAskUserExtension({
						wait: () => workspaceSettings.askUserWait === true,
						freeAnswer: spec.askUser?.freeAnswer ?? true,
						...(spec.askUser?.unavailable ? { unavailable: spec.askUser.unavailable } : {}),
						onAsk: () => hookRunner.notify("Tau has a question for you", "elicitation_dialog"),
					})
				: undefined;
		// P43 (pi): the shell tools' commands see their session (TAU_SESSION_*); the gateway is parked.
		let sessionAgent: Agent | undefined;
		const commandEnv = spec.extendedSettings !== false ? () => sessionEnvironment(sessionAgent) : undefined;
		// P36a: background commands, one list per workspace (a gateway conversation has its own).
		const background = new NodeBackgroundShell(cwd, {
			env: modelEnvironment(),
			...(commandEnv ? { commandEnv } : {}),
			...(spec.backgroundOnTimeout === false ? { moveOnTimeout: false } : {}),
		});
		// P44 (Claude Code): /loop and the cron tools in the TUI and the REPL (-p ends before a task
		// could fire); TAU_DISABLE_CRON=1 turns them off. Monitor everywhere but the gateway, 10 min
		// at most in -p. The gateway is parked and gets neither.
		const extended = spec.extendedSettings !== false;
		const scheduling =
			extended && (workspaceHost === "tui" || workspaceHost === "repl") && process.env.TAU_DISABLE_CRON !== "1"
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
				worktreeSession
					? { session: worktreeSession, original: worktreeOriginal ?? worktreeSession.mainRoot }
					: undefined,
			move: async (target, worktree) => {
				if (worktree) await followMainTrust(worktree.session.path, worktree.session.mainRoot);
				worktreeSession = worktree?.session;
				worktreeOriginal = worktree?.original;
				await moveTo(target);
			},
			settings: () => userSettings.worktree ?? {},
			permissionMode: () => workspaceMode ?? permissionMode ?? "supervised",
		};
		const hostExtensions = [
			...(askUser ? [askUser] : []),
			createBackgroundExtension(background, {
				...(scheduling ? { scheduler: scheduling.scheduler } : {}),
				// Like bash, which read-only mode leaves out (createCodingTools).
				...(extended && (workspaceMode ?? permissionMode) !== "read-only"
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
			...(extended &&
			spec.fs === undefined &&
			(workspaceHost === "tui" || workspaceHost === "repl" || workspaceHost === "print" || workspaceHost === "json") &&
			(workspaceMode ?? permissionMode) !== "read-only"
				? [createWorktreeToolsExtension(worktreeHost)]
				: []),
			// P46 (Claude Code's PushNotification): where a terminal can show it.
			...(extended && (workspaceHost === "tui" || workspaceHost === "repl") ? [createPushNotificationExtension()] : []),
			...(spec.extensions ?? []),
		];
		const trustUi = spec.trustPrompt === false ? undefined : spec.ui;
		const loaded = await loadExtensionRegistry(
			cwd,
			trustUi,
			hostExtensions,
			spec.memory,
			(spec.mcp ?? true) && options.noMcp !== true,
			auditExtension,
			hookRunner,
			spec.extendedSettings !== false,
			workspaceHost === "tui",
		);
		const extensions = loaded.registry;
		/** P46: the language servers in use (a reload brings new ones). */
		let currentLsp = loaded.lsp;
		// The trust decision for project resources (ctx.isProjectTrusted, project paths); /reload re-decides.
		let projectTrusted = loaded.projectTrusted;
		// P40c (pi): settings.json in layers, the user's then a trusted project's; /reload reads them again.
		// The gateway, parked, keeps the keys it had before P40.
		const readWorkspaceSettings = (): TauSettings =>
			spec.extendedSettings === false
				? withoutP40Keys(readSettings(join(userHome(), ".tau", "settings.json")))
				: loadSettings({ home: userHome(), cwd, projectTrusted });
		workspaceSettings = readWorkspaceSettings();
		// P41b (pi): what replaces and extends the system prompt; the gateway keeps -s only, as before.
		const readPromptSources = (): { system?: string; append: string[] } =>
			spec.extendedSettings === false
				? { ...(options.system !== undefined ? { system: options.system } : {}), append: [] }
				: systemPromptSources(cwd, userHome(), projectTrusted, {
						...(options.system !== undefined ? { system: options.system } : {}),
						...(options.appendSystemPrompt ? { append: options.appendSystemPrompt } : {}),
					});
		let promptSources = readPromptSources();
		// Permission rules (P37a): settings files, flags, /permissions; "always allow" saves rules.
		let currentAgent: Agent | undefined;
		const permissions =
			spec.permissionRules === false
				? undefined
				: new WorkspacePermissions({
						home: userHome(),
						cwd,
						// P37d: in a tau worktree, local rules live in the main checkout (Claude Code).
						...(worktreeSession && cwd === resolve(worktreeSession.path)
							? { localRoot: worktreeSession.mainRoot }
							: {}),
						projectTrusted: () => projectTrusted,
						allowedTools: options.allowedTools ?? [],
						disallowedTools: options.disallowedTools ?? [],
						addDirs: options.addDirs ?? [],
						// This session only: other sessions and later ones keep their own mode (Claude Code).
						acceptEdits: () => currentAgent?.setPermissionMode("accept-edits"),
						mode: () => currentAgent?.getPermissionMode() ?? workspaceMode ?? permissionMode ?? "supervised",
						onProjectFileWritten: () => {
							if (projectTrusted) void saveProjectTrust(cwd, true);
						},
					});
		for (const diagnostic of permissions?.diagnostics() ?? []) console.error(dim(`permissions: ${diagnostic}`));
		if (permissions) {
			await extensions.add([createPermissionsExtension(permissions), createStatusLineExtension(userHome())]);
		}
		const policy: ToolPolicy | undefined = permissions
			? auditedPolicy(
					createDefaultPolicy({
						rules: () => permissions.rules(),
						workingDirectories: () => permissions.workingDirectories(),
						home: userHome(),
					}),
					approvals,
				)
			: undefined;
		// The host's prompt learns what "always allow" would save for each open approval.
		const withAlwaysOption = (handler: ((request: ApprovalRequest) => Promise<boolean>) | undefined): typeof handler =>
			handler && permissions
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
			spec.audit?.approvals ?? "terminal",
			spec.audit?.decidedBy,
		);
		extensions.setFlagValues(resolveExtensionFlags(extensions, options.extras).values);
		const reloadExtensions = async (reloadUi: UiCapability | undefined): Promise<ExtensionRegistry> => {
			// /reload also re-reads AGENTS.md / CLAUDE.md, as pi's resource loader does.
			projectContext = await loadProjectContext();
			const next = await loadExtensionRegistry(
				cwd,
				spec.trustPrompt === false ? undefined : reloadUi,
				hostExtensions,
				spec.memory,
				(spec.mcp ?? true) && options.noMcp !== true,
				auditExtension,
				hookRunner,
				spec.extendedSettings !== false,
				workspaceHost === "tui",
			);
			projectTrusted = next.projectTrusted;
			currentLsp = next.lsp;
			workspaceSettings = readWorkspaceSettings();
			promptSources = readPromptSources();
			applyShellSettings();
			if (permissions) {
				await next.registry.add([createPermissionsExtension(permissions), createStatusLineExtension(userHome())]);
			}
			next.registry.setFlagValues(resolveExtensionFlags(next.registry, options.extras).values);
			return next.registry;
		};

		const fs: FileSystem = spec.fs ?? new NodeFileSystem(cwd);
		/** P36d: converts and shrinks images for read and `@file` (pi); P40c: settings' images.autoResize. */
		const imageProcessor = new NodeImageProcessor({
			autoResize: () => workspaceSettings.images?.autoResize !== false,
		});
		// The user's own `!` commands get the full environment; the tools the model calls get it
		// without secret-looking variables (P32b). Secrets are registered first so their values go too.
		const shell = new NodeShell(cwd);
		const toolShell = new NodeShell(cwd, { env: modelEnvironment(), ...(commandEnv ? { commandEnv } : {}) });
		// P40b: pi's powershell tool on Windows when PowerShell is installed (Claude Code: on by default).
		const powershellShell =
			spec.extendedSettings !== false && findPowerShell() !== undefined
				? new NodeShell(cwd, {
						env: modelEnvironment(),
						interpreter: "powershell",
						...(commandEnv ? { commandEnv } : {}),
					})
				: undefined;
		const powershellBackground = powershellShell ? background.forPowerShell() : undefined;
		// P46 (Claude Code's isolation: worktree): a subagent's own worktree, with file, bash and PowerShell
		// tools bound there (no background commands, so no monitor); removed when it changed nothing. A
		// resumed subagent reopens the worktree its last run kept. Not in the parked gateway.
		setSubagentIsolation(
			spec.extendedSettings === false
				? undefined
				: async (agentId, kept) => {
						const settings = userSettings.worktree ?? {};
						// Ids restart in every session, so an earlier session's kept agent-sub-1 is never reopened by a new sub-1.
						const session =
							kept !== undefined && existsSync(kept)
								? openWorktree({ cwd, name: basename(kept), settings })
								: openWorktree({ cwd, name: `agent-${agentId}`, unique: true, settings });
						const childFs = new NodeFileSystem(session.path);
						const childShell = new NodeShell(session.path, {
							env: modelEnvironment(),
							...(commandEnv ? { commandEnv } : {}),
						});
						childShell.options = toolShell.options;
						const childPowershell =
							powershellShell && powershellAllowed()
								? new NodeShell(session.path, {
										env: modelEnvironment(),
										interpreter: "powershell",
										...(commandEnv ? { commandEnv } : {}),
									})
								: undefined;
						const tools = createCodingTools(
							{
								fs: childFs,
								shell: childShell,
								images: imageProcessor,
								...(childPowershell ? { powershell: { shell: childPowershell } } : {}),
							},
							{ mode: workspaceMode ?? permissionMode ?? "supervised", supportsImages: modelTakesImages },
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
					},
		);
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
			if (shellPath !== undefined && !existsSync(shellPath))
				throw new Error(`Custom shell path not found: ${shellPath}`);
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
			// P44 (Claude Code): InstructionsLoaded for each file, for the record only; not in the parked gateway.
			for (const file of spec.extendedSettings === false ? [] : files) {
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
			spec.sessionDir ??
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
			const mode = workspaceMode ?? permissionMode;
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
				{ mode, supportsImages: modelTakesImages },
			);
			// P46 (Claude Code's TaskStop): task_stop also stops a background subagent by ID or name.
			if (extended) {
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
			}
			// P43 (pi bash/powershell guidelines): the commands see TAU_SESSION_*.
			if (commandEnv) {
				for (const tool of codingTools) {
					if (tool.name !== "bash" && tool.name !== "powershell") continue;
					tool.promptGuidelines = [
						...(tool.promptGuidelines ?? []),
						"You can inspect TAU_SESSION_* environment variables for current model and session details.",
					];
				}
			}
			const built = new Agent({
				config,
				transport,
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
					spec.promptNote ?? "",
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
				// P43 (pi): images tools return (MCP, extensions) are converted and shrunk before they
				// are logged; the gateway is parked and keeps what it had.
				...(spec.extendedSettings !== false ? { imageProcessor } : {}),
				initialMessages: messages,
				session,
				// P40c (pi): settings' retry, compaction, branch summary, queue modes and turn cap; the env wins for retries.
				...agentOptionsFromSettings(workspaceSettings, retry),
				pricing,
				thinkingLevel,
				permissionMode: mode,
				toolExecution,
				onApproval: onWorkspaceApproval,
				...(policy ? { policy } : {}),
				// P44 (Claude Code): PostToolBatch after each batch of tool calls; the gateway is parked.
				...(spec.extendedSettings !== false
					? {
							finishTurn: async (turn, signal) => {
								const batch = await postToolBatch(hookRunner, turn, signal);
								const send = agentExtensions.hostAction("sendMessage");
								if (batch.context !== undefined) {
									send?.(
										{ customType: "hook_context", content: batch.context, display: false },
										{ triggerTurn: false },
									);
								}
								if (batch.stop === undefined) return undefined;
								send?.(
									{ customType: "hook_stop", content: `PostToolBatch hook: ${batch.stop}`, display: true },
									{ triggerTurn: false },
								);
								return { action: "end" as const };
							},
						}
					: {}),
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
			/** P37a: this workspace's permission rules (undefined in the gateway). */
			permissions,
			/** P37a: settings' permissions.defaultMode, unless --permission-mode or the env chose (ACP applies it per session). */
			defaultMode: (): PermissionMode | undefined => (explicitMode ? undefined : permissions?.defaultMode().mode),
			isProjectTrusted: () => projectTrusted,
			/** Agents built later (session switches) use this mode; only for a workspace opened with one. */
			setPermissionMode: (next: PermissionMode) => {
				if (workspaceMode !== undefined) workspaceMode = next;
				else permissionMode = next;
			},
		};
	};
	type Workspace = Awaited<ReturnType<typeof openWorkspace>>;
	const modelDisplay = (): string =>
		activeModel ? modelRef({ provider: activeModel.provider, id: config.model }) : config.model;
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
			config.model = nextModel;
			if (anthropicConfig) anthropicConfig.model = nextModel;
		},
		setHostThinking: (nextLevel: ThinkingLevel | undefined) => {
			thinkingLevel = nextLevel;
		},
		setHostPermissionMode: (nextMode: PermissionMode) => {
			permissionMode = nextMode;
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
			supportsImages: () => activeModel?.input?.includes("image") === true,
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
		if (settingsMode) permissionMode = settingsMode;
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
		if (options.sessionPath) {
			store = await sessionRepo.open({ id: "", cwd, timestamp: "", filePath: resolve(options.sessionPath) });
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
				if (entry && (entry.provider !== activeModel?.provider || entry.id !== config.model)) {
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
				provider: activeModel?.provider ?? config.provider ?? "openai-compat",
				version: CLI_VERSION,
				...(worktreeSession
					? {
							projectDir: worktreeSession.mainRoot,
							worktree: {
								name: worktreeSession.name,
								path: worktreeSession.path,
								branch: worktreeSession.branch,
								originalCwd: worktreeSession.mainRoot,
								...(worktreeSession.originalBranch ? { originalBranch: worktreeSession.originalBranch } : {}),
							},
						}
					: {}),
			}),
			doubleEscapeAction: userSettings.doubleEscapeAction ?? "tree",
			showReasoning: userSettings.showReasoning ?? false,
			saveSetting: (section, key, value) => writeSectionKey(userSettingsPath, section, key, value),
			autoTitle: autoTitleOn(workspace.settings().autoTitle),
			notify: userSettings.tuiNotify ?? "auto",
			terminalTitle: userSettings.tuiTitle !== false,
			model: activeModel ? modelRef({ provider: activeModel.provider, id: config.model }) : config.model,
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
			baseUrl: config.baseUrl,
			cwd,
			contextWindow: config.contextWindow,
			permissionMode,
			sessionRepo,
			shell,
			store,
			recorder,
			thinkingLevel,
			setModel: (nextModel) => {
				// Agents built later (/reload, /resume) start from the switched model.
				config.model = nextModel;
				if (anthropicConfig) anthropicConfig.model = nextModel;
			},
			setThinkingLevel: (nextLevel) => {
				thinkingLevel = nextLevel;
			},
			setPermissionMode: (nextMode) => {
				// Agents built later (/reload, /resume) start from the switched mode.
				permissionMode = nextMode;
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
		if (worktreeSession) await finishWorktree(worktreeSession, workspace.background);
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
		banner: { model, baseUrl: effectiveBaseUrl, provider, cwd, permissionMode },
		contextWindow,
		terminalStatus: userSettings.tuiTitle !== false,
		titled,
		worktreeSession,
	});
}

await main();
