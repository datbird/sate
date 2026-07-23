# Planner Phase 5 — Recipe Suggester + Preferences (allergies) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the **recipe suggester** (spec §7) — a new `recipe_suggest` AI function plus `POST /api/recipes/suggest` (compact ideas that fit a numeric target) and `POST /api/recipes/expand` (one idea → a full recipe) — and make the **remembered `profiles.allergies`** (spec §2.4) actually *drive* the AI: it is injected **server-side** into BOTH the recipe prompts AND the nutritionist coach prompt, **never trusted from the client**. On the client, the disabled "Suggest a recipe" seam Phase 3 left in the plan-an-event fill step (`views/planevent.js`) goes **live**: target prefilled from the remaining budget (goal − today's logged totals), editable; a free-text prefs box; a compact ideas list with re-roll; tap → full recipe; then **"Add to plan"** (a PLANNED entry, not counted) or **"Log now"** (a logged entry, immediately).

**Architecture:** All changes land in `@sate/core` (`~/gitrepos/sate/core`), deployed to Cloud (sate.health) via sate-cloud. The prompt text + JSON schemas + defensive normalizers go in the shared, goja-safe `core/src/shared/prompts.js` (both editions read it; its typed mirror is `core/src/ai/prompts.d.ts`). Two thin AI callers (`suggestRecipes`, `expandRecipe`) join the existing ones in `core/src/ai/index.ts`, each funneled through the one `callAI` so key resolution, **limit enforcement, and usage accounting are automatic and uniform** — exactly like `estimateNutrition`/`nutritionist`. A new route module `core/src/api/recipes.ts` (`registerRecipes`) exposes the two endpoints, both behind `requireAI`; each reads `profile.allergies` from `ensureProfile(...)` and passes it to the caller — the handler never references the client body's allergies. The coach injection is a one-line append of a pure `allergiesLine()` to the nutritionist context in `core/src/api/coach.ts`, plus one sentence in `NUTRITIONIST_SYSTEM`. The client work is confined to `views/planevent.js` + one pure helper (`remainingBudget`) in the already-established import-free `core/src/web/planner.js`.

**Tech Stack:** TypeScript (Node 24, run via the Phase-1 esbuild bundle + native `node:test`), Hono, Zod, the ports/adapters `DataStore`/`Secrets` abstraction, framework-free ES-module SPA. No new runtime dependencies. `core/src/shared/prompts.js` stays **goja-safe ES2015 CommonJS** (no `?.`, no `??`, no object spread, string concatenation not template literals) because the Hosted edition `require()`s it verbatim.

## Global Constraints

Every task inherits these (from the spec `docs/superpowers/specs/2026-07-23-planner-recipes-coach-plan-design.md` §7, §2.4, §3):

- **Cloud edition only, core-first.** All schema/logic lands in `@sate/core`. The Hosted (`pb_hooks`/`pb_public`) port is explicitly OUT OF SCOPE. But `shared/prompts.js` is shared by both editions, so it MUST stay goja-safe ES2015 (see Tech Stack) — a TS-only idiom there breaks the Hosted build even though we don't ship Hosted here.
- **Allergies are server-authoritative, NEVER trusted from the client.** Every AI call that must respect allergies reads them from `profile.allergies` via `ensureProfile(platform, uid, ...)`. Route handlers MUST NOT read `body.allergies`. A client cannot suppress or spoof a user's allergies. This is the single most important regression to test (mirrors Phase 1's honesty rule in weight).
- **Recipe results are AI ESTIMATES.** The full-recipe macros and per-idea numbers are the model's best fit to the target, not lab values — the same status as every other AI estimate in the app. The UI presents them as suggestions; "Add to plan"/"Log now" store them as the *intended*/entered content, editable like any manual entry.
- **Honesty (spec §3) is preserved by reusing Phase 1 primitives.** "**Add to plan**" creates a **planned** entry/schedule via the existing plan-an-event flow (`buildPlanRequest` → `POST /api/plan/entry` | `/api/plan/schedules`) — status `planned`, counted ZERO until accepted. "**Log now**" creates a **logged** entry immediately via the existing `POST /api/foods/manual`. Phase 5 adds no new totalling path and re-sums nothing client-side.
- **Reuse `callAI` + the usage/limits plane.** The recipe callers go through `callAI` (which does `checkLimit` → `runProvider` → `recordUsage`); they do NOT call `runProvider` directly. Default model = **Latest Flash** via `resolveDefaultModel(platform, "ai")` (Google `gemini-flash-latest`), same rolling alias/admin-routing as `text_parse`/`daily_summary`.
- **Strict-JSON parsing with a fallback, like the other AI functions.** Each caller `parseJSON(res.text)` then runs a defensive normalizer (`normalizeRecipeIdeas` / `normalizeRecipe`) that coerces types, clamps counts, and returns a safe empty shape on garbage — mirroring `normalizeNutrition`/`normalizeActivity`. `recipe_suggest`/`recipe_expand` use `jsonMode: true` (no web search), like `text_parse`.
- **Escape ALL AI text in the DOM (XSS).** Recipe names, blurbs, ingredients, and steps are model-authored; every insertion into `planevent.js` uses `esc()` (or `el(tag, props, ...children)` text-node children). Never `innerHTML` with raw AI strings.
- **No asset cache-busting query strings.** `planevent.js` is already in the bundle graph (Phase 3, imported by `app.js`); do NOT add `?vN`. New CSS goes in `core/src/web/style.css` (served content-hashed).
- **Test/typecheck gates:** pure/harness tests run via `cd ~/gitrepos/sate/core && npm test`; the typecheck gate `cd ~/gitrepos/sate-cloud && npx tsc --noEmit` must stay exit 0.

---

## Dependency on Phase 4 (`profiles.allergies`)

Phase 5 **consumes** `profiles.allergies` but does **not own** it. **Phase 4 (Plan tab)** adds `allergies?: z.string().optional()` to `Profile` (`core/src/schema/index.ts`), echoes it in `profileView()` (so `GET /api/me` returns `allergies: ""` for fresh profiles), and persists it in `PATCH /api/goals` (length-capped) — verified in the Phase 4 plan (`2026-07-23-planner-phase4-plan-tab.md`, Task 1). Phase 5 assumes that field exists.

**Task 0 (guard)** below verifies the field is present. If Phase 4 has **not** landed (`Profile.allergies` missing or `GET /api/me` omits `allergies`), Task 0 adds the exact Phase-4 slice (schema field + `profileView` echo + `PATCH /api/goals` accept) so Phase 5 is not blocked — this is the ONLY place Phase 5 touches the field's ownership, and it is a no-op if Phase 4 already shipped it.

---

## File Structure

- **Modify `core/src/shared/prompts.js`** — add `"recipe_suggest"` + `"recipe_expand"` to `FUNCTIONS`; add the two system prompts + JSON-schema strings + `PROMPTS` entries; add `buildRecipeSuggestMsg` / `buildRecipeExpandMsg` (pure user-message builders) + `normalizeRecipeIdeas` / `normalizeRecipe` (defensive normalizers) + `allergiesLine`; append one allergy sentence to `NUTRITIONIST_SYSTEM`; export the new functions. Tasks 1, 2, 5. Goja-safe.
- **Modify `core/src/ai/prompts.d.ts`** — declare the new `AIFunction` union members + `RecipeIdeas`/`Recipe` result types + the new function signatures. Tasks 1, 2.
- **Modify `core/src/ai/index.ts`** — add `suggestRecipes()` + `expandRecipe()` callers (through `callAI`, Flash by default). Task 3.
- **Create `core/src/api/recipes.ts`** — `registerRecipes(app, deps)`: `POST /api/recipes/suggest`, `POST /api/recipes/expand`; both `requireAI`, both read `profile.allergies` server-side. Task 4.
- **Modify `core/src/api/index.ts`** — mount `registerRecipes`. Task 4.
- **Modify `core/src/api/coach.ts`** — inject `allergiesLine(profile.allergies)` into the nutritionist context. Task 5.
- **Modify `core/src/web/planner.js`** — add the pure `remainingBudget(goals, totals)`. Task 6.
- **Create `core/test/recipes-prompts.test.ts`** — pure tests for the builders + normalizers + `allergiesLine`. Tasks 1, 2, 5.
- **Create `core/test/recipes.test.ts`** — harness tests for the two routes via a **captured-fetch stub** (validation short-circuits, allergies-from-profile-not-body, passthrough shape, usage accounting). Task 4.
- **Modify `core/test/planner-ui.test.ts`** — append `remainingBudget` tests. Task 6.
- **Modify `core/src/web/views/planevent.js`** — replace the disabled "Suggest a recipe" seam with the live recipe panel (suggest/expand/re-roll → Add to plan | Log now). Task 7.
- **Modify `core/src/web/style.css`** — recipe-panel styles. Task 7.

Note: `core/package.json` already has the `test` script + `esbuild` devDep (Phase 1). No harness change is needed — the route tests stub `platform.secrets.get` and `globalThis.fetch` in-test (Task 4).

