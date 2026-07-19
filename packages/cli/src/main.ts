#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { digestDirectory, loadExtensionsFromDir, NodeFileSystem, NodeShell } from "@yophon/tau-host-node";
import {
	Agent,
	type ApprovalRequest,
	createCodingTools,
	defaultPlatform,
	ExtensionRegistry,
	JsonlSessionRepo,
	type ModelPricing,
	messageText,
	type OpenAICompatConfig,
	type PermissionMode,
	restoreSession,
	SessionRecorder,
	type SessionStore,
	sessionDirSlug,
	type ThinkingLevel,
	thinkingText,
	type UiCapability,
} from "@yophon/tau-kernel";
import { createStartupTuiUi, runTui } from "./tui.ts";

const USAGE = `tau - minimal OpenAI-compatible coding agent

Usage: tau [options] [-p "prompt"]

Options:
  -b, --base-url <url>   API base URL (env: TAU_BASE_URL, OPENAI_BASE_URL)
  -k, --api-key <key>    API key (env: TAU_API_KEY, OPENAI_API_KEY)
  -m, --model <model>    Model id (env: TAU_MODEL)
      --models <list>    Comma-separated TUI model selector candidates (env: TAU_MODELS)
  -s, --system <text>    Override the system prompt
  -p, --print <prompt>   One-shot mode: run a single prompt and exit
      --tui              Use the TUI interactive mode
  -w, --context-window <n>  Model context window in tokens; enables auto-compaction
                         (env: TAU_CONTEXT_WINDOW)
      --pricing <spec>   Unit prices, USD per million tokens, e.g.
                         "in=0.5,out=2,cacheRead=0.05,cacheWrite=0.625"
                         (cache keys optional and uncounted when omitted;
                         env: TAU_PRICING). Enables real cost in the footer.
      --permission-mode <mode>  read-only | supervised | autonomous | bypass
                         (default: supervised; env: TAU_PERMISSION_MODE).
                         supervised asks before medium/high-risk tools;
                         headless (piped) runs deny instead of asking.
                         read-only registers only the read tool.
  -c, --continue         Resume the most recent session for this directory
      --session <path>   Resume a specific session file
      --no-session       Do not persist this conversation
  -h, --help             Show this help

REPL commands: /name <name>, /sessions, /compact [instructions], /tree [<id>],
/fork [<id>], /help. /tree lists jump points; /tree <id> navigates there
(summarizing the abandoned branch); /fork copies the session into a new file
(up to <id> if given) and switches to it.

Extensions may declare additional --<flag> options (see registerFlag).
Retry/timeout env knobs: TAU_MAX_RETRIES (0 disables, default 3),
TAU_RETRY_BASE_DELAY_MS (default 2000, exponential), TAU_STALL_TIMEOUT_MS
(default 120000, 0 disables the dry-stream watchdog).
Without -p, tau starts an interactive REPL. During a running turn, typed lines
are queued as steering messages. Ctrl+C aborts the current turn.`;

interface CliOptions {
	baseUrl?: string;
	apiKey?: string;
	model?: string;
	models?: string[];
	system?: string;
	print?: string;
	tui: boolean;
	continue: boolean;
	contextWindow?: number;
	pricing?: ModelPricing;
	permissionMode?: PermissionMode;
	sessionPath?: string;
	noSession: boolean;
	help: boolean;
	/** Unrecognized tokens, matched against extension-declared flags after loading. */
	extras: string[];
}

