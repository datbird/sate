# Planner Phase 6 — Coach edits the plan by chat (`<<PLAN_CHANGE>>` → `/api/plan/apply`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the **Coach change the plan by chat** (spec §10) — "bump me to 1,800 kcal", "higher protein", "push my goal to October" — **without** a Gemini tool-calling framework. The `nutritionist` prompt is extended so that, **only when the user asks to change targets/goals**, the reply ends with a machine-readable trailer `<<PLAN_CHANGE>>{...json...}`. A pure parser strips that trailer from the **visible** reply (the user NEVER sees the raw JSON) and returns it as `plan_change` on the `/api/nutritionist` response. The client renders an **inline Apply / Dismiss card** summarizing the proposal — never a silent rewrite. On **Apply**, `POST /api/plan/apply` **validates** the change server-side, **re-runs the deterministic nutrition engine (`computePlan` + `macroTargets`)** so every number stays self-consistent (the AI's arithmetic is discarded), **persists** the new targets (`goal_kcal`/macros/`method`/`activity_level` via the same profile-goal fields `PATCH /api/goals` writes) + any weight goal (via the same `weight_goals` path `POST /api/weight/goals` writes) + a refreshed `plan_summary`, and returns the updated plan. The Plan-tab card + Home rings reflect it via `refreshMe()`. **The AI is the proposer; the deterministic engine + an explicit user Apply are the authority.**

**Architecture:** All changes land in `@sate/core` (`~/gitrepos/sate/core`), deployed to Cloud (sate.health) via sate-cloud. The risky text-parsing is a pure, goja-safe function in the shared registry `core/src/shared/prompts.js` (`splitPlanChange`) plus one appended instruction paragraph to `NUTRITIONIST_SYSTEM`; its typed mirror is `core/src/shared/prompts.d.ts`. The `/api/nutritionist` route (`core/src/api/coach.ts`) runs `splitPlanChange` on the model reply and returns `{ reply: visibleText, plan_change }`. A new deterministic (NON-AI) route `POST /api/plan/apply` also lands in `core/src/api/coach.ts` — it sits beside `/api/plan/compute` and reuses that file's private `buildPlanInput` / `currentWeightKg` helpers plus `nutrition.computePlan` / `nutrition.macroTargets`, persists goals through the same `Profile` goal fields `PATCH /api/goals` uses, and creates a weight goal through the same `weight_goals` collection `POST /api/weight/goals` uses. Semantic validation (enum/range clamping with the real `GOAL_METHODS`/`ACTIVITY_LEVELS`) lives in the route (`validatePlanChange`), NOT in the shared parser — the pure parser only handles the text-extraction + JSON.parse, returning the raw object. The client work is confined to `core/src/web/views/coach.js` (the inline confirm card) + a little CSS.

**Tech Stack:** TypeScript (Node 24, run via the Phase-1 esbuild bundle + native `node:test`), Hono, Zod, the ports/adapters `DataStore`/`Secrets` abstraction, framework-free ES-module SPA. No new runtime dependencies. `core/src/shared/prompts.js` stays **goja-safe ES2015 CommonJS** (no `?.`, no `??`, no object spread, `var`/`function`, string concatenation not template literals) because the Hosted edition `require()`s it verbatim.

## Global Constraints

Every task inherits these (from the spec `docs/superpowers/specs/2026-07-23-planner-recipes-coach-plan-design.md` §10, §3):

- **Cloud edition only, core-first.** All schema/logic lands in `@sate/core`. The Hosted (`pb_hooks`/`pb_public`) port is explicitly OUT OF SCOPE. But `shared/prompts.js` is shared by both editions, so `splitPlanChange` + the `NUTRITIONIST_SYSTEM` append MUST stay goja-safe ES2015 (see Tech Stack) — a TS-only idiom there breaks the Hosted build even though we don't ship Hosted here.
- **The AI proposes; the deterministic engine + an explicit user Apply are the AUTHORITY.** The model NEVER writes the plan. Only `POST /api/plan/apply` — reached *after* the user taps **Apply** — mutates goals, and it **re-runs `computePlan` + `macroTargets`** to compute the real numbers. The AI's proposed macros are never persisted verbatim; at most the user's requested `goal_kcal` seeds the engine, and the engine derives everything else. This is the single most important invariant to test (mirrors Phase 5's server-authoritative-allergies rule and Phase 1's honesty rule).
- **NEVER a silent plan rewrite.** A `plan_change` on the `/api/nutritionist` response only *proposes*. Nothing is persisted until the user taps **Apply** in the inline card. **Dismiss** changes nothing.
- **The visible reply MUST have the trailer stripped — the user never sees raw JSON.** `splitPlanChange` removes the `<<PLAN_CHANGE>>` marker **and everything after it** from `visibleText`, **even when the trailer JSON is malformed** (in which case `plan_change` is null but no JSON leaks to the UI).
- **Reuse existing primitives — add no parallel paths.** Persisting goals reuses the exact `Profile` goal fields `PATCH /api/goals` writes (`goal_kcal`/`goal_protein`/`goal_carbs`/`goal_fat`/`goal_sodium`/`method`/`activity_level`); a proposed weight goal reuses the `weight_goals` collection + `lbToKg` conversion `POST /api/weight/goals` writes; the plan recompute reuses `buildPlanInput`/`computePlan`/`macroTargets`; the client reflects the change with the existing `refreshMe()`. No new totalling, no new goal store.
- **`/api/plan/apply` is deterministic — NOT `requireAI`.** It runs the pure nutrition engine; it makes no model call and consumes no AI budget (aligns with the AI-spend guardrail — Apply must never fire a paid model). Only `/api/nutritionist` (already `requireAI`) calls the model.
- **Escape ALL AI/derived text in the DOM (XSS).** The inline card renders only validated, structured fields (an enum `method`/`activity_level` token, a numeric `goal_kcal`/`target_lb`, a regex-validated `target_date`) as **text nodes** via `el(tag,{text})` (which sets `textContent`). Never `innerHTML` with any model-derived string. The visible reply bubble keeps `textContent` (existing coach behavior).
- **No asset cache-busting query strings.** `coach.js` is already in the bundle graph; do NOT add `?vN`. New CSS goes in `core/src/web/style.css` (served content-hashed).
- **Test/typecheck gates:** pure/harness tests run via `cd ~/gitrepos/sate/core && npm test`; the typecheck gate `cd ~/gitrepos/sate-cloud && npx tsc --noEmit` must stay exit 0.

---

## The `plan_change` JSON contract (single source of truth — consistent across prompt → parser → route → UI)

The trailer is the **last** thing in the reply, on its own, and looks exactly like:

```
<<PLAN_CHANGE>>{"goal_kcal":1800,"method":"protein","activity_level":"active","weight_goal":{"target_lb":180,"target_date":"2026-10-01"}}
```

The JSON object — **every field optional; at least one present when a change is proposed:**

