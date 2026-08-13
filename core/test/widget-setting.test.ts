import { test } from "node:test";
import assert from "node:assert/strict";
import { client } from "./mem.ts";

test("GET /api/me defaults widget_updates to balanced", async () => {
  const { req } = client();
  const res = await req("/api/me");
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.widget_updates, "balanced");
});

test("PATCH /api/goals persists a valid widget_updates value", async () => {
  const { req } = client();
  const patch = await req("/api/goals", {
    method: "PATCH",
    body: JSON.stringify({ widget_updates: "frequent" }),
  });
  assert.equal(patch.status, 200);
  const body = await (await req("/api/me")).json();
  assert.equal(body.widget_updates, "frequent");
});

test("PATCH /api/goals ignores an unknown widget_updates value", async () => {
  const { req } = client();
  await req("/api/goals", { method: "PATCH", body: JSON.stringify({ widget_updates: "frequent" }) });
  await req("/api/goals", { method: "PATCH", body: JSON.stringify({ widget_updates: "instant" }) });
  const body = await (await req("/api/me")).json();
  assert.equal(body.widget_updates, "frequent", "an unknown mode must not overwrite a valid one");
});
