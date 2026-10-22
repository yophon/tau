/**
 * Telling you how a run is going when you are not looking (P34e): a spinner in
 * the terminal title (pi's titlebar-spinner example), Windows Terminal's tab
 * and taskbar progress (OSC 9;4), and a desktop notification when a run ends
 * or an approval waits while the window is in the background (pi's notify
 * example: a Windows toast under Windows Terminal, OSC 99 for Kitty, OSC 777
 * elsewhere). P49: the Program Status Protocol (OSC 7501) says working, blocked,
 * done or error to terminals that show it (Ghostty, Rex); others ignore it.
 */
import { spawn } from "node:child_process";

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const SPIN_MS = 100;
/** How long the error state shows on the tab after a failed run. */
const ERROR_MS = 2000;

/** OSC 9;4 states: 0 none, 2 error, 3 working (indeterminate), 4 paused. */
const progress = (state: 0 | 2 | 3 | 4) => `\x1b]9;4;${state};0\x07`;
// Control characters would end the sequence early.
// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point
const title = (text: string) => `\x1b]0;${text.replace(/[\x00-\x1f\x7f]/g, " ")}\x07`;

/** Program Status Protocol states (OSC 7501, revision 0.4). */
export type ProgramState = "idle" | "working" | "blocked" | "done" | "error" | "clear";
/** What a blocked program waits for. */
export type BlockedKind = "permission" | "question" | "auth";

/**
 * One OSC 7501 report (P49): `ESC ] 7501 ; key=value : … ESC \`, with `app=tau` and a
 * one-line `msg` in base64 as the protocol asks. No query first: a terminal that does not
 * know the sequence drops it.
 */
export function programStatusSequence(state: ProgramState, fields: { kind?: BlockedKind; msg?: string } = {}): string {
	const parts = [`state=${state}`, ...(fields.kind ? [`kind=${fields.kind}`] : []), "app=tau"];
	const msg = fields.msg?.replace(/\s+/g, " ").trim().slice(0, 200);
	if (msg) parts.push(`msg=${Buffer.from(msg, "utf8").toString("base64")}`);
	return `\x1b]7501;${parts.join(":")}\x1b\\`;
}

/**
 * The program status as a terminal sees it, each change written once (P49). The REPL uses it
 * on its own; the TUI through TerminalStatus.
 */
export class ProgramStatus {
	private last = "";
	private finished = false;
	private readonly write: (data: string) => void;

	constructor(write: (data: string) => void) {
		this.write = write;
	}

	set(state: ProgramState, fields: { kind?: BlockedKind; msg?: string } = {}): void {
		const key = `${state}:${fields.kind ?? ""}`;
		this.finished = state === "done" || state === "error";
		if (key === this.last) return;
		this.last = key;
		this.write(programStatusSequence(state, fields));
	}

	/** You started typing after a run ended: idle again. */
	active(): void {
		if (this.finished) this.set("idle");
	}
}

/** Windows Terminal and ConEmu show OSC 9;4 progress; elsewhere it is not sent. */
/** Terminals that show OSC 8 hyperlinks (pi's terminal capabilities); tmux only when configured, so not here. */
export function supportsHyperlinks(env: Record<string, string | undefined> = process.env): boolean {
	if (env.TMUX) return false;
	const program = (env.TERM_PROGRAM ?? "").toLowerCase();
	return Boolean(
		env.WT_SESSION ||
			env.KITTY_WINDOW_ID ||
			env.TERM === "xterm-kitty" ||
			env.WEZTERM_PANE ||
			env.ITERM_SESSION_ID ||
			env.WARP_SESSION_ID ||
			env.GHOSTTY_RESOURCES_DIR ||
			["iterm.app", "wezterm", "vscode", "zed", "alacritty", "ghostty", "warpterminal"].includes(program),
	);
}

export function supportsProgress(env: NodeJS.ProcessEnv = process.env): boolean {
	return env.WT_SESSION !== undefined || env.ConEmuANSI === "ON";
}

export interface StatusOptions {
	/** Change the title (tui.title); false sends neither title, progress nor OSC 7501. */
	title: boolean;
	progress: boolean;
}

/** The title and tab progress for the run state. */
export class TerminalStatus {
	private timer: ReturnType<typeof setInterval> | undefined;
	private errorTimer: ReturnType<typeof setTimeout> | undefined;
	private frame = 0;
	private disposed = false;

	private readonly write: (data: string) => void;
	private readonly options: StatusOptions;
	private readonly base: () => string;
	private readonly program: ProgramStatus;

	constructor(write: (data: string) => void, options: StatusOptions, base: () => string) {
		this.write = write;
		this.options = options;
		this.base = base;
		this.program = new ProgramStatus(write);
		if (options.title) write(title(base()));
	}

