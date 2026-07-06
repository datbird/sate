/// <reference path="../pb_data/types.d.ts" />

// All Sate request logic lives here as a required module. PocketBase runs route handlers in
// an isolated JSVM that can't see a hook file's top-level scope, so main.pb.js stays thin and
// delegates to the functions exported below (each handler require()s this module at call time).

const { runProvider } = require(`${__hooks}/providers.js`);
const F = require(`${__hooks}/functions.js`);

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

// ------------------------------------------------------------------ helpers

function identity(e) {
  let email = e.request.header.get(AUTH_HEADER) || "";
  if (!email && DEV_EMAIL) email = DEV_EMAIL;
  return email.toLowerCase().trim();
}

function isAdmin(email) {
  return ADMINS.indexOf(email) !== -1;
}

function ensureProfile(app, email) {
  let rec = null;
  try {
    rec = app.findFirstRecordByFilter("profiles", "email = {:e}", { e: email });
  } catch (_) {
    rec = null;
  }
  let isNew = false;
  if (!rec) {
    rec = new Record(app.findCollectionByNameOrId("profiles"));
    rec.set("email", email);
    rec.set("name", email.split("@")[0]);
    isNew = true;
  }
  const role = isAdmin(email) ? "admin" : "user";
  if (isNew || rec.getString("role") !== role) {
    rec.set("role", role);
    app.save(rec);
  }
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
  const reply = runProvider({
    provider: cfg.provider,
    apiKey: cfg.apiKey,
    baseUrl: cfg.baseUrl,
    model: cfg.model,
    system: p.system,
    messages: [{ role: "user", text: userText }],
    image: image || null,
    jsonMode: p.jsonMode,
  });
  const parsed = F.normalizeNutrition(F.parseJSON(reply));
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
    isAdmin: isAdmin(email),
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
    const reply = runProvider({
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
    const reply = runProvider({
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
  if (!isAdmin(email)) return { ok: false, res: e.json(403, { error: "admin only" }) };
  return { ok: true, email: email };
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
  let rec;
  try {
    rec = app.findFirstRecordByFilter("providers", "name = {:n}", { n: name });
  } catch (_) {
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

function adminGetUsers(e) {
  const a = requireAdmin(e);
  if (!a.ok) return a.res;
  const app = e.app;
  const out = app.findAllRecords("profiles").map((r) => ({
    email: r.getString("email"),
    name: r.getString("name"),
    role: r.getString("role"),
  }));
  return e.json(200, { users: out });
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
  adminGetFunctions,
  adminPutFunction,
  adminGetUsers,
};
