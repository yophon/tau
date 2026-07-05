import { appendFile, lstat, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { FileError, type FileErrorCode, type FileInfo, type FileKind, type FileSystem, toError } from "@tau/kernel";

function fileKindFromStats(stats: { isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean }): FileKind {
	if (stats.isFile()) return "file";
	if (stats.isDirectory()) return "directory";
	if (stats.isSymbolicLink()) return "symlink";
	return "other";
}

function errnoToCode(code: string | undefined): FileErrorCode {
	switch (code) {
		case "ENOENT":
			return "not_found";
		case "EACCES":
		case "EPERM":
			return "permission_denied";
		case "EISDIR":
			return "is_directory";
		case "ENOTDIR":
			return "not_directory";
		case "EINVAL":
			return "invalid";
		default:
			return "unknown";
	}
}

function toFileError(error: unknown, path: string): FileError {
	if (error instanceof FileError) return error;
	const cause = toError(error);
	const errno = error instanceof Error && "code" in error ? String((error as NodeJS.ErrnoException).code) : undefined;
	return new FileError(errnoToCode(errno), cause.message, path, cause);
}

export class NodeFileSystem implements FileSystem {
	readonly cwd: string;

	constructor(cwd: string = process.cwd()) {
		this.cwd = resolve(cwd);
	}

	private resolvePath(path: string): string {
		return isAbsolute(path) ? path : resolve(this.cwd, path);
	}

	async readTextFile(path: string): Promise<string> {
		const resolved = this.resolvePath(path);
		try {
			return await readFile(resolved, "utf8");
		} catch (error) {
			throw toFileError(error, resolved);
		}
	}

	async writeTextFile(path: string, content: string): Promise<void> {
		const resolved = this.resolvePath(path);
		try {
			await mkdir(dirname(resolved), { recursive: true });
			await writeFile(resolved, content, "utf8");
		} catch (error) {
			throw toFileError(error, resolved);
		}
	}

	async appendFile(path: string, content: string): Promise<void> {
		const resolved = this.resolvePath(path);
		try {
			await mkdir(dirname(resolved), { recursive: true });
			await appendFile(resolved, content, "utf8");
		} catch (error) {
			throw toFileError(error, resolved);
		}
	}

	async remove(path: string): Promise<void> {
		const resolved = this.resolvePath(path);
		try {
			await rm(resolved);
		} catch (error) {
			throw toFileError(error, resolved);
		}
	}

	async listDir(path: string): Promise<FileInfo[]> {
		const resolved = this.resolvePath(path);
		try {
			const entries = await readdir(resolved, { withFileTypes: true });
			const infos: FileInfo[] = [];
			for (const entry of entries) {
				const entryPath = resolve(resolved, entry.name);
				try {
					infos.push(await this.stat(entryPath));
				} catch {
					// Entry disappeared between readdir and lstat; skip it.
				}
			}
			return infos;
		} catch (error) {
			throw toFileError(error, resolved);
		}
	}

	async stat(path: string): Promise<FileInfo> {
		const resolved = this.resolvePath(path);
		try {
			const stats = await lstat(resolved);
			return {
				path: resolved,
				name: basename(resolved),
				kind: fileKindFromStats(stats),
				size: stats.size,
				mtimeMs: stats.mtimeMs,
			};
		} catch (error) {
			throw toFileError(error, resolved);
		}
	}
}
