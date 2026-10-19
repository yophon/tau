/**
 * Reading the clipboard for the paste key (P36b), after pi's handleClipboardPaste
 * and clipboard-image.ts: copied files first, then an image, then text. Linux and
 * WSL as pi does (wl-paste / xclip, PowerShell for Windows screenshots in WSL);
 * pi's native module for Windows and macOS is replaced by PowerShell (the same
 * script pi runs from WSL) and osascript, since tau ships no native code.
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** What a paste key finds on the clipboard. */
export type ClipboardContent =
	| { kind: "files"; paths: string[] }
	| { kind: "image"; bytes: Uint8Array; mimeType: string }
	| { kind: "text"; text: string };

/** Runs a program; undefined when it is missing, fails or times out (pi runClipboardCommand). */
export type ClipboardCommand = (
	command: string,
	args: string[],
	options?: { timeoutMs?: number },
) => Promise<Buffer | undefined>;

/** pi's timeouts: listing types 1 s, PowerShell 5 s. */
const LIST_TIMEOUT_MS = 1000;
const POWERSHELL_TIMEOUT_MS = 5000;
const READ_TIMEOUT_MS = 3000;

export const runClipboardCommand: ClipboardCommand = (command, args, options = {}) =>
	new Promise((resolve) => {
		let child: ReturnType<typeof spawn>;
		try {
			child = spawn(command, args, { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
		} catch {
			resolve(undefined);
			return;
		}
		const chunks: Buffer[] = [];
		const timer = setTimeout(() => child.kill(), options.timeoutMs ?? READ_TIMEOUT_MS);
		child.stdout?.on("data", (chunk: Buffer) => chunks.push(chunk));
		child.on("error", () => {
			clearTimeout(timer);
			resolve(undefined);
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			resolve(code === 0 ? Buffer.concat(chunks) : undefined);
		});
	});

/** pi's preference among the image types a Linux clipboard offers. */
const IMAGE_PREFERENCE = ["image/png", "image/jpeg", "image/webp", "image/gif"];

function baseType(type: string): string {
	return type.split(";")[0]?.trim().toLowerCase() ?? type.toLowerCase();
}

function preferredImageType(types: string[]): string | undefined {
	for (const wanted of IMAGE_PREFERENCE) {
		const match = types.find((type) => baseType(type) === wanted);
		if (match) return match;
	}
	return types.find((type) => baseType(type).startsWith("image/"));
}

/** The `file://` lines of a text/uri-list, as paths. */
export function uriListPaths(list: string): string[] {
	return list
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line.startsWith("file://"))
		.map((line) => {
			try {
				return decodeURIComponent(new URL(line).pathname);
			} catch {
				return "";
			}
		})
		.filter((path) => path !== "");
}

/**
 * One PowerShell run for Windows and WSL: the copied files, else the image saved as
 * PNG at `imagePath` (pi's WSL script), else the text. Values travel as base64 so
 * no console code page gets in the way. A clipboard that cannot be opened (another
 * program holds it, or the process may not read it) comes back as an ERROR line.
 */
export function windowsClipboardScript(imagePath: string): string {
	const path = imagePath.replaceAll("'", "''");
	return [
		"Add-Type -AssemblyName System.Windows.Forms",
		"Add-Type -AssemblyName System.Drawing",
		"function Enc($s) { [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($s)) }",
		"try {",
		"$files = [System.Windows.Forms.Clipboard]::GetFileDropList()",
		"if ($files -and $files.Count -gt 0) { foreach ($f in $files) { 'FILE ' + (Enc $f) }; exit }",
		"$img = [System.Windows.Forms.Clipboard]::GetImage()",
		`if ($img) { $img.Save('${path}', [System.Drawing.Imaging.ImageFormat]::Png); 'IMAGE'; exit }`,
		"if ([System.Windows.Forms.Clipboard]::ContainsText()) { 'TEXT ' + (Enc ([System.Windows.Forms.Clipboard]::GetText())) }",
		"} catch { $e = $_.Exception; if ($e.InnerException) { $e = $e.InnerException }; 'ERROR ' + $e.Message }",
	].join("\n");
}

/** The script's output as clipboard content; the image is read from the file it saved. */
export function parseWindowsClipboard(
	output: string,
	readImage: () => Uint8Array | undefined,
): ClipboardContent | undefined {
	const lines = output.split(/\r?\n/).filter((line) => line !== "");
	const decode = (value: string): string => Buffer.from(value, "base64").toString("utf8");
	const error = lines.find((line) => line.startsWith("ERROR "));
	if (error) throw new Error(error.slice(6));
	const files = lines.filter((line) => line.startsWith("FILE ")).map((line) => decode(line.slice(5)));
	if (files.length > 0) return { kind: "files", paths: files };
	const image = lines.find((line) => line === "IMAGE" || line.startsWith("IMAGE "));
	if (image) {
		const bytes = readImage();
		const mimeType = image.slice(6) || "image/png";
		return bytes && bytes.length > 0 ? { kind: "image", bytes, mimeType } : undefined;
	}
	const text = lines.find((line) => line.startsWith("TEXT "));
	return text ? { kind: "text", text: decode(text.slice(5)) } : undefined;
}

export interface ReadClipboardOptions {
	platform?: NodeJS.Platform;
	env?: Record<string, string | undefined>;
	run?: ClipboardCommand;
	/** A fresh temporary file path (the PNG PowerShell or osascript writes). */
	tempPath?: () => string;
	readFile?: (path: string) => Uint8Array | undefined;
	removeFile?: (path: string) => void;
}

type Resolved = Required<ReadClipboardOptions>;

async function readViaPowerShell(options: Resolved, wsl: boolean): Promise<ClipboardContent | undefined> {
	const temp = options.tempPath();
	let target = temp;
	if (wsl) {
		const converted = await options.run("wslpath", ["-w", temp], { timeoutMs: LIST_TIMEOUT_MS });
		if (!converted) return undefined;
		target = converted.toString("utf8").trim();
	}
	const encoded = Buffer.from(windowsClipboardScript(target), "utf16le").toString("base64");
	const output = await options.run(
		"powershell.exe",
		["-NoProfile", "-NonInteractive", "-STA", "-EncodedCommand", encoded],
		{ timeoutMs: POWERSHELL_TIMEOUT_MS },
	);
	try {
		if (!output) return undefined;
		const content = parseWindowsClipboard(output.toString("utf8"), () => options.readFile(temp));
		if (content?.kind === "files" && wsl) {
			const paths: string[] = [];
			for (const path of content.paths) {
				const unix = await options.run("wslpath", ["-u", path], { timeoutMs: LIST_TIMEOUT_MS });
				paths.push(unix ? unix.toString("utf8").trim() : path);
			}
			return { kind: "files", paths };
		}
		return content;
	} finally {
		options.removeFile(temp);
	}
}

/** Wayland (wl-paste) or X11 (xclip). undefined: the tool is missing; null: the clipboard is empty. */
async function readViaLinux(options: Resolved, wayland: boolean): Promise<ClipboardContent | null | undefined> {
	const list = wayland
		? await options.run("wl-paste", ["--list-types"], { timeoutMs: LIST_TIMEOUT_MS })
		: await options.run("xclip", ["-selection", "clipboard", "-t", "TARGETS", "-o"], { timeoutMs: LIST_TIMEOUT_MS });
	if (!list) return undefined;
	const types = list
		.toString("utf8")
		.split(/\r?\n/)
		.map((type) => type.trim())
		.filter(Boolean);
	const read = (type: string | undefined) =>
		wayland
			? options.run("wl-paste", [...(type ? ["--type", type] : []), "--no-newline"])
			: options.run("xclip", ["-selection", "clipboard", ...(type ? ["-t", type] : []), "-o"]);
	if (types.includes("text/uri-list")) {
		const uris = await read("text/uri-list");
		const paths = uris ? uriListPaths(uris.toString("utf8")) : [];
		if (paths.length > 0) return { kind: "files", paths };
	}
	const imageType = preferredImageType(types);
	if (imageType) {
		const bytes = await read(imageType);
		if (bytes && bytes.length > 0)
			return { kind: "image", bytes: new Uint8Array(bytes), mimeType: baseType(imageType) };
	}
	if (types.length === 0) return null;
	const text = await read(undefined);
	return text && text.length > 0 ? { kind: "text", text: text.toString("utf8") } : null;
}

async function readViaMac(options: Resolved): Promise<ClipboardContent | undefined> {
	const file = await options.run("osascript", ["-e", "POSIX path of (the clipboard as «class furl»)"]);
	const path = file?.toString("utf8").trim();
	if (path) return { kind: "files", paths: [path] };
	const temp = options.tempPath();
	const quoted = temp.replaceAll('"', '\\"');
	const saved = await options.run("osascript", [
		"-e",
		`set f to open for access POSIX file "${quoted}" with write permission`,
		"-e",
		"write (the clipboard as «class PNGf») to f",
		"-e",
		"close access f",
	]);
	const bytes = saved ? options.readFile(temp) : undefined;
	options.removeFile(temp);
	if (bytes && bytes.length > 0) return { kind: "image", bytes, mimeType: "image/png" };
	const text = await options.run("pbpaste", []);
	return text && text.length > 0 ? { kind: "text", text: text.toString("utf8") } : undefined;
}

/** What is on the clipboard: copied files first, then an image, then text (pi). */
export async function readClipboard(options: ReadClipboardOptions = {}): Promise<ClipboardContent | undefined> {
	const resolved: Resolved = {
		platform: options.platform ?? process.platform,
		env: options.env ?? process.env,
		run: options.run ?? runClipboardCommand,
		tempPath: options.tempPath ?? (() => join(tmpdir(), `tau-clip-${randomUUID()}.png`)),
		readFile:
			options.readFile ??
			((path) => {
				try {
					return new Uint8Array(readFileSync(path));
				} catch {
					return undefined;
				}
			}),
		removeFile:
			options.removeFile ??
			((path) => {
				try {
					unlinkSync(path);
				} catch {
					// Never written, or already gone.
				}
			}),
	};
	const env = resolved.env;
	if (env.TERMUX_VERSION) return undefined;
	if (resolved.platform === "win32") return readViaPowerShell(resolved, false);
	if (resolved.platform === "darwin") return readViaMac(resolved);
	const wsl = Boolean(env.WSL_DISTRO_NAME || env.WSL_INTEROP);
	const wayland = Boolean(env.WAYLAND_DISPLAY) || env.XDG_SESSION_TYPE === "wayland";
	let content: ClipboardContent | null | undefined;
	if (wayland || wsl) content = await readViaLinux(resolved, true);
	if (content === undefined) content = await readViaLinux(resolved, false);
	// WSL: Windows screenshots and copied files never reach the Linux clipboard (pi).
	if (wsl && (!content || content.kind === "text")) {
		const windows = await readViaPowerShell(resolved, true);
		if (windows && (windows.kind !== "text" || !content)) return windows;
	}
	return content ?? undefined;
}

/** File name extension for a pasted image's type (pi extensionForImageMimeType). */
export function imageExtension(mimeType: string): string {
	switch (baseType(mimeType)) {
		case "image/jpeg":
			return "jpg";
		case "image/webp":
			return "webp";
		case "image/gif":
			return "gif";
		default:
			return "png";
	}
}

/** Quote a path for a `!` shell command when it needs it (pi quoteIfNeeded, verbatim). */
export function quoteIfNeeded(value: string): string {
	if (value.length > 0 && !/[^a-zA-Z0-9_\-./~:@]/.test(value)) return value;
	return `'${value.replace(/'/g, `'\\''`)}'`;
}
