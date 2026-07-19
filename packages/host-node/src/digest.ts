import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Stable sha256 digest of a directory's source files (P15 trust integrity):
 * sorted relative paths and file bytes, skipping dotfiles (editor/OS noise
 * like .DS_Store) and node_modules (dependency churn is not a trust change —
 * the loaded extension source is). Returns undefined when the directory does
 * not exist, so "no extensions dir" and "empty extensions dir" stay distinct.
 */
export async function digestDirectory(dir: string): Promise<string | undefined> {
	try {
		await readdir(dir);
	} catch {
		return undefined;
	}
	const files: string[] = [];
	const walk = async (current: string, prefix: string): Promise<void> => {
		let entries: Dirent[];
		try {
			entries = await readdir(current, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
			const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
			if (entry.isDirectory()) await walk(join(current, entry.name), relative);
			else if (entry.isFile()) files.push(relative);
		}
	};
	await walk(dir, "");
	files.sort();
	const hash = createHash("sha256");
	for (const file of files) {
		hash.update(file);
		hash.update("\0");
		try {
			hash.update(await readFile(join(dir, file)));
		} catch {
			hash.update("<unreadable>");
		}
		hash.update("\0");
	}
	return hash.digest("hex");
}
