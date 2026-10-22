// Claude Code drops gitignored paths from definition, references, implementation and
// workspace-symbol results (it asks `git check-ignore`). The pure core reads the
// .gitignore files from the working directory down to each path with the kernel's
// parser instead; paths outside the working directory are kept.
import { type FileSystem, parseGitignore } from "@yophon/tau-kernel";
import { displayPath, isAbsolutePath } from "./paths.ts";

type Rules = ReturnType<typeof parseGitignore>;

export class GitignoreFilter {
	private readonly rules = new Map<string, Promise<Rules>>();
	private readonly fs: Pick<FileSystem, "readTextFile">;
	private readonly cwd: string;

	constructor(fs: Pick<FileSystem, "readTextFile">, cwd: string) {
		this.fs = fs;
		this.cwd = cwd;
	}

	async isIgnored(path: string): Promise<boolean> {
		const relative = displayPath(path, this.cwd);
		if (relative === "." || isAbsolutePath(relative) || relative.startsWith("../")) return false;
		const parts = relative.split("/");
		// Each directory on the way, then the file: an ignored directory hides everything below it.
		for (let depth = 1; depth <= parts.length; depth++) {
			const isDirectory = depth < parts.length;
			let ignored = false;
			for (let base = 0; base < depth; base++) {
				const rules = await this.rulesIn(parts.slice(0, base).join("/"));
				const local = parts.slice(base, depth).join("/");
				for (const rule of rules) {
					if (rule.directoryOnly && !isDirectory) continue;
					if (rule.matches(local)) ignored = !rule.negate;
				}
			}
			if (ignored) return true;
		}
		return false;
	}

	private rulesIn(directory: string): Promise<Rules> {
		let rules = this.rules.get(directory);
		if (!rules) {
			const file = directory === "" ? ".gitignore" : `${directory}/.gitignore`;
			rules = this.fs.readTextFile(file).then(parseGitignore, () => []);
			this.rules.set(directory, rules);
		}
		return rules;
	}
}
