import type { UserContent } from "@yophon/tau-kernel";
import type { TauSettings } from "../settings.ts";
import type { StatusLineFacts } from "../statusline-input.ts";
import type { ClipboardContent } from "./clipboard-read.ts";
import type { TuiSession } from "./session-client.ts";

export type ApprovalAnswer = "once" | "always" | "deny";

/**
 * What main.ts hands the TUI. P57: the session lives in the hub and the TUI reaches it through
 * `session` (the protocol); what is here is the terminal's own (keys, screen, settings it writes).
 */
export interface RunTuiOptions {
	/** The session to show, already joined (main.ts starts or resumes it). */
	session: TuiSession;
	/** P36c: prompts from the command line (`tau @shot.png "why"`), run one after another at start. */
	initialPrompts?: UserContent[];
	/** P53a (-r/--resume, pi): open /resume's picker at start; command-line prompts go to the session picked. */
	openResumePicker?: boolean;
	/** P58: lines to show at start (why not the resident server, that it was started, versions). */
	startupNotices?: string[];
	/** Where tau started; the TUI follows the session when it moves (a worktree, P46). */
	cwd: string;
	/** Hints per `provider/id` for the /model picker (P28 model table). */
	modelHints?: Record<string, string>;
	/** Desktop notifications while the window is in the background (P34e; tui.notify); default "auto". */
	notify?: "auto" | "off";
	/** Spinner in the terminal title and tab progress (P34e; tui.title); default true. */
	terminalTitle?: boolean;
	/** /settings → Screen: save tui.mode in settings.json for the next start (P33). */
	saveTuiMode?(mode: "fullscreen" | "inline"): void;
	/** Ctrl+S in the /model picker: save `provider/id` as the default in settings.json. */
	saveDefaultModel?(ref: string): boolean;
	/** Save a trust decision for this project's resources (/trust); returns the resources it covers. */
	saveTrust?(trusted: boolean): Promise<string[]>;
	/** P39e: ~/.tau/keybindings.json (pi), read at start and on /reload; absent = the default keys. */
	keybindingsPath?: string;
	/** P40c: settings in force (treeFilterMode, branchSummary.skipPrompt, externalEditor), read again after /reload. */
	settings?: () => Pick<TauSettings, "treeFilterMode" | "branchSummary" | "externalEditor">;
	/** P33: the alternate screen with tau's own transcript view (default), or the inline view in the main screen. */
	screen?: "fullscreen" | "inline";
	/** P37b: ask before switching sessions with uncommitted changes (session.dirtyRepoGuard). */
	dirtyRepoGuard?: boolean;
	/** P38b: reasoning shown in full instead of one "Thought for Ns" row (tui.showReasoning; default off). */
	showReasoning?: boolean;
	/** P37b: Esc twice on an empty input (pi doubleEscapeAction; default "tree"). */
	doubleEscapeAction?: "tree" | "fork" | "none";
	/** P37b: save a /settings choice (section.key in ~/.tau/settings.json). */
	saveSetting?(section: "tui" | "session", key: string, value: unknown): void;
	/** P37c: the custom status line runner (Claude Code statusLine), given where its lines go. */
	statusLine?: (onLines: (lines: string[] | undefined, padding: number) => void) => {
		trigger(input: () => unknown): void;
		stop(): void;
	};
	/** P37c: what the status line JSON says that the TUI does not know itself. */
	statusLineContext?: () => Partial<
		Pick<StatusLineFacts, "projectDir" | "addedDirs" | "provider" | "version" | "worktree">
	>;
}

/** Test seams; the real TUI uses the defaults. */
export interface TuiDeps {
	/** ~/.tau/history.jsonl; undefined keeps history in memory. */
	historyFile?: string;
	fileLister?: (cwd: string) => Promise<string[]>;
	columns?: () => number;
	now?: () => number;
	/** P37b: changed files in the repository (git status --porcelain); undefined outside one. */
	uncommittedFiles?: (cwd: string) => Promise<number | undefined>;
	/** Ctrl+G: edit text in an external editor; undefined keeps the input. */
	editText?: (text: string) => string | undefined;
	/** /copy: put text on the clipboard; returns how. */
	copy?: (text: string) => Promise<string>;
	/** Clear the screen and scrollback (/clear, session switches). */
	clearScreen?: () => void;
	/** Git branch for the status line. */
	readBranch?: (cwd: string) => string | undefined;
	/** A desktop notification (P34e); defaults to notifyDesktop. */
	notify?: (heading: string, body: string) => void;
	/** The paste key (P36b); defaults to readClipboard. */
	readClipboard?: () => Promise<ClipboardContent | undefined>;
	/** Where a pasted image is saved; defaults to the system temp directory. */
	saveImage?: (bytes: Uint8Array, extension: string) => string;
	/** process.platform for key bindings (Ctrl+Z undoes on Windows, suspends elsewhere). */
	platform?: string;
	/** Run something that takes the terminal (an external editor): the TUI leaves the screen and comes back after (pi). */
	handOverScreen?: <T>(run: () => T) => T;
	/** Ctrl+Z outside Windows: suspend to the shell, come back on SIGCONT. */
	suspend?: () => void;
	/** A click on a link (P38b); defaults to the system browser. */
	openUrl?: (url: string) => void;
	/** Tab path completion: a directory's entries, directories ending in "/". */
	listDirectory?: (dir: string) => string[];
}
