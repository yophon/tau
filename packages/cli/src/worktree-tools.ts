/**
 * enter_worktree and exit_worktree (P46, Claude Code's EnterWorktree / ExitWorktree): the
 * model moves the session into a git worktree and back. New worktrees are made as
 * `tau --worktree` makes them (P37d, worktree.ts). An existing worktree outside
 * <repo>/.tau/worktrees asks you first — rules do not waive it, bypass mode does; from a
 * worktree session only worktrees under that directory can be entered. Leaving keeps the
 * worktree or removes it; removing one that holds work needs discard_changes, and asks you
 * unless the session runs in bypass mode. The session records where it is (a `tau.worktree`
 * entry), so a resumed session returns there. The host moves the session (files, commands,
 * permissions, hooks and language servers at once; settings, AGENTS.md and extensions when
 * the turn ends, in the TUI).
 */
import { existsSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import type { Extension, PermissionMode, SessionEntry } from "@yophon/tau-kernel";
import { comparablePath, gitQuiet, mainCheckoutOf } from "./git-paths.ts";
import {
	openWorktree,
	removeWorktree,
	type WorktreeSession,
	type WorktreeSettings,
	worktreeState,
} from "./worktree.ts";

/** The session entry that says which worktree the session works in (path null: none). */
export const WORKTREE_ENTRY = "tau.worktree";

export interface WorktreeBinding {
	path: string | null;
	name?: string;
	branch?: string;
	mainRoot?: string;
	base?: string;
	/** tau made it (its marker is in git), as opposed to an existing worktree entered by path. */
	created?: boolean;
	/** Where the session was before it entered. */
	original?: string;
}

/** The worktree the session works in, and where it came from. */
export interface CurrentWorktree {
	session: WorktreeSession;
	original: string;
}

export interface WorktreeHost {
	cwd(): string;
	current(): CurrentWorktree | undefined;
	/** Move the session to `target`; `worktree` is the worktree it is in afterwards (undefined: none). */
	move(target: string, worktree: CurrentWorktree | undefined): Promise<void>;
	settings(): WorktreeSettings;
	permissionMode(): PermissionMode;
}

const samePath = (a: string, b: string) => comparablePath(a) === comparablePath(b);

function isUnder(path: string, dir: string): boolean {
	const rel = relative(comparablePath(dir), comparablePath(path));
	return rel !== "" && !rel.startsWith("..") && !rel.startsWith("/") && !/^[A-Za-z]:/.test(rel);
}

const worktreesDirectory = (mainRoot: string) => join(mainRoot, ".tau", "worktrees");

/** The repository's main checkout, from it or from one of its worktrees. */
function mainRootOf(cwd: string): string | undefined {
	const top = gitQuiet(cwd, ["rev-parse", "--show-toplevel"]);
	return mainCheckoutOf(cwd) ?? (top ? resolve(top) : undefined);
}

/** The worktrees git lists for the repository at `mainRoot` (the main checkout first). */
function listedWorktrees(mainRoot: string): string[] {
	const list = gitQuiet(mainRoot, ["worktree", "list", "--porcelain"]) ?? "";
	return [...list.matchAll(/^worktree (.+)$/gm)].map((match) => resolve(match[1] as string));
}

/** A binding as recorded in the session. */
function bindingOf(worktree: CurrentWorktree | undefined): WorktreeBinding {
	if (!worktree) return { path: null };
	const { session, original } = worktree;
	return {
		path: session.path,
		name: session.name,
		branch: session.branch,
		mainRoot: session.mainRoot,
		base: session.base,
		created: session.created,
		original,
	};
}

/** The last worktree binding on a session's branch, if it has one. */
function lastBinding(entries: readonly SessionEntry[]): WorktreeBinding | undefined {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index] as SessionEntry & { customType?: string; data?: unknown };
		if (entry.type === "custom" && entry.customType === WORKTREE_ENTRY) return entry.data as WorktreeBinding;
	}
	return undefined;
}

/**
 * The worktree a binding names, when it is still a worktree of its repository; else why not
 * (Claude Code resumes in the launch directory then and says the worktree is gone).
 */
function reopenBinding(binding: WorktreeBinding): CurrentWorktree | string {
	if (!binding.path || !binding.mainRoot) return "no worktree";
	if (!existsSync(binding.path)) return `the worktree ${binding.path} no longer exists`;
	if (!listedWorktrees(binding.mainRoot).some((path) => samePath(path, binding.path as string))) {
		return `${binding.path} is no longer a worktree of ${binding.mainRoot}`;
	}
	return {
		session: {
			name: binding.name ?? basename(binding.path),
			path: binding.path,
			branch: binding.branch ?? gitQuiet(binding.path, ["rev-parse", "--abbrev-ref", "HEAD"]) ?? "HEAD",
			mainRoot: binding.mainRoot,
			base: binding.base ?? gitQuiet(binding.path, ["rev-parse", "HEAD"]) ?? "",
			named: true,
			links: [],
			created: binding.created ?? false,
		},
		original: binding.original ?? binding.mainRoot,
	};
}

