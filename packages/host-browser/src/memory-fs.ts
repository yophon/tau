import { FileError, type FileErrorCode, type FileInfo, type FileKind, type FileSystem } from "@yophon/tau-kernel";
import { normalizeBrowserPath, parentPath, pathName, splitPath } from "./path.ts";

interface MemoryNodeBase {
	kind: FileKind;
	mtimeMs: number;
}

interface MemoryFileNode extends MemoryNodeBase {
	kind: "file";
	content: string;
}

interface MemoryDirectoryNode extends MemoryNodeBase {
	kind: "directory";
	children: Map<string, MemoryNode>;
}

type MemoryNode = MemoryFileNode | MemoryDirectoryNode;

function now(): number {
	return Date.now();
}

function createDirectory(): MemoryDirectoryNode {
	return { kind: "directory", mtimeMs: now(), children: new Map() };
}

function codeForMissingParent(parent: MemoryNode | undefined): FileErrorCode {
	return parent ? "not_directory" : "not_found";
}

export class BrowserMemoryFileSystem implements FileSystem {
	readonly cwd: string;
	private readonly root = createDirectory();

	constructor(cwd = "/") {
		this.cwd = normalizeBrowserPath("/", cwd);
		this.ensureDirectory(this.cwd);
	}

	private resolvePath(path: string): string {
		return normalizeBrowserPath(this.cwd, path);
	}

	private getNode(path: string): MemoryNode | undefined {
		if (path === "/") return this.root;
		let node: MemoryNode = this.root;
		for (const part of splitPath(path)) {
			if (node.kind !== "directory") return undefined;
			const child = node.children.get(part);
			if (!child) return undefined;
			node = child;
		}
		return node;
	}

	private ensureDirectory(path: string): MemoryDirectoryNode {
		let node = this.root;
		for (const part of splitPath(path)) {
			const child = node.children.get(part);
			if (!child) {
				const directory = createDirectory();
				node.children.set(part, directory);
				node.mtimeMs = now();
				node = directory;
				continue;
			}
			if (child.kind !== "directory") throw new FileError("not_directory", `${path} is not a directory`, path);
			node = child;
		}
		return node;
	}

	private parentDirectory(path: string, create: boolean): MemoryDirectoryNode {
		const parent = parentPath(path);
		if (create) return this.ensureDirectory(parent);
		const node = this.getNode(parent);
		if (!node || node.kind !== "directory") {
			throw new FileError(codeForMissingParent(node), `Parent directory not found: ${parent}`, parent);
		}
		return node;
	}

	async readTextFile(path: string): Promise<string> {
		const resolved = this.resolvePath(path);
		const node = this.getNode(resolved);
		if (!node) throw new FileError("not_found", `File not found: ${resolved}`, resolved);
		if (node.kind !== "file") throw new FileError("is_directory", `Not a file: ${resolved}`, resolved);
		return node.content;
	}

	async writeTextFile(path: string, content: string): Promise<void> {
		const resolved = this.resolvePath(path);
		if (resolved === "/") throw new FileError("is_directory", "Cannot write root as a file", resolved);
		const parent = this.parentDirectory(resolved, true);
		parent.children.set(pathName(resolved), { kind: "file", content, mtimeMs: now() });
		parent.mtimeMs = now();
	}

	async appendFile(path: string, content: string): Promise<void> {
		const resolved = this.resolvePath(path);
		const existing = this.getNode(resolved);
		if (existing && existing.kind !== "file") throw new FileError("is_directory", `Not a file: ${resolved}`, resolved);
		await this.writeTextFile(resolved, `${existing?.kind === "file" ? existing.content : ""}${content}`);
	}

	async listDir(path: string): Promise<FileInfo[]> {
		const resolved = this.resolvePath(path);
		const node = this.getNode(resolved);
		if (!node) throw new FileError("not_found", `Directory not found: ${resolved}`, resolved);
		if (node.kind !== "directory") throw new FileError("not_directory", `Not a directory: ${resolved}`, resolved);
		return [...node.children.entries()]
			.map(([name, child]) => this.infoForNode(`${resolved === "/" ? "" : resolved}/${name}`, name, child))
			.sort((a, b) => a.name.localeCompare(b.name));
	}

	async stat(path: string): Promise<FileInfo> {
		const resolved = this.resolvePath(path);
		const node = this.getNode(resolved);
		if (!node) throw new FileError("not_found", `Path not found: ${resolved}`, resolved);
		return this.infoForNode(resolved, pathName(resolved), node);
	}

	async remove(path: string): Promise<void> {
		const resolved = this.resolvePath(path);
		if (resolved === "/") throw new FileError("invalid", "Cannot remove root", resolved);
		const parent = this.parentDirectory(resolved, false);
		if (!parent.children.delete(pathName(resolved))) {
			throw new FileError("not_found", `Path not found: ${resolved}`, resolved);
		}
		parent.mtimeMs = now();
	}

	private infoForNode(path: string, name: string, node: MemoryNode): FileInfo {
		return {
			path,
			name,
			kind: node.kind,
			size: node.kind === "file" ? new TextEncoder().encode(node.content).byteLength : 0,
			mtimeMs: node.mtimeMs,
		};
	}
}
