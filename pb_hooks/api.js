/// <reference path="../pb_data/types.d.ts" />

// All Sate request logic. PocketBase runs route handlers in an isolated JSVM that can't see a
// hook file's top-level scope, so main.pb.js stays thin and delegates to the functions below
// (each handler require()s this module at call time).

const P = require(`${__hooks}/providers.js`);
const F = require(`${__hooks}/functions.js`);
const FOODS = require(`${__hooks}/foods.js`);
const ACTS = require(`${__hooks}/activities.js`);
const AL = require(`${__hooks}/ailimits.js`);
const N = require(`${__hooks}/nutrition.js`);

function num(v) {
  const n = Number(v);
  return isFinite(n) ? n : 0;
}

function env(name) {
  try {
    if (typeof $os !== "undefined" && $os.getenv) return $os.getenv(name) || "";
  } catch (_) {}
  try {
    if (typeof process !== "undefined" && process.env) return process.env[name] || "";
  } catch (_) {}
  return "";
}

// How users are identified:
//   "proxy" — trust an email header injected by an auth proxy (Cloudflare Access, oauth2-proxy…).
//             The origin MUST be reachable only through that proxy, or anyone can forge the header.
//   "apple" — Sate authenticates users itself, via Sign in with Apple on the `users` collection.
//             The origin may be exposed directly; the proxy header is ignored entirely.
const AUTH_MODE = (env("AUTH_MODE") || "proxy").toLowerCase().trim() === "apple" ? "apple" : "proxy";
const AUTH_HEADER = env("AUTH_EMAIL_HEADER") || "Cf-Access-Authenticated-User-Email";
const DEV_EMAIL = env("DEV_EMAIL").toLowerCase().trim();
const ADMINS = env("ADMIN_EMAILS")
  .toLowerCase()
  .split(",")
  .map((s) => s.trim())
  .filter((s) => s.length > 0);
const VALID_PROVIDERS = ["anthropic", "openai", "google", "openrouter"];
const SETTING_KEYS = ["app_name", "default_goal_kcal", "default_goal_protein", "default_goal_carbs", "default_goal_fat"];

// ------------------------------------------------------------------ helpers

function identity(e) {
  if (AUTH_MODE === "apple") {
    // Deliberately does NOT fall back to AUTH_HEADER: in this mode the origin can be public,
    // and honouring the header would let anyone authenticate as anyone.
    try {
      if (e.auth) {
        const email = (e.auth.email() || "").toLowerCase().trim();
        if (email) return email;
      }
    } catch (_) {}
    return DEV_EMAIL;
  }
  let email = e.request.header.get(AUTH_HEADER) || "";
  if (!email && DEV_EMAIL) email = DEV_EMAIL;
  return email.toLowerCase().trim();
}

// Public — the SPA calls this before it has any session, to decide whether to render a
// Sign in with Apple button or assume the proxy already authenticated the request.
function authConfig(e) {
  // Reported in both modes: an operator needs to see that Apple is wired up *before* flipping
  // AUTH_MODE to apple, otherwise the switch locks everyone out.
  let appleReady = false;
  try {
    const col = e.app.findCollectionByNameOrId("users");
    const providers = (col.oauth2 && col.oauth2.providers) || [];
    appleReady = !!col.oauth2.enabled && providers.some((p) => p.name === "apple");
  } catch (_) {}
  return e.json(200, {
    mode: AUTH_MODE,
    apple_configured: appleReady,
    app_name: settingsMap(e.app).app_name || "Sate",
  });
}

function isEnvAdmin(email) {
  return ADMINS.indexOf(email) !== -1;
}

// Admin = listed in ADMIN_EMAILS (env, bootstrap) OR promoted in-app (profiles.role == "admin").
function resolveIsAdmin(app, email) {
  if (isEnvAdmin(email)) return true;
  try {
    const p = app.findFirstRecordByFilter("profiles", "email = {:e}", { e: email });
    return p.getString("role") === "admin";
  } catch (_) {
    return false;
  }
}

function settingsMap(app) {
  const out = {};
  try {
    app.findAllRecords("settings").forEach((r) => {
      out[r.getString("key")] = r.getString("value");
    });
  } catch (_) {}
  return out;
}

// Effective system prompt for a function: an admin override in `settings` (key prompt_<fn>)
// if set, otherwise the built-in default from functions.js.
function promptFor(app, fn) {
  try {
    const rec = app.findFirstRecordByFilter("settings", "key = {:k}", { k: "prompt_" + fn });
    const v = rec.getString("value");
    if (v && v.trim()) return v;
  } catch (_) {}
  return (F.PROMPTS[fn] && F.PROMPTS[fn].system) || "";
}

function applyDefaultGoals(app, rec) {
  const s = settingsMap(app);
  if (s.default_goal_kcal) rec.set("goal_kcal", Number(s.default_goal_kcal) || 0);
  if (s.default_goal_protein) rec.set("goal_protein", Number(s.default_goal_protein) || 0);
  if (s.default_goal_carbs) rec.set("goal_carbs", Number(s.default_goal_carbs) || 0);
  if (s.default_goal_fat) rec.set("goal_fat", Number(s.default_goal_fat) || 0);
}

function ensureProfile(app, email) {
  let rec = null;
  try {
    rec = app.findFirstRecordByFilter("profiles", "email = {:e}", { e: email });
  } catch (_) {
    rec = null;
  }
  let dirty = false;
  if (!rec) {
    rec = new Record(app.findCollectionByNameOrId("profiles"));
    rec.set("email", email);
    rec.set("name", email.split("@")[0]);
    rec.set("role", isEnvAdmin(email) ? "admin" : "user");
    applyDefaultGoals(app, rec);
    dirty = true;
  } else if (isEnvAdmin(email) && rec.getString("role") !== "admin") {
    // env admins are always admin; never force-downgrade an in-app promoted admin
    rec.set("role", "admin");
    dirty = true;
  }
  if (dirty) app.save(rec);
  return rec;
}

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function dayRange(dateStr) {
  const start = dateStr + " 00:00:00.000Z";
  const d = new Date(dateStr + "T00:00:00.000Z");
  d.setUTCDate(d.getUTCDate() + 1);
  const end = d.toISOString().slice(0, 10) + " 00:00:00.000Z";
  return { start: start, end: end };
}

// A json field reads back as raw bytes via rec.get() on a reloaded record; getString() gives the
// JSON text in both the in-memory-set and persisted cases, so parse that for native JS objects.
function readItems(rec) {
  const s = rec.getString("items");
  if (!s) return [];
  try {
    return JSON.parse(s);
  } catch (_) {
    return [];
  }
}

function entryJSON(rec) {
  const kind = rec.getString("kind") || "food";
  return {
    id: rec.id,
    kind: kind,
    logged_at: rec.getString("logged_at"),
    source: rec.getString("source"),
    description: rec.getString("description"),
    items: readItems(rec),
    duration_min: rec.getFloat("duration_min"),
    distance: rec.getFloat("distance"),
    intensity: rec.getString("intensity"),
    kcal: rec.getFloat("kcal"),
    protein: rec.getFloat("protein"),
    carbs: rec.getFloat("carbs"),
    fat: rec.getFloat("fat"),
    fiber: rec.getFloat("fiber"),
    sugar: rec.getFloat("sugar"),
    sodium: rec.getFloat("sodium"),
    sat_fat: rec.getFloat("sat_fat"),
    provider: rec.getString("provider"),
    model: rec.getString("model"),
  };
}

function dayEntries(app, email, dateStr) {
  const r = dayRange(dateStr);
  return app.findRecordsByFilter(
    "entries",
    "user_email = {:e} && logged_at >= {:s} && logged_at < {:end}",
    "-logged_at",
    500,
    0,
    { e: email, s: r.start, end: r.end }
  );
}

// A rolling window for the stats dashboard, anchored on today (UTC). Returns the half-open
// [start,end) datetime-literal bounds plus the bucket granularity for the trend series.
function periodWindow(range) {
  const days = range === "day" ? 1 : range === "week" ? 7 : range === "month" ? 30 : 365;
  const now = new Date();
  const endD = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
  const startD = new Date(endD);
  startD.setUTCDate(startD.getUTCDate() - days);
  const iso = (d) => d.toISOString().slice(0, 10) + " 00:00:00.000Z";
  return { start: iso(startD), end: iso(endD), days: days, bucket: range === "year" ? "month" : "day" };
}

// Fetch every entry in [start,end) for a user, paging past the 500-row cap so month/year
// windows aren't silently truncated. (Volumes are tiny for a personal app; if this ever grows,
// swap for a SQL SUM(...) GROUP BY via app.db().newQuery.)
function rangeEntries(app, email, start, end) {
  const out = [];
  let offset = 0;
  for (;;) {
    const page = app.findRecordsByFilter(
      "entries",
      "user_email = {:e} && logged_at >= {:s} && logged_at < {:end}",
      "-logged_at",
      500,
      offset,
      { e: email, s: start, end: end }
    );
    for (const r of page) out.push(r);
    if (page.length < 500) break;
    offset += 500;
  }
  return out;
}

function isActivity(rec) { return rec.getString("kind") === "activity"; }

// Intake totals for the ring/goals. Activity entries carry kcal as *burn*, which is never intake,
// so they're skipped here — burn is surfaced separately by the stats endpoint.
function sumTotals(records) {
  const t = { kcal: 0, protein: 0, carbs: 0, fat: 0, fiber: 0, sugar: 0, sodium: 0, sat_fat: 0, count: 0 };
  for (const rec of records) {
    if (rec.getString("kind") === "activity") continue;
    t.count += 1;
    t.kcal += rec.getFloat("kcal");
    t.protein += rec.getFloat("protein");
    t.carbs += rec.getFloat("carbs");
    t.fat += rec.getFloat("fat");
    t.fiber += rec.getFloat("fiber");
    t.sugar += rec.getFloat("sugar");
    t.sodium += rec.getFloat("sodium");
    t.sat_fat += rec.getFloat("sat_fat");
  }
  return t;
}

function addEntry(app, email, data) {
  const rec = new Record(app.findCollectionByNameOrId("entries"));
  rec.set("user_email", email);
  rec.set("logged_at", data.logged_at ? new Date(data.logged_at).toISOString() : new Date().toISOString());
  if (data.ext_id) rec.set("ext_id", String(data.ext_id));
  rec.set("kind", data.kind || "food");
  rec.set("source", data.source);
  rec.set("description", data.description || "");
  rec.set("items", data.items || []);
  rec.set("duration_min", num(data.duration_min));
  rec.set("distance", num(data.distance));
  rec.set("intensity", data.intensity || "");
  rec.set("kcal", data.total.kcal);
  rec.set("protein", data.total.protein);
  rec.set("carbs", data.total.carbs);
  rec.set("fat", data.total.fat);
  rec.set("fiber", num(data.total.fiber));
  rec.set("sugar", num(data.total.sugar));
  rec.set("sodium", num(data.total.sodium));
  rec.set("sat_fat", num(data.total.sat_fat));
  rec.set("provider", data.provider || "");
  rec.set("model", data.model || "");
  app.save(rec);
  return rec;
}

// "vision_estimate" is image interpretation; everything else is "normal AI".
function fnCategory(fn) { return fn === "vision_estimate" ? "vision" : "ai"; }

// A user's per-category model override, or null to use the global default.
function userModelOverride(app, email, fn) {
  if (!email) return null;
  let p;
  try { p = app.findFirstRecordByFilter("profiles", "email = {:e}", { e: email }); } catch (_) { return null; }
  if (!p) return null;
  const vision = fnCategory(fn) === "vision";
  const provider = p.getString(vision ? "ov_vision_provider" : "ov_ai_provider");
  const model = p.getString(vision ? "ov_vision_model" : "ov_ai_model");
  if (!provider || !model) return null;
  return { provider: provider, model: model };
}

// Resolve a function for a specific user (applies their override, else the global default).
function resolveFor(app, fn, email) {
  return F.resolveFunction(app, fn, userModelOverride(app, email, fn));
}

// Central AI dispatch: enforce this provider's monthly limits, run the call, then record token
// usage. Returns the reply text (same value callers previously got straight from P.runProvider).
// req carries provider/model/apiKey/baseUrl/system/messages/image/jsonMode/webSearch.
function callAI(app, req) {
  AL.checkLimit(app, req.provider, req.model);
  const r = P.runProvider(req);
  AL.recordUsage(app, req.provider, req.model, r.input, r.output);
  return r.text;
}

function estimate(app, fn, userText, image, email) {
  const cfg = resolveFor(app, fn, email);
  const p = F.PROMPTS[fn];

  // Retrieval: for text logging, ground the model with known foods from the DB.
  let userMsg = userText;
  let matched = [];
  if (fn === "text_parse") {
    try {
      matched = FOODS.searchByText(app, userText);
      const ref = FOODS.referenceBlock(matched);
      if (ref) userMsg = ref + "\n\nMeal to log:\n" + userText;
    } catch (_) {}
  }

  const reply = callAI(app, {
    provider: cfg.provider,
    apiKey: cfg.apiKey,
    baseUrl: cfg.baseUrl,
    model: cfg.model,
    system: promptFor(app, fn),
    messages: [{ role: "user", text: userMsg }],
    image: image || null,
    jsonMode: p.jsonMode,
  });
  const parsed = F.normalizeNutrition(F.parseJSON(reply));

  // Self-growth: bump usage for matched foods, save any new ones as unverified.
  try {
    if (matched.length) FOODS.bumpUsage(app, matched);
    FOODS.upsertItems(app, parsed.items);
  } catch (_) {}

  // Only *verified* foods (seed/admin-confirmed) count as "known" for suppressing the web
  // button — an unverified AI guess is exactly what a web search should be able to replace.
  const trusted = matched.filter((f) => f.getBool("verified"));
  const inDb = fn === "text_parse" ? FOODS.coverageOk(userText, trusted) : false;
  return { parsed: parsed, provider: cfg.provider, model: cfg.model, inDb: inDb };
}

