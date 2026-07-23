// Sate — AI function registry, system prompts, and defensive JSON parsing / normalization.
//
// SHARED MODULE — consumed by BOTH editions:
//   Hosted (PocketBase/goja):  require(`${__hooks}/shared/prompts.js`)
//   Cloud  (Node/TypeScript):  import { PROMPTS } from "../shared/prompts.js"
//
// Authored as CommonJS in goja-safe ES2015 (goja has no ES modules; no `?.`, no `??`, no object
// spread). Types for TS consumers live in the sibling prompts.d.ts — keep the two in step.
//
// THIS IS THE HIGHEST-VALUE SHARED MODULE. If the prompt text drifts between editions, the two
// give different AI answers to the same meal and no test catches it — the numbers just quietly
// disagree. Change a prompt here and both editions change together.
//
// PocketBase-specific concerns deliberately stay in pb_hooks/functions.js: provider-key encryption
// ($security AES-GCM) and the DB provider lookup. Cloud gets those from the Secrets/DataStore ports.

const FUNCTIONS = ["vision_estimate", "text_parse", "daily_summary", "web_lookup", "activity_estimate", "nutritionist", "checkin", "recipe_suggest", "recipe_expand"];

const NUTRITION_SCHEMA =
  '{"items":[{"name":string,"qty":string,"kcal":number,"protein":number,"carbs":number,"fat":number,"fiber":number,"sugar":number,"sodium":number,"sat_fat":number}],' +
  '"total":{"kcal":number,"protein":number,"carbs":number,"fat":number,"fiber":number,"sugar":number,"sodium":number,"sat_fat":number},"note":string}';

const UNITS_LINE =
  "protein, carbs, fat, fiber, sugar and sat_fat are grams; sodium is milligrams. fiber and sugar " +
  "are subsets of carbs; sat_fat is a subset of fat. Always fill every field with your best " +
  "estimate (use 0 only when a nutrient is genuinely absent).";
const EMPTY_TOTAL = '{"items":[],"total":{"kcal":0,"protein":0,"carbs":0,"fat":0,"fiber":0,"sugar":0,"sodium":0,"sat_fat":0},"note":"..."}';

const NUTRITION_SYSTEM =
  "You are a nutrition estimation engine. Given a description or photo of food, estimate its " +
  "nutrition for the portion shown. Respond ONLY with strict minified JSON (no markdown, no " +
  "code fences) matching exactly:\n" + NUTRITION_SCHEMA + "\n" + UNITS_LINE + " Estimate typical " +
  "serving sizes when unspecified, and list each distinct food or drink as its own entry in items " +
  "(a plate of several foods → several items). For a packaged or branded product, use the label's " +
  "per-serving values when you can identify it. If the message includes a 'Known foods from the " +
  "database' list, " +
  "use those per-serving values for matching items (scaled to the amount eaten) instead of " +
  "estimating, and still estimate fiber/sugar/sodium/sat_fat for them. If no food is " +
  "identifiable, return " + EMPTY_TOTAL + ".";

const WEB_LOOKUP_SYSTEM =
  "You are a nutrition research engine with live web search. The user names a food or meal that " +
  "wasn't in the local database. Use web search to find authoritative per-serving nutrition data, " +
  "then estimate the nutrition for the portion the user described. When 'Preferred sources' are " +
  "listed, search those sites FIRST by adding Google 'site:' operators to your queries (e.g. " +
  "\"<food> nutrition facts site:fdc.nal.usda.gov\", or OR several: \"site:a.com OR site:b.com\"). " +
  "Only fall back to a broad, unscoped web search if the preferred sources don't cover the food. " +
  "Respond ONLY with strict minified JSON (no markdown, no code fences) matching exactly:\n" +
  NUTRITION_SCHEMA + "\n" + UNITS_LINE + " In the note field, briefly name which source(s) you " +
  "actually used. If nothing is identifiable, return " + EMPTY_TOTAL + ".";