| Field | Type | Meaning / validation |
|---|---|---|
| `goal_kcal?` | number | An explicit daily calorie target the user asked for. Route clamps to `[safety-floor, 6000]`; seeds the engine's final kcal (macros re-derived from it). |
| `method?` | string | Tracking-method emphasis. MUST be one of `GOAL_METHODS` = `calories \| carb \| protein \| fat \| balanced \| heart`. Anything else is dropped. |
| `activity_level?` | string | MUST be one of `ACTIVITY_LEVELS` = `sedentary \| light \| moderate \| active \| athlete`. Anything else is dropped. |
| `weight_goal?` | `{ target_lb: number, target_date: "YYYY-MM-DD" }` | A new weight goal. `target_lb > 0` and `target_date` matching `^\d{4}-\d{2}-\d{2}$`; else the whole `weight_goal` is dropped. Drives the calorie delta in the recompute + is persisted via the weight-goals path. |

**Split of responsibility:**
- **Pure parser (`splitPlanChange`, shared/prompts.js):** strips the trailer, `JSON.parse`s it, returns the **raw** parsed object (or `null` if absent/malformed/not a plain object). No enum knowledge.
- **Route validator (`validatePlanChange`, coach.ts):** applies the enum/range table above with the *real* `GOAL_METHODS`/`ACTIVITY_LEVELS` from the schema, returns a sanitized `PlanChange` or `null` (→ 400 at apply / `plan_change:null` at nutritionist).

---

## File Structure

- **Modify `core/src/shared/prompts.js`** — append the `<<PLAN_CHANGE>>` instruction paragraph to `NUTRITIONIST_SYSTEM`; add the pure `splitPlanChange(raw)`; export it. Tasks 1, 2. Goja-safe.
- **Modify `core/src/shared/prompts.d.ts`** — declare `PlanChangeRaw` + `PlanChangeSplit` + `splitPlanChange`. Task 2.
- **Modify `core/src/api/coach.ts`** — import `splitPlanChange` (via `../ai/index`) + `GOAL_METHODS`/`ACTIVITY_LEVELS` (from `../schema`); add the local `validatePlanChange` + `planSummaryText` helpers; make `/api/nutritionist` return `{ reply: visibleText, plan_change }`; add the `POST /api/plan/apply` route. Tasks 3, 4.
- **Create `core/test/coach-planedit.test.ts`** — harness TDD for `/api/nutritionist` plan_change extraction (captured-fetch stub) + `/api/plan/apply` (deterministic; seed a profile, assert engine recompute + persistence + validation). Tasks 3, 4.
- **Modify `core/test/prompts-*` (new `core/test/planchange-parse.test.ts`)** — pure node:test TDD for `splitPlanChange` (no/one/multiple/malformed/partial/mid-text trailers, whitespace, non-object JSON). Task 2. Plus a system-prompt assertion (the trailer instruction is present). Task 1.
- **Modify `core/src/web/views/coach.js`** — render the inline Apply/Dismiss card when a reply carries `plan_change`; Apply → `POST /api/plan/apply` → `refreshMe()` + toast; Dismiss → remove. Task 5.
- **Modify `core/src/web/style.css`** — inline-confirm card styles. Task 5.

**Verification approach (read before Task 1) — the pure / backend-harness / DOM split:**

