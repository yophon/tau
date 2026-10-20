// Shared harness for the P25 TUI tests: a real Agent on a scripted platform,
// optional JSONL sessions in a temp dir, rendered with ink-testing-library and
// driven through stdin like a terminal.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeFileSystem } from "@yophon/tau-host-node";
import {
	Agent,
	type AgentMessage,
	defaultPlatform,
	type Extension,
	ExtensionRegistry,
	JsonlSessionRepo,
	type PermissionMode,
	restoreSession,
	SessionRecorder,
	type SessionStore,
	type Tool,
	type ToolResult,
} from "@yophon/tau-kernel";
import { render } from "ink-testing-library";
import React from "react";
import { fakePlatform } from "../../kernel/test/helpers.ts";
import { suggestRules } from "../src/permissions.ts";
import { App } from "../src/tui/app.ts";
import { TuiController } from "../src/tui/controller.ts";
import { FullscreenApp } from "../src/tui/fullscreen.ts";
import type { ApprovalPromptRequest } from "../src/tui/model.ts";
import { CARET_END, CARET_MARK } from "../src/tui/render/bottom.ts";
import { LineCache } from "../src/tui/render/lines.ts";
import type { ApprovalAnswer, RunTuiOptions, TuiDeps } from "../src/tui/types.ts";

export type Response = Parameters<typeof fakePlatform>[0][number];

export interface Harness {
	controller: TuiController;
	requests: Array<{ messages: Array<{ role: string; content: unknown }> }>;
	repo?: JsonlSessionRepo;
	/** Text /copy put on the clipboard. */
	copied: string[];
	/** Desktop notifications sent (P34e). */
	notified: string[];
	/** What Ctrl+G returns from the external editor. */
	editorResult: { value: string | undefined };
	frame(): string;
	type(text: string): Promise<void>;
	key(sequence: string): Promise<void>;
	submit(text: string): Promise<void>;
	waitFor(test: (frame: string) => boolean, what: string): Promise<string>;
	cleanup(): void;
}

export const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export const ENTER = "\r";
export const ESC = "\x1b";
export const ALT_ENTER = "\x1b\r";
export const UP = "\x1b[A";
export const DOWN = "\x1b[B";

export interface HarnessOptions {
	responses: Response[];
	tools?: Tool[];
	permissionMode?: PermissionMode;
	extensions?: Extension[];
	/** Persist to JSONL sessions in a temp dir (needed by /resume, /tree, /fork, /name). */
	sessions?: boolean;
	/** Messages of a session to resume at startup (with `sessions`). */
	resume?: (store: SessionStore, recorder: SessionRecorder) => Promise<void>;
	/** What /reload loads; defaults to the same extensions again. */
	reloadExtensions?: Extension[];
	/** Extra RunTuiOptions (P28: the model table hooks). */
	tui?: Partial<RunTuiOptions>;
	/** Render the full-screen view (P33/P34) instead of the inline one. */
	fullscreen?: boolean;
	/** Extra TuiDeps (P36b: the clipboard). */
	deps?: Partial<TuiDeps>;
}

