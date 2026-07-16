import { FileError, type FileInfo, type FileSystem } from "@yophon/tau-kernel";
import { normalizeBrowserPath, pathName, splitPath } from "./path.ts";

interface BrowserFileLike {
	readonly size: number;
	readonly lastModified: number;
	text(): Promise<string>;
}

interface BrowserWritableFileStreamLike {
	write(data: string): Promise<void>;
	close(): Promise<void>;
}

interface BrowserFileHandleLike {
	readonly kind: "file";
	readonly name: string;
	getFile(): Promise<BrowserFileLike>;
	createWritable(): Promise<BrowserWritableFileStreamLike>;
}

interface BrowserDirectoryHandleLike {
	readonly kind: "directory";
	readonly name: string;
	getFileHandle(name: string, options?: { create?: boolean }): Promise<BrowserFileHandleLike>;
	getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<BrowserDirectoryHandleLike>;
	removeEntry(name: string, options?: { recursive?: boolean }): Promise<void>;
	values(): AsyncIterable<BrowserFileHandleLike | BrowserDirectoryHandleLike>;
}

export interface BrowserStorageLike {
	getDirectory?: () => Promise<BrowserDirectoryHandleLike>;
}

function browserStorage(): BrowserStorageLike | undefined {
	return globalThis.navigator?.storage as unknown as BrowserStorageLike | undefined;
}

export function hasOpfsSupport(storage: BrowserStorageLike | undefined = browserStorage()): boolean {
	return typeof storage?.getDirectory === "function";
}

function toFileError(error: unknown, path: string): FileError {
	if (error instanceof FileError) return error;
	const name = error instanceof Error ? error.name : "";
	const message = error instanceof Error ? error.message : String(error);
	if (name === "NotFoundError")
		return new FileError("not_found", message, path, error instanceof Error ? error : undefined);
	if (name === "TypeMismatchError") {
		return new FileError("not_directory", message, path, error instanceof Error ? error : undefined);
	}
	if (name === "NotAllowedError" || name === "SecurityError") {
		return new FileError("permission_denied", message, path, error instanceof Error ? error : undefined);
	}
	return new FileError("unknown", message, path, error instanceof Error ? error : undefined);
}

export class OpfsFileSystem implements FileSystem {
	readonly cwd: string;
	private readonly storage: BrowserStorageLike;

	constructor(options?: { cwd?: string; storage?: BrowserStorageLike }) {
		this.cwd = normalizeBrowserPath("/", options?.cwd ?? "/");
		const storage = options?.storage ?? browserStorage();
		if (!storage) throw new FileError("not_found", "Origin Private File System is not available", this.cwd);
		this.storage = storage;
		if (!hasOpfsSupport(this.storage)) {
			throw new FileError("not_found", "Origin Private File System is not available", this.cwd);
		}
	}

	private resolvePath(path: string): string {
		return normalizeBrowserPath(this.cwd, path);
	}

	private async root(): Promise<BrowserDirectoryHandleLike> {
		if (!this.storage.getDirectory) {
			throw new FileError("not_found", "Origin Private File System is not available", this.cwd);
		}
		return this.storage.getDirectory();
	}

	private async directoryFor(path: string, create: boolean): Promise<BrowserDirectoryHandleLike> {
		let current = await this.root();
		for (const part of splitPath(path)) {
			try {
				current = await current.getDirectoryHandle(part, { create });
			} catch (error) {
				throw toFileError(error, path);
			}
		}
		return current;
	}

	private async fileFor(path: string, create: boolean): Promise<BrowserFileHandleLike> {
		const parts = splitPath(path);
		const name = parts.at(-1);
		if (!name) throw new FileError("is_directory", "Root is a directory", path);
		const parent = await this.directoryFor(`/${parts.slice(0, -1).join("/")}`, create);
		try {
			return await parent.getFileHandle(name, { create });
		} catch (error) {
			throw toFileError(error, path);
		}
	}

	async readTextFile(path: string): Promise<string> {
		const resolved = this.resolvePath(path);
		const file = await this.fileFor(resolved, false);
		try {
			return await (await file.getFile()).text();
		} catch (error) {
			throw toFileError(error, resolved);
		}
	}

	async writeTextFile(path: string, content: string): Promise<void> {
		const resolved = this.resolvePath(path);
		const file = await this.fileFor(resolved, true);
		try {
			const writable = await file.createWritable();
			await writable.write(content);
			await writable.close();
		} catch (error) {
			throw toFileError(error, resolved);
		}
	}

	async appendFile(path: string, content: string): Promise<void> {
		const resolved = this.resolvePath(path);
		let previous = "";
		try {
			previous = await this.readTextFile(resolved);
		} catch (error) {
			if (!(error instanceof FileError) || error.code !== "not_found") throw error;
		}
		await this.writeTextFile(resolved, `${previous}${content}`);
	}

	async listDir(path: string): Promise<FileInfo[]> {
		const resolved = this.resolvePath(path);
		const directory = await this.directoryFor(resolved, false);
		const infos: FileInfo[] = [];
		for await (const handle of directory.values()) {
			const childPath = `${resolved === "/" ? "" : resolved}/${handle.name}`;
			infos.push(await this.infoForHandle(childPath, handle));
		}
		return infos.sort((a, b) => a.name.localeCompare(b.name));
	}

	async stat(path: string): Promise<FileInfo> {
		const resolved = this.resolvePath(path);
		if (resolved === "/") {
			return { path: "/", name: "", kind: "directory", size: 0, mtimeMs: 0 };
		}
		const parts = splitPath(resolved);
		const name = parts.at(-1);
		if (!name) throw new FileError("invalid", `Invalid path: ${resolved}`, resolved);
		const parent = await this.directoryFor(`/${parts.slice(0, -1).join("/")}`, false);
		try {
			const file = await parent.getFileHandle(name);
			return this.infoForHandle(resolved, file);
		} catch (fileError) {
			try {
				const directory = await parent.getDirectoryHandle(name);
				return this.infoForHandle(resolved, directory);
			} catch {
				throw toFileError(fileError, resolved);
			}
		}
	}

	async remove(path: string): Promise<void> {
		const resolved = this.resolvePath(path);
		if (resolved === "/") throw new FileError("invalid", "Cannot remove root", resolved);
		const parts = splitPath(resolved);
		const name = parts.at(-1);
		if (!name) throw new FileError("invalid", `Invalid path: ${resolved}`, resolved);
		const parent = await this.directoryFor(`/${parts.slice(0, -1).join("/")}`, false);
		try {
			await parent.removeEntry(name, { recursive: true });
		} catch (error) {
			throw toFileError(error, resolved);
		}
	}

	private async infoForHandle(
		path: string,
		handle: BrowserFileHandleLike | BrowserDirectoryHandleLike,
	): Promise<FileInfo> {
		if (handle.kind === "directory") return { path, name: pathName(path), kind: "directory", size: 0, mtimeMs: 0 };
		const file = await handle.getFile();
		return { path, name: pathName(path), kind: "file", size: file.size, mtimeMs: file.lastModified };
	}
}
