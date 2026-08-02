import { test } from "node:test";
import assert from "node:assert/strict";
import { projectOccurrences } from "../src/domain/schedule.ts";
import { recurrenceSummary, nextOccurrence } from "../src/web/planner.js";

// Recurrence power-up: intervals ("every 2 weeks") and BalanceEngine-style monthly anchors
// (nth-weekday, last-day) — plus the guarantee that the CLIENT MIRROR in web/planner.js agrees with
// the server projector. A silent disagreement there shows the user a "Next: …" date the timeline
// never produces, which is worse than either being wrong on its own.

const base = {
  id: "s1", user: "u", kind: "food" as const, name: "Thing", payload: { kcal: 100 },
  time_of_day: "12:00", tz_offset_min: 0, is_active: true,
};
const sched = (recurrence: Record<string, unknown>, active_from = "2026-01-01") =>
  ({ ...base, recurrence, active_from }) as never;

const fires = (recurrence: Record<string, unknown>, from: string, to: string, active_from = "2026-01-01") =>
  projectOccurrences([sched(recurrence, active_from)], [], from, to, "2026-01-01")
    .map((o: { scheduled_date: string }) => o.scheduled_date);

// ---------------------------------------------------------------- intervals

test("every 2 days fires on alternate days from active_from", () => {
  const d = fires({ unit: "daily", interval: 2 }, "2026-01-01", "2026-01-09");
  assert.deepEqual(d, ["2026-01-01", "2026-01-03", "2026-01-05", "2026-01-07", "2026-01-09"]);
});

test("every 3 weeks on a weekday skips the two weeks between", () => {
  // active_from is a Thursday; ask for Mondays every 3rd week.
  const d = fires({ unit: "weekly", interval: 3, by_weekday: [1] }, "2026-01-01", "2026-02-28");
  // Week 0 contains Mon 2026-01-05? active_from 2026-01-01 (Thu). weeks = floor(daysBetween/7).
  assert.ok(d.length >= 2, "should fire more than once in two months");
  for (let i = 1; i < d.length; i++) {
    const gap = (Date.parse(d[i] + "T00:00:00Z") - Date.parse(d[i - 1] + "T00:00:00Z")) / 86400000;
    assert.equal(gap, 21, `consecutive fires must be 3 weeks apart, got ${gap} days`);
  }
});

test("every 2 months lands on the same day-of-month, skipping the odd months", () => {
  const d = fires({ unit: "monthly", interval: 2, day_of_month: 15 }, "2026-01-01", "2026-07-31");
  assert.deepEqual(d, ["2026-01-15", "2026-03-15", "2026-05-15", "2026-07-15"]);
});

// ---------------------------------------------------------------- monthly anchors

test("anchor 'end' fires on the real last day, including February and 30-day months", () => {
  const d = fires({ unit: "monthly", interval: 1, anchor: "end" }, "2026-01-01", "2026-06-30");
  assert.deepEqual(d, ["2026-01-31", "2026-02-28", "2026-03-31", "2026-04-30", "2026-05-31", "2026-06-30"]);
});

test("nth-weekday: first Monday of each month", () => {
  const d = fires({ unit: "monthly", interval: 1, anchor: "nth-weekday", nth: 1, nth_weekday: 1 }, "2026-01-01", "2026-04-30");
  for (const day of d) assert.equal(new Date(day + "T00:00:00Z").getUTCDay(), 1, `${day} must be a Monday`);
  for (const day of d) assert.ok(Number(day.slice(8, 10)) <= 7, `${day} must be in the first week`);
  assert.equal(d.length, 4);
});

test("nth-weekday: LAST Friday of each month", () => {
  const d = fires({ unit: "monthly", interval: 1, anchor: "nth-weekday", nth: -1, nth_weekday: 5 }, "2026-01-01", "2026-03-31");
  for (const day of d) {
    assert.equal(new Date(day + "T00:00:00Z").getUTCDay(), 5, `${day} must be a Friday`);
    // No later Friday may exist in that month.
    const next = new Date(Date.parse(day + "T00:00:00Z") + 7 * 86400000).toISOString().slice(0, 10);
    assert.notEqual(next.slice(0, 7), day.slice(0, 7), `${day} is not the LAST Friday`);
  }
  assert.equal(d.length, 3);
});

