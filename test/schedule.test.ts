import { test } from "node:test";
import assert from "node:assert/strict";
import { projectOccurrences, localInstantUTC, type PlanSchedule } from "../src/domain/schedule.ts";

// A minimal daily schedule factory; override fields per test.
function daily(over: Partial<PlanSchedule> = {}): PlanSchedule {
  return {
    id: "s1", user: "u", kind: "food", name: "Oats",
    payload: { kcal: 300, description: "Overnight oats" },
    recurrence: { unit: "daily", interval: 1 },
    time_of_day: "07:30", tz_offset_min: 0,
    active_from: "2026-07-01", is_active: true, ...over,
  };
}

test("daily interval=1 emits one occurrence per day across the window", () => {
  const occ = projectOccurrences([daily()], [], "2026-07-10", "2026-07-13", "2026-07-10");
  assert.deepEqual(occ.map((o) => o.scheduled_date), ["2026-07-10", "2026-07-11", "2026-07-12", "2026-07-13"]);
  assert.equal(occ[0].id, "s1:2026-07-10");
  assert.equal(occ[0].kind, "food");
  assert.equal(occ[0].name, "Oats");
  assert.deepEqual(occ[0].payload, { kcal: 300, description: "Overnight oats" });
  assert.equal(occ[0].is_overridden, false);
});

test("daily interval=3 emits every third day counted from active_from", () => {
  // active_from 2026-07-01; fires on 01,04,07,10,13,16,19,22,25 — window picks 2026-07-10..-19.
  const occ = projectOccurrences([daily({ recurrence: { unit: "daily", interval: 3 } })],
    [], "2026-07-10", "2026-07-19", "2026-07-10");
  assert.deepEqual(occ.map((o) => o.scheduled_date), ["2026-07-10", "2026-07-13", "2026-07-16", "2026-07-19"]);
});

test("future-only: occurrences before todayLocal are dropped even if in the window", () => {
  const occ = projectOccurrences([daily()], [], "2026-07-01", "2026-07-05", "2026-07-03");
  assert.deepEqual(occ.map((o) => o.scheduled_date), ["2026-07-03", "2026-07-04", "2026-07-05"]);
});

test("active_from and active_to bound the series", () => {
  const occ = projectOccurrences([daily({ active_from: "2026-07-12", active_to: "2026-07-14" })],
    [], "2026-07-10", "2026-07-20", "2026-07-01");
  assert.deepEqual(occ.map((o) => o.scheduled_date), ["2026-07-12", "2026-07-13", "2026-07-14"]);
});

test("an inactive schedule emits nothing", () => {
  const occ = projectOccurrences([daily({ is_active: false })], [], "2026-07-10", "2026-07-12", "2026-07-01");
  assert.equal(occ.length, 0);
});

test("logged_at is the local wall-clock instant in UTC and day == scheduled_date (tz=0)", () => {
  const occ = projectOccurrences([daily({ time_of_day: "07:30", tz_offset_min: 0 })],
    [], "2026-07-10", "2026-07-10", "2026-07-10");
  assert.equal(occ[0].logged_at, "2026-07-10T07:30:00.000Z");
  assert.equal(occ[0].day, "2026-07-10");
  assert.equal(occ[0].time_of_day, "07:30");
});

test("tz_offset_min shifts logged_at but day stays the local scheduled_date (America/Chicago = 300)", () => {
  // 08:00 local at offset 300 (UTC = local + 300min) => 13:00 UTC, still the same local day.
  const occ = projectOccurrences([daily({ time_of_day: "08:00", tz_offset_min: 300 })],
    [], "2026-07-10", "2026-07-10", "2026-07-10");
  assert.equal(occ[0].logged_at, "2026-07-10T13:00:00.000Z");
  assert.equal(occ[0].day, "2026-07-10");
});

test("localInstantUTC is the inverse of dayKey by construction", () => {
  // Late-evening local time west of UTC crosses into the next UTC day, but the local day is preserved.
  const iso = localInstantUTC("2026-07-10", "23:30", 300);
  assert.equal(iso, "2026-07-11T04:30:00.000Z");
});

