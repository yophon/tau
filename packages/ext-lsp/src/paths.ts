// Paths and file URIs without node:path or node:url (the core is pure ES). Windows
// paths (drive letters, UNC) and POSIX paths are told apart by their shape, so one
// build serves both. Every comparison goes through pathKey: language servers may hand
// back a drive letter or casing that differs from what tau sent (opencode got caught
// there).

const DRIVE = /^[A-Za-z]:([\\/]|$)/;

export function isWindowsPath(path: string): boolean {
	return DRIVE.test(path) || path.startsWith("\\\\");
}

export function isAbsolutePath(path: string): boolean {
	return path.startsWith("/") || isWindowsPath(path);
}

/** Collapse `.`, `..` and repeated separators; Windows paths get backslashes and an upper-case drive. */
function normalizePath(path: string): string {
	const windows = isWindowsPath(path);
	const unc = windows && path.startsWith("\\\\");
	let rest = path.replace(/\\/g, "/");
	let root = "";
	if (unc) {
		const [, host = "", share = ""] = rest.match(/^\/\/([^/]+)\/([^/]*)/) ?? [];
		root = `//${host}/${share}`;
		rest = rest.slice(root.length);
	} else if (windows) {
		root = `${rest[0].toUpperCase()}:`;
		rest = rest.slice(2);
	} else if (rest.startsWith("/")) {
		root = "";
	}
	const absolute = unc || windows || path.startsWith("/");
	const parts: string[] = [];
	for (const part of rest.split("/")) {
		if (part === "" || part === ".") continue;
		if (part === "..") {
			if (parts.length > 0 && parts[parts.length - 1] !== "..") parts.pop();
			else if (!absolute) parts.push("..");
			continue;
		}
		parts.push(part);
	}
	const joined = `${root}${absolute ? "/" : ""}${parts.join("/")}`;
	return windows ? joined.replace(/\//g, "\\") : joined || ".";
}

/** `path` made absolute against `cwd` and normalized. */
export function resolvePath(cwd: string, path: string): string {
	if (isAbsolutePath(path)) return normalizePath(path);
	const separator = isWindowsPath(cwd) ? "\\" : "/";
	return normalizePath(`${cwd}${separator}${path}`);
}

/** Comparison key: Windows file systems ignore case. */
export function pathKey(path: string): string {
	const normalized = normalizePath(path);
	return isWindowsPath(normalized) ? normalized.toLowerCase() : normalized;
}

/** `path` relative to `cwd` with `/` separators when inside it; the absolute path otherwise. */
export function displayPath(path: string, cwd: string): string {
	const absolute = normalizePath(path);
	const base = normalizePath(cwd);
	const key = pathKey(absolute);
	const baseKey = pathKey(base);
	if (key === baseKey) return ".";
	const separator = isWindowsPath(base) ? "\\" : "/";
	const prefix = baseKey.endsWith(separator) ? baseKey : `${baseKey}${separator}`;
	if (!key.startsWith(prefix)) return absolute;
	return absolute.slice(prefix.length).replace(/\\/g, "/");
}

// Characters a file URI path keeps as they are (RFC 3986 unreserved, sub-delims, ":", "@", "/").
const URI_SAFE = /[A-Za-z0-9\-._~!$&'()*+,;=:@/]/;

function encodeUriPath(path: string): string {
	let out = "";
	for (const char of path) {
		if (URI_SAFE.test(char)) out += char;
		else out += encodeURIComponent(char);
	}
	return out;
}

/** file:///D:/a%20b/x.ts, file:///home/x.ts, file://server/share/x.ts (what Node's pathToFileURL gives). */
export function pathToUri(path: string): string {
	const normalized = normalizePath(path);
	if (normalized.startsWith("\\\\")) {
		const [host = "", ...rest] = normalized.slice(2).split("\\");
		return `file://${host}/${encodeUriPath(rest.join("/"))}`;
	}
	if (isWindowsPath(normalized)) return `file:///${encodeUriPath(normalized.replace(/\\/g, "/"))}`;
	return `file://${encodeUriPath(normalized)}`;
}

/** The path a file URI names; undefined for other schemes. Decodes %3A-style drive colons too. */
export function uriToPath(uri: string): string | undefined {
	const match = uri.match(/^file:\/\/([^/]*)(\/.*)?$/i);
	if (!match) return undefined;
	const host = match[1];
	let path: string;
	try {
		path = decodeURIComponent(match[2] ?? "/");
	} catch {
		return undefined;
	}
	if (host !== "" && host.toLowerCase() !== "localhost")
		return normalizePath(`\\\\${host}${path.replace(/\//g, "\\")}`);
	if (/^\/[A-Za-z]:/.test(path)) return normalizePath(path.slice(1));
	return normalizePath(path);
}

/** The directory part of a path, normalized. */
export function dirname(path: string): string {
	const normalized = normalizePath(path);
	const index = Math.max(normalized.lastIndexOf("/"), normalized.lastIndexOf("\\"));
	if (index < 0) return ".";
	const head = normalized.slice(0, index);
	// "C:\x" → "C:\"; "/x" → "/".
	if (head === "" || /^[A-Za-z]:$/.test(head)) return normalizePath(`${head}${normalized[index]}`);
	return head;
}

/** The last segment of a path. */
export function basename(path: string): string {
	const normalized = normalizePath(path);
	return normalized.slice(Math.max(normalized.lastIndexOf("/"), normalized.lastIndexOf("\\")) + 1);
}
