import { test } from "node:test";
import assert from "node:assert/strict";
// The shared registry is CommonJS; import the named exports the .d.ts declares.
import { FUNCTIONS, PROMPTS, allergiesLine } from "../src/ai/prompts.ts";

test("recipe_suggest + recipe_expand are registered functions with strict-JSON prompts", () => {
  assert.ok(FUNCTIONS.includes("recipe_suggest"), "recipe_suggest in FUNCTIONS");
  assert.ok(FUNCTIONS.includes("recipe_expand"), "recipe_expand in FUNCTIONS");
  assert.equal(PROMPTS.recipe_suggest.jsonMode, true);
  assert.equal(PROMPTS.recipe_expand.jsonMode, true);
  // The suggest prompt states the ideas JSON shape + honors the target/method/prefs/allergies.
  assert.match(PROMPTS.recipe_suggest.system, /ideas/i);
  assert.match(PROMPTS.recipe_suggest.system, /allergen|allerg|restriction/i);
  // The expand prompt states the full-recipe shape.
  assert.match(PROMPTS.recipe_expand.system, /ingredients/i);
  assert.match(PROMPTS.recipe_expand.system, /steps/i);
});

test("allergiesLine renders a restriction line only when allergies are present", () => {
  assert.equal(allergiesLine(""), "");
  assert.equal(allergiesLine("   "), "");
  assert.equal(allergiesLine(undefined), "");
  const line = allergiesLine("no dairy, shellfish allergy");
  assert.match(line, /no dairy, shellfish allergy/);
  assert.match(line, /must respect|restriction|allerg/i);
});
