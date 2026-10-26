/**
 * Built-in slash commands (registry shape from yo-agent surface-cli
 * commands.ts; behavior from the P8 TUI). Extension commands merge in; a
 * built-in name wins.
 */

import {
	type AgentMessage,
	estimateStringTokens,
	estimateTokens,
	messageText,
	type PermissionMode,
	type ThinkingLevel,
	type Usage,
} from "@yophon/tau-kernel";
import { type GitDiff, gitDiff } from "../git-diff.ts";
import { mainCheckoutOf } from "../git-paths.ts";
import type { TuiController } from "./controller.ts";
import { conversationLength, errorText, firstLine, fmtCost, fmtInt } from "./format.ts";
import type { CompletionItem } from "./input/completion.ts";
import { getKeybindings } from "./keybindings.ts";
import type { PickerItem } from "./model.ts";
import { gitDiffLines, summarizeDiff } from "./render/git-diff.ts";
import { plainLine, type StyledLine, span } from "./render/spans.ts";
import { runRewind } from "./rewind.ts";
import type { TuiRuns } from "./runs.ts";
import { contextOf, type TuiSession, usageOf } from "./session-client.ts";
import { sessionCommands } from "./session-commands.ts";
import { buildTree } from "./session-tree.ts";
import type { TuiSessions } from "./sessions.ts";

/** What a command's argument completer reads (the input box offers completions through it). */
export type CompletionHost = Pick<TuiController, "model" | "modelChoices" | "options" | "session">;

/** What the built-in commands use: controller members, and the runs and session switches they start (P51). */
export type CommandHost = Pick<
	TuiController,
	| "ask"
	| "askAside"
	| "copyText"
	| "editKeybindings"
	| "execute"
	| "flash"
	| "guardDirty"
	| "lastSessionStart"
	| "lines"
	| "model"
	| "modelChoices"
	| "notice"
	| "openAside"
	| "openSearch"
	| "options"
	| "pick"
	| "pickTree"
	| "pickWithActions"
	| "pickWithAlt"
	| "refreshSurfaces"
	| "runHandoff"
	| "session"
	| "setMode"
	| "settings"
	| "shortcutConflicts"
	| "state"
	| "stop"
	| "thinkingLevel"
	| "ui"
> & {
	readonly runs: Pick<
		TuiRuns,
		"navigate" | "promptWhenFree" | "runCompact" | "runJob" | "runPrompt" | "sendQueued" | "showOutcome" | "waitForTurn"
	>;
	readonly sessions: Pick<TuiSessions, "reloadExtensions" | "switchModel" | "switchSession" | "switchThinking">;
};

export interface BuiltinCommand {
	name: string;
	aliases?: string[];
	args?: string;
	description: string;
	run(tui: CommandHost, args: string): Promise<void> | void;
	/** Completions for the text after "/name " (filtered by the command). */
	complete?(tui: CompletionHost, prefix: string): CompletionItem[] | Promise<CompletionItem[]>;
}

/** A command as the completion menu and the argument completer see it. */
export interface CommandEntry {
	name: string;
	description: string;
	complete?: (prefix: string) => CompletionItem[] | null | Promise<CompletionItem[] | null>;
}

const THINKING_LEVELS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

/** Every permission mode with one line on what it does (yo-agent /mode). */
export const PERMISSION_MODES: ReadonlyArray<{ mode: PermissionMode; hint: string }> = [
	{ mode: "read-only", hint: "tools that change files or run commands are denied" },
	{ mode: "supervised", hint: "medium- and high-risk tool calls ask first" },
	{ mode: "accept-edits", hint: "file edits in this directory run; commands still ask" },
	{ mode: "autonomous", hint: "tool calls run without asking" },
	{ mode: "bypass", hint: "every approval skipped, policy rules included" },
	// P53c: last, so the picker keeps its order; Shift+Tab never reaches it.
	{ mode: "ci", hint: "nothing asks: reads and edits in this directory run, the rest is denied (unattended)" },
];

/** The /model choices: table models with their hints, or the configured ids. */
function modelItems(tui: CompletionHost): CompletionItem[] {
	const hints = tui.options.modelHints ?? {};
	return tui.modelChoices.map((model) => {
		const hint = [model === tui.model ? "current" : "", hints[model] ?? ""].filter((part) => part !== "").join(" · ");
		return { value: model, label: model, ...(hint !== "" ? { hint } : {}) };
	});
}

/** Values that start with the prefix (case-insensitive), as completion items. */
export function startingWith(prefix: string, values: ReadonlyArray<string | CompletionItem>): CompletionItem[] {
	const lower = prefix.toLowerCase();
	return values
		.map((value) => (typeof value === "string" ? { value, label: value } : value))
		.filter((item) => item.value.toLowerCase().startsWith(lower));
}

const INIT_PROMPT = `Please analyze this codebase and create an AGENTS.md file at the project root. It is read at the start of every future session by coding agents working in this repository.

Include:
1. The commands for building, linting and testing, including how to run a single test.
2. The high-level architecture and code structure that takes reading several files to understand.
3. Conventions a newcomer would get wrong (naming, error handling, formatting, commit rules).

Usage notes:
- If AGENTS.md (or CLAUDE.md, .cursorrules, .github/copilot-instructions.md, README.md) already exists, read it first; improve an existing AGENTS.md instead of replacing it, and carry over the important parts of the others.
- Keep it concise: no generic advice, no obvious instructions, no listing of every file.
- Do not invent sections or facts that you cannot back with what you read in the repository.`;