- **Pure (full TDD, `node:test`):** `splitPlanChange` carries the highest-value, riskiest logic (text parsing of untrusted model output) and is tested exhaustively with no network — no-trailer, one trailer, **multiple** trailers (first wins, everything after stripped), **malformed** JSON (→ `planChange:null` but marker still stripped from `visibleText`), partial/truncated JSON, trailer **not** at the very end (trailing prose after it is dropped from visible text), leading/trailing whitespace, a non-object JSON value (array/number → null), and the "user never sees raw JSON" guarantee. The `NUTRITIONIST_SYSTEM` trailer instruction is asserted present here too.
- **Backend-harness (TDD via `client()`):**
  - `/api/nutritionist` plan_change extraction is harness-testable via a **captured-fetch stub** (stub `platform.secrets.get` for a key + `globalThis.fetch` to return a canned Gemini reply **containing a trailer**): assert `res.reply` has the trailer stripped and **contains no `<<PLAN_CHANGE>>` and no raw JSON**, and `res.plan_change` deep-equals the sanitized change; a **malformed** trailer → `plan_change:null` with a clean `reply`. (This mirrors Phase 5's captured-fetch recipe-route harness.)
  - `/api/plan/apply` is **fully deterministic** — no model call, so it needs **no fetch stub at all**: seed a profile with real stats, POST a change, and assert the engine re-ran (persisted `goal_kcal`/macros equal `macroTargets(...)` for the final kcal — **not** the AI's proposed numbers), the profile goal fields + `plan_summary` persisted, a `weight_goals` row was created for a proposed `weight_goal`, and validation rejects garbage (unknown `method` dropped; empty change → 400).
- **DOM (complete code + explicit LIVE steps):** the inline Apply/Dismiss card in `coach.js` — there is no jsdom/browser harness in this repo (Phase 3/5 precedent). The card is thin over the tested route shapes, so a browser is only needed to confirm the card renders, Apply updates the rings/plan card via `refreshMe()`, and the raw JSON never appears in the bubble — which the live steps cover.

---

### Task 0: Guard — confirm the Phase 1/4/5 substrate is present

Phase 6 builds on already-deployed pieces. Confirm they exist before starting; each check is a one-liner. If any is missing, STOP — a prior phase regressed and must be restored first (Phase 6 does not re-own them).

**Files:** none (verification only).

- [ ] **Step 1: Confirm the substrate**

Run:
```bash
cd ~/gitrepos/sate
grep -n "NUTRITIONIST_SYSTEM" core/src/shared/prompts.js | head -1              # coach system prompt
grep -n "computePlan\|macroTargets\|goalCalories" core/src/shared/nutrition.js  # deterministic engine
grep -n "buildPlanInput\|currentWeightKg\|/api/plan/compute" core/src/api/coach.ts # reusable helpers + compute route
grep -n "plan_summary\|allergies" core/src/api/profile.ts                        # PATCH /api/goals persistence
grep -n "/api/weight/goals" core/src/api/weight.ts                               # weight-goals path
grep -n "GOAL_METHODS\|ACTIVITY_LEVELS" core/src/schema/index.ts                 # enums for validation
```
Expected: every grep returns at least one hit. `buildPlanInput` + `currentWeightKg` are module-private in `coach.ts` (Phase 6 calls them in the same file). If all present, proceed to Task 1.

- [ ] **Step 2: Baseline green**

Run: `cd ~/gitrepos/sate/core && npm test` then `cd ~/gitrepos/sate-cloud && npx tsc --noEmit`
Expected: all Phase 1–5 tests green; typecheck exit 0. This is the baseline Phase 6 must preserve.

---

### Task 1: Extend `NUTRITIONIST_SYSTEM` with the `<<PLAN_CHANGE>>` trailer instruction

Teach the coach to append the machine-readable trailer **only when the user asks to change targets/goals**, and to keep the visible message a normal, warm explanation (the trailer is stripped server-side). Prompt text only — no parsing yet.

**Files:**
- Modify: `core/src/shared/prompts.js` (`NUTRITIONIST_SYSTEM` — one appended paragraph)
- Create: `core/test/planchange-parse.test.ts` (one system-prompt assertion now; the parser tests join in Task 2)

**Interfaces:**
- Produces: `PROMPTS.nutritionist.system` now instructs the model to emit `<<PLAN_CHANGE>>{...}` with the contract's fields when (and only when) the user requests a plan/target/goal change. Consumed by Task 3 (the route strips it) + the live coach.

- [ ] **Step 1: Write the failing test `core/test/planchange-parse.test.ts`**

```typescript
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
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd ~/gitrepos/sate/core && npm test`
Expected: FAIL — `NUTRITIONIST_SYSTEM` has no `<<PLAN_CHANGE>>` language yet.

- [ ] **Step 3: Append the trailer instruction to `NUTRITIONIST_SYSTEM` in `core/src/shared/prompts.js`** (goja-safe; concatenate into the existing `+`-joined literal, right before the closing "You are not a doctor…" sentence)

```javascript
  "PLAN CHANGES: only when the user explicitly asks to change their plan, targets, or goals (e.g. " +
  "\"bump me to 1,800 kcal\", \"more protein\", \"push my goal to October\"), APPEND — as the very " +
  "LAST thing in your reply, on its own line, after your normal warm explanation — a single " +
  "machine-readable trailer for the app to apply:\n" +
  "<<PLAN_CHANGE>>{\"goal_kcal\":number,\"method\":string,\"activity_level\":string," +
  "\"weight_goal\":{\"target_lb\":number,\"target_date\":\"YYYY-MM-DD\"}}\n" +
  "Include ONLY the field(s) the user is changing (all are optional; omit the rest). `method` is one " +
  "of calories|carb|protein|fat|balanced|heart; `activity_level` is one of " +
  "sedentary|light|moderate|active|athlete. Emit the trailer as strict minified JSON with no code " +
  "fences and no text after it. Do NOT mention the trailer or show its JSON in your prose — the app " +
  "strips it and asks the user to confirm; the deterministic engine recomputes the exact numbers, so " +
  "keep your spoken numbers approximate. If the user is NOT changing their plan, do not emit a trailer " +
  "at all. " +
```

(Concatenate this fragment into the single big `NUTRITIONIST_SYSTEM` string literal — it is one `+`-joined expression.)

- [ ] **Step 4: Run the test + typecheck**

Run: `cd ~/gitrepos/sate/core && npm test` then `cd ~/gitrepos/sate-cloud && npx tsc --noEmit`
Expected: PASS — the system-prompt assertion green; all prior tests green; typecheck exit 0.

- [ ] **Step 5: Commit**

```bash
cd ~/gitrepos/sate
git add core/src/shared/prompts.js core/test/planchange-parse.test.ts
git commit -m "feat(core): teach the nutritionist to emit a <<PLAN_CHANGE>> trailer on plan-change requests"
```

---

### Task 2: Pure trailer parser `splitPlanChange(raw)` (the risky parsing — heavy TDD)

The highest-value pure piece: split the model's raw reply into `{ visibleText, planChange }`, stripping the `<<PLAN_CHANGE>>` marker **and everything after it** from `visibleText` (so no JSON — malformed or not — ever reaches the UI), and returning the parsed raw object (or `null`). No enum knowledge here; the route validates fields (Task 3/4).

**Files:**
- Modify: `core/src/shared/prompts.js`
- Modify: `core/src/shared/prompts.d.ts`
- Modify: `core/test/planchange-parse.test.ts` (append the parser tests)

**Interfaces:**
- Produces (goja-safe): `splitPlanChange(raw): { visibleText: string, planChange: object | null }`. Consumed by Task 3.

- [ ] **Step 1: Append the failing tests to `core/test/planchange-parse.test.ts`**

```typescript
import { splitPlanChange } from "../src/ai/prompts.ts";

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

test("tolerates null/empty/whitespace input", () => {
  assert.deepEqual(splitPlanChange(null as any), { visibleText: "", planChange: null });
  assert.deepEqual(splitPlanChange(""), { visibleText: "", planChange: null });
  assert.deepEqual(splitPlanChange("   "), { visibleText: "", planChange: null });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd ~/gitrepos/sate/core && npm test`
Expected: FAIL — `splitPlanChange` is not exported.

- [ ] **Step 3: Add `splitPlanChange` to `core/src/shared/prompts.js`** (goja-safe ES2015; place after the recipe helpers, before `const PROMPTS = {`)

```javascript
// ---- coach plan-edit trailer (spec §10) --------------------------------
// The nutritionist appends a machine-readable trailer proposing a plan change, e.g.:
//   <<PLAN_CHANGE>>{"goal_kcal":1800,"method":"protein","weight_goal":{"target_lb":180,"target_date":"2026-10-01"}}
// splitPlanChange strips the marker AND everything after it from visibleText (so no JSON — malformed
// or not — ever reaches the UI) and returns the RAW parsed object (or null). It does NOT validate the
// fields; the route validates them against the real GOAL_METHODS/ACTIVITY_LEVELS enums. First marker
// wins. Pure + defensive.
var PLAN_CHANGE_MARKER = "<<PLAN_CHANGE>>";

function splitPlanChange(raw) {
  var text = raw == null ? "" : String(raw);
  var idx = text.indexOf(PLAN_CHANGE_MARKER);
  if (idx === -1) return { visibleText: text.trim(), planChange: null };
  var visible = text.slice(0, idx).replace(/\s+$/, "");
  var after = text.slice(idx + PLAN_CHANGE_MARKER.length);
  // If the model emitted a SECOND marker, only the first one's JSON counts — truncate before the next
  // marker so lastIndexOf("}") can't span into a later object and corrupt the parse (first wins).
  var next = after.indexOf(PLAN_CHANGE_MARKER);
  if (next !== -1) after = after.slice(0, next);
  var planChange = null;
  var start = after.indexOf("{");
  var end = after.lastIndexOf("}");
  if (start !== -1 && end > start) {
    try {
      var parsed = JSON.parse(after.slice(start, end + 1));
      if (parsed && typeof parsed === "object" && !(parsed instanceof Array)) planChange = parsed;
    } catch (e) {
      planChange = null;
    }
  }
  return { visibleText: visible, planChange: planChange };
}
```

Add `splitPlanChange` to `module.exports`:
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
  splitPlanChange,
};
```

- [ ] **Step 4: Declare the types in `core/src/shared/prompts.d.ts`**

```typescript
// The raw, UNVALIDATED plan-change object parsed from the model's <<PLAN_CHANGE>> trailer. The route
// (validatePlanChange) enforces the GOAL_METHODS/ACTIVITY_LEVELS enums + ranges before anything is used.
export interface PlanChangeRaw {
  goal_kcal?: unknown;
  method?: unknown;
  activity_level?: unknown;
  weight_goal?: { target_lb?: unknown; target_date?: unknown };
}
export interface PlanChangeSplit {
  visibleText: string;
  planChange: PlanChangeRaw | null;
}
// Split a raw model reply into the user-visible text (trailer stripped) + the parsed proposal (or null).
export declare function splitPlanChange(raw: string | null | undefined): PlanChangeSplit;
```

- [ ] **Step 5: Run the tests + typecheck**

Run: `cd ~/gitrepos/sate/core && npm test` then `cd ~/gitrepos/sate-cloud && npx tsc --noEmit`
Expected: PASS — all `splitPlanChange` tests green; typecheck exit 0.

- [ ] **Step 6: Commit**

```bash
cd ~/gitrepos/sate
git add core/src/shared/prompts.js core/src/shared/prompts.d.ts core/test/planchange-parse.test.ts
git commit -m "feat(core): pure splitPlanChange trailer parser (strips trailer, defensive JSON parse)"
```

---

### Task 3: `/api/nutritionist` returns `plan_change` (visible reply stripped)

Run `splitPlanChange` on the model reply, **validate** the parsed proposal server-side (so the client only ever receives a sane, enum-checked change), and return `{ reply: visibleText, plan_change }`. Add the local `validatePlanChange` helper (reused by Task 4's apply route).

**Files:**
- Modify: `core/src/api/coach.ts`
- Create: `core/test/coach-planedit.test.ts` (the `/api/nutritionist` extraction cases)

**Interfaces:**
- Consumes: `splitPlanChange` (Task 2), `GOAL_METHODS`/`ACTIVITY_LEVELS` (schema).
- Produces: `/api/nutritionist` response gains `plan_change: PlanChange | null`; `reply` is now the trailer-stripped `visibleText`. `validatePlanChange(raw): PlanChange | null` (module-local, also used by Task 4).

- [ ] **Step 1: Write the failing harness test `core/test/coach-planedit.test.ts`**

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { client, TEST_EMAIL } from "./mem.ts";

// Give callAI a key + stub fetch so the "model" returns a canned reply (optionally with a trailer).
function stubGemini(platform: any, replyText: string) {
  platform.secrets.get = async () => "test-key";
  (globalThis as any).fetch = async () =>
    new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ text: replyText }] } }],
      usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 7 },
    }), { status: 200, headers: { "content-type": "application/json" } });
}

test("POST /api/nutritionist strips the trailer from reply and returns a validated plan_change", async () => {
  const orig = (globalThis as any).fetch;
  try {
    const { req, platform } = client();
    stubGemini(platform,
      "Sure — I'll move you to 1,800 kcal with more protein.\n" +
      '<<PLAN_CHANGE>>{"goal_kcal":1800,"method":"protein"}');
    const res = await req("/api/nutritionist", { method: "POST", body: JSON.stringify({ mode: "chat", message: "bump me to 1800 with more protein" }) });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.reply, "Sure — I'll move you to 1,800 kcal with more protein.");
    assert.doesNotMatch(body.reply, /<<PLAN_CHANGE>>/);
    assert.doesNotMatch(body.reply, /goal_kcal/); // no raw JSON leaks to the client
    assert.deepEqual(body.plan_change, { goal_kcal: 1800, method: "protein" });
  } finally { (globalThis as any).fetch = orig; }
});

test("POST /api/nutritionist drops invalid fields; an all-invalid trailer → plan_change null", async () => {
  const orig = (globalThis as any).fetch;
  try {
    const { req, platform } = client();
    stubGemini(platform, 'Ok.\n<<PLAN_CHANGE>>{"method":"bogus","activity_level":"lazy"}');
    const res = await req("/api/nutritionist", { method: "POST", body: JSON.stringify({ mode: "chat", message: "x" }) });
    const body = await res.json();
    assert.equal(body.reply, "Ok.");
    assert.equal(body.plan_change, null); // nothing valid remained
  } finally { (globalThis as any).fetch = orig; }
});

test("POST /api/nutritionist with no trailer returns plan_change null and a clean reply", async () => {
  const orig = (globalThis as any).fetch;
  try {
    const { req, platform } = client();
    stubGemini(platform, "Here is some general advice.");
    const res = await req("/api/nutritionist", { method: "POST", body: JSON.stringify({ mode: "chat", message: "hi" }) });
    const body = await res.json();
    assert.equal(body.reply, "Here is some general advice.");
    assert.equal(body.plan_change, null);
  } finally { (globalThis as any).fetch = orig; }
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd ~/gitrepos/sate/core && npm test`
Expected: FAIL — the response has no `plan_change`, and (for the trailer case) `reply` still contains the raw trailer.

- [ ] **Step 3: Wire the route in `core/src/api/coach.ts`**

Add `splitPlanChange` to the existing `from "../ai/index"` import list:
```typescript
  allergiesLine,
  splitPlanChange,
```
Add value imports of the enums (extend the existing `from "../schema"` import — currently type-only; add a separate value import so the enums are available at runtime):
```typescript
import { GOAL_METHODS, ACTIVITY_LEVELS } from "../schema";
```

Add the module-local validator + a small `PlanChange` interface near the other helpers (after `num`):
```typescript
// The sanitized, enum-checked plan change the client + apply route act on. Built from the RAW parsed
// trailer (splitPlanChange) using the real schema enums. Returns null if nothing valid remains.
export interface PlanChange {
  goal_kcal?: number;
  method?: GoalMethod;
  activity_level?: ActivityLevel;
  weight_goal?: { target_lb: number; target_date: string };
}
export function validatePlanChange(raw: unknown): PlanChange | null {
  if (!raw || typeof raw !== "object") return null;
  const b = raw as Record<string, any>;
  const out: PlanChange = {};
  let has = false;
  if (num(b.goal_kcal) > 0) { out.goal_kcal = Math.round(num(b.goal_kcal)); has = true; }
  if (b.method != null && (GOAL_METHODS as readonly string[]).includes(String(b.method))) {
    out.method = String(b.method) as GoalMethod; has = true;
  }
  if (b.activity_level != null && (ACTIVITY_LEVELS as readonly string[]).includes(String(b.activity_level))) {
    out.activity_level = String(b.activity_level) as ActivityLevel; has = true;
  }
  const wg = b.weight_goal;
  if (wg && typeof wg === "object" && num(wg.target_lb) > 0 && /^\d{4}-\d{2}-\d{2}$/.test(String(wg.target_date || ""))) {
    out.weight_goal = { target_lb: num(wg.target_lb), target_date: String(wg.target_date) }; has = true;
  }
  return has ? out : null;
}
```

In `POST /api/nutritionist`, after `reply` is computed, split + validate + return it:
```typescript
    // Split off the machine-readable <<PLAN_CHANGE>> trailer (spec §10): the user only ever sees the
    // stripped visibleText; the proposal is validated (enum/range) before it reaches the client.
    const { visibleText, planChange } = splitPlanChange(reply);
    const proposed = validatePlanChange(planChange);
```
and change the `ok(c, { reply, … })` to:
```typescript
    return ok(c, {
      reply: visibleText,
      plan_change: proposed,
      role,
      provider,
      model,
      plan: { bmr: plan.bmr, tdee: plan.tdee, targets: plan.targets, warnings: plan.warnings },
    });
```

- [ ] **Step 4: Run the tests + typecheck**

Run: `cd ~/gitrepos/sate/core && npm test` then `cd ~/gitrepos/sate-cloud && npx tsc --noEmit`
Expected: PASS — the three `/api/nutritionist` plan_change tests green; all prior tests green; typecheck exit 0.

- [ ] **Step 5: Commit**

```bash
cd ~/gitrepos/sate
git add core/src/api/coach.ts core/test/coach-planedit.test.ts
git commit -m "feat(core): /api/nutritionist strips <<PLAN_CHANGE>> trailer + returns validated plan_change"
```

---

### Task 4: `POST /api/plan/apply` — the authority step (deterministic recompute + persist)

The Apply endpoint. **Deterministic — NOT `requireAI`.** Validate the change, apply it as overrides to the profile's current values, **re-run `computePlan` + `macroTargets`** (the AI's proposed numbers are discarded — the engine computes the real ones), persist the goals through the same `Profile` goal fields `PATCH /api/goals` writes + a proposed weight goal through the same `weight_goals` path `POST /api/weight/goals` writes + a refreshed `plan_summary`, and return the updated plan.

