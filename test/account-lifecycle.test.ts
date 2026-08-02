import { test } from "node:test";
import assert from "node:assert/strict";
import { client } from "./mem.ts";

// Export + account deletion. Health data must never be a one-way door, and a delete that leaves rows
// behind is worse than no delete at all — the user believes they are erased when they are not.

const USER_COLLECTIONS = [
  "entries", "profiles", "measurements", "weight_goals", "checkins", "plan_schedules", "plan_overrides",
];

async function seed(store: any, email: string) {
  await store.create("entries", { user: email, day: "2026-05-01", kcal: 400, description: "eggs" });
  await store.create("entries", { user: email, day: "2026-05-02", kcal: 500, description: "toast" });
  await store.create("measurements", { user: email, date: "2026-05-01", weight_kg: 80 });
  await store.create("weight_goals", { user: email, target_kg: 75, target_date: "2026-09-01" });
  await store.create("checkins", { user: email, status: "pending", message: "hi" });
  await store.create("plan_schedules", { user: email, name: "Lunch", is_active: true });
  await store.create("plan_overrides", { user: email, schedule_id: "s1", scheduled_date: "2026-05-03" });
}

test("GET /api/account/export returns every user-scoped collection", async () => {
  const { req, platform, email } = client();
  await seed(platform.data.forUser(email), email);
  await req("/api/me"); // materialize the profile

  const res = await req("/api/account/export");
  assert.equal(res.status, 200);
  const body = await res.json();

  assert.equal(body.account.email, email);
  for (const coll of USER_COLLECTIONS) {
    assert.ok(Array.isArray(body.data[coll]), `export must include ${coll}`);
  }
  assert.equal(body.data.entries.length, 2, "both entries exported");
  assert.equal(body.data.measurements.length, 1);
  assert.ok(body.data.profiles.length >= 1, "the profile itself is part of the record");
  // Shared catalogue data is instance-scoped and must NOT be dragged into a personal export.
  assert.equal(body.data.foods, undefined, "shared foods KB is not the user's data");
});

test("DELETE /api/account refuses without an explicit confirmation", async () => {
  const { req, platform, email } = client();
  await seed(platform.data.forUser(email), email);

  const res = await req("/api/account", { method: "DELETE", body: JSON.stringify({}) });
  assert.equal(res.status, 400);

  const still = await platform.data.forUser(email).list("entries", {});
  assert.equal(still.items.length, 2, "nothing may be deleted without confirmation");
});

test("DELETE /api/account erases every user-scoped collection", async () => {
  const { req, platform, email } = client();
  const store = platform.data.forUser(email);
  await seed(store, email);
  await req("/api/me");

  const res = await req("/api/account", { method: "DELETE", body: JSON.stringify({ confirm: "DELETE" }) });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(body.deleted.entries >= 2, "reports what it removed");

  for (const coll of USER_COLLECTIONS) {
    const left = await store.list(coll, {});
    assert.equal(left.items.length, 0, `${coll} must be empty after account deletion`);
  }
});

test("deletion leaves the shared instance catalogue untouched", async () => {
  const { req, platform, inst, email } = client();
  await seed(platform.data.forUser(email), email);
  await inst.create("foods", { name: "banana", kcal: 105, verified: true });

  await req("/api/account", { method: "DELETE", body: JSON.stringify({ confirm: "DELETE" }) });

  const foods = await inst.list("foods", {});
  assert.equal(foods.items.length, 1, "the shared food KB is instance data, not the user's to delete");
});
