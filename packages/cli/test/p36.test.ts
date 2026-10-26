// P36: background commands in the CLI (the end-of-task message, /tasks), the paste
// key (clipboard reading on each system, what goes into the input box) and `@file`.
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { NodeBackgroundShell, NodeImageProcessor, NodeShell } from "@yophon/tau-host-node";
import {
	Agent,
	type AgentEvent,
	createCodingTools,
	type ExtensionContext,
	ExtensionRegistry,
	messageText,
	toolResultText,
} from "@yophon/tau-kernel";
import { fakePlatform, makeSseResponse, textTurn, toolCallTurn } from "../../kernel/test/helpers.ts";
import { backgroundTasksText, createBackgroundExtension, readTail, taskEndMessage } from "../src/background.ts";
import { initialContent, processFileArguments } from "../src/file-args.ts";
import {
	type ClipboardCommand,
	parseWindowsClipboard,
	readClipboard,
	uriListPaths,
	windowsClipboardScript,
} from "../src/tui/clipboard-read.ts";
import { routeKey } from "../src/tui/keymap.ts";
import { harness } from "./tui-harness.ts";

const node = JSON.stringify(process.execPath.replaceAll("\\", "/"));

async function drain(agent: Agent, input: string): Promise<AgentEvent[]> {
	const events: AgentEvent[] = [];
	for await (const event of agent.prompt(input)) events.push(event);
	return events;
}

