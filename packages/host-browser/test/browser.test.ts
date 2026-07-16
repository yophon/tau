import assert from "node:assert/strict";
import { test } from "node:test";
import { Agent, createCodingTools, messageText, restoreSession, SessionRecorder } from "@yophon/tau-kernel";
import { fakePlatform, makeSseResponse, seededRandomBytes, textTurn, toolCallTurn } from "../../kernel/test/helpers.ts";
import {
	BrowserMemoryFileSystem,
	type BrowserStorageLike,
	createBrowserSessionRepo,
	hasOpfsSupport,
	normalizeBrowserPath,
	OpfsFileSystem,
} from "../src/index.ts";

test("BrowserMemoryFileSystem round-trips files with POSIX-like paths", async () => {
	const fs = new BrowserMemoryFileSystem("/workspace");

	await fs.writeTextFile("notes/tau.txt", "hello");
	await fs.appendFile("/workspace/notes/tau.txt", "\nworld");

	assert.equal(await fs.readTextFile("./notes/../notes/tau.txt"), "hello\nworld");
	assert.deepEqual(
		(await fs.listDir("notes")).map((entry) => [entry.path, entry.name, entry.kind]),
		[["/workspace/notes/tau.txt", "tau.txt", "file"]],
	);
	assert.equal((await fs.stat("/workspace/notes")).kind, "directory");

	await fs.remove("notes/tau.txt");
	await assert.rejects(() => fs.readTextFile("notes/tau.txt"), /File not found/);
});

test("browser session repo reuses pi-v3 JSONL storage through FileSystem", async () => {
	const fs = new BrowserMemoryFileSystem("/");
	const platform = fakePlatform([]);
	const repo = createBrowserSessionRepo({
		fs,
		platform: { ...platform, randomBytes: seededRandomBytes(7) },
		cwd: "/app",
	});
	const store = await repo.create({ id: "browser-session" });
	const recorder = await SessionRecorder.open(store);

	await recorder.recordMessage({ role: "user", content: "hello from browser", timestamp: 1 });
	await recorder.setName("browser smoke");

	const listed = await repo.list();
	assert.equal(listed.length, 1);
	assert.equal(listed[0]?.name, "browser smoke");

	const restored = await restoreSession(await repo.open(listed[0]));
	assert.equal(messageText(restored.messages[0] ?? { role: "user", content: "", timestamp: 0 }), "hello from browser");
});

test("browser host fs tools run an agent loop without registering bash", async () => {
	const fs = new BrowserMemoryFileSystem("/app");
	const tools = createCodingTools({ fs });
	assert.deepEqual(
		tools.map((tool) => tool.name),
		["read", "write", "edit"],
	);

	const platform = fakePlatform([
		makeSseResponse(toolCallTurn("write", { path: "demo.txt", content: "browser file" })),
		makeSseResponse(toolCallTurn("read", { path: "demo.txt" })),
		makeSseResponse(textTurn("done")),
	]);
	const agent = new Agent({
		config: { baseUrl: "https://fake.test/v1", model: "fake-model" },
		platform,
		tools,
		maxTurnsPerPrompt: 5,
	});

	for await (const _event of agent.prompt("write then read a browser file")) {
		// drain
	}

	assert.equal(await fs.readTextFile("demo.txt"), "browser file");
	const toolResults = agent.messages.filter((message) => message.role === "toolResult").map(messageText);
	assert.match(toolResults[0] ?? "", /Wrote 12 characters/);
	assert.equal(toolResults[1], "1\tbrowser file");
	assert.equal(messageText(agent.messages.at(-1) ?? { role: "user", content: "", timestamp: 0 }), "done");
});

test("browser helpers expose OPFS detection and path normalization", () => {
	assert.equal(hasOpfsSupport({}), false);
	assert.equal(hasOpfsSupport({ getDirectory: async () => ({}) as never }), true);
	assert.equal(normalizeBrowserPath("/app/project", "../other/./file.txt"), "/app/other/file.txt");
});

test("OpfsFileSystem adapts browser directory handles", async () => {
	const root = new MockDirectoryHandle("");
	const storage: BrowserStorageLike = { getDirectory: async () => root };
	const fs = new OpfsFileSystem({ cwd: "/workspace", storage });

	await fs.writeTextFile("notes/tau.txt", "opfs");
	await fs.appendFile("notes/tau.txt", "\nfile");

	assert.equal(await fs.readTextFile("/workspace/notes/tau.txt"), "opfs\nfile");
	assert.deepEqual(
		(await fs.listDir("notes")).map((entry) => [entry.path, entry.name, entry.kind, entry.size]),
		[["/workspace/notes/tau.txt", "tau.txt", "file", 9]],
	);
	assert.equal((await fs.stat("notes")).kind, "directory");

	await fs.remove("notes/tau.txt");
	await assert.rejects(() => fs.readTextFile("notes/tau.txt"), /not found/i);
});

class MockFileHandle {
	readonly kind = "file";
	readonly name: string;
	private content: string;

	constructor(name: string, content = "") {
		this.name = name;
		this.content = content;
	}

	async getFile(): Promise<{ size: number; lastModified: number; text(): Promise<string> }> {
		const content = this.content;
		return {
			size: new TextEncoder().encode(content).byteLength,
			lastModified: 1,
			text: async () => content,
		};
	}

	async createWritable(): Promise<{ write(data: string): Promise<void>; close(): Promise<void> }> {
		return {
			write: async (data) => {
				this.content = data;
			},
			close: async () => undefined,
		};
	}
}

class MockDirectoryHandle {
	readonly kind = "directory";
	readonly name: string;
	private readonly entries = new Map<string, MockDirectoryHandle | MockFileHandle>();

	constructor(name: string) {
		this.name = name;
	}

	async getFileHandle(name: string, options?: { create?: boolean }): Promise<MockFileHandle> {
		const entry = this.entries.get(name);
		if (entry instanceof MockFileHandle) return entry;
		if (entry) throw Object.assign(new Error(`${name} is not a file`), { name: "TypeMismatchError" });
		if (!options?.create) throw Object.assign(new Error(`${name} not found`), { name: "NotFoundError" });
		const file = new MockFileHandle(name);
		this.entries.set(name, file);
		return file;
	}

	async getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<MockDirectoryHandle> {
		const entry = this.entries.get(name);
		if (entry instanceof MockDirectoryHandle) return entry;
		if (entry) throw Object.assign(new Error(`${name} is not a directory`), { name: "TypeMismatchError" });
		if (!options?.create) throw Object.assign(new Error(`${name} not found`), { name: "NotFoundError" });
		const directory = new MockDirectoryHandle(name);
		this.entries.set(name, directory);
		return directory;
	}

	async removeEntry(name: string): Promise<void> {
		if (!this.entries.delete(name)) throw Object.assign(new Error(`${name} not found`), { name: "NotFoundError" });
	}

	async *values(): AsyncIterable<MockDirectoryHandle | MockFileHandle> {
		yield* this.entries.values();
	}
}
