// What to tell the model about diagnostics, as Claude Code does it (debug logs in
// #93321, #100569): every file a server publishes for is collected; a diagnostic
// already delivered since the file was last edited is not delivered again; editing
// or writing a file forgets what was delivered for it. One deviation: a publish
// replaces that server's undelivered diagnostics for the file (publishes are the full
// current set), so issues fixed before delivery are not reported (Claude Code still
// reports them, #100569).
import type { LspDiagnostic } from "./client.ts";
import { displayPath, pathKey } from "./paths.ts";

export interface FileDiagnostics {
	path: string;
	items: { server: string; diagnostic: LspDiagnostic }[];
}

function diagnosticKey(server: string, diagnostic: LspDiagnostic): string {
	const { start, end } = diagnostic.range;
	return JSON.stringify([
		server,
		start.line,
		start.character,
		end.line,
		end.character,
		diagnostic.severity ?? 1,
		diagnostic.code ?? null,
		diagnostic.source ?? null,
		diagnostic.message,
	]);
}

function isDiagnostic(value: unknown): value is LspDiagnostic {
	const candidate = value as Partial<LspDiagnostic> | undefined;
	return (
		typeof candidate === "object" &&
		candidate !== null &&
		typeof candidate.message === "string" &&
		typeof candidate.range?.start?.line === "number" &&
		typeof candidate.range?.start?.character === "number"
	);
}

export class DiagnosticRegistry {
	/** Keys delivered since each file was last edited. */
	private readonly delivered = new Map<string, Set<string>>();
	private readonly pending = new Map<string, { path: string; byServer: Map<string, LspDiagnostic[]> }>();
	private readonly published = new Map<string, number>();
	/** When any publish last arrived (ms since epoch). */
	lastPublishAt = 0;

	publish(path: string, server: string, diagnostics: readonly unknown[]): void {
		const key = pathKey(path);
		const now = Date.now();
		this.published.set(key, now);
		this.lastPublishAt = now;
		const delivered = this.delivered.get(key);
		const seen = new Set<string>();
		const fresh: LspDiagnostic[] = [];
		for (const item of diagnostics) {
			if (!isDiagnostic(item)) continue;
			const itemKey = diagnosticKey(server, item);
			if (delivered?.has(itemKey) || seen.has(itemKey)) continue;
			seen.add(itemKey);
			fresh.push(item);
		}
		let entry = this.pending.get(key);
		if (fresh.length === 0) {
			entry?.byServer.delete(server);
			if (entry && entry.byServer.size === 0) this.pending.delete(key);
			return;
		}
		if (!entry) {
			entry = { path, byServer: new Map() };
			this.pending.set(key, entry);
		}
		entry.byServer.set(server, fresh);
	}

	/** The file was edited or written: what was delivered for it may be delivered again. */
	clear(path: string): void {
		const key = pathKey(path);
		this.delivered.delete(key);
		this.pending.delete(key);
	}

	/** When the last publish for `path` arrived, if any. */
	publishedAt(path: string): number | undefined {
		return this.published.get(pathKey(path));
	}

	hasPending(): boolean {
		return this.pending.size > 0;
	}

	/** Everything waiting, marked delivered. */
	take(): FileDiagnostics[] {
		const out: FileDiagnostics[] = [];
		for (const [key, entry] of this.pending) {
			let delivered = this.delivered.get(key);
			if (!delivered) {
				delivered = new Set();
				this.delivered.set(key, delivered);
			}
			const items: FileDiagnostics["items"] = [];
			for (const [server, diagnostics] of entry.byServer) {
				for (const diagnostic of diagnostics) {
					delivered.add(diagnosticKey(server, diagnostic));
					items.push({ server, diagnostic });
				}
			}
			items.sort(
				(a, b) =>
					a.diagnostic.range.start.line - b.diagnostic.range.start.line ||
					a.diagnostic.range.start.character - b.diagnostic.range.start.character,
			);
			if (items.length > 0) out.push({ path: entry.path, items });
		}
		this.pending.clear();
		return out;
	}
}

/** Claude Code's ✘ (error) and ★ (hint); its warning and information marks are not public. */
const SEVERITY_MARKS: Record<number, string> = { 1: "✘", 2: "▲", 3: "●", 4: "★" };

function plural(count: number, word: string): string {
	return `${count} ${word}${count === 1 ? "" : "s"}`;
}

/** "Found 1 new diagnostic issue in 1 file" (Claude Code's summary line). */
export function diagnosticsSummary(issues: number, files: number): string {
	return `Found ${issues} new diagnostic ${issues === 1 ? "issue" : "issues"} in ${plural(files, "file")}`;
}

export interface FormattedDiagnostics {
	/** What the model gets. */
	text: string;
	issues: number;
	files: number;
}

/**
 * The model's text, as Claude Code words it:
 *   <new-diagnostics>The following new diagnostic issues were detected:
 *
 *   src/app.ts:
 *     ✘ [Line 5:6] Cannot find name 'foo'. [2304] (typescript)
 *   </new-diagnostics>
 * Lines and columns from 1; the file as a path relative to `cwd` (Claude Code shows
 * the bare name, which mixes up same-named files, #80303).
 */
export function formatDiagnostics(files: readonly FileDiagnostics[], cwd: string): FormattedDiagnostics {
	const sections: string[] = [];
	let issues = 0;
	for (const file of files) {
		const lines = [`${displayPath(file.path, cwd)}:`];
		for (const { diagnostic } of file.items) {
			issues++;
			const mark = SEVERITY_MARKS[diagnostic.severity ?? 1] ?? SEVERITY_MARKS[1];
			const { line, character } = diagnostic.range.start;
			const message = diagnostic.message.trim().replace(/\r?\n/g, "\n    ");
			const code = diagnostic.code !== undefined && diagnostic.code !== "" ? ` [${diagnostic.code}]` : "";
			const source = diagnostic.source ? ` (${diagnostic.source})` : "";
			lines.push(`  ${mark} [Line ${line + 1}:${character + 1}] ${message}${code}${source}`);
		}
		sections.push(lines.join("\n"));
	}
	return {
		text: `<new-diagnostics>The following new diagnostic issues were detected:\n\n${sections.join("\n\n")}\n</new-diagnostics>`,
		issues,
		files: files.length,
	};
}
