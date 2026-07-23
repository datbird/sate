import { test } from "node:test";
import assert from "node:assert/strict";
import { Entry } from "../src/schema/index.ts";
import { isLogged } from "../src/api/helpers.ts";

test("Entry.status is optional (absent → undefined) and isLogged treats absent as logged (backward-compat)", () => {
  const e = Entry.parse({ id: "x", user: "u", description: "d", logged_at: "2026-07-23T00:00:00.000Z" });
  assert.equal(e.status, undefined); // pre-Planner entries have no status field
  assert.equal(isLogged(e), true); // ...and are counted as logged
});

test("Entry accepts status:'planned' + plan_schedule_id + scheduled_date", () => {
  const e = Entry.parse({
    id: "x", user: "u", description: "d", logged_at: "2026-07-23T00:00:00.000Z",
    status: "planned", plan_schedule_id: "sch1", scheduled_date: "2026-07-24",
  });
  assert.equal(e.status, "planned");
  assert.equal(e.plan_schedule_id, "sch1");
  assert.equal(e.scheduled_date, "2026-07-24");
});
