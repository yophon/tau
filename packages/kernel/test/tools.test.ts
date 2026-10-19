import assert from "node:assert/strict";
import { test } from "node:test";
import { createCodingTools as createCodingToolsForEdit, mutationQueueKey } from "../src/coding-tools.ts";
import { ShellError } from "../src/errors.ts";
import { limitToolText, toolResultText, truncateMiddle, validateToolArgs } from "../src/tools.ts";

const bashSchema = {
	type: "object",
	properties: {
		command: { type: "string", description: "Command to execute" },
		timeoutSeconds: { type: "number" },
	},
	required: ["command"],
};

test("validateToolArgs: valid args pass; extra properties are permitted", () => {
	assert.deepEqual(validateToolArgs(bashSchema, { command: "ls" }), []);
	assert.deepEqual(validateToolArgs(bashSchema, { command: "ls", timeoutSeconds: 5 }), []);
	assert.deepEqual(validateToolArgs(bashSchema, { command: "ls", junk: true }), []);
	// integer satisfies "number"
	assert.deepEqual(validateToolArgs(bashSchema, { command: "ls", timeoutSeconds: 120 }), []);
});

test("validateToolArgs: missing required and wrong types are reported", () => {
	const missing = validateToolArgs(bashSchema, {});
	assert.equal(missing.length, 1);
	assert.match(missing[0], /missing required property "command"/);

	const wrongType = validateToolArgs(bashSchema, { command: 42 });
	assert.match(wrongType[0], /command: expected string, got integer/);

	const both = validateToolArgs(bashSchema, { timeoutSeconds: "soon" });
	assert.equal(both.length, 2); // missing command + wrong timeoutSeconds type
});

test("validateToolArgs: enum, items, nested objects, and type arrays", () => {
	const schema = {
		type: "object",
		properties: {
			mode: { type: "string", enum: ["fast", "slow"] },
			tags: { type: "array", items: { type: "string" } },
			options: {
				type: "object",
				properties: { depth: { type: "integer" } },
				required: ["depth"],
			},
			label: { type: ["string", "null"] },
		},
		required: ["mode"],
	};
	assert.deepEqual(
		validateToolArgs(schema, { mode: "fast", tags: ["a", "b"], options: { depth: 2 }, label: null }),
		[],
	);

	assert.match(validateToolArgs(schema, { mode: "turbo" })[0], /mode: must be one of "fast", "slow"/);
	assert.match(
		validateToolArgs(schema, { mode: "fast", tags: ["a", 1] })[0],
		/tags\[1\]: expected string, got integer/,
	);
	assert.match(
		validateToolArgs(schema, { mode: "fast", options: {} })[0],
		/options: missing required property "depth"/,
	);
	assert.match(validateToolArgs(schema, { mode: "fast", options: { depth: 1.5 } })[0], /depth: expected integer/);
	assert.match(validateToolArgs(schema, { mode: "fast", label: 3 })[0], /label: expected string \| null, got integer/);
});

test("validateToolArgs: schemas without recognized keywords accept anything", () => {
	assert.deepEqual(validateToolArgs({}, { anything: [1, 2, 3] }), []);
	assert.deepEqual(validateToolArgs({ description: "opaque" }, {}), []);
});

test("edit writes newText literally: $ replacement patterns are not interpreted (HF-13)", async () => {
	const files = new Map<string, string>([["a.sh", "echo OLD\n"]]);
	const fsCap = {
		cwd: "/w",
		readTextFile: async (path: string) => {
			const value = files.get(path);
			if (value === undefined) throw new Error("missing");
			return value;
		},
		writeTextFile: async (path: string, content: string) => {
			files.set(path, content);
		},
		listDir: async () => [],
		stat: async () => undefined,
	};
	const tools = createCodingToolsForEdit({ fs: fsCap as never });
	const edit = tools.find((tool) => tool.name === "edit");
	assert.ok(edit);
	const newText = "echo $$ && echo $& $` $' $HOME";
	const result = await edit.execute({ path: "a.sh", oldText: "echo OLD", newText }, undefined, () => {}, {} as never);
	assert.equal(result.isError, undefined, toolResultText(result));
	assert.equal(files.get("a.sh"), `${newText}\n`);
});

test("mutation queue key folds Windows spellings of one file (HF-14)", () => {
	assert.equal(mutationQueueKey("C:\\work\\a.ts"), mutationQueueKey("c:/work/a.ts"));
	assert.equal(mutationQueueKey("C:/work/./src/../a.ts"), "c:/work/a.ts");
	assert.equal(mutationQueueKey("src\\a.ts"), mutationQueueKey("src/a.ts"));
	assert.notEqual(mutationQueueKey("C:/a.ts"), mutationQueueKey("D:/a.ts"));
	assert.equal(mutationQueueKey("/usr/./lib/x"), "/usr/lib/x");
});

test("truncateMiddle keeps head and tail within the byte budget, at character boundaries (pi)", () => {
	assert.deepEqual(truncateMiddle("short", 100).truncated, false);
	const text = `${"a".repeat(30)}${"中".repeat(30)}${"z".repeat(30)}`;
	const result = truncateMiddle(text, 40);
	assert.equal(result.truncated, true);
	assert.match(result.content, /^a{20}…\d+ chars truncated…z{20}$/);
	assert.equal(result.removedChars, 90 - 40);
	const limited = limitToolText("x".repeat(30_000), 20 * 1024, () => "[where]");
	assert.match(limited, /^Warning: truncated output \(original token count: 7500\)\nTotal output lines: 1\n\n/);
	assert.ok(limited.endsWith("\n\n[where]"));
	assert.equal(
		limitToolText("small", 20 * 1024, () => "never"),
		"small",
	);
});

test("mutationQueueKey resolves relative paths against the filesystem cwd (P23e)", () => {
	assert.equal(mutationQueueKey("src/a.ts", "D:\\repo"), mutationQueueKey("D:/repo/src/a.ts"));
	assert.equal(mutationQueueKey("./src/../src/a.ts", "/repo"), mutationQueueKey("/repo/src/a.ts"));
	assert.equal(mutationQueueKey("/abs/a.ts", "/repo"), "/abs/a.ts");
});

test("bash stopped by its timeout reports what it printed and how to give it longer", async () => {
	const shell = {
		exec: async (_command: string, options: { onStdout?: (chunk: string) => void; timeoutSeconds?: number }) => {
			options.onStdout?.("compiling 1/3\ncompiling 2/3\n");
			throw new ShellError("timeout", `Command timed out after ${options.timeoutSeconds}s`);
		},
	};
	const bash = createCodingToolsForEdit({ shell: shell as never }).find((tool) => tool.name === "bash");
	assert.ok(bash);
	const result = await bash.execute({ command: "make", timeoutSeconds: 5 }, undefined);
	assert.equal(result.isError, true);
	const text = toolResultText(result);
	assert.match(text, /compiling 2\/3/);
	assert.match(text, /stopped after the 5s timeout/);
	assert.match(text, /larger timeoutSeconds/);
});