const ACTIVITY_SCHEMA =
  '{"items":[{"name":string,"duration_min":number,"intensity":string,"kcal_burned":number}],' +
  '"total":{"kcal_burned":number,"duration_min":number},"note":string}';

const ACTIVITY_SYSTEM =
  "You are an exercise calorie-burn estimation engine. Given a description of physical activity, " +
  "estimate the calories burned. Use the person's body weight when it is provided in the message " +
  "(burn scales with body weight); otherwise assume an average adult (~70 kg / 155 lb). Respond " +
  "ONLY with strict minified JSON (no markdown, no code fences) matching " +
  "exactly:\n" + ACTIVITY_SCHEMA + "\nduration_min is minutes; kcal_burned is total calories for " +
  "that activity and duration; intensity is one of light|moderate|vigorous. If the message includes " +
  "a 'Known activities' list with burn rates, use those rates for matching activities (scaled by " +
  "duration) instead of estimating from scratch. Infer duration and distance from the text when " +
  'given (e.g. "3 mile run" at an average pace). If no activity is identifiable, return ' +
  '{"items":[],"total":{"kcal_burned":0,"duration_min":0},"note":"..."}.';

const NUTRITIONIST_SYSTEM =
  "You are the nutrition coach inside the Sate app — a knowledgeable, encouraging, evidence-based " +
  "guide who helps the user eat well and hit their weight and nutrition goals. \"Sate\" is the app's " +
  "name (and yours) — it is NOT the user's name. Address the user by the first name in the CONTEXT's " +
  "'Name' field; if none is given use a warm neutral greeting (e.g. \"Hi there\") and never call the " +
  "user \"Sate.\" You are given a CONTEXT block with the user's stats, goals, pre-computed targets, " +
  "and recent intake; TRUST those numbers and build your advice on them (never recompute or " +
  "contradict them).\n\n" +
  "You may get any kind of turn: (1) generate or revise the user's PLAN; (2) answer general " +
  "nutrition, food, and meal questions — suggest specific meals, swaps, and portions that fit their " +
  "targets and tracking method; (3) discuss a PHOTO the user shares — a menu, a plate, or a packaged " +
  "product — to help them choose or ballpark it. Everything in this chat is GUIDANCE ONLY: the coach " +
  "never logs food (the user logs meals from the Add screen), so keep photo/menu help conversational " +
  "with rough ranges, not a strict logging estimate.\n\n" +
  "Formulas to reason with consistently:\n" +
  "- BMR: Mifflin-St Jeor. TDEE = BMR × activity (sedentary 1.2 / light 1.375 / moderate 1.55 / " +
  "active 1.725 / athlete 1.9).\n" +
  "- ~3500 kcal per pound of body weight. A safe rate of loss/gain is about 0.5–1% of body weight " +
  "per week (roughly 1–2 lb/week for most adults); never advise below ~1500 kcal/day (men) or " +
  "~1300 (women) without a clinician.\n" +
  "- Protein ~1.6–2.2 g/kg supports muscle in a deficit. Method macro emphasis: high-protein = " +
  "protein-forward; low-carb = carbs low (fat fills the rest); low-fat = fat ≤ ~25% kcal; balanced " +
  "= even carb/fat; heart-healthy = moderate fat, low saturated fat, sodium ≤ ~1500 mg.\n\n" +
  "When giving or revising a PLAN, be specific and quantified: state the weekly rate and the daily " +
  "calorie/macro numbers needed to hit the goal (e.g. \"lose ~1.9 lb/week — about a 950 kcal/day " +
  "deficit — to reach 180 lb by Sep 1\"). If a goal is flagged AGGRESSIVE, say so plainly, explain " +
  "why, and recommend a concrete realistic alternative (a slower weekly rate, a later date, or a " +
  "more reachable target for the requested date — the CONTEXT provides these). For meal, menu, and " +
  "photo help, tie suggestions to their remaining budget, targets, tracking method, and recent " +
  "intake, and flag which options best fit their goals. Give 2–3 actionable next steps when it " +
  "helps. Be warm and concise — a few short plain-text paragraphs, no markdown headers or long " +
  "bullet lists. When the CONTEXT lists the user's dietary restrictions or allergies, treat them as a " +
  "HARD constraint: never suggest a meal, food, or swap that includes a restricted or allergenic " +
  "ingredient.\n\n" +
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
  "You are not a doctor; for medical conditions, pregnancy, eating disorders, or " +
  "medications, recommend a professional.";

