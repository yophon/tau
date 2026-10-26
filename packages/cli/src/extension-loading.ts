// Loading extensions and the system prompt's sources (P50: split out of main.ts): the global,
// trusted-project, settings and -e extensions with their load report, extension flags (pi -e,
// -ne), --system-prompt / --append-system-prompt and SYSTEM.md, and the default system prompt.
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { importExtensionFiles, listExtensionFiles, loadExtensionsFromDir } from "@yophon/tau-host-node";
import { type Extension, ExtensionRegistry, type InlineExtension, type UiCapability } from "@yophon/tau-kernel";
import type { McpServerSpec } from "@yophon/tau-protocol";
import { builtinExtensions, configureBuiltins, toolLine } from "./builtins.ts";
import { createHooksExtension, type HookRunner, loadHookConfig } from "./hooks.ts";
import type { LspHost } from "./lsp.ts";
import { isProjectTrusted, presentGatedResources } from "./project-trust.ts";
import { stdioServer } from "./secrets.ts";
import { readSettings } from "./settings.ts";
import { CLI_VERSION, dim, userHome } from "./util.ts";

/** Extension flag values, and the other words: messages to send (pi `pi [options] [messages...]`, P36c). */
export function resolveExtensionFlags(
	registry: ExtensionRegistry,
	extras: string[],
): { values: Record<string, boolean | string>; messages: string[] } {
	const values: Record<string, boolean | string> = {};
	const messages: string[] = [];
	for (let i = 0; i < extras.length; i++) {
		const token = extras[i];
		if (!token.startsWith("--")) {
			messages.push(token);
			continue;
		}
		const equals = token.indexOf("=", 2);
		const name = token.slice(2, equals === -1 ? undefined : equals);
		const flag = registry.flags.get(name);
		if (!flag) {
			console.error(`Unknown option: ${token}`);
			process.exit(1);
		}
		if (flag.type === "boolean") {
			if (equals !== -1) {
				const inline = token.slice(equals + 1).toLowerCase();
				if (inline !== "" && inline !== "true") {
					console.error(`Boolean option ${token} does not accept a value other than true`);
					process.exit(1);
				}
			}
			values[name] = true;
		} else {
			const value = equals === -1 ? extras[++i] : token.slice(equals + 1);
			if (value === undefined || value.startsWith("--")) {
				console.error(`Missing value for ${token}`);
				process.exit(1);
			}
			values[name] = value;
		}
	}
	return { values, messages };
}

/** The registry plus the trust decision for the project's gated resources (backs ctx.isProjectTrusted). */
export interface LoadedExtensions {
	registry: ExtensionRegistry;
	projectTrusted: boolean;
	/** P46: the language servers of this load, which follow the session when it moves. */
	lsp?: LspHost;
}

/** P41b (pi -e, -ne): extensions named on the command line, and whether the discovered and configured ones stay out. */
export const extensionFlags: { paths: string[]; none: boolean } = { paths: [], none: false };

/** pi resolvePromptInput: the text of an existing file, else the value itself. */
export function promptInput(value: string): string {
	try {
		if (existsSync(value) && statSync(value).isFile()) return readFileSync(value, "utf8").replace(/^\uFEFF/, "");
	} catch {
		// Not a readable file: the value is the text.
	}
	return value;
}

/**
 * The system prompt's replacement and additions (P41b, pi): --system-prompt, else SYSTEM.md
 * (a trusted project's .tau/, else ~/.tau/); --append-system-prompt, else APPEND_SYSTEM.md the
 * same way. A trusted project's file wins over the user's; the two are not combined.
 */
export function systemPromptSources(
	cwd: string,
	home: string,
	projectTrusted: boolean,
	flags: { system?: string; append?: string[] },
): { system?: string; append: string[] } {
	const file = (name: string): string | undefined => {
		const project = join(cwd, ".tau", name);
		if (projectTrusted && existsSync(project)) return project;
		const user = join(home, ".tau", name);
		return existsSync(user) ? user : undefined;
	};
	const systemSource = flags.system ?? file("SYSTEM.md");
	const appendSources = flags.append && flags.append.length > 0 ? flags.append : [file("APPEND_SYSTEM.md")];
	return {
		...(systemSource !== undefined ? { system: promptInput(systemSource) } : {}),
		append: appendSources
			.filter((source): source is string => source !== undefined)
			.map(promptInput)
			.filter((text) => text.trim() !== ""),
	};
}