// The activity counterpart to estimate(): grounds on the activities table, calls the model, and
// returns a normalized {items, total:{kcal_burned, duration_min}, note}.
function estimateActivity(app, text, email) {
  const cfg = resolveFor(app, "activity_estimate", email);
  let userMsg = text;
  let matched = [];
  try {
    matched = ACTS.searchByText(app, text);
    const ref = ACTS.referenceBlock(matched);
    if (ref) userMsg = ref + "\n\nActivity to log:\n" + text;
  } catch (_) {}

  const reply = callAI(app, {
    provider: cfg.provider,
    apiKey: cfg.apiKey,
    baseUrl: cfg.baseUrl,
    model: cfg.model,
    system: promptFor(app, "activity_estimate"),
    messages: [{ role: "user", text: userMsg }],
    jsonMode: F.PROMPTS.activity_estimate.jsonMode,
  });
  const parsed = F.normalizeActivity(F.parseJSON(reply));
  try {
    if (matched.length) ACTS.bumpUsage(app, matched);
    ACTS.upsertItems(app, parsed.items);
  } catch (_) {}
  return { parsed: parsed, provider: cfg.provider, model: cfg.model };
}

// Build a "prefer these sources" hint from the curated nutrition URLs for web lookups.
function sourcesHint(app) {
  let recs = [];
  try {
    recs = app.findRecordsByFilter("sources", "enabled = true", "title", 50, 0, {});
  } catch (_) {
    recs = [];
  }
  if (!recs.length) return "";
  const lines = recs.map((r) => `- ${r.getString("title")}: ${r.getString("domain") || r.getString("url")}`);
  const domains = recs.map((r) => r.getString("domain")).filter(Boolean);
  const example = domains.length
    ? domains.slice(0, 3).map((d) => "site:" + d).join(" OR ")
    : "site:fdc.nal.usda.gov";
  return (
    "Preferred sources — search THESE FIRST with Google 'site:' operators before any general search " +
    "(e.g. query: \"<food> nutrition facts " + example + "\"). Fall back to a broad search only if none " +
    "of them cover the food:\n" + lines.join("\n")
  );
}

// Web-grounded estimate for a food/meal not found in the local database.
function webEstimate(app, text, email) {
  const cfg = resolveFor(app, "web_lookup", email);
  const hint = sourcesHint(app);
  const userMsg = (hint ? hint + "\n\n" : "") + "Food/meal to research and estimate:\n" + text;
  const reply = callAI(app, {
    provider: cfg.provider,
    apiKey: cfg.apiKey,
    baseUrl: cfg.baseUrl,
    model: cfg.model,
    system: promptFor(app, "web_lookup"),
    messages: [{ role: "user", text: userMsg }],
    webSearch: true,
    jsonMode: false,
  });
  const parsed = F.normalizeNutrition(F.parseJSON(reply));
  try { FOODS.upsertItems(app, parsed.items, "web"); } catch (_) {}
  return { parsed: parsed, provider: cfg.provider, model: cfg.model };
}

// Tracking modes → which metric the ring counts down. Kept in sync with the frontend MODES.
const TRACK_MODES = ["calories", "carb", "protein", "fat", "balanced", "heart"];

function goalsOf(profile) {
  return {
    kcal: profile.getFloat("goal_kcal"),
    protein: profile.getFloat("goal_protein"),
    carbs: profile.getFloat("goal_carbs"),
    fat: profile.getFloat("goal_fat"),
    sodium: profile.getFloat("goal_sodium"),
  };
}

function trackModeOf(profile) {
  const m = profile.getString("track_mode");
  return TRACK_MODES.indexOf(m) !== -1 ? m : "calories";
}

// "Add exercise calories to my budget" — on unless the profile explicitly opted out.
// Existing/unset profiles read back as on, matching how most trackers behave.
function netExerciseOf(profile) {
  return profile.getString("net_exercise") !== "off";
}

// Apple Health sync is opt-in and native-only, so it defaults OFF — on only once the
// user connects Health from the iOS app (which grants read access and flips this).
function healthSyncOf(profile) {
  return profile.getString("health_sync") === "on";
}

// Minutes the app waits between auto-syncs when it opens. "0" = every launch; unset/invalid
// reads back as the daily default. The throttle is applied client-side at launch (never in
// the background) using this value + health_synced_at.
function healthSyncIntervalOf(profile) {
  const v = parseInt(profile.getString("health_sync_interval"), 10);
  return isNaN(v) || v < 0 ? 1440 : v;
}

// Body stats the HR→kcal (Keytel) formula needs. Read from Apple Health when available (the
// client passes them per-call), else the user's saved profile values, else neutral defaults.
function bodyStatsOf(profile) {
  return {
    weight_kg: profile.getFloat("body_weight_kg") || 0,
    age: Math.round(profile.getFloat("body_age")) || 0,
    sex: (profile.getString("body_sex") || "").toLowerCase(),
  };
}

// Which method turns a heart-rate window into a calorie burn: the deterministic Keytel formula
// (default) or the AI activity_estimate function. Only "ai" flips it.
function hrMethodOf(profile) {
  return profile.getString("hr_estimate_method") === "ai" ? "ai" : "formula";
}

// Keytel et al. (2005) kcal/min from heart rate, using weight (kg), age (yr), and sex. Unknown
// sex → average the male/female equations. Defaults fill missing inputs; clamped ≥ 0 (the
// regression can go slightly negative at rest-level HR).
function keytelKcalPerMin(hr, weightKg, age, sex) {
  const w = weightKg > 0 ? weightKg : 70;
  const a = age > 0 ? age : 40;
  const male = (-55.0969 + 0.6309 * hr + 0.1988 * w + 0.2017 * a) / 4.184;
  const female = (-20.4022 + 0.4472 * hr - 0.1263 * w + 0.074 * a) / 4.184;
  const s = (sex || "").toLowerCase();
  let v;
  if (s === "male" || s === "m") v = male;
  else if (s === "female" || s === "f") v = female;
  else v = (male + female) / 2;
  return Math.max(0, v);
}

// --------------------------------------------------------------- user routes

function me(e) {
  const email = identity(e);
  if (!email) {
    return e.json(401, {
      error: AUTH_MODE === "apple" ? "not authenticated (sign in required)" : "not authenticated (no auth-proxy header)",
      auth_mode: AUTH_MODE,
    });
  }
  const app = e.app;
  const profile = ensureProfile(app, email);
  const today = todayStr();
  return e.json(200, {
    email: email,
    name: profile.getString("name"),
    role: profile.getString("role"),
    isAdmin: resolveIsAdmin(app, email),
    auth_mode: AUTH_MODE,
    app_name: settingsMap(app).app_name || "Sate",
    goals: goalsOf(profile),
    track_mode: trackModeOf(profile),
    net_exercise: netExerciseOf(profile),
    health_sync: healthSyncOf(profile),
    health_sync_interval: healthSyncIntervalOf(profile),
    health_synced_at: profile.getString("health_synced_at"),
    hr_estimate_method: hrMethodOf(profile),
    body_weight_kg: profile.getFloat("body_weight_kg") || 0,
    body_age: Math.round(profile.getFloat("body_age")) || 0,
    body_sex: profile.getString("body_sex") || "",
    weight_source: profile.getString("weight_source") || "",
    height_cm: profile.getFloat("height_cm") || 0,
    weight_synced_at: profile.getString("weight_synced_at"),
    activity_level: profile.getString("activity_level") || "",
    onboarded: profile.getString("onboarded") === "yes",
    today: today,
    totals: sumTotals(dayEntries(app, email, today)),
  });
}

function logText(e) {
  const email = identity(e);
  if (!email) return e.json(401, { error: "not authenticated" });
  const app = e.app;
  ensureProfile(app, email);
  const body = e.requestInfo().body || {};
  const text = (body.text || "").toString().trim();
  if (!text) return e.json(400, { error: "text is required" });
  try {
    const r = estimate(app, "text_parse", text, null, email);
    const rec = addEntry(app, email, {
      source: "text",
      description: text,
      items: r.parsed.items,
      total: r.parsed.total,
      provider: r.provider,
      model: r.model,
    });
    return e.json(200, {
      entry: entryJSON(rec),
      note: r.parsed.note,
      in_db: r.inDb,
      totals: sumTotals(dayEntries(app, email, todayStr())),
    });
  } catch (err) {
    return e.json(502, { error: String(err.message || err) });
  }
}

// Re-estimate an existing entry using web search, then update it in place.
function webLookupEntry(e) {
  const email = identity(e);
  if (!email) return e.json(401, { error: "not authenticated" });
  const app = e.app;
  const id = e.request.pathValue("id");
  let rec;
  try {
    rec = app.findRecordById("entries", id);
  } catch (_) {
    return e.json(404, { error: "not found" });
  }
  if (rec.getString("user_email") !== email) return e.json(403, { error: "forbidden" });
  const text = rec.getString("description");
  if (!text || text === "(photo)") return e.json(400, { error: "entry has no description to search" });
  try {
    const r = webEstimate(app, text, email);
    rec.set("source", "web");
    rec.set("items", r.parsed.items);
    rec.set("kcal", r.parsed.total.kcal);
    rec.set("protein", r.parsed.total.protein);
    rec.set("carbs", r.parsed.total.carbs);
    rec.set("fat", r.parsed.total.fat);
    rec.set("fiber", num(r.parsed.total.fiber));
    rec.set("sugar", num(r.parsed.total.sugar));
    rec.set("sodium", num(r.parsed.total.sodium));
    rec.set("sat_fat", num(r.parsed.total.sat_fat));
    rec.set("provider", r.provider);
    rec.set("model", r.model);
    app.save(rec);
    return e.json(200, {
      entry: entryJSON(rec),
      note: r.parsed.note,
      totals: sumTotals(dayEntries(app, email, todayStr())),
    });
  } catch (err) {
    return e.json(502, { error: String(err.message || err) });
  }
}

// Look up a product by barcode on Open Food Facts (runtime API call — not redistributed data).
function fetchOpenFoodFacts(code) {
  const url = "https://world.openfoodfacts.org/api/v2/product/" + encodeURIComponent(code) +
    ".json?fields=product_name,brands,serving_size,serving_quantity,nutriments";
  let res;
  try {
    res = $http.send({ url: url, method: "GET",
      headers: { "User-Agent": "Sate/1.0 (self-hosted calorie app)" }, timeout: 20 });
  } catch (_) { return null; }
  if (res.statusCode >= 300 || !res.json) return null;
  const j = res.json;
  if (!j.product || j.status === 0) return null;
  const p = j.product;
  const nut = p.nutriments || {};
  const name = String(p.product_name || "").trim();
  if (!name) return null;
  const sq = Number(p.serving_quantity) || 0; // grams per serving
  const r1 = (x) => Math.round((Number(x) || 0) * 10) / 10;
  let kcal, protein, carbs, fat, fiber, sugar, sodium, sat_fat, servingDesc, servingG;
  const perServ = Number(nut["energy-kcal_serving"]);
  if (isFinite(perServ) && perServ > 0) {
    kcal = perServ;
    protein = num(nut["proteins_serving"]); carbs = num(nut["carbohydrates_serving"]); fat = num(nut["fat_serving"]);
    fiber = num(nut["fiber_serving"]); sugar = num(nut["sugars_serving"]);
    sodium = num(nut["sodium_serving"]) * 1000; sat_fat = num(nut["saturated-fat_serving"]); // OFF sodium is grams
    servingDesc = String(p.serving_size || (sq ? sq + " g" : "1 serving"));
    servingG = sq || 0;
  } else {
    const f = sq ? sq / 100 : 1;
    kcal = num(nut["energy-kcal_100g"]) * f;
    protein = num(nut["proteins_100g"]) * f; carbs = num(nut["carbohydrates_100g"]) * f; fat = num(nut["fat_100g"]) * f;
    fiber = num(nut["fiber_100g"]) * f; sugar = num(nut["sugars_100g"]) * f;
    sodium = num(nut["sodium_100g"]) * 1000 * f; sat_fat = num(nut["saturated-fat_100g"]) * f;
    servingDesc = sq ? String(p.serving_size || sq + " g") : "100 g";
    servingG = sq || 100;
  }
  if (!(kcal > 0)) return null;
  return { name: name, brand: String(p.brands || "").split(",")[0].trim(),
    serving_desc: servingDesc.slice(0, 40), serving_g: Math.round(servingG),
    kcal: Math.round(kcal), protein: r1(protein), carbs: r1(carbs), fat: r1(fat),
    fiber: r1(fiber), sugar: r1(sugar), sodium: Math.round(sodium), sat_fat: r1(sat_fat) };
}

function r1x(x) { return Math.round((Number(x) || 0) * 10) / 10; }

// Barcode-lookup source credentials (stored in settings; all optional).
function lookupCfg(app) {
  const s = settingsMap(app);
  return {
    usdaKey: (s.usda_api_key || "").trim(),
    nixId: (s.nutritionix_app_id || "").trim(),
    nixKey: (s.nutritionix_app_key || "").trim(),
    fsId: (s.fatsecret_client_id || "").trim(),
    fsSecret: (s.fatsecret_client_secret || "").trim(),
    // Identity-only sources (name/brand, no nutrition) — see barcodeIdentifyOnline.
    upcKey: (s.upcitemdb_key || "").trim(),
    goUpcKey: (s.go_upc_key || "").trim(),
    barcodeLookupKey: (s.barcode_lookup_key || "").trim(),
  };
}

function normUpc(s) { return String(s || "").replace(/^0+/, ""); }

