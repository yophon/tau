// The session commands (P58: moved out of commands.ts, technical debt #32): naming, resuming and
// listing sessions, forks and copies, a new session, /session, export and import. BUILTINS in
// commands.ts lists them in its order.

import { copyFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { messageText, type SessionEntry, type SessionMetadata } from "@yophon/tau-kernel";
import type { ThreadInfo } from "@yophon/tau-protocol";
import { findSession, relativeTime, sessionLabel } from "../session-title.ts";
import { toWireEntry } from "../wire.ts";
import { type BuiltinCommand, type CommandHost, startingWith } from "./commands.ts";
import { sessionHtml } from "./export-html.ts";
import { conversationLength, firstLine } from "./format.ts";
import { truncateCells } from "./input/width.ts";
import type { PickerItem } from "./model.ts";
import { plainLine, type StyledLine, span } from "./render/spans.ts";
import { contextOf, savedSessions, usageOf } from "./session-client.ts";

/** A row of the session picker: a saved session, and (P58) how the resident server runs it now. */
type SessionRow = SessionMetadata & { live?: ThreadInfo };

const FULL_SESSION = "__full_session__";
const INFO = "__entry_info__:";

export const sessionCommands: Record<
	"name" | "resume" | "fork" | "new" | "clone" | "session" | "export" | "import",
	BuiltinCommand
> = {
	name: {
		name: "name",
		aliases: ["rename"],
		args: "<name>",
		description: "Name the current session",
		run: async (tui, args) => {
			if (!tui.session.state.sessionFile) {
				tui.notice("error", "No active session (--no-session).");
				return;
			}
			if (args === "") {
				tui.notice("error", "Usage: /name <name>");
				return;
			}
			await tui.session.request("thread/setName", { name: args });
			await tui.session.drain();
			await tui.refreshSurfaces();
			tui.notice("dim", `Session named "${args}".`);
		},
	},
	resume: {
		name: "resume",
		aliases: ["sessions"],
		args: "[session]",
		description: "Switch to a saved session",
		complete: async (tui, prefix) =>
			startingWith(
				prefix,
				(await listSessions(tui)).map((session) => ({
					value: session.name ?? session.id,
					label: truncateCells(sessionLabel(session), 50),
					hint: relativeTime(session.modified ?? session.timestamp),
				})),
			),
		run: async (tui, args) => {
			const sessions = await listSessions(tui);
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
			const result = await tui.sessions.switchSession({ kind: "resume", threadId: selected.id });
			if (result.cancelled) tui.notice("dim", "Session switch cancelled by an extension.");
		},
	},
	fork: {
		name: "fork",
		args: "[id]",
		description: "Copy this session (or up to a message) and switch to the copy",
		run: async (tui, args) => {
			if (!tui.session.state.sessionFile) {
				tui.notice("error", "No active session (--no-session).");
				return;
			}
			let target = args;
			if (target === "") {
				const items: PickerItem[] = [{ label: "● The whole session", value: FULL_SESSION }];
				for (const entry of (await tui.session.entries()).entries) {
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
			// session_before_fork (before a message) and session_before_switch run in the hub.
			const result = await tui.sessions.switchSession({ kind: "fork", ...(target === "" ? {} : { entryId: target }) });
			if (result.cancelled) {
				tui.notice(
					"dim",
					result.by === "fork"
						? "Fork cancelled."
						: "Session switch cancelled by an extension (the fork file was kept).",
				);
			}
		},
	},
	new: {
		name: "new",
		// Claude Code's /clear (aliases /reset, /new): a new conversation with empty context (P38c).
		aliases: ["clear", "reset"],
		description: "Start a new session with empty context (/clear)",
		run: async (tui) => {
			if (!tui.session.state.sessionFile) {
				tui.notice("error", "No active session (--no-session).");
				return;
			}
			if (!(await tui.guardDirty("new session"))) return;
			const result = await tui.sessions.switchSession({ kind: "new" });
			if (result.cancelled) tui.notice("dim", "New session cancelled by an extension.");
		},
	},
	clone: {
		name: "clone",
		description: "Copy this session at its current position and switch to the copy",
		run: async (tui) => {
			if (!tui.session.state.sessionFile) {
				tui.notice("error", "No active session (--no-session).");
				return;
			}
			if (!(await tui.guardDirty("fork"))) return;
			const { leafId } = await tui.session.entries();
			const result = await tui.sessions.switchSession(
				leafId === null ? { kind: "fork" } : { kind: "fork", entryId: leafId, position: "at" },
			);
			if (result.cancelled) tui.notice("dim", "Session switch cancelled by an extension (the copy was kept).");
		},
	},
	session: {
		name: "session",
		aliases: ["status"],
		description: "Show the session file, id, size and usage",
		run: async (tui) => {
			const usage = usageOf(tui.session.state);
			const context = contextOf(tui.session.state);
			const row = (label: string, value: string): StyledLine => [
				span(`  ${label.padEnd(12)}`, { dim: true }),
				span(value),
			];
			const lines: StyledLine[] = [plainLine("Session", { bold: true })];
			const { state } = tui.session;
			if (state.sessionFile) {
				const { entries } = await tui.session.entries();
				lines.push(row("id", tui.session.id));
				if (state.name) lines.push(row("name", state.name));
				lines.push(row("file", state.sessionFile));
				if (state.parentSession) lines.push(row("parent", state.parentSession));
				lines.push(row("entries", String(entries.length)));
			} else {
				lines.push(row("file", "none (--no-session)"));
			}
			lines.push(row("messages", `${conversationLength(tui.session.messages)} in context`));
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
			lines.push(row("mode", tui.session.state.permissionMode));
			tui.lines(lines);
		},
	},
	export: {
		name: "export",
		args: "[path]",
		description: "Write the session as HTML (default) or JSONL",
		run: async (tui, args) => {
			const { state } = tui.session;
			const persisted = state.sessionFile !== undefined;
			const stem = `tau-session-${(persisted ? tui.session.id : new Date().toISOString().replaceAll(":", "-")).slice(0, 8)}`;
			const target = resolve(tui.options.cwd, args === "" ? `${stem}.html` : args);
			if (target.toLowerCase().endsWith(".jsonl")) {
				if (!state.sessionFile) {
					tui.notice("error", "No active session (--no-session): only HTML export is available.");
					return;
				}
				try {
					await copyFile(state.sessionFile, target);
				} catch {
					// Not written yet (no message): the entries as they are.
					const { entries } = await tui.session.entries();
					await writeFile(target, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf8");
				}
			} else {
				const html = sessionHtml(tui.session.messages, {
					title: state.name ?? `tau session ${persisted ? tui.session.id.slice(0, 8) : ""}`.trim(),
					model: tui.model,
					cwd: tui.options.cwd,
					exportedAt: new Date().toISOString(),
				});
				await writeFile(target, html, "utf8");
			}
			tui.notice("dim", `Exported the session to ${target}.`);
		},
	},
	import: {
		name: "import",
		args: "<path.jsonl>",
		description: "Import a session file and switch to it",
		run: async (tui, args) => {
			if (!tui.session.state.sessionFile) {
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
			const result = await tui.sessions.switchSession({ kind: "import", path: source });
			if (result.cancelled) tui.notice("dim", "Session switch cancelled by an extension (the imported file was kept).");
			else tui.notice("dim", `Imported ${source}.`);
		},
	},
};

/** A session entry as a picker item, through extension entry renderers first. */
async function presentEntry(
	tui: CommandHost,
	entry: SessionEntry,
	fallback: { label: string; hint?: string } | undefined,
): Promise<{ label: string; hint?: string } | undefined> {
	if (tui.session.state.extensions.entryRenderers === 0) return fallback;
	try {
		const { rendered, failed } = await tui.session.request("render/entry", {
			entry: toWireEntry(entry),
			width: 80,
		});
		if (failed) {
			tui.notice("error", `Entry renderer ${failed.renderer} failed: ${failed.error}`);
			return fallback;
		}
		if (!rendered) return fallback;
		if (rendered.kind === "label") {
			return { label: rendered.label, ...(rendered.description !== undefined ? { hint: rendered.description } : {}) };
		}
		if (rendered.kind === "lines") {
			const [label, ...rest] = rendered.lines;
			if (!label) return fallback;
			return { label, ...(rest.length > 0 ? { hint: rest.join(" ") } : {}) };
		}
		return { label: rendered.text, ...(fallback?.hint ? { hint: fallback.hint } : {}) };
	} catch {
		return fallback;
	}
}

/**
 * "5 min ago · 42 messages" (P34f). P58: a session the resident server holds says how it runs —
 * "running · 2 clients", "waiting for an answer", and its directory when it is not this one.
 */
function sessionHint(session: SessionRow, here: string | undefined): string {
	const { live } = session;
	if (live) {
		const state = live.waiting ? "waiting for an answer" : live.status === "running" ? "running" : "idle";
		const clients = live.clients ?? 0;
		const where = here !== undefined && live.cwd !== here ? ` · ${live.cwd}` : "";
		return `${state} · ${clients} client${clients === 1 ? "" : "s"}${where}`;
	}
	const when = relativeTime(session.modified ?? session.timestamp);
	const count = session.messageCount ?? 0;
	return `${when} · ${count} message${count === 1 ? "" : "s"}`;
}

/**
 * The /resume picker (P38c, pi's session selector): type to search titles and first
 * messages, the current session marked, same titles told apart by their id, Ctrl+R to
 * rename and Ctrl+D to delete. Undefined when nothing is chosen (or only the current one).
 */
async function chooseSession(tui: CommandHost, initial: SessionRow[]): Promise<SessionMetadata | undefined> {
	let sessions = initial;
	const current = { id: tui.session.id };
	for (;;) {
		const labels = sessions.map((session) => truncateCells(sessionLabel(session), 50));
		const items = sessions.map((session, index) => {
			const label = labels[index] as string;
			const twin = labels.filter((other) => other === label).length > 1;
			return {
				label: `${session.id === current?.id ? "● " : "  "}${label}`,
				hint: `${session.id === current?.id ? "current · " : ""}${sessionHint(session, tui.session.cwd)}${twin ? ` · ${session.id.slice(0, 8)}` : ""}`,
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
				await tui.session.client.call("thread/setName", { threadId: session.id, name, ...tui.session.where() });
				tui.flash(`Renamed to "${name}"`);
			}
		} else if (picked.action === "ctrl+d") {
			if (session.id === current?.id) {
				tui.flash("The current session cannot be deleted.");
			} else if (await tui.ui.confirm(`Delete "${sessionLabel(session)}"?`, "This removes the session file.")) {
				await tui.session.client.call("thread/delete", { threadId: session.id, ...tui.session.where() });
				tui.flash("Session deleted.");
			}
		} else {
			if (session.id === current?.id) {
				tui.flash("Already in this session.");
				return undefined;
			}
			return session;
		}
		sessions = await listSessions(tui);
		if (sessions.length === 0) {
			tui.notice("dim", "No sessions found.");
			return undefined;
		}
	}
}

/** The sessions of this directory as the pickers know them (thread/list; P57: the hub reads them). */
async function listSessions(tui: Pick<CommandHost, "session">): Promise<SessionRow[]> {
	const { session } = tui;
	const rows: SessionRow[] = savedSessions((await session.client.listThreads(session.cwd)).threads);
	if (!session.resident) return rows;
	// P58: what the resident server holds — this directory's sessions marked, other directories' first.
	const loaded = (await session.client.call("thread/loaded/list", {})).threads;
	for (const row of rows) {
		const live = loaded.find((thread) => thread.id === row.id);
		if (live) row.live = live;
	}
	const elsewhere: SessionRow[] = loaded
		.filter((thread) => !rows.some((row) => row.id === thread.id))
		.map((thread) => ({
			id: thread.id,
			cwd: thread.cwd,
			timestamp: thread.createdAt ?? thread.updatedAt ?? "",
			...(thread.name !== undefined ? { name: thread.name } : {}),
			...(thread.preview !== undefined ? { firstMessage: thread.preview } : {}),
			live: thread,
		}));
	return [...elsewhere, ...rows];
}