**Files:**
- Modify: `core/src/api/coach.ts` (add the route + a `planSummaryText` helper)
- Modify: `core/test/coach-planedit.test.ts` (append the apply cases)

**Interfaces:**
- Consumes: `validatePlanChange` (Task 3), `buildPlanInput`/`currentWeightKg` (module-private, this file), `nutrition.computePlan`/`nutrition.macroTargets`, `lbToKg`, `WeightGoal`/`Profile` types.
- Produces: `POST /api/plan/apply` body `{ goal_kcal?, method?, activity_level?, weight_goal? }` → `{ applied, plan:{bmr,tdee,targets,warnings}, goals, plan_summary }`.

- [ ] **Step 1: Append the failing harness tests to `core/test/coach-planedit.test.ts`**

```typescript
// Seed a profile with real stats so computePlan produces meaningful numbers (no AI needed here).
async function seedProfile(platform: any, extra: Record<string, unknown> = {}) {
  const store = platform.data.forUser(TEST_EMAIL);
  await store.create("profiles", {
    user: TEST_EMAIL, email: TEST_EMAIL,
    body_weight_kg: 90, height_cm: 180, age: 40, sex: "male",
    activity_level: "sedentary", method: "calories",
    ...extra,
  }, TEST_EMAIL);
}

test("POST /api/plan/apply re-runs the engine for an explicit goal_kcal (macros derived, NOT echoed)", async () => {
  const { req, platform } = client();
  await seedProfile(platform);
  const res = await req("/api/plan/apply", { method: "POST", body: JSON.stringify({ goal_kcal: 1800, method: "protein" }) });
  assert.equal(res.status, 200);
  const body = await res.json();
  // The engine honored the explicit kcal…
  assert.equal(body.goals.kcal, 1800);
  assert.equal(body.plan.targets.kcal, 1800);
  // …and DERIVED the macros deterministically via macroTargets(1800,"protein",90) — protein-forward,
  // and self-consistent (a positive protein target, not the AI's arithmetic).
  assert.ok(body.goals.protein > 0);
  assert.ok(body.plan_summary && /1,?800/.test(body.plan_summary));
  // Persisted: GET /api/me reflects the new goals + method + plan_summary.
  const me = await (await req("/api/me?tz=0")).json();
  assert.equal(me.goals.kcal, 1800);
  assert.equal(me.track_mode, "protein");
  assert.equal(me.plan_summary, body.plan_summary);
});

test("POST /api/plan/apply with a weight_goal recomputes the deficit AND persists the goal", async () => {
  const { req, platform } = client();
  await seedProfile(platform);
  const res = await req("/api/plan/apply", {
    method: "POST",
    body: JSON.stringify({ weight_goal: { target_lb: 180, target_date: "2027-01-01" } }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(body.goals.kcal > 0);
  // The weight goal landed in the same collection POST /api/weight/goals writes.
  const wg = await (await req("/api/weight/goals")).json();
  assert.equal(wg.goals.length, 1);
  assert.equal(Math.round(wg.goals[0].target_lb), 180);
});

test("POST /api/plan/apply changes activity_level and re-derives calories", async () => {
  const { req, platform } = client();
  await seedProfile(platform);
  const before = (await (await req("/api/plan/apply", { method: "POST", body: JSON.stringify({ activity_level: "sedentary" }) })).json()).goals.kcal;
  const after = (await (await req("/api/plan/apply", { method: "POST", body: JSON.stringify({ activity_level: "athlete" }) })).json()).goals.kcal;
  assert.ok(after > before, "a higher activity level raises maintenance calories");
  const me = await (await req("/api/me?tz=0")).json();
  assert.equal(me.activity_level, "athlete");
});

test("POST /api/plan/apply 400s an empty/all-invalid change", async () => {
  const { req, platform } = client();
  await seedProfile(platform);
  assert.equal((await req("/api/plan/apply", { method: "POST", body: JSON.stringify({}) })).status, 400);
  assert.equal((await req("/api/plan/apply", { method: "POST", body: JSON.stringify({ method: "bogus" }) })).status, 400);
});

test("POST /api/plan/apply clamps a dangerous goal_kcal to the safety floor", async () => {
  const { req, platform } = client();
  await seedProfile(platform); // male → floor 1500
  const body = await (await req("/api/plan/apply", { method: "POST", body: JSON.stringify({ goal_kcal: 200 }) })).json();
  assert.equal(body.goals.kcal, 1500);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd ~/gitrepos/sate/core && npm test`
