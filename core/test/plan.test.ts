import { test } from "node:test";
import assert from "node:assert/strict";
import { client, TEST_EMAIL } from "./mem.ts";

test("POST /api/plan/entry creates a planned entry that is excluded from totals", async () => {
  const { req } = client();
  const create = await req("/api/plan/entry", {
    method: "POST",
    body: JSON.stringify({
      kind: "food", description: "planned dinner", kcal: 800,
      macros: { protein: 50, carbs: 60, fat: 30 },
      logged_at: "2026-07-24T19:00:00.000Z", tz_offset_min: 0,
    }),
  });
  assert.equal(create.status, 200);
  const { entry } = await create.json();
  assert.equal(entry.status, "planned");
  assert.equal(entry.day, "2026-07-24");
  assert.equal(entry.kcal, 800);

  // It's stored but invisible to that day's totals.
  const day = await req("/api/entries?day=2026-07-24&tz=0");
  const body = await day.json();
  assert.equal(body.entries.length, 1, "planned entry is listed");
  assert.equal(body.totals.kcal, 0, "planned entry contributes nothing");
});

test("POST /api/plan/entry requires a description", async () => {
  const { req } = client();
  const res = await req("/api/plan/entry", { method: "POST", body: JSON.stringify({ kcal: 100 }) });
  assert.equal(res.status, 400);
});

test("POST /api/plan/accept flips a planned entry to logged and counts it", async () => {
  const { req } = client();
  const create = await req("/api/plan/entry", {
    method: "POST",
    body: JSON.stringify({ kind: "food", description: "planned lunch", kcal: 600,
      macros: { protein: 40, carbs: 50, fat: 20 }, logged_at: "2026-07-24T12:00:00.000Z", tz_offset_min: 0 }),
  });
  const { entry } = await create.json();

  const acc = await req("/api/plan/accept", { method: "POST", body: JSON.stringify({ entry_id: entry.id }) });
  assert.equal(acc.status, 200);
  const body = await acc.json();
  assert.equal(body.entry.status, "logged");
  assert.equal(body.totals.kcal, 600, "accepted entry now counts");

  // A second read of the day confirms it's counted.
  const day = await req("/api/entries?day=2026-07-24&tz=0");
  assert.equal((await day.json()).totals.kcal, 600);
});

test("POST /api/plan/accept applies edits while accepting", async () => {
  const { req } = client();
  const { entry } = await (await req("/api/plan/entry", {
    method: "POST",
    body: JSON.stringify({ kind: "food", description: "big meal", kcal: 900,
      macros: { protein: 20, carbs: 20, fat: 20 }, logged_at: "2026-07-24T12:00:00.000Z", tz_offset_min: 0 }),
  })).json();
  const acc = await req("/api/plan/accept", {
    method: "POST",
    body: JSON.stringify({ entry_id: entry.id, edits: { kcal: 450, protein: 10 } }),
  });
  const body = await acc.json();
  assert.equal(body.entry.kcal, 450);
  assert.equal(body.totals.kcal, 450);
});

test("POST /api/plan/accept is idempotent (accepting a logged entry is a no-op)", async () => {
  const { req } = client();
  const { entry } = await (await req("/api/plan/entry", {
    method: "POST",
    body: JSON.stringify({ kind: "food", description: "snack", kcal: 100, logged_at: "2026-07-24T12:00:00.000Z", tz_offset_min: 0 }),
  })).json();
  await req("/api/plan/accept", { method: "POST", body: JSON.stringify({ entry_id: entry.id }) });
  const again = await req("/api/plan/accept", { method: "POST", body: JSON.stringify({ entry_id: entry.id }) });
  assert.equal(again.status, 200);
  const body = await again.json();
  assert.equal(body.entry.status, "logged");
  assert.equal(body.totals.kcal, 100, "no double-count on re-accept");
});

test("POST /api/plan/accept 404s an unknown entry", async () => {
  const { req } = client();
  const res = await req("/api/plan/accept", { method: "POST", body: JSON.stringify({ entry_id: "nope" }) });
  assert.equal(res.status, 404);
});

async function seedSchedule(platform: any, over: Record<string, unknown> = {}) {
  const store = platform.data.forUser(TEST_EMAIL);
  return await store.create("plan_schedules", {
    user: TEST_EMAIL, kind: "food", name: "Overnight oats",
    payload: { kcal: 300, description: "Overnight oats", macros: { protein: 12, carbs: 40, fat: 8 } },
    recurrence: { unit: "daily", interval: 1 }, time_of_day: "07:30", tz_offset_min: 0,
    active_from: "2026-07-01", is_active: true, ...over,
  });
}

