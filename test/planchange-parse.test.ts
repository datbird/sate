import { test } from "node:test";
import assert from "node:assert/strict";
import { PROMPTS, splitPlanChange } from "../src/ai/prompts.ts";

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

test("no trailer → visibleText is the whole (trimmed) reply, planChange null", () => {
  const r = splitPlanChange("Here's some general advice about protein.  ");
  assert.equal(r.visibleText, "Here's some general advice about protein.");
  assert.equal(r.planChange, null);
});

test("one well-formed trailer → stripped from visibleText, parsed into planChange", () => {
  const raw =
    "Great — I'll bump you to 1,800 kcal and lean the macros toward protein.\n" +
    '<<PLAN_CHANGE>>{"goal_kcal":1800,"method":"protein"}';
  const r = splitPlanChange(raw);
  assert.equal(r.visibleText, "Great — I'll bump you to 1,800 kcal and lean the macros toward protein.");
  assert.doesNotMatch(r.visibleText, /<<PLAN_CHANGE>>/);
  assert.doesNotMatch(r.visibleText, /goal_kcal/); // user NEVER sees the raw JSON
  assert.deepEqual(r.planChange, { goal_kcal: 1800, method: "protein" });
});

test("trailer with a nested weight_goal object parses fully", () => {
  const raw = 'Pushing your goal out.\n<<PLAN_CHANGE>>{"weight_goal":{"target_lb":180,"target_date":"2026-10-01"}}';
  const r = splitPlanChange(raw);
  assert.deepEqual(r.planChange, { weight_goal: { target_lb: 180, target_date: "2026-10-01" } });
  assert.equal(r.visibleText, "Pushing your goal out.");
});

test("MALFORMED trailer JSON → planChange null but the marker + JSON are STILL stripped (no leak)", () => {
  const raw = "Sure, higher protein.\n<<PLAN_CHANGE>>{not valid json,,}";
  const r = splitPlanChange(raw);
  assert.equal(r.planChange, null);
  assert.equal(r.visibleText, "Sure, higher protein.");
  assert.doesNotMatch(r.visibleText, /<<PLAN_CHANGE>>/);
  assert.doesNotMatch(r.visibleText, /json/);
});

test("multiple markers → first wins, everything from the first marker on is stripped", () => {
  const raw =
    'Ok.\n<<PLAN_CHANGE>>{"goal_kcal":1700}\nignore me <<PLAN_CHANGE>>{"goal_kcal":9999}';
  const r = splitPlanChange(raw);
  assert.equal(r.visibleText, "Ok.");
  assert.deepEqual(r.planChange, { goal_kcal: 1700 });
});

test("prose AFTER the trailer is dropped from the visible reply", () => {
  const raw = 'Done.\n<<PLAN_CHANGE>>{"method":"carb"}\n(debug: applied)';
  const r = splitPlanChange(raw);
  assert.equal(r.visibleText, "Done.");
  assert.deepEqual(r.planChange, { method: "carb" });
});

test("non-object JSON after the marker (array/number) → planChange null", () => {
  assert.equal(splitPlanChange('x\n<<PLAN_CHANGE>>[1,2,3]').planChange, null);
  assert.equal(splitPlanChange('x\n<<PLAN_CHANGE>>42').planChange, null);
});

test("empty-object trailer {} → planChange null (no fields = not an apply signal), still stripped", () => {
  const r = splitPlanChange("Ok.\n<<PLAN_CHANGE>>{}");
  assert.equal(r.planChange, null);
  assert.equal(r.visibleText, "Ok.");
  assert.doesNotMatch(r.visibleText, /<<PLAN_CHANGE>>/);
});

test("well-formed trailer followed by prose containing a stray '}' → still parses (brace-matched, not lastIndexOf)", () => {
  const r = splitPlanChange('Done.\n<<PLAN_CHANGE>>{"method":"carb"}\nsmile :}');
  assert.deepEqual(r.planChange, { method: "carb" });
  assert.equal(r.visibleText, "Done.");
});

test("a '}' inside a JSON string value does not truncate the object", () => {
  const r = splitPlanChange('Note.\n<<PLAN_CHANGE>>{"method":"carb","note":"a} b"}');
  assert.deepEqual(r.planChange, { method: "carb", note: "a} b" });
});

test("array-wrapped object [{...}] → planChange null (payload must be a bare object)", () => {
  assert.equal(splitPlanChange('x\n<<PLAN_CHANGE>>[{"goal_kcal":1800}]').planChange, null);
});

test("leading whitespace before the marker is trimmed from visibleText", () => {
  const r = splitPlanChange('   Hello there.\n<<PLAN_CHANGE>>{"goal_kcal":1800}');
  assert.equal(r.visibleText, "Hello there.");
});

test("tolerates null/empty/whitespace input", () => {
  assert.deepEqual(splitPlanChange(null as any), { visibleText: "", planChange: null });
  assert.deepEqual(splitPlanChange(""), { visibleText: "", planChange: null });
  assert.deepEqual(splitPlanChange("   "), { visibleText: "", planChange: null });
});