function weekly(over: Partial<PlanSchedule> = {}): PlanSchedule {
  return {
    id: "w1", user: "u", kind: "activity", name: "Run",
    payload: { kcal: 250, duration_min: 30 },
    recurrence: { unit: "weekly", interval: 1, by_weekday: [1, 3, 5] }, // Mon/Wed/Fri
    time_of_day: "06:00", tz_offset_min: 0,
    active_from: "2026-07-01", is_active: true, ...over,
  };
}

test("weekly by_weekday emits only the listed weekdays", () => {
  // 2026-07-06 Mon, -07 Tue, -08 Wed, -09 Thu, -10 Fri, -11 Sat, -12 Sun.
  const occ = projectOccurrences([weekly()], [], "2026-07-06", "2026-07-12", "2026-07-01");
  assert.deepEqual(occ.map((o) => o.scheduled_date), ["2026-07-06", "2026-07-08", "2026-07-10"]);
});

test("weekly with no by_weekday defaults to active_from's weekday", () => {
  // 2026-07-01 is a Wednesday → fire only on Wednesdays.
  const occ = projectOccurrences([weekly({ recurrence: { unit: "weekly", interval: 1 }, active_from: "2026-07-01" })],
    [], "2026-07-06", "2026-07-19", "2026-07-01");
  assert.deepEqual(occ.map((o) => o.scheduled_date), ["2026-07-08", "2026-07-15"]);
});

test("weekly interval=2 fires every other week from active_from", () => {
  // Mondays only, every 2 weeks. active_from 2026-07-01 (Wed); week 0 = 06-28..07-04.
  // Mondays: 07-06 (wk1), 07-13 (wk2), 07-20 (wk3), 07-27 (wk4). weeksDiff = floor((d-active_from)/7).
  // 07-06 diff5 wk0; 07-13 diff12 wk1; 07-20 diff19 wk2; 07-27 diff26 wk3 → even weeks: 07-06, 07-20.
  const occ = projectOccurrences([weekly({ recurrence: { unit: "weekly", interval: 2, by_weekday: [1] } })],
    [], "2026-07-06", "2026-07-31", "2026-07-01");
  assert.deepEqual(occ.map((o) => o.scheduled_date), ["2026-07-06", "2026-07-20"]);
});

function monthly(over: Partial<PlanSchedule> = {}): PlanSchedule {
  return {
    id: "m1", user: "u", kind: "food", name: "Cheat meal",
    payload: { kcal: 1200 },
    recurrence: { unit: "monthly", interval: 1, day_of_month: 15 },
    time_of_day: "18:00", tz_offset_min: 0,
    active_from: "2026-01-15", is_active: true, ...over,
  };
}

test("monthly fires on day_of_month each month", () => {
  const occ = projectOccurrences([monthly()], [], "2026-07-01", "2026-09-30", "2026-07-01");
  assert.deepEqual(occ.map((o) => o.scheduled_date), ["2026-07-15", "2026-08-15", "2026-09-15"]);
});

test("monthly with no day_of_month defaults to active_from's day-of-month", () => {
  const occ = projectOccurrences([monthly({ recurrence: { unit: "monthly", interval: 1 }, active_from: "2026-06-09" })],
    [], "2026-07-01", "2026-08-31", "2026-07-01");
  assert.deepEqual(occ.map((o) => o.scheduled_date), ["2026-07-09", "2026-08-09"]);
});

test("monthly day 31 clamps to the last day of shorter months", () => {
  const occ = projectOccurrences([monthly({ recurrence: { unit: "monthly", interval: 1, day_of_month: 31 }, active_from: "2026-01-31" })],
    [], "2026-02-01", "2026-04-30", "2026-02-01");
  assert.deepEqual(occ.map((o) => o.scheduled_date), ["2026-02-28", "2026-03-31", "2026-04-30"]);
});

test("monthly interval=2 fires every other month from active_from", () => {
  const occ = projectOccurrences([monthly({ recurrence: { unit: "monthly", interval: 2, day_of_month: 10 }, active_from: "2026-01-10" })],
    [], "2026-01-01", "2026-06-30", "2026-01-01");
  assert.deepEqual(occ.map((o) => o.scheduled_date), ["2026-01-10", "2026-03-10", "2026-05-10"]);
});
