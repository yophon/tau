/**
 * /permissions and /add-dir (P37a, Claude Code). Built on UiCapability only, so the
 * same commands work in the TUI (pickers), the REPL, RPC and ACP; without a UI
 * /permissions prints the rules.
 */
import { isAbsolute, relative } from "node:path";
import type { Extension, PermissionRuleKind, UiCapability } from "@yophon/tau-kernel";
import { DIRECTORY_ADDED_CHANNEL } from "./hooks-extension.ts";
import type { ListedRule, RuleDestination, WorkspacePermissions } from "./permissions.ts";

const KIND_TITLES: Record<PermissionRuleKind, string> = { allow: "Allow", ask: "Ask", deny: "Deny" };
const DESTINATIONS: ReadonlyArray<{ label: string; value: RuleDestination }> = [
	{ label: "This project, only me (.tau/settings.local.json)", value: "local" },
	{ label: "This project, shared (.tau/settings.json)", value: "project" },
	{ label: "All projects (~/.tau/settings.json)", value: "user" },
];
const ADD_RULE = "Add a new rule…";
const ADD_DIR = "Add a directory…";

function isInside(path: string, root: string): boolean {
	const rel = relative(root, path);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export function createPermissionsExtension(permissions: WorkspacePermissions): Extension {
	return (api) => {
		api.registerCommand("permissions", {
			description: "View, add and remove permission rules and working directories",
			handler: async (_args, ctx) => {
				if (!ctx.ui) return permissionsText(permissions);
				await browse(permissions, ctx.ui);
				return undefined;
			},
		});
		api.registerCommand("add-dir", {
			description: "Add a working directory (file edits there count as inside the project)",
			handler: async (args, ctx) => {
				const dir = args.trim() || (ctx.ui ? ((await ctx.ui.input("Directory to add", "../shared")) ?? "") : "");
				if (dir.trim() === "") return "Usage: /add-dir <directory>";
				// P44 (Claude Code): DirectoryAdded hooks hear about a directory /add-dir added.
				return addDirectory(permissions, dir.trim(), ctx.ui, (path) =>
					api.events?.emit(DIRECTORY_ADDED_CHANNEL, { directory: path, source: "slash_command" }),
				);
			},
		});
	};
}

async function addDirectory(
	permissions: WorkspacePermissions,
	dir: string,
	ui: UiCapability | undefined,
	onAdded?: (path: string) => void,
) {
	let remember = false;
	if (ui) {
		const choice = await ui.select(`Add ${dir} as a working directory?`, [
			"Yes, for this session",
			"Yes, and remember this directory (.tau/settings.local.json)",
		]);
		if (choice === undefined) return "Cancelled.";
		remember = choice.startsWith("Yes, and remember");
	}
	const before = permissions.workingDirectories();
	const added = permissions.addDirectory(dir, remember);
	if (added.error) return added.error;
	// Not for a directory that already was one, or inside one (Claude Code).
	const path = added.path;
	if (path && !before.some((root) => isInside(path, root))) onAdded?.(path);
	return remember
		? `Added ${added.path} as a working directory and saved it to .tau/settings.local.json.`
		: `Added ${added.path} as a working directory for this session.`;
}

function ruleLabel(rule: ListedRule): string {
	return `${rule.text}   [${rule.source}]`;
}

async function browse(permissions: WorkspacePermissions, ui: UiCapability): Promise<void> {
	for (;;) {
		const rules = permissions.list();
		const dirs = permissions.listDirectories();
		const problems = permissions.diagnostics();
		const count = (kind: PermissionRuleKind) => rules.filter((rule) => rule.kind === kind).length;
		const items = [
			`Allow (${count("allow")})`,
			`Ask (${count("ask")})`,
			`Deny (${count("deny")})`,
			`Working directories (${dirs.length + 1})`,
			...(problems.length > 0 ? [`Problems (${problems.length})`] : []),
		];
		const picked = await ui.select("Permissions", items);
		if (picked === undefined) return;
		if (picked.startsWith("Working directories")) await browseDirectories(permissions, ui);
		else if (picked.startsWith("Problems")) await ui.select("Rules that are not in force", problems);
		else await browseKind(permissions, ui, picked.split(" ")[0].toLowerCase() as PermissionRuleKind);
	}
}

async function browseKind(permissions: WorkspacePermissions, ui: UiCapability, kind: PermissionRuleKind) {
	for (;;) {
		const rules = permissions.list().filter((rule) => rule.kind === kind);
		const picked = await ui.select(`${KIND_TITLES[kind]} rules`, [ADD_RULE, ...rules.map(ruleLabel)]);
		if (picked === undefined) return;
		if (picked === ADD_RULE) {
			const text = await ui.input(`New ${kind} rule`, kind === "deny" ? "Edit(.env*)" : "Bash(npm test *)");
			if (!text?.trim()) continue;
			const destination = await ui.select(
				`Save ${text.trim()} to`,
				DESTINATIONS.map((entry) => entry.label),
			);
			const value = DESTINATIONS.find((entry) => entry.label === destination)?.value;
			if (!value) continue;
			const saved = permissions.addRules(kind, [text.trim()], value);
			ui.notify(
				saved.error ? `Not saved: ${saved.error}` : `Added ${kind} rule ${text.trim()}.`,
				saved.error ? "error" : "info",
			);
			continue;
		}
		const rule = rules.find((candidate) => ruleLabel(candidate) === picked);
		if (!rule) continue;
		if (rule.source === "flag") {
			ui.notify("Rules from the command line last for this run only.", "warning");
			continue;
		}
		if (await ui.confirm(`Remove ${rule.text}?`, `From ${rule.path ?? rule.source}`)) {
			const removed = permissions.removeRule(rule);
			ui.notify(removed.error ?? `Removed ${rule.text}.`, removed.error ? "error" : "info");
		}
	}
}

async function browseDirectories(permissions: WorkspacePermissions, ui: UiCapability) {
	for (;;) {
		const dirs = permissions.listDirectories();
		const picked = await ui.select("Working directories", [
			ADD_DIR,
			`${permissions.cwd}   [working directory]`,
			...dirs.map((dir) => `${dir.path}   [${dir.source}]`),
		]);
		if (picked === undefined) return;
		if (picked !== ADD_DIR) continue;
		const dir = await ui.input("Directory to add", "../shared");
		if (!dir?.trim()) continue;
		ui.notify(await addDirectory(permissions, dir.trim(), ui), "info");
	}
}

/** /permissions without a UI: the rules by kind, with where each comes from. */
export function permissionsText(permissions: WorkspacePermissions): string {
	const rules = permissions.list();
	const lines: string[] = [];
	for (const kind of ["allow", "ask", "deny"] as const) {
		const list = rules.filter((rule) => rule.kind === kind);
		lines.push(`${KIND_TITLES[kind]}:${list.length === 0 ? " (none)" : ""}`);
		for (const rule of list) lines.push(`  ${ruleLabel(rule)}`);
	}
	const dirs = permissions.listDirectories();
	lines.push(`Working directories: ${permissions.cwd}${dirs.map((dir) => `, ${dir.path} [${dir.source}]`).join("")}`);
	const problems = permissions.diagnostics();
	if (problems.length > 0) lines.push("Not in force:", ...problems.map((problem) => `  ${problem}`));
	lines.push(
		"Rules live in ~/.tau/settings.json, .tau/settings.json and .tau/settings.local.json (see docs/permissions.md).",
	);
	return lines.join("\n");
}
