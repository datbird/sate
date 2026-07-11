/// <reference path="../pb_data/types.d.ts" />

// Function registry, prompts, key encryption, and config resolution.

const FUNCTIONS = ["vision_estimate", "text_parse", "daily_summary", "web_lookup", "activity_estimate", "nutritionist", "checkin"];

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
  "bullet lists. You are not a doctor; for medical conditions, pregnancy, eating disorders, or " +
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
};

// ---- encryption of provider API keys (AES-256-GCM via $security) ----

// Env access inside PocketBase hooks is via $os.getenv (process.env is not available in the
// isolated handler VM).
function env(name) {
  try {
    if (typeof $os !== "undefined" && $os.getenv) return $os.getenv(name) || "";
  } catch (_) {}
  try {
    if (typeof process !== "undefined" && process.env) return process.env[name] || "";
  } catch (_) {}
  return "";
}

function encKey() {
  const k = env("APP_ENCRYPTION_KEY") || "";
  if (k.length !== 32) {
    throw new Error(
      "APP_ENCRYPTION_KEY must be exactly 32 characters (AES-256). " +
        "Generate one with `openssl rand -hex 16`."
    );
  }
  return k;
}

function encryptKey(plaintext) {
  if (!plaintext) return "";
  return $security.encrypt(plaintext, encKey());
}

function bytesToStr(b) {
  if (b == null) return "";
  if (typeof b === "string") return b;
  let s = "";
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return s;
}

function decryptKey(cipher) {
  if (!cipher) return "";
  return bytesToStr($security.decrypt(cipher, encKey()));
}

function redact(plaintext) {
  if (!plaintext) return "";
  const s = String(plaintext);
  return s.length <= 4 ? "••••" : "••••" + s.slice(-4);
}

// ---- resolve which provider+model+key handles a function ----

// Try to build a usable config for a provider+model; returns null if the provider is missing,
// disabled, or has no key (so callers can fall back).
function tryResolveProvider(app, provider, model) {
  if (!provider || !model) return null;
  const prov = app.findFirstRecordByFilter("providers", "name = {:n}", { n: provider });
  if (!prov || !prov.getBool("enabled")) return null;
  const enc = prov.getString("api_key_enc");
  if (!enc) return null;
  return { provider: provider, model: model, apiKey: decryptKey(enc), baseUrl: prov.getString("base_url") || "" };
}

// Resolve which provider+model+key handles a function. An optional per-user `override`
// ({provider, model}) wins when its provider is enabled and keyed; otherwise the global
// per-function default is used.
// Resolve a concrete (provider, model) to a callable config: the provider record must exist, be
// enabled, and have a key. Throws a clear error otherwise. (The routing hierarchy that CHOOSES the
// provider/model lives in api.js resolveFor; this is just the provider/key lookup tail.)
function resolveProviderKey(app, provider, model) {
  const prov = app.findFirstRecordByFilter("providers", "name = {:n}", { n: provider });
  if (!prov) throw new Error("unknown provider: " + provider);
  if (!prov.getBool("enabled")) throw new Error("provider not enabled: " + provider);
  const enc = prov.getString("api_key_enc");
  if (!enc) throw new Error("no API key configured for provider: " + provider);
  return { provider: provider, model: model, apiKey: decryptKey(enc), baseUrl: prov.getString("base_url") || "" };
}

function resolveFunction(app, fn, override) {
  if (override && override.provider && override.model) {
    const r = tryResolveProvider(app, override.provider, override.model);
    if (r) return r;
  }

  const cfg = app.findFirstRecordByFilter("function_config", "fn = {:fn}", { fn: fn });
  if (!cfg) throw new Error("function not configured: " + fn);
  if (!cfg.getBool("enabled")) throw new Error("function is disabled: " + fn);

  const provider = cfg.getString("provider");
  const model = cfg.getString("model");
  if (!provider || !model) throw new Error("function missing provider/model: " + fn);

  const prov = app.findFirstRecordByFilter("providers", "name = {:n}", { n: provider });
  if (!prov) throw new Error("unknown provider: " + provider);
  if (!prov.getBool("enabled")) throw new Error("provider not enabled: " + provider);

  const enc = prov.getString("api_key_enc");
  if (!enc) throw new Error("no API key configured for provider: " + provider);

  return {
    provider: provider,
    model: model,
    apiKey: decryptKey(enc),
    baseUrl: prov.getString("base_url") || "",
  };
}

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
  encryptKey,
  decryptKey,
  redact,
  resolveFunction,
  resolveProviderKey,
  parseJSON,
  normalizeNutrition,
  normalizeActivity,
};
