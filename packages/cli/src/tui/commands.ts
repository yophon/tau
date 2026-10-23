/**
 * Built-in slash commands (registry shape from yo-agent surface-cli
 * commands.ts; behavior from the P8 TUI). Extension commands merge in; a
 * built-in name wins.
 */

import { copyFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
	type AgentMessage,
	commandPromptContent,
	type ExtensionRegistry,
	estimateStringTokens,
	estimateTokens,
	messageText,
	type PermissionMode,
	type SessionEntry,
	type SessionMetadata,
	SessionRecorder,
	type ThinkingLevel,
	type Usage,
} from "@yophon/tau-kernel";
import { type GitDiff, gitDiff } from "../git-diff.ts";
import { relativeTime, sessionLabel } from "../session-title.ts";
import type { TuiController } from "./controller.ts";
import { sessionHtml } from "./export-html.ts";
import { entryRendererMatches, isRenderComponent } from "./extensions.ts";
import { conversationLength, errorText, firstLine, fmtCost, fmtInt } from "./format.ts";
import type { CompletionItem } from "./input/completion.ts";
import { truncateCells } from "./input/width.ts";
import { getKeybindings } from "./keybindings.ts";
import type { PickerItem } from "./model.ts";
import { gitDiffLines, summarizeDiff } from "./render/git-diff.ts";
import { plainLine, type StyledLine, span } from "./render/spans.ts";
import { buildTree } from "./session-tree.ts";

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
					label: truncateCells(sessionLabel(session), 50),
					hint: relativeTime(session.modified ?? session.timestamp),
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
				selected = await chooseSession(tui, sessions);
				if (!selected) return;
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
			if (!(await tui.guardDirty("switch session"))) return;
			const result = await tui.sessions.switchSession(await tui.options.sessionRepo.open(selected), "resume");
			if (result.cancelled) tui.notice("dim", "Session switch cancelled by an extension.");
		},
	},
	{
		name: "tree",
		args: "[id]",
		description: "Browse the session tree and go back to any point; your messages return to the input box (pi)",
		run: async (tui, args) => {
			const store = tui.sessionStore;
			if (!store) {
				tui.notice("error", "No active session (--no-session).");
				return;
			}
			if (args !== "") {
				await tui.runs.navigate(args);
				return;
			}
			// P39f: pi's tree selector, every entry with its branches, opened at the current leaf.
			const entries = await store.getEntries();
			const leafId = await store.getLeafId();
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
			if (!(await tui.guardDirty("fork"))) return;
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
			const result = await tui.sessions.switchSession(forked, "fork");
			if (result.cancelled) tui.notice("dim", "Session switch cancelled by an extension (the fork file was kept).");
		},
	},
	{
		name: "new",
		// Claude Code's /clear (aliases /reset, /new): a new conversation with empty context (P38c).
		aliases: ["clear", "reset"],
		description: "Start a new session with empty context (/clear)",
		run: async (tui) => {
			if (!tui.sessionStore) {
				tui.notice("error", "No active session (--no-session).");
				return;
			}
			if (!(await tui.guardDirty("new session"))) return;
			const result = await tui.sessions.switchSession(await tui.options.sessionRepo.create(), "new");
			if (result.cancelled) tui.notice("dim", "New session cancelled by an extension.");
		},
	},
	{
		name: "handoff",
		args: "<goal>",
		description: "Start a new session with a prompt that carries what matters from this one",
		run: (tui, args) => tui.runHandoff(args.trim()),
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
			if (!(await tui.guardDirty("fork"))) return;
			const leaf = await store.getLeafId();
			const copy = await tui.options.sessionRepo.fork(
				await store.getMetadata(),
				leaf === null || leaf === undefined ? undefined : { entryId: leaf, position: "at" },
			);
			const result = await tui.sessions.switchSession(copy, "fork");
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
				if (metadata.parentSession) lines.push(row("parent", metadata.parentSession));
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
			const answers = tui.agent.messages
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
			if (!(await tui.guardDirty("switch session"))) return;
			const imported = await tui.options.sessionRepo.importFile(source);
			const result = await tui.sessions.switchSession(imported, "resume");
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
				{ label: "Permission mode", hint: tui.agent.getPermissionMode(), value: "mode" },
				{ label: "Show reasoning", hint: tui.state.showReasoning ? "on" : "off", value: "reasoning" },
				{ label: "Tool details", hint: tui.state.verbose ? "expanded" : "collapsed", value: "details" },
				{ label: "Tools", hint: `${tui.agent.getActiveTools().length} on`, value: "tools" },
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
async function pickDoubleEscape(tui: TuiController): Promise<void> {
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
async function pickDirtyGuard(tui: TuiController): Promise<void> {
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
		// P41a (pi enableSkillCommands): hidden commands still run when typed, but are not offered.
		if (findBuiltin(invocation) || command.hidden) continue;
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
export function whenCommandRuns(tui: TuiController, text: string): "now" | "later" | "unknown" {
	const parsed = parseCommandLine(text);
	if (!parsed) return "unknown";
	const builtin = findBuiltin(parsed.name);
	if (builtin) {
		// /follow joins a running turn; during another task (a compaction) it waits like a prompt.
		if (builtin.name === "follow" && tui.state.task !== undefined && tui.state.task !== "turn") return "later";
		return RUNS_DURING_A_TURN.has(builtin.name) ? "now" : "later";
	}
	// Extension commands run at once, even mid-turn (pi: "execute immediately, even during streaming").
	return tui.extensions.commands.has(parsed.name) ? "now" : "unknown";
}

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
		await tui.runs.renderNewMessages(start);
		await tui.refreshSurfaces();
		if (typeof output === "string") tui.notice("info", output);
		else if (output?.action === "prompt") {
			// P44: UserPromptExpansion hooks may stop the prompt the command expands to.
			const expansion = await tui.extensions.runCommandPrompt(
				{ command: parsed.name, args: parsed.args, source: command.source ?? "extension", text: output.text },
				tui.agent.extensionContext(),
			);
			if (expansion.cancel)
				tui.notice("warn", `/${parsed.name} blocked${expansion.reason ? `: ${expansion.reason}` : "."}`);
			else await tui.runs.promptWhenFree(commandPromptContent(output));
		}
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

/** "5 min ago · 42 messages" (P34f). */
function sessionHint(session: SessionMetadata): string {
	const when = relativeTime(session.modified ?? session.timestamp);
	const count = session.messageCount ?? 0;
	return `${when} · ${count} message${count === 1 ? "" : "s"}`;
}

/**
 * The /resume picker (P38c, pi's session selector): type to search titles and first
 * messages, the current session marked, same titles told apart by their id, Ctrl+R to
 * rename and Ctrl+D to delete. Undefined when nothing is chosen (or only the current one).
 */
async function chooseSession(tui: TuiController, initial: SessionMetadata[]): Promise<SessionMetadata | undefined> {
	let sessions = initial;
	const current = tui.sessionStore ? await tui.sessionStore.getMetadata() : undefined;
	for (;;) {
		const labels = sessions.map((session) => truncateCells(sessionLabel(session), 50));
		const items = sessions.map((session, index) => {
			const label = labels[index] as string;
			const twin = labels.filter((other) => other === label).length > 1;
			return {
				label: `${session.id === current?.id ? "● " : "  "}${label}`,
				hint: `${session.id === current?.id ? "current · " : ""}${sessionHint(session)}${twin ? ` · ${session.id.slice(0, 8)}` : ""}`,
				value: session.id,
			};
		});
		const start = Math.max(
			0,
			sessions.findIndex((session) => session.id !== current?.id),
		);
		const picked = await tui.pickWithActions(
			"Resume a session",
			items,
			[
				{ key: "ctrl+r", label: "rename" },
				{ key: "ctrl+d", label: "delete" },
			],
			start,
		);
		if (!picked) {
			tui.flash("Session selection cancelled.");
			return undefined;
		}
		const session = sessions.find((candidate) => candidate.id === picked.value);
		if (!session) return undefined;
		if (picked.action === "ctrl+r") {
			const name = (await tui.ask("input", `New name for "${sessionLabel(session)}"`))?.trim();
			if (name) {
				if (session.id === current?.id && tui.recorder) await tui.recorder.setName(name);
				else await (await SessionRecorder.open(await tui.options.sessionRepo.open(session))).setName(name);
				tui.flash(`Renamed to "${name}"`);
			}
		} else if (picked.action === "ctrl+d") {
			if (session.id === current?.id) {
				tui.flash("The current session cannot be deleted.");
			} else if (await tui.ui.confirm(`Delete "${sessionLabel(session)}"?`, "This removes the session file.")) {
				await tui.options.sessionRepo.delete(session);
				tui.flash("Session deleted.");
			}
		} else {
			if (session.id === current?.id) {
				tui.flash("Already in this session.");
				return undefined;
			}
			return session;
		}
		sessions = await tui.options.sessionRepo.list();
		if (sessions.length === 0) {
			tui.notice("dim", "No sessions found.");
			return undefined;
		}
	}
}

/** A session by id, time, name, file or title: exact, then prefix, then (P34f) a piece of its title. */
function findSession(sessions: SessionMetadata[], selector: string): SessionMetadata | "ambiguous" | undefined {
	const values = (session: SessionMetadata): string[] => {
		const fileName = session.filePath?.split(/[\\/]/).at(-1);
		return [session.id, session.timestamp, session.name, sessionLabel(session), session.filePath, fileName].filter(
			(value): value is string => value !== undefined && value !== "",
		);
	};
	const needle = selector.toLowerCase();
	const tiers: Array<(value: string) => boolean> = [
		(value) => value === selector,
		(value) => value.startsWith(selector),
		(value) => value.toLowerCase().includes(needle),
	];
	for (const test of tiers) {
		const found = sessions.filter((session) => values(session).some(test));
		if (found.length === 1) return found[0];
		if (found.length > 1) return "ambiguous";
	}
	return undefined;
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

function helpLines(extensions: ExtensionRegistry): StyledLine[] {
	const row = (name: string, what: string): StyledLine => [
		span(`  ${name.padEnd(26)}`, { color: "cyan" }),
		span(what, { dim: true }),
	];
	const lines: StyledLine[] = [plainLine("Commands", { bold: true })];
	for (const command of BUILTINS)
		lines.push(row(`/${command.name}${command.args ? ` ${command.args}` : ""}`, command.description));
	const extensionCommands = [...extensions.commands].filter(
		([invocation, command]) => !findBuiltin(invocation) && !command.hidden,
	);
	if (extensionCommands.length > 0) {
		lines.push(plainLine("Extension commands", { bold: true }));
		for (const [invocation, command] of extensionCommands) lines.push(row(`/${invocation}`, command.description ?? ""));
	}
	lines.push(...hotkeyLines(extensions));
	return lines;
}

/** /hotkeys (pi): the built-in keys, then extension shortcuts. */
/** The shortcuts as picker rows (P38c: ? on an empty input, Claude Code), extension shortcuts after. */
export function shortcutItems(extensions: ExtensionRegistry): PickerItem[] {
	const rows: Array<[string, string]> = [
		...keyRows(),
		...[...extensions.shortcuts.values()].map((shortcut): [string, string] => [
			shortcut.key,
			shortcut.description ?? shortcut.name,
		]),
	];
	return rows.map(([key, what], index) => ({ label: key, hint: what, value: String(index) }));
}

function hotkeyLines(extensions: ExtensionRegistry): StyledLine[] {
	const row = (name: string, what: string): StyledLine => [
		span(`  ${name.padEnd(26)}`, { color: "cyan" }),
		span(what, { dim: true }),
	];
	const lines: StyledLine[] = [plainLine("Keys", { bold: true })];
	for (const [key, what] of keyRows()) lines.push(row(key, what));
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