// USDA FoodData Central Branded search by UPC (free key or the shared DEMO_KEY; public domain).
function fetchUSDA(code, apiKey) {
  const key = apiKey || "DEMO_KEY";
  const url = "https://api.nal.usda.gov/fdc/v1/foods/search?api_key=" + encodeURIComponent(key) +
    "&dataType=Branded&pageSize=10&query=" + encodeURIComponent(code);
  let res;
  try { res = $http.send({ url: url, method: "GET", timeout: 20 }); } catch (_) { return null; }
  if (res.statusCode >= 300 || !res.json) return null; // incl. 429 OVER_RATE_LIMIT → skip gracefully
  const foods = res.json.foods || [];
  let hit = null;
  for (const f of foods) { if (normUpc(f.gtinUpc) === normUpc(code)) { hit = f; break; } }
  if (!hit) return null;
  const sg = Number(hit.servingSize) || 0;
  const ln = hit.labelNutrients || {};
  const lv = (o) => (o && isFinite(o.value)) ? Number(o.value) : 0;
  // Prefer the Nutrition-Facts label values (already per serving)...
  let kcal = lv(ln.calories), protein = lv(ln.protein), carbs = lv(ln.carbohydrates), fat = lv(ln.fat);
  let fiber = lv(ln.fiber), sugar = lv(ln.sugars), sodium = lv(ln.sodium), sat_fat = lv(ln.saturatedFat);
  // ...else fall back to the per-100g foodNutrients array scaled by the serving weight.
  if (!(kcal > 0)) {
    const per = {};
    for (const n of (hit.foodNutrients || [])) {
      const id = String(n.nutrientId || n.nutrientNumber || "");
      const v = Number(n.value);
      if (!isFinite(v)) continue;
      if ((id === "1008" || id === "208" || id === "2048" || id === "2047") && per.kcal === undefined) per.kcal = v;
      else if (id === "1003" || id === "203") per.protein = v;
      else if (id === "1004" || id === "204") per.fat = v;
      else if (id === "1005" || id === "205") per.carbs = v;
      else if (id === "1079" || id === "291") per.fiber = v;
      else if (id === "2000" || id === "269") per.sugar = v;
      else if (id === "1093" || id === "307") per.sodium = v; // mg per 100g
      else if (id === "1258" || id === "606") per.sat_fat = v;
    }
    if (per.kcal > 0) {
      const f = sg ? sg / 100 : 1;
      kcal = per.kcal * f; protein = (per.protein || 0) * f; carbs = (per.carbs || 0) * f; fat = (per.fat || 0) * f;
      fiber = (per.fiber || 0) * f; sugar = (per.sugar || 0) * f; sodium = (per.sodium || 0) * f; sat_fat = (per.sat_fat || 0) * f;
    }
  }
  if (!(kcal > 0)) return null;
  const servingG = sg || 100;
  const sdesc = sg ? (hit.householdServingFullText || (sg + " " + (hit.servingSizeUnit || "g"))) : "100 g";
  return { name: String(hit.description || "").trim().slice(0, 58),
    brand: String(hit.brandName || hit.brandOwner || "").trim().slice(0, 30),
    serving_desc: String(sdesc).slice(0, 40), serving_g: Math.round(servingG),
    kcal: Math.round(kcal), protein: r1x(protein), carbs: r1x(carbs), fat: r1x(fat),
    fiber: r1x(fiber), sugar: r1x(sugar), sodium: Math.round(sodium), sat_fat: r1x(sat_fat) };
}

// Nutritionix UPC item lookup (BYO app id/key; best US branded + restaurant coverage).
function fetchNutritionix(code, appId, appKey) {
  if (!appId || !appKey) return null;
  const url = "https://trackapi.nutritionix.com/v2/search/item?upc=" + encodeURIComponent(code);
  let res;
  try { res = $http.send({ url: url, method: "GET",
    headers: { "x-app-id": appId, "x-app-key": appKey }, timeout: 20 }); } catch (_) { return null; }
  if (res.statusCode >= 300 || !res.json) return null;
  const f = (res.json.foods || [])[0];
  if (!f) return null;
  const kcal = num(f.nf_calories);
  if (!(kcal > 0)) return null;
  const sdesc = (f.serving_qty && f.serving_unit) ? (f.serving_qty + " " + f.serving_unit) : "1 serving";
  return { name: String(f.food_name || "").trim().slice(0, 58), brand: String(f.brand_name || "").trim().slice(0, 30),
    serving_desc: String(sdesc).slice(0, 40), serving_g: Math.round(num(f.serving_weight_grams)),
    kcal: Math.round(kcal), protein: r1x(f.nf_protein), carbs: r1x(f.nf_total_carbohydrate), fat: r1x(f.nf_total_fat),
    fiber: r1x(f.nf_dietary_fiber), sugar: r1x(f.nf_sugars), sodium: Math.round(num(f.nf_sodium)), sat_fat: r1x(f.nf_saturated_fat) };
}

function b64(str) {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let out = ""; let i = 0; const b = [];
  for (let k = 0; k < str.length; k++) b.push(str.charCodeAt(k) & 0xff);
  while (i < b.length) {
    const c1 = b[i++], c2 = i < b.length ? b[i++] : NaN, c3 = i < b.length ? b[i++] : NaN;
    const e1 = c1 >> 2, e2 = ((c1 & 3) << 4) | (c2 >> 4);
    const e3 = isNaN(c2) ? 64 : (((c2 & 15) << 2) | (c3 >> 6)), e4 = isNaN(c3) ? 64 : (c3 & 63);
    out += chars[e1] + chars[e2] + (e3 === 64 ? "=" : chars[e3]) + (e4 === 64 ? "=" : chars[e4]);
  }
  return out;
}

// FatSecret OAuth2 token (client_credentials), cached in settings until near expiry.
function fatsecretToken(app, id, secret) {
  const now = Math.floor(Date.now() / 1000);
  const s = settingsMap(app);
  if (s._fs_token && Number(s._fs_token_exp || 0) > now + 30) return s._fs_token;
  let res;
  try {
    res = $http.send({ url: "https://oauth.fatsecret.com/connect/token", method: "POST",
      headers: { "Authorization": "Basic " + b64(id + ":" + secret),
        "Content-Type": "application/x-www-form-urlencoded" },
      body: "grant_type=client_credentials&scope=barcode+premier", timeout: 20 });
  } catch (_) { return ""; }
  if (res.statusCode >= 300 || !res.json || !res.json.access_token) return "";
  const tok = res.json.access_token;
  const exp = now + (Number(res.json.expires_in) || 3600);
  try {
    const col = app.findCollectionByNameOrId("settings");
    for (const kv of [["_fs_token", tok], ["_fs_token_exp", String(exp)]]) {
      let rec; try { rec = app.findFirstRecordByFilter("settings", "key = {:k}", { k: kv[0] }); }
      catch (_) { rec = new Record(col); rec.set("key", kv[0]); }
      rec.set("value", kv[1]); app.save(rec);
    }
  } catch (_) {}
  return tok;
}

// FatSecret barcode → food_id → nutrition (BYO client id/secret; Premier tier for barcode scope).
function fetchFatSecret(app, code, id, secret) {
  if (!id || !secret) return null;
  const tok = fatsecretToken(app, id, secret);
  if (!tok) return null;
  let res;
  try {
    res = $http.send({ url: "https://platform.fatsecret.com/rest/food/barcode/find-by-id/v1?format=json&barcode=" +
      encodeURIComponent(code), method: "GET", headers: { "Authorization": "Bearer " + tok }, timeout: 20 });
  } catch (_) { return null; }
  if (res.statusCode >= 300 || !res.json) return null;
  const fid = res.json.food_id && (res.json.food_id.value || res.json.food_id);
  if (!fid || String(fid) === "0") return null;
  let d;
  try {
    d = $http.send({ url: "https://platform.fatsecret.com/rest/food/v4?format=json&food_id=" + encodeURIComponent(fid),
      method: "GET", headers: { "Authorization": "Bearer " + tok }, timeout: 20 });
  } catch (_) { return null; }
  if (d.statusCode >= 300 || !d.json || !d.json.food) return null;
  const food = d.json.food;
  let serv = food.servings && food.servings.serving;
  if (Array.isArray(serv)) serv = serv[0];
  if (!serv) return null;
  const kcal = num(serv.calories);
  if (!(kcal > 0)) return null;
  return { name: String(food.food_name || "").trim().slice(0, 58), brand: String(food.brand_name || "").trim().slice(0, 30),
    serving_desc: String(serv.serving_description || "1 serving").slice(0, 40),
    serving_g: Math.round(num(serv.metric_serving_amount)),
    kcal: Math.round(kcal), protein: r1x(serv.protein), carbs: r1x(serv.carbohydrate), fat: r1x(serv.fat),
    fiber: r1x(serv.fiber), sugar: r1x(serv.sugar), sodium: Math.round(num(serv.sodium)), sat_fat: r1x(serv.saturated_fat) };
}

// ------------------------------------------------------------- identity-only barcode sources
// These return the product NAME/brand only — no trustworthy nutrition. They exist so that when
// every nutrition source misses, we can still name the product and let the AI estimate its macros
// (saved unverified, clearly an estimate). Each is optional; UPCitemdb works with no key at all.

// UPCitemdb — ~700M+ barcodes, the largest catalog. Free "trial" endpoint needs no key (shared,
// low daily limit); a paid user_key lifts the volume. Identity only.
function fetchUpcItemDb(code, key) {
  let url; const headers = { "Accept": "application/json" };
  if (key) { url = "https://api.upcitemdb.com/prod/v1/lookup?upc=" + encodeURIComponent(code);
    headers.user_key = key; headers.key_type = "3scale"; }
  else { url = "https://api.upcitemdb.com/prod/trial/lookup?upc=" + encodeURIComponent(code); }
  let res;
  try { res = $http.send({ url: url, method: "GET", headers: headers, timeout: 20 }); } catch (_) { return null; }
  if (res.statusCode >= 300 || !res.json) return null; // incl. 429 shared-trial limit → skip
  const it = (res.json.items || [])[0];
  if (!it) return null;
  const name = String(it.title || "").trim();
  if (!name) return null;
  return { name: name.slice(0, 70), brand: String(it.brand || "").trim().slice(0, 30) };
}

// Go-UPC — ~500M+ barcodes, strong international coverage. BYO API key (Bearer). Identity only.
function fetchGoUpc(code, key) {
  if (!key) return null;
  let res;
  try { res = $http.send({ url: "https://go-upc.com/api/v1/code/" + encodeURIComponent(code),
    method: "GET", headers: { "Authorization": "Bearer " + key }, timeout: 20 }); } catch (_) { return null; }
  if (res.statusCode >= 300 || !res.json || !res.json.product) return null;
  const name = String(res.json.product.name || "").trim();
  if (!name) return null;
  return { name: name.slice(0, 70), brand: String(res.json.product.brand || "").trim().slice(0, 30) };
}

// Barcode Lookup (barcodelookup.com) — BYO key, rich retail metadata. Identity only.
function fetchBarcodeLookup(code, key) {
  if (!key) return null;
  let res;
  try { res = $http.send({ url: "https://api.barcodelookup.com/v3/products?formatted=y&barcode=" +
    encodeURIComponent(code) + "&key=" + encodeURIComponent(key), method: "GET", timeout: 20 }); } catch (_) { return null; }
  if (res.statusCode >= 300 || !res.json) return null;
  const p = (res.json.products || [])[0];
  if (!p) return null;
  const name = String(p.product_name || p.title || "").trim();
  if (!name) return null;
  return { name: name.slice(0, 70), brand: String(p.brand || p.manufacturer || "").trim().slice(0, 30) };
}

// Identity fallback chain — first source to name the product wins. UPCitemdb runs even unkeyed.
function barcodeIdentifyOnline(app, code, cfg) {
  const chain = [
    { src: "upcitemdb", via: "UPCitemdb", fn: () => fetchUpcItemDb(code, cfg.upcKey) },
    { src: "go_upc", via: "Go-UPC", fn: () => fetchGoUpc(code, cfg.goUpcKey) },
    { src: "barcode_lookup", via: "Barcode Lookup", fn: () => fetchBarcodeLookup(code, cfg.barcodeLookupKey) },
  ];
  for (const step of chain) {
    let id = null;
    try { id = step.fn(); } catch (_) {}
    if (id && id.name) return { name: id.name, brand: id.brand, via: step.via, src: step.src };
  }
  return null;
}

// Online barcode fallback chain: Open Food Facts → USDA → Nutritionix → FatSecret. Prefers the
// first "complete" hit (has a real serving weight); otherwise keeps the first partial result.
function barcodeLookupOnline(app, code) {
  const cfg = lookupCfg(app);
  const chain = [
    { src: "off", via: "Open Food Facts", fn: () => fetchOpenFoodFacts(code) },
    { src: "usda", via: "USDA FoodData Central", fn: () => fetchUSDA(code, cfg.usdaKey) },
    { src: "nutritionix", via: "Nutritionix", fn: () => fetchNutritionix(code, cfg.nixId, cfg.nixKey) },
    { src: "fatsecret", via: "FatSecret", fn: () => fetchFatSecret(app, code, cfg.fsId, cfg.fsSecret) },
  ];
  let partial = null;
  for (const step of chain) {
    let food = null;
    try { food = step.fn(); } catch (_) {}
    if (!food) continue;
    const complete = food.kcal > 0 && food.serving_g > 0;
    if (complete) return { food: food, via: step.via, src: step.src };
    if (!partial) partial = { food: food, via: step.via, src: step.src };
  }
  return partial;
}

