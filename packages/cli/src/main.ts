#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";

/**
 * User-level tau directory root. Honors `HOME` when set (tests and sandboxes
 * override it); on Windows `os.homedir()` reads USERPROFILE and ignores HOME,
 * which made e2e runs load the real ~/.tau/extensions.
 */
function userHome(): string {
	const home = process.env.HOME?.trim();
	return home ? home : homedir();
}

import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import {
	ANTHROPIC_DEFAULT_BASE_URL,
	ANTHROPIC_MESSAGES_API,
	type AnthropicTransportConfig,
	createAnthropicTransport,
} from "@yophon/tau-ext-provider-anthropic";
import {
	digestDirectory,
	importExtensionFiles,
	listExtensionFiles,
	loadExtensionsFromDir,
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
	ExtensionRegistry,
	type FileSystem,
	JsonlSessionRepo,
	loadProjectContextFiles,
	type ModelPricing,
	messageText,
	type OpenAICompatConfig,
	type PermissionMode,
	renderProjectContext,
	restoreSession,
	type SessionEntry,
	SessionRecorder,
	type SessionStore,
	type SetModelOptions,
	sessionDirSlug,
	TauError,
	type ThinkingLevel,
	type ToolExecutionMode,
	type ToolPolicy,
	thinkingText,
	toolResultText,
	type UiCapability,
	type UserContent,
	userContentText,
} from "@yophon/tau-kernel";
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
import { createBackgroundExtension } from "./background.ts";
import { attachPromptAgent, builtinExtensions, configureBuiltins, toolLine } from "./builtins.ts";
import { CredentialStore, credentialsPath } from "./credentials.ts";
import { initialContent, type ProcessedFiles, processFileArguments } from "./file-args.ts";
import { createHooksExtension, HookRunner, loadHookConfig, withHookApprovals } from "./hooks.ts";
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
import { RpcUiBridge, runRpcMode } from "./modes/rpc.ts";
import { createPermissionsExtension } from "./permission-commands.ts";
import {
	type HostApprovalRequest,
	localSettingsIsRepoFile,
	migrateLegacyPermissions,
	openAlwaysOptions,
	splitRuleList,
	WorkspacePermissions,
} from "./permissions.ts";
import { registerEnvSecrets, scrubEnv } from "./secrets.ts";
import { autoTitle, autoTitleOn } from "./session-title.ts";
import { readSettings, tuiScreen, writeSettings, writeTuiMode } from "./settings.ts";
import { conversationLength } from "./tui/controller.ts";

/** The CLI package version (src/ and dist/ both sit one level below package.json). */
const CLI_VERSION = (
	JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }
).version;

const USAGE = `tau - minimal OpenAI-compatible coding agent

Usage: tau [options] [@files...] [messages...]
       tau [options] -p "prompt" [@files...]
       tau gateway <run|status|login|channels|allow|revoke> ...   (see tau gateway help)

@file: a text file goes into the first message, an image is attached to it
(converted and shrunk like read's). Messages: the first starts the session,
the others follow one after another.

Options:
  -b, --base-url <url>   API base URL (env: TAU_BASE_URL, then OPENAI_BASE_URL /
                         ANTHROPIC_BASE_URL per protocol; optional with
                         --provider anthropic)
  -k, --api-key <key>    API key (env: TAU_API_KEY, then OPENAI_API_KEY /
                         ANTHROPIC_API_KEY per protocol). TAU_BASE_URL and
                         TAU_API_KEY apply only to the protocol TAU_PROVIDER
                         names (openai when unset).
  -m, --model <model>    Model: provider/id or id from ~/.tau/models.json, or a model
                         id on the --base-url endpoint (env: TAU_MODEL)
      --list-models      List the models configured in ~/.tau/models.json and exit
      --provider <name>  Wire protocol: openai (default) | anthropic
                         (anthropic: /thinking sends adaptive thinking + effort;
                         TAU_ANTHROPIC_THINKING=budget for pre-4.6 models;
                         TAU_MAX_TOKENS sets the output cap, default 8192)
                         (env: TAU_PROVIDER). anthropic speaks the Anthropic
                         Messages API: native thinking, prompt caching, images
                         in tool results.
      --models <list>    Comma-separated TUI model selector candidates (env: TAU_MODELS)
  -s, --system <text>    Override the system prompt
  -p, --print <prompt>   One-shot mode: run a single prompt and exit
      --mode <mode>      json: -p (or stdin) as a JSONL event stream on stdout;
                         rpc: JSONL commands on stdin (pi's RPC protocol);
                         acp: Agent Client Protocol over stdio (editors)
      --tui              Use the TUI (the default on a terminal)
      --repl             Use the line-based REPL instead of the TUI
      --inline           TUI in the main screen, history in the terminal's scrollback
                         (default: full screen; settings.json tui.mode, env TAU_TUI_MODE)
      --fullscreen       TUI on the alternate screen with its own scrollable transcript
  -w, --context-window <n>  Model context window in tokens; enables auto-compaction
                         (env: TAU_CONTEXT_WINDOW)
      --pricing <spec>   Unit prices, USD per million tokens, e.g.
                         "in=0.5,out=2,cacheRead=0.05,cacheWrite=0.625"
                         (cache keys optional and uncounted when omitted;
                         env: TAU_PRICING). Enables real cost in the footer.
      --permission-mode <mode>  read-only | supervised | accept-edits | autonomous | bypass
                         (default: settings permissions.defaultMode, else supervised;
                         env: TAU_PERMISSION_MODE).
                         supervised asks before medium/high-risk tools;
                         accept-edits also allows file edits inside the
                         working directory (commands still ask);
                         headless (piped) runs deny instead of asking.
                         read-only registers only the read tool.
      --allowed-tools <rules>  Permission rules allowed for this run (Claude Code
                         syntax; comma-separated or repeated), e.g.
                         "Bash(npm test *),WebFetch(domain:github.com)"
      --disallowed-tools <rules>  Deny rules for this run; a bare name ("Bash")
                         takes the tool away. Saved rules: permissions in
                         settings.json, /permissions (docs/permissions.md)
      --add-dir <dir>    Another working directory for this run (repeatable):
                         accept-edits allows edits there too; see /add-dir
      --tool-execution <mode>  sequential | parallel
                         (default: parallel, pi's default; env: TAU_TOOL_EXECUTION).
                         parallel runs a multi-tool batch concurrently after
                         sequential preflight (hooks/approval stay ordered).
  -c, --continue         Resume the most recent session for this directory
      --session <path>   Resume a specific session file
      --no-session       Do not persist this conversation
  -nc, --no-context-files  Do not load AGENTS.md / CLAUDE.md into the system prompt
  -t,  --tools <list>    Active tools, comma-separated: names pick built-ins ("*" = all),
                         +name adds, -name removes; extension tools stay unless removed
      --no-tools         Start with no active tools
  -h, --help             Show this help

REPL commands: /name <name>, /sessions, /compact [instructions], /tree [<id>],
/fork [<id>], /help. /tree lists jump points; /tree <id> navigates there
(summarizing the abandoned branch); /fork copies the session into a new file
(up to <id> if given) and switches to it.

Extensions may declare additional --<flag> options (see registerFlag).
Retry/timeout env knobs: TAU_MAX_RETRIES (0 disables, default 3),
TAU_RETRY_BASE_DELAY_MS (default 2000, exponential), TAU_STALL_TIMEOUT_MS
(default 120000, 0 disables the dry-stream watchdog).
Chat Completions dialect knobs: TAU_MAX_TOKENS_FIELD=max_completion_tokens (OpenAI
reasoning models; summary requests), TAU_SUPPORTS_FINISH_REASON=0 (endpoints that
omit finish_reason), TAU_INPUT=text (text-only models: images become placeholders).
Models: describe providers and models once in ~/.tau/models.json (pi's format;
see the README). With a usable model there, the endpoint env vars above are
not used; -b/-k/--provider still run an ad-hoc endpoint. web_search needs
"webSearch" in ~/.tau/settings.json, or BRAVE_API_KEY / TAVILY_API_KEY /
EXA_API_KEY.
Without -p, tau starts the TUI on a terminal (--repl for the line-based REPL).
During a running turn, typed lines steer it. Ctrl+C aborts the current turn.`;

