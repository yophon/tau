/**
 * Completion engine (ported from yo-agent surface-cli input/completion.ts):
 * `/` at the start of the input completes commands, the text after
 * "/command " completes that command's arguments (pi getArgumentCompletions),
 * `@` anywhere completes file and directory paths (fuzzy; `@"…"` for paths with
 * spaces, pi). Candidates come from the caller; this module only parses the token
 * and filters.
 */
export interface CompletionItem {
	/** Replaces the token when accepted. */
	value: string;
	label: string;
	hint?: string;
}

export interface Completion {
	kind: "slash" | "argument" | "file";
	/** The replaced token spans [tokenStart, tokenStart + token.length). */
	tokenStart: number;
	token: string;
	items: CompletionItem[];
}

/** `@` file matches listed at most (a project can hold tens of thousands of files); typing narrows the rest. */
export const FILE_MATCH_LIMIT = 200;

/** Prefix > path-segment prefix > substring > ordered subsequence; -1 = no match. Shorter wins ties. */
export function fuzzyScore(candidate: string, query: string): number {
	if (query === "") return 1;
	const c = candidate.toLowerCase();
	const q = query.toLowerCase();
	if (c.startsWith(q)) return 1000 - candidate.length;
	if (c.split(/[/._-]/).some((segment) => segment.startsWith(q))) return 800 - candidate.length;
	const at = c.indexOf(q);
	if (at >= 0) return 600 - at - candidate.length;
	let i = 0;
	for (const ch of c) {
		if (ch === q[i]) i++;
		if (i === q.length) return 300 - candidate.length;
	}
	return -1;
}

/** Matches best first; an empty query keeps the given order (the sort is stable). */
export function fuzzyFilter(candidates: readonly string[], query: string, limit = Number.POSITIVE_INFINITY): string[] {
	return candidates
		.map((value) => ({ value, score: fuzzyScore(value, query) }))
		.filter((entry) => entry.score >= 0)
		.sort((a, b) => b.score - a.score)
		.slice(0, limit)
		.map((entry) => entry.value);
}

export interface CompletionSources {
	/** Command names with a leading `/`, and their descriptions. */
	commands: ReadonlyArray<{ name: string; description: string }>;
	/** Relative file paths; undefined while still loading. */
	files: readonly string[] | undefined;
	/** Completions for the arguments of command `name` (no slash); undefined = none (yet). */
	argumentCompletions?: (name: string, prefix: string) => readonly CompletionItem[] | undefined;
}

export function computeCompletion(text: string, cursor: number, sources: CompletionSources): Completion | undefined {
	const before = text.slice(0, cursor);

	// Commands: only while the cursor is still inside the first word of a `/` input.
	const slash = before.match(/^\/([\w:-]*)$/);
	if (slash && text.startsWith("/")) {
		const query = slash[1] ?? "";
		const names = sources.commands.map((command) => command.name.slice(1));
		const items = fuzzyFilter(names, query).map((name) => ({
			value: `/${name}`,
			label: `/${name}`,
			hint: sources.commands.find((command) => command.name === `/${name}`)?.description,
		}));
		return items.length > 0 ? { kind: "slash", tokenStart: 0, token: `/${query}`, items } : undefined;
	}

	// Arguments: one line, cursor at the end; the item value replaces everything after "/name ".
	const argument = cursor === text.length ? before.match(/^\/([\w:-]+) ([^\n]*)$/) : null;
	if (argument && sources.argumentCompletions) {
		const name = argument[1] ?? "";
		const prefix = argument[2] ?? "";
		const items = sources.argumentCompletions(name, prefix);
		if (items && items.length > 0) {
			return { kind: "argument", tokenStart: before.length - prefix.length, token: prefix, items: [...items] };
		}
	}

	const file = before.match(/(?:^|\s)(@"[^"\n]*|@[^\s@"]*)$/);
	if (file) {
		const token = file[1] ?? "@";
		const query = token.startsWith('@"') ? token.slice(2) : token.slice(1);
		const tokenStart = cursor - token.length;
		if (sources.files === undefined) return { kind: "file", tokenStart, token, items: [] };
		const items = fuzzyFilter(sources.files, query, FILE_MATCH_LIMIT).map((path) => ({
			value: fileReference(path),
			label: path,
		}));
		return items.length > 0 ? { kind: "file", tokenStart, token, items } : undefined;
	}
	return undefined;
}

/** `@path`, quoted when it has spaces; a directory stays open (no closing quote) to keep descending. */
export function fileReference(path: string): string {
	if (!/\s/.test(path)) return `@${path}`;
	return path.endsWith("/") ? `@"${path}` : `@"${path}"`;
}

/** Replace the token with the item (a file completion adds a space; a directory does not, pi). */
export function acceptCompletion(
	text: string,
	completion: Completion,
	item: CompletionItem,
): { text: string; cursor: number } {
	const directory = item.value.endsWith("/");
	const inserted = item.value + (completion.kind === "file" && !directory ? " " : "");
	const next =
		text.slice(0, completion.tokenStart) + inserted + text.slice(completion.tokenStart + completion.token.length);
	return { text: next, cursor: completion.tokenStart + inserted.length };
}

/** Files listed at most; typing narrows the matches shown (FILE_MATCH_LIMIT). */
export const FILE_LIST_LIMIT = 50_000;

const SKIP_DIRS = new Set(["node_modules", "dist", "build", ".next"]);

/** Files and the directories holding them (ending in "/"), for `@` completion. */
export async function listFiles(cwd: string, limit = FILE_LIST_LIMIT): Promise<string[]> {
	const files = await listOnlyFiles(cwd, limit);
	const dirs = new Set<string>();
	for (const file of files) {
		for (let slash = file.indexOf("/"); slash !== -1; slash = file.indexOf("/", slash + 1)) {
			dirs.add(file.slice(0, slash + 1));
		}
	}
	return [...files, ...dirs];
}

/** `git ls-files` first (fast, honors .gitignore), else a directory walk; capped. */
async function listOnlyFiles(cwd: string, limit: number): Promise<string[]> {
	try {
		const { execFile } = await import("node:child_process");
		const out = await new Promise<string>((resolve, reject) => {
			execFile(
				"git",
				["ls-files", "--cached", "--others", "--exclude-standard"],
				{ cwd, maxBuffer: 16 * 1024 * 1024, windowsHide: true },
				(error, stdout) => (error ? reject(error) : resolve(stdout)),
			);
		});
		const files = out.split("\n").filter(Boolean);
		if (files.length > 0) return files.slice(0, limit);
	} catch {
		// Not a git work tree: walk the directory.
	}
	const { readdir } = await import("node:fs/promises");
	const { join } = await import("node:path");
	const found: string[] = [];
	const walk = async (dir: string, rel: string): Promise<void> => {
		if (found.length >= limit) return;
		let entries: import("node:fs").Dirent[];
		try {
			entries = await readdir(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			if (found.length >= limit) return;
			if (entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) continue;
			const path = rel === "" ? entry.name : `${rel}/${entry.name}`;
			if (entry.isDirectory()) await walk(join(dir, entry.name), path);
			else found.push(path);
		}
	};
	await walk(cwd, "");
	return found;
}
