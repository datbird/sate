import { test } from "node:test";
import assert from "node:assert/strict";
// The shared registry is CommonJS; import the named exports the .d.ts declares.
import {
  FUNCTIONS, PROMPTS, allergiesLine,
  buildRecipeSuggestMsg, buildRecipeExpandMsg, normalizeRecipeIdeas, normalizeRecipe,
} from "../src/ai/prompts.ts";

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

test("buildRecipeSuggestMsg embeds the numeric target, method, prefs, and allergies", () => {
  const msg = buildRecipeSuggestMsg({
    target: { kcal: 650, protein: 45, carbs: 60, fat: 20 },
    method: "high-protein", prefs: "quick, no oven", allergies: "peanuts, shellfish",
  });
  assert.match(msg, /650/); assert.match(msg, /45/); assert.match(msg, /60/); assert.match(msg, /20/);
  assert.match(msg, /high-protein/);
  assert.match(msg, /quick, no oven/);
  assert.match(msg, /peanuts, shellfish/);
  assert.match(msg, /must respect/i);
});

test("buildRecipeSuggestMsg omits empty method/prefs/allergies cleanly (no allergy line when none)", () => {
  const msg = buildRecipeSuggestMsg({ target: { kcal: 500, protein: 30, carbs: 50, fat: 15 } });
  assert.match(msg, /500/);
  assert.doesNotMatch(msg, /must respect/i); // no allergy line when there are none
});

test("buildRecipeExpandMsg names the idea and carries allergies", () => {
  const msg = buildRecipeExpandMsg({
    idea: "Greek yogurt power bowl", target: { kcal: 650, protein: 45, carbs: 60, fat: 20 },
    prefs: "no oven", allergies: "peanuts",
  });
  assert.match(msg, /Greek yogurt power bowl/);
  assert.match(msg, /peanuts/);
  // Accepts an object idea too (uses .name).
  const msg2 = buildRecipeExpandMsg({ idea: { name: "Tofu stir-fry", kcal: 500 } });
  assert.match(msg2, /Tofu stir-fry/);
});

test("normalizeRecipeIdeas coerces types, clamps count, and falls back to [] on garbage", () => {
  const good = normalizeRecipeIdeas({ ideas: [
    { name: "Bowl", kcal: "650", protein: 45, carbs: 60, fat: "20", blurb: "Tasty." },
    { name: 123 }, // missing/typed fields → coerced/zeroed
  ]});
  assert.equal(good.ideas.length, 2);
  assert.equal(good.ideas[0].kcal, 650);
  assert.equal(good.ideas[0].fat, 20);
  assert.equal(good.ideas[0].name, "Bowl");
  assert.equal(good.ideas[1].name, "123");
  assert.equal(good.ideas[1].protein, 0);
  assert.deepEqual(normalizeRecipeIdeas(null).ideas, []);
  assert.deepEqual(normalizeRecipeIdeas({ nope: 1 }).ideas, []);
  // clamp: 20 ideas → at most 8
  const many = normalizeRecipeIdeas({ ideas: Array.from({ length: 20 }, (_, i) => ({ name: "n" + i })) });
  assert.ok(many.ideas.length <= 8);
});

test("normalizeRecipe returns a full typed shape and a safe empty on garbage", () => {
  const r = normalizeRecipe({
    name: "Power bowl", servings: "2",
    ingredients: [{ item: "Greek yogurt", amount: "200 g" }, "loose string", { item: "Honey" }],
    steps: ["Mix.", 5, "Serve."], kcal: "640",
    macros: { protein: "44", carbs: 60, fat: 19, sodium: 300 },
  });
  assert.equal(r.name, "Power bowl");
  assert.equal(r.servings, 2);
  assert.equal(r.ingredients[0].item, "Greek yogurt");
  assert.equal(r.ingredients[0].amount, "200 g");
  assert.equal(r.ingredients[1].item, "loose string"); // string coerced to {item, amount:""}
  assert.equal(r.ingredients[2].amount, "");
  assert.deepEqual(r.steps, ["Mix.", "5", "Serve."]);
  assert.equal(r.kcal, 640);
  assert.equal(r.macros.protein, 44);
  assert.equal(r.macros.fiber, 0);
  const empty = normalizeRecipe("not json");
  assert.equal(empty.name, "");
  assert.deepEqual(empty.ingredients, []);
  assert.deepEqual(empty.steps, []);
});
