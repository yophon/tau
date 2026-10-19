/**
 * Built-in slash commands (registry shape from yo-agent surface-cli
 * commands.ts; behavior from the P8 TUI). Extension commands merge in; a
 * built-in name wins.
 */

import { copyFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
	type AgentMessage,
	type ExtensionRegistry,
	estimateStringTokens,
	estimateTokens,
	messageText,
	type PermissionMode,
	type SessionEntry,
	type SessionMetadata,
	type ThinkingLevel,
	type Usage,
} from "@yophon/tau-kernel";
import type { TuiController } from "./controller.ts";
import { conversationLength } from "./controller.ts";
import { sessionHtml } from "./export-html.ts";
import { entryRendererMatches, isRenderComponent } from "./extensions.ts";
import { errorText, firstLine, fmtCost, fmtInt } from "./format.ts";
import type { CompletionItem } from "./input/completion.ts";
import type { PickerItem } from "./model.ts";
import { plainLine, type StyledLine, span } from "./render/spans.ts";

export interface BuiltinCommand {
	name: string;
	aliases?: string[];
	args?: string;
	description: string;
	run(tui: TuiController, args: string): Promise<void> | void;
	/** Completions for the text after "/name " (filtered by the command). */
	complete?(tui: TuiController, prefix: string): CompletionItem[] | Promise<CompletionItem[]>;
}

/** A command as the completion menu and the argument completer see it. */
export interface CommandEntry {
	name: string;
	description: string;
	complete?: (prefix: string) => CompletionItem[] | null | Promise<CompletionItem[] | null>;
}

const THINKING_LEVELS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
const FULL_SESSION = "__full_session__";

/** Every permission mode with one line on what it does (yo-agent /mode). */
export const PERMISSION_MODES: ReadonlyArray<{ mode: PermissionMode; hint: string }> = [
	{ mode: "read-only", hint: "tools that change files or run commands are denied" },
	{ mode: "supervised", hint: "medium- and high-risk tool calls ask first" },
	{ mode: "accept-edits", hint: "file edits in this directory run; commands still ask" },
	{ mode: "autonomous", hint: "tool calls run without asking" },
	{ mode: "bypass", hint: "every approval skipped, policy rules included" },
];

/** The /model choices: table models with their hints, or the configured ids. */
function modelItems(tui: TuiController): CompletionItem[] {
	const hints = tui.options.modelHints ?? {};
	return tui.modelChoices.map((model) => {
		const hint = [model === tui.model ? "current" : "", hints[model] ?? ""].filter((part) => part !== "").join(" · ");
		return { value: model, label: model, ...(hint !== "" ? { hint } : {}) };
	});
}

