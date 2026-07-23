import { test } from "node:test";
import assert from "node:assert/strict";
import { addDays, localInstantUTC, timelineWindow, expandWindow, groupByDay, dayHeading } from "../src/web/planner.js";

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

test("groupByDay buckets by day, newest-future day first, newest item first within a day", () => {
  const items = [
    { id: "a", day: "2026-07-22", logged_at: "2026-07-22T08:00:00.000Z" },
    { id: "b", day: "2026-07-24", logged_at: "2026-07-24T07:30:00.000Z" },
    { id: "c", day: "2026-07-22", logged_at: "2026-07-22T19:00:00.000Z" },
    { id: "d", day: "2026-07-23", logged_at: "2026-07-23T12:00:00.000Z" },
  ];
  const g = groupByDay(items);
  assert.deepEqual(g.map((x) => x.day), ["2026-07-24", "2026-07-23", "2026-07-22"]);
  // Within 2026-07-22, the later logged_at (19:00) comes first (descending).
  assert.deepEqual(g[2].items.map((i) => i.id), ["c", "a"]);
});

test("groupByDay ascending mode reverses the day + intra-day order", () => {
  const items = [
    { id: "b", day: "2026-07-24", logged_at: "2026-07-24T07:30:00.000Z" },
    { id: "a", day: "2026-07-22", logged_at: "2026-07-22T08:00:00.000Z" },
  ];
  const g = groupByDay(items, { descending: false });
  assert.deepEqual(g.map((x) => x.day), ["2026-07-22", "2026-07-24"]);
});

test("groupByDay falls back to logged_at's date when day is absent", () => {
  const g = groupByDay([{ id: "x", logged_at: "2026-07-25T06:00:00.000Z" }]);
  assert.equal(g[0].day, "2026-07-25");
});

test("dayHeading classifies today/yesterday/tomorrow and returns null otherwise", () => {
  assert.equal(dayHeading("2026-07-23", "2026-07-23"), "Today");
  assert.equal(dayHeading("2026-07-22", "2026-07-23"), "Yesterday");
  assert.equal(dayHeading("2026-07-24", "2026-07-23"), "Tomorrow");
  assert.equal(dayHeading("2026-07-30", "2026-07-23"), null);
});