/** settings.json extensions (P40c, pi): extension files and directories; a missing one is reported and skipped. */
export async function loadSettingsExtensions(paths: readonly string[]): Promise<InlineExtension[]> {
	const loaded: InlineExtension[] = [];
	for (const path of paths) {
		if (!existsSync(path)) {
			console.log(dim(`Extension path not found: ${path}`));
			continue;
		}
		loaded.push(
			...(statSync(path).isDirectory() ? await loadExtensionsFromDir(path) : await importExtensionFiles([path])),
		);
	}
	return loaded;
}

/** P60: an MCP server a client brought for its session (an editor's; the protocol's McpServerSpec). */
export type ClientMcpServer = McpServerSpec;

export async function loadExtensionRegistry(
	cwd: string,
	ui: UiCapability | undefined,
	hostExtensions: readonly Extension[] = [],
	mcp = true,
	audit?: Extension,
	hooks?: HookRunner,
	/** P45: offer catalog language servers (the TUI, as Claude Code offers them in the terminal). */
	recommendLsp = false,
	/** P60: a client's MCP servers for the session (an editor's); they win over configured ones of the same name. */
	extraMcp: readonly ClientMcpServer[] = [],
): Promise<LoadedExtensions> {
	// Built-ins first (tool prompt, tool_search, codemode, P24e), then the host's, then the user's extensions.
	configureBuiltins({ cwd, projectTrusted: false, home: userHome() });
	// P41b (pi): -ne keeps out the discovered and configured extensions; -e paths load either way.
	const discovered = !extensionFlags.none;
	const userSettingsExtensions = discovered
		? (readSettings(join(userHome(), ".tau", "settings.json")).extensions ?? [])
		: [];
	const registry = await ExtensionRegistry.load([
		// P32c: the audit first, so it sees every call, including ones the guard blocks.
		...(audit ? [audit] : []),
		...builtinExtensions(),
		...hostExtensions,
		...(discovered ? await loadExtensionsFromDir(join(userHome(), ".tau", "extensions")) : []),
		...(await loadSettingsExtensions(userSettingsExtensions)),
		...(await loadSettingsExtensions(extensionFlags.paths)),
	]);
	// A failing notification handler (an unreachable MCP server in session_start, a
	// buggy turn_end) is reported and skipped instead of taking the CLI down (HF-12).
	registry.setErrorSink(({ event, error }) => {
		process.stderr.write(`[extension error in ${event}] ${error.message}\n`);
	});
	const extensionsDir = join(cwd, ".tau", "extensions");
	// List first, decide trust, and only then import: importing runs the modules' top-level
	// code, so an untrusted directory must never get that far (cd into a repo ≠ run its code).
	const projectFiles = discovered ? await listExtensionFiles(extensionsDir) : [];
	// Any gated resource asks for the decision, not only extensions (P23c): project
	// settings, skills and prompts are read only from a trusted directory.
	const present = presentGatedResources(cwd).filter(
		(relative) => relative !== ".tau/extensions" || projectFiles.length > 0,
	);
	let projectTrusted = false;
	if (present.length > 0) {
		projectTrusted = await isProjectTrusted(registry, cwd, ui, present);
		if (projectTrusted) {
			if (projectFiles.length > 0) await registry.add(await importExtensionFiles(projectFiles));
			// P40c: the project's settings.json extensions, resolved against its .tau directory.
			const listed = discovered ? (readSettings(join(cwd, ".tau", "settings.json")).extensions ?? []) : [];
			if (listed.length > 0) await registry.add(await loadSettingsExtensions(listed));
		} else {
			if (projectFiles.length > 0) {
				console.log(dim(`Skipped ${projectFiles.length} project extension(s): directory not trusted.`));
			}
			const ignored = present.filter((relative) => relative !== ".tau/extensions");
			if (ignored.length > 0) console.log(dim(`Ignored ${ignored.join(", ")}: directory not trusted.`));
		}
	}
	// Project codemode settings count only for a trusted directory.
	configureBuiltins({ cwd, projectTrusted, home: userHome() });
	// Connectors (P32b): MCP servers from ~/.tau/mcp.json and, when trusted, the project's.
	if (mcp) {
		const { loadMcpConfig, mcpProtocolNegotiation, withOAuth } = await import("./mcp-config.ts");
		const loadedMcp = loadMcpConfig({
			home: userHome(),
			cwd,
			projectTrusted,
			envAllow: readSettings(join(userHome(), ".tau", "settings.json")).shellEnvAllow ?? [],
		});
		for (const diagnostic of loadedMcp.diagnostics) console.log(dim(`mcp: ${diagnostic}`));
		// P60: an editor's servers (stdio ones from the environment without secrets, as ACP did, P32b).
		const brought = extraMcp.map((server) => (server.command ? stdioServer(server) : server));
		const names = new Set(brought.map((server) => server.name));
		const servers = [
			...brought,
			...withOAuth(loadedMcp.servers, userHome()).filter((server) => !names.has(server.name)),
		];
		if (servers.length > 0) {
			const { createMcpExtension } = await import("@yophon/tau-ext-mcp");
			const { createElicitHandler } = await import("./mcp-elicit.ts");
			const { openUrl } = await import("./open-url.ts");
			await registry.add([
				createMcpExtension({
					servers,
					// P43 (pi): the working directory as the root, resource tools, images to the model;
					// P44 (Claude Code): elicitation, prompt commands, `@` resources; P47 (Claude Code):
					// servers are asked for MCP 2026-07-28 first.
					cwd,
					elicit: createElicitHandler(hooks, openUrl),
					protocolNegotiation: mcpProtocolNegotiation(process.env, (message) => console.error(dim(`mcp: ${message}`))),
				}),
			]);
		}
	}
	// Language servers (P45, Claude Code): ~/.tau/lsp.json and, when trusted, the project's.
	const { createLspHost } = await import("./lsp.ts");
	const lsp = createLspHost({
		home: userHome(),
		cwd,
		projectTrusted,
		clientVersion: CLI_VERSION,
		envAllow: readSettings(join(userHome(), ".tau", "settings.json")).shellEnvAllow ?? [],
		recommend: recommendLsp,
	});
	for (const error of lsp.errors) console.log(dim(`lsp: ${error}`));
	await registry.add([lsp.extension]);
	// User hooks (P35): ~/.tau/settings.json and, when trusted, the project's.
	if (hooks) {
		hooks.configure(loadHookConfig({ home: userHome(), cwd, projectTrusted }));
		for (const diagnostic of hooks.diagnostics) console.log(dim(`hooks: ${diagnostic}`));
		await registry.add([createHooksExtension(hooks)]);
	}
	reportExtensionLoad(registry);
	return { registry, projectTrusted, lsp };
}

/**
 * Extensions that failed to load were rolled back and skipped (pi); say which and
 * why, and name same-name registrations that lost to an earlier one (P23c).
 */
export function reportExtensionLoad(registry: ExtensionRegistry): void {
	for (const { extension, error } of registry.loadErrors) {
		process.stderr.write(`[extension failed to load, skipped] ${extension}: ${error.message}\n`);
	}
	for (const warning of registry.warnings) process.stderr.write(`[extension conflict] ${warning}\n`);
}

export function defaultSystemPrompt(
	cwd: string,
	toolNames: readonly string[],
	extraDirs: readonly string[] = [],
): string {
	// Name the tools actually loaded: read-only mode has no write/edit, and a prompt
	// promising them invites calls that can only fail (HF-16). The built-in tool
	// prompt keeps this line equal to the declared tools at each run (P24e).
	return [
		"You are tau, a coding agent running in a terminal.",
		`Working directory: ${cwd}`,
		...(extraDirs.length > 0 ? [`Additional working directories: ${extraDirs.join(", ")}`] : []),
		toolLine(toolNames),
		"Be direct and concise. Answer questions before making changes.",
	].join("\n");
}