**Verification approach (read before Task 1) — the pure / harness / AI-live / DOM split:**

- **Pure (full TDD, `node:test`):** the user-message **builders** (assert the numeric target, method, prefs, and — critically — the **allergies** all appear in the prompt the model will see), the **normalizers** (strict-JSON + fallback + type/shape clamping over garbage), `allergiesLine`, and the client `remainingBudget`. These carry the highest-value logic and need no network.
- **Harness (TDD via `client()` + a captured-fetch stub):** the two routes' **non-model** behavior IS unit-testable without a real Gemini call by stubbing `platform.secrets.get` (so `callAI` gets a key) and `globalThis.fetch` (so `runGoogle` returns a canned `candidates[…]` JSON while we **capture the outgoing request body**). That lets us assert, deterministically: validation 400s (bad/missing target) short-circuit **before** any AI call; the response **passthrough shape** (`{ideas:[…]}` / the full recipe); **usage accounting** (a row lands in the instance `ai_usage` collection via `recordUsage`); and the **server-side allergies invariant** — seed `profile.allergies="peanuts, shellfish"`, send a body with a *different* `allergies:"none"`, and assert the **captured prompt contains the PROFILE allergies and NOT the body value**. This is the "stub/inject where the harness allows" the spec calls for; it does not exercise the real model.
- **AI-live (sate.health, `god` account):** only the *model quality* is live — that ideas actually fit the target and honor real allergies, that expand returns a coherent recipe, and that the live usage counter increments. Compared against the deployed revision; cleaned up after.
- **DOM (complete code + explicit LIVE steps):** the recipe panel in `planevent.js` — there is no jsdom/browser harness in this repo (Phase 3 precedent). The panel is thin over the tested pure `remainingBudget` + the tested route shapes, so a browser is only needed to confirm layout/wiring, which the live steps do.

---

### Task 0: Guard — confirm `profiles.allergies` exists (Phase-4 dependency)

Phase 5 consumes `profiles.allergies`. Confirm Phase 4 shipped it; if not, add the exact Phase-4 slice so Phase 5 isn't blocked. A no-op if Phase 4 already landed.

**Files:**
- (Conditional) Modify: `core/src/schema/index.ts`, `core/src/api/profile.ts`
- Test: `core/test/recipes-prompts.test.ts` (a small guard assertion, moved into the pure file created in Task 1) — OR run the check below directly.

- [ ] **Step 1: Check whether the field is present**

Run:
```bash
cd ~/gitrepos/sate
grep -n "allergies" core/src/schema/index.ts core/src/api/profile.ts
```
Expected if Phase 4 shipped it: `Profile` has `allergies: z.string().optional()` and `profileView` returns `allergies: p.allergies || ""`. If BOTH are present, this task is **done** — skip to Task 1.

- [ ] **Step 2 (only if MISSING): add the Phase-4 slice**

In `core/src/schema/index.ts`, in the `Profile` object (near `plan_summary`, or after the goals block if `plan_summary` is also absent), add:
```typescript
  // Remembered dietary restrictions/allergies (free-text, e.g. "no dairy, shellfish allergy").
  // Owned by Phase 4 (Plan tab); consumed server-side by Phase 5 (recipes + coach). Additive/optional.
  allergies: z.string().optional(),
```
In `core/src/api/profile.ts` `profileView()`, add `allergies: p.allergies || "",`, and in `PATCH /api/goals` add (with the other string fields): `if (b.allergies !== undefined) patch.allergies = String(b.allergies).slice(0, 2000);`.

- [ ] **Step 3: Verify + typecheck**

Run: `cd ~/gitrepos/sate/core && npm test` then `cd ~/gitrepos/sate-cloud && npx tsc --noEmit`
Expected: all Phase 1–4 tests green; typecheck exit 0.

- [ ] **Step 4: Commit (only if Step 2 ran)**

```bash
cd ~/gitrepos/sate
git add core/src/schema/index.ts core/src/api/profile.ts
git commit -m "feat(core): add profiles.allergies (Phase-4 field; guarded for Phase 5)"
```

---

### Task 1: Register `recipe_suggest` + `recipe_expand` (prompts + schemas + PROMPTS)

Add the two AI functions to the shared registry with their system prompts and strict-JSON schemas, and declare their types. No callers/routes yet — this task is the prompt text + registry only, plus the pure `allergiesLine` used by both recipes and the coach.

**Files:**
- Modify: `core/src/shared/prompts.js`
- Modify: `core/src/ai/prompts.d.ts`
- Create: `core/test/recipes-prompts.test.ts`

**Interfaces:**
- Produces: `FUNCTIONS` gains `"recipe_suggest"`, `"recipe_expand"`; `PROMPTS.recipe_suggest`/`PROMPTS.recipe_expand` (`{ system, jsonMode: true }`); `allergiesLine(allergies): string` (empty string when no allergies, else a `"DIETARY RESTRICTIONS / ALLERGIES (must respect): …"` line). Consumed by Tasks 2, 3, 5.

- [ ] **Step 1: Write the failing test `core/test/recipes-prompts.test.ts`**

```typescript
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
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd ~/gitrepos/sate/core && npm test`
Expected: FAIL — `recipe_suggest`/`recipe_expand`/`allergiesLine` are not exported.

- [ ] **Step 3: Add the functions + prompts to `core/src/shared/prompts.js`** (goja-safe ES2015)

Add the two names to `FUNCTIONS` (line 17):
```javascript
const FUNCTIONS = ["vision_estimate", "text_parse", "daily_summary", "web_lookup", "activity_estimate", "nutritionist", "checkin", "recipe_suggest", "recipe_expand"];
```

After the `CHECKIN_SYSTEM` block (before `const PROMPTS = {`), add the recipe schemas + prompts + the shared allergy helper:
```javascript
// ---- recipe suggester (spec §7) ----------------------------------------
// Compact ideas that FIT a numeric target; the model is grounded on exact kcal/macro numbers so the
// suggestions actually fit the user's remaining budget. Strict minified JSON, no prose/fences.
const RECIPE_IDEAS_SCHEMA =
  '{"ideas":[{"name":string,"kcal":number,"protein":number,"carbs":number,"fat":number,"blurb":string}]}';

const RECIPE_SUGGEST_SYSTEM =
  "You are a meal-idea engine for the Sate nutrition app. Given a numeric nutrition TARGET for a " +
  "single meal (calories + protein/carbs/fat grams), an optional tracking-method emphasis, optional " +
  "free-text preferences, and any dietary restrictions/allergies, propose about 5 distinct, realistic " +
  "meal ideas whose nutrition fits the target as closely as you reasonably can. Honor the method " +
  "emphasis (high-protein = protein-forward; low-carb = carbs low; low-fat = fat low; balanced = even; " +
  "heart-healthy = low saturated fat/sodium), the preferences, and — as a HARD constraint — the " +
  "dietary restrictions/allergies: NEVER suggest a meal that includes a restricted or allergenic " +
  "ingredient. Respond ONLY with strict minified JSON (no markdown, no code fences) matching exactly:\n" +
  RECIPE_IDEAS_SCHEMA + "\n" +
  "kcal is calories; protein, carbs and fat are grams for one serving of the idea. `blurb` is a single " +
  "short appetizing sentence (no newlines). Return roughly 5 ideas. If the target is unusable, return " +
  '{"ideas":[]}.';

// Expand ONE chosen idea into a cookable recipe with exact per-serving macros. Same allergy hard rule.
const RECIPE_FULL_SCHEMA =
  '{"name":string,"servings":number,"ingredients":[{"item":string,"amount":string}],"steps":[string],' +
  '"kcal":number,"macros":{"protein":number,"carbs":number,"fat":number,"fiber":number,"sugar":number,"sodium":number,"sat_fat":number}}';

const RECIPE_EXPAND_SYSTEM =
  "You are a recipe engine for the Sate nutrition app. Expand the single meal idea the user names into " +
  "a complete, cookable recipe that still fits the given nutrition target and honors the preferences " +
  "and, as a HARD constraint, the dietary restrictions/allergies (NEVER include a restricted or " +
  "allergenic ingredient). Respond ONLY with strict minified JSON (no markdown, no code fences) " +
  "matching exactly:\n" + RECIPE_FULL_SCHEMA + "\n" +
  "servings is a whole number of servings; each ingredient has a plain `item` name and an `amount` " +
  "string (e.g. \"2 tbsp\", \"150 g\"); steps is an ordered array of short plain-text instructions; " +
  "kcal and macros are per ONE serving. " + UNITS_LINE + " Keep it realistic and concise.";

// A single grounding line naming the user's remembered dietary restrictions/allergies, injected
// SERVER-SIDE into the recipe prompts AND the nutritionist coach context (spec §2.4, §7.3). Empty
// string when the user has none, so callers can concatenate unconditionally.
function allergiesLine(allergies) {
  var a = (allergies == null ? "" : String(allergies)).trim();
  if (!a) return "";
  return "DIETARY RESTRICTIONS / ALLERGIES (must respect — never include these): " + a;
}
```