test("POST /api/plan/accept (occurrence) materializes a logged entry from the schedule payload", async () => {
  const { req, platform } = client();
  const sched = await seedSchedule(platform);
  const res = await req("/api/plan/accept", { method: "POST", body: JSON.stringify({ schedule_id: sched.id, scheduled_date: "2026-07-24" }) });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.entry.status, "logged");
  assert.equal(body.entry.plan_schedule_id, sched.id);
  assert.equal(body.entry.scheduled_date, "2026-07-24");
  assert.equal(body.entry.day, "2026-07-24");
  assert.equal(body.entry.logged_at, "2026-07-24T07:30:00.000Z");
  assert.equal(body.entry.kcal, 300);
  assert.equal(body.entry.macros.protein, 12);
  assert.equal(body.totals.kcal, 300, "materialized entry counts");
});

test("POST /api/plan/accept (occurrence) is idempotent — a second accept returns the same entry", async () => {
  const { req, platform } = client();
  const sched = await seedSchedule(platform);
  const first = await (await req("/api/plan/accept", { method: "POST", body: JSON.stringify({ schedule_id: sched.id, scheduled_date: "2026-07-24" }) })).json();
  const second = await (await req("/api/plan/accept", { method: "POST", body: JSON.stringify({ schedule_id: sched.id, scheduled_date: "2026-07-24" }) })).json();
  assert.equal(second.entry.id, first.entry.id, "no duplicate materialization");
  assert.equal(second.totals.kcal, 300, "no double-count");
  const store = platform.data.forUser(TEST_EMAIL);
  const { items } = await store.list("entries", {});
  assert.equal(items.length, 1);
});

test("POST /api/plan/accept (occurrence) applies the override then the caller's edits", async () => {
  const { req, platform } = client();
  const sched = await seedSchedule(platform);
  const store = platform.data.forUser(TEST_EMAIL);
  await store.create("plan_overrides", { user: TEST_EMAIL, schedule_id: sched.id, scheduled_date: "2026-07-24", new_time: "09:00", new_payload: { kcal: 500, description: "Bigger oats", macros: { protein: 20, carbs: 60, fat: 10 } } });
  const res = await req("/api/plan/accept", { method: "POST", body: JSON.stringify({ schedule_id: sched.id, scheduled_date: "2026-07-24", edits: { kcal: 450 } }) });
  const body = await res.json();
  assert.equal(body.entry.logged_at, "2026-07-24T09:00:00.000Z", "override new_time applied");
  assert.equal(body.entry.description, "Bigger oats", "override new_payload applied");
  assert.equal(body.entry.kcal, 450, "caller edit wins over override payload");
});

test("POST /api/plan/accept (occurrence) 404s an unknown schedule", async () => {
  const { req } = client();
  const res = await req("/api/plan/accept", { method: "POST", body: JSON.stringify({ schedule_id: "nope", scheduled_date: "2026-07-24" }) });
  assert.equal(res.status, 404);
});

test("POST /api/plan/accept (occurrence) 409s a skipped occurrence", async () => {
  const { req, platform } = client();
  const sched = await seedSchedule(platform);
  const store = platform.data.forUser(TEST_EMAIL);
  await store.create("plan_overrides", { user: TEST_EMAIL, schedule_id: sched.id, scheduled_date: "2026-07-24", is_skipped: true });
  const res = await req("/api/plan/accept", { method: "POST", body: JSON.stringify({ schedule_id: sched.id, scheduled_date: "2026-07-24" }) });
  assert.equal(res.status, 409);
});

test("POST /api/plan/accept 403s an entry owned by another user", async () => {
  const { req, platform } = client();
  // Seed a planned entry whose `user` is someone else, into the caller's own store.
  const store = platform.data.forUser(TEST_EMAIL); // the caller
  const rec = await store.create("entries", {
    user: "someone-else@example.com", kind: "food", status: "planned",
    description: "not yours", kcal: 300, logged_at: "2026-07-24T12:00:00.000Z", day: "2026-07-24",
  });
  const res = await req("/api/plan/accept", { method: "POST", body: JSON.stringify({ entry_id: rec.id }) });
  assert.equal(res.status, 403);
});

test("POST /api/plan/accept (occurrence) 403s a schedule owned by another user", async () => {
  const { req, platform } = client();
  // seedSchedule stores into the caller's own store but with a mismatched `user` field.
  const sched = await seedSchedule(platform, { user: "someone-else@example.com" });
  const res = await req("/api/plan/accept", {
    method: "POST",
    body: JSON.stringify({ schedule_id: sched.id, scheduled_date: "2026-07-24" }),
  });
  assert.equal(res.status, 403);
});

test("POST /api/plan/accept 400s when entry_id is missing", async () => {
  const { req } = client();
  const res = await req("/api/plan/accept", { method: "POST", body: JSON.stringify({}) });
  assert.equal(res.status, 400);
});
