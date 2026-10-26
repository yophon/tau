// The extensions' side of the screen, server-side (P57): their dialogs go to the clients as
// ui/request; what their renderers, widgets and status items draw is worked out here and sent as data
// (text, markdown, or the lines a component drew at the client's width); their commands, shortcuts,
// argument completion and autocomplete providers run here. A client only ever sees results.
import {
	type AgentMessage,
	type AutocompleteProvider,
	type AutocompleteProviderFactory,
	type AutocompleteSuggestions,
	commandPromptContent,
	type ExtensionRenderComponent,
	type RegisteredEntryRenderer,
	type RegisteredMessageRenderer,
	type RegisteredToolRenderEvent,
	type RegisteredToolRenderer,
	type SessionEntry,
	type UiCapability,
	type UiForm,
} from "@yophon/tau-kernel";
import {
	type ClientRequests,
	type CommandInfo,
	type CommandOutcome,
	type CompletionItem,
	ERROR_CODES,
	JsonRpcError,
	type Rendered,
	type ServerRequests,
	type ShortcutInfo,
} from "@yophon/tau-protocol";
import { errorText } from "../util.ts";
import { fromWireFormResult, toWireObject } from "../wire.ts";
import { extensionCounts } from "./native.ts";
import type { HubThread, Subscriber } from "./thread.ts";

type UiParams = Omit<ServerRequests["ui/request"]["params"], "threadId" | "requestId">;
type UiResult = ServerRequests["ui/request"]["result"];

/** Where a session's dialogs go: its thread, or the client opening it before the thread exists. */
export interface UiRoute {
	thread?: HubThread;
	/** The client that opened the session: it gets the project trust question while the session loads. */
	opener?: Subscriber;
}

let openRequests = 0;

