import { test } from "node:test";
import assert from "node:assert/strict";
import { PlanSchedule, PlanOverride } from "../src/schema/index.ts";

test("PlanSchedule applies defaults (interval, is_active, payload, kind)", () => {
  const s = PlanSchedule.parse({
    id: "s1", user: "u", name: "Oats",
    recurrence: { unit: "daily" },
    active_from: "2026-07-01",
  });
  assert.equal(s.kind, "food");
  assert.equal(s.recurrence.interval, 1);
  assert.equal(s.is_active, true);
  assert.deepEqual(s.payload, {});
  assert.equal(s.time_of_day, "12:00");
  assert.equal(s.tz_offset_min, 0);
});

test("PlanSchedule keeps weekly by_weekday and open-ended active_to", () => {
  const s = PlanSchedule.parse({
    id: "s1", user: "u", kind: "activity", name: "Run",
    recurrence: { unit: "weekly", interval: 2, by_weekday: [1, 3, 5] },
    payload: { kcal: 250 }, time_of_day: "06:00", tz_offset_min: 300,
    active_from: "2026-07-01",
  });
  assert.deepEqual(s.recurrence.by_weekday, [1, 3, 5]);
  assert.equal(s.active_to, undefined);
  assert.equal(s.payload.kcal, 250);
});

test("PlanSchedule rejects a bad recurrence unit", () => {
  assert.throws(() => PlanSchedule.parse({
    id: "s1", user: "u", name: "x", recurrence: { unit: "yearly" }, active_from: "2026-07-01",
  }));
});

test("PlanOverride defaults is_skipped false and allows new_time/new_payload", () => {
  const o = PlanOverride.parse({ id: "o1", user: "u", schedule_id: "s1", scheduled_date: "2026-07-11" });
  assert.equal(o.is_skipped, false);
  const o2 = PlanOverride.parse({
    id: "o2", user: "u", schedule_id: "s1", scheduled_date: "2026-07-12",
    new_time: "20:00", new_payload: { kcal: 550 },
  });
  assert.equal(o2.new_time, "20:00");
  assert.equal(o2.new_payload!.kcal, 550);
});
