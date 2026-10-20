// P38b: the edit tool's display diff in pi's generateDiffString format (numbered lines,
// four lines of context, "..." for skipped runs), computed from the touched lines only.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { applyEdits } from "../src/coding-tools.ts";
import { editDiff, type LocatedEdit } from "../src/edit-diff.ts";

const lines = (count: number) => `${Array.from({ length: count }, (_, i) => `l${i + 1}`).join("\n")}\n`;
const at = (content: string, oldText: string, newText: string): LocatedEdit => ({
	at: content.indexOf(oldText),
	oldText,
	newText,
});

describe("P38b editDiff (pi generateDiffString)", () => {
	it("numbers the change in the file, with four lines of context and ... for the rest", () => {
		const content = lines(12);
		const { diff, firstChangedLine } = editDiff(content, [at(content, "l6\n", "L6\n")]);
		assert.equal(firstChangedLine, 6);
		assert.equal(
			diff,
			[
				"    ...",
				"  2 l2",
				"  3 l3",
				"  4 l4",
				"  5 l5",
				"- 6 l6",
				"+ 6 L6",
				"  7 l7",
				"  8 l8",
				"  9 l9",
				" 10 l10",
				"    ...",
			].join("\n"),
		);
	});

	it("shows a short run between two edits whole and diffs inside a multi-line replacement", () => {
		const content = lines(12);
		const { diff } = editDiff(content, [at(content, "l2\n", "L2\n"), at(content, "l9\nl10\nl11", "l9\nX\nl11")]);
		const rows = diff.split("\n");
		assert.deepEqual(rows.slice(0, 3), ["  1 l1", "- 2 l2", "+ 2 L2"]);
		// l3..l9 (7 lines, under 2 × 4) stay, then the one changed line inside the block.
		assert.ok(rows.includes("  9 l9"));
		assert.ok(rows.includes("-10 l10"));
		assert.ok(rows.includes("+10 X"));
		assert.ok(rows.includes(" 11 l11"));
		assert.ok(!rows.slice(0, rows.indexOf("-10 l10")).includes("    ..."));
	});

	it("two edits on one line are one change; added lines shift the new numbering", () => {
		const content = "a\nx = 1; y = 2\nb\n";
		const { diff } = editDiff(content, [at(content, "1", "10"), at(content, "2", "20\nz = 3")]);
		assert.equal(diff, [" 1 a", "-2 x = 1; y = 2", "+2 x = 10; y = 20", "+3 z = 3", " 3 b"].join("\n"));
		assert.equal(applyEdits(content, [{ oldText: "1", newText: "10" }], "f"), "a\nx = 10; y = 2\nb\n");
	});

	it("CRLF lines come without their carriage return; the final newline is no line of its own (pi)", () => {
		const crlf = "line1\r\nline2\r\nline3\r\n";
		assert.equal(
			editDiff(crlf, [at(crlf, "line2", "LINE2")]).diff,
			[" 1 line1", "-2 line2", "+2 LINE2", " 3 line3"].join("\n"),
		);
		// Removing the final newline, then adding lines after a last line without one.
		assert.equal(editDiff("a\nb\n", [at("a\nb\n", "b\n", "c")]).diff, [" 1 a", "-2 b", "+2 c"].join("\n"));
		assert.equal(editDiff("a\nb", [at("a\nb", "b", "b\nc\n")]).diff, [" 1 a", "-2 b", "+2 b", "+3 c"].join("\n"));
	});
});
