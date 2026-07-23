import { test } from "node:test";
import assert from "node:assert/strict";
import { PROMPTS } from "../src/ai/prompts.ts";

test("NUTRITIONIST_SYSTEM documents the <<PLAN_CHANGE>> trailer + its fields, only on a change request", () => {
  const s = PROMPTS.nutritionist.system;
  assert.match(s, /<<PLAN_CHANGE>>/);
  // The four contract fields are named so the model emits the right keys.
  assert.match(s, /goal_kcal/);
  assert.match(s, /method/);
  assert.match(s, /activity_level/);
  assert.match(s, /weight_goal/);
  // It must be conditional — only when the user asks to CHANGE the plan/targets/goals.
  assert.match(s, /only\b.*(change|adjust|update)/i);
  // And the trailer goes at the END and is machine-only (the app strips it from the visible reply).
  assert.match(s, /end|last|after/i);
});