Expected: FAIL — `/api/plan/apply` 404 (route not registered).

- [ ] **Step 3: Add the `planSummaryText` helper + the route to `core/src/api/coach.ts`**

Add the deterministic summary builder near the other helpers (it never calls AI — the narrative is built from the recomputed plan, so it stays self-consistent):
```typescript
// A short, deterministic plan narrative built from the RECOMPUTED plan (not the AI's prose) — persisted
// as profiles.plan_summary so the Plan tab's "Show full plan" reflects the change. Self-consistent by
// construction (same engine numbers the goals were saved from).
function planSummaryText(inp: nutrition.PlanInput, targets: nutrition.MacroTargets, warnings: string[]): string {
  const L: string[] = [];
  L.push(
    `Your plan: ${targets.kcal.toLocaleString()} kcal/day · ${targets.protein}g protein · ` +
    `${targets.carbs}g carbs · ${targets.fat}g fat (${inp.method}).`,
  );
  if (inp.goals && inp.goals.length) {
    const g = inp.goals[0]!;
    L.push(`Goal: reach ${Math.round(g.target_kg * LB_PER_KG)} lb by ${g.target_date}.`);
  } else {
    L.push("Maintenance (no weight goal set).");
  }
  if (warnings && warnings.length) L.push(warnings[0]!);
  return L.join(" ");
}
```
(If `nutrition.MacroTargets` is not an exported type, use the return type of `nutrition.macroTargets` or `ReturnType<typeof nutrition.macroTargets>`; confirm against `core/src/shared/nutrition.d.ts` and use whichever name it declares.)

