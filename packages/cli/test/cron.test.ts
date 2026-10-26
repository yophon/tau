// The session's cron (P44): the gateway's P31 cases, moved with the code when the gateway was archived (P62).
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { nextCronTime, parseCron } from "../src/cron.ts";

const SH = "Asia/Shanghai";
const NY = "America/New_York";
const at = (iso: string) => Date.parse(iso);

describe("cron", () => {
	it("parses the five fields with lists, ranges, steps and Sunday as 0 or 7", () => {
		const spec = parseCron("0,30 9-11 */10 1-12/6 7");
		assert.deepEqual([...spec.minutes], [0, 30]);
		assert.deepEqual([...spec.hours], [9, 10, 11]);
		assert.deepEqual([...spec.days], [1, 11, 21, 31]);
		assert.deepEqual([...spec.months], [1, 7]);
		assert.deepEqual([...spec.weekdays], [0]);
		assert.throws(() => parseCron("0 9 * *"), /5 fields/);
		assert.throws(() => parseCron("60 9 * * *"), /minute: "60" is outside 0–59/);
		assert.throws(() => parseCron("0 9 * * mon"), /day of week: "mon" is not a number/);
		assert.throws(() => parseCron("*/0 * * * *"), /step must be at least 1/);
	});

	it("finds the next firing in a zone", () => {
		// 2026-10-18 10:00 in Shanghai is 02:00Z; the next 09:00 is tomorrow, 01:00Z.
		const daily = parseCron("0 9 * * *");
		assert.equal(nextCronTime(daily, at("2026-10-18T02:00:00Z"), SH), at("2026-10-19T01:00:00Z"));
		assert.equal(nextCronTime(daily, at("2026-10-18T00:59:00Z"), SH), at("2026-10-18T01:00:00Z"));
		// Strictly after: a firing exactly now is not the next one.
		assert.equal(nextCronTime(daily, at("2026-10-18T01:00:00Z"), SH), at("2026-10-19T01:00:00Z"));
		// Monday 2026-10-19 at 08:00 Shanghai.
		assert.equal(nextCronTime(parseCron("0 8 * * 1"), at("2026-10-17T00:00:00Z"), SH), at("2026-10-19T00:00:00Z"));
		assert.equal(nextCronTime(parseCron("0 9 30 2 *"), at("2026-10-17T00:00:00Z"), SH), undefined);
	});

	it("ORs day of month and day of week when both are restricted (Vixie)", () => {
		// The 1st of the month or a Monday, 09:00: after Sat 2026-10-17 the next is Mon the 19th.
		const spec = parseCron("0 9 1 * 1");
		assert.equal(nextCronTime(spec, at("2026-10-17T00:00:00Z"), SH), at("2026-10-19T01:00:00Z"));
		// After Fri 2026-10-30 the next is Sun 1 November (the 1st).
		assert.equal(nextCronTime(spec, at("2026-10-30T02:00:00Z"), SH), at("2026-11-01T01:00:00Z"));
	});

	it("skips a wall time that DST removes and fires a repeated one once", () => {
		// 2026-03-08 02:30 does not exist in New York; the next 02:30 is on the 9th (EDT, 06:30Z).
		const spring = parseCron("30 2 * * *");
		assert.equal(nextCronTime(spring, at("2026-03-07T17:00:00Z"), NY), at("2026-03-09T06:30:00Z"));
		// 2026-11-01 01:30 happens twice; it fires at the first (EDT, 05:30Z), then the next day (EST, 06:30Z).
		const fall = parseCron("30 1 * * *");
		const first = nextCronTime(fall, at("2026-10-31T16:00:00Z"), NY);
		assert.equal(first, at("2026-11-01T05:30:00Z"));
		assert.equal(nextCronTime(fall, first ?? 0, NY), at("2026-11-02T06:30:00Z"));
	});
});