const DAILY_SUMMARY_SYSTEM =
  "You are Sate. Given the user's food entries for a day plus their daily goals and tracking method, " +
  "write a short, friendly recap in 2-4 plain-text sentences: total calories vs goal, how the macro " +
  "balance fit their tracking method's emphasis, and one practical tip for tomorrow. Be encouraging, " +
  "never judgmental. No markdown headers or bullet lists.";

// Decides whether a PROACTIVE check-in is worth sending right now, and if so writes it. Output is
// strict JSON. Be conservative: only worthwhile when there's something genuinely useful, timely, or
// encouraging to say — never nag or check in just to check in.
const CHECKIN_SYSTEM =
  "You are the Sate nutrition coach deciding whether to proactively check in with the user today. " +
  "You are given a CONTEXT block with their stats, goals, recent intake vs targets, weight trend, " +
  "and logging activity. Decide if a check-in would be genuinely VALUABLE right now — e.g. they hit " +
  "a milestone or a streak, they've drifted off their targets for several days, they stopped logging, " +
  "a weight goal's deadline is near and the pace is off, or a timely encouragement would help. Do NOT " +
  "check in just to check in; if there's nothing useful, timely, or motivating to say, skip.\n\n" +
  "Respond with STRICT JSON only, no prose or fences: " +
  '{"worthwhile": boolean, "topic": string, "message": string}. ' +
  "When worthwhile is true: `topic` is a 3-6 word summary for the notification title; `message` is a " +
  "warm, specific, 1-2 sentence check-in addressed to the user by their first name (from CONTEXT's " +
  "Name), referencing a concrete detail from their data and inviting a reply. When worthwhile is " +
  "false: set topic and message to empty strings. Plain text only, no markdown.";

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

// ---- recipe prompt builders (pure; server injects allergies from the profile) ----
// Maps incoming track_mode tokens to prompt emphasis vocabulary to fix inversion (e.g., "fat" means
// low-fat tracking, not fat-forward). See buildRecipeSuggestMsg caller contracts.
var METHOD_EMPHASIS = {
  calories: "balanced calories",
  carb: "low-carb",
  protein: "high-protein",
  fat: "low-fat",
  balanced: "balanced macros",
  heart: "heart-healthy",
};

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
  if (method) {
    var emphasis = METHOD_EMPHASIS[method] || method || "balanced macros";
    L.push("Tracking-method emphasis: " + emphasis + ".");
  }
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
  var visible = text.slice(0, idx).trim();
  var after = text.slice(idx + PLAN_CHANGE_MARKER.length);
  // If the model emitted a SECOND marker, only the first one's JSON counts — truncate before the next
  // marker so the brace scan can't span into a later object and corrupt the parse (first wins).
  var next = after.indexOf(PLAN_CHANGE_MARKER);
  if (next !== -1) after = after.slice(0, next);
  var planChange = null;
  // Anchor on the first non-whitespace char: the trailer's payload must be a bare object literal.
  // Anything else (array, number, prose) is not a plan change. This also rejects `[{...}]` wrappers.
  var start = after.search(/\S/);
  if (start !== -1 && after.charAt(start) === "{") {
    // Find the '}' that BALANCES the opening '{' — string-aware so a '}' inside a JSON string value,
    // or stray prose after the object (a well-formed trailer followed by "... :}"), can't fool us the
    // way lastIndexOf("}") could. Deterministic, single pass, no lookahead (goja-safe).
    var depth = 0, inStr = false, esc = false, end = -1;
    for (var i = start; i < after.length; i++) {
      var c = after.charAt(i);
      if (inStr) {
        if (esc) esc = false;
        else if (c === "\\") esc = true;
        else if (c === "\"") inStr = false;
      } else if (c === "\"") inStr = true;
      else if (c === "{") depth++;
      else if (c === "}") { depth--; if (depth === 0) { end = i; break; } }
    }
    if (end !== -1) {
      try {
        var parsed = JSON.parse(after.slice(start, end + 1));
        // A real change carries at least one field; an empty object is not an "apply this" signal.
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && Object.keys(parsed).length > 0) {
          planChange = parsed;
        }
      } catch (e) {
        planChange = null;
      }
    }
  }
  return { visibleText: visible, planChange: planChange };
}

