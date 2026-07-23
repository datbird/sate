import { test } from "node:test";
import assert from "node:assert/strict";
import { addDays, localInstantUTC, timelineWindow, expandWindow } from "../src/web/planner.js";

test("addDays does UTC-anchored calendar math across a month boundary", () => {
  assert.equal(addDays("2026-07-30", 3), "2026-08-02");
  assert.equal(addDays("2026-03-01", -1), "2026-02-28");
  assert.equal(addDays("2026-07-23", 0), "2026-07-23");
});

test("localInstantUTC is the inverse of dayKey (local wall-clock → UTC)", () => {
  assert.equal(localInstantUTC("2026-07-10", "07:30", 0), "2026-07-10T07:30:00.000Z");
  // 300 = America/Chicago getTimezoneOffset; UTC = local + 300min.
  assert.equal(localInstantUTC("2026-07-10", "08:00", 300), "2026-07-10T13:00:00.000Z");
  // Late local evening west of UTC crosses into the next UTC day.
  assert.equal(localInstantUTC("2026-07-10", "23:30", 300), "2026-07-11T04:30:00.000Z");
});

test("timelineWindow centers today with default 7 past / 14 future days", () => {
  assert.deepEqual(timelineWindow("2026-07-23"), { from: "2026-07-16", to: "2026-08-06" });
  assert.deepEqual(timelineWindow("2026-07-23", 2, 3), { from: "2026-07-21", to: "2026-07-26" });
});

test("expandWindow grows the future 'to' on scroll-up and the past 'from' on scroll-down", () => {
  const w = { from: "2026-07-16", to: "2026-08-06" };
  assert.deepEqual(expandWindow(w, "future"), { from: "2026-07-16", to: "2026-08-20" });
  assert.deepEqual(expandWindow(w, "past"), { from: "2026-07-02", to: "2026-08-06" });
  assert.deepEqual(expandWindow(w, "future", 7), { from: "2026-07-16", to: "2026-08-13" });
});
