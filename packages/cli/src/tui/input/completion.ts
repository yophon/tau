/**
 * Completion engine (ported from yo-agent surface-cli input/completion.ts):
 * `/` at the start of the input completes commands, the text after
 * "/command " completes that command's arguments (pi getArgumentCompletions),
 * `@` anywhere completes file paths (fuzzy). Candidates come from the caller;
 * this module only parses the token and filters.
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

export const COMPLETION_LIMIT = 8;

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

export function fuzzyFilter(candidates: readonly string[], query: string, limit = COMPLETION_LIMIT): string[] {
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
		const items = sources.argumentCompletions(name, prefix)?.slice(0, COMPLETION_LIMIT);
		if (items && items.length > 0) {
			return { kind: "argument", tokenStart: before.length - prefix.length, token: prefix, items: [...items] };
		}
	}

	const file = before.match(/(?:^|\s)@([^\s@]*)$/);
	if (file) {
		const token = `@${file[1] ?? ""}`;
		const tokenStart = cursor - token.length;
		if (sources.files === undefined) return { kind: "file", tokenStart, token, items: [] };
		const items = fuzzyFilter(sources.files, file[1] ?? "").map((path) => ({ value: `@${path}`, label: path }));
		return items.length > 0 ? { kind: "file", tokenStart, token, items } : undefined;
	}
	return undefined;
}

/** Replace the token with the item (a file completion adds a space). */
export function acceptCompletion(
	text: string,
	completion: Completion,
	item: CompletionItem,
): { text: string; cursor: number } {
	const inserted = item.value + (completion.kind === "file" ? " " : "");
	const next =
		text.slice(0, completion.tokenStart) + inserted + text.slice(completion.tokenStart + completion.token.length);
	return { text: next, cursor: completion.tokenStart + inserted.length };
}

export const FILE_LIST_LIMIT = 5000;

const SKIP_DIRS = new Set(["node_modules", "dist", "build", ".next"]);

/** `git ls-files` first (fast, honors .gitignore), else a directory walk; capped. */
export async function listFiles(cwd: string, limit = FILE_LIST_LIMIT): Promise<string[]> {
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
