import assert from "node:assert/strict";
import { test } from "node:test";
import { validateToolArgs } from "../src/tools.ts";

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