// Log a scanned barcode: local foods DB first, then the online fallback chain (cached into foods).
function logBarcode(e) {
  const email = identity(e);
  if (!email) return e.json(401, { error: "not authenticated" });
  const app = e.app;
  ensureProfile(app, email);
  const b = e.requestInfo().body || {};
  const code = String(b.barcode || "").replace(/[^0-9]/g, "");
  if (!code) return e.json(400, { error: "no barcode provided" });

  let food = null;
  try { food = app.findFirstRecordByFilter("foods", "barcode = {:c}", { c: code }); } catch (_) {}
  // EAN-13 vs UPC-12 leading-zero mismatch
  if (!food && code.length === 12) {
    try { food = app.findFirstRecordByFilter("foods", "barcode = {:c}", { c: "0" + code }); } catch (_) {}
  }

  let item, via;
  if (food) {
    via = "database";
    item = { name: food.getString("name"), brand: food.getString("brand"),
      serving_desc: food.getString("serving_desc") || "1 serving",
      kcal: food.getFloat("kcal"), protein: food.getFloat("protein"),
      carbs: food.getFloat("carbs"), fat: food.getFloat("fat"),
      fiber: food.getFloat("fiber"), sugar: food.getFloat("sugar"),
      sodium: food.getFloat("sodium"), sat_fat: food.getFloat("sat_fat") };
    try { food.set("usage_count", (food.getFloat("usage_count") || 0) + 1); app.save(food); } catch (_) {}
  } else {
    let hit = barcodeLookupOnline(app, code);
    // No authoritative nutrition anywhere → try to at least NAME the product via the identity
    // sources, then let the AI estimate its macros from that name (web-grounded if possible,
    // else a plain estimate). Saved unverified — it's an estimate, not label data.
    if (!hit) {
      const cfg = lookupCfg(app);
      let ident = null;
      try { ident = barcodeIdentifyOnline(app, code, cfg); } catch (_) {}
      if (ident) {
        const label = ident.brand ? ident.name + " " + ident.brand : ident.name;
        let est = null;
        try { est = webEstimate(app, label, email); } catch (_) {}
        if (!est || !(est.parsed && est.parsed.total && est.parsed.total.kcal > 0)) {
          try { est = estimate(app, "text_parse", label, null, email); } catch (_) {}
        }
        const t = est && est.parsed && est.parsed.total;
        if (t && t.kcal > 0) {
          hit = { food: { name: ident.name, brand: ident.brand, serving_desc: "1 serving", serving_g: 0,
            kcal: Math.round(t.kcal), protein: r1x(t.protein), carbs: r1x(t.carbs), fat: r1x(t.fat),
            fiber: r1x(t.fiber), sugar: r1x(t.sugar), sodium: Math.round(num(t.sodium)), sat_fat: r1x(t.sat_fat) },
            via: ident.via + " → AI estimate", src: "barcode-id" };
        }
      }
    }
    if (!hit) return e.json(404, { error: "Barcode not found in the database, Open Food Facts, or your configured sources.", barcode: code });
    via = hit.via;
    item = hit.food;
    const off = hit.food;
    try { // cache it so next scan is instant + it grows the DB
      const rec = new Record(app.findCollectionByNameOrId("foods"));
      rec.set("name", off.name); rec.set("brand", off.brand); rec.set("serving_desc", off.serving_desc);
      rec.set("serving_g", off.serving_g); rec.set("kcal", off.kcal); rec.set("protein", off.protein);
      rec.set("carbs", off.carbs); rec.set("fat", off.fat); rec.set("category", "");
      rec.set("fiber", num(off.fiber)); rec.set("sugar", num(off.sugar));
      rec.set("sodium", num(off.sodium)); rec.set("sat_fat", num(off.sat_fat));
      rec.set("aliases", []); rec.set("barcode", code); rec.set("source", hit.src);
      rec.set("verified", false); rec.set("usage_count", 1);
      rec.set("search", (off.name + " " + off.brand + " " + code).toLowerCase());
      rec.set("norm_key", FOODS.normKey(off.name, off.brand));
      app.save(rec);
    } catch (_) {}
  }
  const label = item.brand ? item.name + " (" + item.brand + ")" : item.name;
  const rec = addEntry(app, email, {
    source: "barcode", description: label,
    items: [{ name: item.name, qty: item.serving_desc || "1 serving",
      kcal: item.kcal, protein: item.protein, carbs: item.carbs, fat: item.fat,
      fiber: num(item.fiber), sugar: num(item.sugar), sodium: num(item.sodium), sat_fat: num(item.sat_fat) }],
    total: { kcal: item.kcal, protein: item.protein, carbs: item.carbs, fat: item.fat,
      fiber: num(item.fiber), sugar: num(item.sugar), sodium: num(item.sodium), sat_fat: num(item.sat_fat) },
    provider: "", model: "" });
  return e.json(200, { entry: entryJSON(rec), found_via: via, name: label,
    totals: sumTotals(dayEntries(app, email, todayStr())) });
}

function logPhoto(e) {
  const email = identity(e);
  if (!email) return e.json(401, { error: "not authenticated" });
  const app = e.app;
  ensureProfile(app, email);
  const body = e.requestInfo().body || {};
  let data = (body.image || "").toString();
  let mimeType = (body.mimeType || "image/jpeg").toString();
  const m = data.match(/^data:([^;]+);base64,(.*)$/);
  if (m) {
    mimeType = m[1];
    data = m[2];
  }
  if (!data) return e.json(400, { error: "image is required (base64)" });
  const note = (body.note || "").toString().trim();
  try {
    const prompt = note
      ? "Estimate the nutrition of the food in this photo. Context: " + note
      : "Estimate the nutrition of the food in this photo.";
    const r = estimate(app, "vision_estimate", prompt, { mimeType: mimeType, data: data }, email);
    const rec = addEntry(app, email, {
      source: "photo",
      description: note || "(photo)",
      items: r.parsed.items,
      total: r.parsed.total,
      provider: r.provider,
      model: r.model,
    });
    return e.json(200, {
      entry: entryJSON(rec),
      note: r.parsed.note,
      totals: sumTotals(dayEntries(app, email, todayStr())),
    });
  } catch (err) {
    return e.json(502, { error: String(err.message || err) });
  }
}

function chat(e) {
  const email = identity(e);
  if (!email) return e.json(401, { error: "not authenticated" });
  const app = e.app;
  ensureProfile(app, email);
  const body = e.requestInfo().body || {};
  const messages = Array.isArray(body.messages) ? body.messages : [];
  if (messages.length === 0) return e.json(400, { error: "messages is required" });
  const clean = messages
    .filter((m) => m && m.text)
    .map((m) => ({ role: m.role === "assistant" ? "assistant" : "user", text: String(m.text) }));
  const totals = sumTotals(dayEntries(app, email, todayStr()));
  const context =
    promptFor(app, "chat") +
    `\n\nUser's totals so far today: ${Math.round(totals.kcal)} kcal, ` +
    `${Math.round(totals.protein)}g protein, ${Math.round(totals.carbs)}g carbs, ` +
    `${Math.round(totals.fat)}g fat across ${totals.count} entries.`;
  try {
    const cfg = resolveFor(app, "chat", email);
    const reply = callAI(app, {
      provider: cfg.provider,
      apiKey: cfg.apiKey,
      baseUrl: cfg.baseUrl,
      model: cfg.model,
      system: context,
      messages: clean,
      jsonMode: false,
    });
    return e.json(200, { reply: reply });
  } catch (err) {
    return e.json(502, { error: String(err.message || err) });
  }
}

function listEntries(e) {
  const email = identity(e);
  if (!email) return e.json(401, { error: "not authenticated" });
  const app = e.app;
  const q = e.requestInfo().query || {};
  const date = (q.date || todayStr()).toString();
  const records = dayEntries(app, email, date);
  return e.json(200, { date: date, entries: records.map(entryJSON), totals: sumTotals(records) });
}

function deleteEntry(e) {
  const email = identity(e);
  if (!email) return e.json(401, { error: "not authenticated" });
  const app = e.app;
  const id = e.request.pathValue("id");
  let rec;
  try {
    rec = app.findRecordById("entries", id);
  } catch (_) {
    return e.json(404, { error: "not found" });
  }
  if (rec.getString("user_email") !== email) return e.json(403, { error: "forbidden" });
  app.delete(rec);
  return e.json(200, { deleted: id });
}

// ---------------------------------------------------------------- activity

function activityTotal(kcal) {
  return { kcal: kcal, protein: 0, carbs: 0, fat: 0, fiber: 0, sugar: 0, sodium: 0, sat_fat: 0 };
}

// POST /api/sate/log/activity — either a picked preset {activity_id, duration_min, distance}
// (burn computed from its MET) or free text {text} (burn estimated by activity_estimate).
function logActivity(e) {
  const email = identity(e);
  if (!email) return e.json(401, { error: "not authenticated" });
  const app = e.app;
  ensureProfile(app, email);
  const body = e.requestInfo().body || {};
  const durationIn = num(body.duration_min);
  const distance = num(body.distance);

  try {
    // Preset path — deterministic burn from the seeded MET, no AI call.
    if (body.activity_id) {
      let act;
      try { act = app.findRecordById("activities", String(body.activity_id)); } catch (_) { return e.json(404, { error: "unknown activity" }); }
      const minutes = durationIn > 0 ? durationIn : 30;
      const kcal = ACTS.burnFor(act, minutes);
      const name = act.getString("name");
      try { ACTS.bumpUsage(app, [act]); } catch (_) {}
      const rec = addEntry(app, email, {
        kind: "activity", source: "preset",
        description: name, duration_min: minutes, distance: distance,
        intensity: body.intensity ? String(body.intensity) : "",
        items: [{ name: name, duration_min: minutes, kcal_burned: kcal }],
        total: activityTotal(kcal),
      });
      return e.json(200, { entry: entryJSON(rec), note: "", totals: sumTotals(dayEntries(app, email, todayStr())) });
    }

    // Free-text path — AI estimate.
    const text = (body.text || "").toString().trim();
    if (!text) return e.json(400, { error: "text or activity_id is required" });
    const r = estimateActivity(app, text, email);
    const t = r.parsed.total;
    const rec = addEntry(app, email, {
      kind: "activity", source: "activity_ai",
      description: text,
      duration_min: durationIn > 0 ? durationIn : t.duration_min,
      distance: distance,
      items: r.parsed.items,
      total: activityTotal(Math.round(t.kcal_burned)),
      provider: r.provider, model: r.model,
    });
    return e.json(200, { entry: entryJSON(rec), note: r.parsed.note, totals: sumTotals(dayEntries(app, email, todayStr())) });
  } catch (err) {
    return e.json(502, { error: String(err.message || err) });
  }
}

// POST /api/sate/log/heart-rate — turn a selected heart-rate window into a named activity.
// Body: { name, start, end, duration_min, avg_hr, max_hr, min_hr,
//         weight_kg?, age?, sex?, method?, confirm_overlap? }
// Burn is estimated by the deterministic Keytel formula (default) or the AI activity_estimate
// function, per the user's hr_estimate_method preference (overridable per call via `method`).
// Guards double-counting: if the window overlaps an existing activity (e.g. an auto-imported
// workout), it returns { warning, overlap } unless confirm_overlap is set.
function logHeartRate(e) {
  const email = identity(e);
  if (!email) return e.json(401, { error: "not authenticated" });
  const app = e.app;
  const profile = ensureProfile(app, email);
  const body = e.requestInfo().body || {};

  const name = (body.name || "").toString().trim() || "Heart-rate activity";
  const avgHr = num(body.avg_hr);
  const maxHr = num(body.max_hr);
  const start = body.start ? new Date(body.start) : null;
  const end = body.end ? new Date(body.end) : null;
  let minutes = Math.round(num(body.duration_min));
  if ((!minutes || minutes <= 0) && start && end) minutes = Math.max(1, Math.round((end - start) / 60000));
  if (!minutes || minutes <= 0) return e.json(400, { error: "duration_min (or start+end) required" });
  if (!avgHr) return e.json(400, { error: "avg_hr required" });

  // Overlap guard — scan the day(s) the window touches for an activity that intersects it.
  if (!body.confirm_overlap && start && end) {
    try {
      const dates = [start.toISOString().slice(0, 10)];
      const endDate = end.toISOString().slice(0, 10);
      if (endDate !== dates[0]) dates.push(endDate);
      for (const d of dates) {
        for (const rec of dayEntries(app, email, d)) {
          if (!isActivity(rec)) continue;
          const rs = new Date(rec.getString("logged_at"));
          const re = new Date(rs.getTime() + (num(rec.getFloat("duration_min")) || 0) * 60000);
          if (rs < end && re > start) {
            return e.json(200, { warning: 'overlaps "' + rec.getString("description") + '"', overlap: true });
          }
        }
      }
    } catch (_) { /* best-effort guard; never block the log on it */ }
  }

  // Estimate the burn per the chosen method.
  const method = (body.method === "ai" || body.method === "formula") ? body.method : hrMethodOf(profile);
  let kcal = 0, provider = "", model = "", note = "";
  if (method === "ai") {
    const desc = name + " — about " + minutes + " min at avg " + Math.round(avgHr) + " bpm" +
      (maxHr ? ", peak " + Math.round(maxHr) + " bpm" : "");
    try {
      const r = estimateActivity(app, desc, email);
      kcal = Math.round(num(r.parsed.total.kcal_burned));
      provider = r.provider; model = r.model; note = r.parsed.note || "";
    } catch (err) { return e.json(502, { error: String(err.message || err) }); }
  } else {
    const st = bodyStatsOf(profile);
    const weight = num(body.weight_kg) || st.weight_kg;
    const age = num(body.age) || st.age;
    const sex = (body.sex || st.sex || "").toString();
    kcal = Math.round(keytelKcalPerMin(avgHr, weight, age, sex) * minutes);
  }
  if (kcal < 0) kcal = 0;

  const rec = addEntry(app, email, {
    kind: "activity", source: "heart_rate",
    logged_at: start ? start.toISOString() : undefined,
    description: name,
    duration_min: minutes,
    intensity: "avg " + Math.round(avgHr) + (maxHr ? " / max " + Math.round(maxHr) : "") + " bpm",
    items: [{ name: name, duration_min: minutes, kcal_burned: kcal, avg_hr: Math.round(avgHr), max_hr: Math.round(maxHr) }],
    total: activityTotal(kcal),
    provider: provider, model: model,
  });
  return e.json(200, { entry: entryJSON(rec), method: method, kcal: kcal, note: note, totals: sumTotals(dayEntries(app, email, todayStr())) });
}

