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

test("NUTRITIONIST_SYSTEM instructs the coach to respect dietary restrictions/allergies", () => {
  assert.match(PROMPTS.nutritionist.system, /allerg|dietary restriction|restriction/i);
});

test("allergiesLine renders a restriction line only when allergies are present", () => {
  assert.equal(allergiesLine(""), "");
  assert.equal(allergiesLine("   "), "");
  assert.equal(allergiesLine(undefined), "");
  const line = allergiesLine("no dairy, shellfish allergy");
  assert.match(line, /no dairy, shellfish allergy/);
  assert.match(line, /must respect|restriction|allerg/i);
});

test("buildRecipeSuggestMsg maps raw track_mode tokens to emphasis vocabulary (fat→low-fat, carb→low-carb)", () => {
  // Test mapping of raw token "fat" (which means low-fat tracking) to emphasis phrase "low-fat"
  const msgFat = buildRecipeSuggestMsg({
    target: { kcal: 650, protein: 45, carbs: 60, fat: 20 },
    method: "fat", prefs: "quick, no oven", allergies: "peanuts",
  });
  assert.match(msgFat, /low-fat/);
  assert.doesNotMatch(msgFat, /^Tracking-method emphasis: fat\./m); // not bare token

  // Test mapping of raw token "carb" (which means low-carb tracking) to emphasis phrase "low-carb"
  const msgCarb = buildRecipeSuggestMsg({
    target: { kcal: 650, protein: 45, carbs: 30, fat: 20 },
    method: "carb",
  });
  assert.match(msgCarb, /low-carb/);

  // Test mapping of raw token "protein" to emphasis phrase "high-protein"
  const msgProtein = buildRecipeSuggestMsg({
    target: { kcal: 650, protein: 60, carbs: 60, fat: 20 },
    method: "protein",
  });
  assert.match(msgProtein, /high-protein/);

  // Test mapping of raw token "balanced" to emphasis phrase "balanced macros"
  const msgBalanced = buildRecipeSuggestMsg({
    target: { kcal: 650, protein: 45, carbs: 60, fat: 20 },
    method: "balanced",
  });
  assert.match(msgBalanced, /balanced macros/);

  // Test mapping of raw token "heart" to emphasis phrase "heart-healthy"
  const msgHeart = buildRecipeSuggestMsg({
    target: { kcal: 650, protein: 45, carbs: 60, fat: 20 },
    method: "heart",
  });
  assert.match(msgHeart, /heart-healthy/);

  // Test mapping of raw token "calories" to emphasis phrase "balanced calories"
  const msgCalories = buildRecipeSuggestMsg({
    target: { kcal: 650, protein: 45, carbs: 60, fat: 20 },
    method: "calories",
  });
  assert.match(msgCalories, /balanced calories/);
});

test("buildRecipeSuggestMsg omits empty method/prefs/allergies cleanly (no allergy line when none)", () => {
  const msg = buildRecipeSuggestMsg({ target: { kcal: 500, protein: 30, carbs: 50, fat: 15 } });
  assert.match(msg, /500/);
  assert.doesNotMatch(msg, /must respect/i); // no allergy line when there are none
  assert.doesNotMatch(msg, /Tracking-method emphasis/); // no method line when empty
});

test("buildRecipeSuggestMsg handles unknown/unrecognized method with fallback to default", () => {
  // Unknown method should still embed itself (or fall back); shouldn't crash
  const msg = buildRecipeSuggestMsg({
    target: { kcal: 500, protein: 30, carbs: 50, fat: 15 },
    method: "unknown_mode",
  });
  // Unknown methods pass through as-is (or fallback to "balanced macros")
  assert.match(msg, /Tracking-method emphasis/);
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
