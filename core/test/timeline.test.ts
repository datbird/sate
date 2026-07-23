import { test } from "node:test";
import assert from "node:assert/strict";
import { client, TEST_EMAIL } from "./mem.ts";

// today (tz=0) so future-only occurrences land inside the requested window.
const TODAY = new Date().toISOString().slice(0, 10);
function plusDays(base: string, n: number): string {
  return new Date(Date.parse(base + "T00:00:00Z") + n * 86400000).toISOString().slice(0, 10);
}

async function seedDailySchedule(platform: any, over: Record<string, unknown> = {}) {
  const store = platform.data.forUser(TEST_EMAIL);
  return await store.create("plan_schedules", {
    user: TEST_EMAIL, kind: "food", name: "Oats", payload: { kcal: 300, description: "Oats", macros: { protein: 12, carbs: 40, fat: 8 } },
    recurrence: { unit: "daily", interval: 1 }, time_of_day: "07:30", tz_offset_min: 0,
    active_from: TODAY, is_active: true, ...over,
  });
}

test("GET /api/timeline merges stored entries and projected occurrences, tagged", async () => {
  const { req, platform } = client();
  const store = platform.data.forUser(TEST_EMAIL);
  // A logged actual + a planned one-off, both today.
  await store.create("entries", { user: TEST_EMAIL, kind: "food", description: "logged lunch", kcal: 500,
    macros: { protein: 30, carbs: 40, fat: 20 }, status: "logged", logged_at: `${TODAY}T12:00:00.000Z`, day: TODAY });
  await store.create("entries", { user: TEST_EMAIL, kind: "food", description: "planned snack", kcal: 150,
    status: "planned", logged_at: `${TODAY}T15:00:00.000Z`, day: TODAY });
  await seedDailySchedule(platform);

  const res = await req(`/api/timeline?from=${TODAY}&to=${TODAY}&tz=0`);
  assert.equal(res.status, 200);
  const body = await res.json();
  const byOrigin = (o: string) => body.items.filter((i: any) => i.origin === o);
  assert.equal(byOrigin("entry").length, 2, "logged + planned one-off");
  assert.equal(byOrigin("occurrence").length, 1, "one projected occurrence today");
  const occ = byOrigin("occurrence")[0];
  assert.equal(occ.state, "planned");
  assert.equal(occ.scheduled_date, TODAY);
  assert.equal(occ.id, `${occ.schedule_id}:${TODAY}`);
  const planned = byOrigin("entry").find((i: any) => i.description === "planned snack");
  assert.equal(planned.state, "planned");
  const logged = byOrigin("entry").find((i: any) => i.description === "logged lunch");
  assert.equal(logged.state, "logged");
});

test("GET /api/timeline drops a skipped occurrence date", async () => {
  const { req, platform } = client();
  const store = platform.data.forUser(TEST_EMAIL);
  const sched = await seedDailySchedule(platform);
  await store.create("plan_overrides", { user: TEST_EMAIL, schedule_id: sched.id, scheduled_date: TODAY, is_skipped: true });
  const res = await req(`/api/timeline?from=${TODAY}&to=${TODAY}&tz=0`);
  const body = await res.json();
  assert.equal(body.items.filter((i: any) => i.origin === "occurrence").length, 0);
});

test("GET /api/timeline drops an already-materialized occurrence date", async () => {
  const { req, platform } = client();
  const store = platform.data.forUser(TEST_EMAIL);
  const sched = await seedDailySchedule(platform);
  // A materialized entry for today's occurrence (as the accept flow would create).
  await store.create("entries", { user: TEST_EMAIL, kind: "food", description: "Oats", kcal: 300, status: "logged",
    plan_schedule_id: sched.id, scheduled_date: TODAY, logged_at: `${TODAY}T07:30:00.000Z`, day: TODAY });
  const res = await req(`/api/timeline?from=${TODAY}&to=${TODAY}&tz=0`);
  const body = await res.json();
  assert.equal(body.items.filter((i: any) => i.origin === "occurrence").length, 0, "materialized date not double-shown");
  assert.equal(body.items.filter((i: any) => i.origin === "entry").length, 1, "the materialized entry shows once");
});

test("GET /api/timeline scope=activity filters to activity items", async () => {
  const { req, platform } = client();
  await seedDailySchedule(platform); // food
  await seedDailySchedule(platform, { kind: "activity", name: "Run", payload: { kcal: 250, duration_min: 30 } });
  const res = await req(`/api/timeline?from=${TODAY}&to=${TODAY}&scope=activity&tz=0`);
  const body = await res.json();
  assert.equal(body.items.length, 1);
  assert.equal(body.items[0].kind, "activity");
});

test("GET /api/timeline occurrences never enter day totals (honesty rule)", async () => {
  const { req, platform } = client();
  await seedDailySchedule(platform);
  await req(`/api/timeline?from=${TODAY}&to=${TODAY}&tz=0`); // project some occurrences
  const day = await req(`/api/entries?day=${TODAY}&tz=0`);
  const body = await day.json();
  assert.equal(body.totals.kcal, 0, "a projected occurrence contributes nothing to totals");
});

test("GET /api/timeline defaults from/to to today and returns future occurrences on scroll-up window", async () => {
  const { req, platform } = client();
  await seedDailySchedule(platform);
  const to = plusDays(TODAY, 2);
  const res = await req(`/api/timeline?from=${TODAY}&to=${to}&tz=0`);
  const body = await res.json();
  const dates = body.items.filter((i: any) => i.origin === "occurrence").map((i: any) => i.scheduled_date);
  assert.deepEqual(dates, [TODAY, plusDays(TODAY, 1), plusDays(TODAY, 2)]);
});
