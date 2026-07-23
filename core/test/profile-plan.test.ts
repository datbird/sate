import { test } from "node:test";
import assert from "node:assert/strict";
import { client, TEST_EMAIL } from "./mem.ts";

test("GET /api/me returns empty plan_summary/allergies for a fresh profile (backward-compat)", async () => {
  const { req } = client();
  const res = await req("/api/me?tz=0");
  assert.equal(res.status, 200);
  const me = await res.json();
  assert.equal(me.plan_summary, "");
  assert.equal(me.allergies, "");
});

test("PATCH /api/goals persists plan_summary + allergies; GET /api/me echoes them", async () => {
  const { req } = client();
  const patch = await req("/api/goals", {
    method: "PATCH",
    body: JSON.stringify({ plan_summary: "Aim for 1,800 kcal · 150g protein to reach 180 lb by Oct.", allergies: "no dairy, shellfish allergy" }),
  });
  assert.equal(patch.status, 200);
  const pv = await patch.json();
  assert.equal(pv.plan_summary, "Aim for 1,800 kcal · 150g protein to reach 180 lb by Oct.");
  assert.equal(pv.allergies, "no dairy, shellfish allergy");
  const me = await (await req("/api/me?tz=0")).json();
  assert.equal(me.plan_summary, "Aim for 1,800 kcal · 150g protein to reach 180 lb by Oct.");
  assert.equal(me.allergies, "no dairy, shellfish allergy");
});

test("PATCH /api/goals leaves the fields untouched when not provided, and clears with an empty string", async () => {
  const { req } = client();
  await req("/api/goals", { method: "PATCH", body: JSON.stringify({ plan_summary: "keep me", allergies: "peanuts" }) });
  // A patch that omits them must not wipe them.
  await req("/api/goals", { method: "PATCH", body: JSON.stringify({ goal_kcal: 2000 }) });
  let me = await (await req("/api/me?tz=0")).json();
  assert.equal(me.plan_summary, "keep me");
  assert.equal(me.allergies, "peanuts");
  // An explicit empty string clears.
  await req("/api/goals", { method: "PATCH", body: JSON.stringify({ allergies: "" }) });
  me = await (await req("/api/me?tz=0")).json();
  assert.equal(me.allergies, "");
  assert.equal(me.plan_summary, "keep me");
});

test("PATCH /api/goals coerces non-strings and caps length", async () => {
  const { req } = client();
  const long = "x".repeat(9000);
  const res = await req("/api/goals", { method: "PATCH", body: JSON.stringify({ plan_summary: long, allergies: 42 }) });
  const pv = await res.json();
  assert.equal(pv.plan_summary.length, 8000); // capped
  assert.equal(pv.allergies, "42");           // coerced to string
});
