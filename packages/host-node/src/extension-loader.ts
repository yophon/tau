import { readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { Extension } from "@yophon/tau-kernel";

/**
 * Load extensions from a directory of .ts/.js/.mjs modules, each default-exporting
 * an Extension setup function. This dynamic loading is a Node host convenience —
 * the kernel only ever sees the resulting Extension values, so hosts that forbid
 * dynamic code (mini-programs, React Native) pass statically imported extensions
 * instead and skip this module entirely.
 */
export async function loadExtensionsFromDir(dir: string): Promise<Extension[]> {
	const resolved = resolve(dir);
	let entries: string[];
	try {
		entries = await readdir(resolved);
	} catch {
		return [];
	}
	const extensions: Extension[] = [];
	for (const entry of entries.sort()) {
		if (!/\.(ts|js|mjs)$/.test(entry) || entry.endsWith(".d.ts")) continue;
		const path = join(resolved, entry);
		const modifiedAt = (await stat(path)).mtimeMs;
		const module = (await import(`${pathToFileURL(path).href}?mtime=${modifiedAt}`)) as { default?: unknown };
		if (typeof module.default !== "function") {
			throw new Error(`Extension ${path} must default-export a setup function`);
		}
		extensions.push(module.default as Extension);
	}
	return extensions;
}
