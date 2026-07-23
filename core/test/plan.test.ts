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
