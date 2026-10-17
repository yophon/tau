import type {
	Agent,
	AgentMessage,
	ApprovalRequest,
	ExtensionRegistry,
	JsonlSessionRepo,
	PermissionMode,
	SessionRecorder,
	SessionStore,
	Shell,
	ThinkingLevel,
	UiCapability,
} from "@yophon/tau-kernel";

export type ApprovalAnswer = "once" | "always" | "deny";

/** What main.ts hands the TUI (the same shape the P8 TUI took). */
export interface RunTuiOptions {
	agent: Agent;
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
}
