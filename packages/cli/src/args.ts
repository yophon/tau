// Command-line arguments (P50: split out of main.ts, like pi's cli/args.ts): the usage text,
// the options, `tau gateway`, and the number, pricing and mode values flags and environment
// variables take.
import { resolve } from "node:path";
import type { ModelPricing, PermissionMode, ToolExecutionMode } from "@yophon/tau-kernel";
import { splitRuleList } from "./permissions.ts";
import { isWorktreeName } from "./worktree.ts";

export const USAGE = `tau - minimal OpenAI-compatible coding agent

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
  -s, --system-prompt <text|file>  Replace the system prompt (also --system; default:
                         .tau/SYSTEM.md of a trusted project, else ~/.tau/SYSTEM.md, else tau's)
      --append-system-prompt <text|file>  Append to the system prompt (repeatable; default:
                         .tau/APPEND_SYSTEM.md of a trusted project, else ~/.tau/APPEND_SYSTEM.md)
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
      --worktree [name]  Work in a new git worktree <repo>/.tau/worktrees/<name> on branch
                         worktree-<name> (a name is generated when none is given; an
                         existing one is opened again). On exit a clean worktree with a
                         generated name is removed, otherwise you choose. Not with
                         --mode rpc/acp or the gateway. settings: worktree.baseRef
                         ("fresh" = origin's default branch, "head"), worktree.symlinkDirectories
  -c, --continue         Resume the most recent session for this directory
      --session <path>   Resume a specific session file
      --session-dir <dir>  Keep sessions in this directory (settings.json sessionDir)
      --no-session       Do not persist this conversation
  -nc, --no-context-files  Do not load AGENTS.md / CLAUDE.md into the system prompt
  -e,  --extension <path>  Load an extension file or directory for this run (repeatable)
  -ne, --no-extensions   No extensions from ~/.tau/extensions, .tau/extensions or settings
                         (-e paths still load)
      --no-mcp           No MCP servers for this run
      --skill <path>     Load a skill file or directory (repeatable)
  -ns, --no-skills       Only the --skill paths: no skills from the usual directories or settings
      --prompt-template <path>  Load a prompt template file or directory (repeatable)
  -np, --no-prompt-templates  Only the --prompt-template paths
  -v,  --version         Print the version and exit
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

export interface CliOptions {
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
	/** P40c (pi): --session-dir, where sessions are kept. */
	sessionDir?: string;
	noSession: boolean;
	noContextFiles?: boolean;
	/** P41b (pi -e/--extension): extension files or directories for this run, resolved against the cwd. */
	extensionPaths?: string[];
	/** P41b (pi -ne): no discovered or configured extensions (explicit -e paths still load). */
	noExtensions?: boolean;
	/** P41b (pi --no-mcp): no MCP servers for this run. */
	noMcp?: boolean;
	/** P41b (pi --skill / --prompt-template): explicit resource paths, resolved against the cwd. */
	skillPaths?: string[];
	promptPaths?: string[];
	/** P41b (pi -ns / -np): only the explicit skill / prompt template paths load. */
	noSkills?: boolean;
	noPrompts?: boolean;
	/** P41b (pi --append-system-prompt): text or files appended to the system prompt, in order. */
	appendSystemPrompt?: string[];
	/** P41b (pi -v): print the version and exit. */
	version?: boolean;
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
	/** P37d: --worktree [name] (Claude Code). */
	worktree?: { name?: string };
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

export function parseGatewayArgs(argv: string[]): CliOptions {
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

export function parseArgs(argv: string[]): CliOptions {
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
			const freeText =
				arg === "-p" ||
				arg === "--print" ||
				arg === "-s" ||
				arg === "--system" ||
				arg === "--system-prompt" ||
				arg === "--append-system-prompt";
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
			case "--system-prompt":
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
			case "--worktree": {
				// The next word is the name when it looks like one (Claude Code's optional argument).
				const candidate = argv[i + 1];
				if (isWorktreeName(candidate) && !candidate.startsWith("-")) {
					options.worktree = { name: candidate };
					i++;
				} else {
					options.worktree = {};
				}
				break;
			}
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
			case "--session-dir":
				options.sessionDir = next();
				break;
			case "--no-session":
				options.noSession = true;
				break;
			case "-nc":
			case "--no-context-files":
				options.noContextFiles = true;
				break;
			// P41b: pi's resource flags.
			case "-e":
			case "--extension":
				options.extensionPaths = [...(options.extensionPaths ?? []), next()];
				break;
			case "-ne":
			case "--no-extensions":
				options.noExtensions = true;
				break;
			case "--no-mcp":
				options.noMcp = true;
				break;
			case "--skill":
				options.skillPaths = [...(options.skillPaths ?? []), next()];
				break;
			case "-ns":
			case "--no-skills":
				options.noSkills = true;
				break;
			case "--prompt-template":
				options.promptPaths = [...(options.promptPaths ?? []), next()];
				break;
			case "-np":
			case "--no-prompt-templates":
				options.noPrompts = true;
				break;
			case "--append-system-prompt":
				options.appendSystemPrompt = [...(options.appendSystemPrompt ?? []), next()];
				break;
			case "-v":
			case "--version":
				options.version = true;
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

export const PRICING_KEYS: Record<string, keyof ModelPricing> = {
	in: "inputPerMTok",
	out: "outputPerMTok",
	cacheRead: "cacheReadPerMTok",
	cacheWrite: "cacheWritePerMTok",
};

/** Parse "in=0.5,out=2,cacheRead=0.05,cacheWrite=0.625" (cache keys optional). */
/** A whole number written as digits only ("128k", "1e5", "12.5" are rejected), or undefined. */
export function parseNonNegativeInt(text: string): number | undefined {
	if (!/^\d+$/.test(text.trim())) return undefined;
	const value = Number(text.trim());
	return Number.isSafeInteger(value) ? value : undefined;
}

/** An integer env knob: unset → undefined; malformed or below `min` → warning and undefined (P14–P16 env convention). */
export function envInt(name: string, min: number): number | undefined {
	const raw = process.env[name];
	if (raw === undefined || raw.trim() === "") return undefined;
	const value = parseNonNegativeInt(raw);
	if (value === undefined || value < min) {
		console.error(`Ignoring ${name}="${raw}" (expected a whole number >= ${min})`);
		return undefined;
	}
	return value;
}

export function parsePricing(spec: string): ModelPricing | Error {
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

export function splitList(value: string | undefined): string[] {
	return (value ?? "")
		.split(",")
		.map((item) => item.trim())
		.filter((item) => item !== "");
}

export const PERMISSION_MODES: readonly PermissionMode[] = [
	"read-only",
	"supervised",
	"accept-edits",
	"autonomous",
	"bypass",
];

export function isPermissionMode(value: string): value is PermissionMode {
	return (PERMISSION_MODES as readonly string[]).includes(value);
}

export const TOOL_EXECUTION_MODES: readonly ToolExecutionMode[] = ["sequential", "parallel"];

export function isToolExecutionMode(value: string): value is ToolExecutionMode {
	return (TOOL_EXECUTION_MODES as readonly string[]).includes(value);
}

export const PROVIDERS = ["openai", "anthropic"] as const;

export type ProviderKind = (typeof PROVIDERS)[number];

export function isProvider(value: string): value is ProviderKind {
	return (PROVIDERS as readonly string[]).includes(value);
}
