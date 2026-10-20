/**
 * The uncommitted-changes check before switching sessions (P37b), pi's
 * examples/extensions/dirty-repo-guard.ts: `git status --porcelain`, and a question
 * with pi's wording when there are changes. Off unless settings turn it on
 * (session.dirtyRepoGuard), as pi's is an extension you install.
 */
import { execFile } from "node:child_process";

export type SwitchAction = "new session" | "switch session" | "fork";

/** Changed files in the repository at `cwd`; undefined outside a repository or when git fails. */
export function uncommittedFiles(cwd: string): Promise<number | undefined> {
	return new Promise((resolve) => {
		execFile(
			"git",
			["status", "--porcelain"],
			{ cwd, timeout: 5000, windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
			(error, stdout) => {
				if (error) {
					resolve(undefined);
					return;
				}
				resolve(stdout.split("\n").filter((line) => line.trim() !== "").length);
			},
		);
	});
}

/** pi's question and options. */
export function dirtyRepoQuestion(count: number, action: SwitchAction): { title: string; options: [string, string] } {
	const verb = action.charAt(0).toUpperCase() + action.slice(1);
	return {
		title: `You have ${count} uncommitted file(s). ${verb} anyway?`,
		options: ["Yes, proceed anyway", "No, let me commit first"],
	};
}
