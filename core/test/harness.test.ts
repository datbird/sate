import { test } from "node:test";
import assert from "node:assert/strict";
import { client, TEST_EMAIL } from "./mem.ts";

test("harness: GET /api/entries reads a seeded logged entry's totals through app.request", async () => {
  const { req, platform } = client();
  const store = platform.data.forUser(TEST_EMAIL);
  await store.create("entries", {
    user: TEST_EMAIL, kind: "food", description: "eggs", kcal: 200,
    macros: { protein: 12, carbs: 1, fat: 15 },
    logged_at: "2026-07-23T12:00:00.000Z", day: "2026-07-23",
  });
  const res = await req("/api/entries?day=2026-07-23&tz=0");
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.totals.kcal, 200);
  assert.equal(body.entries.length, 1);
});