// GET /api/sate/activities/search?q= — autocomplete for the Activity compose tab. Each row carries
// its per-minute burn rate so the client can preview kcal live as the user picks a duration.
function activitiesSearch(e) {
  const email = identity(e);
  if (!email) return e.json(401, { error: "not authenticated" });
  const app = e.app;
  const q = (e.requestInfo().query || {}).q || "";
  const recs = ACTS.searchByPrefix(app, q, 12);
  const rate = ACTS.KCAL_PER_MIN_PER_MET;
  return e.json(200, {
    activities: recs.map((r) => ({
      id: r.id,
      name: r.getString("name"),
      category: r.getString("category"),
      met: r.getFloat("met"),
      kcal_min: Math.round(r.getFloat("met") * rate * 10) / 10,
    })),
  });
}

// POST /api/sate/health/sync — import Apple Health workouts from the native app.
// Body: { workouts: [{ id, name, start, end, duration_min, kcal, distance_m, intensity }] }
// `id` is the HealthKit workout UUID; it dedupes re-syncs via entries.ext_id. `kcal` is
// Apple's Active Energy (trustworthy), stored as the burn. Distance is metres → miles.
function healthSync(e) {
  const email = identity(e);
  if (!email) return e.json(401, { error: "not authenticated" });
  const app = e.app;
  const profile = ensureProfile(app, email);
  const body = e.requestInfo().body || {};
  const workouts = Array.isArray(body.workouts) ? body.workouts.slice(0, 500) : [];

  let added = 0, skipped = 0;
  for (const w of workouts) {
    const ext = (w && (w.id || w.uuid) || "").toString().trim();
    if (!ext) { skipped++; continue; }
    try {
      const existing = app.findFirstRecordByFilter("entries", "user_email = {:e} && ext_id = {:x}", { e: email, x: ext });
      if (existing) { skipped++; continue; }
    } catch (_) { /* not found → import */ }
    try {
      const kcal = Math.round(num(w.kcal));
      const minutes = Math.round(num(w.duration_min));
      const name = (w.name || "Workout").toString();
      const distanceMi = num(w.distance_m) > 0 ? +(num(w.distance_m) / 1609.34).toFixed(2) : 0;
      addEntry(app, email, {
        kind: "activity", source: "health", ext_id: ext,
        logged_at: w.start || w.end,
        description: name, duration_min: minutes, distance: distanceMi,
        intensity: w.intensity ? String(w.intensity) : "",
        items: [{ name: name, duration_min: minutes, kcal_burned: kcal }],
        total: activityTotal(kcal),
      });
      added++;
    } catch (err) { skipped++; }
  }

  // Reaching this endpoint means Health is connected; keep the flag in sync and stamp the
  // sync time so the client's launch throttle can tell how long it's been.
  const syncedAt = new Date().toISOString();
  profile.set("health_synced_at", syncedAt);
  if (!healthSyncOf(profile)) profile.set("health_sync", "on");
  app.save(profile);
  return e.json(200, { added: added, skipped: skipped, synced_at: syncedAt, totals: sumTotals(dayEntries(app, email, todayStr())) });
}

// ---------------------------------------------------------- weight tracking + goals
const LB_PER_KG = 2.2046226;
function kgToLb(kg) { return +(kg * LB_PER_KG).toFixed(1); }
function lbToKg(lb) { return lb / LB_PER_KG; }

// The newest weight measurement for a user, or null.
function latestMeasurement(app, email) {
  try {
    const r = app.findRecordsByFilter("measurements", "user_email = {:e} && weight_kg > 0", "-measured_at", 1, 0, { e: email });
    return r && r.length ? r[0] : null;
  } catch (_) { return null; }
}
function currentWeightKg(app, email, profile) {
  const l = latestMeasurement(app, email);
  if (l) return l.getFloat("weight_kg");
  return (profile || ensureProfile(app, email)).getFloat("body_weight_kg") || 0;
}

function addMeasurement(app, email, data) {
  const rec = new Record(app.findCollectionByNameOrId("measurements"));
  rec.set("user_email", email);
  rec.set("measured_at", data.measured_at ? new Date(data.measured_at).toISOString() : new Date().toISOString());
  rec.set("weight_kg", num(data.weight_kg));
  rec.set("height_cm", num(data.height_cm));
  rec.set("source", data.source || "manual");
  if (data.ext_id) rec.set("ext_id", String(data.ext_id));
  app.save(rec);
  return rec;
}

// Active weight goals with pace vs the linear start→target path. to_go_lb > 0 = still to lose;
// pace.behind_lb > 0 = behind the schedule needed to hit the target on time.
function goalsWithPace(app, email, curKg) {
  let rows = [];
  try { rows = app.findRecordsByFilter("weight_goals", "user_email = {:e}", "created", 10, 0, { e: email }); } catch (_) { rows = []; }
  const today = todayStr();
  return rows.map((r) => {
    const targetKg = r.getFloat("target_kg");
    const startKg = r.getFloat("start_kg") || curKg;
    const startDate = r.getString("start_date") || today;
    const targetDate = r.getString("target_date");
    let pace = null;
    const t0 = Date.parse(startDate + "T00:00:00Z"), t1 = Date.parse(targetDate + "T00:00:00Z"), tn = Date.parse(today + "T00:00:00Z");
    if (t1 > t0 && curKg > 0) {
      const frac = Math.min(1, Math.max(0, (tn - t0) / (t1 - t0)));
      const expectedKg = startKg + (targetKg - startKg) * frac;
      // "behind" = on the wrong side of where you should be by now, in the goal's direction.
      const behindKg = targetKg < startKg ? curKg - expectedKg : expectedKg - curKg;
      pace = { behind_lb: +(behindKg * LB_PER_KG).toFixed(1), on_track: behindKg <= 0.25 };
    }
    return {
      id: r.id,
      target_lb: kgToLb(targetKg),
      target_date: targetDate,
      start_lb: startKg > 0 ? kgToLb(startKg) : 0,
      start_date: startDate,
      to_go_lb: curKg > 0 && targetKg > 0 ? +((curKg - targetKg) * LB_PER_KG).toFixed(1) : 0,
      pace: pace,
    };
  });
}

// POST /api/sate/weight/log — manual measurement. Body { weight_kg, height_cm?, measured_at? }.
function weightLog(e) {
  const email = identity(e);
  if (!email) return e.json(401, { error: "not authenticated" });
  const app = e.app;
  const profile = ensureProfile(app, email);
  const body = e.requestInfo().body || {};
  const kg = num(body.weight_kg), heightCm = num(body.height_cm);
  if (!(kg > 0) && !(heightCm > 0)) return e.json(400, { error: "weight_kg or height_cm required" });
  const rec = addMeasurement(app, email, { weight_kg: kg, height_cm: heightCm, source: "manual", measured_at: body.measured_at });
  // A manual log is "now" → refresh the current-weight scalars used elsewhere (Keytel HR).
  if (kg > 0) profile.set("body_weight_kg", kg);
  if (heightCm > 0) profile.set("height_cm", heightCm);
  app.save(profile);
  return e.json(200, { ok: true, id: rec.id });
}

// POST /api/sate/weight/sync — Apple Health body-mass import (native). Body { weights:[{id,date,kg}] }.
function weightSync(e) {
  const email = identity(e);
  if (!email) return e.json(401, { error: "not authenticated" });
  const app = e.app;
  const profile = ensureProfile(app, email);
  const body = e.requestInfo().body || {};
  const weights = Array.isArray(body.weights) ? body.weights.slice(0, 2000) : [];
  let added = 0, skipped = 0;
  for (const w of weights) {
    const ext = (w && (w.id || w.uuid) || "").toString().trim();
    const kg = num(w.kg);
    if (!ext || !(kg > 0)) { skipped++; continue; }
    try {
      const existing = app.findFirstRecordByFilter("measurements", "user_email = {:e} && ext_id = {:x}", { e: email, x: ext });
      if (existing) { skipped++; continue; }
    } catch (_) { /* not found → import */ }
    try { addMeasurement(app, email, { weight_kg: kg, source: "health", ext_id: ext, measured_at: w.date }); added++; }
    catch (_) { skipped++; }
  }
  const latest = latestMeasurement(app, email);
  if (latest) profile.set("body_weight_kg", latest.getFloat("weight_kg"));
  const syncedAt = new Date().toISOString();
  profile.set("weight_synced_at", syncedAt);
  if (profile.getString("weight_source") !== "health") profile.set("weight_source", "health");
  app.save(profile);
  return e.json(200, { added: added, skipped: skipped, synced_at: syncedAt });
}

// GET /api/sate/weight?range=day|week|month|year — series + current + goals-with-pace for the Weight tab.
function weightGet(e) {
  const email = identity(e);
  if (!email) return e.json(401, { error: "not authenticated" });
  const app = e.app;
  const profile = ensureProfile(app, email);
  const range = ((e.requestInfo().query || {}).range || "month").toString();
  const win = periodWindow(range);
  let rows = [];
  try {
    rows = app.findRecordsByFilter("measurements",
      "user_email = {:e} && weight_kg > 0 && measured_at >= {:s} && measured_at < {:en}",
      "measured_at", 2000, 0, { e: email, s: win.start, en: win.end });
  } catch (_) { rows = []; }
  const series = rows.map((r) => ({ t: r.getString("measured_at"), weight_lb: kgToLb(r.getFloat("weight_kg")) }));
  const curKg = currentWeightKg(app, email, profile);
  return e.json(200, {
    range: range,
    series: series,
    current_lb: curKg > 0 ? kgToLb(curKg) : 0,
    height_cm: profile.getFloat("height_cm") || 0,
    weight_source: profile.getString("weight_source") || "",
    goals: goalsWithPace(app, email, curKg),
  });
}

function weightGoalsList(e) {
  const email = identity(e);
  if (!email) return e.json(401, { error: "not authenticated" });
  const app = e.app;
  return e.json(200, { goals: goalsWithPace(app, email, currentWeightKg(app, email)) });
}

// POST /api/sate/weight/goals — { target_lb, target_date }. Caps at 3 active per user.
function weightGoalSet(e) {
  const email = identity(e);
  if (!email) return e.json(401, { error: "not authenticated" });
  const app = e.app;
  const body = e.requestInfo().body || {};
  const targetLb = num(body.target_lb);
  const targetDate = (body.target_date || "").toString().slice(0, 10);
  if (!(targetLb > 0)) return e.json(400, { error: "target_lb required" });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(targetDate)) return e.json(400, { error: "target_date (YYYY-MM-DD) required" });
  let count = 0;
  try { count = app.findRecordsByFilter("weight_goals", "user_email = {:e}", "created", 10, 0, { e: email }).length; } catch (_) {}
  if (count >= 3) return e.json(400, { error: "You can track up to 3 weight goals — remove one first." });
  const curKg = currentWeightKg(app, email);
  const rec = new Record(app.findCollectionByNameOrId("weight_goals"));
  rec.set("user_email", email);
  rec.set("target_kg", lbToKg(targetLb));
  rec.set("target_date", targetDate);
  rec.set("start_kg", curKg);
  rec.set("start_date", todayStr());
  app.save(rec);
  return e.json(200, { ok: true, id: rec.id });
}

function weightGoalDelete(e) {
  const email = identity(e);
  if (!email) return e.json(401, { error: "not authenticated" });
  const app = e.app;
  const id = e.request.pathValue("id");
  let rec;
  try { rec = app.findRecordById("weight_goals", id); } catch (_) { return e.json(404, { error: "not found" }); }
  if (rec.getString("user_email") !== email) return e.json(403, { error: "forbidden" });
  app.delete(rec);
  return e.json(200, { deleted: id });
}

// ---------------------------------------------------- nutrition plan + coach
// Average intake per logged day over the last `days` (food entries only).
function recentIntake(app, email, days) {
  const now = new Date();
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
  const start = new Date(end); start.setUTCDate(start.getUTCDate() - days);
  const iso = (d) => d.toISOString().slice(0, 10) + " 00:00:00.000Z";
  let rows = [];
  try { rows = rangeEntries(app, email, iso(start), iso(end)); } catch (_) { rows = []; }
  const byDay = {};
  for (const r of rows) {
    if (isActivity(r)) continue;
    const day = r.getString("logged_at").slice(0, 10);
    const b = byDay[day] || (byDay[day] = { kcal: 0, protein: 0, carbs: 0, fat: 0 });
    b.kcal += num(r.getFloat("kcal")); b.protein += num(r.getFloat("protein"));
    b.carbs += num(r.getFloat("carbs")); b.fat += num(r.getFloat("fat"));
  }
  const ds = Object.keys(byDay);
  if (!ds.length) return { days: 0 };
  const s = ds.reduce((a, d) => ({ kcal: a.kcal + byDay[d].kcal, protein: a.protein + byDay[d].protein, carbs: a.carbs + byDay[d].carbs, fat: a.fat + byDay[d].fat }), { kcal: 0, protein: 0, carbs: 0, fat: 0 });
  const n = ds.length;
  return { days: n, kcal: Math.round(s.kcal / n), protein: Math.round(s.protein / n), carbs: Math.round(s.carbs / n), fat: Math.round(s.fat / n) };
}