const BUILTINS: BuiltinCommand[] = [
	{
		name: "help",
		description: "Show commands and keys",
		run: (tui) => tui.lines(helpLines(tui.session)),
	},
	{
		name: "compact",
		args: "[instructions]",
		description: "Summarize older conversation context",
		run: (tui, args) => tui.runs.runCompact(args === "" ? undefined : args),
	},
	{
		name: "model",
		args: "[model]",
		description: "Show or switch the model",
		complete: (tui, prefix) => startingWith(prefix, modelItems(tui)),
		run: async (tui, args) => {
			if (args !== "") {
				await tui.sessions.switchModel(args);
				return;
			}
			const items = modelItems(tui).map((item) => ({
				label: item.label,
				value: item.value,
				...(item.hint !== undefined ? { hint: item.hint } : {}),
			}));
			const selected = Math.max(
				0,
				items.findIndex((item) => item.value === tui.model),
			);
			const save = tui.options.saveDefaultModel;
			if (!save) {
				const picked = await tui.pick(`Model (current: ${tui.model})`, items, selected);
				if (picked !== undefined && picked !== tui.model) await tui.sessions.switchModel(picked);
				return;
			}
			const picked = await tui.pickWithAlt(`Model (current: ${tui.model})`, items, selected, "save as default");
			if (!picked) return;
			if (picked.alt) {
				if (save(picked.value)) tui.notice("dim", `Default model for new sessions: ${picked.value}.`);
				else tui.notice("error", `Cannot save ${picked.value} as the default.`);
			}
			if (picked.value !== tui.model) await tui.sessions.switchModel(picked.value);
		},
	},
	{
		name: "thinking",
		args: "[level]",
		description: "Show or set the reasoning effort",
		complete: (_tui, prefix) => startingWith(prefix, ["default", ...THINKING_LEVELS]),
		run: async (tui, args) => {
			let requested = args.trim().toLowerCase();
			if (requested === "") {
				const picked = await tui.pick(`Reasoning effort (current: ${tui.thinkingLevel ?? "default"})`, [
					{ label: "default", value: "default", ...(tui.thinkingLevel === undefined ? { hint: "current" } : {}) },
					...THINKING_LEVELS.map((level) => ({
						label: level,
						value: level,
						...(tui.thinkingLevel === level ? { hint: "current" } : {}),
					})),
				]);
				if (picked === undefined) return;
				requested = picked;
			}
			if (requested === "default" || requested === "auto" || requested === "off") {
				await tui.sessions.switchThinking(undefined);
				return;
			}
			if (!(THINKING_LEVELS as readonly string[]).includes(requested)) {
				tui.notice("error", "Usage: /thinking [default|none|minimal|low|medium|high|xhigh|max]");
				return;
			}
			await tui.sessions.switchThinking(requested as ThinkingLevel);
		},
	},
	sessionCommands.name,
	sessionCommands.resume,
	{
		name: "rewind",
		description: "Go back to before one of your messages: restore the code, the conversation, or both (Claude Code)",
		run: (tui) => runRewind(tui),
	},
	{
		name: "tree",
		args: "[id]",
		description: "Browse the session tree and go back to any point; your messages return to the input box (pi)",
		run: async (tui, args) => {
			if (!tui.session.state.sessionFile) {
				tui.notice("error", "No active session (--no-session).");
				return;
			}
			if (args !== "") {
				await tui.runs.navigate(args);
				return;
			}
			// P39f: pi's tree selector, every entry with its branches, opened at the current leaf.
			const { entries, leafId } = await tui.session.entries();
			if (!entries.some((entry) => entry.type === "message" && entry.message.role === "user")) {
				tui.notice("dim", "No messages in this session yet.");
				return;
			}
			const picked = await tui.pickTree(buildTree(entries), leafId);
			if (picked === undefined) {
				tui.flash("Navigation cancelled.");
				return;
			}
			if (picked === leafId) {
				tui.flash("Already at this point.");
				return;
			}
			// pi: whether to summarize the branch being left, no summary first; settings'
			// branchSummary.skipPrompt (P40c) takes no summary without asking.
			if (tui.settings.branchSummary?.skipPrompt === true) {
				await tui.runs.navigate(picked, { summarize: false });
				return;
			}
			const choice = await tui.pick("Summarize branch?", [
				{ label: "No summary", value: "none" },
				{ label: "Summarize", value: "summarize" },
				{ label: "Summarize with custom prompt", value: "custom" },
			]);
			if (choice === undefined) {
				tui.flash("Navigation cancelled.");
				return;
			}
			let customInstructions: string | undefined;
			if (choice === "custom") {
				customInstructions = await tui.ask("input", "Custom summarization instructions");
				if (customInstructions === undefined) {
					tui.flash("Navigation cancelled.");
					return;
				}
			}
			await tui.runs.navigate(picked, {
				summarize: choice !== "none",
				...(customInstructions !== undefined ? { customInstructions } : {}),
			});
		},
	},
	sessionCommands.fork,
	sessionCommands.new,
	{
		name: "handoff",
		args: "<goal>",
		description: "Start a new session with a prompt that carries what matters from this one",
		run: (tui, args) => tui.runHandoff(args.trim()),
	},
	sessionCommands.clone,
	{
		name: "cwd",
		description: "Show the working directory",
		run: (tui) => {
			const main = mainCheckoutOf(tui.options.cwd);
			tui.notice(
				"dim",
				main && main !== tui.options.cwd ? `${tui.options.cwd}\nmain checkout: ${main}` : tui.options.cwd,
			);
		},
	},
	sessionCommands.session,
	{
		name: "keybindings",
		description: "Change keys: open ~/.tau/keybindings.json (created with every action) in your editor",
		run: async (tui) => {
			await tui.editKeybindings();
		},
	},
	{
		name: "btw",
		args: "<question>",
		description: "Ask a side question about the conversation, even while it works; no tools, not added to it",
		run: async (tui, args) => {
			// Claude Code's /btw; without a question it reopens the last answer.
			const question = args.trim();
			if (question === "") {
				if (tui.state.asides.length > 0) tui.openAside();
				else tui.notice("dim", "Usage: /btw <question> — answered from the conversation, without tools.");
				return;
			}
			await tui.askAside(question);
		},
	},
	{
		name: "diff",
		description: "Show the uncommitted changes, untracked files included (git diff)",
		run: async (tui) => {
			// Codex's /diff: the transcript shows it; the model never sees it.
			let diff: GitDiff;
			try {
				diff = await gitDiff(tui.options.cwd);
			} catch (error) {
				tui.notice("error", `/diff failed: ${errorText(error)}`);
				return;
			}
			if (!diff.repo) {
				tui.notice("dim", "Not a git repository.");
				return;
			}
			if (diff.text.trim() === "") {
				tui.notice("dim", "No changes.");
				return;
			}
			const { files, added, removed } = summarizeDiff(diff.text);
			tui.lines([
				[
					span("git diff", { bold: true }),
					span(` · ${files} file${files === 1 ? "" : "s"} · `, { dim: true }),
					span(`+${added}`, { color: "green" }),
					span(" "),
					span(`-${removed}`, { color: "red" }),
					...(diff.untracked > 0 ? [span(` · ${diff.untracked} untracked`, { dim: true })] : []),
				],
				...gitDiffLines(diff.text),
			]);
		},
	},
	{
		name: "copy",
		args: "[N]",
		description: "Copy an answer (the last, or the Nth from the end); with code blocks, pick one",
		run: async (tui, args) => {
			// Claude Code's /copy [N]: answers with text, newest first.
			const answers = tui.session.messages
				.filter((message) => message.role === "assistant")
				.map((message) => messageText(message).trim())
				.filter((text) => text !== "")
				.reverse();
			const n = args.trim() === "" ? 1 : Number(args.trim());
			if (!Number.isInteger(n) || n < 1) {
				tui.notice("error", "Usage: /copy [N] (1 = the last answer)");
				return;
			}
			const text = answers[n - 1];
			if (text === undefined) {
				tui.notice("dim", answers.length === 0 ? "Nothing to copy yet." : `There are only ${answers.length} answers.`);
				return;
			}
			let chosen = text;
			const blocks = codeBlocks(text);
			if (blocks.length > 0) {
				const picked = await tui.pick("Copy", [
					{ label: "The whole answer", hint: `${text.length} characters`, value: "all" },
					...blocks.map((block, index) => ({
						label: block.language ? `Code block ${index + 1} (${block.language})` : `Code block ${index + 1}`,
						hint: block.code.split("\n")[0]?.slice(0, 60) ?? "",
						value: String(index),
					})),
				]);
				if (picked === undefined) return;
				chosen = picked === "all" ? text : (blocks[Number(picked)]?.code ?? text);
			}
			const how = await tui.copyText(chosen);
			tui.flash(`Copied ${chosen.length} characters via ${how}`);
		},
	},
	sessionCommands.export,
	sessionCommands.import,
	{
		name: "trust",
		description: "Save whether this project's extensions, skills and settings are trusted",
		run: async (tui) => {
			if (!tui.options.saveTrust) {
				tui.notice("error", "Trust decisions cannot be saved here.");
				return;
			}
			const answer = await tui.pick("Trust this project's resources from now on?", [
				{ label: "Trust", value: "yes", key: "y" },
				{ label: "Do not trust", value: "no", key: "n" },
			]);
			if (answer === undefined) return;
			const present = await tui.options.saveTrust(answer === "yes");
			tui.notice(
				"dim",
				`${answer === "yes" ? "Trusted" : "Not trusted"}${present.length > 0 ? `: ${present.join(", ")}` : ""}. /reload applies it now.`,
			);
		},
	},
	{
		name: "follow",
		args: "<text>",
		description: "Queue a follow-up after the current turn (Alt+Enter)",
		run: (tui, args) => {
			if (args === "") {
				tui.notice("error", "Usage: /follow <text>");
				return;
			}
			if (tui.state.task !== "turn") {
				tui.notice("dim", "No turn is running; sending it now.");
				void tui.runs.runPrompt(args);
				return;
			}
			tui.runs.sendQueued("followUp", args);
		},
	},
	{
		name: "reasoning",
		description: "Show or hide reasoning (Ctrl+T)",
		run: (tui) => tui.execute({ type: "toggle-reasoning" }),
	},
	{
		name: "tools",
		args: "[expand|collapse]",
		description: "Turn tools on or off; expand|collapse shows tool details (Ctrl+O)",
		complete: (_tui, prefix) => startingWith(prefix, ["expand", "collapse"]),
		run: async (tui, args) => {
			if (args === "expand" || args === "collapse") {
				const verbose = tui.state.verbose;
				if (args === "expand" ? !verbose : verbose) tui.execute({ type: "toggle-verbose" });
				else tui.notice("dim", `Tool details are already ${verbose ? "expanded" : "collapsed"}.`);
				return;
			}
			if (args !== "") {
				tui.notice("error", "Usage: /tools [expand|collapse]");
				return;
			}
			await toggleTools(tui);
		},
	},
	{
		name: "mode",
		args: "[mode]",
		description: "Show or switch the permission mode (Shift+Tab cycles)",
		complete: (tui, prefix) => {
			const current = tui.session.state.permissionMode;
			return startingWith(
				prefix,
				PERMISSION_MODES.map(({ mode, hint }) => ({
					value: mode,
					label: mode,
					hint: mode === current ? `current · ${hint}` : hint,
				})),
			);
		},
		run: async (tui, args) => {
			const current = tui.session.state.permissionMode;
			let requested = args.trim().toLowerCase();
			if (requested === "") {
				const picked = await tui.pick(
					`Permission mode (current: ${current})`,
					PERMISSION_MODES.map(({ mode, hint }) => ({
						label: mode,
						value: mode,
						hint: mode === current ? `current · ${hint}` : hint,
					})),
					Math.max(
						0,
						PERMISSION_MODES.findIndex(({ mode }) => mode === current),
					),
				);
				if (picked === undefined) return;
				requested = picked;
			}
			const target = PERMISSION_MODES.find(({ mode }) => mode === requested)?.mode;
			if (!target) {
				tui.notice("error", `Usage: /mode [${PERMISSION_MODES.map(({ mode }) => mode).join("|")}]`);
				return;
			}
			if (target === current) {
				tui.notice("dim", `Already in ${current} mode.`);
				return;
			}
			if (target === "bypass") {
				const answer = await tui.pick("Bypass skips every approval, high-risk commands included. Switch?", [
					{ label: "Cancel", value: "no", key: "n" },
					{ label: "Switch to bypass", value: "yes", key: "y" },
				]);
				if (answer !== "yes") {
					tui.notice("dim", "Mode unchanged.");
					return;
				}
			}
			tui.setMode(target);
		},
	},
	{
		name: "usage",
		aliases: ["cost"],
		description: "Show token usage and cost per turn",
		run: (tui) => tui.lines(usageLines(tui.session.messages, usageOf(tui.session.state))),
	},
	{
		name: "context",
		description: "Show what fills the context window",
		run: (tui) => tui.lines(contextLines(tui)),
	},
	{
		name: "init",
		description: "Have the model write AGENTS.md for this project",
		run: (tui) => {
			if (tui.state.task !== undefined) {
				tui.notice("dim", "A task is running; run /init when it ends.");
				return;
			}
			void tui.runs.runPrompt(INIT_PROMPT);
		},
	},
	{
		name: "settings",
		description: "Change the model, reasoning, permission mode and display",
		run: async (tui) => {
			const items: PickerItem[] = [
				{ label: "Model", hint: tui.model, value: "model" },
				{ label: "Reasoning effort", hint: tui.thinkingLevel ?? "default", value: "thinking" },
				{ label: "Permission mode", hint: tui.session.state.permissionMode, value: "mode" },
				{ label: "Show reasoning", hint: tui.state.showReasoning ? "on" : "off", value: "reasoning" },
				{ label: "Tool details", hint: tui.state.verbose ? "expanded" : "collapsed", value: "details" },
				{ label: "Tools", hint: `${tui.session.state.tools.active.length} on`, value: "tools" },
			];
			if (tui.options.saveTuiMode) {
				items.push({ label: "Screen", hint: screenName(tui.options.screen ?? "fullscreen"), value: "screen" });
			}
			if (tui.options.saveSetting) {
				items.push(
					{ label: "Double Esc", hint: tui.options.doubleEscapeAction ?? "tree", value: "double-esc" },
					{
						label: "Uncommitted-changes check",
						hint: tui.options.dirtyRepoGuard ? "on" : "off",
						value: "dirty-guard",
					},
				);
			}
			const picked = await tui.pick("Settings", items);
			if (picked === undefined) return;
			if (picked === "reasoning") {
				tui.execute({ type: "toggle-reasoning" });
				tui.options.saveSetting?.("tui", "showReasoning", tui.state.showReasoning);
			} else if (picked === "details") tui.execute({ type: "toggle-verbose" });
			else if (picked === "screen") await pickScreen(tui);
			else if (picked === "double-esc") await pickDoubleEscape(tui);
			else if (picked === "dirty-guard") await pickDirtyGuard(tui);
			else await findBuiltin(picked)?.run(tui, "");
		},
	},
	{
		name: "search",
		args: "[text]",
		description: "Search the conversation (full screen; same as Ctrl+F)",
		run: (tui, args) => tui.openSearch(args),
	},
	{
		name: "hotkeys",
		description: "Show keyboard shortcuts",
		run: (tui) => tui.lines(hotkeyLines(tui.session)),
	},
	{
		name: "diagnostics",
		description: "Show loaded extensions, resources and their diagnostics",
		run: async (tui) => tui.lines(await diagnosticsLines(tui)),
	},
	{
		name: "reload",
		description: "Reload extensions, prompts and context files",
		run: (tui) => tui.sessions.reloadExtensions(),
	},
	{
		name: "quit",
		aliases: ["exit"],
		description: "Exit tau",
		run: (tui) => tui.stop(),
	},
];

