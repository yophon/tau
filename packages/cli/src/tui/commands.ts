/**
 * Built-in slash commands (registry shape from yo-agent surface-cli
 * commands.ts; behavior from the P8 TUI). Extension commands merge in; a
 * built-in name wins.
 */

import { copyFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
	type ExtensionRegistry,
	messageText,
	type SessionEntry,
	type SessionMetadata,
	type ThinkingLevel,
} from "@yophon/tau-kernel";
import type { TuiController } from "./controller.ts";
import { conversationLength } from "./controller.ts";
import { entryRendererMatches, isRenderComponent } from "./extensions.ts";
import { errorText, firstLine } from "./format.ts";
import type { PickerItem } from "./model.ts";
import { plainLine, type StyledLine, span } from "./render/spans.ts";

export interface BuiltinCommand {
	name: string;
	aliases?: string[];
	args?: string;
	description: string;
	run(tui: TuiController, args: string): Promise<void> | void;
}

const THINKING_LEVELS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
const FULL_SESSION = "__full_session__";

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
		run: async (tui, args) => {
			if (args !== "") {
				await tui.switchModel(args);
				return;
			}
			const picked = await tui.pick(
				`Model (current: ${tui.model})`,
				tui.modelChoices.map((model) => ({
					label: model,
					value: model,
					...(model === tui.model ? { hint: "current" } : {}),
				})),
			);
			if (picked !== undefined && picked !== tui.model) await tui.switchModel(picked);
		},
	},
	{
		name: "thinking",
		args: "[default|none|minimal|low|medium|high|xhigh|max]",
		description: "Show or set the reasoning effort",
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
		args: "[id|path|timestamp|name]",
		description: "Switch to a saved session",
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
		description: "Write the session as JSONL",
		run: async (tui, args) => {
			const store = tui.sessionStore;
			if (!store) {
				tui.notice("error", "No active session (--no-session).");
				return;
			}
			const metadata = await store.getMetadata();
			const target = resolve(tui.options.cwd, args === "" ? `tau-session-${metadata.id.slice(0, 8)}.jsonl` : args);
			if (metadata.filePath) {
				await copyFile(metadata.filePath, target);
			} else {
				const entries = await store.getEntries();
				await writeFile(target, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n", "utf8");
			}
			tui.notice("dim", `Exported the session to ${target}.`);
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
		description: "Expand or collapse tool details for new output (Ctrl+O)",
		run: (tui, args) => {
			const verbose = tui.state.verbose;
			if (args === "expand" ? !verbose : args === "collapse" ? verbose : true) tui.execute({ type: "toggle-verbose" });
			else tui.notice("dim", `Tool details are already ${verbose ? "expanded" : "collapsed"}.`);
		},
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

const INFO = "__entry_info__:";

export function builtinCommands(): readonly BuiltinCommand[] {
	return BUILTINS;
}

function findBuiltin(name: string): BuiltinCommand | undefined {
	return BUILTINS.find((command) => command.name === name || command.aliases?.includes(name));
}

/** Every command for completion: built-ins first, then extension commands that do not clash. */
export function commandList(extensions: ExtensionRegistry): Array<{ name: string; description: string }> {
	const list = BUILTINS.map((command) => ({ name: `/${command.name}`, description: command.description }));
	for (const command of extensions.commands.values()) {
		if (findBuiltin(command.name)) continue;
		list.push({ name: `/${command.name}`, description: command.description ?? "" });
	}
	return list;
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
	["Shift+Tab", "permission mode: supervised → autonomous → read-only"],
	["Ctrl+G", "edit the input in $VISUAL / $EDITOR"],
	["Tab", "complete / commands and @ files"],
	["!cmd / !!cmd", "run a shell command (!! keeps it out of the context)"],
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
	const extensionCommands = [...extensions.commands.values()].filter((command) => !findBuiltin(command.name));
	if (extensionCommands.length > 0) {
		lines.push(plainLine("Extension commands", { bold: true }));
		for (const command of extensionCommands) lines.push(row(`/${command.name}`, command.description ?? ""));
	}
	const shortcuts = [...extensions.shortcuts.values()];
	if (shortcuts.length > 0) {
		lines.push(plainLine("Extension shortcuts", { bold: true }));
		for (const shortcut of shortcuts) lines.push(row(shortcut.key, shortcut.description ?? shortcut.name));
	}
	lines.push(plainLine("Keys", { bold: true }));
	for (const [key, what] of KEYS) lines.push(row(key, what));
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
