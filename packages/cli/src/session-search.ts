// session_search / session_read (P32a, after Hermes Agent's session_search):
// keyword search over a person's own session files, returning the stored text
// itself — no index, no embeddings, no model call. Only user and assistant text
// is searched (not tool results). Stays in the CLI (P63): it reads the terminal's
// JSONL session files; another host searches its own conversations its own way.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import type { Extension } from "@yophon/tau-kernel";

export interface SessionRoot {
	dir: string;
}

interface Hit {
	file: string;
	entry: string;
	at: string;
	role: string;
	snippet: string;
}

const MAX_BYTES = 200 * 1024 * 1024;
const MAX_MS = 3000;
const SNIPPET = 150;

function walk(dir: string, out: string[]): void {
	let names: string[];
	try {
		names = readdirSync(dir);
	} catch {
		return;
	}
	for (const name of names) {
		const path = join(dir, name);
		let stat: ReturnType<typeof statSync>;
		try {
			stat = statSync(path);
		} catch {
			continue;
		}
		if (stat.isDirectory()) walk(path, out);
		else if (name.endsWith(".jsonl")) out.push(path);
	}
}

/** The session files this person may read, newest first. */
export function sessionFiles(roots: readonly SessionRoot[]): string[] {
	const files: Array<{ path: string; mtime: number }> = [];
	for (const root of roots) {
		const found: string[] = [];
		walk(root.dir, found);
		for (const path of found) {
			try {
				files.push({ path: resolve(path), mtime: statSync(path).mtimeMs });
			} catch {
				// Removed meanwhile.
			}
		}
	}
	return [...new Map(files.map((file) => [file.path, file])).values()]
		.sort((a, b) => b.mtime - a.mtime)
		.map((file) => file.path);
}

interface MessageLine {
	id: string;
	at: string;
	role: string;
	text: string;
}

/** The user and assistant text of one JSONL line, or undefined for anything else. */
function messageOf(line: string): MessageLine | undefined {
	if (!line.includes('"type":"message"')) return undefined;
	let entry: { type?: string; id?: string; timestamp?: string; message?: { role?: string; content?: unknown } };
	try {
		entry = JSON.parse(line);
	} catch {
		return undefined;
	}
	const role = entry.message?.role;
	if (entry.type !== "message" || (role !== "user" && role !== "assistant") || !entry.id) return undefined;
	const content = entry.message?.content;
	const text =
		typeof content === "string"
			? content
			: Array.isArray(content)
				? content
						.filter(
							(block): block is { type: string; text: string } =>
								block?.type === "text" && typeof block.text === "string",
						)
						.map((block) => block.text)
						.join("\n")
				: "";
	if (text.trim() === "") return undefined;
	return { id: entry.id, at: entry.timestamp ?? "", role, text };
}

/** "7d", "24h", "2026-10-01" → epoch ms. */
export function parseSince(value: string, now = Date.now()): number {
	const relativeMatch = /^(\d+)\s*([dh])$/i.exec(value.trim());
	if (relativeMatch) {
		const amount = Number(relativeMatch[1]);
		return now - amount * ((relativeMatch[2] ?? "d").toLowerCase() === "d" ? 86_400_000 : 3_600_000);
	}
	const at = Date.parse(value.trim());
	if (Number.isFinite(at)) return at;
	throw new Error(`since: "${value}" is not like 7d, 24h or 2026-10-01`);
}

function localTime(iso: string): string {
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) return iso;
	const pad = (value: number) => String(value).padStart(2, "0");
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function snippetOf(text: string, term: string): string {
	const flat = text.replace(/\s+/g, " ").trim();
	const index = flat.toLowerCase().indexOf(term);
	const start = Math.max(0, index - SNIPPET);
	const end = Math.min(flat.length, index + term.length + SNIPPET);
	return `${start > 0 ? "…" : ""}${flat.slice(start, end)}${end < flat.length ? "…" : ""}`;
}

export function searchSessions(
	roots: readonly SessionRoot[],
	query: string,
	options: {
		since?: string;
		limit?: number;
		exclude?: string | undefined;
		now?: number;
		maxBytes?: number;
		maxMs?: number;
	} = {},
): { hits: Hit[]; complete: boolean; text: string } {
	const terms = query
		.toLowerCase()
		.split(/\s+/)
		.filter((term) => term !== "");
	if (terms.length === 0) throw new Error("query is empty");
	const limit = Math.max(1, Math.min(30, Math.floor(options.limit ?? 10)));
	const since = options.since ? parseSince(options.since, options.now) : undefined;
	const exclude = options.exclude ? resolve(options.exclude) : undefined;
	const started = Date.now();
	const maxBytes = options.maxBytes ?? MAX_BYTES;
	const maxMs = options.maxMs ?? MAX_MS;
	let bytes = 0;
	let complete = true;
	const hits: Hit[] = [];
	const files = sessionFiles(roots);
	outer: for (const file of files) {
		if (file === exclude) continue;
		if (since !== undefined) {
			try {
				if (statSync(file).mtimeMs < since) continue;
			} catch {
				continue;
			}
		}
		if (bytes > maxBytes || Date.now() - started > maxMs) {
			complete = false;
			break;
		}
		let content: string;
		try {
			content = readFileSync(file, "utf8");
		} catch {
			continue;
		}
		bytes += content.length;
		const fileHits: Hit[] = [];
		for (const line of content.split("\n")) {
			const message = messageOf(line);
			if (!message) continue;
			if (since !== undefined && Date.parse(message.at) < since) continue;
			const lower = message.text.toLowerCase();
			if (!terms.every((term) => lower.includes(term))) continue;
			fileHits.push({
				file,
				entry: message.id,
				at: message.at,
				role: message.role,
				snippet: snippetOf(message.text, terms[0] as string),
			});
		}
		// Newest first within a file too.
		for (const hit of fileHits.reverse()) {
			hits.push(hit);
			if (hits.length >= limit) break outer;
		}
	}
	const lines = hits.map(
		(hit) => `${localTime(hit.at)} · ${hit.role} · ${hit.file} · entry ${hit.entry}\n  ${hit.snippet}`,
	);
	const text =
		hits.length === 0
			? `No earlier session mentions ${terms.map((term) => `"${term}"`).join(" and ")}${complete ? "" : " (search stopped early: too many sessions; narrow it with since)"}.`
			: [
					...lines,
					complete ? "" : "(Search stopped early: too many sessions; narrow it with since.)",
					"Read more around a hit with session_read.",
				]
					.filter((line) => line !== "")
					.join("\n");
	return { hits, complete, text };
}

