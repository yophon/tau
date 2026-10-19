import type {
	Agent,
	AgentMessage,
	ApprovalRequest,
	ExtensionRegistry,
	JsonlSessionRepo,
	PermissionMode,
	SessionRecorder,
	SessionStore,
	SetModelOptions,
	Shell,
	ThinkingLevel,
	UiCapability,
	UserContent,
} from "@yophon/tau-kernel";
import type { ClipboardContent } from "./clipboard-read.ts";

export type ApprovalAnswer = "once" | "always" | "deny";

/** What main.ts hands the TUI (the same shape the P8 TUI took). */
export interface RunTuiOptions {
	agent: Agent;
	/** P36c: prompts from the command line (`tau @shot.png "why"`), run one after another at start. */
	initialPrompts?: UserContent[];
	extensions: ExtensionRegistry;
	model: string;
	modelChoices?: string[];
	baseUrl: string;
	cwd: string;
	contextWindow?: number;
	permissionMode: PermissionMode;
	sessionRepo: JsonlSessionRepo;
	shell: Shell;
	store?: SessionStore;
	recorder?: SessionRecorder;
	thinkingLevel?: ThinkingLevel;
	setModel(model: string): void;
	/** Hints per `provider/id` for the /model picker (P28 model table). */
	modelHints?: Record<string, string>;
	/**
	 * Resolve a /model choice against the model table (P28): the id to request,
	 * the name to show, and what else the agent switches (transport, provider,
	 * context window); `commit` makes later agents (/reload, /resume) use it.
	 * Absent without a table: /model changes the id only.
	 */
	resolveModelSwitch?(
		requested: string,
	): { model: string; display: string; options: SetModelOptions; commit(): void } | { error: string };
	/** After the first turn the model names an unnamed session (P34f; settings session.autoTitle); default true. */
	autoTitle?: boolean;
	/** Desktop notifications while the window is in the background (P34e; tui.notify); default "auto". */
	notify?: "auto" | "off";
	/** Spinner in the terminal title and tab progress (P34e; tui.title); default true. */
	terminalTitle?: boolean;
	/** /settings → Screen: save tui.mode in settings.json for the next start (P33). */
	saveTuiMode?(mode: "fullscreen" | "inline"): void;
	/** Ctrl+S in the /model picker: save `provider/id` as the default in settings.json. */
	saveDefaultModel?(ref: string): boolean;
	setThinkingLevel(level: ThinkingLevel | undefined): void;
	/** Agents built later (/reload, /resume) use the mode Shift+Tab switched to. */
	setPermissionMode?(mode: PermissionMode): void;
	/** Save a trust decision for this project's resources (/trust); returns the resources it covers. */
	saveTrust?(trusted: boolean): Promise<string[]>;
	/** Install the TUI approval prompt into the host's approval loop (P15). */
	setApprovalPrompt?(prompt: (request: ApprovalRequest) => Promise<ApprovalAnswer>): void;
	buildAgent(
		messages: AgentMessage[] | undefined,
		session: SessionRecorder | undefined,
		extensions: ExtensionRegistry,
	): Agent;
	reloadExtensions(ui: UiCapability | undefined): Promise<ExtensionRegistry>;
	/** session_start reason; fired once the host actions are attached (P23e). */
	sessionReason: "startup" | "resume";
	/** P33: the alternate screen with tau's own transcript view (default), or the inline view in the main screen. */
	screen?: "fullscreen" | "inline";
}

/** Test seams; the real TUI uses the defaults. */
export interface TuiDeps {
	/** ~/.tau/history.jsonl; undefined keeps history in memory. */
	historyFile?: string;
	fileLister?: (cwd: string) => Promise<string[]>;
	columns?: () => number;
	now?: () => number;
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
}
