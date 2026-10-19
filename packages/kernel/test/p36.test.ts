// P36: bash run_in_background and task_stop over a BackgroundShell, read's image
// processor and non-vision note, read path cleanup, and the extension event bus.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	type BackgroundShell,
	type BackgroundTaskInfo,
	cleanReadPath,
	createCodingTools,
	ExtensionRegistry,
	type FileSystem,
	type ImageProcessor,
	imageMimeType,
	NON_VISION_IMAGE_NOTE,
	type Shell,
	type Tool,
	toolResultText,
} from "../src/index.ts";

const shell: Shell = { exec: async () => ({ stdout: "ran", stderr: "", exitCode: 0 }) };

function fakeBackground(): BackgroundShell & { started: Array<{ command: string; description?: string }> } {
	const tasks = new Map<string, BackgroundTaskInfo>();
	const started: Array<{ command: string; description?: string }> = [];
	return {
		started,
		async start(command, options) {
			const id = `b${tasks.size + 1}`;
			started.push({ command, ...(options?.description ? { description: options.description } : {}) });
			const task: BackgroundTaskInfo = {
				id,
				command,
				...(options?.description ? { description: options.description } : {}),
				outputPath: `/tmp/tasks/${id}.output`,
				status: "running",
				startedAt: 0,
			};
			tasks.set(id, task);
			return { ...task };
		},
		async stop(id) {
			const task = tasks.get(id);
			if (!task) throw new Error(`No background task ${id}.`);
			task.status = "killed";
			return { ...task };
		},
		list: () => [...tasks.values()],
	};
}

function tool(tools: Tool[], name: string): Tool {
	const found = tools.find((candidate) => candidate.name === name);
	assert.ok(found, `${name} is registered`);
	return found;
}

/** A filesystem holding one binary file. */
function binaryFs(bytes: Uint8Array): FileSystem {
	return {
		cwd: "/work",
		readTextFile: async () => "",
		readBinaryFile: async () => bytes,
		writeTextFile: async () => undefined,
		appendFile: async () => undefined,
		listDir: async () => [],
		stat: async () => ({ path: "/work/x", name: "x", kind: "file", size: bytes.length, mtimeMs: 0 }),
		remove: async () => undefined,
	};
}

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);

/** A minimal 24-bit BMP header (pi's isBmp checks the layout, not the pixels). */
function bmpHeader(): Uint8Array {
	const bytes = new Uint8Array(58);
	const view = new DataView(bytes.buffer);
	bytes[0] = 0x42;
	bytes[1] = 0x4d;
	view.setUint32(2, 58, true);
	view.setUint32(10, 54, true);
	view.setUint32(14, 40, true);
	view.setUint16(26, 1, true);
	view.setUint16(28, 24, true);
	return bytes;
}

describe("P36a: bash run_in_background and task_stop", () => {
	it("a background start returns the task id and output file at once", async () => {
		const background = fakeBackground();
		const tools = createCodingTools({ shell, background });
		const bash = tool(tools, "bash");
		const properties = (bash.parameters as { properties: Record<string, unknown> }).properties;
		assert.ok(properties.run_in_background && properties.description);
		assert.match(bash.description, /run_in_background/);
		const result = await bash.execute({
			command: "npm run dev",
			run_in_background: true,
			description: "Start the dev server",
			timeoutSeconds: 1,
		});
		assert.equal(
			toolResultText(result),
			"Command running in background with ID: b1. Output is being written to: /tmp/tasks/b1.output",
		);
		assert.deepEqual(background.started, [{ command: "npm run dev", description: "Start the dev server" }]);
		assert.equal((result.structuredContent as { exit_code: number }).exit_code, 0);
	});

	it("task_stop stops a task; an unknown id is an error", async () => {
		const background = fakeBackground();
		const tools = createCodingTools({ shell, background });
		await tool(tools, "bash").execute({ command: "sleep 100", run_in_background: true });
		const stopped = await tool(tools, "task_stop").execute({ task_id: "b1" });
		assert.equal(toolResultText(stopped), "Stopped b1 (sleep 100)");
		const unknown = await tool(tools, "task_stop").execute({ task_id: "b9" });
		assert.equal(unknown.isError, true);
		assert.match(toolResultText(unknown), /No background task b9/);
		assert.equal(tool(tools, "task_stop").risk, "low");
	});

	it("without a background shell there is no parameter and no task_stop; read-only has neither", async () => {
		const plain = createCodingTools({ shell });
		const properties = (tool(plain, "bash").parameters as { properties: Record<string, unknown> }).properties;
		assert.equal(properties.run_in_background, undefined);
		assert.equal(
			plain.some((candidate) => candidate.name === "task_stop"),
			false,
		);
		// run_in_background on a host without it runs in the foreground.
		assert.equal(toolResultText(await tool(plain, "bash").execute({ command: "x", run_in_background: true })), "ran");
		const readOnly = createCodingTools({ shell, background: fakeBackground() }, { mode: "read-only" });
		assert.deepEqual(
			readOnly.filter((candidate) => candidate.name === "bash" || candidate.name === "task_stop"),
			[],
		);
	});
});