export function readSessionAround(
	roots: readonly SessionRoot[],
	file: string,
	entry: string,
	options: { before?: number; after?: number } = {},
): string {
	const target = resolve(file);
	const allowed = roots.some((root) => {
		const rel = relative(resolve(root.dir), target);
		return rel !== "" && !rel.startsWith("..") && !/^[a-zA-Z]:/.test(rel);
	});
	if (!allowed || !target.endsWith(".jsonl"))
		throw new Error(`${file} is not one of the sessions session_search can read`);
	const messages = readFileSync(target, "utf8")
		.split("\n")
		.map(messageOf)
		.filter((message): message is MessageLine => message !== undefined);
	const index = messages.findIndex((message) => message.id === entry);
	if (index < 0) throw new Error(`entry ${entry} is not a message in ${file}`);
	const before = Math.max(0, Math.min(20, Math.floor(options.before ?? 3)));
	const after = Math.max(0, Math.min(20, Math.floor(options.after ?? 3)));
	return messages
		.slice(Math.max(0, index - before), index + after + 1)
		.map((message) => {
			const body = message.text.length > 1500 ? `${message.text.slice(0, 1500)}…` : message.text;
			return `${message.id === entry ? "▶ " : ""}${localTime(message.at)} ${message.role}: ${body}`;
		})
		.join("\n\n");
}

const text = (value: string, isError = false) => ({
	content: [{ type: "text" as const, text: value }],
	...(isError ? { isError: true } : {}),
});
const str = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);
const failureText = (error: unknown) => text(error instanceof Error ? error.message : String(error), true);

/**
 * The two tools as a built-in extension (P63: split from the memory extension, which moved
 * to @yophon/tau-ext-memory; loaded right after it so the tool order stays the same).
 * `getRoots` is read on every use; undefined = not configured yet.
 */
export function createSessionSearchExtension(getRoots: () => readonly SessionRoot[] | undefined): Extension {
	return (api) => {
		api.registerTool(
			{
				name: "session_search",
				description:
					"Search this person's earlier sessions (terminal and chat) for words: every word must appear in the message. Returns date, session file, entry id and the text around the match; read more with session_read.",
				promptSnippet: "Find things said in earlier sessions",
				promptGuidelines: [
					"When the user refers to something from an earlier conversation that is not in memory or this session, use session_search before saying you do not know.",
				],
				parameters: {
					type: "object",
					properties: {
						query: { type: "string", description: "Words to find, separated by spaces (all must match)" },
						since: {
							type: "string",
							description: "Only sessions from this far back: 7d, 24h, or a date like 2026-10-01",
						},
						limit: { type: "number", description: "Most hits to return (default 10, at most 30)" },
					},
					required: ["query"],
				},
				execute: async (args, _signal, _onUpdate, ctx) => {
					const roots = getRoots();
					if (!roots) return text("Session search is not available here.", true);
					try {
						const result = searchSessions(roots, str(args.query) ?? "", {
							...(str(args.since) ? { since: str(args.since) } : {}),
							limit: typeof args.limit === "number" ? args.limit : 10,
							exclude: ctx?.sessionManager?.getSessionFile(),
						});
						return text(result.text);
					} catch (error) {
						return failureText(error);
					}
				},
			},
			{ risk: "low" },
		);

		api.registerTool(
			{
				name: "session_read",
				description: "Read the messages around an entry that session_search found.",
				parameters: {
					type: "object",
					properties: {
						file: { type: "string", description: "The session file session_search returned" },
						entry: { type: "string", description: "The entry id session_search returned" },
						before: { type: "number", description: "Messages before it (default 3, at most 20)" },
						after: { type: "number", description: "Messages after it (default 3, at most 20)" },
					},
					required: ["file", "entry"],
				},
				execute: async (args) => {
					const roots = getRoots();
					if (!roots) return text("Session search is not available here.", true);
					try {
						return text(
							readSessionAround(roots, str(args.file) ?? "", str(args.entry) ?? "", {
								before: typeof args.before === "number" ? args.before : 3,
								after: typeof args.after === "number" ? args.after : 3,
							}),
						);
					} catch (error) {
						return failureText(error);
					}
				},
			},
			{ risk: "low" },
		);
	};
}
