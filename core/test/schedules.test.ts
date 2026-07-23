import { test } from "node:test";
import assert from "node:assert/strict";
import { client } from "./mem.ts";

const NEW_SCHED = {
  kind: "food", name: "Overnight oats",
  payload: { kcal: 300, description: "Overnight oats", macros: { protein: 12, carbs: 40, fat: 8 } },
  recurrence: { unit: "daily", interval: 1 },
  time_of_day: "07:30", tz_offset_min: 0, active_from: "2026-07-01",
};

async function createSchedule(req: any, over: Record<string, unknown> = {}) {
  const res = await req("/api/plan/schedules", { method: "POST", body: JSON.stringify({ ...NEW_SCHED, ...over }) });
  return { res, body: await res.json() };
}

test("POST /api/plan/schedules creates a schedule with defaults + server fields", async () => {
  const { req } = client();
  const { res, body } = await createSchedule(req);
  assert.equal(res.status, 200);
  assert.equal(body.schedule.name, "Overnight oats");
  assert.equal(body.schedule.is_active, true);
  assert.equal(body.schedule.recurrence.interval, 1);
  assert.ok(body.schedule.id, "server assigns an id");
  assert.ok(body.schedule.created_at, "server stamps created_at");
});

test("POST /api/plan/schedules 400s a bad recurrence unit", async () => {
  const { req } = client();
  const { res } = await createSchedule(req, { recurrence: { unit: "yearly" } });
  assert.equal(res.status, 400);
});

test("POST /api/plan/schedules 400s a missing active_from", async () => {
  const { req } = client();
  const res = await req("/api/plan/schedules", { method: "POST",
    body: JSON.stringify({ name: "x", recurrence: { unit: "daily" } }) });
  assert.equal(res.status, 400);
});

test("GET /api/plan/schedules lists the caller's schedules", async () => {
  const { req } = client();
  await createSchedule(req);
  await createSchedule(req, { name: "Morning run", kind: "activity" });
  const res = await req("/api/plan/schedules");
  const body = await res.json();
  assert.equal(body.schedules.length, 2);
});

test("PATCH /api/plan/schedules/:id edits the schedule (all-scope)", async () => {
  const { req } = client();
  const { body } = await createSchedule(req);
  const res = await req(`/api/plan/schedules/${body.schedule.id}`, {
    method: "PATCH", body: JSON.stringify({ name: "Steel-cut oats", time_of_day: "08:00" }),
  });
  const patched = await res.json();
  assert.equal(res.status, 200);
  assert.equal(patched.schedule.name, "Steel-cut oats");
  assert.equal(patched.schedule.time_of_day, "08:00");
});

test("DELETE /api/plan/schedules/:id removes it and cascades its overrides", async () => {
  const { req, platform } = client();
  const { body } = await createSchedule(req);
  const id = body.schedule.id;
  // Seed an override for this schedule to prove the cascade.
  const store = platform.data.forUser("tester@example.com");
  await store.create("plan_overrides", { user: "tester@example.com", schedule_id: id, scheduled_date: "2026-07-11", is_skipped: true });
  const res = await req(`/api/plan/schedules/${id}`, { method: "DELETE" });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).deleted, id);
  const gone = await req("/api/plan/schedules");
  assert.equal((await gone.json()).schedules.length, 0);
  const { items } = await store.list("plan_overrides", {});
  assert.equal(items.length, 0, "overrides cascaded");
});

test("PATCH /api/plan/schedules/:id 404s an unknown id", async () => {
  const { req } = client();
  const res = await req("/api/plan/schedules/nope", { method: "PATCH", body: JSON.stringify({ name: "x" }) });
  assert.equal(res.status, 404);
});

test("PATCH /api/plan/schedules/:id 403s a schedule owned by another user", async () => {
  const { req, platform } = client();
  const store = platform.data.forUser("tester@example.com"); // the caller's own store
  const rec = await store.create("plan_schedules", {
    user: "someone-else@example.com", kind: "food", name: "not yours",
    payload: {}, recurrence: { unit: "daily", interval: 1 },
    time_of_day: "07:00", tz_offset_min: 0, active_from: "2026-07-01", is_active: true,
  });
  const res = await req(`/api/plan/schedules/${rec.id}`, { method: "PATCH", body: JSON.stringify({ name: "hijacked" }) });
  assert.equal(res.status, 403);
});

test("upsertOverride writes exactly one row per (schedule_id, scheduled_date), updating on repeat", async () => {
  const { req, platform } = client();
  const { body } = await createSchedule(req);
  const id = body.schedule.id;
  const { upsertOverride } = await import("../src/api/plan.ts");
  const store = platform.data.forUser("tester@example.com");
  const first = await upsertOverride(store, id, "2026-07-11", { user: "tester@example.com", schedule_id: id, scheduled_date: "2026-07-11", is_skipped: true });
  const second = await upsertOverride(store, id, "2026-07-11", { user: "tester@example.com", schedule_id: id, scheduled_date: "2026-07-11", is_skipped: false, new_time: "08:00" });
  assert.equal(first.id, second.id, "same row is reused");
  const { items } = await store.list("plan_overrides", {
    where: [{ field: "schedule_id", op: "==", value: id }, { field: "scheduled_date", op: "==", value: "2026-07-11" }],
  });
  assert.equal(items.length, 1, "exactly one override row for this occurrence");
  assert.equal((items[0] as any).is_skipped, false, "the second call's patch won");
  assert.equal((items[0] as any).new_time, "08:00");
});