describe("P36d: read's images", () => {
	it("goes through the host's image processor and passes its hints on", async () => {
		const calls: string[] = [];
		const images: ImageProcessor = {
			process: async (_bytes, mimeType) => {
				calls.push(mimeType);
				return { ok: true, data: "c21hbGw=", mimeType: "image/jpeg", hints: ["[Image: original 4000x3000]"] };
			},
		};
		const [read] = createCodingTools({ fs: binaryFs(PNG), images });
		const result = await read.execute({ path: "shot.png" });
		assert.deepEqual(calls, ["image/png"]);
		assert.deepEqual(result.content, [
			{ type: "text", text: "Read image file [image/jpeg]\n[Image: original 4000x3000]" },
			{ type: "image", data: "c21hbGw=", mimeType: "image/jpeg" },
		]);
	});

	it("an image the processor cannot handle comes back as its message, without an image", async () => {
		const images: ImageProcessor = { process: async () => ({ ok: false, message: "[Image omitted: too big.]" }) };
		const [read] = createCodingTools({ fs: binaryFs(PNG), images });
		const result = await read.execute({ path: "shot.png" });
		assert.equal(result.content.length, 1);
		assert.equal(toolResultText(result), "Read image file [image/png]\n[Image omitted: too big.]");
	});

	it("says when the model takes no images (pi's note)", async () => {
		const [read] = createCodingTools({ fs: binaryFs(PNG) }, { supportsImages: () => false });
		const result = await read.execute({ path: "shot.png" });
		assert.equal(toolResultText(result), `Read image file [image/png]\n${NON_VISION_IMAGE_NOTE}\n[image]`);
	});

	it("knows BMP files; without a processor they are refused", async () => {
		const bmp = bmpHeader();
		assert.equal(imageMimeType(bmp), "image/bmp");
		const [read] = createCodingTools({ fs: binaryFs(bmp) });
		const result = await read.execute({ path: "old.bmp" });
		assert.equal(result.isError, true);
		assert.match(toolResultText(result), /cannot convert BMP/);
	});

	it("forgives quotes around a dropped path and pi's @ prefix", () => {
		assert.equal(cleanReadPath('"C:\\My Shots\\a.png"'), "C:\\My Shots\\a.png");
		assert.equal(cleanReadPath("'/tmp/a b.png'"), "/tmp/a b.png");
		assert.equal(cleanReadPath("@src/index.ts"), "src/index.ts");
		assert.equal(cleanReadPath("src/index.ts"), "src/index.ts");
	});
});

describe("P36a: the extension event bus (pi pi.events)", () => {
	it("delivers to every subscriber, unsubscribes, and reports failing handlers", async () => {
		const seen: string[] = [];
		const errors: string[] = [];
		let off: (() => void) | undefined;
		const registry = await ExtensionRegistry.load([
			(api) => {
				off = api.events.on("jobs", (data) => seen.push(`a:${String(data)}`));
				api.events.on("jobs", () => {
					throw new Error("broken");
				});
			},
			(api) => {
				api.events.on("jobs", (data) => seen.push(`b:${String(data)}`));
				api.events.emit("jobs", 1);
			},
		]);
		registry.setErrorSink(({ event, error }) => errors.push(`${event}: ${error.message}`));
		registry.events.emit("jobs", 2);
		off?.();
		registry.events.emit("jobs", 3);
		assert.deepEqual(seen, ["a:1", "b:1", "a:2", "b:2", "b:3"]);
		assert.deepEqual(errors, ["events:jobs: broken", "events:jobs: broken"]);
	});
});
