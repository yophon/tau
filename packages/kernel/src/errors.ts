export type TauErrorCode =
	| "platform_missing"
	| "http_error"
	| "network_error"
	| "stream_error"
	| "timeout"
	| "aborted"
	| "max_turns"
	| "no_host"
	| "no_session"
	| "busy"
	/** A seam was asked for something its implementation does not support (e.g. headers on a custom transport). */
	| "unsupported"
	/** An extension handler cancelled the operation (e.g. session_before_compact). */
	| "cancelled"
	| "compaction_failed"
	| "invalid_response"
	| "invalid_tool"
	/** An extension registered something malformed (a command without handler, a flag default of the wrong type). */
	| "invalid_extension"
	/** A captured extension api/ctx was used after its registry was replaced or its setup failed. */
	| "stale_extension"
	/** Kernel invariant broken (e.g. the request diverged from the session log, P22): a bug, not a runtime condition. */
	| "invalid_state";

export class TauError extends Error {
	readonly code: TauErrorCode;

	constructor(code: TauErrorCode, message: string, cause?: unknown) {
		super(message, cause === undefined ? undefined : { cause });
		this.name = "TauError";
		this.code = code;
	}
}

export class HttpError extends TauError {
	readonly status: number;
	readonly bodyText: string;

	constructor(status: number, bodyText: string) {
		super("http_error", `HTTP ${status}: ${bodyText.slice(0, 2000)}`);
		this.name = "HttpError";
		this.status = status;
		this.bodyText = bodyText;
	}
}

export type FileErrorCode =
	| "not_found"
	| "permission_denied"
	| "is_directory"
	| "not_directory"
	| "invalid"
	| "unknown";

export class FileError extends Error {
	readonly code: FileErrorCode;
	readonly path?: string;

	constructor(code: FileErrorCode, message: string, path?: string, cause?: unknown) {
		super(message, cause === undefined ? undefined : { cause });
		this.name = "FileError";
		this.code = code;
		this.path = path;
	}
}

export type SessionErrorCode = "invalid_session" | "invalid_entry" | "invalid_fork_target" | "not_found";

export class SessionError extends Error {
	readonly code: SessionErrorCode;

	constructor(code: SessionErrorCode, message: string, cause?: unknown) {
		super(message, cause === undefined ? undefined : { cause });
		this.name = "SessionError";
		this.code = code;
	}
}

export type ShellErrorCode = "shell_unavailable" | "spawn_error" | "timeout" | "aborted";

export class ShellError extends Error {
	readonly code: ShellErrorCode;

	constructor(code: ShellErrorCode, message: string, cause?: unknown) {
		super(message, cause === undefined ? undefined : { cause });
		this.name = "ShellError";
		this.code = code;
	}
}

export function toError(value: unknown): Error {
	return value instanceof Error ? value : new Error(String(value));
}

/**
 * An error's message with its innermost cause appended (P23d): undici reports a
 * refused local port as "fetch failed" and keeps ECONNREFUSED two causes deep,
 * which is all a user needs to see. Falls back to the cause's `code` when its
 * message is empty (AggregateError).
 */
export function describeError(value: unknown): string {
	const outer = toError(value);
	let inner: unknown = outer;
	for (let depth = 0; depth < 8; depth++) {
		const next = (inner as { cause?: unknown } | undefined)?.cause;
		if (next === undefined || next === null || next === inner) break;
		inner = next;
	}
	if (inner === outer) return outer.message;
	const innerError = inner as { message?: unknown; code?: unknown };
	const detail =
		typeof innerError.message === "string" && innerError.message !== ""
			? innerError.message
			: typeof innerError.code === "string"
				? innerError.code
				: String(inner);
	return detail === "" || outer.message.includes(detail) ? outer.message : `${outer.message} (${detail})`;
}
