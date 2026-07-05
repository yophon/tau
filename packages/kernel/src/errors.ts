export type TauErrorCode =
	| "platform_missing"
	| "http_error"
	| "stream_error"
	| "aborted"
	| "max_turns"
	| "invalid_response";

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
