// Every directory's saved sessions, newest first (P59: the phone's "recent sessions"). Sessions live
// in ~/.tau/sessions/<slug of the directory>/; the files are ranked by when they last changed and
// only the newest are read. Sessions kept elsewhere (settings sessionDir, --session-dir) are not
// in it.
import { readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { NodeFileSystem } from "@yophon/tau-host-node";
import { defaultPlatform, JsonlSessionRepo, type SessionMetadata } from "@yophon/tau-kernel";

export async function listAllSessions(home: string, limit: number): Promise<SessionMetadata[]> {
	const root = join(home, ".tau", "sessions");
	const files: Array<{ path: string; changed: number }> = [];
	let dirs: string[] = [];
	try {
		dirs = readdirSync(root, { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => join(root, entry.name));
	} catch {
		return [];
	}
	for (const dir of dirs) {
		let names: string[] = [];
		try {
			names = readdirSync(dir).filter((name) => name.endsWith(".jsonl"));
		} catch {
			continue;
		}
		for (const name of names) {
			try {
				files.push({ path: join(dir, name), changed: statSync(join(dir, name)).mtimeMs });
			} catch {
				// Removed while listing: not a session any more.
			}
		}
	}
	const newest = files.sort((a, b) => b.changed - a.changed).slice(0, limit);
	const wanted = new Set(newest.map((file) => file.path));
	const fs = new NodeFileSystem("/");
	const found: SessionMetadata[] = [];
	for (const dir of new Set(newest.map((file) => dirname(file.path)))) {
		const listed = await new JsonlSessionRepo(fs, defaultPlatform(), dir, dir).list();
		found.push(...listed.filter((metadata) => metadata.filePath !== undefined && wanted.has(metadata.filePath)));
	}
	return found.sort((a, b) => (b.modified ?? b.timestamp).localeCompare(a.modified ?? a.timestamp)).slice(0, limit);
}
