import { test } from "node:test";
import assert from "node:assert/strict";
import { client } from "./mem.ts";

// Regression: logging a meal must bucket into the USER'S local calendar day, not UTC.
//
// The SPA's shared api() helper appends the timezone as a QUERY param (?tz=<getTimezoneOffset()>) on
// every request; the compose sheet does NOT put tz_offset_min in the JSON body. Write handlers that
// only read the body therefore fell back to tz=0 (UTC), so anything logged after 19:00 US-Central
// (= 00:00 UTC) landed on TOMORROW's date. Reported by a real user 2026-07-27.
//
// 2026-07-27T01:32:45Z is 2026-07-26 20:32 CDT — the exact shape of the reported entry.
const EVENING_UTC = "2026-07-27T01:32:45.000Z";
const LOCAL_DAY = "2026-07-26";
const US_CENTRAL = 300; // getTimezoneOffset() for CDT

async function seedFood(inst: any) {
  return await inst.create("foods", {
    name: "turkey cheese salami sandwich",
    kcal: 500,
    protein: 30,
    carbs: 40,
    fat: 20,
  });
}

test("POST /api/log/food buckets by ?tz= query when the body omits tz_offset_min", async () => {
  const { req, inst } = client();
  const food = await seedFood(inst);
  const res = await req(`/api/log/food?tz=${US_CENTRAL}`, {
    method: "POST",
    body: JSON.stringify({ food_id: food.id, logged_at: EVENING_UTC }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.entry.day, LOCAL_DAY, "evening meal must land on the local day, not the UTC day");
  assert.equal(body.entry.tz_offset_min, US_CENTRAL, "the entry must record the tz it was bucketed in");
});

test("an explicit body tz_offset_min still wins over the query param", async () => {
  const { req, inst } = client();
  const food = await seedFood(inst);
  const res = await req(`/api/log/food?tz=${US_CENTRAL}`, {
    method: "POST",
    body: JSON.stringify({ food_id: food.id, logged_at: EVENING_UTC, tz_offset_min: 0 }),
  });
  const body = await res.json();
  assert.equal(body.entry.day, "2026-07-27", "explicit body tz=0 must still bucket in UTC");
});

test("POST /api/entries/:id/duplicate buckets by ?tz= query too", async () => {
  const { req, inst } = client();
  const food = await seedFood(inst);
  const first = await req(`/api/log/food?tz=${US_CENTRAL}`, {
    method: "POST",
    body: JSON.stringify({ food_id: food.id, logged_at: EVENING_UTC }),
  });
  const { entry } = await first.json();
  const res = await req(`/api/entries/${entry.id}/duplicate?tz=${US_CENTRAL}`, {
    method: "POST",
    body: JSON.stringify({ logged_at: EVENING_UTC }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.entry.day, LOCAL_DAY);
});
