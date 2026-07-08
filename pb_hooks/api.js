/// <reference path="../pb_data/types.d.ts" />

// All Sate request logic. PocketBase runs route handlers in an isolated JSVM that can't see a
// hook file's top-level scope, so main.pb.js stays thin and delegates to the functions below
// (each handler require()s this module at call time).

const P = require(`${__hooks}/providers.js`);
const F = require(`${__hooks}/functions.js`);
const FOODS = require(`${__hooks}/foods.js`);

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

const AUTH_HEADER = env("AUTH_EMAIL_HEADER") || "Cf-Access-Authenticated-User-Email";
const DEV_EMAIL = env("DEV_EMAIL").toLowerCase().trim();
const ADMINS = env("ADMIN_EMAILS")
  .toLowerCase()
  .split(",")
  .map((s) => s.trim())
  .filter((s) => s.length > 0);
const VALID_PROVIDERS = ["anthropic", "openai", "google"];
const SETTING_KEYS = ["app_name", "default_goal_kcal", "default_goal_protein", "default_goal_carbs", "default_goal_fat"];

// ------------------------------------------------------------------ helpers

function identity(e) {
  let email = e.request.header.get(AUTH_HEADER) || "";
  if (!email && DEV_EMAIL) email = DEV_EMAIL;
  return email.toLowerCase().trim();
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

function readItems(rec) {
  let v = rec.get("items");
  if (v == null) return [];
  if (typeof v === "string") {
    try {
      return JSON.parse(v);
    } catch (_) {
      return [];
    }
  }
  return v;
}

function entryJSON(rec) {
  return {
    id: rec.id,
    logged_at: rec.getString("logged_at"),
    source: rec.getString("source"),
    description: rec.getString("description"),
    items: readItems(rec),
    kcal: rec.getFloat("kcal"),
    protein: rec.getFloat("protein"),
    carbs: rec.getFloat("carbs"),
    fat: rec.getFloat("fat"),
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

function sumTotals(records) {
  const t = { kcal: 0, protein: 0, carbs: 0, fat: 0, count: records.length };
  for (const rec of records) {
    t.kcal += rec.getFloat("kcal");
    t.protein += rec.getFloat("protein");
    t.carbs += rec.getFloat("carbs");
    t.fat += rec.getFloat("fat");
  }
  return t;
}

function addEntry(app, email, data) {
  const rec = new Record(app.findCollectionByNameOrId("entries"));
  rec.set("user_email", email);
  rec.set("logged_at", new Date().toISOString());
  rec.set("source", data.source);
  rec.set("description", data.description || "");
  rec.set("items", data.items || []);
  rec.set("kcal", data.total.kcal);
  rec.set("protein", data.total.protein);
  rec.set("carbs", data.total.carbs);
  rec.set("fat", data.total.fat);
  rec.set("provider", data.provider || "");
  rec.set("model", data.model || "");
  app.save(rec);
  return rec;
}

function estimate(app, fn, userText, image) {
  const cfg = F.resolveFunction(app, fn);
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

  const reply = P.runProvider({
    provider: cfg.provider,
    apiKey: cfg.apiKey,
    baseUrl: cfg.baseUrl,
    model: cfg.model,
    system: p.system,
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

  return { parsed: parsed, provider: cfg.provider, model: cfg.model };
}

function goalsOf(profile) {
  return {
    kcal: profile.getFloat("goal_kcal"),
    protein: profile.getFloat("goal_protein"),
    carbs: profile.getFloat("goal_carbs"),
    fat: profile.getFloat("goal_fat"),
  };
}

// --------------------------------------------------------------- user routes

function me(e) {
  const email = identity(e);
  if (!email) return e.json(401, { error: "not authenticated (no auth-proxy header)" });
  const app = e.app;
  const profile = ensureProfile(app, email);
  const today = todayStr();
  return e.json(200, {
    email: email,
    name: profile.getString("name"),
    role: profile.getString("role"),
    isAdmin: resolveIsAdmin(app, email),
    app_name: settingsMap(app).app_name || "Sate",
    goals: goalsOf(profile),
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
    const r = estimate(app, "text_parse", text, null);
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
      totals: sumTotals(dayEntries(app, email, todayStr())),
    });
  } catch (err) {
    return e.json(502, { error: String(err.message || err) });
  }
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
    const r = estimate(app, "vision_estimate", prompt, { mimeType: mimeType, data: data });
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
    F.PROMPTS.chat.system +
    `\n\nUser's totals so far today: ${Math.round(totals.kcal)} kcal, ` +
    `${Math.round(totals.protein)}g protein, ${Math.round(totals.carbs)}g carbs, ` +
    `${Math.round(totals.fat)}g fat across ${totals.count} entries.`;
  try {
    const cfg = F.resolveFunction(app, "chat");
    const reply = P.runProvider({
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

function setGoals(e) {
  const email = identity(e);
  if (!email) return e.json(401, { error: "not authenticated" });
  const app = e.app;
  const profile = ensureProfile(app, email);
  const body = e.requestInfo().body || {};
  for (const k of ["goal_kcal", "goal_protein", "goal_carbs", "goal_fat"]) {
    if (body[k] !== undefined && body[k] !== null && body[k] !== "") {
      profile.set(k, Number(body[k]) || 0);
    }
  }
  app.save(profile);
  return e.json(200, { goals: goalsOf(profile) });
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
    const cfg = F.resolveFunction(app, "daily_summary");
    const reply = P.runProvider({
      provider: cfg.provider,
      apiKey: cfg.apiKey,
      baseUrl: cfg.baseUrl,
      model: cfg.model,
      system: F.PROMPTS.daily_summary.system,
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

// Instance settings: app name + default new-user goals.
function adminGetSettings(e) {
  const a = requireAdmin(e);
  if (!a.ok) return a.res;
  return e.json(200, {
    settings: settingsMap(e.app),
    env_admins: ADMINS,
    auth_header: AUTH_HEADER,
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
    };
  });
  // include env admins who haven't logged in yet
  for (const email of ADMINS) {
    if (!seen[email]) out.push({ email: email, name: email.split("@")[0], role: "admin", env_admin: true });
  }
  return e.json(200, { users: out });
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

module.exports = {
  me,
  logText,
  logPhoto,
  chat,
  listEntries,
  deleteEntry,
  setGoals,
  daySummary,
  adminGetProviders,
  adminPutProvider,
  adminGetModels,
  adminGetFunctions,
  adminPutFunction,
  adminGetSettings,
  adminPutSettings,
  adminGetUsers,
  adminSetUserRole,
  adminGetFoods,
  adminPutFood,
  adminDeleteFood,
};