export async function harness(options: HarnessOptions): Promise<Harness> {
	const requests: Harness["requests"] = [];
	const platform = fakePlatform(options.responses, requests);
	const permissionMode = options.permissionMode ?? "autonomous";
	const extensions = await ExtensionRegistry.load(options.extensions ?? []);
	let approvalPrompt: ((request: ApprovalPromptRequest) => Promise<ApprovalAnswer>) | undefined;
	const cwd = mkdtempSync(join(tmpdir(), "tau-tui-"));

	let repo: JsonlSessionRepo | undefined;
	let store: SessionStore | undefined;
	let recorder: SessionRecorder | undefined;
	let initial: AgentMessage[] | undefined;
	if (options.sessions) {
		repo = new JsonlSessionRepo(new NodeFileSystem("/"), defaultPlatform(), join(cwd, ".sessions"), cwd);
		store = await repo.create();
		recorder = await SessionRecorder.open(store);
		if (options.resume) {
			await options.resume(store, recorder);
			initial = (await restoreSession(store)).messages;
		}
	}

	const buildAgent = (
		messages: AgentMessage[] | undefined,
		session: SessionRecorder | undefined,
		registry: ExtensionRegistry,
	): Agent =>
		new Agent({
			config: { baseUrl: "http://mock/v1", apiKey: "k", model: "test-model" },
			platform,
			tools: options.tools ?? [],
			extensions: registry,
			permissionMode,
			...(messages !== undefined ? { initialMessages: messages } : {}),
			...(session !== undefined ? { session } : {}),
			onApproval: async (request) => {
				if (!approvalPrompt) return false;
				// What main.ts's workspace would offer as "always" (P37a).
				const edits = request.toolName === "write" || request.toolName === "edit";
				const rules = edits || request.protectedPath ? [] : suggestRules(request, { allow: [], ask: [], deny: [] });
				const always = edits
					? { label: "Allow all edits this session", kind: "edits" as const }
					: rules.length > 0
						? { label: `Always allow in this project: ${rules.join(", ")}`, kind: "rules" as const }
						: undefined;
				return (await approvalPrompt(always ? { ...request, always } : request)) !== "deny";
			},
		});
	const agent = buildAgent(initial, recorder, extensions);
	const tuiOptions: RunTuiOptions = {
		agent,
		extensions,
		model: "test-model",
		modelChoices: ["test-model", "other-model"],
		baseUrl: "http://mock/v1",
		cwd,
		permissionMode,
		sessionRepo: (repo ?? {}) as RunTuiOptions["sessionRepo"],
		shell: {
			exec: async (command: string, opts?: { onStdout?: (chunk: string) => void }) => {
				opts?.onStdout?.(`ran: ${command}\n`);
				return { stdout: `ran: ${command}\n`, stderr: "", exitCode: 0 };
			},
		} as unknown as RunTuiOptions["shell"],
		...(store !== undefined ? { store } : {}),
		...(recorder !== undefined ? { recorder } : {}),
		setModel: () => undefined,
		setThinkingLevel: () => undefined,
		setApprovalPrompt: (prompt) => {
			approvalPrompt = prompt;
		},
		buildAgent: (messages, session, registry) => buildAgent(messages, session, registry),
		reloadExtensions: async () => ExtensionRegistry.load(options.reloadExtensions ?? options.extensions ?? []),
		sessionReason: initial ? "resume" : "startup",
		// A title request would take the next scripted response: tests that want it turn it on.
		autoTitle: false,
		...options.tui,
	};
	const copied: string[] = [];
	const notified: string[] = [];
	const editorResult: { value: string | undefined } = { value: undefined };
	const controller = new TuiController(tuiOptions, {
		columns: () => 100,
		readBranch: () => undefined,
		clearScreen: () => undefined,
		copy: async (text) => {
			copied.push(text);
			return "the test clipboard";
		},
		editText: () => editorResult.value,
		notify: (heading, body) => notified.push(`${heading}: ${body}`),
		...options.deps,
	});
	const ink = render(
		options.fullscreen
			? React.createElement(FullscreenApp, { controller, cache: new LineCache() })
			: React.createElement(App, { controller }),
	);
	const cleanup = (): void => {
		ink.unmount();
		void controller.stop();
	};
	await controller.start();
	// Let Ink mount and attach its stdin listener (useInput's raw mode) before anything is typed;
	// a fixed pause lost the first keystroke on a loaded machine.
	for (let waited = 0; ink.stdin.listenerCount("readable") === 0 && waited < 3000; waited += 5) await pause(5);
	await pause(5);
	const frame = (): string => {
		controller.store.flush();
		// The full-screen caret mark (P38a) is for the painter; tests read the frame without it.
		return (ink.lastFrame() ?? "").replaceAll(CARET_MARK, "").replaceAll(CARET_END, "");
	};
	const waitFor = async (test: (frame: string) => boolean, what: string): Promise<string> => {
		const deadline = Date.now() + 3000;
		for (;;) {
			const current = frame();
			if (test(current)) return current;
			if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}. Last frame:\n${current}`);
			await pause(10);
		}
	};
	// Like the TUI's filtered stdin: the controller takes terminal reports before Ink sees a read.
	const write = (data: string): void => {
		const rest = controller.filterInput(data);
		if (rest !== "") ink.stdin.write(rest);
	};
	const type = async (text: string): Promise<void> => {
		for (const ch of text) {
			write(ch);
			await pause(1);
		}
		await pause(5);
	};
	const key = async (sequence: string): Promise<void> => {
		write(sequence);
		await pause(10);
	};
	return {
		controller,
		requests,
		copied,
		notified,
		editorResult,
		...(repo !== undefined ? { repo } : {}),
		frame,
		type,
		key,
		submit: async (text) => {
			await type(text);
			await key(ENTER);
		},
		waitFor,
		cleanup,
	};
}

export function textTool(name: string, output: string | (() => Promise<string>), executions: string[] = []): Tool {
	return {
		name,
		description: `${name} tool`,
		parameters: { type: "object", properties: { path: { type: "string" }, command: { type: "string" } } },
		execute: async (args, signal): Promise<ToolResult> => {
			executions.push(JSON.stringify(args));
			const aborted = new Promise<never>((_resolve, reject) => {
				signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
			});
			const text = typeof output === "string" ? output : await Promise.race([output(), aborted]);
			return { content: [{ type: "text", text }] };
		},
	};
}

export function deferred(): { promise: Promise<string>; resolve: (value: string) => void } {
	let resolve: (value: string) => void = () => undefined;
	const promise = new Promise<string>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}