Add the route inside `registerCoach` (after `/api/plan/compute`, so it sits with the other `/api/plan/*` compute-side routes). NOTE the deliberate absence of `requireAI`:
```typescript
  // POST /api/plan/apply — apply a coach-proposed <<PLAN_CHANGE>> AFTER the user tapped Apply (spec §10).
  // DETERMINISTIC (no AI, no requireAI): validate the change, apply it as overrides, RE-RUN computePlan +
  // macroTargets so the numbers are the engine's (never the AI's arithmetic), then persist goals through
  // the same Profile fields PATCH /api/goals writes + any weight goal through the same weight_goals path
  // POST /api/weight/goals writes + a refreshed plan_summary. This is the AUTHORITY step.
  app.post("/api/plan/apply", async (c) => {
    const uid = getUid(c);
    const email = getEmail(c);
    const profile = await ensureProfile(platform, uid, email);
    const store = platform.data.forUser(uid);

    const change = validatePlanChange(await readBody(c));
    if (!change) return err(c, "no valid plan change to apply", 400);

    // Apply the change as overrides on the profile's current values.
    const ov: PlanOverrides = {};
    if (change.method) ov.method = change.method;
    if (change.activity_level) ov.activity = change.activity_level;
    // A proposed weight goal drives the calorie delta; otherwise the user's existing goals do.
    if (change.weight_goal) {
      ov.goals = [{ target_kg: lbToKg(change.weight_goal.target_lb), target_date: change.weight_goal.target_date }];
    }

    const inp = await buildPlanInput(store, profile, todayStr(), ov);
    const plan = nutrition.computePlan(inp);

    // Authority: the engine's kcal — unless the user asked for an explicit target, clamped to the safe
    // floor (male 1500 / female 1300) and a sane ceiling. Macros are ALWAYS re-derived for the final kcal.
    const floor = (inp.sex || "").toLowerCase() === "female" ? 1300 : 1500;
    const goalKcal = change.goal_kcal
      ? Math.max(floor, Math.min(6000, Math.round(change.goal_kcal)))
      : plan.targets.kcal;
    const targets = nutrition.macroTargets(goalKcal, inp.method, inp.curKg);
    const summary = planSummaryText(inp, targets, plan.warnings);

    // Persist goals — exactly the Profile fields PATCH /api/goals writes.
    const patch: Partial<Profile> = {
      goal_kcal: targets.kcal,
      goal_protein: targets.protein,
      goal_carbs: targets.carbs,
      goal_fat: targets.fat,
      goal_sodium: targets.sodium,
      method: inp.method as GoalMethod,
      plan_summary: summary,
    };
    if (change.activity_level) patch.activity_level = change.activity_level;
    const pid = (profile as Profile & { id?: string }).id;
    try {
      if (pid) await store.update<Profile>("profiles", pid, patch);
    } catch (e) {
      return err(c, String((e as Error)?.message || e), 502);
    }

    // Persist a proposed weight goal via the same weight_goals path (cap 3, lb→kg) as /api/weight/goals.
    if (change.weight_goal) {
      try {
        const { items } = await store.list<WeightGoal>("weight_goals", { limit: 10 });
        if (items.length < 3) {
          await store.create<WeightGoal>("weight_goals", {
            user: uid,
            target_kg: lbToKg(change.weight_goal.target_lb),
            target_date: change.weight_goal.target_date,
            start_kg: inp.curKg,
            start_date: todayStr(),
          } as Omit<WeightGoal, "id">);
        }
      } catch {
        /* non-fatal — the goals/targets already persisted */
      }
    }

    return ok(c, {
      applied: change,
      plan: { bmr: plan.bmr, tdee: plan.tdee, targets, warnings: plan.warnings },
      goals: { kcal: targets.kcal, protein: targets.protein, carbs: targets.carbs, fat: targets.fat, sodium: targets.sodium },
      plan_summary: summary,
    });
  });
```

(`PlanOverrides`, `buildPlanInput`, `currentWeightKg`, `lbToKg`, `todayStr`, `LB_PER_KG`, `readBody`, `WeightGoal` are all already defined/imported in `coach.ts`. Confirm `nutrition.macroTargets` is exported from `core/src/shared/nutrition.js` — it is — and typed in `nutrition.d.ts`.)

- [ ] **Step 4: Run the tests + typecheck**

Run: `cd ~/gitrepos/sate/core && npm test` then `cd ~/gitrepos/sate-cloud && npx tsc --noEmit`
Expected: PASS — all five `/api/plan/apply` tests green (recompute-for-explicit-kcal, weight-goal recompute + persist, activity change, empty/invalid 400, floor clamp); all prior tests green; typecheck exit 0.

- [ ] **Step 5: Commit**

```bash
cd ~/gitrepos/sate
git add core/src/api/coach.ts core/test/coach-planedit.test.ts
git commit -m "feat(core): POST /api/plan/apply — deterministic recompute + persist (the authority step)"
```

---

### Task 5: Client inline Apply / Dismiss card in `coach.js`

When a coach reply carries `plan_change`, render an inline confirmation card under the reply summarizing the proposal — **Apply** posts to `/api/plan/apply`, then `refreshMe()` + toast (Plan card + Home rings pick up the new goals on the next `me()` read/show); **Dismiss** removes the card and changes nothing. No silent rewrite. DOM → complete code + LIVE steps.

**Files:**
- Modify: `core/src/web/views/coach.js`
- Modify: `core/src/web/style.css`

**Interfaces:**
- Consumes: the `/api/nutritionist` response's `plan_change`; `lib.js` (`el`, `api`, `toast`, `refreshMe`, `fmt`); `/api/plan/apply`.
- Produces: an inline card appended to the coach log after a plan-change reply; Apply mutates via the route + `refreshMe()`; Dismiss is inert.

- [ ] **Step 1: Extend the imports in `core/src/web/views/coach.js`**

Add `refreshMe` and `fmt` to the existing `from "../lib.js"` import:
```javascript
import {
  $, $$, el, api, me, registerView, onViewChange, toast, isNative, refreshMe, fmt,
} from "../lib.js";
```

- [ ] **Step 2: Render the card when a reply carries `plan_change`**