// Assemble the nutrition-engine input from the profile + saved goals, with optional overrides
// (used by onboarding to preview targets from not-yet-saved stats/goals).
function buildPlanInput(app, email, profile, ov) {
  ov = ov || {};
  let goals = [];
  try {
    goals = app.findRecordsByFilter("weight_goals", "user_email = {:e}", "target_date", 5, 0, { e: email })
      .map((r) => ({ target_kg: r.getFloat("target_kg"), target_date: r.getString("target_date") }));
  } catch (_) {}
  if (Array.isArray(ov.goals)) goals = ov.goals;
  return {
    name: (profile.getString("name") || "").split(/\s+/)[0] || "",
    curKg: ov.curKg || currentWeightKg(app, email, profile),
    cm: ov.cm || (profile.getFloat("height_cm") || 0),
    age: ov.age || (Math.round(profile.getFloat("body_age")) || 0),
    sex: ov.sex || (profile.getString("body_sex") || ""),
    activity: ov.activity || (profile.getString("activity_level") || ""),
    method: ov.method || trackModeOf(profile),
    goals: goals,
    today: todayStr(),
  };
}

// POST /api/sate/plan/compute — deterministic BMR/TDEE/targets/warnings (optional overrides).
function planCompute(e) {
  const email = identity(e);
  if (!email) return e.json(401, { error: "not authenticated" });
  const app = e.app;
  const profile = ensureProfile(app, email);
  const body = e.requestInfo().body || {};
  const ov = {};
  if (num(body.weight_lb) > 0) ov.curKg = lbToKg(num(body.weight_lb));
  if (num(body.height_cm) > 0) ov.cm = num(body.height_cm);
  if (num(body.age) > 0) ov.age = num(body.age);
  if (body.sex) ov.sex = String(body.sex);
  if (body.activity) ov.activity = String(body.activity);
  if (body.method) ov.method = String(body.method);
  if (Array.isArray(body.goals)) {
    ov.goals = body.goals
      .map((g) => ({ target_kg: lbToKg(num(g.target_lb)), target_date: String(g.target_date || "").slice(0, 10) }))
      .filter((g) => g.target_kg > 0 && /^\d{4}-\d{2}-\d{2}$/.test(g.target_date));
  }
  const plan = N.computePlan(buildPlanInput(app, email, profile, ov));
  return e.json(200, plan);
}

// POST /api/sate/nutritionist — AI coach. Body { mode:"plan"|"chat", message? }. Grounded on the
// deterministic plan so advice matches the app's numbers. Routed through callAI (limits+usage).
function nutritionist(e) {
  const email = identity(e);
  if (!email) return e.json(401, { error: "not authenticated" });
  const app = e.app;
  const profile = ensureProfile(app, email);
  const body = e.requestInfo().body || {};
  const mode = body.mode === "chat" ? "chat" : "plan";
  const inp = buildPlanInput(app, email, profile, {});
  const plan = N.computePlan(inp);
  const context = N.contextText(inp, plan, recentIntake(app, email, 7));
  const userMsg = mode === "chat"
    ? (String(body.message || "").trim() || "How am I doing toward my goals?")
    : "Give me my starting plan: the weekly rate and specific daily calorie + macro targets to reach my goal(s), flag anything unrealistic with a concrete realistic alternative, and 2-3 first steps.";
  const cfg = resolveFor(app, "nutritionist", email);
  let reply;
  try {
    reply = callAI(app, {
      provider: cfg.provider, apiKey: cfg.apiKey, baseUrl: cfg.baseUrl, model: cfg.model,
      system: promptFor(app, "nutritionist"),
      messages: [{ role: "user", text: "CONTEXT:\n" + context + "\n\n" + userMsg }],
    });
  } catch (err) { return e.json(502, { error: String(err.message || err) }); }
  return e.json(200, { reply: reply, plan: { bmr: plan.bmr, tdee: plan.tdee, targets: plan.targets, warnings: plan.warnings } });
}

// GET /api/sate/stats?range=day|week|month|year — server-side rollup for the dashboard.
function statsRange(e) {
  const email = identity(e);
  if (!email) return e.json(401, { error: "not authenticated" });
  const app = e.app;
  const q = e.requestInfo().query || {};
  const range = ["day", "week", "month", "year"].indexOf((q.range || "").toString()) !== -1 ? q.range.toString() : "day";
  const w = periodWindow(range);
  const recs = rangeEntries(app, email, w.start, w.end);

  const nutrition = [];
  const activity = [];
  for (const r of recs) (isActivity(r) ? activity : nutrition).push(r);

  const intake = sumTotals(nutrition);
  let burn = 0, minutes = 0;
  for (const r of activity) { burn += r.getFloat("kcal"); minutes += r.getFloat("duration_min"); }

  // Trend series bucketed by day (week/month) or month (year).
  const bucketOf = (r) => {
    const s = r.getString("logged_at"); // "YYYY-MM-DD HH:MM..."
    return w.bucket === "month" ? s.slice(0, 7) : s.slice(0, 10);
  };
  const buckets = {};
  const order = [];
  for (const r of recs) {
    const k = bucketOf(r);
    if (!buckets[k]) { buckets[k] = { bucket: k, in_kcal: 0, out_kcal: 0 }; order.push(k); }
    if (isActivity(r)) buckets[k].out_kcal += r.getFloat("kcal");
    else buckets[k].in_kcal += r.getFloat("kcal");
  }
  order.sort();
  const series = order.map((k) => buckets[k]);

  const p = ensureProfile(app, email);
  const goals = goalsOf(p);
  const activeDays = new Set(recs.map(bucketOf)).size || 1;

  return e.json(200, {
    range: range,
    days: w.days,                                // calendar days in the window (goal scaling)
    in: intake,                                  // kcal + 8 nutrients + count, summed over window
    out: { kcal: Math.round(burn), minutes: Math.round(minutes), workouts: activity.length },
    avg_in_kcal: Math.round(intake.kcal / activeDays),
    avg_out_kcal: Math.round(burn / activeDays),
    goals: goals,
    net_exercise: netExerciseOf(p),
    series: series,
  });
}

// PATCH /api/sate/entries/{id} — edit an existing entry.
//   { scale: 0.5 }                → scale nutrients (and activity duration/distance) proportionally
//   { kcal, duration_min, distance, intensity, description }  → direct field overrides
//   { re_estimate: true, text }   → re-run the AI on new text and replace the estimate
function updateEntry(e) {
  const email = identity(e);
  if (!email) return e.json(401, { error: "not authenticated" });
  const app = e.app;
  const id = e.request.pathValue("id");
  let rec;
  try { rec = app.findRecordById("entries", id); } catch (_) { return e.json(404, { error: "not found" }); }
  if (rec.getString("user_email") !== email) return e.json(403, { error: "forbidden" });
  const activity = isActivity(rec);
  const b = e.requestInfo().body || {};

  try {
    if (b.re_estimate && (b.text || "").toString().trim()) {
      const text = b.text.toString().trim();
      if (activity) {
        const r = estimateActivity(app, text, email);
        const t = r.parsed.total;
        rec.set("description", text);
        rec.set("items", r.parsed.items);
        rec.set("duration_min", num(t.duration_min));
        rec.set("kcal", Math.round(t.kcal_burned));
        rec.set("source", "activity_ai");
      } else {
        const r = estimate(app, "text_parse", text, null, email);
        rec.set("description", text);
        rec.set("items", r.parsed.items);
        for (const k of ["kcal", "protein", "carbs", "fat", "fiber", "sugar", "sodium", "sat_fat"]) rec.set(k, num(r.parsed.total[k]));
        rec.set("source", "text");
      }
    } else if (num(b.scale) > 0 && num(b.scale) !== 1) {
      const s = num(b.scale);
      const NUTR = ["kcal", "protein", "carbs", "fat", "fiber", "sugar", "sodium", "sat_fat"];
      for (const k of NUTR) rec.set(k, +(rec.getFloat(k) * s).toFixed(2));
      if (activity) {
        rec.set("duration_min", +(rec.getFloat("duration_min") * s).toFixed(1));
        if (rec.getFloat("distance")) rec.set("distance", +(rec.getFloat("distance") * s).toFixed(2));
      }
      const items = readItems(rec).map((it) => {
        const o = Object.assign({}, it);
        for (const k of NUTR.concat(["kcal_burned"])) if (typeof o[k] === "number") o[k] = +(o[k] * s).toFixed(2);
        return o;
      });
      rec.set("items", items);
    }

    // Direct overrides (applied after scale/re-estimate).
    if (b.kcal !== undefined) rec.set("kcal", num(b.kcal));
    if (b.duration_min !== undefined) rec.set("duration_min", num(b.duration_min));
    if (b.distance !== undefined) rec.set("distance", num(b.distance));
    if (b.intensity !== undefined) rec.set("intensity", String(b.intensity));
    if (b.description !== undefined) rec.set("description", String(b.description));

    app.save(rec);
    return e.json(200, { entry: entryJSON(rec), totals: sumTotals(dayEntries(app, email, todayStr())) });
  } catch (err) {
    return e.json(502, { error: String(err.message || err) });
  }
}

// ---- admin: activities table (mirrors admin/foods) ----
function activityJSON(r) {
  return {
    id: r.id, name: r.getString("name"), category: r.getString("category"),
    met: r.getFloat("met"), aliases: ACTS.readAliases(r), source: r.getString("source"),
    verified: r.getBool("verified"), usage_count: r.getFloat("usage_count"),
  };
}
function adminGetActivities(e) {
  const a = requireAdmin(e);
  if (!a.ok) return a.res;
  const app = e.app;
  const q = e.requestInfo().query || {};
  const recs = ACTS.searchByPrefix(app, q.q || "", 200);
  return e.json(200, { activities: recs.map(activityJSON), total: app.countRecords("activities") });
}
function adminPutActivity(e) {
  const a = requireAdmin(e);
  if (!a.ok) return a.res;
  const app = e.app;
  const b = e.requestInfo().body || {};
  const name = String(b.name || "").trim();
  if (!name) return e.json(400, { error: "name is required" });
  let rec;
  if (b.id) { try { rec = app.findRecordById("activities", String(b.id)); } catch (_) { return e.json(404, { error: "not found" }); } }
  else { rec = new Record(app.findCollectionByNameOrId("activities")); rec.set("source", "user"); rec.set("usage_count", 0); }
  const aliases = Array.isArray(b.aliases) ? b.aliases : String(b.aliases || "").split(",").map((s) => s.trim()).filter(Boolean);
  rec.set("name", name);
  rec.set("category", String(b.category || ""));
  rec.set("met", num(b.met));
  rec.set("aliases", aliases);
  rec.set("verified", !!b.verified);
  rec.set("search", (name + " " + aliases.join(" ")).toLowerCase());
  rec.set("norm_key", ACTS.normKey(name));
  app.save(rec);
  return e.json(200, { activity: activityJSON(rec) });
}
function adminDeleteActivity(e) {
  const a = requireAdmin(e);
  if (!a.ok) return a.res;
  const app = e.app;
  try { app.delete(app.findRecordById("activities", e.request.pathValue("id"))); } catch (_) { return e.json(404, { error: "not found" }); }
  return e.json(200, { ok: true });
}

function setGoals(e) {
  const email = identity(e);
  if (!email) return e.json(401, { error: "not authenticated" });
  const app = e.app;
  const profile = ensureProfile(app, email);
  const body = e.requestInfo().body || {};
  for (const k of ["goal_kcal", "goal_protein", "goal_carbs", "goal_fat", "goal_sodium"]) {
    if (body[k] !== undefined && body[k] !== null && body[k] !== "") {
      profile.set(k, Number(body[k]) || 0);
    }
  }
  if (body.track_mode !== undefined && TRACK_MODES.indexOf(String(body.track_mode)) !== -1) {
    profile.set("track_mode", String(body.track_mode));
  }
  if (body.net_exercise !== undefined) {
    profile.set("net_exercise", body.net_exercise ? "on" : "off");
  }
  if (body.health_sync !== undefined) {
    profile.set("health_sync", body.health_sync ? "on" : "off");
  }
  if (body.health_sync_interval !== undefined) {
    const v = parseInt(body.health_sync_interval, 10);
    if (!isNaN(v) && v >= 0) profile.set("health_sync_interval", String(v));
  }
  if (body.hr_estimate_method !== undefined) {
    profile.set("hr_estimate_method", body.hr_estimate_method === "ai" ? "ai" : "formula");
  }
  if (body.body_weight_kg !== undefined && body.body_weight_kg !== null && body.body_weight_kg !== "") {
    profile.set("body_weight_kg", Number(body.body_weight_kg) || 0);
  }
  if (body.body_age !== undefined && body.body_age !== null && body.body_age !== "") {
    profile.set("body_age", Number(body.body_age) || 0);
  }
  if (body.body_sex !== undefined) {
    const s = String(body.body_sex).toLowerCase();
    profile.set("body_sex", (s === "male" || s === "female") ? s : "");
  }
  if (body.weight_source !== undefined) {
    const s = String(body.weight_source);
    profile.set("weight_source", (s === "health" || s === "manual") ? s : "");
  }
  if (body.height_cm !== undefined && body.height_cm !== null && body.height_cm !== "") {
    profile.set("height_cm", Number(body.height_cm) || 0);
  }
  if (body.activity_level !== undefined) {
    const a = String(body.activity_level);
    profile.set("activity_level", N.ACTIVITY_MULT[a] ? a : "");
  }
  if (body.onboarded !== undefined) {
    profile.set("onboarded", body.onboarded ? "yes" : "");
  }
  if (body.name !== undefined) {
    profile.set("name", String(body.name).slice(0, 60).trim());
  }
  app.save(profile);
  return e.json(200, {
    goals: goalsOf(profile), track_mode: trackModeOf(profile), net_exercise: netExerciseOf(profile),
    health_sync: healthSyncOf(profile), health_sync_interval: healthSyncIntervalOf(profile),
    hr_estimate_method: hrMethodOf(profile),
    body_weight_kg: profile.getFloat("body_weight_kg") || 0,
    body_age: Math.round(profile.getFloat("body_age")) || 0,
    body_sex: profile.getString("body_sex") || "",
    weight_source: profile.getString("weight_source") || "",
    height_cm: profile.getFloat("height_cm") || 0,
    activity_level: profile.getString("activity_level") || "",
    onboarded: profile.getString("onboarded") === "yes",
  });
}

