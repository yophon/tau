// defaultPlatform is the seam itself, so unlike other kernel tests this one
// legitimately touches host globals (Node's timers/AbortController).
import assert from "node:assert/strict";
import { test } from "node:test";
import { TauError } from "../src/errors.ts";
import { defaultPlatform } from "../src/platform.ts";
import { TestAbortController } from "./helpers.ts";

test("sleep resolves after the delay and rejects on abort", async () => {
	const platform = defaultPlatform();
	assert.ok(platform.sleep);
	await platform.sleep(1);

	const controller = new TestAbortController();
	const pending = platform.sleep(60_000, controller.signal);
	controller.abort();
	await assert.rejects(pending, (error: unknown) => error instanceof TauError && error.code === "aborted");
});

test("sleep with an already-aborted signal rejects with TauError aborted (not a TDZ ReferenceError)", async () => {
	const platform = defaultPlatform();
	assert.ok(platform.sleep);
	const controller = new TestAbortController();
	controller.abort();
	await assert.rejects(
		platform.sleep(60_000, controller.signal),
		(error: unknown) => error instanceof TauError && error.code === "aborted",
	);
});
