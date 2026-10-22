/**
 * Small pure formatters shared by the TUI renderers (ported from yo-agent
 * surface-cli tui-format.ts).
 */
import { homedir } from "node:os";
import type { RiskLevel } from "@yophon/tau-kernel";

export type Tone = "info" | "warn" | "error" | "dim" | "success";

/** Compact integer: 1234 → 1.2k, 1_200_000 → 1.2M. */
export function fmtInt(n: number): string {
	if (!Number.isFinite(n) || n <= 0) return "0";
	if (n < 1000) return String(Math.round(n));
	if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
	return `${(n / 1_000_000).toFixed(1)}M`;
}

/** Cost: unknown or zero → undefined; under a cent → four decimals; else two. */
export function fmtCost(usd: number | undefined): string | undefined {
	if (!usd || usd <= 0) return undefined;
	if (usd < 0.01) return `$${usd.toFixed(4)}`;
	return `$${usd.toFixed(2)}`;
}

/** Seconds with one decimal under a minute, then m:ss. */
export function fmtElapsed(ms: number): string {
	const seconds = Math.max(0, ms) / 1000;
	if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`;
	const minutes = Math.floor(seconds / 60);
	return `${minutes}m${String(Math.floor(seconds % 60)).padStart(2, "0")}s`;
}

/** The home directory folded to `~` (both separators, for Windows). */
export function shortPath(path: string, home = homedir()): string {
	if (home && (path === home || path.startsWith(`${home}/`) || path.startsWith(`${home}\\`))) {
		return `~${path.slice(home.length)}`;
	}
	return path;
}

export function riskColor(risk: RiskLevel): string {
	return risk === "low" ? "green" : risk === "medium" ? "yellow" : "red";
}

/** First line of a text, cut to `max` characters with an ellipsis. */
export function firstLine(text: string, max = 60): string {
	const line = text.split("\n")[0] ?? "";
	return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

export function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** A line number given as a number or a numeric string (pi 1.3 parseLineNumber, #9887). */
export function readLineNumber(value: unknown): number | undefined {
	const number = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
	return typeof number === "number" && Number.isFinite(number) ? number : undefined;
}

/**
 * A read call's line range, ":start-end" (pi 1.3 formatReadLineRange): numbers or numeric
 * strings; null is an omitted argument (strict schemas); a malformed range is left out.
 */
export function formatReadLineRange(offset: unknown, limit: unknown): string {
	if (offset == null && limit == null) return "";
	const start = offset == null ? 1 : readLineNumber(offset);
	if (start === undefined) return "";
	if (limit == null) return `:${start}`;
	const count = readLineNumber(limit);
	if (count === undefined) return "";
	const end = start + count - 1;
	return `:${start}${end ? `-${end}` : ""}`;
}