function daySummary(e) {
  const email = identity(e);
  if (!email) return e.json(401, { error: "not authenticated" });
  const app = e.app;
  const q = e.requestInfo().query || {};
  const date = (q.date || todayStr()).toString();
  const records = dayEntries(app, email, date);
  const totals = sumTotals(records);
  if (records.length === 0)
    return e.json(200, { summary: "Nothing logged yet for this day.", totals: totals });
  const profile = ensureProfile(app, email);
  const lines = records
    .map((r) => `- ${r.getString("description")}: ${Math.round(r.getFloat("kcal"))} kcal`)
    .join("\n");
  const userText =
    `Date: ${date}\nGoal: ${profile.getFloat("goal_kcal") || "not set"} kcal/day\n` +
    `Entries:\n${lines}\n\n` +
    `Totals: ${Math.round(totals.kcal)} kcal, ${Math.round(totals.protein)}g protein, ` +
    `${Math.round(totals.carbs)}g carbs, ${Math.round(totals.fat)}g fat.`;
  try {
    const cfg = resolveFor(app, "daily_summary", email);
    const reply = callAI(app, {
      provider: cfg.provider,
      apiKey: cfg.apiKey,
      baseUrl: cfg.baseUrl,
      model: cfg.model,
      system: promptFor(app, "daily_summary"),
      messages: [{ role: "user", text: userText }],
      jsonMode: false,
    });
    return e.json(200, { summary: reply, totals: totals });
  } catch (err) {
    return e.json(502, { error: String(err.message || err) });
  }
}

// -------------------------------------------------------------- admin routes

function requireAdmin(e) {
  const email = identity(e);
  if (!email) return { ok: false, res: e.json(401, { error: "not authenticated" }) };
  if (!resolveIsAdmin(e.app, email)) return { ok: false, res: e.json(403, { error: "admin only" }) };
  return { ok: true, email: email };
}

function providerRecord(app, name) {
  try {
    return app.findFirstRecordByFilter("providers", "name = {:n}", { n: name });
  } catch (_) {
    return null;
  }
}

function adminGetProviders(e) {
  const a = requireAdmin(e);
  if (!a.ok) return a.res;
  const app = e.app;
  const out = app.findAllRecords("providers").map((r) => {
    const enc = r.getString("api_key_enc");
    let hint = "";
    try {
      hint = enc ? F.redact(F.decryptKey(enc)) : "";
    } catch (_) {
      hint = "(unreadable — check APP_ENCRYPTION_KEY)";
    }
    return {
      name: r.getString("name"),
      enabled: r.getBool("enabled"),
      base_url: r.getString("base_url"),
      key_set: enc.length > 0,
      key_hint: hint,
    };
  });
  return e.json(200, { providers: out });
}

function adminPutProvider(e) {
  const a = requireAdmin(e);
  if (!a.ok) return a.res;
  const app = e.app;
  const body = e.requestInfo().body || {};
  const name = (body.name || "").toString();
  if (VALID_PROVIDERS.indexOf(name) === -1) return e.json(400, { error: "invalid provider name" });
  let rec = providerRecord(app, name);
  if (!rec) {
    rec = new Record(app.findCollectionByNameOrId("providers"));
    rec.set("name", name);
  }
  if (body.api_key !== undefined && body.api_key !== null && String(body.api_key).length > 0) {
    rec.set("api_key_enc", F.encryptKey(String(body.api_key)));
  }
  if (body.enabled !== undefined) rec.set("enabled", !!body.enabled);
  if (body.base_url !== undefined) rec.set("base_url", String(body.base_url));
  app.save(rec);
  return e.json(200, { ok: true });
}

// Live model list for a provider (used to populate the admin model pickers).
function adminGetModels(e) {
  const a = requireAdmin(e);
  if (!a.ok) return a.res;
  const app = e.app;
  const q = e.requestInfo().query || {};
  const name = (q.provider || "").toString();
  if (VALID_PROVIDERS.indexOf(name) === -1) return e.json(400, { error: "invalid provider" });
  const rec = providerRecord(app, name);
  const enc = rec ? rec.getString("api_key_enc") : "";
  if (!enc) return e.json(200, { provider: name, models: [], note: "no API key set" });
  try {
    const models = P.listModels({
      provider: name,
      apiKey: F.decryptKey(enc),
      baseUrl: rec.getString("base_url") || "",
    });
    return e.json(200, { provider: name, models: models });
  } catch (err) {
    return e.json(200, { provider: name, models: [], error: String(err.message || err) });
  }
}

function adminGetFunctions(e) {
  const a = requireAdmin(e);
  if (!a.ok) return a.res;
  const app = e.app;
  const out = app.findAllRecords("function_config").map((r) => ({
    fn: r.getString("fn"),
    provider: r.getString("provider"),
    model: r.getString("model"),
    enabled: r.getBool("enabled"),
  }));
  return e.json(200, { functions: out });
}

function adminPutFunction(e) {
  const a = requireAdmin(e);
  if (!a.ok) return a.res;
  const app = e.app;
  const body = e.requestInfo().body || {};
  const fn = (body.fn || "").toString();
  if (F.FUNCTIONS.indexOf(fn) === -1) return e.json(400, { error: "invalid function" });
  let rec;
  try {
    rec = app.findFirstRecordByFilter("function_config", "fn = {:fn}", { fn: fn });
  } catch (_) {
    rec = new Record(app.findCollectionByNameOrId("function_config"));
    rec.set("fn", fn);
  }
  if (body.provider !== undefined) {
    if (VALID_PROVIDERS.indexOf(String(body.provider)) === -1)
      return e.json(400, { error: "invalid provider" });
    rec.set("provider", String(body.provider));
  }
  if (body.model !== undefined) rec.set("model", String(body.model));
  if (body.enabled !== undefined) rec.set("enabled", !!body.enabled);
  app.save(rec);
  return e.json(200, { ok: true });
}

// ---- AI usage / limits / prices — per-provider caps by token count or $ budget ----

// This month's per-provider token usage + estimated cost + configured caps.
function adminGetUsage(e) {
  const a = requireAdmin(e);
  if (!a.ok) return a.res;
  return e.json(200, { providers: AL.usageSummary(e.app, VALID_PROVIDERS) });
}

// Configured limit per provider (0 = unlimited).
function adminGetLimits(e) {
  const a = requireAdmin(e);
  if (!a.ok) return a.res;
  const app = e.app;
  const limits = VALID_PROVIDERS.map((p) => {
    const l = AL.limitFor(app, p) || { monthly_tokens: 0, usd_budget: 0, in_cap: 0, out_cap: 0 };
    return { provider: p, monthly_tokens: l.monthly_tokens, usd_budget: l.usd_budget, in_cap: l.in_cap, out_cap: l.out_cap };
  });
  return e.json(200, { limits: limits });
}

function adminSetLimit(e) {
  const a = requireAdmin(e);
  if (!a.ok) return a.res;
  const body = e.requestInfo().body || {};
  const provider = (body.provider || "").toString();
  if (VALID_PROVIDERS.indexOf(provider) === -1) return e.json(400, { error: "invalid provider" });
  AL.setLimit(e.app, provider, {
    monthly_tokens: body.monthly_tokens, usd_budget: body.usd_budget,
    in_cap: body.in_cap, out_cap: body.out_cap,
  });
  return e.json(200, { ok: true });
}

function adminGetPrices(e) {
  const a = requireAdmin(e);
  if (!a.ok) return a.res;
  return e.json(200, { prices: AL.pricesList(e.app) });
}

function adminSetPrice(e) {
  const a = requireAdmin(e);
  if (!a.ok) return a.res;
  const body = e.requestInfo().body || {};
  const provider = (body.provider || "").toString();
  const model = (body.model || "").toString();
  if (VALID_PROVIDERS.indexOf(provider) === -1) return e.json(400, { error: "invalid provider" });
  if (!model) return e.json(400, { error: "model required" });
  AL.setPrice(e.app, provider, model, body.in_usd, body.out_usd);
  return e.json(200, { ok: true });
}

// Instance settings: app name + default new-user goals.
function adminGetSettings(e) {
  const a = requireAdmin(e);
  if (!a.ok) return a.res;
  return e.json(200, {
    settings: settingsMap(e.app),
    env_admins: ADMINS,
    auth_mode: AUTH_MODE,
    auth_header: AUTH_MODE === "proxy" ? AUTH_HEADER : null,
  });
}

function adminPutSettings(e) {
  const a = requireAdmin(e);
  if (!a.ok) return a.res;
  const app = e.app;
  const body = e.requestInfo().body || {};
  const col = app.findCollectionByNameOrId("settings");
  for (const k of SETTING_KEYS) {
    if (body[k] === undefined) continue;
    let rec;
    try {
      rec = app.findFirstRecordByFilter("settings", "key = {:k}", { k: k });
    } catch (_) {
      rec = new Record(col);
      rec.set("key", k);
    }
    rec.set("value", String(body[k]));
    app.save(rec);
  }
  return e.json(200, { settings: settingsMap(app) });
}

function adminGetUsers(e) {
  const a = requireAdmin(e);
  if (!a.ok) return a.res;
  const app = e.app;
  const seen = {};
  const out = app.findAllRecords("profiles").map((r) => {
    const email = r.getString("email");
    seen[email] = true;
    return {
      email: email,
      name: r.getString("name"),
      role: isEnvAdmin(email) ? "admin" : r.getString("role") || "user",
      env_admin: isEnvAdmin(email),
      ov_ai_provider: r.getString("ov_ai_provider"),
      ov_ai_model: r.getString("ov_ai_model"),
      ov_vision_provider: r.getString("ov_vision_provider"),
      ov_vision_model: r.getString("ov_vision_model"),
    };
  });
  // include env admins who haven't logged in yet
  for (const email of ADMINS) {
    if (!seen[email]) out.push({ email: email, name: email.split("@")[0], role: "admin", env_admin: true,
      ov_ai_provider: "", ov_ai_model: "", ov_vision_provider: "", ov_vision_model: "" });
  }
  return e.json(200, { users: out });
}

// Set (or clear) a user's per-category AI model overrides. Empty provider/model clears it.
function adminSetUserModels(e) {
  const a = requireAdmin(e);
  if (!a.ok) return a.res;
  const app = e.app;
  const body = e.requestInfo().body || {};
  const email = (body.email || "").toString().toLowerCase().trim();
  if (!email || email.indexOf("@") === -1) return e.json(400, { error: "valid email required" });
  let rec;
  try {
    rec = app.findFirstRecordByFilter("profiles", "email = {:e}", { e: email });
  } catch (_) {
    rec = new Record(app.findCollectionByNameOrId("profiles"));
    rec.set("email", email);
    rec.set("name", email.split("@")[0]);
    rec.set("role", isEnvAdmin(email) ? "admin" : "user");
    applyDefaultGoals(app, rec);
  }
  for (const k of ["ov_ai_provider", "ov_ai_model", "ov_vision_provider", "ov_vision_model"]) {
    if (body[k] !== undefined) rec.set(k, String(body[k] || "").trim());
  }
  app.save(rec);
  return e.json(200, { ok: true, email: email });
}

// Promote/demote a user (or pre-authorize an admin by email).
function adminSetUserRole(e) {
  const a = requireAdmin(e);
  if (!a.ok) return a.res;
  const app = e.app;
  const body = e.requestInfo().body || {};
  const email = (body.email || "").toString().toLowerCase().trim();
  const role = (body.role || "").toString();
  if (!email || email.indexOf("@") === -1) return e.json(400, { error: "valid email required" });
  if (role !== "admin" && role !== "user") return e.json(400, { error: "role must be admin or user" });
  if (isEnvAdmin(email))
    return e.json(400, { error: "this email is an env admin (ADMIN_EMAILS) and is always admin" });
  let rec;
  try {
    rec = app.findFirstRecordByFilter("profiles", "email = {:e}", { e: email });
  } catch (_) {
    rec = new Record(app.findCollectionByNameOrId("profiles"));
    rec.set("email", email);
    rec.set("name", email.split("@")[0]);
    applyDefaultGoals(app, rec);
  }
  rec.set("role", role);
  app.save(rec);
  return e.json(200, { ok: true, email: email, role: role });
}

// ---- admin: food database ----

function foodJSON(r) {
  return {
    id: r.id,
    name: r.getString("name"),
    brand: r.getString("brand"),
    serving_desc: r.getString("serving_desc"),
    serving_g: r.getFloat("serving_g"),
    kcal: r.getFloat("kcal"),
    protein: r.getFloat("protein"),
    carbs: r.getFloat("carbs"),
    fat: r.getFloat("fat"),
    category: r.getString("category"),
    aliases: FOODS.readAliases(r),
    barcode: r.getString("barcode"),
    source: r.getString("source"),
    verified: r.getBool("verified"),
    usage_count: r.getFloat("usage_count"),
  };
}

function adminGetFoods(e) {
  const a = requireAdmin(e);
  if (!a.ok) return a.res;
  const app = e.app;
  const q = e.requestInfo().query || {};
  const term = FOODS.norm(q.q || "");
  let recs;
  try {
    if (term) {
      recs = app.findRecordsByFilter("foods", "search ~ {:t}", "-verified,-usage_count", 200, 0, { t: term });
    } else {
      recs = app.findRecordsByFilter("foods", "id != ''", "-verified,name", 200, 0, {});
    }
  } catch (err) {
    return e.json(500, { error: String(err.message || err) });
  }
  let total = recs.length;
  try { total = app.countRecords("foods"); } catch (_) {}
  return e.json(200, { foods: recs.map(foodJSON), shown: recs.length, total: total });
}

