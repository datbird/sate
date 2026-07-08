/// <reference path="../pb_data/types.d.ts" />

// Function registry, prompts, key encryption, and config resolution.

const FUNCTIONS = ["vision_estimate", "text_parse", "chat", "daily_summary", "web_lookup"];

const NUTRITION_SCHEMA =
  '{"items":[{"name":string,"qty":string,"kcal":number,"protein":number,"carbs":number,"fat":number}],' +
  '"total":{"kcal":number,"protein":number,"carbs":number,"fat":number},"note":string}';

const NUTRITION_SYSTEM =
  "You are a nutrition estimation engine. Given a description or photo of food, estimate its " +
  "nutrition for the portion shown. Respond ONLY with strict minified JSON (no markdown, no " +
  "code fences) matching exactly:\n" + NUTRITION_SCHEMA + "\n" +
  "protein/carbs/fat are grams. Estimate typical serving sizes when unspecified. If the message " +
  "includes a 'Known foods from the database' list, use those per-serving values for matching " +
  "items (scaled to the amount eaten) instead of estimating. If no food is " +
  'identifiable, return {"items":[],"total":{"kcal":0,"protein":0,"carbs":0,"fat":0},"note":"..."}.';

const WEB_LOOKUP_SYSTEM =
  "You are a nutrition research engine with live web search. The user names a food or meal that " +
  "wasn't in the local database. Use web search to find authoritative per-serving nutrition data, " +
  "then estimate the nutrition for the portion the user described. Strongly prefer the authoritative " +
  "references listed under 'Preferred sources' when present; you may consult other reputable " +
  "nutrition databases only if those don't cover the food. Respond ONLY with strict minified JSON " +
  "(no markdown, no code fences) matching exactly:\n" + NUTRITION_SCHEMA + "\n" +
  "protein/carbs/fat are grams. In the note field, briefly name which source(s) you used. If nothing " +
  'is identifiable, return {"items":[],"total":{"kcal":0,"protein":0,"carbs":0,"fat":0},"note":"..."}.';

const CHAT_SYSTEM =
  "You are Sate, a friendly, concise calorie and nutrition coach. Help the user understand and " +
  "manage their intake. Keep replies short and practical. If the user's logged totals for today " +
  "are provided, you may reference them.";

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

function resolveFunction(app, fn) {
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
  }));
  const total = clean.reduce(
    (t, it) => ({
      kcal: t.kcal + it.kcal,
      protein: t.protein + it.protein,
      carbs: t.carbs + it.carbs,
      fat: t.fat + it.fat,
    }),
    { kcal: 0, protein: 0, carbs: 0, fat: 0 }
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
};
