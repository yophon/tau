import {
	type FileSystem,
	JsonlSessionRepo,
	type JsonlSessionRepo as JsonlSessionRepoType,
	type Platform,
	sessionDirSlug,
} from "@yophon/tau-kernel";

export interface BrowserSessionRepoOptions {
	fs: FileSystem;
	platform: Platform;
	rootDir?: string;
	cwd?: string;
}

export function createBrowserSessionRepo(options: BrowserSessionRepoOptions): JsonlSessionRepoType {
	const cwd = options.cwd ?? options.fs.cwd;
	const rootDir = options.rootDir ?? "/.tau/sessions";
	return new JsonlSessionRepo(options.fs, options.platform, `${rootDir}/${sessionDirSlug(cwd)}`, cwd);
}
