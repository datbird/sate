import { test } from "node:test";
import assert from "node:assert/strict";
import { client } from "./mem.ts";

// Regression: /api/stats must aggregate EVERY entry in the requested window, not just the first page.
//
// fetchDayRange (api/profile.ts) has always paged with `limit: 500` + `cursor`, breaking out of the
// loop when a page returns no `nextCursor`. But the only DataStore implementation (the Firestore
// adapter) applied neither: `query()` never called startAfter and `list()` never returned a cursor.
// The loop therefore always exited after one iteration and a month/year window silently aggregated
// the OLDEST 500 entries — no error, no truncation signal, just quietly wrong totals, averages and
// trend series. Latent until an account crossed 500 entries in a window (~3-4 months of logging).
//
// This test drives the shared core through the in-memory store, which now models the same cursor
// contract as Firestore, so it fails against either implementation regressing.
const TZ = 300; // US-Central
const PER_DAY_KCAL = 100;

// 600 entries > the 500 page size, spread across a month so they fall in one `range=month` window.
const DAYS = 30;
const PER_DAY = 20;
const TOTAL = DAYS * PER_DAY; // 600

test("GET /api/stats?range=month aggregates past the 500-row page boundary", async () => {
  const { req, platform, email } = client();
  const user = platform.data.forUser(email);

  for (let d = 0; d < DAYS; d++) {
    const day = `2026-03-${String(d + 1).padStart(2, "0")}`;
    for (let i = 0; i < PER_DAY; i++) {
      await user.create("entries", {
        user: email,
        kind: "",
        description: `meal ${d}-${i}`,
        kcal: PER_DAY_KCAL,
        protein: 10,
        carbs: 10,
        fat: 5,
        day,
        logged_at: `${day}T12:${String(i).padStart(2, "0")}:00.000Z`,
        tz_offset_min: TZ,
      });
    }
  }

  const res = await req(`/api/stats?range=month&date=2026-03-30&tz=${TZ}`);
  assert.equal(res.status, 200);
  const body = await res.json();

  // The whole point: every entry counted, not the first 500.
  assert.equal(
    body.in.kcal,
    TOTAL * PER_DAY_KCAL,
    `expected all ${TOTAL} entries aggregated (${TOTAL * PER_DAY_KCAL} kcal), got ${body.in.kcal} — ` +
      `${body.in.kcal === 500 * PER_DAY_KCAL ? "this is the 500-row truncation" : "unexpected total"}`,
  );
  assert.equal(body.in.count, TOTAL, "the entry count must reflect the whole window");
});

test("the store's list() emits nextCursor on a full page and omits it on a short one", async () => {
  const { platform, email } = client();
  const user = platform.data.forUser(email);
  for (let i = 0; i < 7; i++) {
    await user.create("entries", { user: email, day: `2026-04-${String(i + 1).padStart(2, "0")}`, kcal: 1 });
  }
  const spec = { orderBy: [{ field: "day", dir: "asc" as const }], limit: 3 };

  const p1 = await user.list("entries", spec);
  assert.equal(p1.items.length, 3);
  assert.ok(p1.nextCursor, "a full page must expose a cursor to continue from");

  const p2 = await user.list("entries", { ...spec, cursor: p1.nextCursor });
  assert.equal(p2.items.length, 3);
  assert.notEqual(p2.items[0].day, p1.items[0].day, "the second page must resume AFTER the first");

  const p3 = await user.list("entries", { ...spec, cursor: p2.nextCursor });
  assert.equal(p3.items.length, 1, "the last page is short");
  assert.equal(p3.nextCursor, undefined, "a short page must NOT advertise more");

  // No row is dropped or repeated across the three pages.
  const seen = [...p1.items, ...p2.items, ...p3.items].map((e: { day: string }) => e.day);
  assert.equal(new Set(seen).size, 7, "pagination must cover every row exactly once");
});