describe("P36a: background commands in the CLI", () => {
	it("the end of a command reaches the model as a follow-up message with the output's tail", async () => {
		const dir = mkdtempSync(join(tmpdir(), "tau-p36-"));
		const job = join(dir, "job.mjs").replaceAll("\\", "/");
		writeFileSync(job, `for (let i = 1; i <= 30; i++) console.log("line " + i); process.exit(2);`);
		const background = new NodeBackgroundShell(dir, { dir: join(dir, "tasks") });
		const agent = new Agent({
			config: { baseUrl: "https://fake.test/v1", model: "fake" },
			platform: fakePlatform([
				makeSseResponse(toolCallTurn("bash", { command: `${node} "${job}"`, run_in_background: true })),
				makeSseResponse(textTurn("started it")),
			]),
			tools: createCodingTools({ shell: new NodeShell(dir), background }),
			extensions: await ExtensionRegistry.load([createBackgroundExtension(background)]),
			permissionMode: "autonomous",
		});
		const events = await drain(agent, "build");
		const started = events.find((event) => event.type === "tool_result");
		assert.ok(started?.type === "tool_result");
		assert.match(toolResultText(started.result), /running in background with ID: b1/);
		for (let i = 0; i < 100 && !agent.messages.some((message) => message.role === "custom"); i++) {
			await new Promise((resolve) => setTimeout(resolve, 50));
			await agent.flush();
		}
		const custom = agent.messages.find((message) => message.role === "custom");
		assert.ok(custom, "the end-of-task message arrived");
		const text = messageText(custom);
		assert.match(text, /^\[Background task b1 failed: exit code 2\] /);
		assert.match(text, /Output: .*b1\.output/);
		assert.match(text, /line 11\n[\s\S]*line 30$/);
		assert.doesNotMatch(text, /line 10\n/);
	});

	it("a stopped command is not announced; /tasks lists, shows and stops without a UI", async () => {
		const dir = mkdtempSync(join(tmpdir(), "tau-p36-"));
		const forever = join(dir, "forever.mjs").replaceAll("\\", "/");
		writeFileSync(forever, `console.log("serving on 5173"); setInterval(() => {}, 1000);`);
		const background = new NodeBackgroundShell(dir, { dir: join(dir, "tasks") });
		const sent: string[] = [];
		const registry = await ExtensionRegistry.load([createBackgroundExtension(background)]);
		registry.attachHostActions({ sendMessage: (message: { content: string }) => sent.push(message.content) } as never);
		const ctx = {} as ExtensionContext;
		const tasks = registry.commands.get("tasks");
		assert.ok(tasks);
		assert.equal(await tasks.handler("", ctx), "No background tasks in this session.");
		await background.start(`${node} "${forever}"`, { description: "dev server" });
		assert.match(String(await tasks.handler("", ctx)), /^◐ b1 running · \d+s · dev server$/);
		for (let i = 0; i < 50 && !readTail(background.list()[0].outputPath, 5).includes("serving"); i++) {
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
		assert.match(String(await tasks.handler("b1", ctx)), /b1 running .*\n.*b1\.output\n\nserving on 5173/);
		assert.equal(await tasks.handler("stop b1", ctx), "Stopped b1 (dev server).");
		assert.match(String(await tasks.handler("stop b1", ctx)), /already ended/);
		await new Promise((resolve) => setTimeout(resolve, 100));
		assert.deepEqual(sent, []);
		const widget = registry.widgets.get("background");
		assert.equal(await widget?.handler(ctx), undefined);
		// /tasks as text: the same list, straight from the shell.
		assert.match(await backgroundTasksText(background, ""), /^■ b1 killed · \d+s · dev server$/);
		assert.match(await backgroundTasksText(background, "b1"), /^b1 killed .*\n.*b1\.output\n\nserving on 5173/);
		assert.equal(await backgroundTasksText(background, "b4"), "No background task b4.");
		assert.equal(await backgroundTasksText(new NodeBackgroundShell(dir), ""), "No background commands.");
	});

	it("taskEndMessage and readTail", () => {
		const dir = mkdtempSync(join(tmpdir(), "tau-p36-"));
		const path = join(dir, "out.txt");
		writeFileSync(path, "a\r\nb\r\nc\r\n\r\n");
		assert.equal(readTail(path, 2), "b\nc");
		assert.equal(readTail(join(dir, "missing"), 2), "");
		assert.equal(
			taskEndMessage(
				{ id: "b2", command: "npm test", outputPath: path, status: "completed", exitCode: 0, startedAt: 0 },
				"ok",
			),
			`[Background task b2 completed: exit code 0] npm test\nOutput: ${path}\nok`,
		);
	});
});

describe("P36b: reading the clipboard", () => {
	/** A fake command runner: answers by program and first argument. */
	function runner(answers: Record<string, string | Buffer | undefined>, calls: string[] = []): ClipboardCommand {
		return async (command, args) => {
			const key = `${command} ${args.join(" ")}`;
			calls.push(key);
			for (const [prefix, answer] of Object.entries(answers)) {
				if (key.startsWith(prefix)) return answer === undefined ? undefined : Buffer.from(answer);
			}
			return undefined;
		};
	}

	it("Windows: one PowerShell run; files, then the saved PNG, then text", async () => {
		const enc = (text: string) => Buffer.from(text, "utf8").toString("base64");
		assert.deepEqual(
			parseWindowsClipboard(`FILE ${enc("C:\\a b\\x.png")}\r\nFILE ${enc("D:\\y.txt")}\r\n`, () => undefined),
			{
				kind: "files",
				paths: ["C:\\a b\\x.png", "D:\\y.txt"],
			},
		);
		assert.deepEqual(
			parseWindowsClipboard("IMAGE\r\n", () => new Uint8Array([1, 2])),
			{
				kind: "image",
				bytes: new Uint8Array([1, 2]),
				mimeType: "image/png",
			},
		);
		assert.deepEqual(
			parseWindowsClipboard(`TEXT ${enc("你好\nworld")}\r\n`, () => undefined),
			{
				kind: "text",
				text: "你好\nworld",
			},
		);
		assert.equal(
			parseWindowsClipboard("", () => undefined),
			undefined,
		);
		assert.match(windowsClipboardScript("C:\\T\\o'k.png"), /Save\('C:\\T\\o''k\.png'/);
		const calls: string[] = [];
		const removed: string[] = [];
		const content = await readClipboard({
			platform: "win32",
			env: {},
			run: runner({ "powershell.exe": "IMAGE\n" }, calls),
			tempPath: () => "C:\\T\\clip.png",
			readFile: () => new Uint8Array([9]),
			removeFile: (path) => removed.push(path),
		});
		assert.deepEqual(content, { kind: "image", bytes: new Uint8Array([9]), mimeType: "image/png" });
		assert.equal(calls.length, 1);
		assert.match(calls[0], /^powershell\.exe -NoProfile -NonInteractive -STA -EncodedCommand /);
		assert.deepEqual(removed, ["C:\\T\\clip.png"]);
	});

	it("Linux Wayland: copied files, else the preferred image type, else text; X11 when wl-paste is missing", async () => {
		assert.deepEqual(uriListPaths("file:///home/me/a%20b.png\r\n#comment\nfile:///tmp/c.txt\n"), [
			"/home/me/a b.png",
			"/tmp/c.txt",
		]);
		const wayland = { WAYLAND_DISPLAY: "wayland-0" };
		assert.deepEqual(
			await readClipboard({
				platform: "linux",
				env: wayland,
				run: runner({
					"wl-paste --list-types": "text/uri-list\ntext/plain\n",
					"wl-paste --type text/uri-list": "file:///home/me/x.png\n",
				}),
			}),
			{ kind: "files", paths: ["/home/me/x.png"] },
		);
		assert.deepEqual(
			await readClipboard({
				platform: "linux",
				env: wayland,
				run: runner({
					"wl-paste --list-types": "image/bmp\nimage/jpeg\nimage/png\n",
					"wl-paste --type image/png": "PNGDATA",
				}),
			}),
			{ kind: "image", bytes: new Uint8Array(Buffer.from("PNGDATA")), mimeType: "image/png" },
		);
		assert.deepEqual(
			await readClipboard({
				platform: "linux",
				env: { DISPLAY: ":0" },
				run: runner({
					"xclip -selection clipboard -t TARGETS -o": "UTF8_STRING\nTARGETS\n",
					"xclip -selection clipboard -o": "plain words",
				}),
			}),
			{ kind: "text", text: "plain words" },
		);
	});

	it("WSL: a Windows screenshot comes through PowerShell when the Linux clipboard has only text", async () => {
		const content = await readClipboard({
			platform: "linux",
			env: { WSL_DISTRO_NAME: "Ubuntu" },
			run: runner({
				"wl-paste --list-types": "text/plain\n",
				"wl-paste --no-newline": "stale text",
				"wslpath -w": "C:\\Users\\me\\AppData\\Local\\Temp\\clip.png\n",
				"powershell.exe": "IMAGE\n",
			}),
			tempPath: () => "/tmp/clip.png",
			readFile: () => new Uint8Array([7]),
			removeFile: () => undefined,
		});
		assert.deepEqual(content, { kind: "image", bytes: new Uint8Array([7]), mimeType: "image/png" });
	});

	it("macOS: a copied file, else the PNG osascript writes, else pbpaste", async () => {
		assert.deepEqual(
			await readClipboard({
				platform: "darwin",
				env: {},
				run: runner({ "osascript -e POSIX path": "/Users/me/shot.png\n" }),
			}),
			{ kind: "files", paths: ["/Users/me/shot.png"] },
		);
		assert.deepEqual(
			await readClipboard({
				platform: "darwin",
				env: {},
				run: runner({ "osascript -e set f": "", pbpaste: "hello" }),
				tempPath: () => "/tmp/c.png",
				readFile: () => new Uint8Array([1]),
				removeFile: () => undefined,
			}),
			{ kind: "image", bytes: new Uint8Array([1]), mimeType: "image/png" },
		);
		assert.deepEqual(
			await readClipboard({
				platform: "darwin",
				env: {},
				run: runner({ pbpaste: "hello" }),
				tempPath: () => "/tmp/c.png",
				readFile: () => undefined,
				removeFile: () => undefined,
			}),
			{ kind: "text", text: "hello" },
		);
	});

	it("Alt+V and Ctrl+V are the paste key", () => {
		const ctx = {
			approvalOpen: false,
			pickerOpen: false,
			menuOpen: false,
			promptActive: false,
			running: false,
			bufferEmpty: true,
			cursorAtFirstRow: true,
			cursorAtLastRow: true,
		};
		assert.deepEqual(routeKey("v", { meta: true }, ctx), { type: "paste-clipboard" });
		assert.deepEqual(routeKey("v", { ctrl: true }, ctx), { type: "paste-clipboard" });
		assert.deepEqual(routeKey("v", {}, ctx), { type: "insert", text: "v" });
	});
});

describe("P36b: the paste key in the TUI", () => {
	it("inserts copied file paths with spaces around them, a saved image's path, or the text", async () => {
		let next: Awaited<ReturnType<typeof readClipboard>> = { kind: "files", paths: ["/a/x.png", "/b/y.txt"] };
		const saved: string[] = [];
		const h = await harness({
			responses: [],
			deps: {
				readClipboard: async () => next,
				saveImage: (bytes, extension) => {
					saved.push(`${bytes.length}.${extension}`);
					return "/tmp/tau-clipboard-1.png";
				},
			},
		});
		try {
			await h.type("look");
			await h.key("\x1bv");
			await h.waitFor((frame) => frame.includes("look /a/x.png"), "the file paths");
			assert.equal(h.controller.state.editor.text, "look /a/x.png\n/b/y.txt");
			h.controller.execute({ type: "clear-input" });
			next = { kind: "image", bytes: new Uint8Array([1, 2, 3]), mimeType: "image/png" };
			await h.type("see ");
			await h.key("\x1bv");
			await h.waitFor(() => h.controller.state.editor.text === "see /tmp/tau-clipboard-1.png", "the image path");
			assert.deepEqual(saved, ["3.png"]);
			h.controller.execute({ type: "clear-input" });
			next = { kind: "text", text: "pasted words" };
			await h.key("\x1bv");
			await h.waitFor(() => h.controller.state.editor.text === "pasted words", "the text");
			h.controller.execute({ type: "clear-input" });
			await h.type("!ls ");
			next = { kind: "files", paths: ["/a b/c.txt"] };
			await h.key("\x1bv");
			await h.waitFor(() => h.controller.state.editor.text === "!ls '/a b/c.txt'", "a quoted path in a ! command");
		} finally {
			h.cleanup();
		}
	});
});

describe("P36c: @file arguments", () => {
	it("inlines text files, attaches images with hints, skips empty files and stops at a missing one", async () => {
		const dir = mkdtempSync(join(tmpdir(), "tau-p36-"));
		writeFileSync(join(dir, "note.txt"), "\uFEFFremember this");
		writeFileSync(join(dir, "empty.txt"), "");
		const png = Buffer.from(
			"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
			"base64",
		);
		writeFileSync(join(dir, "dot.png"), png);
		const files = await processFileArguments(["note.txt", "empty.txt", "dot.png"], dir, new NodeImageProcessor());
		assert.equal(
			files.text,
			`<file name="${join(dir, "note.txt")}">\nremember this\n</file>\n<file name="${join(dir, "dot.png")}"></file>\n`,
		);
		assert.equal(files.images.length, 1);
		assert.equal(files.images[0].mimeType, "image/png");
		const content = initialContent(files, "what is this?");
		assert.ok(Array.isArray(content));
		assert.deepEqual(content[0], { type: "text", text: `${files.text}what is this?` });
		assert.equal(initialContent({ text: "", images: [] }, undefined), undefined);
		await assert.rejects(
			processFileArguments(["nope.txt"], dir, new NodeImageProcessor()),
			/File not found: .*nope\.txt/,
		);
	});
});
