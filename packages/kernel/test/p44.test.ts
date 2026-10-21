// P44: forms (MCP elicitation's form mode), commands registered again by the same
// extension, and command prompts with images.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
	askFormStepByStep,
	commandPromptContent,
	ExtensionRegistry,
	formErrors,
	formFieldError,
	formValueText,
	parseFormText,
	type UiCapability,
	type UiForm,
	type UiFormField,
} from "../src/index.ts";

const field = (extra: Partial<UiFormField> & Pick<UiFormField, "type">): UiFormField => ({
	name: "f",
	title: "F",
	required: false,
	...extra,
});

test("formFieldError checks required, lengths, patterns, formats, ranges and choices", () => {
	assert.equal(formFieldError(field({ type: "string", required: true }), ""), "Required");
	assert.equal(formFieldError(field({ type: "string" }), undefined), undefined);
	assert.equal(formFieldError(field({ type: "string", minLength: 3 }), "ab"), "At least 3 characters");
	assert.equal(formFieldError(field({ type: "string", maxLength: 2 }), "日本語"), "At most 2 characters");
	assert.equal(formFieldError(field({ type: "string", pattern: "^[a-z]+$" }), "A1"), "Must match ^[a-z]+$");
	assert.equal(formFieldError(field({ type: "string", format: "email" }), "a@b.co"), undefined);
	assert.equal(formFieldError(field({ type: "string", format: "email" }), "nope"), "Enter an email address");
	assert.equal(formFieldError(field({ type: "string", format: "uri" }), "https://x.y/z"), undefined);
	assert.equal(formFieldError(field({ type: "string", format: "date" }), "2026-02-29"), "Enter a date (YYYY-MM-DD)");
	assert.equal(formFieldError(field({ type: "string", format: "date" }), "2028-02-29"), undefined);
	assert.equal(formFieldError(field({ type: "string", format: "date-time" }), "2026-10-21T09:30:00Z"), undefined);
	assert.equal(formFieldError(field({ type: "integer", minimum: 1 }), 0), "At least 1");
	assert.equal(formFieldError(field({ type: "integer" }), 1.5), "Enter a whole number");
	assert.equal(formFieldError(field({ type: "number", maximum: 10 }), 10), undefined);
	const options = [
		{ value: "r", label: "Red" },
		{ value: "g", label: "Green" },
	];
	assert.equal(formFieldError(field({ type: "select", options }), "b"), "Choose one of the options");
	assert.equal(formFieldError(field({ type: "multiselect", options, maxItems: 1 }), ["r", "g"]), "Choose at most 1");
	assert.equal(formFieldError(field({ type: "multiselect", options, minItems: 1, required: true }), []), "Required");
	assert.equal(formValueText(field({ type: "multiselect", options }), ["r", "g"]), "Red, Green");
	assert.deepEqual(parseFormText(field({ type: "number" }), " 4.5 "), { value: 4.5 });
	assert.deepEqual(parseFormText(field({ type: "number" }), "x"), { error: "Enter a number" });
	const form: UiForm = {
		title: "t",
		fields: [field({ name: "a", type: "string", required: true }), field({ name: "b", type: "boolean" })],
	};
	assert.deepEqual(formErrors(form, { b: true }), { a: "Required" });
});

test("askFormStepByStep: booleans, choices, multi-select without selectMany, Enter keeps a default, cancel cancels", async () => {
	const answers: Array<string | undefined> = ["Fill in", "Yes", "Green", "r, g", ""];
	const ui: UiCapability = {
		confirm: async () => true,
		select: async () => answers.shift(),
		input: async () => answers.shift(),
		notify: () => {},
	};
	const options = [
		{ value: "r", label: "Red" },
		{ value: "g", label: "Green" },
	];
	const form: UiForm = {
		title: "MCP server",
		fields: [
			field({ name: "ok", type: "boolean", required: true }),
			field({ name: "color", type: "select", options, required: true }),
			field({ name: "tags", type: "multiselect", options: [...options] }),
			field({ name: "who", type: "string", default: "octo" }),
		],
	};
	// "r, g" are values, not labels: the step maps labels and keeps unknown words as they are.
	const result = await askFormStepByStep(ui, form);
	assert.equal(result?.action, "submit");
	if (result?.action === "submit") {
		assert.equal(result.values.ok, true);
		assert.equal(result.values.color, "g");
		assert.equal(result.values.who, "octo");
	}
	const cancelled = await askFormStepByStep({ ...ui, select: async () => undefined }, form);
	assert.equal(cancelled, undefined);
});

test("the same extension registering a command name again replaces it; another extension's gets a suffix", async () => {
	const registry = await ExtensionRegistry.load([
		(api) => {
			api.registerCommand("p", { description: "first", handler: () => "1" });
			api.registerCommand("p", { description: "second", hidden: true, handler: () => "2" });
		},
		(api) => {
			api.registerCommand("p", { description: "other", handler: () => "3" });
		},
	]);
	assert.deepEqual([...registry.commands.keys()].sort(), ["p:1", "p:2"]);
	assert.equal(registry.commands.get("p:1")?.description, "second");
	assert.equal(registry.commands.get("p:1")?.hidden, true);
	assert.equal(registry.commands.get("p:2")?.description, "other");
});

test("a command prompt with images becomes text followed by the images", () => {
	assert.equal(commandPromptContent({ text: "hi" }), "hi");
	assert.deepEqual(
		commandPromptContent({ text: "hi", images: [{ type: "image", data: "AA", mimeType: "image/png" }] }),
		[
			{ type: "text", text: "hi" },
			{ type: "image", data: "AA", mimeType: "image/png" },
		],
	);
});
