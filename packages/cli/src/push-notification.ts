// P46 (Claude Code's PushNotification): the model sends a desktop notification so a long
// task or a scheduled task can reach you when you step away. Like Claude Code it is not
// sent while you are at the terminal (focused, or a key pressed in the last minute; tau's
// number, Claude Code does not give one) unless TAU_DISABLE_NOTIFICATION_PRESENCE_CHECK=1,
// nor when tui.notify is "off". tau has no phone push (Claude Code's goes through Remote
// Control). The TUI and the REPL feed `presence`.
import process from "node:process";
import { type Extension, textResult } from "@yophon/tau-kernel";
import { notifyDesktop } from "./tui/terminal-status.ts";

/** A key pressed within this long means you are at the terminal. */
export const PRESENT_KEY_MS = 60_000;
/** Mobile systems cut longer text (Claude Code keeps the message under 200 characters). */
export const PUSH_MESSAGE_MAX = 200;

export const presence = {
	/** The terminal's focus as it last reported it; undefined when it never did. */
	focused: undefined as boolean | undefined,
	/** When a key was last pressed (ms since epoch). */
	keyAt: 0,
	/** tui.notify is not "off". */
	notifications: true,
	/** How a notification goes out (the TUI routes it through its own writer). */
	send: (heading: string, body: string): void => notifyDesktop(heading, body),
};

/** You typed something (keys or a paste; not mouse or focus reports). */
export function markActivity(now = Date.now()): void {
	presence.keyAt = now;
}

export function userPresent(now = Date.now()): boolean {
	return presence.focused === true || now - presence.keyAt < PRESENT_KEY_MS;
}

const DESCRIPTION = [
	"Send a desktop notification to the user, so a long-running task or a scheduled task can reach them when they step away.",
	`Keep the message under ${PUSH_MESSAGE_MAX} characters. It is not sent while the user is at the terminal, so use it for results worth interrupting them for, not for progress.`,
].join("\n");

export function createPushNotificationExtension(
	options: { env?: Record<string, string | undefined>; now?: () => number } = {},
): Extension {
	const env = options.env ?? process.env;
	const now = options.now ?? Date.now;
	return (api) => {
		api.registerTool(
			{
				name: "push_notification",
				description: DESCRIPTION,
				promptSnippet: "Send the user a desktop notification",
				parameters: {
					type: "object",
					properties: {
						message: { type: "string", description: `The notification text, under ${PUSH_MESSAGE_MAX} characters` },
						status: { type: "string", enum: ["proactive"], description: 'Always "proactive"' },
					},
					required: ["message", "status"],
				},
				execute: async (args) => {
					const raw = typeof args.message === "string" ? args.message.trim() : "";
					if (raw === "") return { content: [{ type: "text", text: "Give a message." }], isError: true };
					const message = raw.length > PUSH_MESSAGE_MAX ? `${raw.slice(0, PUSH_MESSAGE_MAX - 1)}…` : raw;
					const skipped = (reason: "config_off" | "user_present", text: string) =>
						textResult(text, { message, localSent: false, pushSent: false, disabledReason: reason });
					if (!presence.notifications)
						return skipped("config_off", "Not sent: notifications are turned off (tui.notify).");
					if (env.TAU_DISABLE_NOTIFICATION_PRESENCE_CHECK !== "1" && userPresent(now())) {
						return skipped("user_present", "Not sent: the user is at the terminal and will see your reply.");
					}
					presence.send("tau", message);
					return textResult("Desktop notification sent (tau has no phone push).", {
						message,
						localSent: true,
						pushSent: false,
						disabledReason: "no_transport",
						sentAt: new Date(now()).toISOString(),
					});
				},
			},
			{ risk: "low" },
		);
	};
}
