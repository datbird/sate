/// <reference path="../pb_data/types.d.ts" />

// Function registry, prompts, key encryption, and config resolution.

const FUNCTIONS = ["vision_estimate", "text_parse", "chat", "daily_summary", "web_lookup", "activity_estimate", "nutritionist"];

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
  "serving sizes when unspecified. If the message includes a 'Known foods from the database' list, " +
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
  "estimate the calories burned. Assume an average adult (~70 kg / 155 lb) unless the description " +
  "says otherwise. Respond ONLY with strict minified JSON (no markdown, no code fences) matching " +
  "exactly:\n" + ACTIVITY_SCHEMA + "\nduration_min is minutes; kcal_burned is total calories for " +
  "that activity and duration; intensity is one of light|moderate|vigorous. If the message includes " +
  "a 'Known activities' list with burn rates, use those rates for matching activities (scaled by " +
  "duration) instead of estimating from scratch. Infer duration and distance from the text when " +
  'given (e.g. "3 mile run" at an average pace). If no activity is identifiable, return ' +
  '{"items":[],"total":{"kcal_burned":0,"duration_min":0},"note":"..."}.';

const CHAT_SYSTEM =
  "You are Sate, a friendly, concise calorie and nutrition coach. Help the user understand and " +
  "manage their intake. Keep replies short and practical. If the user's logged totals for today " +
  "are provided, you may reference them.";

const NUTRITIONIST_SYSTEM =
  "You are Sate's nutritionist coach — a knowledgeable, encouraging, evidence-based guide who helps " +
  "the user hit their weight and nutrition goals. You are given a CONTEXT block with the user's " +
  "stats and pre-computed numbers; TRUST those numbers and build your advice on them (do not " +
  "recompute or contradict them).\n\n" +
  "The numbers come from these formulas, which you should reason with consistently:\n" +
  "- BMR: Mifflin-St Jeor. TDEE = BMR × activity (sedentary 1.2 / light 1.375 / moderate 1.55 / " +
  "active 1.725 / athlete 1.9).\n" +
  "- ~3500 kcal per pound of body weight. A safe rate of loss/gain is about 0.5–1% of body weight " +
  "per week (roughly 1–2 lb/week for most adults); never advise below ~1500 kcal/day (men) or " +
  "~1300 (women) without a clinician.\n" +
  "- Protein ~1.6–2.2 g/kg supports muscle in a deficit. Method macro emphasis: high-protein = " +
  "protein-forward; low-carb = carbs low (fat fills the rest); low-fat = fat ≤ ~25% kcal; balanced " +
  "= even carb/fat; heart-healthy = moderate fat, low saturated fat, sodium ≤ ~1500 mg.\n\n" +
  "ALWAYS be specific and quantified: state the weekly rate and daily calorie/macro numbers needed " +
  "to hit the goal (e.g. \"lose ~1.9 lb/week — about a 950 kcal/day deficit — to reach 180 lb by " +
  "Sep 1\"). If a goal is flagged AGGRESSIVE, say so plainly, explain why the pace is unrealistic or " +
  "unsafe, and RECOMMEND a concrete realistic alternative (a slower weekly rate, a later date, or a " +
  "more reachable target weight for the requested date — the CONTEXT gives these). Reference recent " +
  "intake vs targets when provided and give 2–3 actionable next steps. Be warm and concise (a few " +
  "short paragraphs, plain text — no markdown headers or long bullet lists). You are not a doctor; " +
  "for medical conditions, pregnancy, eating disorders, or medications, recommend a professional.";

const DAILY_SUMMARY_SYSTEM =
  "You are Sate. Given the user's food entries for a day and their daily goals, write a short, " +
  "friendly recap in 2-4 plain-text sentences: total calories vs goal, macro balance, and one " +
  "practical tip. No markdown headers or bullet lists.";

const PROMPTS = {
  vision_estimate: { system: NUTRITION_SYSTEM, jsonMode: true },
  text_parse: { system: NUTRITION_SYSTEM, jsonMode: true },
  chat: { system: CHAT_SYSTEM, jsonMode: false },
  daily_summary: { system: DAILY_SUMMARY_SYSTEM, jsonMode: false },
  // Web search grounding can't be combined with forced-JSON response modes, so jsonMode is
  // off and the reply is parsed defensively (parseJSON strips any prose/fences).
  web_lookup: { system: WEB_LOOKUP_SYSTEM, jsonMode: false },
  activity_estimate: { system: ACTIVITY_SYSTEM, jsonMode: true },
  nutritionist: { system: NUTRITIONIST_SYSTEM, jsonMode: false },
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
  parseJSON,
  normalizeNutrition,
  normalizeActivity,
};