const ENTER_DESCRIPTION = [
	"Create an isolated git worktree and move this session into it, or pass `path` to move into an existing worktree of this repository instead.",
	"After it, every file tool, command and background task works in the worktree; project settings and AGENTS.md follow once this turn ends.",
	"New worktrees go to <repo>/.tau/worktrees/<name> on branch worktree-<name>. Entering an existing worktree outside that directory asks the user first. From inside a worktree, only `path` works, and only for worktrees under that directory.",
	"Use exit_worktree to go back.",
].join("\n");

const EXIT_DESCRIPTION = [
	"Leave the current worktree and return the session to the directory it came from.",
	'action "keep" leaves the worktree and its branch on disk; "remove" deletes both. Removing a worktree with uncommitted changes or new commits needs discard_changes: true (and the user\'s approval), which throws that work away.',
].join("\n");

export function createWorktreeToolsExtension(host: WorktreeHost): Extension {
	return (api) => {
		const fail = (text: string) => ({ content: [{ type: "text" as const, text }], isError: true });
		/** Where the session works now, recorded so a resumed session returns there. */
		const record = (worktree: CurrentWorktree | undefined): void => {
			try {
				api.appendEntry(WORKTREE_ENTRY, bindingOf(worktree));
			} catch {
				// A host without a session log: nothing to resume.
			}
		};
		const move = async (target: string, worktree: CurrentWorktree | undefined): Promise<void> => {
			await host.move(target, worktree);
			record(worktree);
		};

		// Claude Code: a session resumed after it ended inside a worktree goes back into it; a
		// worktree that is gone leaves it in the launch directory, with a word about why.
		api.on("session_start", async (event, ctx) => {
			if (event.reason === "reload") return;
			const binding = lastBinding(ctx.sessionManager?.getBranch() ?? []);
			if (!binding?.path) return;
			const now = host.current();
			if (now && samePath(now.session.path, binding.path)) return;
			const tell = (text: string) => (ctx.ui ? ctx.ui.notify(text, "info") : process.stderr.write(`${text}\n`));
			const reopened = reopenBinding(binding);
			if (typeof reopened === "string") {
				tell(`Not back in the worktree: ${reopened}. The session works in ${host.cwd()}.`);
				return;
			}
			await host.move(reopened.session.path, reopened);
			tell(`Back in worktree ${reopened.session.name} (${reopened.session.path}).`);
		});

		api.registerTool(
			{
				name: "enter_worktree",
				description: ENTER_DESCRIPTION,
				promptSnippet: "Move the session into a git worktree",
				parameters: {
					type: "object",
					properties: {
						name: {
							type: "string",
							description: "Name of a new worktree (generated when neither name nor path is given)",
						},
						path: { type: "string", description: "Path of an existing worktree to move into instead" },
					},
				},
				execute: async (args, _signal, _onUpdate, ctx) => {
					const name = typeof args.name === "string" && args.name.trim() !== "" ? args.name.trim() : undefined;
					const path = typeof args.path === "string" && args.path.trim() !== "" ? args.path.trim() : undefined;
					if (name && path) return fail("Give name or path, not both.");
					const now = host.current();
					const mainRoot = now?.session.mainRoot ?? mainRootOf(host.cwd());
					if (!mainRoot) return fail("enter_worktree needs a git repository.");
					const original = now?.original ?? host.cwd();
					if (path === undefined) {
						if (now) {
							return fail(
								`The session is already in worktree ${now.session.name}; pass the path of another worktree under ${worktreesDirectory(mainRoot)} to switch to it.`,
							);
						}
						let session: WorktreeSession;
						try {
							session = openWorktree({ cwd: mainRoot, ...(name ? { name } : {}), settings: host.settings() });
						} catch (error) {
							return fail(`Could not create the worktree: ${error instanceof Error ? error.message : String(error)}`);
						}
						await move(session.path, { session, original });
						return {
							content: [
								{
									type: "text",
									text: `${session.created ? "Created" : "Opened"} worktree ${session.name} on branch ${session.branch} at ${session.path}. The session now works there.`,
								},
							],
							details: { worktreePath: session.path, worktreeBranch: session.branch },
						};
					}
					const target = resolve(host.cwd(), path);
					if (!listedWorktrees(mainRoot).some((listed) => samePath(listed, target))) {
						return fail(`${target} is not a worktree of ${mainRoot} (see git worktree list).`);
					}
					if (samePath(target, mainRoot)) return fail("That is the main checkout; use exit_worktree to go back to it.");
					if (now && samePath(target, now.session.path)) return fail(`The session is already in ${target}.`);
					const inside = isUnder(target, worktreesDirectory(mainRoot));
					if (now && !inside) {
						return fail(`From a worktree only worktrees under ${worktreesDirectory(mainRoot)} can be entered.`);
					}
					if (!inside && host.permissionMode() !== "bypass") {
						// Claude Code: a rule or "don't ask again" never waives this; only bypass mode does.
						if (!ctx?.ui) return fail(`Entering ${target} needs the user's approval, and no one can be asked here.`);
						const yes = await ctx.ui.confirm(
							`Enter the worktree at ${target}?`,
							"The session's working directory, write access and project settings move there.",
						);
						if (!yes) return fail(`The user did not let the session enter ${target}.`);
					}
					let session: WorktreeSession;
					if (inside) {
						try {
							session = openWorktree({ cwd: mainRoot, name: basename(target), settings: host.settings() });
						} catch (error) {
							return fail(`Could not open the worktree: ${error instanceof Error ? error.message : String(error)}`);
						}
					} else {
						const reopened = reopenBinding({ path: target, mainRoot, name: basename(target) });
						if (typeof reopened === "string") return fail(`Could not enter ${target}: ${reopened}.`);
						session = reopened.session;
					}
					await move(session.path, { session, original });
					return {
						content: [
							{
								type: "text",
								text: `Entered worktree ${session.name} on branch ${session.branch} at ${session.path}. The session now works there.`,
							},
						],
						details: { worktreePath: session.path, worktreeBranch: session.branch },
					};
				},
			},
			{ risk: "low" },
		);

		api.registerTool(
			{
				name: "exit_worktree",
				description: EXIT_DESCRIPTION,
				promptSnippet: "Leave the worktree, keeping or removing it",
				parameters: {
					type: "object",
					properties: {
						action: {
							type: "string",
							enum: ["keep", "remove"],
							description: "Keep the worktree and its branch, or remove both",
						},
						discard_changes: {
							type: "boolean",
							description: "Required to remove a worktree that has uncommitted changes or new commits",
						},
					},
					required: ["action"],
				},
				execute: async (args) => {
					const action = args.action;
					if (action !== "keep" && action !== "remove") return fail('action must be "keep" or "remove".');
					const now = host.current();
					if (!now) return fail("The session is not in a worktree.");
					const { session, original } = now;
					const state = worktreeState(session);
					const holdsWork = state.unknown !== undefined || state.changedFiles > 0 || state.newCommits > 0;
					if (action === "remove" && holdsWork && args.discard_changes !== true) {
						const what = state.unknown
							? `its ${state.unknown} could not be checked`
							: `it has ${state.changedFiles} changed file${state.changedFiles === 1 ? "" : "s"} and ${state.newCommits} new commit${state.newCommits === 1 ? "" : "s"}`;
						return fail(
							`Not removed: ${what}. Use action "keep", or pass discard_changes: true to throw that work away.`,
						);
					}
					// Out of the directory first: Windows will not remove the directory a process stands in.
					await move(original, undefined);
					let message: string;
					if (action === "remove") {
						try {
							removeWorktree(session);
						} catch (error) {
							return fail(
								`Back in ${original}, but the worktree could not be removed: ${error instanceof Error ? error.message : String(error)}`,
							);
						}
						message = `Removed worktree ${session.name} and branch ${session.branch}${holdsWork ? `, discarding ${state.changedFiles} changed file(s) and ${state.newCommits} commit(s)` : ""}. The session is back in ${original}.`;
					} else {
						message = `Kept worktree ${session.name} (branch ${session.branch}) at ${session.path}. The session is back in ${original}.`;
					}
					return {
						content: [{ type: "text", text: message }],
						details: {
							action,
							originalCwd: original,
							worktreePath: session.path,
							worktreeBranch: session.branch,
							...(action === "remove" && holdsWork
								? { discardedFiles: state.changedFiles, discardedCommits: state.newCommits }
								: {}),
						},
					};
				},
			},
			{ risk: "low" },
		);

		// Removing a worktree that holds work throws it away: the user decides (not in bypass mode).
		api.on("tool_call", (event) => {
			if (event.toolName !== "exit_worktree") return undefined;
			if (event.input.action !== "remove" || event.input.discard_changes !== true) return undefined;
			return host.permissionMode() === "bypass" ? undefined : { permission: "ask" as const };
		});
	};
}