function askUi(
	route: UiRoute,
	params: UiParams,
	options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<UiResult> {
	if (route.thread) return route.thread.ask("ui/request", params, {}, options);
	const opener = route.opener;
	if (!opener) return Promise.resolve({});
	return opener.peer
		.request<UiResult>("ui/request", { ...params, threadId: "", requestId: `open${++openRequests}` })
		.catch(() => ({}));
}

const text = (result: UiResult | undefined): string | undefined =>
	typeof result?.value === "string" ? result.value : undefined;

/** The UiCapability of a hub session: every dialog is a ui/request to its clients (P56, form and timeouts P57). */
export function threadUi(route: UiRoute): UiCapability & { expectSignIn(): void } {
	return {
		confirm: async (title, message) =>
			(await askUi(route, { kind: "confirm", title, ...(message ? { message } : {}) })).confirmed === true,
		select: async (title, choices, dialog) =>
			text(
				await askUi(
					route,
					{ kind: "select", title, options: choices, ...(dialog?.timeout ? { timeoutMs: dialog.timeout } : {}) },
					{
						...(dialog?.signal ? { signal: dialog.signal as AbortSignal } : {}),
						...(dialog?.timeout ? { timeoutMs: dialog.timeout } : {}),
					},
				),
			),
		selectMany: async (title, choices) => {
			const result = await askUi(route, { kind: "selectMany", title, options: choices });
			const values = Array.isArray(result.values)
				? result.values.filter((value): value is string => typeof value === "string")
				: [];
			return values.length > 0 ? values : undefined;
		},
		input: async (title, placeholder) =>
			text(await askUi(route, { kind: "input", title, ...(placeholder ? { placeholder } : {}) })),
		editor: async (title, prefill) =>
			text(await askUi(route, { kind: "editor", title, ...(prefill !== undefined ? { prefill } : {}) })),
		form: async (form: UiForm, options) => {
			const result = await askUi(
				route,
				{ kind: "form", title: form.title, form: toWireObject(form) },
				options?.signal ? { signal: options.signal as AbortSignal } : {},
			);
			return result.cancelled || !result.form ? undefined : fromWireFormResult(result.form);
		},
		notify: (message, level) => route.thread?.notice(level ?? "info", message),
		addAutocompleteProvider: (factory: AutocompleteProviderFactory) => route.thread?.addAutocompleteProvider(factory),
		// P49: the next question is an MCP server's sign-in page (mcp-elicit says so first).
		expectSignIn: () => route.thread?.expectSignIn(),
	};
}

// --- Renderers ------------------------------------------------------------------------------

type RenderResult = string | { text: string; format?: "text" | "markdown" } | ExtensionRenderComponent | undefined;

function isRenderComponent(value: unknown): value is ExtensionRenderComponent {
	return typeof value === "object" && value !== null && "render" in value && typeof value.render === "function";
}

/** A render result as data: components draw at `width`, here. */
function toRendered(result: RenderResult, width: number): Rendered | undefined {
	if (result === undefined || result === null) return undefined;
	if (typeof result === "string") return { kind: "text", text: result };
	if (isRenderComponent(result)) return { kind: "lines", lines: result.render(width) };
	return result.format === "markdown" ? { kind: "markdown", text: result.text } : { kind: "text", text: result.text };
}

function messageRendererMatches(renderer: RegisteredMessageRenderer, message: AgentMessage): boolean {
	if (renderer.roles && !renderer.roles.includes(message.role)) return false;
	if (renderer.customTypes) {
		if (message.role !== "custom") return false;
		if (!renderer.customTypes.includes(message.customType)) return false;
	}
	return true;
}

function entryRendererMatches(renderer: RegisteredEntryRenderer, entry: SessionEntry): boolean {
	if (renderer.entryTypes && !renderer.entryTypes.includes(entry.type)) return false;
	const customType = entry.type === "custom" || entry.type === "custom_message" ? entry.customType : undefined;
	if (renderer.customTypes) {
		if (!customType) return false;
		if (!renderer.customTypes.includes(customType)) return false;
	}
	return true;
}

function toolRendererMatches(renderer: RegisteredToolRenderer, event: RegisteredToolRenderEvent): boolean {
	if (renderer.toolNames && !renderer.toolNames.includes(event.toolCall.name)) return false;
	if (renderer.phases && !renderer.phases.includes(event.phase)) return false;
	return true;
}

type RenderAnswer = ClientRequests["render/tool"]["result"];

/** The first tool renderer that draws something (the TUI's order: registration order). */
export async function renderTool(
	thread: HubThread,
	event: RegisteredToolRenderEvent,
	width: number,
): Promise<RenderAnswer> {
	for (const renderer of thread.session.extensions.toolRenderers.values()) {
		if (!toolRendererMatches(renderer, event)) continue;
		try {
			const rendered = toRendered(await renderer.handler(event, thread.session.agent.extensionContext()), width);
			if (rendered) return { rendered };
		} catch (error) {
			return { failed: { renderer: renderer.name, error: errorText(error) } };
		}
	}
	return {};
}

export async function renderMessage(thread: HubThread, message: AgentMessage, width: number): Promise<RenderAnswer> {
	for (const renderer of thread.session.extensions.messageRenderers.values()) {
		if (!messageRendererMatches(renderer, message)) continue;
		try {
			const rendered = toRendered(await renderer.handler(message, thread.session.agent.extensionContext()), width);
			if (rendered) return { rendered };
		} catch (error) {
			return { failed: { renderer: renderer.name, error: errorText(error) } };
		}
	}
	return {};
}

/** A session entry as an extension presents it: a picker label, or what it drew. */
export async function renderEntry(
	thread: HubThread,
	entry: SessionEntry,
	width: number,
): Promise<ClientRequests["render/entry"]["result"]> {
	for (const renderer of thread.session.extensions.entryRenderers.values()) {
		if (!entryRendererMatches(renderer, entry)) continue;
		try {
			const result = await renderer.handler(entry, thread.session.agent.extensionContext());
			if (result === undefined) continue;
			if (typeof result === "string" || isRenderComponent(result)) {
				const rendered = toRendered(result, width);
				if (rendered) return { rendered };
				continue;
			}
			return {
				rendered: {
					kind: "label",
					label: result.label,
					...(result.description !== undefined ? { description: result.description } : {}),
				},
			};
		} catch (error) {
			return { failed: { renderer: renderer.name, error: errorText(error) } };
		}
	}
	return {};
}

/** Markdown after every transformer, in extension order; one that throws or returns no string is skipped. */
export function transformMarkdown(
	thread: HubThread,
	items: ClientRequests["markdown/transform"]["params"]["items"],
): string[] {
	const transformers = thread.session.extensions.markdownTransformers();
	return items.map(({ text: markdown, ...context }) => {
		let out = markdown;
		for (const transformer of transformers) {
			try {
				const next = transformer(out, context);
				if (typeof next === "string") out = next;
			} catch {
				// A broken transformer must not take the transcript down.
			}
		}
		return out;
	});
}

// --- Surfaces and diagnostics ---------------------------------------------------------------

export async function readSurfaces(
	thread: HubThread,
	width: number,
	parts: ReadonlyArray<"status" | "widgets"> = ["status", "widgets"],
): Promise<ClientRequests["surfaces/read"]["result"]> {
	const registry = thread.session.extensions;
	const context = thread.session.agent.extensionContext();
	const status: string[] = [];
	if (parts.includes("status")) {
		for (const item of [...registry.headerItems.values(), ...registry.footerItems.values()]) {
			try {
				const result = await item.handler(context);
				if (result) status.push(result);
			} catch (error) {
				status.push(`${item.name} failed: ${errorText(error)}`);
			}
		}
	}
	const widgets: ClientRequests["surfaces/read"]["result"]["widgets"] = [];
	if (!parts.includes("widgets")) return { status, widgets };
	for (const widget of registry.widgets.values()) {
		const placement = widget.placement === "below-editor" ? "below-editor" : "above-editor";
		const clickable = widget.onClick !== undefined;
		try {
			const rendered = toRendered(await widget.handler(context), width);
			if (rendered) widgets.push({ name: widget.name, placement, rendered, clickable });
		} catch (error) {
			widgets.push({ name: widget.name, placement, error: errorText(error), clickable });
		}
	}
	return { status, widgets };
}

export async function clickWidget(thread: HubThread, name: string): Promise<void> {
	const widget = thread.session.extensions.widgets.get(name);
	if (!widget?.onClick) return;
	await widget.onClick(thread.session.agent.extensionContext());
}

export async function readDiagnostics(thread: HubThread): Promise<ClientRequests["diagnostics/read"]["result"]> {
	const registry = thread.session.extensions;
	const context = thread.session.agent.extensionContext();
	const result: ClientRequests["diagnostics/read"]["result"] = {
		lastSessionStart: thread.lastSessionStart,
		counts: extensionCounts(registry, thread.autocompleteProviderCount),
		items: [],
	};
	try {
		const discovered = await context.discoverResources?.(thread.lastSessionStart === "reload" ? "reload" : "startup");
		if (discovered) {
			result.resources = { skillPaths: discovered.skillPaths.length, promptPaths: discovered.promptPaths.length };
		}
	} catch (error) {
		result.resourcesError = errorText(error);
	}
	for (const diagnostic of registry.diagnostics.values()) {
		try {
			result.items.push({ name: diagnostic.name, result: await diagnostic.handler(context) });
		} catch (error) {
			result.items.push({ name: diagnostic.name, error: errorText(error) });
		}
	}
	return result;
}

// --- Commands, shortcuts, completion ----------------------------------------------------------

export function listCommands(thread: HubThread): { commands: CommandInfo[]; shortcuts: ShortcutInfo[] } {
	const registry = thread.session.extensions;
	return {
		commands: [...registry.commands].map(([invocation, command]) => ({
			name: invocation,
			description: command.description ?? "",
			...(command.source !== undefined ? { source: command.source } : {}),
			...(command.hidden ? { hidden: true } : {}),
			...(command.getArgumentCompletions ? { completes: true } : {}),
		})),
		shortcuts: [...registry.shortcuts.values()].map((shortcut) => ({
			name: shortcut.name,
			key: shortcut.key,
			description: shortcut.description ?? shortcut.name,
		})),
	};
}

/** An extension command (the TUI's runCommand): its text, or the prompt it asks for as a turn. */
export async function runCommand(thread: HubThread, name: string, args: string): Promise<CommandOutcome> {
	const registry = thread.session.extensions;
	const command = registry.commands.get(name);
	if (!command) return { unknown: true };
	const { agent } = thread.session;
	await agent.flush();
	const output = await command.handler(args, agent.extensionContext());
	// What it added to the conversation (sendMessage, written in the background) reaches the native clients now.
	await agent.flush();
	thread.syncMessages();
	if (typeof output === "string") return { output };
	if (output?.action !== "prompt") return {};
	// P44: UserPromptExpansion hooks may stop the prompt the command expands to.
	const expansion = await registry.runCommandPrompt(
		{ command: name, args, source: command.source ?? "extension", text: output.text },
		agent.extensionContext(),
	);
	if (expansion.cancel) return { blocked: expansion.reason ? { reason: expansion.reason } : {} };
	return { turn: thread.startTurn(commandPromptContent(output)) };
}

export async function runShortcut(thread: HubThread, name: string): Promise<CommandOutcome> {
	const shortcut = thread.session.extensions.shortcuts.get(name);
	if (!shortcut) return { unknown: true };
	const { agent } = thread.session;
	await agent.flush();
	const output = await shortcut.handler(agent.extensionContext());
	await agent.flush();
	thread.syncMessages();
	if (typeof output === "string") return { output };
	if (output?.action === "prompt") return { turn: thread.startTurn(commandPromptContent(output)) };
	return {};
}

export async function completeCommand(
	thread: HubThread,
	name: string,
	prefix: string,
): Promise<CompletionItem[] | null> {
	const complete = thread.session.extensions.commands.get(name)?.getArgumentCompletions;
	if (!complete) return null;
	const items = await complete(prefix);
	return (
		items?.map((item) => ({
			value: item.value,
			label: item.label,
			...(item.description !== undefined ? { description: item.description } : {}),
		})) ?? null
	);
}

/** Applying reached the bottom of the chain: the item is the client's own, and the client applies it. */
export const CLIENT_APPLIES = -1;

/**
 * The bottom of the hub's provider chain: the client's own completion (commands, files), which the
 * client sends with each request (`base`), as the TUI's built-in provider was the bottom of pi's
 * chain. Applying one of its items is the client's (CLIENT_APPLIES).
 */
export function bottomProvider(base: () => AutocompleteSuggestions | null): AutocompleteProvider {
	return {
		getSuggestions: async () => base(),
		applyCompletion: (lines) => ({ lines, cursorLine: CLIENT_APPLIES, cursorCol: CLIENT_APPLIES }),
	};
}

export function invalidParams(message: string): JsonRpcError {
	return new JsonRpcError(ERROR_CODES.invalidParams, message);
}