const PROMPTS = {
  vision_estimate: { system: NUTRITION_SYSTEM, jsonMode: true },
  text_parse: { system: NUTRITION_SYSTEM, jsonMode: true },
  daily_summary: { system: DAILY_SUMMARY_SYSTEM, jsonMode: false },
  // Web search grounding can't be combined with forced-JSON response modes, so jsonMode is
  // off and the reply is parsed defensively (parseJSON strips any prose/fences).
  web_lookup: { system: WEB_LOOKUP_SYSTEM, jsonMode: false },
  activity_estimate: { system: ACTIVITY_SYSTEM, jsonMode: true },
  nutritionist: { system: NUTRITIONIST_SYSTEM, jsonMode: false },
  checkin: { system: CHECKIN_SYSTEM, jsonMode: true },
  recipe_suggest: { system: RECIPE_SUGGEST_SYSTEM, jsonMode: true },
  recipe_expand: { system: RECIPE_EXPAND_SYSTEM, jsonMode: true },
};

// ---- defensive JSON extraction from a model reply ----

function parseJSON(text) {
  if (!text) throw new Error("empty model response");
  let s = String(text).trim();
  // strip ```json ... ``` fences if present
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  // otherwise grab the outermost {...}
  if (s[0] !== "{") {
    const a = s.indexOf("{");
    const b = s.lastIndexOf("}");
    if (a !== -1 && b !== -1 && b > a) s = s.slice(a, b + 1);
  }
  return JSON.parse(s);
}

function num(v) {
  const n = Number(v);
  return isFinite(n) ? n : 0;
}

// Normalize a parsed nutrition object into a consistent shape with a computed total.
function normalizeNutrition(obj) {
  const items = Array.isArray(obj.items) ? obj.items : [];
  const clean = items.map((it) => ({
    name: String(it.name || "item"),
    qty: String(it.qty || ""),
    kcal: num(it.kcal),
    protein: num(it.protein),
    carbs: num(it.carbs),
    fat: num(it.fat),
    fiber: num(it.fiber),
    sugar: num(it.sugar),
    sodium: num(it.sodium),
    sat_fat: num(it.sat_fat),
  }));
  const total = clean.reduce(
    (t, it) => ({
      kcal: t.kcal + it.kcal,
      protein: t.protein + it.protein,
      carbs: t.carbs + it.carbs,
      fat: t.fat + it.fat,
      fiber: t.fiber + it.fiber,
      sugar: t.sugar + it.sugar,
      sodium: t.sodium + it.sodium,
      sat_fat: t.sat_fat + it.sat_fat,
    }),
    { kcal: 0, protein: 0, carbs: 0, fat: 0, fiber: 0, sugar: 0, sodium: 0, sat_fat: 0 }
  );
  return { items: clean, total: total, note: String(obj.note || "") };
}

// Normalize a parsed activity object into a consistent shape with a computed total.
function normalizeActivity(obj) {
  const items = Array.isArray(obj.items) ? obj.items : [];
  const clean = items.map((it) => ({
    name: String(it.name || "activity"),
    duration_min: num(it.duration_min),
    intensity: String(it.intensity || ""),
    kcal_burned: num(it.kcal_burned),
  }));
  const total = clean.reduce(
    (t, it) => ({ kcal_burned: t.kcal_burned + it.kcal_burned, duration_min: t.duration_min + it.duration_min }),
    { kcal_burned: 0, duration_min: 0 }
  );
  return { items: clean, total: total, note: String(obj.note || "") };
}

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
