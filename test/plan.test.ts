import { test } from "node:test";
import assert from "node:assert/strict";
import { client } from "./mem.ts";

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

test("POST /api/plan/accept 400s the occurrence branch (phase 2)", async () => {
  const { req } = client();
  const res = await req("/api/plan/accept", {
    method: "POST",
    body: JSON.stringify({ schedule_id: "s1", scheduled_date: "2026-07-24" }),
  });
  assert.equal(res.status, 400);
});
