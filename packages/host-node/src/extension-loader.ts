import { readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { Extension, InlineExtension } from "@yophon/tau-kernel";

const EXTENSION_FILE = /\.(ts|js|mjs)$/;

/**
 * List the extension module files in a directory without importing any of them.
 * Only regular files (or symlinks to regular files) named `*.ts|*.js|*.mjs`
 * count; `.d.ts` and directories that happen to match the pattern (`three.js/`)
 * are skipped. Hosts call this before a trust decision: listing must never
 * execute project code.
 */
export async function listExtensionFiles(dir: string): Promise<string[]> {
	const resolved = resolve(dir);
	let entries: { name: string; isFile(): boolean; isSymbolicLink(): boolean }[];
	try {
		entries = await readdir(resolved, { withFileTypes: true });
	} catch {
		return [];
	}
	const files: string[] = [];
	for (const entry of [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
		if (!EXTENSION_FILE.test(entry.name) || entry.name.endsWith(".d.ts")) continue;
		const path = join(resolved, entry.name);
		if (entry.isFile()) {
			files.push(path);
			continue;
		}
		if (entry.isSymbolicLink()) {
			try {
				if ((await stat(path)).isFile()) files.push(path);
			} catch {
				// Dangling symlink: not an extension.
			}
		}
	}
	return files;
}

/**
 * Import already-listed extension files, each named by its path (P23c). Each must
 * default-export an Extension setup function. A module that fails to import or
 * exports something else becomes an extension whose setup throws, so the
 * registry reports it as a load error and loads the rest (pi).
 */
export async function importExtensionFiles(files: string[]): Promise<InlineExtension[]> {
	const extensions: InlineExtension[] = [];
	for (const path of files) {
		try {
			const modifiedAt = (await stat(path)).mtimeMs;
			const module = (await import(`${pathToFileURL(path).href}?mtime=${modifiedAt}`)) as { default?: unknown };
			if (typeof module.default !== "function") {
				throw new Error(`Extension ${path} must default-export a setup function`);
			}
			extensions.push({ name: path, factory: module.default as Extension });
		} catch (error) {
			extensions.push({
				name: path,
				factory: () => {
					throw error;
				},
			});
		}
	}
	return extensions;
}

/**
 * Load extensions from a directory of .ts/.js/.mjs modules, each default-exporting
 * an Extension setup function. This dynamic loading is a Node host convenience —
 * the kernel only ever sees the resulting Extension values, so hosts that forbid
 * dynamic code (mini-programs, React Native) pass statically imported extensions
 * instead and skip this module entirely.
 *
 * Importing runs the modules' top-level code. For directories that need a trust
 * decision first, call {@link listExtensionFiles}, decide, then {@link importExtensionFiles}.
 */
export async function loadExtensionsFromDir(dir: string): Promise<InlineExtension[]> {
	return importExtensionFiles(await listExtensionFiles(dir));
}