function parseArgs(argv: string[]): CliOptions {
	const options: CliOptions = { help: false, extras: [], continue: false, noSession: false, tui: false };
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		const next = (): string => {
			const value = argv[++i];
			if (value === undefined) {
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
				const parsed = Number.parseInt(next(), 10);
				if (!Number.isFinite(parsed) || parsed <= 0) {
					console.error("--context-window must be a positive integer");
					process.exit(1);
				}
				options.contextWindow = parsed;
				break;
			}
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
			case "--session":
				options.sessionPath = next();
				break;
			case "--no-session":
				options.noSession = true;
				break;
			case "--tui":
				options.tui = true;
				break;
			case "-h":
			case "--help":
				options.help = true;
				break;
			default:
				options.extras.push(arg);
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

function splitList(value: string | undefined): string[] {
	return (value ?? "")
		.split(",")
		.map((item) => item.trim())
		.filter((item) => item !== "");
}

const PERMISSION_MODES: readonly PermissionMode[] = ["read-only", "supervised", "autonomous", "bypass"];

function isPermissionMode(value: string): value is PermissionMode {
	return (PERMISSION_MODES as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Approval persistence (P15): "always allow" decisions are keyed by tool name
// plus a rule fingerprint (the policy reason that fired, or the bare risk
// level), so one approval covers the rule, not the exact argument bytes.
// ---------------------------------------------------------------------------

type ApprovalChoice = "once" | "always" | "deny";

interface PermissionRule {
	tool: string;
	fingerprint: string;
	action: "allow";
}

function permissionsStorePath(): string {
	return join(homedir(), ".tau", "permissions.json");
}

function approvalFingerprint(request: ApprovalRequest): string {
	return request.reason ?? `risk:${request.risk}`;
}

function readPermissionRules(): PermissionRule[] {
	try {
		const parsed = JSON.parse(readFileSync(permissionsStorePath(), "utf8")) as { rules?: PermissionRule[] };
		return Array.isArray(parsed.rules) ? parsed.rules : [];
	} catch {
		return [];
	}
}

function isAlwaysAllowed(request: ApprovalRequest): boolean {
	const fingerprint = approvalFingerprint(request);
	return readPermissionRules().some(
		(rule) => rule.tool === request.toolName && rule.fingerprint === fingerprint && rule.action === "allow",
	);
}

function recordAlwaysAllow(request: ApprovalRequest): void {
	if (isAlwaysAllowed(request)) return;
	const rules = readPermissionRules();
	rules.push({ tool: request.toolName, fingerprint: approvalFingerprint(request), action: "allow" });
	const path = permissionsStorePath();
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify({ version: 1, rules }, null, "\t")}\n`, "utf8");
}

function uniqueStrings(values: string[]): string[] {
	return [...new Set(values)];
}

function resolveExtensionFlags(registry: ExtensionRegistry, extras: string[]): Record<string, boolean | string> {
	const values: Record<string, boolean | string> = {};
	for (let i = 0; i < extras.length; i++) {
		const token = extras[i];
		if (!token.startsWith("--")) {
			console.error(`Unexpected argument: ${token}`);
			process.exit(1);
		}
		const name = token.slice(2);
		const flag = registry.flags.get(name);
		if (!flag) {
			console.error(`Unknown option: ${token}`);
			process.exit(1);
		}
		if (flag.type === "boolean") {
			values[name] = true;
		} else {
			const value = extras[++i];
			if (value === undefined || value.startsWith("--")) {
				console.error(`Missing value for ${token}`);
				process.exit(1);
			}
			values[name] = value;
		}
	}
	return values;
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
	return join(homedir(), ".tau", "trust.json");
}

function readTrustStore(): TrustStore {
	try {
		const parsed = JSON.parse(readFileSync(trustStorePath(), "utf8")) as TrustStore;
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

async function isProjectTrusted(
	registry: ExtensionRegistry,
	cwd: string,
	ui: UiCapability | undefined,
	extensionsDir: string,
): Promise<boolean> {
	const store = readTrustStore();
	const digest = await digestDirectory(extensionsDir);
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
		console.log(dim("Project extensions changed since they were last trusted — confirming again."));
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
	const approved = await ui.confirm("Trust this directory and load its .tau/extensions?", cwd);
	store.trusted[cwd] = { trusted: approved, digest };
	writeTrustStore(store);
	return approved;
}

async function loadExtensionRegistry(cwd: string, ui: UiCapability | undefined): Promise<ExtensionRegistry> {
	const registry = await ExtensionRegistry.load(await loadExtensionsFromDir(join(homedir(), ".tau", "extensions")));
	const extensionsDir = join(cwd, ".tau", "extensions");
	const projectExtensions = await loadExtensionsFromDir(extensionsDir);
	if (projectExtensions.length === 0) return registry;
	if (await isProjectTrusted(registry, cwd, ui, extensionsDir)) {
		await registry.add(projectExtensions);
	} else {
		console.log(dim(`Skipped ${projectExtensions.length} project extension(s): directory not trusted.`));
	}
	return registry;
}

function defaultSystemPrompt(cwd: string): string {
	return [
		"You are tau, a coding agent running in a terminal.",
		`Working directory: ${cwd}`,
		"Use the available tools (read, write, edit, bash) to inspect and modify the project.",
		"Be direct and concise. Answer questions before making changes.",
	].join("\n");
}

function firstLine(text: string, max = 120): string {
	const line = text.split("\n")[0];
	return line.length > max ? `${line.slice(0, max)}…` : line;
}

function thinkingLevelFromExtraBody(extraBody: OpenAICompatConfig["extraBody"]): ThinkingLevel | undefined {
	const value = extraBody?.reasoning_effort;
	return typeof value === "string" && ["none", "minimal", "low", "medium", "high", "xhigh"].includes(value)
		? (value as ThinkingLevel)
		: undefined;
}

function setThinkingLevelInConfig(config: OpenAICompatConfig, level: ThinkingLevel | undefined): void {
	if (level === undefined) {
		if (!config.extraBody) return;
		const { reasoning_effort: _reasoningEffort, ...rest } = config.extraBody;
		config.extraBody = Object.keys(rest).length === 0 ? undefined : rest;
		return;
	}
	config.extraBody = { ...config.extraBody, reasoning_effort: level };
}

/** Abort controller of the currently running turn, if any (consulted by the REPL's SIGINT handling). */
const turnState: { controller: AbortController | null } = { controller: null };

async function runTurn(agent: Agent, input: string | null, readline: Readline): Promise<void> {
	const controller = new AbortController();
	turnState.controller = controller;
	const onSigint = (): void => {
		controller.abort();
	};
	process.on("SIGINT", onSigint);
	// Lines typed while the turn is running become steering messages.
	const onLine = (line: string): void => {
		const text = line.trim();
		if (text !== "") agent.steer(text);
	};
	readline.on("line", onLine);
	let sawReasoning = false;
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
					if (event.message.stopReason === "aborted") {
						process.stdout.write(`\n${dim("Turn aborted.")}\n`);
						break;
					}
					if (event.message.stopReason === "error") {
						process.stdout.write(`\n${red(`Error: ${event.message.errorMessage ?? "unknown provider error"}`)}\n`);
						break;
					}
					if (messageText(event.message) !== "" || thinkingText(event.message) !== "") process.stdout.write("\n");
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
					process.stdout.write(`${marker} ${dim(firstLine(event.result.output))}\n`);
					break;
				}
				case "agent_end": {
					const last = agent.messages.at(-1);
					if (last?.role === "assistant" && last.usage.totalTokens > 0) {
						process.stdout.write(dim(`[tokens: ${last.usage.input} in, ${last.usage.output} out]\n`));
					}
					break;
				}
			}
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		process.stdout.write(`\n${red(`Error: ${message}`)}\n`);
	} finally {
		turnState.controller = null;
		readline.removeListener("line", onLine);
		process.removeListener("SIGINT", onSigint);
	}
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
		if (typeof output === "string") {
			console.log(output);
		} else if (output?.action === "prompt") {
			await runTurn(agent, output.text, readline);
		}
	} catch (error) {
		console.log(red(`Command failed: ${error instanceof Error ? error.message : String(error)}`));
	}
}

async function main(): Promise<void> {
	const options = parseArgs(process.argv.slice(2));
	if (options.help) {
		console.log(USAGE);
		return;
	}

	const baseUrl = options.baseUrl ?? process.env.TAU_BASE_URL ?? process.env.OPENAI_BASE_URL;
	const apiKey = options.apiKey ?? process.env.TAU_API_KEY ?? process.env.OPENAI_API_KEY;
	const model = options.model ?? process.env.TAU_MODEL;
	if (!baseUrl || !model) {
		console.error("Missing --base-url and/or --model (or TAU_BASE_URL / TAU_MODEL env vars).\n");
		console.error(USAGE);
		process.exit(1);
	}

	const envWindow = Number.parseInt(process.env.TAU_CONTEXT_WINDOW ?? "", 10);
	const contextWindow = options.contextWindow ?? (Number.isFinite(envWindow) && envWindow > 0 ? envWindow : undefined);
	const modelChoices = uniqueStrings([model, ...(options.models ?? []), ...splitList(process.env.TAU_MODELS)]);
	const envStall = Number.parseInt(process.env.TAU_STALL_TIMEOUT_MS ?? "", 10);
	const config: OpenAICompatConfig = {
		baseUrl,
		apiKey,
		model,
		contextWindow,
		...(Number.isFinite(envStall) && envStall >= 0 ? { stallTimeoutMs: envStall } : {}),
	};
	let pricing = options.pricing;
	if (!pricing && process.env.TAU_PRICING) {
		const parsed = parsePricing(process.env.TAU_PRICING);
		// Env is a convenience knob: a bad value degrades to "cost unknown" with a
		// warning instead of refusing to start (the explicit flag does exit).
		if (parsed instanceof Error) console.error(`Ignoring TAU_PRICING: ${parsed.message}`);
		else pricing = parsed;
	}
	let permissionMode = options.permissionMode;
	if (!permissionMode && process.env.TAU_PERMISSION_MODE) {
		const value = process.env.TAU_PERMISSION_MODE;
		if (isPermissionMode(value)) permissionMode = value;
		else console.error(`Ignoring TAU_PERMISSION_MODE="${value}" (expected one of: ${PERMISSION_MODES.join(", ")})`);
	}
	// Interactive hosts default to supervised (P15 user ruling) — the kernel's
	// own default stays autonomous for library consumers.
	permissionMode ??= "supervised";
	const envMaxRetries = Number.parseInt(process.env.TAU_MAX_RETRIES ?? "", 10);
	const envRetryDelay = Number.parseInt(process.env.TAU_RETRY_BASE_DELAY_MS ?? "", 10);
	const retry = {
		...(Number.isFinite(envMaxRetries) && envMaxRetries >= 0
			? { maxRetries: envMaxRetries, enabled: envMaxRetries > 0 }
			: {}),
		...(Number.isFinite(envRetryDelay) && envRetryDelay > 0 ? { baseDelayMs: envRetryDelay } : {}),
	};
	const cwd = resolve(process.cwd());
	if (options.tui && options.print === undefined && (!process.stdin.isTTY || !process.stdout.isTTY)) {
		console.error("--tui requires a TTY stdin/stdout");
		process.exit(1);
	}
	const readline =
		options.tui && options.print === undefined
			? undefined
			: createInterface({ input: process.stdin, output: process.stdout });
	// Headless stdin (pipes, CI) cannot answer prompts; omit the UI capability
	// so extensions take their no-UI degradation path instead of hanging.
	const ui =
		options.tui && options.print === undefined
			? createStartupTuiUi()
			: readline && process.stdin.isTTY
				? createUi(readline)
				: undefined;
	const extensions = await loadExtensionRegistry(cwd, ui);
	extensions.setFlagValues(resolveExtensionFlags(extensions, options.extras));
	const reloadExtensions = async (reloadUi: UiCapability | undefined): Promise<ExtensionRegistry> => {
		const nextExtensions = await loadExtensionRegistry(cwd, reloadUi);
		nextExtensions.setFlagValues(resolveExtensionFlags(nextExtensions, options.extras));
		return nextExtensions;
	};

	const platform = defaultPlatform();
	const sessionRepo = new JsonlSessionRepo(
		new NodeFileSystem("/"),
		platform,
		join(homedir(), ".tau", "sessions", sessionDirSlug(cwd)),
		cwd,
	);
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
			console.log(
				dim(`Resumed session (${restored.messages.length} messages${restored.name ? `, "${restored.name}"` : ""}).`),
			);
		} else {
			store = await sessionRepo.create();
		}
	}
	let recorder = store ? await SessionRecorder.open(store) : undefined;

	const fs = new NodeFileSystem(cwd);
	const shell = new NodeShell(cwd);
	// Approval plumbing (P15): the kernel decides *when* to ask, the host owns
	// *how*. REPL and TUI install their prompt into approvalPromptRef below;
	// with no UI at all onApproval stays undefined so the kernel's headless
	// degradation (ask → deny) applies.
	const approvalPromptRef: { current?: (request: ApprovalRequest) => Promise<ApprovalChoice> } = {};
	const onApproval =
		ui === undefined
			? undefined
			: async (request: ApprovalRequest): Promise<boolean> => {
					if (isAlwaysAllowed(request)) return true;
					const choice = approvalPromptRef.current
						? await approvalPromptRef.current(request)
						: (await ui.confirm(`Allow ${request.toolName}? (${request.risk} risk)`, request.reason))
							? "once"
							: "deny";
					if (choice === "always") recordAlwaysAllow(request);
					return choice !== "deny";
				};
	if (readline && ui) {
		// Readline prompt shared by the REPL and one-shot TTY runs; the TUI
		// replaces it with a selector via setApprovalPrompt.
		approvalPromptRef.current = async (request) => {
			console.log(`${cyan(`Approval: ${request.toolName}`)} ${dim(`(${request.risk} risk)`)}`);
			if (request.reason) console.log(dim(request.reason));
			console.log(dim(firstLine(JSON.stringify(request.args), 200)));
			const answer = (await readline.question("Allow? [y]es once / [a]lways / [N]o ")).trim().toLowerCase();
			if (answer === "a" || answer === "always") return "always";
			return answer === "y" || answer === "yes" ? "once" : "deny";
		};
	}
	const buildAgent = (
		messages: typeof initialMessages,
		session: SessionRecorder | undefined,
		agentExtensions = extensions,
	): Agent =>
		new Agent({
			config,
			platform,
			systemPrompt: options.system ?? defaultSystemPrompt(cwd),
			tools: createCodingTools({ fs, shell }, { mode: permissionMode }),
			extensions: agentExtensions,
			ui,
			capabilities: {
				fs,
				shell,
				paths: {
					cwd,
					userTauDir: join(homedir(), ".tau"),
					projectTauDir: join(cwd, ".tau"),
					projectPiDir: join(cwd, ".pi"),
				},
			},
			initialMessages: messages,
			session,
			retry,
			pricing,
			permissionMode,
			onApproval,
		});
	let agent = buildAgent(initialMessages, recorder);
	await extensions.notifySessionStart(sessionReason, agent.extensionContext());

	if (options.print !== undefined) {
		if (!readline) throw new Error("print mode requires readline");
		await runTurn(agent, options.print, readline);
		await extensions.notifySessionShutdown("quit", agent.extensionContext());
		readline.close();
		return;
	}

	if (options.tui) {
		await runTui({
			agent,
			extensions,
			model,
			modelChoices,
			baseUrl,
			cwd,
			contextWindow,
			permissionMode,
			sessionRepo,
			shell,
			store,
			recorder,
			thinkingLevel: thinkingLevelFromExtraBody(config.extraBody),
			setModel: (nextModel) => {
				config.model = nextModel;
			},
			setThinkingLevel: (nextLevel) => {
				setThinkingLevelInConfig(config, nextLevel);
			},
			setApprovalPrompt: (prompt) => {
				approvalPromptRef.current = prompt;
			},
			buildAgent,
			reloadExtensions,
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
	extensions.attachHostActions({
		submitPrompt: (text) => {
			if (turnState.controller) return; // already running: extensions steer instead
			void runTurn(agent, text, readline);
		},
		resumeTurn: () => {
			if (turnState.controller) return;
			void runTurn(agent, null, readline);
		},
	});
	const extensionNote = extensions.tools.size + extensions.commands.size > 0 ? " · extensions loaded" : "";
	console.log(
		dim(`tau · ${model} @ ${baseUrl} · cwd ${cwd} · ${permissionMode}${extensionNote} · "exit" or Ctrl+D to quit`),
	);
	// In a TTY, readline intercepts Ctrl+C: abort the running turn if there is
	// one, otherwise quit the REPL.
	readline.on("SIGINT", () => {
		if (turnState.controller) {
			turnState.controller.abort();
		} else {
			readline.close();
		}
	});
	while (true) {
		let line: string;
		try {
			line = await readline.question("tau> ");
		} catch {
			break;
		}
		const input = line.trim();
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
				try {
					const result = await agent.compact(instructions === "" ? undefined : instructions);
					console.log(
						result ? dim(`Compacted: ~${result.tokensBefore} tokens summarized.`) : dim("Nothing to compact."),
					);
				} catch (error) {
					console.log(red(`Compaction failed: ${error instanceof Error ? error.message : String(error)}`));
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
				try {
					const result = await agent.navigateTo(arg);
					console.log(
						result.cancelled
							? dim("Navigation cancelled.")
							: dim(`Moved to ${arg} (${agent.messages.length} messages in context).`),
					);
				} catch (error) {
					console.log(red(`/tree failed: ${error instanceof Error ? error.message : String(error)}`));
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
					console.log(dim(`Forked to ${meta.filePath ?? meta.id} (${restored.messages.length} messages).`));
				} catch (error) {
					console.log(red(`/fork failed: ${error instanceof Error ? error.message : String(error)}`));
				}
				continue;
			}
			await runCommand(agent, extensions, input, readline);
			continue;
		}
		await runTurn(agent, input, readline);
	}
	await extensions.notifySessionShutdown("quit", agent.extensionContext());
	readline.close();
}

await main();