/** Values that start with the prefix (case-insensitive), as completion items. */
function startingWith(prefix: string, values: ReadonlyArray<string | CompletionItem>): CompletionItem[] {
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
		run: (tui) => tui.lines(helpLines(tui.extensions)),
	},
	{
		name: "compact",
		args: "[instructions]",
		description: "Summarize older conversation context",
		run: (tui, args) => tui.runCompact(args === "" ? undefined : args),
	},
	{
		name: "model",
		args: "[model]",
		description: "Show or switch the model",
		complete: (tui, prefix) => startingWith(prefix, modelItems(tui)),
		run: async (tui, args) => {
			if (args !== "") {
				await tui.switchModel(args);
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
				if (picked !== undefined && picked !== tui.model) await tui.switchModel(picked);
				return;
			}
			const picked = await tui.pickWithAlt(`Model (current: ${tui.model})`, items, selected, "save as default");
			if (!picked) return;
			if (picked.alt) {
				if (save(picked.value)) tui.notice("dim", `Default model for new sessions: ${picked.value}.`);
				else tui.notice("error", `Cannot save ${picked.value} as the default.`);
			}
			if (picked.value !== tui.model) await tui.switchModel(picked.value);
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
				await tui.switchThinking(undefined);
				return;
			}
			if (!(THINKING_LEVELS as readonly string[]).includes(requested)) {
				tui.notice("error", "Usage: /thinking [default|none|minimal|low|medium|high|xhigh|max]");
				return;
			}
			await tui.switchThinking(requested as ThinkingLevel);
		},
	},
	{
		name: "name",
		aliases: ["rename"],
		args: "<name>",
		description: "Name the current session",
		run: async (tui, args) => {
			if (!tui.recorder) {
				tui.notice("error", "No active session (--no-session).");
				return;
			}
			if (args === "") {
				tui.notice("error", "Usage: /name <name>");
				return;
			}
			await tui.recorder.setName(args);
			await tui.extensions.notifySessionInfoChanged(args, tui.agent.extensionContext());
			await tui.refreshSurfaces();
			tui.notice("dim", `Session named "${args}".`);
		},
	},
	{
		name: "resume",
		aliases: ["sessions"],
		args: "[session]",
		description: "Switch to a saved session",
		complete: async (tui, prefix) =>
			startingWith(
				prefix,
				(await tui.options.sessionRepo.list()).map((session) => ({
					value: session.name ?? session.id,
					label: session.name ?? session.id.slice(0, 8),
					hint: session.modified ?? session.timestamp,
				})),
			),
		run: async (tui, args) => {
			const sessions = await tui.options.sessionRepo.list();
			if (sessions.length === 0) {
				tui.notice("dim", "No sessions found.");
				return;
			}
			let selected: SessionMetadata | undefined;
			if (args === "") {
				const current = tui.sessionStore ? await tui.sessionStore.getMetadata() : undefined;
				const id = await tui.pick(
					"Resume a session",
					sessions.map((session) => ({
						label: `${session.id === current?.id ? "● " : "  "}${session.name ?? session.id.slice(0, 8)}`,
						hint: [session.modified ?? session.timestamp, session.name ? session.id.slice(0, 8) : ""]
							.filter((part) => part !== "")
							.join("  "),
						value: session.id,
					})),
				);
				if (id === undefined) {
					tui.notice("dim", "Session selection cancelled.");
					return;
				}
				selected = sessions.find((session) => session.id === id);
			} else {
				const found = findSession(sessions, args);
				if (found === "ambiguous") {
					tui.notice("error", `Multiple sessions match "${args}". Use a full id or path.`);
					return;
				}
				selected = found;
			}
			if (!selected) {
				tui.notice("error", `No session matches "${args}".`);
				return;
			}
			const result = await tui.switchSession(await tui.options.sessionRepo.open(selected), "resume");
			if (result.cancelled) tui.notice("dim", "Session switch cancelled by an extension.");
		},
	},
	{
		name: "tree",
		args: "[id]",
		description: "Jump to an earlier user message in this session",
		run: async (tui, args) => {
			const store = tui.sessionStore;
			if (!store) {
				tui.notice("error", "No active session (--no-session).");
				return;
			}
			if (args !== "") {
				await tui.navigate(args);
				return;
			}
			const entries = await store.getEntries();
			const onPath = new Set((await store.getPathToRoot(await store.getLeafId())).map((entry) => entry.id));
			const items: PickerItem[] = [];
			for (const entry of entries) {
				const fallback =
					entry.type === "message" && entry.message.role === "user"
						? {
								label: `${onPath.has(entry.id) ? "●" : "○"} ${firstLine(messageText(entry.message), 70)}`,
								hint: entry.id,
							}
						: undefined;
				const presentation = await presentEntry(tui, entry, fallback);
				if (presentation) items.push({ ...presentation, value: fallback ? entry.id : `${INFO}${entry.id}` });
			}
			if (items.length === 0) {
				tui.notice("dim", "No user messages in this session yet.");
				return;
			}
			const picked = await tui.pick("Jump to a user message", items);
			if (picked === undefined) {
				tui.notice("dim", "Navigation cancelled.");
				return;
			}
			if (picked.startsWith(INFO)) {
				tui.notice("dim", "That entry is not a jump target.");
				return;
			}
			await tui.navigate(picked);
		},
	},
	{
		name: "fork",
		args: "[id]",
		description: "Copy this session (or up to a message) and switch to the copy",
		run: async (tui, args) => {
			const store = tui.sessionStore;
			if (!store) {
				tui.notice("error", "No active session (--no-session).");
				return;
			}
			let target = args;
			if (target === "") {
				const items: PickerItem[] = [{ label: "● The whole session", value: FULL_SESSION }];
				for (const entry of await store.getEntries()) {
					const fallback =
						entry.type === "message" && entry.message.role === "user"
							? { label: `○ ${firstLine(messageText(entry.message), 70)}`, hint: entry.id }
							: undefined;
					const presentation = await presentEntry(tui, entry, fallback);
					if (presentation) items.push({ ...presentation, value: fallback ? entry.id : `${INFO}${entry.id}` });
				}
				const picked = await tui.pick("Fork from", items);
				if (picked === undefined) {
					tui.notice("dim", "Fork cancelled.");
					return;
				}
				if (picked.startsWith(INFO)) {
					tui.notice("dim", "That entry is not a fork target.");
					return;
				}
				target = picked === FULL_SESSION ? "" : picked;
			}
			if (target !== "") {
				const decision = await tui.extensions.runSessionBeforeFork(
					{ entryId: target, position: "before" },
					tui.agent.extensionContext(),
				);
				if (decision.cancel) {
					tui.notice("dim", "Fork cancelled.");
					return;
				}
			}
			const forked = await tui.options.sessionRepo.fork(
				await store.getMetadata(),
				target === "" ? undefined : { entryId: target },
			);
			const result = await tui.switchSession(forked, "fork");
			if (result.cancelled) tui.notice("dim", "Session switch cancelled by an extension (the fork file was kept).");
		},
	},
	{
		name: "new",
		description: "Start a new session",
		run: async (tui) => {
			if (!tui.sessionStore) {
				tui.notice("error", "No active session (--no-session).");
				return;
			}
			const result = await tui.switchSession(await tui.options.sessionRepo.create(), "new");
			if (result.cancelled) tui.notice("dim", "New session cancelled by an extension.");
		},
	},
	{
		name: "clone",
		description: "Copy this session at its current position and switch to the copy",
		run: async (tui) => {
			const store = tui.sessionStore;
			if (!store) {
				tui.notice("error", "No active session (--no-session).");
				return;
			}
			const leaf = await store.getLeafId();
			const copy = await tui.options.sessionRepo.fork(
				await store.getMetadata(),
				leaf === null || leaf === undefined ? undefined : { entryId: leaf, position: "at" },
			);
			const result = await tui.switchSession(copy, "fork");
			if (result.cancelled) tui.notice("dim", "Session switch cancelled by an extension (the copy was kept).");
		},
	},
	{
		name: "session",
		aliases: ["status"],
		description: "Show the session file, id, size and usage",
		run: async (tui) => {
			const usage = tui.agent.getSessionUsage();
			const context = tui.agent.getContextUsage();
			const row = (label: string, value: string): StyledLine => [
				span(`  ${label.padEnd(12)}`, { dim: true }),
				span(value),
			];
			const lines: StyledLine[] = [plainLine("Session", { bold: true })];
			if (tui.sessionStore) {
				const metadata = await tui.sessionStore.getMetadata();
				const entries = await tui.sessionStore.getEntries();
				lines.push(row("id", metadata.id));
				if (metadata.name) lines.push(row("name", metadata.name));
				if (metadata.filePath) lines.push(row("file", metadata.filePath));
				lines.push(row("entries", String(entries.length)));
			} else {
				lines.push(row("file", "none (--no-session)"));
			}
			lines.push(row("messages", `${conversationLength(tui.agent.messages)} in context`));
			lines.push(
				row("context", `~${context.tokens} tokens${context.contextWindow ? ` of ${context.contextWindow}` : ""}`),
			);
			lines.push(
				row(
					"usage",
					`${usage.input + usage.cacheRead + usage.cacheWrite} in · ${usage.output} out${usage.cost.total > 0 ? ` · $${usage.cost.total.toFixed(4)}` : ""}`,
				),
			);
			lines.push(row("cwd", tui.options.cwd));
			lines.push(row("model", `${tui.model} · ${tui.thinkingLevel ?? "default"} reasoning`));
			lines.push(row("mode", tui.agent.getPermissionMode()));
			tui.lines(lines);
		},
	},
	{
		name: "copy",
		description: "Copy the last answer to the clipboard",
		run: async (tui) => {
			const last = tui.agent.messages.findLast((message) => message.role === "assistant");
			const text = last ? messageText(last).trim() : "";
			if (text === "") {
				tui.notice("dim", "Nothing to copy yet.");
				return;
			}
			const how = await tui.copyText(text);
			tui.notice("dim", `Copied the last answer (${text.length} characters) via ${how}.`);
		},
	},
	{
		name: "export",
		args: "[path]",
		description: "Write the session as HTML (default) or JSONL",
		run: async (tui, args) => {
			const store = tui.sessionStore;
			const metadata = store ? await store.getMetadata() : undefined;
			const stem = `tau-session-${(metadata?.id ?? new Date().toISOString().replaceAll(":", "-")).slice(0, 8)}`;
			const target = resolve(tui.options.cwd, args === "" ? `${stem}.html` : args);
			if (target.toLowerCase().endsWith(".jsonl")) {
				if (!store || !metadata) {
					tui.notice("error", "No active session (--no-session): only HTML export is available.");
					return;
				}
				if (metadata.filePath) {
					await copyFile(metadata.filePath, target);
				} else {
					const entries = await store.getEntries();
					await writeFile(target, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf8");
				}
			} else {
				const html = sessionHtml(tui.agent.messages, {
					title: metadata?.name ?? `tau session ${metadata?.id.slice(0, 8) ?? ""}`.trim(),
					model: tui.model,
					cwd: tui.options.cwd,
					exportedAt: new Date().toISOString(),
				});
				await writeFile(target, html, "utf8");
			}
			tui.notice("dim", `Exported the session to ${target}.`);
		},
	},
	{
		name: "import",
		args: "<path.jsonl>",
		description: "Import a session file and switch to it",
		run: async (tui, args) => {
			if (!tui.sessionStore) {
				tui.notice("error", "No active session (--no-session).");
				return;
			}
			if (args === "") {
				tui.notice("error", "Usage: /import <path.jsonl>");
				return;
			}
			const source = resolve(tui.options.cwd, args);
			const answer = await tui.pick(`Replace the current session with ${source}?`, [
				{ label: "Import", value: "yes", key: "y" },
				{ label: "Cancel", value: "no", key: "n" },
			]);
			if (answer !== "yes") {
				tui.notice("dim", "Import cancelled.");
				return;
			}
			const imported = await tui.options.sessionRepo.importFile(source);
			const result = await tui.switchSession(imported, "resume");
			if (result.cancelled) tui.notice("dim", "Session switch cancelled by an extension (the imported file was kept).");
			else tui.notice("dim", `Imported ${source}.`);
		},
	},
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
				void tui.runPrompt(args);
				return;
			}
			tui.sendQueued("followUp", args);
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
			const current = tui.agent.getPermissionMode();
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
			const current = tui.agent.getPermissionMode();
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
		run: (tui) => tui.lines(usageLines(tui.agent.messages, tui.agent.getSessionUsage())),
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
			void tui.runPrompt(INIT_PROMPT);
		},
	},
	{
		name: "settings",
		description: "Change the model, reasoning, permission mode and display",
		run: async (tui) => {
			const items: PickerItem[] = [
				{ label: "Model", hint: tui.model, value: "model" },
				{ label: "Reasoning effort", hint: tui.thinkingLevel ?? "default", value: "thinking" },
				{ label: "Permission mode", hint: tui.agent.getPermissionMode(), value: "mode" },
				{ label: "Show reasoning", hint: tui.state.showReasoning ? "on" : "off", value: "reasoning" },
				{ label: "Tool details", hint: tui.state.verbose ? "expanded" : "collapsed", value: "details" },
				{ label: "Tools", hint: `${tui.agent.getActiveTools().length} on`, value: "tools" },
			];
			if (tui.options.saveTuiMode) {
				items.push({ label: "Screen", hint: screenName(tui.options.screen ?? "fullscreen"), value: "screen" });
			}
			const picked = await tui.pick("Settings", items);
			if (picked === undefined) return;
			if (picked === "reasoning") tui.execute({ type: "toggle-reasoning" });
			else if (picked === "details") tui.execute({ type: "toggle-verbose" });
			else if (picked === "screen") await pickScreen(tui);
			else await findBuiltin(picked)?.run(tui, "");
		},
	},
	{
		name: "hotkeys",
		description: "Show keyboard shortcuts",
		run: (tui) => tui.lines(hotkeyLines(tui.extensions)),
	},
	{
		name: "diagnostics",
		description: "Show loaded extensions, resources and their diagnostics",
		run: async (tui) => tui.lines(await diagnosticsLines(tui)),
	},
	{
		name: "reload",
		description: "Reload extensions, prompts and context files",
		run: (tui) => tui.reloadExtensions(),
	},
	{
		name: "clear",
		description: "Start a clean screen (the session is unchanged)",
		run: (tui) => {
			tui.clearScreen();
			tui.store.dispatch({ type: "clear" });
		},
	},
	{
		name: "quit",
		aliases: ["exit"],
		description: "Exit tau",
		run: (tui) => tui.stop(),
	},
];