In `coachSend`, right after the reply is set (`thinking.textContent = r.reply || "(no reply)";`) and inside the `if (!isPlan)` success path, add:
```javascript
    if (!isPlan && r.plan_change) renderPlanChange(r.plan_change);
```
(Place it just before `secondOpinionBtn(reqBody);` so the confirm card sits under the coach's explanation.)

- [ ] **Step 3: Add the inline-confirm card to `core/src/web/views/coach.js`**

Append (all fields are validated/structured server-side and rendered as text nodes → esc-safe):
```javascript
// ============================================================ inline plan-change confirm (spec §10)
// A coach reply may carry a validated plan_change proposal. Show an Apply/Dismiss card — NEVER a silent
// rewrite. Apply → POST /api/plan/apply (deterministic recompute + persist) → refreshMe() so the Plan
// card + Home rings reflect the new goals. Dismiss changes nothing.
const METHOD_LABEL = { calories: "Calories", carb: "Carb-focused", protein: "High-protein", fat: "Low-fat", balanced: "Balanced", heart: "Heart-healthy" };
const ACTIVITY_LABEL = { sedentary: "Sedentary", light: "Light", moderate: "Moderate", active: "Active", athlete: "Athlete" };

function planChangeSummary(ch) {
  const parts = [];
  if (ch.goal_kcal) parts.push(fmt(ch.goal_kcal) + " kcal");
  if (ch.method) parts.push(METHOD_LABEL[ch.method] || ch.method);
  if (ch.activity_level) parts.push(ACTIVITY_LABEL[ch.activity_level] || ch.activity_level);
  if (ch.weight_goal) parts.push(Math.round(ch.weight_goal.target_lb) + " lb by " + ch.weight_goal.target_date);
  return parts.join(" · ");
}

function renderPlanChange(change) {
  if (!logEl || !change) return;
  const card = el("div", { class: "planchange" });
  const label = el("div", { class: "pc-label" },
    el("strong", { text: "Update your plan: " }),
    el("span", { text: planChangeSummary(change) }));

  const apply = el("button", { class: "primary small", type: "button", text: "Apply" });
  const dismiss = el("button", { class: "link", type: "button", text: "Dismiss" });
  const actions = el("div", { class: "pc-actions" }, apply, dismiss);

  apply.addEventListener("click", async () => {
    apply.disabled = true; dismiss.disabled = true;
    try {
      await api("/api/plan/apply", { method: "POST", json: change });
      await refreshMe(); // Plan card + Home rings read the new goals on their next render.
      card.innerHTML = "";
      card.classList.add("done");
      card.appendChild(el("div", { class: "pc-done", text: "✓ Plan updated — " + planChangeSummary(change) }));
      toast("Plan updated");
    } catch (e) {
      apply.disabled = false; dismiss.disabled = false;
      toast((e && e.message) || "Could not update your plan");
    }
    scrollLog();
  });
  dismiss.addEventListener("click", () => { card.remove(); });

  card.append(label, actions);
  logEl.appendChild(card);
  scrollLog();
}
```

- [ ] **Step 4: Add the card styles to `core/src/web/style.css`**

```css
/* ---- Coach: inline plan-change confirm (spec §10) ---- */
.planchange { align-self: flex-start; max-width: 88%; margin: 2px 0 8px; padding: 10px 12px; border: 1px solid color-mix(in srgb, var(--brand) 40%, var(--line)); border-radius: 14px; background: color-mix(in srgb, var(--brand) 8%, transparent); }
.planchange .pc-label { font-size: 14px; line-height: 1.35; }
.planchange .pc-actions { display: flex; gap: 10px; align-items: center; margin-top: 8px; }
.planchange.done { border-color: var(--line); background: transparent; }
.planchange .pc-done { font-size: 13.5px; color: var(--muted); }
```

- [ ] **Step 5: LIVE verification on sate.health** (`god` account; run after the sate-cloud deploy — Task 6)

1. **Proposal appears:** open **Coach**, send "bump me to 1,800 kcal and more protein". The coach's spoken reply reads normally and contains **no `<<PLAN_CHANGE>>` and no JSON**; an inline **"Update your plan: 1,800 kcal · High-protein — Apply / Dismiss"** card sits under it.
2. **Non-change chat = no card:** ask "what's a good high-protein snack?" → a normal reply, **no** card (the model only emits the trailer on a change request).
3. **Apply is authoritative:** tap **Apply** → toast "Plan updated"; the card collapses to "✓ Plan updated…". Open the **Plan** tab → "Your Plan" card shows 1,800 kcal + protein-forward macros (the ENGINE's macros, self-consistent — not whatever the AI said); Home rings count down against the new goal. Confirm via `GET /api/me` that `goals.kcal===1800`, `track_mode==="protein"`, and `plan_summary` refreshed.
4. **Weight goal:** send "push my goal to 180 lb by next October" → Apply → the Plan card's weight-goal line updates and `GET /api/weight/goals` shows the new goal; the calorie target recomputed for the new deadline.
5. **Dismiss:** send another change, tap **Dismiss** → the card disappears, `GET /api/me` unchanged (no silent rewrite).
6. **Safety clamp:** send "drop me to 500 kcal" → Apply → the saved `goal_kcal` is clamped to the floor (1,500 male / 1,300 female), not 500.
7. **No raw JSON ever:** across all of the above, the chat transcript never shows the trailer text.

- [ ] **Step 6: Commit**

```bash
cd ~/gitrepos/sate
git add core/src/web/views/coach.js core/src/web/style.css
git commit -m "feat(web): inline coach plan-change Apply/Dismiss card (no silent rewrite)"
```

---

### Task 6: Full-suite green + typecheck + build + sync to sate-cloud + live smoke

The final gate: the whole suite green, typecheck clean, the SPA builds (so the `coach.js` change lands in the fingerprinted bundle), `core/` synced into the sate-cloud subtree, and the coach-plan-edit scenario verified live. No new behavior.

**Files:** None new. Verification + build + subtree sync.

- [ ] **Step 1: Run the whole suite**

Run: `cd ~/gitrepos/sate/core && npm test`
Expected: PASS — `planchange-parse` (system prompt + `splitPlanChange`) + `coach-planedit` (`/api/nutritionist` extraction + `/api/plan/apply` recompute/persist/validate) + all Phase 1–5 tests green; `ℹ fail 0`.

- [ ] **Step 2: Typecheck**

Run: `cd ~/gitrepos/sate-cloud && npx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 3: Build the SPA (confirm `coach.js` bundles, no build error)**

Run (against a local copy or after the Step 5 sync): `cd ~/gitrepos/sate-cloud && node scripts/build-web.mjs`
Expected: completes; `web/app.<hash>.js` rewritten. `coach.js` is already in the graph; no `?vN` added.

- [ ] **Step 4: Confirm git state + the phase-6 commits**

Run: `cd ~/gitrepos/sate && git log --oneline -8 && git status --porcelain`
Expected: the Task 1–5 commits present; no uncommitted changes.

- [ ] **Step 5: Sync `core/` into sate-cloud (subtree)**

Per the `sate-core-unification` memory, sate-cloud vendors `core/` as a subtree and MUST stay byte-identical (`core/src/shared`, `core/src/api`, `core/src/web`). Use the repo's sync tool — **run it with `bash`, not `sh`** — and coordinate the exact sync/push step with the user (this plan's scope is core-side; the sate-cloud PR/deploy is a follow-up).

Run (verify byte-identical after sync): `diff -rq ~/gitrepos/sate/core/src ~/gitrepos/sate-cloud/core/src`
Expected: no differences once synced.

- [ ] **Step 6: Live smoke test on sate.health (after the sate-cloud deploy)**

As the `god` account on the deployed Cloud revision, run the Task 5 LIVE steps end-to-end (proposal appears with the trailer stripped; non-change chat shows no card; Apply is engine-authoritative + refreshes Home/Plan; weight goal persists; Dismiss is inert; the dangerous kcal is clamped; no raw JSON ever shows). Confirm `/api/plan/apply` makes **no** AI-usage entry (deterministic — check the admin usage counter does not increment on Apply). Clean up any test goals/weight goals and restore the account's plan if it was a throwaway change. Document the result. (Runs only after the sate-cloud deploy in the follow-up; noted here so Phase 6 isn't marked "done" until verified live.)

---

## Self-Review

**Spec coverage (Phase 6 scope = spec §13.6 = §10, Coach edits the plan by chat):**

| Spec (§10) | Requirement | Task |
|---|---|---|
| §10 | `nutritionist` prompt extended so a change request appends `<<PLAN_CHANGE>>{...json...}` | Task 1 |
| §10 | contract `{goal_kcal?, method?, activity_level?, weight_goal?:{target_lb, target_date}}` | Contract table + Task 1 (prompt) / Task 2 (parser) / Task 3 (validator) / Task 5 (UI) |
| §10 | server **strips** the trailer from the visible text | Task 2 (`splitPlanChange`) + Task 3 (route uses `visibleText`) |
| §10 | server returns it as `plan_change` in the `/api/nutritionist` response | Task 3 |
| §10 | client renders an **inline confirmation** (Apply / Dismiss), **never a silent rewrite** | Task 5 |
| §10 | on Apply → `POST /api/plan/apply` **validates** the change | Task 4 (`validatePlanChange`) |
| §10 | apply **re-runs the deterministic engine (`computePlan`)** so numbers stay self-consistent | Task 4 (`computePlan` + `macroTargets` re-derive; AI numbers discarded) |
| §10 | apply **persists** new targets (+ weight goal) and a refreshed `plan_summary`, returns the updated plan | Task 4 (Profile goal fields + `weight_goals` path + `plan_summary`) |
| §10 | Plan-tab card + Home rings reflect it via `refreshMe` | Task 5 (`refreshMe()` after Apply) |
| §10 | AI = proposer; deterministic engine + explicit confirm = authority | Global Constraints + Task 4 (no `requireAI`, engine recompute) + Task 5 (explicit Apply) |

**Explicitly OUT of scope (owned elsewhere):** the `Profile` goal fields + `plan_summary`/`allergies` persistence and `PATCH /api/goals` (Phase 4); `computePlan`/`analyzeGoal`/`goalCalories`/`macroTargets` (already deployed — Phase 6 only *calls* them); the `/api/weight/goals` path (Phase 1); the Plan-tab "Your Plan" card + `refreshMe` plumbing (Phase 4); the `nutritionist` route + `callAI` + allergies injection (Phases 1/5). Phase 6 adds the trailer instruction, the parser, the two route behaviors, and the inline card — nothing else.

**Key decision — `/api/plan/apply` lives in `coach.ts` (registerCoach), not `plan.ts` (registerPlan).** The `/api/plan/*` namespace is *already* split: `/api/plan/compute` is in `coach.ts` while `/api/plan/entry`/`/accept`/`/schedules` are in `plan.ts`. `apply` needs `coach.ts`'s module-private `buildPlanInput`/`currentWeightKg` + `nutrition.computePlan`/`macroTargets` — the exact machinery `/api/plan/compute` uses — so it belongs beside `compute`. Flagged for the reader (open question 1).

**Key decision — `plan_summary` is refreshed DETERMINISTICALLY (from the recomputed plan), not by an AI call and not from the coach's prose.** Building it from `macroTargets`+`computePlan` output keeps it self-consistent with the saved goals and fires **no** paid model (AI-spend guardrail). Alternative considered: persist the coach's visible reply as the narrative (would require the client to pass it in the apply body, and it'd be conversational/approximate). Chosen deterministic; flagged (open question 2).

**Key decision — the pure parser does NOT validate fields; the route does.** `splitPlanChange` handles only the risky text-extraction + `JSON.parse` (returns the raw object); enum/range validation (`validatePlanChange`) lives in `coach.ts` with the *real* `GOAL_METHODS`/`ACTIVITY_LEVELS` from the schema — so the enums are defined once (no goja-side duplication that could drift). Both the nutritionist route (so the client only receives sane proposals) and the apply route (defense-in-depth) validate.

**Verification split (decided + stated):** Maximum logic is pure and fully TDD'd — `splitPlanChange` (the untrusted-text parser: no/one/multiple/malformed/partial/mid-text/whitespace/non-object cases + the "no raw JSON leaks" guarantee) and the system-prompt assertion. The two route behaviors are backend-harness-TDD'd: `/api/nutritionist` extraction via a captured-fetch stub (canned reply *with* a trailer → assert `reply` stripped, contains no marker/JSON, `plan_change` validated); `/api/plan/apply` needs **no** stub at all because it is deterministic (seed a profile, assert the engine re-ran — persisted macros equal `macroTargets(...)` not the AI's numbers — plus persistence, weight-goal creation, validation 400s, and the floor clamp). Only end-to-end coach quality (the model actually emits a correct trailer on a real change request, and only then) is LIVE on sate.health, matching the coach routes' live-only precedent. The inline card DOM is thin over the tested route shapes, verified by explicit LIVE steps (no jsdom introduced).

**Placeholder scan:** No TBD/TODO-in-code/"similar to Task N". Every pure/backend step shows complete code + full assertions; every DOM step shows complete code; every run/live step gives the exact command or user action + expected result. The one type-name caveat (Task 4 Step 3, `nutrition.MacroTargets` vs `ReturnType<typeof nutrition.macroTargets>`) states both options + how to pick (check `nutrition.d.ts`) — not an unfinished placeholder.

**`plan_change` contract consistency (prompt → parser → route → UI):** the field set `{goal_kcal, method, activity_level, weight_goal:{target_lb, target_date}}` is identical in the contract table, the `NUTRITIONIST_SYSTEM` trailer instruction (Task 1), the `splitPlanChange`/`PlanChangeRaw` type (Task 2), `validatePlanChange`/`PlanChange` (Task 3), the `/api/plan/apply` override mapping (Task 4), and `planChangeSummary` (Task 5). `method` and `activity_level` are validated against the *same* `GOAL_METHODS`/`ACTIVITY_LEVELS` the schema + Goals dialog + `PATCH /api/goals` use. The persisted goal fields (`goal_kcal`/`goal_protein`/`goal_carbs`/`goal_fat`/`goal_sodium`/`method`/`activity_level`) match `profileView`/`goalsOf` exactly, so `GET /api/me` + the Plan card render them with no new mapping. The weight goal is created with the same `{user, target_kg, target_date, start_kg, start_date}` shape `POST /api/weight/goals` uses. `shared/prompts.js` additions stay goja-safe ES2015 (`var`/`function`, string concat, no spread) so the Hosted edition still `require()`s it.

**Open questions flagged for the reader (also in the report):**
1. **`/api/plan/apply` placement in `coach.ts`** (beside `/api/plan/compute`, reusing its private helpers) vs `plan.ts` — chosen for helper reuse; confirm.
2. **`plan_summary` refreshed deterministically** from the recomputed plan (no AI, self-consistent) vs reusing the coach's visible reply prose — chosen deterministic; confirm.
3. **`goal_kcal` clamp ceiling of 6,000** (floor already reuses the engine's 1,500/1,300) — confirm the ceiling and that an explicit `goal_kcal` should override the engine's computed kcal (with macros still engine-derived), vs treating `goal_kcal` as advisory only.
4. **Apply body shape = the plan_change object directly** (`{goal_kcal?, method?, …}`), matching the spec's "body = the validated plan_change". Confirm (vs a wrapped `{ change: {...} }`).
5. **First-marker-wins** in `splitPlanChange` (a doubled trailer takes the first, strips the rest) — confirm that's the desired disambiguation.