Add the two `PROMPTS` entries (inside the `PROMPTS` object, after `checkin`):
```javascript
  recipe_suggest: { system: RECIPE_SUGGEST_SYSTEM, jsonMode: true },
  recipe_expand: { system: RECIPE_EXPAND_SYSTEM, jsonMode: true },
```

Add `allergiesLine` to `module.exports` (it will gain more members in Tasks 2/5):
```javascript
module.exports = {
  FUNCTIONS,
  PROMPTS,
  parseJSON,
  normalizeNutrition,
  normalizeActivity,
  allergiesLine,
};
```

- [ ] **Step 4: Declare the types in `core/src/ai/prompts.d.ts`**

Add `"recipe_suggest"` and `"recipe_expand"` to the `AIFunction` union, and declare:
```typescript
export declare function allergiesLine(allergies: string | undefined | null): string;
```
(The `RecipeIdeas`/`Recipe` result types + builder/normalizer signatures are added in Task 2 alongside those functions.)

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd ~/gitrepos/sate/core && npm test`
Expected: PASS — both Task 1 tests green; all prior tests green.

- [ ] **Step 6: Typecheck**

Run: `cd ~/gitrepos/sate-cloud && npx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 7: Commit**

```bash
cd ~/gitrepos/sate
git add core/src/shared/prompts.js core/src/ai/prompts.d.ts core/test/recipes-prompts.test.ts
git commit -m "feat(core): register recipe_suggest + recipe_expand AI functions + allergiesLine"
```

---

### Task 2: Pure prompt builders + defensive normalizers

The two highest-value pure pieces: the **user-message builders** that assemble the numeric target + method + prefs + **allergies** into the text the model sees (so the allergy-in-prompt guarantee is unit-tested), and the **defensive normalizers** that turn a (possibly garbage) model reply into a safe, typed shape with a fallback — mirroring `normalizeNutrition`/`normalizeActivity`.

**Files:**
- Modify: `core/src/shared/prompts.js`
- Modify: `core/src/ai/prompts.d.ts`
- Modify: `core/test/recipes-prompts.test.ts` (append)

**Interfaces:**
- Produces (all goja-safe):
  - `buildRecipeSuggestMsg({ target: {kcal,protein,carbs,fat}, method?, prefs?, allergies? }): string`
  - `buildRecipeExpandMsg({ idea, target?, prefs?, allergies? }): string` (`idea` is a name string or `{name,…}`)
  - `normalizeRecipeIdeas(obj): { ideas: Array<{name,kcal,protein,carbs,fat,blurb}> }` (≤ 8 ideas, coerced; `{ideas:[]}` on garbage)
  - `normalizeRecipe(obj): { name, servings, ingredients:[{item,amount}], steps:string[], kcal, macros{…} }` (safe empty on garbage)

- [ ] **Step 1: Append the failing tests to `core/test/recipes-prompts.test.ts`**

```typescript
import {
  buildRecipeSuggestMsg, buildRecipeExpandMsg, normalizeRecipeIdeas, normalizeRecipe,
} from "../src/ai/prompts.ts";

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
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd ~/gitrepos/sate/core && npm test`
Expected: FAIL — the four builder/normalizer functions are not exported.

- [ ] **Step 3: Add the builders + normalizers to `core/src/shared/prompts.js`** (goja-safe; reuse the existing `num` helper)

Add after `allergiesLine`:
```javascript
// ---- recipe prompt builders (pure; server injects allergies from the profile) ----
function targetLines(target) {
  var t = target || {};
  return [
    "Target for this meal (fit these as closely as you reasonably can):",
    "- Calories: " + num(t.kcal) + " kcal",
    "- Protein: " + num(t.protein) + " g, Carbs: " + num(t.carbs) + " g, Fat: " + num(t.fat) + " g",
  ];
}

function buildRecipeSuggestMsg(inp) {
  inp = inp || {};
  var L = targetLines(inp.target);
  var method = (inp.method == null ? "" : String(inp.method)).trim();
  var prefs = (inp.prefs == null ? "" : String(inp.prefs)).trim();
  var al = allergiesLine(inp.allergies);
  if (method) L.push("Tracking-method emphasis: " + method + ".");
  if (prefs) L.push("Preferences: " + prefs);
  if (al) L.push(al);
  L.push("Suggest about 5 distinct meal ideas that fit this target.");
  return L.join("\n");
}

function buildRecipeExpandMsg(inp) {
  inp = inp || {};
  var idea = inp.idea;
  var name = idea && typeof idea === "object" ? String(idea.name || "") : String(idea || "");
  var L = ["Expand this meal idea into a full recipe: " + name];
  if (inp.target) L = L.concat(targetLines(inp.target));
  var prefs = (inp.prefs == null ? "" : String(inp.prefs)).trim();
  var al = allergiesLine(inp.allergies);
  if (prefs) L.push("Preferences: " + prefs);
  if (al) L.push(al);
  return L.join("\n");
}

// ---- recipe response normalizers (strict-JSON already parsed; coerce + clamp + fallback) ----
var MAX_IDEAS = 8;

function normalizeRecipeIdeas(obj) {
  var ideas = obj && Array.isArray(obj.ideas) ? obj.ideas : [];
  var clean = [];
  for (var i = 0; i < ideas.length && clean.length < MAX_IDEAS; i++) {
    var it = ideas[i] || {};
    clean.push({
      name: String(it.name || "Meal idea"),
      kcal: num(it.kcal),
      protein: num(it.protein),
      carbs: num(it.carbs),
      fat: num(it.fat),
      blurb: String(it.blurb || ""),
    });
  }
  return { ideas: clean };
}

function macrosOf(m) {
  m = m || {};
  return {
    protein: num(m.protein), carbs: num(m.carbs), fat: num(m.fat),
    fiber: num(m.fiber), sugar: num(m.sugar), sodium: num(m.sodium), sat_fat: num(m.sat_fat),
  };
}

function normalizeRecipe(obj) {
  var o = obj && typeof obj === "object" ? obj : {};
  var ing = Array.isArray(o.ingredients) ? o.ingredients : [];
  var ingredients = [];
  for (var i = 0; i < ing.length; i++) {
    var g = ing[i];
    if (g && typeof g === "object") ingredients.push({ item: String(g.item || ""), amount: String(g.amount || "") });
    else if (g != null && String(g).trim()) ingredients.push({ item: String(g), amount: "" });
  }
  var st = Array.isArray(o.steps) ? o.steps : [];
  var steps = [];
  for (var j = 0; j < st.length; j++) { if (st[j] != null && String(st[j]).trim()) steps.push(String(st[j])); }
  var servings = num(o.servings);
  return {
    name: String(o.name || ""),
    servings: servings > 0 ? Math.round(servings) : (o.name ? 1 : 0),
    ingredients: ingredients,
    steps: steps,
    kcal: num(o.kcal),
    macros: macrosOf(o.macros),
  };
}
```

Add all four to `module.exports`:
```javascript
module.exports = {
  FUNCTIONS,
  PROMPTS,
  parseJSON,
  normalizeNutrition,
  normalizeActivity,
  allergiesLine,
  buildRecipeSuggestMsg,
  buildRecipeExpandMsg,
  normalizeRecipeIdeas,
  normalizeRecipe,
};
```

- [ ] **Step 4: Declare the types in `core/src/ai/prompts.d.ts`**

```typescript
export interface RecipeIdea { name: string; kcal: number; protein: number; carbs: number; fat: number; blurb: string; }
export interface RecipeIdeas { ideas: RecipeIdea[]; }
export interface RecipeIngredient { item: string; amount: string; }
export interface Recipe {
  name: string; servings: number; ingredients: RecipeIngredient[]; steps: string[];
  kcal: number; macros: { protein: number; carbs: number; fat: number; fiber: number; sugar: number; sodium: number; sat_fat: number };
}
export interface RecipeTarget { kcal: number; protein: number; carbs: number; fat: number; }
export declare function buildRecipeSuggestMsg(inp: { target: RecipeTarget; method?: string; prefs?: string; allergies?: string }): string;
export declare function buildRecipeExpandMsg(inp: { idea: string | { name?: string }; target?: RecipeTarget; prefs?: string; allergies?: string }): string;
export declare function normalizeRecipeIdeas(obj: unknown): RecipeIdeas;
export declare function normalizeRecipe(obj: unknown): Recipe;
```

- [ ] **Step 5: Run the tests + typecheck**

Run: `cd ~/gitrepos/sate/core && npm test` then `cd ~/gitrepos/sate-cloud && npx tsc --noEmit`
Expected: PASS — the four builder/normalizer tests green; typecheck exit 0.

- [ ] **Step 6: Commit**

```bash
cd ~/gitrepos/sate
git add core/src/shared/prompts.js core/src/ai/prompts.d.ts core/test/recipes-prompts.test.ts
git commit -m "feat(core): pure recipe prompt builders + defensive normalizers"
```

---

### Task 3: AI callers `suggestRecipes` + `expandRecipe` (through `callAI`)

