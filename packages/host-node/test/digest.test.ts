import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { digestDirectory } from "../src/digest.ts";

const dir = mkdtempSync(join(tmpdir(), "tau-digest-"));
after(() => rmSync(dir, { recursive: true, force: true }));

test("digestDirectory: stable across calls, sensitive to content, blind to noise", async () => {
	writeFileSync(join(dir, "ext.ts"), "export default () => {};\n");
	mkdirSync(join(dir, "lib"));
	writeFileSync(join(dir, "lib", "util.ts"), "export const x = 1;\n");

	const first = await digestDirectory(dir);
	const again = await digestDirectory(dir);
	assert.ok(first);
	assert.equal(first, again);

	// Dotfiles and node_modules do not participate.
	writeFileSync(join(dir, ".DS_Store"), "junk");
	mkdirSync(join(dir, "node_modules"));
	writeFileSync(join(dir, "node_modules", "dep.js"), "module.exports = 1;");
	assert.equal(await digestDirectory(dir), first);

	// Content changes do.
	writeFileSync(join(dir, "lib", "util.ts"), "export const x = 2;\n");
	const changed = await digestDirectory(dir);
	assert.notEqual(changed, first);

	// New files do too.
	writeFileSync(join(dir, "extra.ts"), "export {};\n");
	assert.notEqual(await digestDirectory(dir), changed);
});

test("digestDirectory: missing directory is undefined, empty directory is a digest", async () => {
	assert.equal(await digestDirectory(join(dir, "does-not-exist")), undefined);
	const empty = mkdtempSync(join(tmpdir(), "tau-digest-empty-"));
	try {
		assert.ok(await digestDirectory(empty));
	} finally {
		rmSync(empty, { recursive: true, force: true });
	}
});