	running(): void {
		if (!this.options.title || this.disposed) return;
		this.program.set("working", { msg: "Working" });
		this.clearError();
		if (this.options.progress) this.write(progress(3));
		if (this.timer) return;
		this.timer = setInterval(() => {
			this.frame = (this.frame + 1) % SPINNER.length;
			this.write(title(`${SPINNER[this.frame]} ${this.base()}`));
		}, SPIN_MS);
		this.timer.unref?.();
	}

	/** An approval, a question or a sign-in waits for you. */
	waiting(kind: BlockedKind = "permission", msg?: string): void {
		if (!this.options.title || this.disposed) return;
		this.program.set("blocked", { kind, ...(msg ? { msg } : {}) });
		if (this.options.progress) this.write(progress(4));
	}

	/** You started typing: a finished run's status goes back to idle. */
	active(): void {
		if (!this.options.title || this.disposed) return;
		this.program.active();
	}

	idle(failed = false): void {
		if (!this.options.title || this.disposed) return;
		this.program.set(failed ? "error" : "done", { msg: failed ? "Failed" : "Done" });
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
		this.write(title(this.base()));
		if (!this.options.progress) return;
		this.clearError();
		if (!failed) {
			this.write(progress(0));
			return;
		}
		this.write(progress(2));
		this.errorTimer = setTimeout(() => {
			this.errorTimer = undefined;
			if (!this.disposed) this.write(progress(0));
		}, ERROR_MS);
		this.errorTimer.unref?.();
	}

	/** Leave the terminal's own title and no progress behind. */
	dispose(): void {
		if (this.disposed) return;
		if (this.timer) clearInterval(this.timer);
		this.clearError();
		this.disposed = true;
		if (!this.options.title) return;
		this.program.set("clear");
		if (this.options.progress) this.write(progress(0));
		this.write(title(""));
	}

	private clearError(): void {
		if (this.errorTimer) clearTimeout(this.errorTimer);
		this.errorTimer = undefined;
	}
}

/** PowerShell's own app id: Windows shows toasts only from a registered app. */
const POWERSHELL_APP_ID = "{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe";

const psString = (text: string) => `'${text.replaceAll("'", "''")}'`;

/** The Windows PowerShell script that shows a two-line toast (WinRT, Windows PowerShell 5.1). */
export function windowsToastScript(heading: string, body: string): string {
	const manager =
		"[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]";
	return [
		`${manager} > $null`,
		"$xml = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)",
		"$text = $xml.GetElementsByTagName('text')",
		`$text[0].AppendChild($xml.CreateTextNode(${psString(heading)})) > $null`,
		`$text[1].AppendChild($xml.CreateTextNode(${psString(body)})) > $null`,
		`[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier(${psString(POWERSHELL_APP_ID)}).Show([Windows.UI.Notifications.ToastNotification]::new($xml))`,
	].join("; ");
}

export type NotifyChannel = "windows" | "kitty" | "osc777";

export function notifyChannel(env: NodeJS.ProcessEnv = process.env): NotifyChannel {
	if (env.WT_SESSION !== undefined) return "windows";
	if (env.KITTY_WINDOW_ID !== undefined) return "kitty";
	return "osc777";
}

/** The escape sequences for a terminal notification (Kitty OSC 99, else OSC 777). */
export function notifySequence(channel: "kitty" | "osc777", heading: string, body: string): string {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters would end the sequence
	const clean = (text: string) => text.replace(/[\x00-\x1f\x7f;]/g, " ");
	if (channel === "kitty") return `\x1b]99;i=1:d=0;${clean(heading)}\x1b\\\x1b]99;i=1:p=body;${clean(body)}\x1b\\`;
	return `\x1b]777;notify;${clean(heading)};${clean(body)}\x07`;
}

/** Send a desktop notification; failures are ignored (it is only a nudge). */
export function notifyDesktop(
	heading: string,
	body: string,
	options: { env?: NodeJS.ProcessEnv; write?: (data: string) => void } = {},
): void {
	const env = options.env ?? process.env;
	const channel = notifyChannel(env);
	if (channel !== "windows") {
		(options.write ?? ((data) => process.stdout.write(data)))(notifySequence(channel, heading, body));
		return;
	}
	try {
		// Windows PowerShell has the WinRT types (pwsh does not); under WSL it is powershell.exe.
		const command = process.platform === "win32" ? "powershell" : "powershell.exe";
		const encoded = Buffer.from(windowsToastScript(heading, body), "utf16le").toString("base64");
		const child = spawn(command, ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], {
			stdio: "ignore",
			windowsHide: true,
			detached: true,
		});
		child.on("error", () => undefined);
		child.unref();
	} catch {
		// No PowerShell: no notification.
	}
}