Add the two thin callers to `core/src/ai/index.ts`, mirroring `estimateNutrition`. Each resolves **Latest Flash** by default, runs through the single `callAI` funnel (so `checkLimit`/`recordUsage` are automatic), `parseJSON`s the reply, and returns the normalized shape. Model call is exercised live (Task 4 harness stubs it); this task is code + typecheck.

**Files:**
- Modify: `core/src/ai/index.ts`

**Interfaces:**
- Produces:
  - `suggestRecipes(platform, { target, method?, prefs?, allergies? }): Promise<RecipeIdeas>`
  - `expandRecipe(platform, { idea, target?, prefs?, allergies? }): Promise<Recipe>`

- [ ] **Step 1: Add the callers to `core/src/ai/index.ts`**

Extend the import from `./prompts` (which re-exports the shared module) to include the new members:
```typescript
import {
  PROMPTS,
  parseJSON,
  normalizeNutrition,
  normalizeActivity,
  buildRecipeSuggestMsg,
  buildRecipeExpandMsg,
  normalizeRecipeIdeas,
  normalizeRecipe,
  type AIFunction,
  type NutritionResult,
  type ActivityResult,
  type RecipeIdeas,
  type Recipe,
  type RecipeTarget,
} from "./prompts";
```

Add after `expandRecipe`'s sibling `estimateActivity` (anywhere among the callers):
```typescript
// ---- recipe_suggest → ~5 compact ideas that fit a numeric target (spec §7) ----------------
export interface SuggestRecipesInput {
  target: RecipeTarget;
  method?: string;
  prefs?: string;
  /** Pulled from the profile by the route — NEVER from the client body. */
  allergies?: string;
}
export async function suggestRecipes(platform: Platform, inp: SuggestRecipesInput): Promise<RecipeIdeas> {
  const { provider, model } = await resolveDefaultModel(platform, "ai"); // Latest Flash by default
  const p = PROMPTS.recipe_suggest;
  const res = await callAI(platform, {
    provider,
    model,
    system: p.system,
    jsonMode: p.jsonMode,
    messages: [{ role: "user", text: buildRecipeSuggestMsg(inp) }],
  });
  return normalizeRecipeIdeas(parseJSON(res.text));
}

// ---- recipe_expand → one idea → a full recipe with per-serving macros (spec §7) -----------
export interface ExpandRecipeInput {
  idea: string | { name?: string };
  target?: RecipeTarget;
  prefs?: string;
  /** Pulled from the profile by the route — NEVER from the client body. */
  allergies?: string;
}
export async function expandRecipe(platform: Platform, inp: ExpandRecipeInput): Promise<Recipe> {
  const { provider, model } = await resolveDefaultModel(platform, "ai");
  const p = PROMPTS.recipe_expand;
  const res = await callAI(platform, {
    provider,
    model,
    system: p.system,
    jsonMode: p.jsonMode,
    messages: [{ role: "user", text: buildRecipeExpandMsg(inp) }],
  });
  return normalizeRecipe(parseJSON(res.text));
}
```

- [ ] **Step 2: Typecheck**

Run: `cd ~/gitrepos/sate-cloud && npx tsc --noEmit`
Expected: exit 0. (No new unit test here — the callers are exercised end-to-end by Task 4's harness stub and by the live smoke.)

- [ ] **Step 3: Run the suite (nothing should regress)**

Run: `cd ~/gitrepos/sate/core && npm test`
Expected: PASS — all prior tests green.

- [ ] **Step 4: Commit**

```bash
cd ~/gitrepos/sate
git add core/src/ai/index.ts
git commit -m "feat(core): suggestRecipes + expandRecipe AI callers (Latest Flash, via callAI)"
```

---

### Task 4: `POST /api/recipes/suggest` + `/expand` — routes (allergies server-side)

The two endpoints. Both `requireAI`; both read `profile.allergies` server-side via `ensureProfile` and pass it to the caller; the handler NEVER references `body.allergies`. Validation short-circuits before any AI call. Verified by a **captured-fetch harness** that asserts: validation 400s, the server-side allergies invariant (captured prompt has profile allergies, not the body's), the passthrough shape, and usage accounting.

**Files:**
- Create: `core/src/api/recipes.ts`
- Modify: `core/src/api/index.ts` (mount `registerRecipes`)
- Create: `core/test/recipes.test.ts`

**Interfaces:**
- Produces: `registerRecipes(app: App, deps: RouteDeps): Promise<void>`.
  - `POST /api/recipes/suggest` body `{ target:{kcal,protein,carbs,fat}, method?, prefs? }` → `{ ideas:[…] }`.
  - `POST /api/recipes/expand` body `{ idea, target?, prefs? }` → the full recipe object.

- [ ] **Step 1: Write the failing harness test `core/test/recipes.test.ts`**

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { client, TEST_EMAIL } from "./mem.ts";

// Install a fake Google provider: give callAI a key + stub fetch to return a canned generateContent
// reply, capturing the outgoing request body so we can inspect the prompt the route actually sent.
function stubGemini(platform: any, replyObj: unknown) {
  const captured: { body: any } = { body: null };
  platform.secrets.get = async () => "test-key";
  (globalThis as any).fetch = async (_url: string, init: any) => {
    captured.body = JSON.parse(init.body);
    const text = typeof replyObj === "string" ? replyObj : JSON.stringify(replyObj);
    return new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ text }] } }],
      usageMetadata: { promptTokenCount: 11, candidatesTokenCount: 22 },
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  return captured;
}
// The prompt text sent to Google lives in systemInstruction + contents[].parts[].text.
function sentText(body: any): string {
  const sys = body?.systemInstruction?.parts?.map((p: any) => p.text).join("\n") || "";
  const msgs = (body?.contents || []).flatMap((c: any) => (c.parts || []).map((p: any) => p.text)).join("\n");
  return sys + "\n" + msgs;
}

test("POST /api/recipes/suggest 400s a missing/invalid target BEFORE any AI call", async () => {
  const orig = (globalThis as any).fetch;
  let called = false;
  (globalThis as any).fetch = async () => { called = true; return new Response("{}"); };
  try {
    const { req } = client();
    const res = await req("/api/recipes/suggest", { method: "POST", body: JSON.stringify({ method: "balanced" }) });
    assert.equal(res.status, 400);
    assert.equal(called, false, "no AI call on a validation failure");
  } finally { (globalThis as any).fetch = orig; }
});