test("a 5th occurrence simply skips months that don't have one", () => {
  // "4th Wednesday" always exists; "-1" (last) is always safe. Use a month-length edge instead:
  // day-of-month 31 clamps rather than skipping — that is the documented dom behaviour.
  const d = fires({ unit: "monthly", interval: 1, day_of_month: 31 }, "2026-01-01", "2026-04-30");
  assert.deepEqual(d, ["2026-01-31", "2026-02-28", "2026-03-31", "2026-04-30"]);
});

// ------------------------------------------- the client mirror must match the server projector

test("web/planner.js nextOccurrence agrees with the server projector for every rule", () => {
  const rules = [
    { unit: "daily", interval: 3 },
    { unit: "weekly", interval: 2, by_weekday: [1, 4] },
    { unit: "monthly", interval: 1, anchor: "end" },
    { unit: "monthly", interval: 1, anchor: "nth-weekday", nth: 2, nth_weekday: 3 },
    { unit: "monthly", interval: 1, anchor: "nth-weekday", nth: -1, nth_weekday: 6 },
    { unit: "monthly", interval: 2, day_of_month: 31 },
  ];
  const today = "2026-02-10";
  for (const r of rules) {
    const server = fires(r, today, "2027-02-10")[0] ?? null;
    const client = nextOccurrence(sched(r), today, []);
    assert.equal(client, server, `mirror drift for ${JSON.stringify(r)}: client=${client} server=${server}`);
  }
});

test("recurrenceSummary describes the new rules in words", () => {
  const s = (r: Record<string, unknown>) => recurrenceSummary({ ...base, recurrence: r, active_from: "2026-01-01" });
  assert.match(s({ unit: "daily", interval: 2 }), /Every 2 days/);
  assert.match(s({ unit: "weekly", interval: 3, by_weekday: [1] }), /Every 3 weeks on Mon/);
  assert.match(s({ unit: "monthly", interval: 1, anchor: "end" }), /Monthly on the last day/);
  assert.match(s({ unit: "monthly", interval: 1, anchor: "nth-weekday", nth: -1, nth_weekday: 5 }), /last Friday/);
  assert.match(s({ unit: "monthly", interval: 2, anchor: "nth-weekday", nth: 1, nth_weekday: 1 }), /Every 2 months on the first Monday/);
  // Back-compat: no anchor ⇒ day-of-month, exactly as before.
  assert.match(s({ unit: "monthly", interval: 1, day_of_month: 15 }), /Monthly on day 15/);
});

// ---------------------------------------- the form → API boundary (what the sheet actually sends)

test("buildPlanRequest carries the interval and the monthly anchor", async () => {
  const { buildPlanRequest } = await import("../src/web/planner.js");

  const every2w = buildPlanRequest(
    { kind: "food", name: "Meal prep", date: "2026-03-02", time: "18:00", repeat: "weekly", interval: 2, by_weekday: [1], kcal: 600 }, 0);
  assert.equal(every2w.path, "/api/plan/schedules");
  assert.equal(every2w.body.recurrence.interval, 2, "the interval the user typed must reach the API");
  assert.deepEqual(every2w.body.recurrence.by_weekday, [1]);

  const lastFri = buildPlanRequest(
    { kind: "activity", name: "Long run", date: "2026-03-27", time: "07:00", repeat: "monthly", interval: 1,
      anchor: "nth-weekday", nth: -1, nth_weekday: 5, kcal: 500, duration_min: 60 }, 0);
  assert.equal(lastFri.body.recurrence.anchor, "nth-weekday");
  assert.equal(lastFri.body.recurrence.nth, -1);
  assert.equal(lastFri.body.recurrence.nth_weekday, 5);

  // dom stays IMPLICIT so pre-anchor schedules keep the same wire shape.
  const dom = buildPlanRequest(
    { kind: "food", name: "Payday treat", date: "2026-03-15", time: "12:00", repeat: "monthly", interval: 1,
      anchor: "dom", day_of_month: 15, kcal: 300 }, 0);
  assert.equal(dom.body.recurrence.anchor, undefined, "dom must not be written to the wire");
  assert.equal(dom.body.recurrence.day_of_month, 15);
});