const screenName = (mode: "fullscreen" | "inline"): string => (mode === "inline" ? "inline" : "full screen");

/** /settings → Screen (P33): saved as tui.mode; the screen changes on the next start. */
async function pickScreen(tui: TuiController): Promise<void> {
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

const INFO = "__entry_info__:";

export function builtinCommands(): readonly BuiltinCommand[] {
	return BUILTINS;
}

function findBuiltin(name: string): BuiltinCommand | undefined {
	return BUILTINS.find((command) => command.name === name || command.aliases?.includes(name));
}

/** Every command for completion: built-ins first, then extension commands that do not clash. */
export function commandList(extensions: ExtensionRegistry, tui?: TuiController): CommandEntry[] {
	const list: CommandEntry[] = BUILTINS.map((command) => {
		const complete = command.complete;
		return {
			name: `/${command.name}`,
			description: command.description,
			...(complete && tui ? { complete: (prefix: string) => complete(tui, prefix) } : {}),
		};
	});
	for (const [invocation, command] of extensions.commands) {
		if (findBuiltin(invocation)) continue;
		const complete = command.getArgumentCompletions;
		list.push({
			name: `/${invocation}`,
			description: command.description ?? "",
			...(complete
				? {
						complete: async (prefix: string) =>
							(await complete(prefix))?.map((item) => ({
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
async function toggleTools(tui: TuiController): Promise<void> {
	let selected = 0;
	for (;;) {
		const active = new Set(tui.agent.getActiveTools());
		const tools = tui.agent.getAllTools().filter((tool) => tool.exposure !== "hidden");
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
		tui.agent.setActiveTools(next);
		const on = new Set(tui.agent.getActiveTools()).has(picked);
		tui.notice("dim", `${picked} ${on ? "on" : "off"}.`);
	}
}

function usageTotal(usage: Usage): number {
	return usage.input + usage.cacheRead + usage.cacheWrite;
}

/** /usage: one row per user turn on the current branch, then the session total (every branch, D19). */
export function usageLines(messages: readonly AgentMessage[], session: Usage): StyledLine[] {
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
function contextLines(tui: TuiController): StyledLine[] {
	const context = tui.agent.getContextUsage();
	const window = context.contextWindow;
	const groups = new Map<string, number>();
	const add = (label: string, tokens: number): void => {
		groups.set(label, (groups.get(label) ?? 0) + tokens);
	};
	for (const message of tui.agent.messages) {
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
	const active = new Set(tui.agent.getActiveTools());
	const declared = tui.agent.getAllTools().filter((tool) => active.has(tool.name) && tool.exposure === "direct");
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

export function parseCommandLine(text: string): { name: string; args: string } | undefined {
	const match = text.match(/^\/([\w:-]+)(?:\s+([\s\S]*))?$/);
	if (!match) return undefined;
	return { name: match[1] ?? "", args: (match[2] ?? "").trim() };
}

/** Run a `/command`; false when no command has that name. */
export async function runCommand(tui: TuiController, text: string): Promise<boolean> {
	const parsed = parseCommandLine(text);
	if (!parsed) return false;
	const builtin = findBuiltin(parsed.name);
	if (builtin) {
		await builtin.run(tui, parsed.args);
		return true;
	}
	const command = tui.extensions.commands.get(parsed.name);
	if (!command) return false;
	try {
		await tui.agent.flush();
		const start = tui.agent.messages.length;
		const output = await command.handler(parsed.args, tui.agent.extensionContext());
		await tui.renderNewMessages(start);
		await tui.refreshSurfaces();
		if (typeof output === "string") tui.notice("info", output);
		else if (output?.action === "prompt") await tui.runPrompt(output.text);
	} catch (error) {
		tui.notice("error", `/${parsed.name} failed: ${errorText(error)}`);
	}
	return true;
}

/** A session entry as a picker item, through extension entry renderers first. */
async function presentEntry(
	tui: TuiController,
	entry: SessionEntry,
	fallback: { label: string; hint?: string } | undefined,
): Promise<{ label: string; hint?: string } | undefined> {
	for (const renderer of tui.extensions.entryRenderers.values()) {
		if (!entryRendererMatches(renderer, entry)) continue;
		try {
			const result = await renderer.handler(entry, tui.agent.extensionContext());
			if (result === undefined) continue;
			if (typeof result === "string") return { label: result, ...(fallback?.hint ? { hint: fallback.hint } : {}) };
			if (isRenderComponent(result)) {
				const [label, ...rest] = result.render(80);
				if (!label) return fallback;
				return { label, ...(rest.length > 0 ? { hint: rest.join(" ") } : {}) };
			}
			return { label: result.label, ...(result.description !== undefined ? { hint: result.description } : {}) };
		} catch (error) {
			tui.notice("error", `Entry renderer ${renderer.name} failed: ${errorText(error)}`);
			return fallback;
		}
	}
	return fallback;
}

function findSession(sessions: SessionMetadata[], selector: string): SessionMetadata | "ambiguous" | undefined {
	const matches = (session: SessionMetadata, prefix: boolean): boolean => {
		const fileName = session.filePath?.split(/[\\/]/).at(-1);
		return [session.id, session.timestamp, session.name, session.filePath, fileName]
			.filter((value): value is string => value !== undefined && value !== "")
			.some((value) => (prefix ? value.startsWith(selector) : value === selector));
	};
	for (const prefix of [false, true]) {
		const found = sessions.filter((session) => matches(session, prefix));
		if (found.length === 1) return found[0];
		if (found.length > 1) return "ambiguous";
	}
	return undefined;
}

const KEYS: Array<[string, string]> = [
	["Enter", "send; while working, steer the current turn"],
	["Alt+Enter", "queue a follow-up while working; a newline when idle"],
	["Ctrl+J", "newline"],
	["Esc", "interrupt; clear the input when idle"],
	["Ctrl+C", "interrupt; press twice to exit when idle"],
	["↑ / ↓", "history; ↑ on an empty input takes queued messages back"],
	["Ctrl+O", "expand or collapse tool details"],
	["Ctrl+T", "show or hide reasoning"],
	["Shift+Tab", "permission mode: supervised → accept-edits → autonomous → read-only (/mode for bypass)"],
	["Ctrl+G", "edit the input in $VISUAL / $EDITOR"],
	["Tab", "complete / commands and @ files"],
	["!cmd / !!cmd", "run a shell command (!! keeps it out of the context)"],
	["#fact", "save a fact to long-term project memory"],
	["Ctrl+A/E/U/K/W", "line editing"],
];

function helpLines(extensions: ExtensionRegistry): StyledLine[] {
	const row = (name: string, what: string): StyledLine => [
		span(`  ${name.padEnd(26)}`, { color: "cyan" }),
		span(what, { dim: true }),
	];
	const lines: StyledLine[] = [plainLine("Commands", { bold: true })];
	for (const command of BUILTINS)
		lines.push(row(`/${command.name}${command.args ? ` ${command.args}` : ""}`, command.description));
	const extensionCommands = [...extensions.commands].filter(([invocation]) => !findBuiltin(invocation));
	if (extensionCommands.length > 0) {
		lines.push(plainLine("Extension commands", { bold: true }));
		for (const [invocation, command] of extensionCommands) lines.push(row(`/${invocation}`, command.description ?? ""));
	}
	lines.push(...hotkeyLines(extensions));
	return lines;
}

/** /hotkeys (pi): the built-in keys, then extension shortcuts. */
function hotkeyLines(extensions: ExtensionRegistry): StyledLine[] {
	const row = (name: string, what: string): StyledLine => [
		span(`  ${name.padEnd(26)}`, { color: "cyan" }),
		span(what, { dim: true }),
	];
	const lines: StyledLine[] = [plainLine("Keys", { bold: true })];
	for (const [key, what] of KEYS) lines.push(row(key, what));
	const shortcuts = [...extensions.shortcuts.values()];
	if (shortcuts.length > 0) {
		lines.push(plainLine("Extension shortcuts", { bold: true }));
		for (const shortcut of shortcuts) lines.push(row(shortcut.key, shortcut.description ?? shortcut.name));
	}
	return lines;
}

async function diagnosticsLines(tui: TuiController): Promise<StyledLine[]> {
	const extensions = tui.extensions;
	const count = (n: number, what: string): string => `${n} ${what}${n === 1 ? "" : "s"}`;
	const lines: StyledLine[] = [
		plainLine("Session", { bold: true }),
		[
			span(`  session_start: ${tui.lastSessionStart} · ${conversationLength(tui.agent.messages)} messages in context`, {
				dim: true,
			}),
		],
		plainLine("Extensions", { bold: true }),
		[
			span(
				`  ${[
					count(extensions.tools.size, "tool"),
					count(extensions.commands.size, "command"),
					count(extensions.shortcuts.size, "shortcut"),
					count(extensions.messageRenderers.size, "message renderer"),
					count(extensions.entryRenderers.size, "entry renderer"),
					count(extensions.toolRenderers.size, "tool renderer"),
					count(extensions.widgets.size, "widget"),
					count(extensions.headerItems.size + extensions.footerItems.size, "status item"),
				].join(" · ")}`,
				{ dim: true },
			),
		],
	];
	if (tui.shortcutConflicts.length > 0) {
		lines.push([span(`  Shortcuts ignored (built-in key): ${tui.shortcutConflicts.join(", ")}`, { color: "yellow" })]);
	}
	try {
		const discovered = await tui.agent
			.extensionContext()
			.discoverResources?.(tui.lastSessionStart === "reload" ? "reload" : "startup");
		lines.push(plainLine("Resources", { bold: true }));
		lines.push([
			span(
				discovered
					? `  ${count(discovered.skillPaths.length, "skill path")} · ${count(discovered.promptPaths.length, "prompt path")}`
					: "  unavailable",
				{ dim: true },
			),
		]);
	} catch (error) {
		lines.push([span(`  Resource discovery failed: ${errorText(error)}`, { color: "red" })]);
	}
	if (extensions.diagnostics.size > 0) {
		lines.push(plainLine("Extension diagnostics", { bold: true }));
		for (const diagnostic of extensions.diagnostics.values()) {
			try {
				const result = await diagnostic.handler(tui.agent.extensionContext());
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
			} catch (error) {
				lines.push([span(`  ${diagnostic.name}  `, { color: "red" }), span(errorText(error))]);
			}
		}
	}
	return lines;
}
