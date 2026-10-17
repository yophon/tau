/**
 * Built-in slash commands (registry shape from yo-agent surface-cli
 * commands.ts). Extension commands merge in; a built-in name wins.
 */
import type { ExtensionRegistry } from "@yophon/tau-kernel";
import type { TuiController } from "./controller.ts";
import { errorText } from "./format.ts";
import { plainLine, type StyledLine, span } from "./render/spans.ts";

export interface BuiltinCommand {
	name: string;
	aliases?: string[];
	args?: string;
	description: string;
	run(tui: TuiController, args: string): Promise<void> | void;
}

const BUILTINS: BuiltinCommand[] = [
	{
		name: "help",
		description: "Show commands and keys",
		run: (tui) => {
			tui.store.dispatch({ type: "lines", lines: helpLines(tui.extensions) });
		},
	},
	{
		name: "clear",
		description: "Start a clean screen (the session is unchanged)",
		run: (tui) => {
			// Clear the visible screen and the scrollback, then let <Static> start over.
			process.stdout.write("\x1b[2J\x1b[3J\x1b[H");
			tui.store.dispatch({ type: "clear" });
		},
	},
	{
		name: "reasoning",
		description: "Show or hide reasoning (Ctrl+T)",
		run: (tui) => tui.execute({ type: "toggle-reasoning" }),
	},
	{
		name: "tools",
		args: "[expand|collapse]",
		description: "Expand or collapse tool details for new output (Ctrl+O)",
		run: (tui, args) => {
			const verbose = tui.state.verbose;
			if (args === "expand" ? !verbose : args === "collapse" ? verbose : true) tui.execute({ type: "toggle-verbose" });
			else tui.notice("dim", `Tool details are already ${verbose ? "expanded" : "collapsed"}.`);
		},
	},
	{
		name: "quit",
		aliases: ["exit"],
		description: "Exit tau",
		run: (tui) => tui.stop(),
	},
];

export function builtinCommands(): readonly BuiltinCommand[] {
	return BUILTINS;
}

function findBuiltin(name: string): BuiltinCommand | undefined {
	return BUILTINS.find((command) => command.name === name || command.aliases?.includes(name));
}

/** Every command for completion: built-ins first, then extension commands that do not clash. */
export function commandList(extensions: ExtensionRegistry): Array<{ name: string; description: string }> {
	const list = BUILTINS.map((command) => ({ name: `/${command.name}`, description: command.description }));
	for (const command of extensions.commands.values()) {
		if (findBuiltin(command.name)) continue;
		list.push({ name: `/${command.name}`, description: command.description ?? "" });
	}
	return list;
}

export function parseCommandLine(text: string): { name: string; args: string } | undefined {
	const match = text.match(/^\/([\w:-]+)(?:\s+([\s\S]*))?$/);
	if (!match) return undefined;
	return { name: match[1] ?? "", args: (match[2] ?? "").trim() };
}

/** Run a `/command`; false when no command has that name. */
export async function runCommand(tui: TuiController, text: string): Promise<boolean> {
	const parsed = parseCommandLine(text);
	if (!parsed) return false;
	const builtin = findBuiltin(parsed.name);
	if (builtin) {
		await builtin.run(tui, parsed.args);
		return true;
	}
	const command = tui.extensions.commands.get(parsed.name);
	if (!command) return false;
	try {
		await tui.agent.flush();
		const output = await command.handler(parsed.args, tui.agent.extensionContext());
		await tui.refreshStatus();
		if (typeof output === "string") tui.notice("info", output);
		else if (output?.action === "prompt") await tui.runPrompt(output.text);
	} catch (error) {
		tui.notice("error", `/${parsed.name} failed: ${errorText(error)}`);
	}
	return true;
}

const KEYS: Array<[string, string]> = [
	["Enter", "send; while working, steer the current turn"],
	["Alt+Enter", "queue a follow-up while working; a newline when idle"],
	["Ctrl+J", "newline"],
	["Esc", "interrupt; clear the input when idle"],
	["Ctrl+C", "interrupt; press twice to exit when idle"],
	["↑ / ↓", "history; ↑ on an empty input takes queued messages back"],
	["Ctrl+O", "expand or collapse tool details"],
	["Ctrl+T", "show or hide reasoning"],
	["Tab", "complete / commands and @ files"],
	["Ctrl+A/E/U/K/W", "line editing"],
];

function helpLines(extensions: ExtensionRegistry): StyledLine[] {
	const lines: StyledLine[] = [plainLine("Commands", { bold: true })];
	for (const command of BUILTINS) {
		const name = `/${command.name}${command.args ? ` ${command.args}` : ""}`;
		lines.push([span(`  ${name.padEnd(24)}`, { color: "cyan" }), span(command.description, { dim: true })]);
	}
	const extensionCommands = [...extensions.commands.values()].filter((command) => !findBuiltin(command.name));
	if (extensionCommands.length > 0) {
		lines.push(plainLine("Extension commands", { bold: true }));
		for (const command of extensionCommands) {
			lines.push([
				span(`  /${command.name.padEnd(23)}`, { color: "cyan" }),
				span(command.description ?? "", { dim: true }),
			]);
		}
	}
	lines.push(plainLine("Keys", { bold: true }));
	for (const [key, what] of KEYS)
		lines.push([span(`  ${key.padEnd(24)}`, { color: "cyan" }), span(what, { dim: true })]);
	return lines;
}