test("POST /api/recipes/suggest injects PROFILE allergies, ignores body allergies, and returns ideas", async () => {
  const orig = (globalThis as any).fetch;
  try {
    const { req, platform, inst } = client();
    // Seed the profile's allergies (Phase-4 field) directly on the user store.
    const store = platform.data.forUser(TEST_EMAIL);
    await store.create("profiles", { user: TEST_EMAIL, email: TEST_EMAIL, allergies: "peanuts, shellfish" }, TEST_EMAIL);
    const cap = stubGemini(platform, { ideas: [
      { name: "Chicken rice bowl", kcal: 650, protein: 45, carbs: 60, fat: 20, blurb: "Fast and lean." },
    ]});
    const res = await req("/api/recipes/suggest", {
      method: "POST",
      body: JSON.stringify({
        target: { kcal: 650, protein: 45, carbs: 60, fat: 20 },
        method: "high-protein", prefs: "quick",
        allergies: "IGNORE-ME-CLIENT", // must NOT reach the model
      }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ideas.length, 1);
    assert.equal(body.ideas[0].name, "Chicken rice bowl");
    assert.equal(body.ideas[0].kcal, 650);
    // Server-side allergies invariant:
    const prompt = sentText(cap.body);
    assert.match(prompt, /peanuts, shellfish/, "profile allergies reached the model");
    assert.doesNotMatch(prompt, /IGNORE-ME-CLIENT/, "client body allergies MUST NOT reach the model");
    // Usage accounting (recordUsage wrote to the instance ai_usage collection):
    const usage = inst.colls.get("ai_usage");
    assert.ok(usage && usage.size >= 1, "usage recorded");
  } finally { (globalThis as any).fetch = orig; }
});

test("POST /api/recipes/expand returns the full recipe shape and carries profile allergies", async () => {
  const orig = (globalThis as any).fetch;
  try {
    const { req, platform } = client();
    const store = platform.data.forUser(TEST_EMAIL);
    await store.create("profiles", { user: TEST_EMAIL, email: TEST_EMAIL, allergies: "dairy" }, TEST_EMAIL);
    const cap = stubGemini(platform, {
      name: "Chicken rice bowl", servings: 1,
      ingredients: [{ item: "Chicken breast", amount: "150 g" }, { item: "Rice", amount: "1 cup" }],
      steps: ["Cook rice.", "Grill chicken.", "Combine."],
      kcal: 650, macros: { protein: 45, carbs: 60, fat: 20 },
    });
    const res = await req("/api/recipes/expand", {
      method: "POST",
      body: JSON.stringify({ idea: "Chicken rice bowl", target: { kcal: 650, protein: 45, carbs: 60, fat: 20 } }),
    });
    assert.equal(res.status, 200);
    const r = await res.json();
    assert.equal(r.name, "Chicken rice bowl");
    assert.equal(r.ingredients.length, 2);
    assert.equal(r.steps.length, 3);
    assert.equal(r.macros.protein, 45);
    assert.match(sentText(cap.body), /dairy/);
  } finally { (globalThis as any).fetch = orig; }
});

test("POST /api/recipes/expand 400s a missing idea", async () => {
  const { req } = client();
  const res = await req("/api/recipes/expand", { method: "POST", body: JSON.stringify({ target: { kcal: 500 } }) });
  assert.equal(res.status, 400);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd ~/gitrepos/sate/core && npm test`
Expected: FAIL — `/api/recipes/*` 404 (routes not mounted).

- [ ] **Step 3: Create `core/src/api/recipes.ts`**

```typescript
// Sate core — Recipe suggester routes (spec §7). Two AI-backed endpoints inside "plan a meal":
//   POST /api/recipes/suggest  → ~5 compact ideas fitting a numeric target
//   POST /api/recipes/expand   → one idea → a full recipe with per-serving macros
// Both are gated by requireAI and run through the AI callers (callAI → usage/limits accounting).
// ALLERGIES ARE SERVER-AUTHORITATIVE: read from profile.allergies (ensureProfile), never from the
// client body — a client cannot spoof or suppress a user's dietary restrictions.

import {
  getUid,
  getEmail,
  ok,
  err,
  ensureProfile,
  type App,
  type RouteDeps,
} from "./helpers";
import { suggestRecipes, expandRecipe } from "../ai/index";
import type { RecipeTarget } from "../ai/prompts";

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const msgOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

// A usable target needs at least a positive calorie figure; macros default to 0 when absent.
function readTarget(raw: any): RecipeTarget | null {
  if (!raw || typeof raw !== "object") return null;
  const t: RecipeTarget = { kcal: num(raw.kcal), protein: num(raw.protein), carbs: num(raw.carbs), fat: num(raw.fat) };
  if (t.kcal <= 0) return null;
  return t;
}

export async function registerRecipes(app: App, deps: RouteDeps): Promise<void> {
  const { platform, requireAI } = deps;

  // POST /api/recipes/suggest — compact ideas fitting the (server-validated) target. Allergies from profile.
  app.post("/api/recipes/suggest", requireAI, async (c) => {
    const uid = getUid(c);
    const profile = await ensureProfile(platform, uid, getEmail(c));
    const b = (await c.req.json().catch(() => ({}))) as Record<string, any>;
    const target = readTarget(b.target);
    if (!target) return err(c, "a target with a positive kcal is required", 400);
    const method = b.method !== undefined ? String(b.method).slice(0, 200) : "";
    const prefs = b.prefs !== undefined ? String(b.prefs).slice(0, 1000) : "";
    try {
      const out = await suggestRecipes(platform, {
        target,
        method,
        prefs,
        allergies: profile.allergies || "", // SERVER-SIDE ONLY — never b.allergies
      });
      return ok(c, out);
    } catch (e) {
      return err(c, msgOf(e), 502);
    }
  });

  // POST /api/recipes/expand — one idea → full recipe. Allergies from profile.
  app.post("/api/recipes/expand", requireAI, async (c) => {
    const uid = getUid(c);
    const profile = await ensureProfile(platform, uid, getEmail(c));
    const b = (await c.req.json().catch(() => ({}))) as Record<string, any>;
    const ideaName =
      b.idea && typeof b.idea === "object" ? String(b.idea.name || "") : String(b.idea || "");
    if (!ideaName.trim()) return err(c, "idea is required", 400);
    const target = readTarget(b.target) || undefined;
    const prefs = b.prefs !== undefined ? String(b.prefs).slice(0, 1000) : "";
    try {
      const out = await expandRecipe(platform, {
        idea: ideaName.slice(0, 300),
        target,
        prefs,
        allergies: profile.allergies || "", // SERVER-SIDE ONLY
      });
      return ok(c, out);
    } catch (e) {
      return err(c, msgOf(e), 502);
    }
  });
}
```

- [ ] **Step 4: Mount `registerRecipes` in `core/src/api/index.ts`**

Add the import beside the other domain imports:
```typescript
import { registerRecipes } from "./recipes";
```
Add the mount inside `buildApi`, after `registerPlan`:
```typescript
  void registerRecipes(app, deps); // /api/recipes/suggest, /api/recipes/expand (AI; allergies server-side)
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd ~/gitrepos/sate/core && npm test`
Expected: PASS — all four recipe-route tests green (validation, allergies-server-side, passthrough shape, usage accounting); all prior tests green.

- [ ] **Step 6: Typecheck**

Run: `cd ~/gitrepos/sate-cloud && npx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 7: Commit**

```bash
cd ~/gitrepos/sate
git add core/src/api/recipes.ts core/src/api/index.ts core/test/recipes.test.ts
git commit -m "feat(core): POST /api/recipes/suggest + /expand (allergies server-side, via callAI)"
```

---

### Task 5: Inject `profiles.allergies` into the nutritionist coach (spec §7.3)

The same remembered allergies must steer the coach. Append `allergiesLine(profile.allergies)` to the nutritionist context server-side, and add one sentence to `NUTRITIONIST_SYSTEM` so the coach treats it as a hard constraint. The system-prompt sentence is verified by the pure prompt test; the context injection is verified pure (the coach route's AI call is live-verified, matching the existing coach tests which are live-only).

**Files:**
- Modify: `core/src/shared/prompts.js` (`NUTRITIONIST_SYSTEM` — one sentence)
- Modify: `core/src/api/coach.ts` (`/api/nutritionist` — append the allergy line to `context`)
- Modify: `core/test/recipes-prompts.test.ts` (assert the sentence is present)

**Interfaces:**
- Consumes: `allergiesLine` (Task 1), `ensureProfile` (already used in `/api/nutritionist`).
- Produces: the coach context now carries the user's allergies; `NUTRITIONIST_SYSTEM` instructs the coach to respect them.

- [ ] **Step 1: Append the failing assertion to `core/test/recipes-prompts.test.ts`**

```typescript
test("NUTRITIONIST_SYSTEM instructs the coach to respect dietary restrictions/allergies", () => {
  assert.match(PROMPTS.nutritionist.system, /allerg|dietary restriction|restriction/i);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd ~/gitrepos/sate/core && npm test`
Expected: FAIL — `NUTRITIONIST_SYSTEM` has no allergy language yet.

- [ ] **Step 3: Add the sentence to `NUTRITIONIST_SYSTEM` in `core/src/shared/prompts.js`**

Insert into the meal-help guidance (right before the closing "You are not a doctor…" sentence), so the coach honors restrictions in every suggestion:
```javascript
  "When the CONTEXT lists the user's dietary restrictions or allergies, treat them as a HARD " +
  "constraint: never suggest a meal, food, or swap that includes a restricted or allergenic " +
  "ingredient. " +
```
(Concatenate it into the existing `NUTRITIONIST_SYSTEM` string — it is one big `+`-joined literal; add this fragment in the meal-help paragraph.)

- [ ] **Step 4: Inject the allergies line into the coach context in `core/src/api/coach.ts`**

Import `allergiesLine` from the AI barrel (it re-exports the shared module). Add to the existing `from "../ai/index"` import list:
```typescript
  allergiesLine,
```
In `POST /api/nutritionist`, immediately after `const context = nutrition.contextText(inp, plan, recent);`, append the allergy line when present:
```typescript
    // Remembered dietary restrictions/allergies steer the coach too (spec §7.3), read server-side
    // from the profile — never from the request body.
    const alLine = allergiesLine(profile.allergies);
    const contextWithAllergies = alLine ? context + "\n" + alLine : context;
```
and pass `contextWithAllergies` to `nutritionist({ … context: contextWithAllergies, … })` instead of `context`.

- [ ] **Step 5: Run the tests + typecheck**

Run: `cd ~/gitrepos/sate/core && npm test` then `cd ~/gitrepos/sate-cloud && npx tsc --noEmit`
Expected: PASS — the system-prompt assertion green; typecheck exit 0. (The context-injection line is a straight-line append over `profile.allergies`, which `ensureProfile` already loaded; its effect on the AI is verified live in Task 8.)

- [ ] **Step 6: Commit**

```bash
cd ~/gitrepos/sate
git add core/src/shared/prompts.js core/src/api/coach.ts core/test/recipes-prompts.test.ts
git commit -m "feat(core): inject profile.allergies into the nutritionist coach (spec §7.3)"
```

---

### Task 6: Pure `remainingBudget(goals, totals)` — the target prefill

The recipe target is prefilled from the **remaining budget** = the user's daily goal minus today's LOGGED totals. Extract that as a pure, tested helper in the import-free `planner.js` so the DOM (Task 7) just calls it. Never goes negative (a blown budget prefills 0, not a negative target).

**Files:**
- Modify: `core/src/web/planner.js`
- Modify: `core/test/planner-ui.test.ts` (append)

**Interfaces:**
- Produces: `remainingBudget(goals, totals): { kcal, protein, carbs, fat }` — each `max(0, round(goal − logged))`; missing goal/total treated as 0.

- [ ] **Step 1: Append the failing tests to `core/test/planner-ui.test.ts`**

```typescript
import { remainingBudget } from "../src/web/planner.js";

test("remainingBudget subtracts logged totals from goals, clamped at 0", () => {
  const r = remainingBudget(
    { kcal: 2000, protein: 150, carbs: 200, fat: 60 },
    { kcal: 1400, protein: 90, carbs: 160, fat: 45 },
  );
  assert.deepEqual(r, { kcal: 600, protein: 60, carbs: 40, fat: 15 });
});

test("remainingBudget never returns a negative target", () => {
  const r = remainingBudget({ kcal: 1800, protein: 120, carbs: 150, fat: 50 },
                            { kcal: 2200, protein: 140, carbs: 150, fat: 70 });
  assert.deepEqual(r, { kcal: 0, protein: 0, carbs: 0, fat: 0 });
});

test("remainingBudget tolerates missing goals/totals (treats as 0)", () => {
  assert.deepEqual(remainingBudget(null, null), { kcal: 0, protein: 0, carbs: 0, fat: 0 });
  assert.deepEqual(remainingBudget({ kcal: 500 }, {}), { kcal: 500, protein: 0, carbs: 0, fat: 0 });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd ~/gitrepos/sate/core && npm test`
Expected: FAIL — `remainingBudget` is not exported.

- [ ] **Step 3: Add `remainingBudget` to `core/src/web/planner.js`**

Append (reusing the module's existing `num` helper):
```javascript
// The remaining daily budget = goal − today's LOGGED totals, per macro, clamped at 0. Drives the
// recipe suggester's prefilled (editable) target (spec §7.2). Pure — the DOM passes me().goals + the
// server-authoritative today totals; this never re-sums anything.
export function remainingBudget(goals, totals) {
  const g = goals || {};
  const t = totals || {};
  const left = (goal, used) => Math.max(0, Math.round(num(goal) - num(used)));
  return {
    kcal: left(g.kcal, t.kcal),
    protein: left(g.protein, t.protein),
    carbs: left(g.carbs, t.carbs),
    fat: left(g.fat, t.fat),
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd ~/gitrepos/sate/core && npm test`
Expected: PASS — the three `remainingBudget` tests green; all prior tests green.

- [ ] **Step 5: Commit**

```bash
cd ~/gitrepos/sate
git add core/src/web/planner.js core/test/planner-ui.test.ts
git commit -m "feat(web): pure remainingBudget helper (recipe target prefill)"
```

---

### Task 7: Make the "Suggest a recipe" seam LIVE in `planevent.js`

Replace the disabled "✨ Suggest a recipe (soon)" button (Phase 3 seam) with a live recipe panel inside the plan-a-meal fill step: a target prefilled from `remainingBudget(me().goals, me().totals)` (editable), an optional prefs box, a compact ideas list (name · kcal · macros · blurb) with **re-roll**, tap an idea → the full recipe (ingredients + steps + per-serving macros), then **"Add to plan"** (populate the planevent form `F` and return to the main flow → the existing `buildPlanRequest` submit makes a PLANNED entry/schedule) or **"Log now"** (`POST /api/foods/manual` → a logged entry immediately). All AI text is `esc()`-escaped. DOM → complete code + LIVE steps.

**Files:**
- Modify: `core/src/web/views/planevent.js`
- Modify: `core/src/web/style.css`

**Interfaces:**
- Consumes: `planner.js` (`remainingBudget`); `lib.js` (`el`, `esc`, `api`, `toast`, `busy`, `me`, `fmt`); the existing `planevent` form state `F` + `submit()`.
- Produces: a recipe sub-panel opened from the fill step; on "Add to plan" it writes name/kcal/macros/note into `F` and re-renders the fill (the user's chosen date/time/repeat still apply); on "Log now" it POSTs `/api/foods/manual` and closes.

- [ ] **Step 1: Extend the imports in `core/src/web/views/planevent.js`**

Add `me` and `fmt` to the existing `from "../lib.js"` import, and `remainingBudget` to the `from "../planner.js"` import:
```javascript
import {
  $$, el, esc, api, toast, busy, sheet, openView, registerView, tzOffset, todayISO, me, fmt,
} from "../lib.js";
import { buildPlanRequest, remainingBudget } from "../planner.js";
```

- [ ] **Step 2: Replace the disabled recipe seam with a live button**

In `renderFill(host)`, REPLACE the disabled seam button:
```javascript
    el("button", { class: "link", type: "button", disabled: "", title: "Coming soon", text: "✨ Suggest a recipe (soon)" }),
```
with a live one (meals only — recipes are a food concept):
```javascript
    ...(F.kind === "activity" ? [] : [
      el("button", { class: "link", type: "button", text: "✨ Suggest a recipe", onClick: () => openRecipePanel() }),
    ]),
```

- [ ] **Step 3: Add the recipe panel to `core/src/web/views/planevent.js`**

Append (view-local state + the panel; escapes all AI text):
```javascript
// ---- recipe suggester (spec §7): prefilled editable target → ideas → full recipe → plan | log ----
let R = null; // { target, prefs, ideas, chosen, recipe }

// The prefilled target = the remaining daily budget (goal − today's logged totals), editable.
function initRecipeState() {
  const m = me() || {};
  const t = remainingBudget(m.goals, m.totals);
  // If the meal already has numbers typed, prefer those; else use the remaining budget.
  R = {
    target: {
      kcal: num(F.kcal) || t.kcal,
      protein: num(F.macros.protein) || t.protein,
      carbs: num(F.macros.carbs) || t.carbs,
      fat: num(F.macros.fat) || t.fat,
    },
    prefs: "",
    ideas: null,
    chosen: null,
    recipe: null,
  };
}

function openRecipePanel() {
  initRecipeState();
  recipeCtrl = sheet({
    title: "Suggest a recipe",
    className: "recipesheet",
    onClose: () => { recipeCtrl = null; },
    body: (b) => renderRecipe(b),
  });
}
let recipeCtrl = null;

function renderRecipe(host) {
  host.innerHTML = "";
  // 1) editable target
  const tgt = el("div", { class: "rtarget" });
  [["kcal", "Calories"], ["protein", "Protein (g)"], ["carbs", "Carbs (g)"], ["fat", "Fat (g)"]].forEach(([k, label]) => {
    const inp = el("input", { type: "number", step: "any", inputmode: "decimal", value: String(R.target[k] || 0) });
    inp.addEventListener("input", () => { R.target[k] = num(inp.value); });
    tgt.append(el("label", { class: "mfield" }, el("span", { text: label }), inp));
  });
  // 2) prefs
  const prefs = el("input", { type: "text", placeholder: "Preferences (optional) — e.g. quick, vegetarian, no oven", value: R.prefs });
  prefs.addEventListener("input", () => { R.prefs = prefs.value; });
  // 3) actions + results
  const results = el("div", { class: "rresults" });
  const go = el("button", { class: "primary", type: "button", text: R.ideas ? "Re-roll" : "Get ideas",
    onClick: () => loadIdeas(results, go) });

  host.append(
    el("div", { class: "field-lbl", text: "Target (prefilled from your remaining budget — edit freely)" }),
    tgt,
    el("label", { class: "field" }, "Preferences", prefs),
    el("div", { class: "sheet-actions", style: { marginTop: "8px" } }, go),
    results,
  );
  if (R.recipe) renderFullRecipe(results);
  else if (R.ideas) renderIdeas(results);
}

async function loadIdeas(results, goBtn) {
  R.recipe = null; R.chosen = null;
  busy("Finding recipes…");
  try {
    const r = await api("/api/recipes/suggest", { method: "POST",
      json: { target: R.target, method: (me() || {}).track_mode || "", prefs: R.prefs } });
    R.ideas = (r && r.ideas) || [];
    goBtn.textContent = "Re-roll";
    renderIdeas(results);
  } catch (e) { toast(e.message); }
}

function renderIdeas(host) {
  host.innerHTML = "";
  if (!R.ideas.length) { host.append(el("div", { class: "hint", text: "No ideas fit that target — adjust it and try again." })); return; }
  const list = el("div", { class: "idealist" });
  R.ideas.forEach((idea) => {
    const macro = fmt(idea.kcal) + " kcal · " + fmt(idea.protein) + "P / " + fmt(idea.carbs) + "C / " + fmt(idea.fat) + "F";
    const card = el("button", { class: "ideacard", type: "button" },
      el("div", { class: "iname", text: idea.name }),          // text node → esc-safe
      el("div", { class: "imacro", text: macro }),
      el("div", { class: "iblurb", text: idea.blurb || "" }),
    );
    card.addEventListener("click", () => expandIdea(idea, host));
    list.append(card);
  });
  host.append(list);
}

async function expandIdea(idea, host) {
  R.chosen = idea;
  busy("Building the recipe…");
  try {
    const r = await api("/api/recipes/expand", { method: "POST",
      json: { idea: idea.name, target: R.target, prefs: R.prefs } });
    R.recipe = r;
    renderFullRecipe(host);
  } catch (e) { toast(e.message); }
}

function renderFullRecipe(host) {
  host.innerHTML = "";
  const r = R.recipe;
  const ing = el("ul", { class: "ringlist" });
  (r.ingredients || []).forEach((g) => ing.append(el("li", { text: (g.amount ? g.amount + " " : "") + g.item })));
  const steps = el("ol", { class: "rsteps" });
  (r.steps || []).forEach((s) => steps.append(el("li", { text: s })));
  const macro = fmt(r.kcal) + " kcal · " + fmt(r.macros.protein) + "P / " + fmt(r.macros.carbs) + "C / " + fmt(r.macros.fat) + "F  (per serving)";
  const back = el("button", { class: "link", type: "button", text: "← Back to ideas", onClick: () => { R.recipe = null; renderIdeas(host); } });
  const addPlan = el("button", { class: "primary", type: "button", text: "Add to plan", onClick: () => addRecipeToPlan() });
  const logNow = el("button", { class: "ghost", type: "button", text: "Log now", onClick: () => logRecipeNow() });
  host.append(
    el("div", { class: "rtitle", text: r.name + (r.servings ? " · serves " + r.servings : "") }),
    el("div", { class: "imacro", text: macro }),
    el("div", { class: "field-lbl", text: "Ingredients" }), ing,
    el("div", { class: "field-lbl", text: "Steps" }), steps,
    el("div", { class: "rrow" }, addPlan, logNow),
    back,
  );
}

// A recipe → a note string stored on the resulting entry/schedule for reference (spec §7.2).
function recipeNote(r) {
  const ing = (r.ingredients || []).map((g) => "- " + (g.amount ? g.amount + " " : "") + g.item).join("\n");
  const steps = (r.steps || []).map((s, i) => (i + 1) + ". " + s).join("\n");
  return "Ingredients:\n" + ing + "\n\nSteps:\n" + steps;
}

// "Add to plan" → hand off to the plan-an-event flow: fill F with the recipe's content, close the
// recipe sheet, and re-render the fill step. The user's already-chosen date/time/repeat still apply;
// the existing "Add to plan" submit runs buildPlanRequest → a PLANNED entry (or schedule).
function addRecipeToPlan() {
  const r = R.recipe;
  F.name = r.name; F.description = r.name;
  F.kcal = String(Math.round(num(r.kcal)));
  F.macros = { protein: String(Math.round(num(r.macros.protein))), carbs: String(Math.round(num(r.macros.carbs))), fat: String(Math.round(num(r.macros.fat))) };
  F.note = recipeNote(r);
  if (recipeCtrl) recipeCtrl.close();
  recipeCtrl = null;
  toast("Recipe added — set the date/time and tap Add to plan.");
  // Re-render the whole plan sheet body so the filled numbers show.
  if (planCtrl && planCtrl.body) renderForm(planCtrl.body);
}

// "Log now" → a LOGGED entry immediately (honesty: this one counts). Reuses /api/foods/manual.
async function logRecipeNow() {
  const r = R.recipe;
  busy("Logging…");
  try {
    await api("/api/foods/manual", { method: "POST", json: {
      name: r.name,
      serving_desc: r.servings ? ("1 of " + r.servings + " servings") : "1 serving",
      note: recipeNote(r),
      kcal: num(r.kcal), protein: num(r.macros.protein), carbs: num(r.macros.carbs), fat: num(r.macros.fat),
      fiber: num(r.macros.fiber), sugar: num(r.macros.sugar), sodium: num(r.macros.sodium), sat_fat: num(r.macros.sat_fat),
      tz_offset_min: tzOffset(),
    } });
    toast("Logged.");
    if (recipeCtrl) recipeCtrl.close();
    recipeCtrl = null;
    if (planCtrl) planCtrl.close();
    planCtrl = null;
    try { renderHome(); } catch (_) {}
  } catch (e) { toast(e.message); }
}
```

Note on `sheet()`/`planCtrl.body`: confirm against `lib.sheet`'s returned controller whether the body element is exposed (Phase 3's `planevent` uses `sheet({ body: (b) => renderForm(b) })`). If the controller does not expose `.body`, keep a module-local reference to the fill host captured in `renderForm`/`open` (e.g. store `planBody` when `renderForm(host)` runs) and re-render from that instead of `planCtrl.body`. Wire whichever the actual `lib.sheet` contract supports — the behavior (re-render the fill step after "Add to plan") is the requirement.

- [ ] **Step 4: Add the recipe-panel styles to `core/src/web/style.css`**

```css
/* ---- Planner: recipe suggester panel ---- */
.recipesheet .rtarget { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.recipesheet .rresults { margin-top: 10px; }
.recipesheet .idealist { display: flex; flex-direction: column; gap: 8px; }
.recipesheet .ideacard { text-align: left; width: 100%; padding: 10px 12px; border: 1px solid var(--line); border-radius: 12px; background: transparent; cursor: pointer; }
.recipesheet .ideacard:active { transform: translateY(1px); }
.recipesheet .iname { font-weight: 700; }
.recipesheet .imacro { color: var(--muted); font-size: 12.5px; margin-top: 2px; }
.recipesheet .iblurb { color: var(--muted); font-size: 13px; margin-top: 4px; }
.recipesheet .rtitle { font-weight: 800; font-size: 16px; margin-bottom: 2px; }
.recipesheet .ringlist, .recipesheet .rsteps { margin: 6px 0 0 18px; display: flex; flex-direction: column; gap: 4px; }
.recipesheet .rrow { display: flex; gap: 10px; margin-top: 14px; }
.recipesheet .rrow .primary, .recipesheet .rrow .ghost { flex: 1 1 0; }
.recipesheet .rrow .ghost { background: transparent; color: var(--brand); border: 1.5px solid color-mix(in srgb, var(--brand) 45%, var(--line)); border-radius: 10px; font-weight: 700; }
```

- [ ] **Step 5: LIVE verification on sate.health** (`god` account; run after the sate-cloud deploy — Task 8)

1. **Seam is live:** open `Plan` → Meal → fill step now shows **"✨ Suggest a recipe"** (enabled). Activity kind does NOT show it.
2. **Prefilled target:** the panel opens with the target prefilled from the remaining budget (log some food first, confirm the target ≈ goal − logged). Editing the numbers sticks.
3. **Ideas + re-roll:** "Get ideas" returns ~5 ideas (name · kcal · P/C/F · blurb); "Re-roll" fetches a fresh set. Compare the JSON against `POST /api/recipes/suggest` via curl with the god token.
4. **Expand:** tapping an idea shows the full recipe (ingredients + steps + per-serving macros); "← Back to ideas" returns.
5. **Allergies honored (critical):** set `profiles.allergies` (e.g. "shellfish, peanuts") via Settings/Plan tab (Phase 4) or `PATCH /api/goals`. Re-roll → no idea/recipe includes those. Send a `POST /api/recipes/suggest` body with a *different* `allergies` value via curl — the model still honors the PROFILE allergies, not the body (server-side invariant).
6. **Add to plan:** on the recipe, "Add to plan" closes the recipe sheet, fills the meal name/kcal/macros in the plan sheet; set a future date → "Add to plan" → it appears ghosted on Home's timeline (PLANNED, not counted; honesty). The stored entry's note carries the recipe.
7. **Log now:** on another recipe, "Log now" creates a logged entry immediately (counts toward today's totals via `/api/foods/manual`), the sheets close, Home refreshes.
8. **XSS:** none of the AI text is interpreted as HTML (all rendered as text nodes / `esc()`).

- [ ] **Step 6: Commit**

```bash
cd ~/gitrepos/sate
git add core/src/web/views/planevent.js core/src/web/style.css
git commit -m "feat(web): live recipe suggester in plan-a-meal (ideas → recipe → plan | log)"
```

---

### Task 8: Full-suite green + typecheck + build + sync to sate-cloud + live smoke

The final gate: the whole suite green, typecheck clean, the SPA builds (so the `planevent.js` changes land in the fingerprinted bundle), `core/` synced into the sate-cloud subtree, and the recipe + allergy scenario verified live. No new behavior.

**Files:** None new. Verification + build + subtree sync.

- [ ] **Step 1: Run the whole suite**

Run: `cd ~/gitrepos/sate/core && npm test`
Expected: PASS — `recipes-prompts` (registry/builders/normalizers/allergiesLine/coach-sentence) + `recipes` (route validation/allergies-server-side/passthrough/usage) + `planner-ui` (`remainingBudget`) + all Phase 1–4 tests green; `ℹ fail 0`.

- [ ] **Step 2: Typecheck**

Run: `cd ~/gitrepos/sate-cloud && npx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 3: Build the SPA (confirm `planevent.js` bundles, no dead files, no build error)**

Run (after syncing core → sate-cloud, Step 5, or against a local copy): `cd ~/gitrepos/sate-cloud && node scripts/build-web.mjs`
Expected: completes; `web/app.<hash>.js` rewritten. `planevent.js`/`planner.js` are already in the graph (Phase 3); no `?vN` was added.

- [ ] **Step 4: Confirm git state + the phase-5 commits**

Run: `cd ~/gitrepos/sate && git log --oneline -10 && git status --porcelain`
Expected: the Task 1–7 commits (+ optional Task 0) present; no uncommitted changes.

- [ ] **Step 5: Sync `core/` into sate-cloud (subtree)**

Per the `sate-core-unification` memory, sate-cloud vendors `core/` as a subtree and MUST stay byte-identical (includes `core/src/shared`, `core/src/ai`, `core/src/api`, `core/src/web`). Use the repo's sync tool — **run it with `bash`, not `sh`** — and coordinate the exact sync/push step with the user (this plan's scope is core-side; the sate-cloud PR/deploy is a follow-up).

Run (verify byte-identical after sync): `diff -rq ~/gitrepos/sate/core/src ~/gitrepos/sate-cloud/core/src`
Expected: no differences once synced.

- [ ] **Step 6: Live smoke test on sate.health (after the sate-cloud deploy)**

As the `god` account on the deployed Cloud revision:
1. **Suggest fits the target:** `POST /api/recipes/suggest` (or via the UI) with a 650 kcal / 45P target → ~5 ideas roughly at that target; re-roll returns a fresh set.
2. **Expand:** `POST /api/recipes/expand` on one idea → a coherent recipe (ingredients + steps + per-serving macros).
3. **Allergies (server-side):** set `profiles.allergies="shellfish"`; suggest/expand omit shellfish; a curl body with `allergies:"none"` does NOT override it.
4. **Coach honors allergies:** ask the nutritionist "suggest me a dinner" → its suggestions respect the profile allergies (spec §7.3).
5. **Usage/limits accounting:** the admin usage counter for the Flash model increments per suggest/expand call (through `callAI` → `recordUsage`).
6. **Add to plan → honesty:** a recipe "Add to plan" → a ghosted planned entry that does NOT move the stat card until accepted; "Log now" → an immediate logged entry that does.
7. Clean up created entries/schedules and reset `profiles.allergies` if it was a throwaway change. Document the result. (Runs only after the sate-cloud deploy in the follow-up; noted here so Phase 5 isn't marked "done" until verified live.)

---

## Self-Review

**Spec coverage (Phase 5 scope = spec §13.5: recipe suggester §7 + `profiles.allergies` §2.4):**

| Spec | Requirement | Task |
|---|---|---|
| §7.1 | `recipe_suggest` added to the registry (`FUNCTIONS`, `PROMPTS`, system prompt) | Task 1 (+ `recipe_expand` sibling — see decision below) |
| §7.1 | `POST /api/recipes/suggest` — body `{target, method, prefs}` → `{ideas:[{name,kcal,protein,carbs,fat,blurb}]}`, ~5 ideas | Task 2 (builder+normalizer), Task 3 (caller), Task 4 (route) |
| §7.1 | allergies pulled from the profile server-side (never client) | Task 4 (route reads `profile.allergies`, never `b.allergies`; harness-asserted), Task 2 (builder carries it) |
| §7.1 | `POST /api/recipes/expand` — `{idea, target, prefs}` → `{name,servings,ingredients,steps,kcal,macros}` | Task 2/3/4 |
| §7.1 | Latest Flash by default; routed via the same admin function-config; through `callAI` (usage/limits) | Task 3 (`resolveDefaultModel("ai")` + `callAI`) |
| §7.2 | target prefilled from remaining budget (`goal − logged`), editable | Task 6 (`remainingBudget`), Task 7 (panel) |
| §7.2 | optional free-text prefs; compact ideas list + re-roll; tap → full recipe | Task 7 |
| §7.2 | "Add to plan" (planned entry/schedule, recipe in items/note) OR "Log now" (logged entry) | Task 7 (`addRecipeToPlan` → `buildPlanRequest`; `logRecipeNow` → `/api/foods/manual`) |
| §7.3 / §2.4 | `profiles.allergies` auto-applied to `recipe_suggest` AND the nutritionist coach | Task 4 (recipes), Task 5 (coach) |
| §2.4 | `profiles.allergies?: string` exists | Task 0 (Phase-4 dependency guard) |
| §3 honesty | "Add to plan" = planned (not counted); "Log now" = logged | Task 7 (reuses Phase-1 planned/logged primitives — no new totalling path) |

**Explicitly OUT of scope (owned elsewhere):** the `allergies` **edit UI** (Settings + Plan tab) and the `Profile.allergies` **field/persistence** are Phase 4 — Phase 5 only CONSUMES the field (Task 0 guards it). Coach plan-edit (`<<PLAN_CHANGE>>`, §10) is Phase 6. The timeline/accept/schedules (§4–6) are Phases 1–3. Called out, not conflated.

**Key decision — `recipe_expand` registered alongside `recipe_suggest`:** the spec names only `recipe_suggest` but describes "two calls" with two distinct prompts + JSON schemas. Registering `recipe_expand` as its own `FUNCTIONS`/`PROMPTS` entry (rather than overloading `recipe_suggest`) keeps each call independently prompted and admin-routable "via the same admin function-config as other functions" (§7.1) — a function that isn't in the registry can't be routed. Both default to Flash. Flagged for the reader (open question 1).

**Verification split (decided + stated):** Maximum logic is pure and fully TDD'd — the prompt **builders** (assert target/method/prefs/**allergies** all reach the model, and that the allergy line is absent when there are none), the defensive **normalizers** (strict-JSON + fallback + type/count clamping over garbage), `allergiesLine`, the coach system-prompt sentence, and the client `remainingBudget`. The two routes' **non-model** behavior is harness-TDD'd via a **captured-fetch stub** (stub `platform.secrets.get` + `globalThis.fetch`, capture the outgoing Gemini request) — this makes the **server-side-allergies invariant** (profile value present, client body value absent in the sent prompt), the **validation short-circuits**, the **passthrough shape**, and **usage accounting** (`ai_usage` row) all deterministic unit assertions with no real model. Only model *quality* (ideas fit the target, real allergies honored, coach honors them) + the live usage counter are LIVE on sate.health, matching the coach routes' live-only precedent. The recipe panel DOM is thin over tested pure outputs, verified by explicit LIVE steps (no jsdom introduced).

**Placeholder scan:** No TBD/TODO-in-code/"similar to Task N". Every pure/backend step shows complete code + full assertions; every DOM step shows complete code; every run/live step gives the exact command or user action + expected result. The one conditional (Task 0 Step 2) is a dependency guard with complete code, explicitly gated on the grep result — not an unfinished placeholder. The Phase-3 "Suggest a recipe (soon)" disabled seam is turned live in Task 7 (no seam left dangling). The single flagged wiring uncertainty (`sheet()` controller's `.body` vs a captured host in Task 7 Step 3) states both the requirement and the fallback.

**Type/interface consistency:** the routes' request/response shapes match the spec verbatim — suggest in `{target:{kcal,protein,carbs,fat}, method, prefs}` → out `{ideas:[{name,kcal,protein,carbs,fat,blurb}]}`; expand in `{idea, target, prefs}` → out `{name,servings,ingredients:[{item,amount}],steps,kcal,macros{…}}`. `RecipeTarget`/`RecipeIdeas`/`Recipe` are declared once in `prompts.d.ts` and consumed by the callers (`ai/index.ts`) and the route (`recipes.ts`). `suggestRecipes`/`expandRecipe` mirror `estimateNutrition`'s signature (`(platform, input)`), resolve the same default model, and funnel through the same `callAI`. `allergiesLine` is defined once in `shared/prompts.js` and used by BOTH the recipe builders and the coach injection (DRY — one place decides the allergy-line wording). The client `remainingBudget(me().goals, me().totals)` consumes exactly the `/api/me` `goals`/`totals` shape (`profileView` `goalsOf` + `sumIntake`). "Add to plan" reuses the Phase-3 `buildPlanRequest` (the recipe fills `F`, the existing submit builds the request); "Log now" matches `/api/foods/manual`'s body (`name, serving_desc, note, kcal + macro keys, tz_offset_min`). `shared/prompts.js` additions stay goja-safe ES2015 (var/function, string concat, no spread) so the Hosted edition still `require()`s it.

**Open questions flagged for the reader (also in the report):**
1. **`recipe_expand` as a second registered function** (vs overloading `recipe_suggest`) — chosen for admin-routability + distinct prompts; confirm.
2. **Idea count** — the prompt asks for "about 5"; the normalizer clamps to ≤ 8. Confirm 5 is the target and there's no hard min.
3. **Method source for the target** — Task 7 passes `me().track_mode` as the recipe `method` (the user's tracking method). Confirm that's the intended "method" for §7.1, vs a separate per-recipe method picker.
4. **"Log now" endpoint** — reuses `/api/foods/manual` (saves the food to the KB *and* logs it). Confirm saving the recipe as a reusable KB food on "Log now" is desired (vs a log-only path).
5. **Recipe storage on "Add to plan"** — stored as a `note` string (ingredients + steps) on the planned entry. Spec says "recipe stored in `items`/`note`". Confirm `note` is sufficient, or whether structured `items[]` are also wanted.