// Admin: estimate nutrition to prefill the food editor WITHOUT logging. method photo|web|text.
function adminFoodEstimate(e) {
  const a = requireAdmin(e);
  if (!a.ok) return a.res;
  const app = e.app, email = identity(e);
  const b = e.requestInfo().body || {};
  const method = String(b.method || "text");
  let r, name;
  try {
    if (method === "photo") {
      let data = String(b.image || ""), mimeType = "image/jpeg";
      const m = data.match(/^data:([^;]+);base64,(.*)$/); if (m) { mimeType = m[1]; data = m[2]; }
      if (!data) return e.json(400, { error: "image required" });
      r = estimate(app, "vision_estimate", "Identify this single food or packaged product and estimate its nutrition per typical serving.", { mimeType: mimeType, data: data }, email);
      name = ((r.parsed.items || [])[0] || {}).name || "Food from photo";
    } else {
      const text = String(b.text || "").trim();
      if (!text) return e.json(400, { error: "name required" });
      r = (method === "web") ? webEstimate(app, text, email) : estimate(app, "text_parse", text, null, email);
      name = text;
    }
  } catch (err) { return e.json(502, { error: String(err.message || err) }); }
  const t = (r.parsed && r.parsed.total) || {};
  const first = ((r.parsed && r.parsed.items) || [])[0] || {};
  return e.json(200, { food: {
    name: name, serving_desc: first.qty || "1 serving",
    kcal: Math.round(t.kcal || 0), protein: Math.round(t.protein || 0),
    carbs: Math.round(t.carbs || 0), fat: Math.round(t.fat || 0),
  }, note: (r.parsed && r.parsed.note) || "" });
}

// Admin: look up a barcode's product nutrition to prefill the food editor (no logging).
function adminFoodBarcode(e) {
  const a = requireAdmin(e);
  if (!a.ok) return a.res;
  const app = e.app, email = identity(e);
  const b = e.requestInfo().body || {};
  const code = String(b.barcode || "").replace(/[^0-9]/g, "");
  if (!code) return e.json(400, { error: "no barcode" });
  const asFood = (o, via) => e.json(200, { via: via, food: {
    name: o.name || "", brand: o.brand || "", barcode: code, serving_desc: o.serving_desc || "1 serving",
    serving_g: Math.round(num(o.serving_g)), kcal: Math.round(num(o.kcal)), protein: Math.round(num(o.protein)),
    carbs: Math.round(num(o.carbs)), fat: Math.round(num(o.fat)),
  } });
  let food = null;
  try { food = app.findFirstRecordByFilter("foods", "barcode = {:c}", { c: code }); } catch (_) {}
  if (!food && code.length === 12) { try { food = app.findFirstRecordByFilter("foods", "barcode = {:c}", { c: "0" + code }); } catch (_) {} }
  if (food) return asFood({ name: food.getString("name"), brand: food.getString("brand"), serving_desc: food.getString("serving_desc"), serving_g: food.getFloat("serving_g"), kcal: food.getFloat("kcal"), protein: food.getFloat("protein"), carbs: food.getFloat("carbs"), fat: food.getFloat("fat") }, "database");
  let hit = null; try { hit = barcodeLookupOnline(app, code); } catch (_) {}
  if (hit && (hit.name || num(hit.kcal) > 0)) return asFood(hit, hit.source || "online");
  const cfg = lookupCfg(app);
  let ident = null; try { ident = barcodeIdentifyOnline(app, code, cfg); } catch (_) {}
  if (ident) {
    const label = ident.brand ? ident.name + " " + ident.brand : ident.name;
    let est = null; try { est = webEstimate(app, label, email); } catch (_) {}
    const t = (est && est.parsed && est.parsed.total) || {};
    return asFood({ name: ident.name, brand: ident.brand || "", serving_desc: "1 serving", kcal: t.kcal, protein: t.protein, carbs: t.carbs, fat: t.fat }, "ai-estimate");
  }
  return e.json(404, { error: "no product found for that barcode" });
}

function adminPutFood(e) {
  const a = requireAdmin(e);
  if (!a.ok) return a.res;
  const app = e.app;
  const b = e.requestInfo().body || {};
  const name = String(b.name || "").trim();
  if (!name) return e.json(400, { error: "name is required" });
  const brand = String(b.brand || "").trim();
  let rec;
  if (b.id) {
    try { rec = app.findRecordById("foods", String(b.id)); }
    catch (_) { return e.json(404, { error: "not found" }); }
  } else {
    rec = new Record(app.findCollectionByNameOrId("foods"));
  }
  const aliases = Array.isArray(b.aliases)
    ? b.aliases
    : String(b.aliases || "").split(",").map((s) => s.trim()).filter(Boolean);
  rec.set("name", name);
  rec.set("brand", brand);
  if (b.barcode !== undefined) rec.set("barcode", String(b.barcode).replace(/[^0-9]/g, ""));
  rec.set("serving_desc", String(b.serving_desc || ""));
  rec.set("serving_g", num(b.serving_g));
  rec.set("kcal", num(b.kcal));
  rec.set("protein", num(b.protein));
  rec.set("carbs", num(b.carbs));
  rec.set("fat", num(b.fat));
  rec.set("category", String(b.category || ""));
  rec.set("aliases", aliases);
  if (b.verified !== undefined) rec.set("verified", !!b.verified);
  if (!rec.getString("source")) rec.set("source", "user");
  rec.set("search", (name + " " + brand + " " + aliases.join(" ")).toLowerCase());
  rec.set("norm_key", FOODS.normKey(name, brand));
  try { app.save(rec); }
  catch (err) { return e.json(400, { error: String(err.message || err) }); }
  return e.json(200, { ok: true, food: foodJSON(rec) });
}

function adminDeleteFood(e) {
  const a = requireAdmin(e);
  if (!a.ok) return a.res;
  const id = e.request.pathValue("id");
  try { e.app.delete(e.app.findRecordById("foods", id)); }
  catch (_) { return e.json(404, { error: "not found" }); }
  return e.json(200, { deleted: id });
}

// ---- admin: curated nutrition sources ----

function sourceJSON(r) {
  return {
    id: r.id,
    title: r.getString("title"),
    url: r.getString("url"),
    domain: r.getString("domain"),
    notes: r.getString("notes"),
    enabled: r.getBool("enabled"),
  };
}

function adminGetSources(e) {
  const a = requireAdmin(e);
  if (!a.ok) return a.res;
  let recs = [];
  try { recs = e.app.findRecordsByFilter("sources", "id != ''", "title", 200, 0, {}); }
  catch (err) { return e.json(500, { error: String(err.message || err) }); }
  return e.json(200, { sources: recs.map(sourceJSON) });
}

function adminPutSource(e) {
  const a = requireAdmin(e);
  if (!a.ok) return a.res;
  const app = e.app;
  const b = e.requestInfo().body || {};
  const title = String(b.title || "").trim();
  let url = String(b.url || "").trim();
  if (!title || !url) return e.json(400, { error: "title and url are required" });
  if (!/^https?:\/\//i.test(url)) url = "https://" + url;
  let rec;
  if (b.id) {
    try { rec = app.findRecordById("sources", String(b.id)); }
    catch (_) { return e.json(404, { error: "not found" }); }
  } else {
    rec = new Record(app.findCollectionByNameOrId("sources"));
  }
  rec.set("title", title);
  rec.set("url", url);
  rec.set("domain", url.replace(/^https?:\/\//i, "").split("/")[0]);
  rec.set("notes", String(b.notes || ""));
  rec.set("enabled", b.enabled === undefined ? true : !!b.enabled);
  try { app.save(rec); }
  catch (err) { return e.json(400, { error: String(err.message || err) }); }
  return e.json(200, { ok: true, source: sourceJSON(rec) });
}

function adminDeleteSource(e) {
  const a = requireAdmin(e);
  if (!a.ok) return a.res;
  const id = e.request.pathValue("id");
  try { e.app.delete(e.app.findRecordById("sources", id)); }
  catch (_) { return e.json(404, { error: "not found" }); }
  return e.json(200, { deleted: id });
}

// ---- admin: editable AI system prompts ----

const PROMPT_LABELS = {
  vision_estimate: "Photo estimate (vision)",
  text_parse: "Text meal parse",
  chat: "Coach chat",
  daily_summary: "Daily recap",
  web_lookup: "Web search lookup",
};

function adminGetPrompts(e) {
  const a = requireAdmin(e);
  if (!a.ok) return a.res;
  const app = e.app;
  const prompts = F.FUNCTIONS.map((fn) => {
    let override = "";
    try {
      override = app.findFirstRecordByFilter("settings", "key = {:k}", { k: "prompt_" + fn }).getString("value");
    } catch (_) {}
    return {
      fn: fn,
      label: PROMPT_LABELS[fn] || fn,
      default: (F.PROMPTS[fn] && F.PROMPTS[fn].system) || "",
      override: override || "",
      customized: !!(override && override.trim()),
    };
  });
  return e.json(200, { prompts: prompts });
}

function adminPutPrompt(e) {
  const a = requireAdmin(e);
  if (!a.ok) return a.res;
  const app = e.app;
  const b = e.requestInfo().body || {};
  const fn = String(b.fn || "");
  if (F.FUNCTIONS.indexOf(fn) === -1) return e.json(400, { error: "invalid function" });
  const text = String(b.text || "");
  const key = "prompt_" + fn;
  let rec = null;
  try { rec = app.findFirstRecordByFilter("settings", "key = {:k}", { k: key }); } catch (_) {}
  // empty text = reset to the built-in default (remove the override)
  if (!text.trim()) {
    try { if (rec) app.delete(rec); } catch (_) {}
    return e.json(200, { ok: true, reset: true });
  }
  if (!rec) {
    rec = new Record(app.findCollectionByNameOrId("settings"));
    rec.set("key", key);
  }
  rec.set("value", text);
  app.save(rec);
  return e.json(200, { ok: true });
}

// ---- admin: barcode-lookup source credentials ----

function adminGetLookup(e) {
  const a = requireAdmin(e);
  if (!a.ok) return a.res;
  const s = settingsMap(e.app);
  const set = (v) => !!(v && String(v).trim());
  return e.json(200, {
    usda: { set: set(s.usda_api_key), hint: F.redact(s.usda_api_key) },
    nutritionix: { app_id: s.nutritionix_app_id || "", set: set(s.nutritionix_app_key), hint: F.redact(s.nutritionix_app_key) },
    fatsecret: { client_id: s.fatsecret_client_id || "", set: set(s.fatsecret_client_secret), hint: F.redact(s.fatsecret_client_secret) },
    upcitemdb: { set: set(s.upcitemdb_key), hint: F.redact(s.upcitemdb_key) },
    go_upc: { set: set(s.go_upc_key), hint: F.redact(s.go_upc_key) },
    barcode_lookup: { set: set(s.barcode_lookup_key), hint: F.redact(s.barcode_lookup_key) },
  });
}

function adminPutLookup(e) {
  const a = requireAdmin(e);
  if (!a.ok) return a.res;
  const app = e.app;
  const b = e.requestInfo().body || {};
  const col = app.findCollectionByNameOrId("settings");
  const setKey = (k, v) => {
    let rec;
    try { rec = app.findFirstRecordByFilter("settings", "key = {:k}", { k: k }); }
    catch (_) { rec = new Record(col); rec.set("key", k); }
    rec.set("value", String(v));
    app.save(rec);
  };
  const delKey = (k) => { try { app.delete(app.findFirstRecordByFilter("settings", "key = {:k}", { k: k })); } catch (_) {} };
  // [key, isSecret] — secrets are kept when submitted blank (so you don't wipe them by re-saving)
  const fields = [["usda_api_key", true], ["nutritionix_app_id", false], ["nutritionix_app_key", true],
    ["fatsecret_client_id", false], ["fatsecret_client_secret", true],
    ["upcitemdb_key", true], ["go_upc_key", true], ["barcode_lookup_key", true]];
  for (const f of fields) {
    if (b[f[0]] === undefined) continue;
    const v = String(b[f[0]]);
    if (f[1] && v === "") continue;
    setKey(f[0], v);
  }
  // FatSecret creds changed → drop the cached OAuth token so the new ones take effect
  if (b.fatsecret_client_id !== undefined || b.fatsecret_client_secret !== undefined) {
    delKey("_fs_token"); delKey("_fs_token_exp");
  }
  return e.json(200, { ok: true });
}

module.exports = {
  authConfig,
  me,
  logText,
  logPhoto,
  logBarcode,
  chat,
  listEntries,
  deleteEntry,
  updateEntry,
  logActivity,
  logHeartRate,
  healthSync,
  weightLog,
  weightSync,
  weightGet,
  weightGoalsList,
  weightGoalSet,
  weightGoalDelete,
  planCompute,
  nutritionist,
  activitiesSearch,
  statsRange,
  adminGetActivities,
  adminPutActivity,
  adminDeleteActivity,
  setGoals,
  daySummary,
  adminGetProviders,
  adminPutProvider,
  adminGetModels,
  adminGetFunctions,
  adminPutFunction,
  adminGetUsage,
  adminGetLimits,
  adminSetLimit,
  adminGetPrices,
  adminSetPrice,
  adminGetSettings,
  adminPutSettings,
  adminGetUsers,
  adminSetUserRole,
  adminSetUserModels,
  adminGetFoods,
  adminPutFood,
  adminFoodEstimate,
  adminFoodBarcode,
  adminDeleteFood,
  webLookupEntry,
  adminGetSources,
  adminPutSource,
  adminDeleteSource,
  adminGetPrompts,
  adminPutPrompt,
  adminGetLookup,
  adminPutLookup,
};