const screenName = (mode: "fullscreen" | "inline"): string => (mode === "inline" ? "inline" : "full screen");

/** The fenced code blocks of markdown text, without their fences. */
export function codeBlocks(markdown: string): Array<{ language: string; code: string }> {
	const blocks: Array<{ language: string; code: string }> = [];
	let open: { language: string; lines: string[] } | undefined;
	for (const line of markdown.split("\n")) {
		const fence = /^\s*(```|~~~)\s*(\S*)\s*$/.exec(line);
		if (fence) {
			if (open) {
				blocks.push({ language: open.language, code: open.lines.join("\n") });
				open = undefined;
			} else {
				open = { language: fence[2] ?? "", lines: [] };
			}
			continue;
		}
		open?.lines.push(line);
	}
	return blocks;
}

/** /settings → Double Esc (P37b, pi doubleEscapeAction): saved as tui.doubleEscapeAction. */
async function pickDoubleEscape(tui: CommandHost): Promise<void> {
	const picked = await tui.pick(
		"Esc twice on an empty input",
		[
			{ label: "Session tree (/tree)", value: "tree" },
			{ label: "Fork from a message (/fork)", value: "fork" },
			{ label: "Nothing", value: "none" },
		],
		["tree", "fork", "none"].indexOf(tui.options.doubleEscapeAction ?? "tree"),
	);
	if (picked !== "tree" && picked !== "fork" && picked !== "none") return;
	tui.options.doubleEscapeAction = picked;
	tui.options.saveSetting?.("tui", "doubleEscapeAction", picked);
	tui.notice("info", `Esc twice now opens: ${picked}.`);
}

/** /settings → Uncommitted-changes check (P37b, pi dirty-repo-guard): saved as session.dirtyRepoGuard. */
async function pickDirtyGuard(tui: CommandHost): Promise<void> {
	const picked = await tui.pick(
		"Ask before switching sessions with uncommitted changes",
		[
			{ label: "On", value: "on" },
			{ label: "Off", value: "off" },
		],
		tui.options.dirtyRepoGuard ? 0 : 1,
	);
	if (picked !== "on" && picked !== "off") return;
	tui.options.dirtyRepoGuard = picked === "on";
	tui.options.saveSetting?.("session", "dirtyRepoGuard", picked === "on");
	tui.notice("info", `Uncommitted-changes check: ${picked}.`);
}

/** /settings → Screen (P33): saved as tui.mode; the screen changes on the next start. */
async function pickScreen(tui: CommandHost): Promise<void> {
	const current = tui.options.screen ?? "fullscreen";
	const modes = ["fullscreen", "inline"] as const;
	const picked = await tui.pick(
		`Screen (now: ${screenName(current)}; takes effect on the next start)`,
		[
			{ label: "Full screen", hint: "own scrollable view, no resize ghosts", value: "fullscreen" },
			{ label: "Inline", hint: "history in the terminal's scrollback", value: "inline" },
		],
		modes.indexOf(current),
	);
	if (picked !== "fullscreen" && picked !== "inline") return;
	tui.options.saveTuiMode?.(picked);
	tui.notice("dim", `Saved tui.mode = ${picked} in settings.json; tau uses it from the next start.`);
}

function findBuiltin(name: string): BuiltinCommand | undefined {
	return BUILTINS.find((command) => command.name === name || command.aliases?.includes(name));
}

/** Every command for completion: built-ins first, then the session's extension commands that do not clash. */
export function commandList(session: TuiSession, tui?: CompletionHost): CommandEntry[] {
	const list: CommandEntry[] = BUILTINS.map((command) => {
		const complete = command.complete;
		return {
			name: `/${command.name}`,
			description: command.description,
			...(complete && tui ? { complete: (prefix: string) => complete(tui, prefix) } : {}),
		};
	});
	for (const [invocation, command] of session.commands) {
		// P41a (pi enableSkillCommands): hidden commands still run when typed, but are not offered.
		if (findBuiltin(invocation) || command.hidden) continue;
		list.push({
			name: `/${invocation}`,
			description: command.description,
			...(command.completes
				? {
						complete: async (prefix: string) =>
							(await session.request("command/complete", { name: invocation, prefix })).items?.map((item) => ({
								value: item.value,
								label: item.label,
								...(item.description !== undefined ? { hint: item.description } : {}),
							})) ?? null,
					}
				: {}),
		});
	}
	return list;
}

/** /tools: a picker of every tool; picking one turns it on or off, Esc closes. */
async function toggleTools(tui: CommandHost): Promise<void> {
	let selected = 0;
	for (;;) {
		const active = new Set(tui.session.state.tools.active);
		const tools = tui.session.state.tools.all.filter((tool) => tool.exposure !== "hidden");
		if (tools.length === 0) {
			tui.notice("dim", "No tools are registered.");
			return;
		}
		const picked = await tui.pick(
			`Tools (${active.size} on) — Enter turns one on or off, Esc closes`,
			tools.map((tool) => ({
				label: `${active.has(tool.name) ? "●" : "○"} ${tool.name}`,
				hint: [tool.exposure === "direct" ? "" : tool.exposure, firstLine(tool.description, 60)]
					.filter((part) => part !== "")
					.join(" · "),
				value: tool.name,
			})),
			selected,
		);
		if (picked === undefined) return;
		selected = Math.max(
			0,
			tools.findIndex((tool) => tool.name === picked),
		);
		const next = active.has(picked) ? [...active].filter((name) => name !== picked) : [...active, picked];
		await tui.session.request("thread/setActiveTools", { names: next });
		await tui.session.drain();
		const on = new Set(tui.session.state.tools.active).has(picked);
		tui.notice("dim", `${picked} ${on ? "on" : "off"}.`);
	}
}

function usageTotal(usage: Usage): number {
	return usage.input + usage.cacheRead + usage.cacheWrite;
}

/** /usage: one row per user turn on the current branch, then the session total (every branch, D19). */
function usageLines(messages: readonly AgentMessage[], session: Usage): StyledLine[] {
	interface Turn {
		label: string;
		input: number;
		output: number;
		cacheRead: number;
		cost: number;
		calls: number;
	}
	const turns: Turn[] = [];
	for (const message of messages) {
		if (message.role === "user") {
			turns.push({ label: firstLine(messageText(message), 40), input: 0, output: 0, cacheRead: 0, cost: 0, calls: 0 });
			continue;
		}
		const usage =
			message.role === "assistant" ? message.usage : message.role === "toolResult" ? message.usage : undefined;
		if (!usage) continue;
		if (turns.length === 0)
			turns.push({ label: "(before the first prompt)", input: 0, output: 0, cacheRead: 0, cost: 0, calls: 0 });
		const turn = turns[turns.length - 1] as Turn;
		turn.input += usageTotal(usage);
		turn.output += usage.output;
		turn.cacheRead += usage.cacheRead;
		turn.cost += usage.cost.total;
		if (message.role === "assistant") turn.calls++;
	}
	const lines: StyledLine[] = [plainLine("Usage", { bold: true })];
	const used = turns.filter((turn) => turn.calls > 0 || turn.input > 0);
	if (used.length === 0) lines.push([span("  No model calls on this branch yet.", { dim: true })]);
	const cell = (text: string, width: number): string => text.padStart(width);
	lines.push([
		span(
			`  ${"#".padEnd(4)}${cell("in", 10)}${cell("cached", 10)}${cell("out", 9)}${cell("calls", 7)}${cell("cost", 10)}  prompt`,
			{ dim: true },
		),
	]);
	turns.forEach((turn, i) => {
		if (turn.calls === 0 && turn.input === 0) return;
		lines.push([
			span(
				`  ${String(i + 1).padEnd(4)}${cell(fmtInt(turn.input), 10)}${cell(fmtInt(turn.cacheRead), 10)}${cell(fmtInt(turn.output), 9)}${cell(String(turn.calls), 7)}${cell(fmtCost(turn.cost) ?? "-", 10)}  `,
			),
			span(turn.label, { dim: true }),
		]);
	});
	lines.push([
		span(
			`  ${"all".padEnd(4)}${cell(fmtInt(usageTotal(session)), 10)}${cell(fmtInt(session.cacheRead), 10)}${cell(fmtInt(session.output), 9)}${cell("", 7)}${cell(fmtCost(session.cost.total) ?? "-", 10)}  `,
			{ bold: true },
		),
		span("session total, every branch", { dim: true }),
	]);
	return lines;
}

/** /context: the window and an estimate of what fills it. */
function contextLines(tui: CommandHost): StyledLine[] {
	const context = contextOf(tui.session.state);
	const window = context.contextWindow;
	const groups = new Map<string, number>();
	const add = (label: string, tokens: number): void => {
		groups.set(label, (groups.get(label) ?? 0) + tokens);
	};
	for (const message of tui.session.messages) {
		if (message.role === "system") {
			add(
				"system prompt",
				estimateStringTokens(typeof message.content === "string" ? message.content : messageText(message)) +
					Object.values(message.sections ?? {}).reduce(
						(sum, section) => sum + (section ? estimateStringTokens(section) : 0),
						0,
					),
			);
			continue;
		}
		const label =
			message.role === "toolResult"
				? "tool results"
				: message.role === "assistant"
					? "assistant"
					: message.role === "user"
						? "user"
						: message.role === "custom"
							? "extension messages"
							: "summaries";
		add(label, estimateTokens(message));
	}
	const active = new Set(tui.session.state.tools.active);
	const declared = tui.session.state.tools.all.filter((tool) => active.has(tool.name) && tool.exposure === "direct");
	add(
		`tool definitions (${declared.length})`,
		estimateStringTokens(
			JSON.stringify(
				declared.map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters })),
			),
		),
	);
	const lines: StyledLine[] = [plainLine("Context", { bold: true })];
	lines.push([
		span(
			`  ~${fmtInt(context.tokens)} tokens${window ? ` of ${fmtInt(window)} (${Math.round((context.tokens / window) * 100)}% used)` : ""}`,
		),
	]);
	if (window) {
		const width = 40;
		const filled = Math.min(width, Math.round((context.tokens / window) * width));
		lines.push([span(`  ${"█".repeat(filled)}`, { color: "cyan" }), span("░".repeat(width - filled), { dim: true })]);
	}
	lines.push([span("  Estimated by part (heuristic):", { dim: true })]);
	for (const [label, tokens] of groups) {
		if (tokens === 0) continue;
		lines.push([span(`    ${label.padEnd(26)}`, { dim: true }), span(`~${fmtInt(tokens)}`)]);
	}
	lines.push([span("  /compact summarizes older messages to free space.", { dim: true })]);
	return lines;
}

function parseCommandLine(text: string): { name: string; args: string } | undefined {
	const match = text.match(/^\/([\w:-]+)(?:\s+([\s\S]*))?$/);
	if (!match) return undefined;
	return { name: match[1] ?? "", args: (match[2] ?? "").trim() };
}

/** Run a `/command`; false when no command has that name. */
/**
 * Commands that only show something run while a turn works; the rest wait for it to end
 * (P38c, Claude Code: "queues it and runs it after the current turn", info commands at once).
 */
const RUNS_DURING_A_TURN = new Set([
	"help",
	"btw",
	"diff",
	"hotkeys",
	"session",
	"copy",
	"usage",
	"context",
	"search",
	"diagnostics",
	"mode",
	"reasoning",
	"follow",
	"quit",
]);

/** When a slash command may run while a task works: now, after it, or not a command at all. */
export function whenCommandRuns(
	tui: Pick<TuiController, "session" | "state">,
	text: string,
): "now" | "later" | "unknown" {
	const parsed = parseCommandLine(text);
	if (!parsed) return "unknown";
	const builtin = findBuiltin(parsed.name);
	if (builtin) {
		// /follow joins a running turn; during another task (a compaction) it waits like a prompt.
		if (builtin.name === "follow" && tui.state.task !== undefined && tui.state.task !== "turn") return "later";
		return RUNS_DURING_A_TURN.has(builtin.name) ? "now" : "later";
	}
	// Extension commands run at once, even mid-turn (pi: "execute immediately, even during streaming").
	return tui.session.commands.has(parsed.name) ? "now" : "unknown";
}

export async function runCommand(tui: CommandHost, text: string): Promise<boolean> {
	const parsed = parseCommandLine(text);
	if (!parsed) return false;
	const builtin = findBuiltin(parsed.name);
	if (builtin) {
		await builtin.run(tui, parsed.args);
		return true;
	}
	// Not known here: the list may have grown since it was read (an MCP server's prompts).
	if (!tui.session.commands.has(parsed.name)) await tui.session.refreshCommands(true).catch(() => false);
	if (!tui.session.commands.has(parsed.name)) return false;
	try {
		// The command runs in the hub; what it adds to the conversation arrives first, then its outcome.
		const outcome = await tui.session.request("command/run", { name: parsed.name, args: parsed.args });
		if (outcome.unknown) return false;
		await tui.runs.showOutcome(parsed.name, outcome);
		// A prompt it asked for is a turn the hub started (or queued): wait for it, as a typed prompt waits.
		if (outcome.turn) await tui.runs.waitForTurn(outcome.turn.turnId);
	} catch (error) {
		tui.notice("error", `/${parsed.name} failed: ${errorText(error)}`);
	}
	return true;
}

/**
 * The keyboard shortcuts for /hotkeys and the ? panel, with the keys the key table
 * gives each action (P39e: changed in ~/.tau/keybindings.json, they show changed).
 */
function keyRows(): Array<[string, string]> {
	const kb = getKeybindings();
	const keys = (...actions: string[]): string =>
		actions
			.map((action) => kb.label(action, ""))
			.filter((label) => label !== "")
			.join(", ") || "unbound";
	return [
		[keys("tui.input.submit"), "send; while working, steer the current turn"],
		[
			keys("tui.input.tab"),
			"while working: queue a follow-up for after the turn; idle: complete / commands, @ files and paths",
		],
		[keys("tui.input.newLine"), `newline (${keys("app.message.followUp")} too, where the terminal passes it)`],
		[keys("app.interrupt"), "interrupt; clear the input when idle (↑ brings it back)"],
		["Esc Esc", "on an empty input: session tree (/settings → Double Esc)"],
		[keys("app.clear"), "interrupt; clear the input; on an empty input press twice to exit"],
		[keys("app.exit"), "on an empty input: exit"],
		[
			keys("tui.editor.cursorUp", "tui.editor.cursorDown"),
			"move in the input, then history; ↑ on an empty input takes queued messages back",
		],
		[
			keys("app.task.background"),
			"while a command runs: move it to the background (/tasks); otherwise cursor left (tmux: press twice)",
		],
		[keys("app.history.search"), "search the prompt history"],
		["?", "on an empty input: these shortcuts"],
		[keys("app.redraw"), "draw the screen again"],
		[keys("app.tools.expand"), "expand or collapse tool details"],
		[keys("app.thinking.toggle"), "show or hide reasoning"],
		[
			keys("app.permissionMode.cycle"),
			"permission mode: supervised → accept-edits → autonomous → read-only (/mode for bypass)",
		],
		[keys("app.editor.external"), "edit the input in $VISUAL / $EDITOR (also while working)"],
		[keys("app.clipboard.pasteImage"), "paste an image or copied files from the clipboard"],
		["!cmd / !!cmd", "run a shell command (!! keeps it out of the context)"],
		["#fact", "save a fact to long-term project memory"],
		[keys("tui.editor.cursorLineStart", "tui.editor.cursorLineEnd"), "start / end of the line"],
		[keys("tui.editor.cursorWordLeft", "tui.editor.cursorWordRight"), "move by word"],
		[
			keys("tui.editor.deleteWordBackward"),
			`delete the word before; ${keys("tui.editor.deleteWordForward")} the word after`,
		],
		[keys("tui.editor.deleteToLineStart", "tui.editor.deleteToLineEnd"), "delete to the start / end of the line"],
		[
			keys("tui.editor.yank", "tui.editor.yankPop"),
			"paste back deleted text; the second right after cycles older deletions",
		],
		[keys("tui.editor.undo"), "undo"],
		...(kb.keys("app.suspend").length > 0
			? ([[keys("app.suspend"), "suspend (fg brings tau back)"]] as Array<[string, string]>)
			: []),
		[keys("tui.altScreen.search"), "full screen: search the conversation (Enter/↓ next, ↑ previous, Esc close)"],
		[
			keys("tui.altScreen.previousPrompt", "tui.altScreen.nextPrompt"),
			"full screen: jump to the previous / next message you sent",
		],
		[
			`${keys("tui.altScreen.pageUp", "tui.altScreen.pageDown")}, wheel`,
			`full screen: scroll; ${keys("tui.altScreen.top", "tui.altScreen.bottom")} to the start / end`,
		],
		["Drag, double/triple click", "full screen: select text, a word, a line; copied on release"],
		["Click", "full screen: a tool's title row opens or shuts it; menu, picker and approval items choose"],
		["/keybindings", "change any of these keys (~/.tau/keybindings.json)"],
	];
}

function helpLines(session: TuiSession): StyledLine[] {
	const row = (name: string, what: string): StyledLine => [
		span(`  ${name.padEnd(26)}`, { color: "cyan" }),
		span(what, { dim: true }),
	];
	const lines: StyledLine[] = [plainLine("Commands", { bold: true })];
	for (const command of BUILTINS)
		lines.push(row(`/${command.name}${command.args ? ` ${command.args}` : ""}`, command.description));
	const extensionCommands = [...session.commands].filter(
		([invocation, command]) => !findBuiltin(invocation) && !command.hidden,
	);
	if (extensionCommands.length > 0) {
		lines.push(plainLine("Extension commands", { bold: true }));
		for (const [invocation, command] of extensionCommands) lines.push(row(`/${invocation}`, command.description));
	}
	lines.push(...hotkeyLines(session));
	return lines;
}

/** /hotkeys (pi): the built-in keys, then extension shortcuts. */
/** The shortcuts as picker rows (P38c: ? on an empty input, Claude Code), extension shortcuts after. */
export function shortcutItems(session: TuiSession): PickerItem[] {
	const rows: Array<[string, string]> = [
		...keyRows(),
		...[...session.shortcuts.values()].map((shortcut): [string, string] => [shortcut.key, shortcut.description]),
	];
	return rows.map(([key, what], index) => ({ label: key, hint: what, value: String(index) }));
}

function hotkeyLines(session: TuiSession): StyledLine[] {
	const row = (name: string, what: string): StyledLine => [
		span(`  ${name.padEnd(26)}`, { color: "cyan" }),
		span(what, { dim: true }),
	];
	const lines: StyledLine[] = [plainLine("Keys", { bold: true })];
	for (const [key, what] of keyRows()) lines.push(row(key, what));
	const shortcuts = [...session.shortcuts.values()];
	if (shortcuts.length > 0) {
		lines.push(plainLine("Extension shortcuts", { bold: true }));
		for (const shortcut of shortcuts) lines.push(row(shortcut.key, shortcut.description));
	}
	return lines;
}

async function diagnosticsLines(tui: CommandHost): Promise<StyledLine[]> {
	const count = (n: number, what: string): string => `${n} ${what}${n === 1 ? "" : "s"}`;
	let report: Awaited<ReturnType<TuiSession["request"]>> | undefined;
	try {
		report = await tui.session.request("diagnostics/read", {});
	} catch {
		report = undefined;
	}
	const diagnostics = report as
		| {
				lastSessionStart: string;
				counts: TuiSession["state"]["extensions"];
				resources?: { skillPaths: number; promptPaths: number };
				resourcesError?: string;
				items: Array<{ name: string; result?: unknown; error?: string }>;
		  }
		| undefined;
	const counts = diagnostics?.counts ?? tui.session.state.extensions;
	const lines: StyledLine[] = [
		plainLine("Session", { bold: true }),
		[
			span(
				`  session_start: ${diagnostics?.lastSessionStart ?? tui.lastSessionStart} · ${conversationLength(tui.session.messages)} messages in context`,
				{ dim: true },
			),
		],
		plainLine("Extensions", { bold: true }),
		[
			span(
				`  ${[
					count(counts.tools, "tool"),
					count(counts.commands, "command"),
					count(counts.shortcuts, "shortcut"),
					count(counts.messageRenderers, "message renderer"),
					count(counts.entryRenderers, "entry renderer"),
					count(counts.toolRenderers, "tool renderer"),
					count(counts.widgets, "widget"),
					count(counts.statusItems, "status item"),
				].join(" · ")}`,
				{ dim: true },
			),
		],
	];
	if (tui.shortcutConflicts.length > 0) {
		lines.push([span(`  Shortcuts ignored (built-in key): ${tui.shortcutConflicts.join(", ")}`, { color: "yellow" })]);
	}
	if (diagnostics?.resourcesError !== undefined) {
		lines.push([span(`  Resource discovery failed: ${diagnostics.resourcesError}`, { color: "red" })]);
	} else {
		lines.push(plainLine("Resources", { bold: true }));
		lines.push([
			span(
				diagnostics?.resources
					? `  ${count(diagnostics.resources.skillPaths, "skill path")} · ${count(diagnostics.resources.promptPaths, "prompt path")}`
					: "  unavailable",
				{ dim: true },
			),
		]);
	}
	if (diagnostics && diagnostics.items.length > 0) {
		lines.push(plainLine("Extension diagnostics", { bold: true }));
		for (const diagnostic of diagnostics.items) {
			if (diagnostic.error !== undefined) {
				lines.push([span(`  ${diagnostic.name}  `, { color: "red" }), span(diagnostic.error)]);
				continue;
			}
			const result = diagnostic.result as
				| string
				| string[]
				| { label: string; value?: string | number | boolean; details?: string | string[] }
				| undefined;
			for (const item of Array.isArray(result) ? result : [result]) {
				if (!item) continue;
				const value =
					typeof item === "string" ? item : item.value === undefined ? item.label : `${item.label}: ${item.value}`;
				lines.push([span(`  ${diagnostic.name}  `, { color: "cyan" }), span(value)]);
				const details = typeof item === "object" && item.details !== undefined ? item.details : [];
				for (const detail of Array.isArray(details) ? details : [details]) {
					lines.push([span(`      ${detail}`, { dim: true })]);
				}
			}
		}
	}
	return lines;
}