interface CliOptions {
	tools?: string[];
	noTools?: boolean;
	baseUrl?: string;
	apiKey?: string;
	model?: string;
	provider?: ProviderKind;
	models?: string[];
	system?: string;
	print?: string;
	tui: boolean;
	repl: boolean;
	/** P33: --inline / --fullscreen for the TUI. */
	screen?: "fullscreen" | "inline";
	continue: boolean;
	contextWindow?: number;
	pricing?: ModelPricing;
	permissionMode?: PermissionMode;
	toolExecution?: ToolExecutionMode;
	sessionPath?: string;
	noSession: boolean;
	noContextFiles?: boolean;
	listModels?: boolean;
	/** P29: json | rpc | acp. */
	mode?: "json" | "rpc" | "acp";
	/** P30: `tau gateway <command>`. */
	gateway?: GatewayCommand;
	help: boolean;
	/** Unrecognized tokens, matched against extension-declared flags after loading; the rest are messages (pi). */
	extras: string[];
	/** P36c: `@file` arguments (pi): text inlined, images attached to the first message. */
	files: string[];
	/** P37a: --add-dir, --allowed-tools, --disallowed-tools (Claude Code). */
	addDirs?: string[];
	allowedTools?: string[];
	disallowedTools?: string[];
}

/** `tau gateway <command> [args]` (P30). run also takes the usual tau options (model, flags). */
export interface GatewayCommand {
	command: string;
	args: string[];
	workspace?: string;
	owner?: boolean;
	mode?: string;
}

function parseGatewayArgs(argv: string[]): CliOptions {
	const command = argv[0] ?? "help";
	const gateway: GatewayCommand = { command, args: [] };
	const rest: string[] = [];
	for (let i = 1; i < argv.length; i++) {
		const arg = argv[i] ?? "";
		const value = (): string => {
			const next = argv[++i];
			if (next === undefined || next.startsWith("--")) {
				console.error(`Missing value for ${arg}`);
				process.exit(1);
			}
			return next;
		};
		if (arg === "--workspace") gateway.workspace = resolve(value());
		else if (arg === "--owner") gateway.owner = true;
		else if (arg === "--mode" && command === "allow") gateway.mode = value();
		else if (command === "run") rest.push(arg);
		else gateway.args.push(arg);
	}
	const options = parseArgs(rest);
	options.gateway = gateway;
	return options;
}

function parseArgs(argv: string[]): CliOptions {
	if (argv[0] === "gateway") return parseGatewayArgs(argv.slice(1));
	const options: CliOptions = {
		help: false,
		extras: [],
		files: [],
		continue: false,
		noSession: false,
		tui: false,
		repl: false,
	};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		const next = (): string => {
			const value = argv[++i];
			// A following flag is not a value (`--model --tui`); prompts and system text may start with "--".
			const freeText = arg === "-p" || arg === "--print" || arg === "-s" || arg === "--system";
			if (value === undefined || (!freeText && value.startsWith("--"))) {
				console.error(`Missing value for ${arg}`);
				process.exit(1);
			}
			return value;
		};
		switch (arg) {
			case "-b":
			case "--base-url":
				options.baseUrl = next();
				break;
			case "-k":
			case "--api-key":
				options.apiKey = next();
				break;
			case "-m":
			case "--model":
				options.model = next();
				break;
			case "--provider": {
				const value = next();
				if (!isProvider(value)) {
					console.error(`--provider must be one of: ${PROVIDERS.join(", ")}`);
					process.exit(1);
				}
				options.provider = value;
				break;
			}
			case "--models":
				options.models = splitList(next());
				break;
			case "-s":
			case "--system":
				options.system = next();
				break;
			case "-p":
			case "--print":
				options.print = next();
				break;
			case "-c":
			case "--continue":
				options.continue = true;
				break;
			case "-w":
			case "--context-window": {
				// Strict: "128k" used to parse as 128 and compact before every turn (pi #9045).
				const parsed = parseNonNegativeInt(next());
				if (parsed === undefined || parsed === 0) {
					console.error("--context-window must be a positive integer");
					process.exit(1);
				}
				options.contextWindow = parsed;
				break;
			}
			case "-t":
			case "--tools":
				options.tools = splitList(next());
				break;
			case "--add-dir":
				options.addDirs = [...(options.addDirs ?? []), next()];
				break;
			case "--allowed-tools":
			case "--allowedTools":
				options.allowedTools = [...(options.allowedTools ?? []), ...splitRuleList(next())];
				break;
			case "--disallowed-tools":
			case "--disallowedTools":
				options.disallowedTools = [...(options.disallowedTools ?? []), ...splitRuleList(next())];
				break;
			case "--no-tools":
				options.noTools = true;
				break;
			case "--pricing": {
				const parsed = parsePricing(next());
				if (parsed instanceof Error) {
					console.error(parsed.message);
					process.exit(1);
				}
				options.pricing = parsed;
				break;
			}
			case "--permission-mode": {
				const value = next();
				if (!isPermissionMode(value)) {
					console.error(`--permission-mode must be one of: ${PERMISSION_MODES.join(", ")}`);
					process.exit(1);
				}
				options.permissionMode = value;
				break;
			}
			case "--tool-execution": {
				const value = next();
				if (!isToolExecutionMode(value)) {
					console.error(`--tool-execution must be one of: ${TOOL_EXECUTION_MODES.join(", ")}`);
					process.exit(1);
				}
				options.toolExecution = value;
				break;
			}
			case "--session":
				options.sessionPath = next();
				break;
			case "--no-session":
				options.noSession = true;
				break;
			case "-nc":
			case "--no-context-files":
				options.noContextFiles = true;
				break;
			case "--tui":
				options.tui = true;
				break;
			case "--repl":
				options.repl = true;
				break;
			case "--inline":
				options.screen = "inline";
				break;
			case "--fullscreen":
				options.screen = "fullscreen";
				break;
			case "--list-models":
				options.listModels = true;
				break;
			case "--mode": {
				const value = next();
				if (value !== "json" && value !== "rpc" && value !== "acp") {
					console.error("--mode must be one of: json, rpc, acp");
					process.exit(1);
				}
				options.mode = value;
				break;
			}
			case "-h":
			case "--help":
				options.help = true;
				break;
			default:
				if (arg.startsWith("@") && arg.length > 1) options.files.push(arg.slice(1));
				else options.extras.push(arg);
		}
	}
	return options;
}

