import { test } from "node:test";
import assert from "node:assert/strict";
import { client } from "./mem.ts";

const TZ = 300; // US-Central

function today(tzMin: number): string {
  return new Date(Date.now() - tzMin * 60000).toISOString().slice(0, 10);
}

async function seed(platform: any, email: string, day: string, rows: any[]) {
  const store = platform.data.forUser(email);
  for (const r of rows) {
    await store.create("entries", { day, kind: "", logged_at: `${day}T12:00:00.000Z`, ...r });
  }
}

test("summary returns a kcal ring with net-exercise applied", async () => {
  const { req, platform, email } = client();
  const day = today(TZ);
  await platform.data.forUser(email).create("profiles", {
    id: "me", method: "calories", net_exercise: true,
    goal_kcal: 2000, goal_protein: 180, goal_carbs: 220, goal_fat: 60,
  });
  await seed(platform, email, day, [
    { kcal: 500, macros: { protein: 40, carbs: 50, fat: 15 } },
    { kcal: 740, macros: { protein: 48, carbs: 90, fat: 26 } },
    { kcal: 331, kind: "activity", duration_min: 30 },
  ]);

  const res = await req(`/api/widget/summary?tz=${TZ}`);
  assert.equal(res.status, 200);
  const b = await res.json();

  assert.equal(b.day, day);
  assert.equal(b.ring.mode, "calories");
  assert.equal(b.ring.unit, "kcal");
  assert.equal(b.ring.value, 1240, "activity burn must never count as intake");
  assert.equal(b.ring.net_burn, 331);
  assert.equal(b.ring.goal, 2331, "net exercise adds burn to the kcal goal");
  assert.equal(b.ring.left, 1091);
  assert.equal(b.macros.protein.value, 88);
  assert.equal(b.macros.protein.goal, 180);
});

test("net exercise is NOT applied when the primary metric is not kcal", async () => {
  const { req, platform, email } = client();
  const day = today(TZ);
  await platform.data.forUser(email).create("profiles", {
    id: "me", method: "protein", net_exercise: true, goal_kcal: 2000, goal_protein: 180,
  });
  await seed(platform, email, day, [
    { kcal: 500, macros: { protein: 40 } },
    { kcal: 331, kind: "activity" },
  ]);

  const b = await (await req(`/api/widget/summary?tz=${TZ}`)).json();
  assert.equal(b.ring.mode, "protein");
  assert.equal(b.ring.unit, "g");
  assert.equal(b.ring.value, 40);
  assert.equal(b.ring.goal, 180, "burn must not inflate a protein goal");
  assert.equal(b.ring.net_burn, 0);
});

test("planned entries count toward nothing", async () => {
  const { req, platform, email } = client();
  const day = today(TZ);
  await platform.data.forUser(email).create("profiles", { id: "me", method: "calories", goal_kcal: 2000 });
  await seed(platform, email, day, [
    { kcal: 500, macros: { protein: 40 } },
    { kcal: 900, status: "planned", macros: { protein: 60 } },
  ]);

  const b = await (await req(`/api/widget/summary?tz=${TZ}`)).json();
  assert.equal(b.ring.value, 500);
  assert.equal(b.macros.protein.value, 40);
});

test("an entry late in the local day buckets to the local day, not the UTC one", async () => {
  const { req, platform, email } = client();
  const day = today(TZ);
  await platform.data.forUser(email).create("profiles", { id: "me", method: "calories", goal_kcal: 2000 });
  // day is the LOCAL bucket the app already stored; 23:30 local is the next UTC day.
  await platform.data.forUser(email).create("entries", {
    day, kind: "", kcal: 300, logged_at: `${day}T04:30:00.000Z`, macros: { protein: 10 },
  });
  const b = await (await req(`/api/widget/summary?tz=${TZ}`)).json();
  assert.equal(b.day, day);
  assert.equal(b.ring.value, 300);
});
