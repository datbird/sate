import { test } from "node:test";
import assert from "node:assert/strict";
import { client, TEST_EMAIL } from "./mem.ts";

// Seed one logged + one planned food entry on the same day, then assert planned is invisible to totals.
async function seedDay(platform: any, day: string) {
  const store = platform.data.forUser(TEST_EMAIL);
  await store.create("entries", {
    user: TEST_EMAIL, kind: "food", description: "logged lunch", kcal: 500,
    macros: { protein: 30, carbs: 40, fat: 20 }, status: "logged",
    logged_at: `${day}T12:00:00.000Z`, day,
  });
  await store.create("entries", {
    user: TEST_EMAIL, kind: "food", description: "planned dinner", kcal: 800,
    macros: { protein: 50, carbs: 60, fat: 30 }, status: "planned",
    logged_at: `${day}T19:00:00.000Z`, day,
  });
}

test("GET /api/entries totals exclude the planned entry", async () => {
  const { req, platform } = client();
  await seedDay(platform, "2026-07-23");
  const res = await req("/api/entries?day=2026-07-23&tz=0");
  const body = await res.json();
  assert.equal(body.totals.kcal, 500, "planned 800 must not be counted");
  assert.equal(body.totals.protein, 30);
});

test("GET /api/me today totals exclude the planned entry", async () => {
  const { req, platform } = client();
  const today = new Date().toISOString().slice(0, 10);
  await seedDay(platform, today);
  const res = await req("/api/me?tz=0");
  const body = await res.json();
  assert.equal(body.totals.kcal, 500);
});

test("GET /api/stats window totals + series exclude the planned entry", async () => {
  const { req, platform } = client();
  const today = new Date().toISOString().slice(0, 10);
  await seedDay(platform, today);
  const res = await req("/api/stats?range=day&tz=0");
  const body = await res.json();
  assert.equal(body.in.kcal, 500, "stats intake must exclude planned");
  const todaysBucket = (body.series as any[]).find((s) => s.bucket === today);
  assert.ok(todaysBucket, "series has today's bucket");
  assert.equal(todaysBucket.in_kcal, 500, "series must exclude planned");
});