const PRICING_KEYS: Record<string, keyof ModelPricing> = {
	in: "inputPerMTok",
	out: "outputPerMTok",
	cacheRead: "cacheReadPerMTok",
	cacheWrite: "cacheWritePerMTok",
};

/** Parse "in=0.5,out=2,cacheRead=0.05,cacheWrite=0.625" (cache keys optional). */
/** A whole number written as digits only ("128k", "1e5", "12.5" are rejected), or undefined. */
function parseNonNegativeInt(text: string): number | undefined {
	if (!/^\d+$/.test(text.trim())) return undefined;
	const value = Number(text.trim());
	return Number.isSafeInteger(value) ? value : undefined;
}

/** An integer env knob: unset → undefined; malformed or below `min` → warning and undefined (P14–P16 env convention). */
function envInt(name: string, min: number): number | undefined {
	const raw = process.env[name];
	if (raw === undefined || raw.trim() === "") return undefined;
	const value = parseNonNegativeInt(raw);
	if (value === undefined || value < min) {
		console.error(`Ignoring ${name}="${raw}" (expected a whole number >= ${min})`);
		return undefined;
	}
	return value;
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

function parsePricing(spec: string): ModelPricing | Error {
	const values: Partial<Record<keyof ModelPricing, number>> = {};
	for (const part of spec.split(",")) {
		const trimmed = part.trim();
		if (trimmed === "") continue;
		const eq = trimmed.indexOf("=");
		const key = eq === -1 ? "" : PRICING_KEYS[trimmed.slice(0, eq).trim()];
		const value = eq === -1 ? Number.NaN : Number(trimmed.slice(eq + 1).trim());
		if (!key || !Number.isFinite(value) || value < 0) {
			return new Error(`Invalid pricing entry "${trimmed}" (expected in=<n>,out=<n>[,cacheRead=<n>][,cacheWrite=<n>])`);
		}
		values[key] = value;
	}
	if (values.inputPerMTok === undefined || values.outputPerMTok === undefined) {
		return new Error('Pricing requires both "in" and "out" (USD per million tokens)');
	}
	return { inputPerMTok: values.inputPerMTok, outputPerMTok: values.outputPerMTok, ...values };
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

function splitList(value: string | undefined): string[] {
	return (value ?? "")
		.split(",")
		.map((item) => item.trim())
		.filter((item) => item !== "");
}

const PERMISSION_MODES: readonly PermissionMode[] = ["read-only", "supervised", "accept-edits", "autonomous", "bypass"];

function isPermissionMode(value: string): value is PermissionMode {
	return (PERMISSION_MODES as readonly string[]).includes(value);
}

const TOOL_EXECUTION_MODES: readonly ToolExecutionMode[] = ["sequential", "parallel"];

function isToolExecutionMode(value: string): value is ToolExecutionMode {
	return (TOOL_EXECUTION_MODES as readonly string[]).includes(value);
}

const PROVIDERS = ["openai", "anthropic"] as const;
type ProviderKind = (typeof PROVIDERS)[number];

function isProvider(value: string): value is ProviderKind {
	return (PROVIDERS as readonly string[]).includes(value);
}

// Approvals (P15): "always allow" saves permission rules since P37a (permissions.ts).
type ApprovalChoice = "once" | "always" | "deny";

function uniqueStrings(values: string[]): string[] {
	return [...new Set(values)];
}

/** Extension flag values, and the other words: messages to send (pi `pi [options] [messages...]`, P36c). */
function resolveExtensionFlags(
	registry: ExtensionRegistry,
	extras: string[],
): { values: Record<string, boolean | string>; messages: string[] } {
	const values: Record<string, boolean | string> = {};
	const messages: string[] = [];
	for (let i = 0; i < extras.length; i++) {
		const token = extras[i];
		if (!token.startsWith("--")) {
			messages.push(token);
			continue;
		}
		const equals = token.indexOf("=", 2);
		const name = token.slice(2, equals === -1 ? undefined : equals);
		const flag = registry.flags.get(name);
		if (!flag) {
			console.error(`Unknown option: ${token}`);
			process.exit(1);
		}
		if (flag.type === "boolean") {
			if (equals !== -1) {
				const inline = token.slice(equals + 1).toLowerCase();
				if (inline !== "" && inline !== "true") {
					console.error(`Boolean option ${token} does not accept a value other than true`);
					process.exit(1);
				}
			}
			values[name] = true;
		} else {
			const value = equals === -1 ? extras[++i] : token.slice(equals + 1);
			if (value === undefined || value.startsWith("--")) {
				console.error(`Missing value for ${token}`);
				process.exit(1);
			}
			values[name] = value;
		}
	}
	return { values, messages };
}

const dim = (text: string): string => `\x1b[2m${text}\x1b[0m`;
const cyan = (text: string): string => `\x1b[36m${text}\x1b[0m`;
const red = (text: string): string => `\x1b[31m${text}\x1b[0m`;

type Readline = ReturnType<typeof createInterface>;

function createUi(readline: Readline): UiCapability {
	return {
		confirm: async (title, message) => {
			if (message) console.log(dim(message));
			const answer = await readline.question(`${title} [y/N] `);
			return /^y(es)?$/i.test(answer.trim());
		},
		input: async (title) => {
			const answer = await readline.question(`${title}: `);
			return answer === "" ? undefined : answer;
		},
		select: async (title, options) => {
			console.log(title);
			for (const [i, option] of options.entries()) console.log(`  ${i + 1}. ${option}`);
			const answer = await readline.question("> ");
			const index = Number.parseInt(answer.trim(), 10) - 1;
			return options[index];
		},
		// P35: numbers separated by spaces or commas; nothing valid = cancelled.
		selectMany: async (title, options) => {
			console.log(title);
			for (const [i, option] of options.entries()) console.log(`  ${i + 1}. ${option}`);
			const answer = await readline.question("numbers, separated by spaces > ");
			const picked = [...new Set(answer.split(/[\s,，、]+/).map((part) => Number.parseInt(part, 10) - 1))]
				.filter((index) => index >= 0 && index < options.length)
				.map((index) => options[index] as string);
			return picked.length > 0 ? picked : undefined;
		},
		notify: (message, level) => {
			const paint = level === "error" ? red : level === "warning" ? cyan : dim;
			console.log(paint(message));
		},
	};
}

// ---------------------------------------------------------------------------
// Project trust gate: project extensions are arbitrary code, so loading them
// from an untrusted directory would be remote code execution by `cd`. Since
// P15 a trusted record also pins a content digest of the extensions directory;
// changed content re-triggers the question (a trust decision covers what was
// reviewed, not whatever lands there later).
// ---------------------------------------------------------------------------

/** Legacy entries were plain booleans (no digest); they are upgraded on first load. */
type TrustEntry = boolean | { trusted: boolean; digest?: string };

interface TrustStore {
	trusted: Record<string, TrustEntry>;
}

function trustStorePath(): string {
	return join(userHome(), ".tau", "trust.json");
}

function readTrustStore(): TrustStore {
	try {
		// Strip a BOM: an unreadable store reads as empty, and the next write would erase every other record.
		const parsed = JSON.parse(readFileSync(trustStorePath(), "utf8").replace(/^\uFEFF/, "")) as TrustStore;
		return { trusted: parsed.trusted ?? {} };
	} catch {
		return { trusted: {} };
	}
}

function writeTrustStore(store: TrustStore): void {
	const path = trustStorePath();
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(store, null, "\t")}\n`, "utf8");
}

/**
 * Project-local resources that load only from a trusted directory (P23c, pi): code,
 * settings that pick endpoints or credentials, and skills/prompts that reach the
 * system prompt.
 */
const GATED_PROJECT_RESOURCES = [
	".tau/extensions",
	".tau/settings.json",
	// P37a: the project's MCP servers were read only when trusted but never asked about.
	".tau/mcp.json",
	".tau/skills",
	".tau/prompts",
	".pi/settings.json",
	".pi/skills",
	".pi/prompts",
] as const;

function presentGatedResources(cwd: string): string[] {
	const present: string[] = GATED_PROJECT_RESOURCES.filter((relative) => existsSync(join(cwd, relative)));
	// The local permissions file counts when the repository supplies it (git tracks it, P37a).
	if (localSettingsIsRepoFile(cwd)) present.push(".tau/settings.local.json");
	return present;
}

/**
 * Content digest of the gated resources (D20-5: a change asks again). A project
 * with only .tau/extensions keeps the pre-P23 digest of that directory, so
 * existing trust records stay valid.
 */
async function digestProjectResources(cwd: string, present: readonly string[]): Promise<string | undefined> {
	if (present.length === 1 && present[0] === ".tau/extensions") return digestDirectory(join(cwd, ".tau/extensions"));
	const hash = createHash("sha256");
	for (const relative of present) {
		const path = join(cwd, relative);
		const digest = statSync(path).isDirectory()
			? await digestDirectory(path)
			: createHash("sha256").update(readFileSync(path)).digest("hex");
		hash.update(`${relative}\0${digest ?? ""}\n`);
	}
	return hash.digest("hex");
}

async function isProjectTrusted(
	registry: ExtensionRegistry,
	cwd: string,
	ui: UiCapability | undefined,
	present: readonly string[],
): Promise<boolean> {
	const store = readTrustStore();
	const digest = await digestProjectResources(cwd, present);
	const recorded = store.trusted[cwd];
	if (recorded !== undefined) {
		const entry = typeof recorded === "boolean" ? { trusted: recorded } : recorded;
		// A denial needs no integrity check — nothing was loaded, nothing changes that.
		if (!entry.trusted) return false;
		if (entry.digest === undefined) {
			// Pre-P15 record: backfill the digest without re-asking, once.
			store.trusted[cwd] = { trusted: true, digest };
			writeTrustStore(store);
			console.log(dim("Recorded a content digest for this project's extensions (older trust entry had none)."));
			return true;
		}
		if (entry.digest === digest) return true;
		console.log(dim("Project resources changed since they were last trusted — confirming again."));
	}

	// Global (always-trusted) extensions may decide via the project_trust event.
	const decision = await registry.runProjectTrust(cwd, { ui, messages: [] });
	if (decision.trusted !== "undecided") {
		const trusted = decision.trusted === "yes";
		if (decision.remember) {
			store.trusted[cwd] = { trusted, digest };
			writeTrustStore(store);
		}
		return trusted;
	}

	if (!ui) return false; // headless + no valid record = reject
	const approved = await ui.confirm(
		"Trust this directory and load its project resources?",
		`${cwd}\n${present.join(", ")}`,
	);
	store.trusted[cwd] = { trusted: approved, digest };
	writeTrustStore(store);
	return approved;
}

/** Record a trust decision for the project's current resources (the TUI's /trust); applies from the next start or /reload. */
async function saveProjectTrust(cwd: string, trusted: boolean): Promise<string[]> {
	const projectFiles = await listExtensionFiles(join(cwd, ".tau", "extensions"));
	const present = presentGatedResources(cwd).filter(
		(relative) => relative !== ".tau/extensions" || projectFiles.length > 0,
	);
	const store = readTrustStore();
	store.trusted[cwd] = { trusted, digest: await digestProjectResources(cwd, present) };
	writeTrustStore(store);
	return present;
}

/** The registry plus the trust decision for the project's gated resources (backs ctx.isProjectTrusted). */
interface LoadedExtensions {
	registry: ExtensionRegistry;
	projectTrusted: boolean;
}

async function loadExtensionRegistry(
	cwd: string,
	ui: UiCapability | undefined,
	hostExtensions: readonly Extension[] = [],
	memory?: MemoryScope,
	mcp = true,
	audit?: Extension,
	hooks?: HookRunner,
): Promise<LoadedExtensions> {
	// Built-ins first (tool prompt, tool_search, codemode, P24e), then the host's (the gateway's
	// schedule tools, P31), then the user's extensions.
	configureBuiltins({ cwd, projectTrusted: false, home: userHome() });
	const registry = await ExtensionRegistry.load([
		// P32c: the audit first, so it sees every call, including ones the guard blocks.
		...(audit ? [audit] : []),
		...builtinExtensions(memory !== undefined ? { memory } : {}),
		...hostExtensions,
		...(await loadExtensionsFromDir(join(userHome(), ".tau", "extensions"))),
	]);
	// A failing notification handler (an unreachable MCP server in session_start, a
	// buggy turn_end) is reported and skipped instead of taking the CLI down (HF-12).
	registry.setErrorSink(({ event, error }) => {
		process.stderr.write(`[extension error in ${event}] ${error.message}\n`);
	});
	const extensionsDir = join(cwd, ".tau", "extensions");
	// List first, decide trust, and only then import: importing runs the modules' top-level
	// code, so an untrusted directory must never get that far (cd into a repo ≠ run its code).
	const projectFiles = await listExtensionFiles(extensionsDir);
	// Any gated resource asks for the decision, not only extensions (P23c): project
	// settings, skills and prompts are read only from a trusted directory.
	const present = presentGatedResources(cwd).filter(
		(relative) => relative !== ".tau/extensions" || projectFiles.length > 0,
	);
	let projectTrusted = false;
	if (present.length > 0) {
		projectTrusted = await isProjectTrusted(registry, cwd, ui, present);
		if (projectTrusted) {
			if (projectFiles.length > 0) await registry.add(await importExtensionFiles(projectFiles));
		} else {
			if (projectFiles.length > 0) {
				console.log(dim(`Skipped ${projectFiles.length} project extension(s): directory not trusted.`));
			}
			const ignored = present.filter((relative) => relative !== ".tau/extensions");
			if (ignored.length > 0) console.log(dim(`Ignored ${ignored.join(", ")}: directory not trusted.`));
		}
	}
	// Project codemode settings count only for a trusted directory.
	configureBuiltins({ cwd, projectTrusted, home: userHome() });
	// Connectors (P32b): MCP servers from ~/.tau/mcp.json and, when trusted, the project's.
	if (mcp) {
		const { loadMcpConfig, withOAuth } = await import("./mcp-config.ts");
		const loadedMcp = loadMcpConfig({
			home: userHome(),
			cwd,
			projectTrusted,
			envAllow: readSettings(join(userHome(), ".tau", "settings.json")).shellEnvAllow ?? [],
		});
		for (const diagnostic of loadedMcp.diagnostics) console.log(dim(`mcp: ${diagnostic}`));
		if (loadedMcp.servers.length > 0) {
			const { createMcpExtension } = await import("@yophon/tau-ext-mcp");
			await registry.add([createMcpExtension({ servers: withOAuth(loadedMcp.servers, userHome()) })]);
		}
	}
	// User hooks (P35): ~/.tau/settings.json and, when trusted, the project's.
	if (hooks) {
		hooks.configure(loadHookConfig({ home: userHome(), cwd, projectTrusted }));
		for (const diagnostic of hooks.diagnostics) console.log(dim(`hooks: ${diagnostic}`));
		await registry.add([createHooksExtension(hooks)]);
	}
	reportExtensionLoad(registry);
	return { registry, projectTrusted };
}

/**
 * Extensions that failed to load were rolled back and skipped (pi); say which and
 * why, and name same-name registrations that lost to an earlier one (P23c).
 */
function reportExtensionLoad(registry: ExtensionRegistry): void {
	for (const { extension, error } of registry.loadErrors) {
		process.stderr.write(`[extension failed to load, skipped] ${extension}: ${error.message}\n`);
	}
	for (const warning of registry.warnings) process.stderr.write(`[extension conflict] ${warning}\n`);
}

function defaultSystemPrompt(cwd: string, toolNames: readonly string[], extraDirs: readonly string[] = []): string {
	// Name the tools actually loaded: read-only mode has no write/edit, and a prompt
	// promising them invites calls that can only fail (HF-16). The built-in tool
	// prompt keeps this line equal to the declared tools at each run (P24e).
	return [
		"You are tau, a coding agent running in a terminal.",
		`Working directory: ${cwd}`,
		...(extraDirs.length > 0 ? [`Additional working directories: ${extraDirs.join(", ")}`] : []),
		toolLine(toolNames),
		"Be direct and concise. Answer questions before making changes.",
	].join("\n");
}

function firstLine(text: string, max = 120): string {
	const line = text.split("\n")[0];
	return line.length > max ? `${line.slice(0, max)}…` : line;
}

/** P36d: converts and shrinks images for read, `@file` and pasted screenshots (pi). */
const imageProcessor = new NodeImageProcessor();
/** Abort controller of the currently running turn, if any (consulted by the REPL's SIGINT handling). */
const turnState: { controller: AbortController | null } = { controller: null };
/** A REPL command holding the agent outside a turn (P23e): extension prompts are refused meanwhile. */
let hostTask: "compact" | "tree" | undefined;
let hostTaskController: AbortController | undefined;
/** Approval prompts say when the call came from another tool (a codemode script, P24c). */
function nestedNote(request: ApprovalRequest): string {
	if (request.subagent !== undefined) return `, called by subagent ${request.subagent}`;
	return request.parentToolCallId === undefined ? "" : ", called by another tool";
}

/** Resolver for the single readline line currently awaited by an approval gate. */
let pendingApproval: { resolve: (choice: ApprovalChoice) => void } | undefined;
/** Marks the current readline event when an approval answer was consumed. */
let approvalLineConsumed = false;

function consumeApprovalLine(line: string): boolean {
	const pending = pendingApproval;
	if (!pending) return false;
	pendingApproval = undefined;
	const answer = line.trim().toLowerCase();
	const choice: ApprovalChoice =
		answer === "a" || answer === "always" ? "always" : answer === "y" || answer === "yes" ? "once" : "deny";
	pending.resolve(choice);
	approvalLineConsumed = true;
	// When a turn owns the readline listener there is no outer REPL loop to clear
	// this marker; let the current event finish before resetting it.
	setTimeout(() => {
		approvalLineConsumed = false;
	}, 0);
	return true;
}

function cancelPendingApproval(): void {
	const pending = pendingApproval;
	if (!pending) return;
	pendingApproval = undefined;
	pending.resolve("deny");
}

/**
 * Run one prompt in the REPL or -p. Returns false when it failed: the last reply
 * errored, was aborted or was cut off by the output limit, or the run threw —
 * -p turns that into exit code 1 (pi print mode). Failures go to stderr.
 */
async function runTurn(agent: Agent, input: UserContent | null, readline: Readline): Promise<boolean> {
	const controller = new AbortController();
	turnState.controller = controller;
	const onSigint = (): void => {
		controller.abort();
	};
	process.on("SIGINT", onSigint);
	// Lines typed while the turn is running become steering messages.
	const onLine = (line: string): void => {
		const text = line.trim();
		// An approval question uses the same readline stream.  Do not turn its
		// answer into a steering message for the agent that is waiting on it.
		if (approvalLineConsumed || consumeApprovalLine(text) || pendingApproval) return;
		if (text !== "") void agent.steer(text);
	};
	readline.on("line", onLine);
	let sawReasoning = false;
	let lastStop: string | undefined;
	let threw = false;
	try {
		// input null = continuation without new user input (extension triggerTurn).
		const stream = input === null ? agent.resume(controller.signal) : agent.prompt(input, controller.signal);
		for await (const event of stream) {
			switch (event.type) {
				case "reasoning_delta":
					sawReasoning = true;
					process.stdout.write(dim(event.delta));
					break;
				case "text_delta":
					if (sawReasoning) {
						sawReasoning = false;
						process.stdout.write("\n\n");
					}
					process.stdout.write(event.delta);
					break;
				case "assistant_message":
					lastStop = event.message.stopReason;
					if (event.message.stopReason === "aborted") {
						process.stderr.write(`\n${dim("Turn aborted.")}\n`);
						break;
					}
					if (event.message.stopReason === "error") {
						process.stderr.write(`\n${red(`Error: ${event.message.errorMessage ?? "unknown provider error"}`)}\n`);
						break;
					}
					if (messageText(event.message) !== "" || thinkingText(event.message) !== "") process.stdout.write("\n");
					if (event.message.stopReason === "length") {
						// The partial text is already printed (pi 1.2.0 #10799).
						process.stderr.write(`${dim("[warning: the reply hit the output token limit and is incomplete]")}\n`);
					}
					break;
				case "user_message":
					process.stdout.write(dim(`↳ steered: ${firstLine(messageText(event.message))}\n`));
					break;
				case "tool_start":
					process.stdout.write(
						`${cyan(`⚙ ${event.toolCall.name}`)} ${dim(firstLine(JSON.stringify(event.toolCall.arguments)))}\n`,
					);
					break;
				case "tool_update":
					break;
				case "compaction":
					process.stdout.write(dim(`[compacted: ~${event.result.tokensBefore} tokens summarized]\n`));
					break;
				case "compaction_failed":
					process.stdout.write(
						dim(
							event.aborted
								? `[${event.reason} compaction aborted]\n`
								: `[${event.reason} compaction failed, continuing: ${firstLine(event.errorMessage ?? "")}]\n`,
						),
					);
					break;
				case "auto_retry_start":
					process.stdout.write(
						dim(
							`[retry ${event.attempt}/${event.maxAttempts} in ${Math.round(event.delayMs / 1000)}s: ${firstLine(event.errorMessage)}]\n`,
						),
					);
					break;
				case "auto_retry_end":
					if (!event.success && event.finalError !== undefined) {
						process.stdout.write(dim(`[retry gave up after ${event.attempt}: ${firstLine(event.finalError)}]\n`));
					}
					break;
				case "tool_result": {
					const marker = event.result.isError ? red("✗") : dim("✓");
					process.stdout.write(`${marker} ${dim(firstLine(toolResultText(event.result)))}\n`);
					break;
				}
				case "agent_end": {
					const last = agent.messages.at(-1);
					if (last?.role === "assistant" && last.usage.totalTokens > 0) {
						// Cache hits are no longer part of `input` (P23d, pi usage).
						const cached = last.usage.cacheRead > 0 ? ` (+${last.usage.cacheRead} cached)` : "";
						process.stdout.write(dim(`[tokens: ${last.usage.input} in${cached}, ${last.usage.output} out]\n`));
					}
					break;
				}
			}
		}
	} catch (error) {
		threw = true;
		const message = error instanceof Error ? error.message : String(error);
		process.stderr.write(`\n${red(`Error: ${message}`)}\n`);
	} finally {
		cancelPendingApproval();
		turnState.controller = null;
		readline.removeListener("line", onLine);
		process.removeListener("SIGINT", onSigint);
		// Queues survive an abort (kernel contract): drop what the run left instead of
		// replaying it into the next prompt, and say so — a REPL has no editor to refill.
		const { steering, followUp } = agent.clearQueue();
		for (const message of [...steering, ...followUp]) {
			const text = message.role === "user" ? userContentText(message.content) : `[${message.customType}]`;
			process.stdout.write(dim(`[dropped queued message: ${firstLine(text)}]\n`));
		}
	}
	return !threw && lastStop !== "error" && lastStop !== "aborted" && lastStop !== "length";
}

async function runCommand(
	agent: Agent,
	extensions: ExtensionRegistry,
	input: string,
	readline: Readline,
): Promise<void> {
	const spaceIndex = input.indexOf(" ");
	const name = (spaceIndex === -1 ? input : input.slice(0, spaceIndex)).slice(1);
	const args = spaceIndex === -1 ? "" : input.slice(spaceIndex + 1).trim();
	if (name === "help") {
		const commands = [...extensions.commands.values()];
		if (commands.length === 0) console.log(dim("No extension commands registered."));
		for (const command of commands) console.log(`/${command.name} — ${command.description}`);
		return;
	}
	const command = extensions.commands.get(name);
	if (!command) {
		console.log(red(`Unknown command: /${name} (try /help)`));
		return;
	}
	try {
		const output = await command.handler(args, agent.extensionContext());
		// Extension actions (sendMessage, appendEntry, …) append to the log asynchronously (P22).
		await agent.flush();
		if (typeof output === "string") {
			console.log(output);
		} else if (output?.action === "prompt") {
			await runTurn(agent, output.text, readline);
		}
	} catch (error) {
		console.log(red(`Command failed: ${error instanceof Error ? error.message : String(error)}`));
	}
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
	for (const dir of options.addDirs ?? []) {
		const path = resolve(dir.startsWith("~/") ? join(home, dir.slice(2)) : dir);
		if (!existsSync(path) || !statSync(path).isDirectory()) {
			console.error(`--add-dir: ${path} is not a directory`);
			process.exit(1);
		}
	}
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
	const out = stdoutWriter();
	const rpcBridge = options.mode === "rpc" ? new RpcUiBridge(out) : undefined;
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
		approvalPromptRef.current = async (request) => {
			console.log(`${cyan(`Approval: ${request.toolName}`)} ${dim(`(${request.risk} risk${nestedNote(request)})`)}`);
			if (request.reason) console.log(dim(request.reason));
			console.log(dim(firstLine(JSON.stringify(request.args), 200)));
			process.stdout.write(
				request.always ? `\nAllow? [y]es once / [a] ${request.always.label} / [N]o ` : "\nAllow? [y]es once / [N]o ",
			);
			return await new Promise<ApprovalChoice>((resolve) => {
				// Tool preflight is serial, but resolving a stale gate defensively keeps
				// an aborted/closed turn from blocking the next one forever.
				cancelPendingApproval();
				pendingApproval = { resolve };
			});
		};
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
		/** P32c: the audit's host, trigger and approval kind for this workspace (the gateway's chats). */
		audit?: {
			host?: AuditHost;
			approvals?: "terminal" | "chat";
			decidedBy?: (toolCallId: string) => string | undefined;
			current?: () => { runId?: string; trigger: AuditTrigger };
		};
	}) => {
		const cwd = spec.cwd;
		let workspaceMode = spec.permissionMode;
		// The audit ledger (P32c): who decided each approval, and a record per run and tool call.
		const approvals = new ApprovalLog();
		const settings = readSettings(join(userHome(), ".tau", "settings.json"));
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
		});
		// ask_user (P35) leads the host's extensions: wherever there is someone to ask.
		const askUser =
			spec.ui !== undefined && spec.askUser !== false
				? createAskUserExtension({
						wait: () => readSettings(join(userHome(), ".tau", "settings.json")).askUserWait === true,
						freeAnswer: spec.askUser?.freeAnswer ?? true,
						...(spec.askUser?.unavailable ? { unavailable: spec.askUser.unavailable } : {}),
						onAsk: () => hookRunner.notify("Tau has a question for you", "elicitation_dialog"),
					})
				: undefined;
		// P36a: background commands, one list per workspace (a gateway conversation has its own).
		const background = new NodeBackgroundShell(cwd, { env: modelEnvironment() });
		const hostExtensions = [
			...(askUser ? [askUser] : []),
			createBackgroundExtension(background),
			...(spec.extensions ?? []),
		];
		const trustUi = spec.trustPrompt === false ? undefined : spec.ui;
		const loaded = await loadExtensionRegistry(
			cwd,
			trustUi,
			hostExtensions,
			spec.memory,
			spec.mcp ?? true,
			auditExtension,
			hookRunner,
		);
		const extensions = loaded.registry;
		// The trust decision for project resources (ctx.isProjectTrusted, project paths); /reload re-decides.
		let projectTrusted = loaded.projectTrusted;
		// Permission rules (P37a): settings files, flags, /permissions; "always allow" saves rules.
		let currentAgent: Agent | undefined;
		const permissions =
			spec.permissionRules === false
				? undefined
				: new WorkspacePermissions({
						home: userHome(),
						cwd,
						projectTrusted: () => projectTrusted,
						allowedTools: options.allowedTools ?? [],
						disallowedTools: options.disallowedTools ?? [],
						addDirs: options.addDirs ?? [],
						acceptEdits: () => {
							currentAgent?.setPermissionMode("accept-edits");
							if (workspaceMode !== undefined) workspaceMode = "accept-edits";
							else permissionMode = "accept-edits";
						},
						onProjectFileWritten: () => {
							if (projectTrusted) void saveProjectTrust(cwd, true);
						},
					});
		for (const diagnostic of permissions?.diagnostics() ?? []) console.error(dim(`permissions: ${diagnostic}`));
		if (permissions) await extensions.add([createPermissionsExtension(permissions)]);
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
				spec.mcp ?? true,
				auditExtension,
				hookRunner,
			);
			projectTrusted = next.projectTrusted;
			if (permissions) await next.registry.add([createPermissionsExtension(permissions)]);
			next.registry.setFlagValues(resolveExtensionFlags(next.registry, options.extras).values);
			return next.registry;
		};

		const fs: FileSystem = spec.fs ?? new NodeFileSystem(cwd);
		// The user's own `!` commands get the full environment; the tools the model calls get it
		// without secret-looking variables (P32b). Secrets are registered first so their values go too.
		const shell = new NodeShell(cwd);
		const toolShell = new NodeShell(cwd, { env: modelEnvironment() });
		// Project context files (P21a, pi loadProjectContextFiles): ~/.tau first, then
		// every directory from the root down to cwd. Appended to any system prompt.
		const loadProjectContext = async (): Promise<string> =>
			options.noContextFiles
				? ""
				: renderProjectContext(await loadProjectContextFiles(fs, { cwd, globalDir: join(userHome(), ".tau") }));
		let projectContext = await loadProjectContext();
		const sessionRepo = new JsonlSessionRepo(
			new NodeFileSystem("/"),
			platform,
			spec.sessionDir ?? join(userHome(), ".tau", "sessions", sessionDirSlug(cwd)),
			cwd,
		);
		const buildAgent = (
			messages: AgentMessage[] | undefined,
			session: SessionRecorder | undefined,
			agentExtensions = extensions,
		): Agent => {
			const mode = workspaceMode ?? permissionMode;
			const codingTools = createCodingTools(
				{ fs, shell: toolShell, background, images: imageProcessor },
				{ mode, supportsImages: modelTakesImages },
			);
			const built = new Agent({
				config,
				transport,
				platform,
				systemPrompt: [
					options.system ??
						defaultSystemPrompt(
							cwd,
							codingTools.map((tool) => tool.name),
							permissions?.workingDirectories() ?? [],
						),
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
						cwd,
						userTauDir: join(userHome(), ".tau"),
						// Project paths only for a trusted project (defense in depth; extensions also ask ctx).
						...(projectTrusted ? { projectTauDir: join(cwd, ".tau"), projectPiDir: join(cwd, ".pi") } : {}),
					},
				},
				isProjectTrusted: () => projectTrusted,
				initialMessages: messages,
				session,
				retry,
				pricing,
				thinkingLevel,
				permissionMode: mode,
				toolExecution,
				onApproval: onWorkspaceApproval,
				...(policy ? { policy } : {}),
				// No cap unless settings.json sets one (P34 follow-up: pi does not cap a prompt).
				...(userSettings.maxTurnsPerPrompt !== undefined ? { maxTurnsPerPrompt: userSettings.maxTurnsPerPrompt } : {}),
			});
			// --tools / --no-tools narrow the active set; a permission mode's missing tools stay missing (D20).
			const active = selectActiveTools(
				built.getAllTools(),
				built.getActiveTools(),
				options.tools,
				options.noTools === true,
			);
			if (active) built.setActiveTools(active);
			attachPromptAgent(built, options.system === undefined);
			currentAgent = built;
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
			/** P36a: this workspace's background commands. */
			background,
			/** P37a: this workspace's permission rules (undefined in the gateway). */
			permissions,
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
			files = await processFileArguments(options.files, cwd, imageProcessor);
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
	let recorder = store ? await SessionRecorder.open(store) : undefined;
	/** Session ids whose title was requested (P34f). */
	const titled = new Set<string>();

	let agent = buildAgent(initialMessages, recorder);

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
			autoTitle: autoTitleOn(userSettings.autoTitle),
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
			setApprovalPrompt: (prompt) => {
				approvalPromptRef.current = prompt;
			},
			buildAgent,
			reloadExtensions,
			sessionReason,
		});
		return;
	}

	if (!readline) throw new Error("interactive REPL requires readline");
	if (contextWindow === undefined) {
		console.log(dim("No --context-window configured: auto-compaction is off (use /compact manually)."));
	}
	// Host actions for extension-triggered runs (sendUserMessage / sendMessage
	// triggerTurn while idle). Closures read the live `agent` binding, so they
	// stay correct across /fork agent swaps.
	// Runs requested while a turn was finishing (agent_settled handlers) start after it.
	const pendingStarts: (UserContent | null)[] = [];
	const startPending = (): void => {
		if (turnState.controller || hostTask) return;
		const next = pendingStarts.shift();
		if (next !== undefined) void runTurn(agent, next, readline).finally(startPending);
	};
	extensions.attachHostActions({
		submitPrompt: (content) => {
			if (turnState.controller) {
				pendingStarts.push(content);
				return;
			}
			// A compaction or navigation holds the REPL: refuse loudly so the caller can retry (HF-11).
			if (hostTask) throw new TauError("busy", `/${hostTask} is running`);
			void runTurn(agent, content, readline).finally(startPending);
		},
		resumeTurn: () => {
			if (turnState.controller || hostTask) {
				if (!pendingStarts.includes(null)) pendingStarts.push(null);
				return;
			}
			void runTurn(agent, null, readline).finally(startPending);
		},
		shutdown: () => {
			readline.close();
		},
	});
	// session_start after the host actions are in place (P23e, pi bindExtensions order).
	await extensions.notifySessionStart(sessionReason, agent.extensionContext());
	const extensionNote = extensions.tools.size + extensions.commands.size > 0 ? " · extensions loaded" : "";
	const providerNote = provider === "anthropic" ? " · anthropic" : "";
	console.log(
		dim(
			`tau · ${model} @ ${effectiveBaseUrl}${providerNote} · cwd ${cwd} · ${permissionMode}${extensionNote} · "exit" or Ctrl+D to quit`,
		),
	);
	// In a TTY, readline intercepts Ctrl+C: abort the running turn if there is
	// one, otherwise quit the REPL.
	readline.on("SIGINT", () => {
		if (turnState.controller) {
			turnState.controller.abort();
		} else if (hostTaskController) {
			hostTaskController.abort();
		} else {
			readline.close();
		}
	});
	// Command-line prompts (P36c) before the first "tau> ".
	const replFirst = initialContent(files, messages[0]);
	if (replFirst !== undefined) {
		for (const prompt of [replFirst, ...messages.slice(1)]) {
			if (!(await runTurn(agent, prompt, readline))) break;
		}
	}
	while (true) {
		let line: string;
		try {
			line = await readline.question("tau> ");
		} catch {
			break;
		}
		const input = line.trim();
		// A Feishu-triggered run can start while this outer question is pending.
		// Its line listener (above) has already handled the line as steering (or
		// the approval question has consumed it).  Wait for that run to finish
		// before opening another `readline.question`; concurrent questions are what
		// previously caused approval answers to launch a second prompt().
		const approvalConsumed = approvalLineConsumed || consumeApprovalLine(input);
		approvalLineConsumed = false;
		if (turnState.controller || approvalConsumed) {
			while (turnState.controller) await new Promise<void>((resolve) => setTimeout(resolve, 10));
			continue;
		}
		if (input === "") continue;
		if (input === "exit" || input === "quit") break;
		if (input.startsWith("/")) {
			if (input === "/sessions") {
				for (const session of await sessionRepo.list()) {
					console.log(`${session.timestamp}  ${session.name ?? dim("(unnamed)")}  ${dim(session.filePath ?? "")}`);
				}
				continue;
			}
			if (input === "/compact" || input.startsWith("/compact ")) {
				const instructions = input.slice("/compact".length).trim();
				hostTask = "compact";
				hostTaskController = new AbortController();
				try {
					const result = await agent.compact(
						instructions === "" ? undefined : instructions,
						"manual",
						hostTaskController.signal,
					);
					console.log(
						result ? dim(`Compacted: ~${result.tokensBefore} tokens summarized.`) : dim("Nothing to compact."),
					);
				} catch (error) {
					if (error instanceof TauError && error.code === "cancelled") console.log(dim("Compaction cancelled."));
					else if (error instanceof TauError && error.code === "aborted") console.log(dim("Compaction aborted."));
					else console.log(red(`Compaction failed: ${error instanceof Error ? error.message : String(error)}`));
				} finally {
					hostTask = undefined;
					hostTaskController = undefined;
					startPending();
				}
				continue;
			}
			if (input.startsWith("/name ")) {
				const name = input.slice("/name ".length).trim();
				if (recorder && name !== "") {
					await recorder.setName(name);
					await extensions.notifySessionInfoChanged(name, agent.extensionContext());
					console.log(dim(`Session named "${name}".`));
				} else {
					console.log(red(recorder ? "Usage: /name <name>" : "No active session (--no-session)."));
				}
				continue;
			}
			if (input === "/tree" || input.startsWith("/tree ")) {
				if (!store) {
					console.log(red("No active session (--no-session)."));
					continue;
				}
				const arg = input.slice("/tree".length).trim();
				if (arg === "") {
					const entries = await store.getEntries();
					const onPath = new Set((await store.getPathToRoot(await store.getLeafId())).map((entry) => entry.id));
					let shown = 0;
					for (const entry of entries) {
						if (entry.type !== "message" || entry.message.role !== "user") continue;
						const marker = onPath.has(entry.id) ? "●" : dim("○");
						console.log(`${marker} ${cyan(entry.id)}  ${firstLine(messageText(entry.message), 80)}`);
						shown++;
					}
					console.log(
						shown === 0
							? dim("No user messages in this session yet.")
							: dim("Jump with /tree <id> (● = on current path)."),
					);
					continue;
				}
				// "/tree <id> --no-summary" navigates without summarizing the abandoned branch.
				const noSummary = arg.endsWith(" --no-summary");
				const target = noSummary ? arg.slice(0, -" --no-summary".length).trim() : arg;
				hostTask = "tree";
				hostTaskController = new AbortController();
				try {
					const result = await agent.navigateTo(target, {
						signal: hostTaskController.signal,
						...(noSummary ? { summarize: false } : {}),
					});
					console.log(
						result.cancelled
							? dim("Navigation cancelled.")
							: dim(`Moved to ${target} (${conversationLength(agent.messages)} messages in context).`),
					);
				} catch (error) {
					console.log(red(`/tree failed: ${error instanceof Error ? error.message : String(error)}`));
					if (error instanceof TauError && error.code === "compaction_failed") {
						console.log(dim(`Navigate without a summary: /tree ${target} --no-summary`));
					}
				} finally {
					hostTask = undefined;
					hostTaskController = undefined;
					startPending();
				}
				continue;
			}
			if (input === "/fork" || input.startsWith("/fork ")) {
				if (!store) {
					console.log(red("No active session (--no-session)."));
					continue;
				}
				const arg = input.slice("/fork".length).trim();
				try {
					// A full copy has no fork point to negotiate over, so the
					// session_before_fork event only fires for entry-targeted forks.
					if (arg !== "") {
						const decision = await extensions.runSessionBeforeFork(
							{ entryId: arg, position: "before" },
							agent.extensionContext(),
						);
						if (decision.cancel) {
							console.log(dim("Fork cancelled."));
							continue;
						}
					}
					const source = await store.getMetadata();
					const newStore = await sessionRepo.fork(source, arg === "" ? undefined : { entryId: arg });
					const meta = await newStore.getMetadata();
					// Switching into the fork is a session switch: extensions may veto it.
					const switchDecision = await extensions.runSessionBeforeSwitch(
						{ reason: "resume", targetSessionFile: meta.filePath },
						agent.extensionContext(),
					);
					if (switchDecision.cancelled) {
						console.log(dim("Session switch cancelled by an extension (fork file kept)."));
						continue;
					}
					const restored = await restoreSession(newStore);
					store = newStore;
					recorder = await SessionRecorder.open(newStore);
					agent = buildAgent(restored.messages, recorder);
					await extensions.notifySessionStart("resume", agent.extensionContext());
					console.log(
						dim(`Forked to ${meta.filePath ?? meta.id} (${conversationLength(restored.messages)} messages).`),
					);
				} catch (error) {
					console.log(red(`/fork failed: ${error instanceof Error ? error.message : String(error)}`));
				}
				continue;
			}
			await runCommand(agent, extensions, input, readline);
			continue;
		}
		await runTurn(agent, input, readline);
		// P34f: name the session after its first turn (in the background; failures are silent).
		if (recorder && autoTitleOn(userSettings.autoTitle)) void autoTitle(agent, recorder, titled);
	}
	await extensions.notifySessionShutdown("quit", agent.extensionContext());
	readline.close();
}

await main();
