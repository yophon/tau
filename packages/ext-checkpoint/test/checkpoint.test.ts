import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	Agent,
	createCodingTools,
	ExtensionRegistry,
	type FileInfo,
	type FileSystem,
	InMemorySessionRepo,
	SessionRecorder,
} from "@yophon/tau-kernel";
import { fakePlatform, makeSseResponse, multiToolCallTurn, textTurn, toolCallTurn } from "../../kernel/test/helpers.ts";
import { createCheckpointExtension, createFileBackupBackend, trackedPaths } from "../src/index.ts";

/** Files in a map under `cwd`; paths are kept as given (absolute here). */
function memoryFs(cwd: string, files: Record<string, string> = {}): FileSystem & { files: Map<string, string> } {
	const map = new Map(Object.entries(files));
	const abs = (path: string): string => (path.startsWith("/") ? path : `${cwd}/${path}`.replace(/\/\.\//g, "/"));
	const info = (path: string): FileInfo => ({
		path,
		name: path.split("/").at(-1) ?? path,
		kind: "file",
		size: 0,
		mtimeMs: 0,
	});
	return {
		files: map,
		cwd,
		readTextFile: async (path) => {
			const content = map.get(abs(path));
			if (content === undefined) throw new Error(`ENOENT ${path}`);
			return content;
		},
		writeTextFile: async (path, content) => {
			map.set(abs(path), content);
		},
		appendFile: async () => undefined,
		listDir: async (path) => {
			const prefix = `${abs(path) === `${cwd}/.` ? cwd : abs(path)}/`;
			return [...map.keys()]
				.filter((key) => key.startsWith(prefix) && !key.slice(prefix.length).includes("/"))
				.map(info);
		},
		stat: async (path) => {
			if (!map.has(abs(path))) throw new Error(`ENOENT ${path}`);
			return info(abs(path));
		},
		remove: async (path) => {
			if (!map.delete(abs(path))) throw new Error(`ENOENT ${path}`);
		},
	};
}

describe("P55c file-backup backend", () => {
	it("keeps each file once per checkpoint and restores everything changed since", async () => {
		const workspace = memoryFs("/w", { "/w/a.txt": "a0", "/w/b.txt": "b0" });
		const store = memoryFs("/store");
		const backend = createFileBackupBackend({ workspace, store });
		await backend.begin("m1", { label: "first", timestamp: 1 });
		await backend.recordBefore("m1", "a.txt");
		workspace.files.set("/w/a.txt", "a1");
		await backend.recordBefore("m1", "/w/a.txt"); // the same file: kept once, as it was before
		await backend.recordBefore("m1", "new.txt");
		workspace.files.set("/w/new.txt", "n1");
		await backend.begin("m2", { label: "second", timestamp: 2 });
		await backend.recordBefore("m2", "a.txt");
		workspace.files.set("/w/a.txt", "a2");
		await backend.recordBefore("m2", "b.txt");
		workspace.files.set("/w/b.txt", "b2");

		const list = await backend.list();
		assert.deepEqual(
			list.map((checkpoint) => [checkpoint.id, checkpoint.files.map((file) => `${file.path}:${file.existed}`)]),
			[
				["m1", ["/w/a.txt:true", "/w/new.txt:false"]],
				["m2", ["/w/a.txt:true", "/w/b.txt:true"]],
			],
		);

		// Back to before m2: b and a as m2 found them; m1's new file stays.
		const second = await backend.restore("m2");
		assert.deepEqual(second, { restored: ["/w/a.txt", "/w/b.txt"], deleted: [] });
		assert.deepEqual(Object.fromEntries(workspace.files), { "/w/a.txt": "a1", "/w/b.txt": "b0", "/w/new.txt": "n1" });

		workspace.files.set("/w/a.txt", "a3");
		const first = await backend.restore("m1");
		// m2 is still there (restoring keeps the checkpoint itself): its b.txt comes back too.
		assert.deepEqual(first, { restored: ["/w/a.txt", "/w/b.txt"], deleted: ["/w/new.txt"] });
		assert.deepEqual(Object.fromEntries(workspace.files), { "/w/a.txt": "a0", "/w/b.txt": "b0" });
		assert.deepEqual(
			(await backend.list()).map((checkpoint) => checkpoint.id),
			["m1"],
			"later checkpoints are dropped",
		);
	});

	it("knows which paths each tool changes", () => {
		assert.deepEqual(trackedPaths("edit", { path: "a" }), ["a"]);
		assert.deepEqual(trackedPaths("write", { path: "b", content: "" }), ["b"]);
		assert.deepEqual(trackedPaths("apply_patch", { input: "*** Begin Patch\n*** Delete File: c\n*** End Patch" }), [
			"c",
		]);
		assert.deepEqual(trackedPaths("bash", { command: "rm a" }), []);
	});
});

describe("P55c the extension in an agent", () => {
	it("starts a checkpoint per prompt and records files before the tools change them", async () => {
		const workspace = memoryFs("/w", { "/w/a.txt": "one\n" });
		const store = memoryFs("/store");
		const backend = createFileBackupBackend({ workspace, store });
		const seen: string[] = [];
		const registry = await ExtensionRegistry.load([
			createCheckpointExtension({
				backendFor: (sessionId) => {
					seen.push(sessionId);
					return backend;
				},
			}),
		]);
		const platform = fakePlatform([
			makeSseResponse(toolCallTurn("edit", { path: "a.txt", edits: [{ oldText: "one", newText: "two" }] })),
			makeSseResponse(textTurn("edited")),
			makeSseResponse(
				multiToolCallTurn([
					{ name: "write", args: { path: "b.txt", content: "bee\n" }, id: "w1" },
					{ name: "edit", args: { path: "a.txt", edits: [{ oldText: "two", newText: "three" }] }, id: "e1" },
				]),
			),
			makeSseResponse(textTurn("done")),
		]);
		const repo = new InMemorySessionRepo(platform, "/w");
		const agent = new Agent({
			config: { baseUrl: "http://mock/v1", apiKey: "k", model: "m" },
			platform,
			session: await SessionRecorder.open(await repo.create()),
			extensions: registry,
			tools: createCodingTools({ fs: workspace }),
		});
		for await (const _ of agent.prompt("change a")) {
			// drain
		}
		for await (const _ of agent.prompt("more")) {
			// drain
		}
		assert.equal(workspace.files.get("/w/a.txt"), "three\n");
		const list = await backend.list();
		assert.deepEqual(
			list.map((checkpoint) => [checkpoint.label, checkpoint.files.map((file) => file.path)]),
			[
				["change a", ["/w/a.txt"]],
				["more", ["/w/b.txt", "/w/a.txt"]],
			],
		);
		assert.ok(seen.length > 0 && seen.every((id) => id === seen[0]));
		await backend.restore(list[0]?.id as string);
		assert.deepEqual(Object.fromEntries(workspace.files), { "/w/a.txt": "one\n" });
	});
});
