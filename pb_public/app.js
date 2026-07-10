"use strict";

const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));

let ME = null;
let AUTH = { mode: "proxy", apple_configured: false };
let PB = null; // PocketBase client — only created in apple mode

async function api(path, opts) {
  const o = Object.assign({}, opts);
  o.headers = Object.assign({ "content-type": "application/json" }, o.headers);
  // In proxy mode the proxy authenticates the request; in apple mode we carry a PocketBase token.
  if (PB && PB.authStore.isValid) o.headers["Authorization"] = PB.authStore.token;
  const res = await fetch("/api/sate" + path, o);
  let data = {};
  try { data = await res.json(); } catch (_) {}
  if (!res.ok) {
    // A stale token is indistinguishable from never having signed in — send them back to sign-in.
    if (res.status === 401 && AUTH.mode === "apple") {
      if (PB) PB.authStore.clear();
      showSignIn();
    }
    throw new Error(data.error || res.status + " error");
  }
  return data;
}

function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (t.hidden = true), 2600);
}

// ---------------------------------------------------- appearance / user menu
function applyTheme(t) {
  if (t === "system") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = t;
  try { localStorage.setItem("sate-theme", t); } catch (e) {}
  $$('#themeSeg [data-theme-choice]').forEach((b) => b.classList.toggle("active", b.dataset.themeChoice === t));
}
(function userMenu() {
  let saved = "system";
  try { saved = localStorage.getItem("sate-theme") || "system"; } catch (e) {}
  applyTheme(saved);
  const btn = $("#userBtn"), menu = $("#userMenu");
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    const open = menu.hidden;
    menu.hidden = !open;
    btn.setAttribute("aria-expanded", String(open));
  });
  document.addEventListener("click", () => { menu.hidden = true; btn.setAttribute("aria-expanded", "false"); });
  menu.addEventListener("click", (e) => e.stopPropagation());
  $$('#themeSeg [data-theme-choice]').forEach((b) => b.addEventListener("click", () => applyTheme(b.dataset.themeChoice)));
})();

function fmt(n) { return Math.round(Number(n) || 0).toLocaleString(); }
function todayISO() { return new Date().toISOString().slice(0, 10); }

// ---------------------------------------------------------------- navigation
// The header tabs and the bottom tab bar are the same nav rendered twice; [data-view] is the
// contract between them, so neither needs to know the other exists.
function showView(name) {
  $$(".view").forEach((v) => (v.hidden = v.id !== "view-" + name));
  $$("[data-view]").forEach((b) => b.classList.toggle("active", b.dataset.view === name));
  if (name === "history") loadHistory();
  if (name === "admin") loadAdmin();
}
$$("[data-view]").forEach((b) => b.addEventListener("click", () => showView(b.dataset.view)));

// ---------------------------------------------------------- tracking modes
// Per-metric display metadata. `get` reads the value from a totals/goals object; `u` is the
// unit suffix shown right after the number; `goalKey` is which goal field applies (if any).
const METRIC = {
  kcal:     { label: "kcal",     u: "",   goalKey: "kcal",   get: (t) => t.kcal || 0 },
  protein:  { label: "protein",  u: "g",  goalKey: "protein", get: (t) => t.protein || 0 },
  carbs:    { label: "carbs",    u: "g",  goalKey: "carbs",  get: (t) => t.carbs || 0 },
  fat:      { label: "fat",      u: "g",  goalKey: "fat",    get: (t) => t.fat || 0 },
  fiber:    { label: "fiber",    u: "g",  goalKey: null,     get: (t) => t.fiber || 0 },
  sugar:    { label: "sugar",    u: "g",  goalKey: null,     get: (t) => t.sugar || 0 },
  sodium:   { label: "sodium",   u: "mg", goalKey: "sodium", get: (t) => t.sodium || 0 },
  sat_fat:  { label: "sat fat",  u: "g",  goalKey: null,     get: (t) => t.sat_fat || 0 },
  // Net carbs = carbs − fiber; its goal is the carb goal.
  netcarbs: { label: "net carbs", u: "g", goalKey: "carbs", get: (t) => Math.max(0, (t.carbs || 0) - (t.fiber || 0)) },
};

// Each mode picks the ring's primary metric and the secondary stats shown beneath it.
const MODES = {
  calories: { label: "Calories",        primary: "kcal",     stats: ["protein", "carbs", "fat"],
              hint: "The ring counts calories. Only a daily calorie goal is needed." },
  carb:     { label: "Carb-focused",    primary: "netcarbs", stats: ["kcal", "protein", "fiber"],
              hint: "The ring counts net carbs (carbs − fiber) toward your carb goal. Covers low-carb, keto, and diabetic carb-counting." },
  protein:  { label: "High-protein",    primary: "protein",  stats: ["kcal", "carbs", "fat"],
              hint: "The ring counts protein toward your protein goal." },
  fat:      { label: "Low-fat",         primary: "fat",      stats: ["kcal", "carbs", "protein"],
              hint: "The ring counts fat toward your fat goal." },
  balanced: { label: "Balanced macros", primary: "kcal",     stats: ["protein", "carbs", "fat"],
              hint: "The ring counts calories; protein, carbs, and fat each show progress toward their goals." },
  heart:    { label: "Heart-healthy",   primary: "sodium",   stats: ["sat_fat", "fiber", "kcal"],
              hint: "The ring counts sodium toward a daily limit; saturated fat and fiber are shown too." },
};
function modeOf() { return MODES[(ME && ME.track_mode)] || MODES.calories; }

// -------------------------------------------------------------------- totals
function renderTotals(totals, goals) {
  totals = totals || {};
  goals = goals || {};
  const mode = modeOf();
  const pm = METRIC[mode.primary];
  const val = pm.get(totals);
  const goal = pm.goalKey ? (goals[pm.goalKey] || 0) : 0;

  $("#ringKcal").textContent = fmt(val);
  const ushort = pm.u ? " " + pm.u : (mode.primary === "kcal" ? " kcal" : "");
  $("#ringGoal").textContent = goal ? "of " + fmt(goal) + ushort : (pm.u ? pm.u : pm.label);
  const pct = goal ? Math.min(100, (val / goal) * 100) : 0;
  $("#ring").style.setProperty("--pct", pct.toFixed(1));

  // Secondary stats row
  const stat = (key) => {
    const m = METRIC[key];
    const v = m.get(totals);
    const g = m.goalKey ? (goals[m.goalKey] || 0) : 0;
    return `<div class="macro"><b>${fmt(v)}${m.u}</b><span>${m.label}${g ? " / " + fmt(g) : ""}</span></div>`;
  };
  $("#macros").innerHTML = mode.stats.map(stat).join("");

  // Mode caption under the ring
  const cap = $("#modeCap");
  cap.hidden = false;
  const goalTxt = goal ? " · goal " + fmt(goal) + ushort : "";
  cap.textContent = mode.label + " · ring tracks " + pm.label + goalTxt;
}

function entryLi(en, onDel) {
  const li = document.createElement("li");
  li.className = "entry";
  const items = (en.items || []).map((i) => i.name).join(", ");
  li.innerHTML =
    `<div class="body"><div class="title">${escapeHtml(en.description || items || "Entry")}</div>` +
    `<div class="sub"><span class="badge">${en.source || ""}</span> ${escapeHtml(items)}` +
    `${en.protein ? " · " + fmt(en.protein) + "g P" : ""}</div></div>` +
    `<div class="kcal">${fmt(en.kcal)}</div>`;
  if (onDel) {
    const btn = document.createElement("button");
    btn.className = "del"; btn.textContent = "✕"; btn.title = "Delete";
    btn.onclick = () => onDel(en.id);
    li.appendChild(btn);
  }
  return li;
}

function escapeHtml(s) {
  return String(s || "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

// ---------------------------------------------------------------------- log
async function refreshToday() {
  const data = await api("/entries?date=" + todayISO());
  renderTotals(data.totals, ME.goals);
  const ul = $("#entries");
  ul.innerHTML = "";
  if (!data.entries.length) ul.innerHTML = '<li class="hint">Nothing logged yet — describe a meal or snap a photo.</li>';
  data.entries.forEach((en) => ul.appendChild(entryLi(en, deleteEntry)));
}

async function deleteEntry(id) {
  await api("/entries/" + id, { method: "DELETE" });
  refreshToday();
}

async function logText() {
  const input = $("#foodInput");
  const text = input.value.trim();
  if (!text) return;
  setBusy(true, "Estimating…");
  try {
    const r = await api("/log/text", { method: "POST", body: JSON.stringify({ text }) });
    input.value = "";
    renderChatResult(r);
    refreshToday();
  } catch (e) {
    toast(e.message);
  } finally {
    setBusy(false);
  }
}

function renderChatResult(r) {
  const cl = $("#chatline");
  cl.innerHTML = "";
  const msg = document.createElement("div");
  msg.className = "chatmsg";
  msg.textContent = r.note || `Logged ${fmt(r.entry.kcal)} kcal.`;
  cl.appendChild(msg);
  // Not found in the local DB → offer an on-demand web search to replace the guess.
  if (!r.in_db) {
    const warn = document.createElement("div");
    warn.className = "chatwarn";
    warn.textContent = "⚠ Not in your food database — this is a best guess.";
    cl.appendChild(warn);
    const btn = document.createElement("button");
    btn.className = "primary websearch";
    btn.textContent = "🔎 Search the web";
    btn.onclick = () => webLookup(r.entry.id, btn);
    cl.appendChild(btn);
  }
}

async function webLookup(entryId, btn) {
  btn.disabled = true;
  btn.textContent = "Searching the web…";
  try {
    const r = await api("/entries/" + entryId + "/web-lookup", { method: "POST" });
    const cl = $("#chatline");
    cl.innerHTML = "";
    const m = document.createElement("div");
    m.className = "chatmsg";
    m.textContent = r.note || `Updated to ${fmt(r.entry.kcal)} kcal from the web.`;
    cl.appendChild(m);
    refreshToday();
  } catch (e) {
    toast(e.message);
    btn.disabled = false;
    btn.textContent = "🔎 Search the web";
  }
}

async function logPhoto(file) {
  const dataUrl = await new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = reject;
    fr.readAsDataURL(file);
  });
  setBusy(true, "Analyzing photo…");
  try {
    const r = await api("/log/photo", { method: "POST", body: JSON.stringify({ image: dataUrl }) });
    $("#chatline").textContent = r.note || `Logged ${fmt(r.entry.kcal)} kcal from photo.`;
    refreshToday();
  } catch (e) {
    toast(e.message);
  } finally {
    setBusy(false);
  }
}

function setBusy(on, msg) {
  $("#sendBtn").disabled = on;
  $("#photoBtn").disabled = on;
  if (on && msg) $("#chatline").textContent = msg;
}

$("#sendBtn").addEventListener("click", logText);
$("#foodInput").addEventListener("keydown", (e) => { if (e.key === "Enter") logText(); });
$("#photoBtn").addEventListener("click", () => $("#photoInput").click());
$("#photoInput").addEventListener("change", (e) => { if (e.target.files[0]) logPhoto(e.target.files[0]); e.target.value = ""; });

// -------------------------------------------------------- barcode scanning
let scanner = null;
let scanBusy = false;

async function openScanner() {
  if (typeof Html5Qrcode === "undefined") return toast("Scanner failed to load");
  $("#scanwrap").hidden = false;
  $("#scanStatus").textContent = "Starting camera…";
  scanBusy = false;
  try {
    scanner = new Html5Qrcode("reader", { verbose: false });
    await scanner.start(
      { facingMode: "environment" },
      { fps: 10, qrbox: { width: 250, height: 160 } },
      onScan,
      () => {}
    );
    $("#scanStatus").textContent = "Point your camera at a barcode.";
  } catch (err) {
    $("#scanStatus").textContent = "Camera error: " + (err && err.message ? err.message : err);
  }
}

async function closeScanner() {
  try { if (scanner) { await scanner.stop(); scanner.clear(); } } catch (_) {}
  scanner = null;
  $("#scanwrap").hidden = true;
}

// Pull a product barcode (GTIN) out of a scan: a plain UPC/EAN, or the GTIN embedded in a
// GS1 Digital Link QR code (e.g. https://brand.example/01/00012345678905/10/LOT).
function gtinFromScan(raw) {
  if (/^\d{8,14}$/.test(raw)) return raw;
  const m = raw.match(/(?:^|\/)01\/(\d{8,14})(?:\/|$)/);
  return m ? m[1] : null;
}

async function onScan(decodedText) {
  if (scanBusy) return;
  const raw = String(decodedText).trim();
  scanBusy = true;
  const gtin = gtinFromScan(raw);
  if (gtin) {
    $("#scanStatus").textContent = "Looking up " + gtin + "…";
    try {
      const r = await api("/log/barcode", { method: "POST", body: JSON.stringify({ barcode: gtin }) });
      await closeScanner();
      const cl = $("#chatline"); cl.innerHTML = "";
      const m = document.createElement("div"); m.className = "chatmsg";
      m.textContent = `Logged ${r.name} — ${fmt(r.entry.kcal)} kcal (via ${r.found_via}).`;
      cl.appendChild(m);
      refreshToday();
    } catch (e) {
      $("#scanStatus").textContent = e.message + " — try again, or type it in.";
      scanBusy = false;
    }
  } else if (/^https?:\/\//i.test(raw)) {
    // a QR code that's just a link (not a product code) — don't log a URL as food
    $("#scanStatus").textContent = "That QR code is a link, not a product barcode.";
    scanBusy = false;
  } else {
    // any other text (incl. a meal typed into a QR) → treat as a meal description
    await closeScanner();
    $("#foodInput").value = raw;
    logText();
  }
}

$("#scanBtn").addEventListener("click", openScanner);
$("#scanClose").addEventListener("click", closeScanner);

// ------------------------------------------------------------------- goals
const goalsDialog = $("#goalsDialog");
function goalModeHint() {
  const m = MODES[$("#goalMode").value] || MODES.calories;
  $("#goalModeHint").textContent = m.hint;
}
function openGoals() {
  const f = $("#goalsForm");
  const g = ME.goals || {};
  f.goal_kcal.value = g.kcal || "";
  f.goal_protein.value = g.protein || "";
  f.goal_carbs.value = g.carbs || "";
  f.goal_fat.value = g.fat || "";
  f.goal_sodium.value = g.sodium || "";
  $("#goalMode").value = ME.track_mode || "calories";
  goalModeHint();
  goalsDialog.showModal();
}
$("#goalsBtn").addEventListener("click", openGoals);
$("#menuGoals").addEventListener("click", () => { $("#userMenu").hidden = true; openGoals(); });
$("#goalMode").addEventListener("change", goalModeHint);
$("#goalsForm").addEventListener("submit", async (e) => {
  if (e.submitter && e.submitter.value === "cancel") return;
  const f = e.target;
  const payload = {
    track_mode: f.track_mode.value,
    goal_kcal: f.goal_kcal.value, goal_protein: f.goal_protein.value,
    goal_carbs: f.goal_carbs.value, goal_fat: f.goal_fat.value, goal_sodium: f.goal_sodium.value,
  };
  const r = await api("/goals", { method: "PATCH", body: JSON.stringify(payload) });
  ME.goals = r.goals;
  if (r.track_mode) ME.track_mode = r.track_mode;
  refreshToday();
  toast("Goals saved");
});

// ----------------------------------------------------------------- history
async function loadHistory() {
  const d = $("#histDate");
  if (!d.value) d.value = todayISO();
  $("#summary").hidden = true;
  const data = await api("/entries?date=" + d.value);
  const ul = $("#histEntries");
  ul.innerHTML = "";
  if (!data.entries.length) ul.innerHTML = '<li class="hint">No entries for this day.</li>';
  data.entries.forEach((en) => ul.appendChild(entryLi(en, null)));
}
$("#histDate").addEventListener("change", loadHistory);
$("#summaryBtn").addEventListener("click", async () => {
  const box = $("#summary");
  box.hidden = false; box.textContent = "Thinking…";
  try {
    const r = await api("/day/summary?date=" + $("#histDate").value);
    box.textContent = r.summary;
  } catch (e) {
    box.textContent = e.message;
  }
});

// ------------------------------------------------------------------- admin
let MODELS = {}; // provider -> [{id,label,vision}]
let PROVIDERS = []; // provider rows from the last admin load (for per-user override dropdowns)

async function loadAdmin() {
  const [{ providers }, { functions }, usersResp, settingsResp] = await Promise.all([
    api("/admin/providers"), api("/admin/functions"), api("/admin/users"), api("/admin/settings"),
  ]);
  PROVIDERS = providers;
  renderInstance(settingsResp);
  renderProviders(providers);
  // Fetch live model lists for any provider that has a key.
  MODELS = {};
  await Promise.all(
    providers.filter((p) => p.key_set).map(async (p) => {
      try { const r = await api("/admin/models?provider=" + p.name); MODELS[p.name] = r.models || []; }
      catch (_) { MODELS[p.name] = []; }
    })
  );
  populateDatalists();
  renderFunctions(functions, providers);
  renderUsers(usersResp.users);
  loadFoods("");
  loadSources();
  loadPrompts();
  loadLookup();
}

// ---------------------------------------------------- barcode lookup sources
async function loadLookup() {
  let r;
  try { r = await api("/admin/lookup"); } catch (e) { return; }
  $("#lk_usda").value = "";
  $("#lk_usda").placeholder = r.usda.set ? "key set — " + r.usda.hint + " (blank keeps it)" : "paste key, or leave blank for DEMO_KEY";
  $("#lk_nix_id").value = r.nutritionix.app_id || "";
  $("#lk_nix_key").value = "";
  $("#lk_nix_key").placeholder = r.nutritionix.set ? "set — " + r.nutritionix.hint + " (blank keeps it)" : "x-app-key";
  $("#lk_fs_id").value = r.fatsecret.client_id || "";
  $("#lk_fs_secret").value = "";
  $("#lk_fs_secret").placeholder = r.fatsecret.set ? "set — " + r.fatsecret.hint + " (blank keeps it)" : "client secret";
  $("#lk_upc").value = "";
  $("#lk_upc").placeholder = (r.upcitemdb && r.upcitemdb.set) ? "key set — " + r.upcitemdb.hint + " (blank keeps it)" : "leave blank to use the free trial tier";
  $("#lk_goupc").value = "";
  $("#lk_goupc").placeholder = (r.go_upc && r.go_upc.set) ? "set — " + r.go_upc.hint + " (blank keeps it)" : "bearer key";
  $("#lk_bclookup").value = "";
  $("#lk_bclookup").placeholder = (r.barcode_lookup && r.barcode_lookup.set) ? "set — " + r.barcode_lookup.hint + " (blank keeps it)" : "api key";
  const on = [];
  if (r.usda.set) on.push("USDA"); if (r.nutritionix.set) on.push("Nutritionix"); if (r.fatsecret.set) on.push("FatSecret");
  const idOn = ["UPCitemdb"]; // always available (free trial)
  if (r.go_upc && r.go_upc.set) idOn.push("Go-UPC"); if (r.barcode_lookup && r.barcode_lookup.set) idOn.push("Barcode Lookup");
  $("#lookupMeta").innerHTML = '<span class="badge">nutrition: local → Open Food Facts' +
    (on.length ? " → " + on.join(" → ") : "") + "</span> " +
    '<span class="badge">identity → AI estimate: ' + idOn.join(" → ") + "</span>";
}

async function saveLookup() {
  const payload = {
    usda_api_key: $("#lk_usda").value.trim(),
    nutritionix_app_id: $("#lk_nix_id").value.trim(),
    nutritionix_app_key: $("#lk_nix_key").value.trim(),
    fatsecret_client_id: $("#lk_fs_id").value.trim(),
    fatsecret_client_secret: $("#lk_fs_secret").value.trim(),
    upcitemdb_key: $("#lk_upc").value.trim(),
    go_upc_key: $("#lk_goupc").value.trim(),
    barcode_lookup_key: $("#lk_bclookup").value.trim(),
  };
  try { await api("/admin/lookup", { method: "PUT", body: JSON.stringify(payload) }); toast("Lookup sources saved"); loadLookup(); }
  catch (e) { toast(e.message); }
}

$("#lookupSaveBtn").addEventListener("click", saveLookup);

// ---------------------------------------------------- editable AI prompts
async function loadPrompts() {
  let r;
  try { r = await api("/admin/prompts"); } catch (e) { toast(e.message); return; }
  const wrap = $("#prompts");
  wrap.innerHTML = "";
  r.prompts.forEach((p) => wrap.appendChild(promptCard(p)));
}

function promptCard(p) {
  const el = document.createElement("div");
  el.className = "prompt";
  const head = document.createElement("div");
  head.className = "prompt-head";
  head.innerHTML = `<span class="fname">${escapeHtml(p.label)}</span>` +
    (p.customized ? ' <span class="fbadge web">customized</span>' : ' <span class="fbadge">default</span>');
  const ta = document.createElement("textarea");
  ta.className = "prompt-ta";
  ta.rows = 5;
  ta.value = p.override || p.default;
  ta.placeholder = "System prompt…";
  const actions = document.createElement("div");
  actions.className = "row end";
  const reset = document.createElement("button");
  reset.className = "link";
  reset.textContent = "Reset to default";
  reset.onclick = () => { ta.value = p.default; savePrompt(p.fn, "", el); };
  const save = document.createElement("button");
  save.className = "primary";
  save.textContent = "Save";
  save.onclick = () => savePrompt(p.fn, ta.value.trim() === p.default.trim() ? "" : ta.value, el);
  actions.appendChild(reset); actions.appendChild(save);
  el.appendChild(head); el.appendChild(ta); el.appendChild(actions);
  return el;
}

async function savePrompt(fn, text, el) {
  try {
    const r = await api("/admin/prompts", { method: "PUT", body: JSON.stringify({ fn, text }) });
    toast(r.reset ? "Reset to default" : "Prompt saved");
    loadPrompts();
  } catch (e) { toast(e.message); }
}

function renderInstance(s) {
  const set = s.settings || {};
  $("#appName").value = set.app_name || "";
  $("#dg_kcal").value = set.default_goal_kcal || "";
  $("#dg_protein").value = set.default_goal_protein || "";
  $("#dg_carbs").value = set.default_goal_carbs || "";
  $("#dg_fat").value = set.default_goal_fat || "";
  $("#instanceMeta").innerHTML =
    `<span class="badge">host ${escapeHtml(location.host)}</span> ` +
    `<span class="badge">auth header ${escapeHtml(s.auth_header || "")}</span> ` +
    `<span class="badge">env admins: ${(s.env_admins || []).map(escapeHtml).join(", ") || "none"}</span>`;
}

$("#saveInstance").addEventListener("click", async () => {
  const payload = {
    app_name: $("#appName").value.trim() || "Sate",
    default_goal_kcal: $("#dg_kcal").value || 0,
    default_goal_protein: $("#dg_protein").value || 0,
    default_goal_carbs: $("#dg_carbs").value || 0,
    default_goal_fat: $("#dg_fat").value || 0,
  };
  try {
    await api("/admin/settings", { method: "PUT", body: JSON.stringify(payload) });
    document.title = payload.app_name + " — calorie chat";
    $("#brandName").textContent = payload.app_name;
    toast("Instance settings saved");
  } catch (e) { toast(e.message); }
});

function populateDatalists() {
  for (const prov of ["anthropic", "openai", "google"]) {
    const dl = $("#dl-" + prov);
    if (!dl) continue;
    const list = MODELS[prov] || [];
    dl.innerHTML = list
      .map((m) => `<option value="${escapeHtml(m.id)}">${m.vision ? "👁 " : ""}${escapeHtml(m.label || m.id)}</option>`)
      .join("");
  }
}

async function fetchModelsIfNeeded(prov) {
  if (MODELS[prov]) return;
  try { const r = await api("/admin/models?provider=" + prov); MODELS[prov] = r.models || []; }
  catch (_) { MODELS[prov] = []; }
  populateDatalists();
}

function provOptions(selected) {
  return '<option value="">(global default)</option>' +
    PROVIDERS.map((p) => `<option value="${p.name}" ${selected === p.name ? "selected" : ""}>${p.name}</option>`).join("");
}

// One override category row (provider select + model input) for a user.
function overrideRow(u, cat, label) {
  const prov = cat === "ai" ? u.ov_ai_provider : u.ov_vision_provider;
  const model = cat === "ai" ? u.ov_ai_model : u.ov_vision_model;
  const row = document.createElement("div");
  row.className = "uov-row";
  row.innerHTML =
    `<span class="uov-label">${label}</span>` +
    `<select data-cat="${cat}" data-k="provider">${provOptions(prov)}</select>` +
    `<input type="text" data-cat="${cat}" data-k="model" value="${escapeHtml(model || "")}" placeholder="global default" />`;
  const sel = row.querySelector("select");
  const inp = row.querySelector("input");
  const sync = (clear) => {
    const has = !!sel.value;
    inp.disabled = !has;
    inp.placeholder = has ? "model id (pick or type)" : "uses global default";
    inp.setAttribute("list", has ? "dl-" + sel.value : "");
    if (has) fetchModelsIfNeeded(sel.value);
    else if (clear) inp.value = "";
  };
  sel.addEventListener("change", () => sync(true));
  sync(false);
  return row;
}

function renderUsers(users) {
  const ul = $("#users");
  ul.innerHTML = "";
  users.forEach((u) => {
    const li = document.createElement("li");
    li.className = "u";
    const badge = u.env_admin
      ? '<span class="badge lock">env-admin</span>'
      : `<span class="badge ${u.role === "admin" ? "adminb" : ""}">${u.role}</span>`;
    const hasOv = u.ov_ai_provider || u.ov_vision_provider;
    li.innerHTML = `<span class="uemail">${escapeHtml(u.email)}${hasOv ? ' <span class="badge">custom AI</span>' : ""}</span>`;
    const right = document.createElement("span");
    right.className = "urow-right";
    right.innerHTML = badge;
    if (!u.env_admin) {
      const btn = document.createElement("button");
      btn.className = "link";
      btn.textContent = u.role === "admin" ? "demote" : "make admin";
      btn.onclick = () => setRole(u.email, u.role === "admin" ? "user" : "admin");
      right.appendChild(btn);
    }
    // AI model overrides (collapsed by default)
    const ov = document.createElement("div");
    ov.className = "uoverrides";
    ov.hidden = true;
    ov.appendChild(overrideRow(u, "ai", "Normal AI"));
    ov.appendChild(overrideRow(u, "vision", "Image"));
    const save = document.createElement("button");
    save.className = "primary small";
    save.textContent = "Save overrides";
    save.onclick = () => saveUserModels(u.email, ov);
    ov.appendChild(save);

    const toggle = document.createElement("button");
    toggle.className = "link";
    toggle.textContent = "AI models";
    toggle.onclick = () => { ov.hidden = !ov.hidden; };
    right.appendChild(toggle);

    li.appendChild(right);
    li.appendChild(ov);
    ul.appendChild(li);
  });
}

async function saveUserModels(email, ov) {
  const val = (cat, k) => {
    const el = ov.querySelector(`[data-cat="${cat}"][data-k="${k}"]`);
    return el ? el.value.trim() : "";
  };
  const payload = {
    email: email,
    ov_ai_provider: val("ai", "provider"), ov_ai_model: val("ai", "model"),
    ov_vision_provider: val("vision", "provider"), ov_vision_model: val("vision", "model"),
  };
  if (!payload.ov_ai_provider) payload.ov_ai_model = "";
  if (!payload.ov_vision_provider) payload.ov_vision_model = "";
  try {
    await api("/admin/users/models", { method: "PUT", body: JSON.stringify(payload) });
    toast("AI overrides saved for " + email);
    loadAdmin();
  } catch (e) { toast(e.message); }
}

async function setRole(email, role) {
  try {
    await api("/admin/users/role", { method: "PUT", body: JSON.stringify({ email, role }) });
    toast(email + " → " + role);
    loadAdmin();
  } catch (e) { toast(e.message); }
}

$("#addAdminBtn").addEventListener("click", () => {
  const email = $("#newAdminEmail").value.trim().toLowerCase();
  if (!email || email.indexOf("@") === -1) return toast("enter a valid email");
  $("#newAdminEmail").value = "";
  setRole(email, "admin");
});

// ---------------------------------------------------- food database
let FOOD_EDIT_ID = null;

async function loadFoods(q) {
  let r;
  try { r = await api("/admin/foods" + (q ? "?q=" + encodeURIComponent(q) : "")); }
  catch (e) { toast(e.message); return; }
  $("#foodCount").textContent = q
    ? `${r.shown} match “${q}” · ${r.total} total`
    : `${r.total} foods`;
  const wrap = $("#foodsList");
  wrap.innerHTML = "";
  if (!r.foods.length) { wrap.innerHTML = '<div class="hint">No foods found.</div>'; return; }
  r.foods.forEach((f) => wrap.appendChild(foodRow(f)));
}

function foodRow(f) {
  const el = document.createElement("div");
  el.className = "food";
  const brand = f.brand ? ` · ${escapeHtml(f.brand)}` : "";
  const src = escapeHtml(f.source || "");
  const badges =
    `<span class="fbadge ${src}">${src}</span>` +
    (f.verified ? "" : ' <span class="fbadge warn">unverified</span>');
  const macros = `${fmt(f.protein)}P · ${fmt(f.carbs)}C · ${fmt(f.fat)}F`;
  const serv = escapeHtml(f.serving_desc || "1 serving");
  const body = document.createElement("div");
  body.className = "fbody";
  body.innerHTML =
    `<div class="fname">${escapeHtml(f.name)}${brand} ${badges}</div>` +
    `<div class="fsub">${serv} · ${macros} · used ${fmt(f.usage_count)}×</div>`;
  const kcal = document.createElement("div");
  kcal.className = "fkcal";
  kcal.textContent = fmt(f.kcal);
  const edit = document.createElement("button");
  edit.className = "fx"; edit.title = "edit"; edit.textContent = "✎";
  edit.onclick = () => fillFoodEditor(f);
  const del = document.createElement("button");
  del.className = "fx danger"; del.title = "delete"; del.textContent = "✕";
  del.onclick = () => deleteFood(f);
  el.appendChild(body); el.appendChild(kcal); el.appendChild(edit); el.appendChild(del);
  return el;
}

function fillFoodEditor(f) {
  FOOD_EDIT_ID = f.id || null;
  $("#foodEditorTitle").textContent = f.id ? "Edit food" : "Add food";
  $("#fName").value = f.name || "";
  $("#fBrand").value = f.brand || "";
  $("#fServing").value = f.serving_desc || "";
  $("#fServingG").value = f.serving_g || "";
  $("#fKcal").value = f.kcal || "";
  $("#fProtein").value = f.protein || "";
  $("#fCarbs").value = f.carbs || "";
  $("#fFat").value = f.fat || "";
  $("#fAliases").value = (f.aliases || []).join(", ");
  $("#fVerified").checked = !!f.verified;
  $("#foodEditorTitle").scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function clearFoodEditor() {
  fillFoodEditor({});
  $("#foodEditorTitle").textContent = "Add food";
}

async function saveFood() {
  const name = $("#fName").value.trim();
  if (!name) return toast("name is required");
  const payload = {
    id: FOOD_EDIT_ID || undefined,
    name: name,
    brand: $("#fBrand").value.trim(),
    serving_desc: $("#fServing").value.trim(),
    serving_g: $("#fServingG").value || 0,
    kcal: $("#fKcal").value || 0,
    protein: $("#fProtein").value || 0,
    carbs: $("#fCarbs").value || 0,
    fat: $("#fFat").value || 0,
    aliases: $("#fAliases").value,
    verified: $("#fVerified").checked,
  };
  try {
    await api("/admin/foods", { method: "PUT", body: JSON.stringify(payload) });
    toast(FOOD_EDIT_ID ? "Food updated" : "Food added");
    clearFoodEditor();
    loadFoods($("#foodSearch").value.trim());
  } catch (e) { toast(e.message); }
}

async function deleteFood(f) {
  if (!confirm(`Delete “${f.name}” from the food database?`)) return;
  try {
    await api("/admin/foods/" + f.id, { method: "DELETE" });
    if (FOOD_EDIT_ID === f.id) clearFoodEditor();
    loadFoods($("#foodSearch").value.trim());
  } catch (e) { toast(e.message); }
}

$("#foodSearchBtn").addEventListener("click", () => loadFoods($("#foodSearch").value.trim()));
$("#foodSearch").addEventListener("keydown", (ev) => {
  if (ev.key === "Enter") { ev.preventDefault(); loadFoods($("#foodSearch").value.trim()); }
});
$("#foodSaveBtn").addEventListener("click", saveFood);
$("#foodClearBtn").addEventListener("click", clearFoodEditor);

// ---------------------------------------------------- nutrition sources
async function loadSources() {
  let r;
  try { r = await api("/admin/sources"); } catch (e) { toast(e.message); return; }
  const wrap = $("#sourcesList");
  wrap.innerHTML = "";
  if (!r.sources.length) { wrap.innerHTML = '<div class="hint">No sources yet.</div>'; return; }
  r.sources.forEach((s) => wrap.appendChild(sourceRow(s)));
}

function sourceRow(s) {
  const el = document.createElement("div");
  el.className = "source" + (s.enabled ? "" : " off");
  const body = document.createElement("div");
  body.className = "fbody";
  body.innerHTML =
    `<div class="fname">${escapeHtml(s.title)}</div>` +
    `<div class="fsub"><a href="${escapeHtml(s.url)}" target="_blank" rel="noopener">${escapeHtml(s.domain || s.url)}</a>` +
    (s.notes ? ` · ${escapeHtml(s.notes)}` : "") + `</div>`;
  const toggle = document.createElement("label");
  toggle.className = "switch";
  const cb = document.createElement("input");
  cb.type = "checkbox";
  cb.checked = s.enabled;
  cb.onchange = () => saveSource({ id: s.id, title: s.title, url: s.url, notes: s.notes, enabled: cb.checked }, true);
  toggle.appendChild(cb);
  const del = document.createElement("button");
  del.className = "fx danger"; del.title = "delete"; del.textContent = "✕";
  del.onclick = () => deleteSource(s);
  el.appendChild(body); el.appendChild(toggle); el.appendChild(del);
  return el;
}

async function saveSource(payload, quiet) {
  try {
    await api("/admin/sources", { method: "PUT", body: JSON.stringify(payload) });
    if (!quiet) {
      $("#sTitle").value = ""; $("#sUrl").value = ""; $("#sNotes").value = ""; $("#sEnabled").checked = true;
      toast("Source added");
    }
    loadSources();
  } catch (e) { toast(e.message); }
}

async function deleteSource(s) {
  if (!confirm(`Remove “${s.title}” from your nutrition sources?`)) return;
  try { await api("/admin/sources/" + s.id, { method: "DELETE" }); loadSources(); }
  catch (e) { toast(e.message); }
}

$("#sourceSaveBtn").addEventListener("click", () => {
  const title = $("#sTitle").value.trim();
  const url = $("#sUrl").value.trim();
  if (!title || !url) return toast("title and url are required");
  saveSource({ title, url, notes: $("#sNotes").value.trim(), enabled: $("#sEnabled").checked }, false);
});

function renderProviders(providers) {
  const wrap = $("#providers");
  wrap.innerHTML = "";
  providers.forEach((p) => {
    const el = document.createElement("div");
    el.className = "prov";
    el.innerHTML =
      `<h4>${p.name}</h4>` +
      `<div class="grid">` +
      `<input type="password" placeholder="${p.key_set ? "Key set — " + p.key_hint : "Paste API key"}" data-k="key" />` +
      `<label class="switch"><input type="checkbox" data-k="enabled" ${p.enabled ? "checked" : ""}/> enabled</label>` +
      `</div>` +
      `<div class="grid" style="margin-top:8px">` +
      `<input type="text" placeholder="Base URL (optional)" value="${escapeHtml(p.base_url || "")}" data-k="base_url" />` +
      `<button class="primary" data-save>Save</button>` +
      `</div>`;
    el.querySelector("[data-save]").onclick = async () => {
      const key = el.querySelector('[data-k="key"]').value.trim();
      const payload = {
        name: p.name,
        enabled: el.querySelector('[data-k="enabled"]').checked,
        base_url: el.querySelector('[data-k="base_url"]').value.trim(),
      };
      if (key) payload.api_key = key;
      try { await api("/admin/providers", { method: "PUT", body: JSON.stringify(payload) }); toast(p.name + " saved"); loadAdmin(); }
      catch (e) { toast(e.message); }
    };
    wrap.appendChild(el);
  });
}

const FN_LABELS = {
  vision_estimate: "Image interpretation — photo → nutrition",
  text_parse: "Normal AI — meal text → nutrition",
  chat: "Normal AI — chat / coaching",
  daily_summary: "Normal AI — daily recap",
  web_lookup: "Normal AI — web-search lookup",
};

function renderFunctions(functions, providers) {
  const wrap = $("#functions");
  wrap.innerHTML = "";
  functions.forEach((fn) => {
    const el = document.createElement("div");
    el.className = "fn";
    const opts = providers.map((p) => `<option value="${p.name}" ${fn.provider === p.name ? "selected" : ""}>${p.name}</option>`).join("");
    const needsVision = fn.fn === "vision_estimate";
    el.innerHTML =
      `<h4>${FN_LABELS[fn.fn] || fn.fn}${needsVision ? ' <span class="badge">needs 👁</span>' : ""}</h4>` +
      `<div class="grid">` +
      `<select data-k="provider">${opts}</select>` +
      `<label class="switch"><input type="checkbox" data-k="enabled" ${fn.enabled ? "checked" : ""}/> on</label>` +
      `</div>` +
      `<div class="grid" style="margin-top:8px">` +
      `<input type="text" list="dl-${fn.provider}" value="${escapeHtml(fn.model || "")}" placeholder="model id (pick or type)" data-k="model" />` +
      `<button class="primary" data-save>Save</button>` +
      `</div>`;
    const modelInput = el.querySelector('[data-k="model"]');
    const provSel = el.querySelector('[data-k="provider"]');
    provSel.addEventListener("change", () => {
      modelInput.setAttribute("list", "dl-" + provSel.value);
      fetchModelsIfNeeded(provSel.value);
    });
    el.querySelector("[data-save]").onclick = async () => {
      const payload = {
        fn: fn.fn,
        provider: provSel.value,
        model: modelInput.value.trim(),
        enabled: el.querySelector('[data-k="enabled"]').checked,
      };
      try { await api("/admin/functions", { method: "PUT", body: JSON.stringify(payload) }); toast(fn.fn + " saved"); }
      catch (e) { toast(e.message); }
    };
    wrap.appendChild(el);
  });
}

// --------------------------------------------------------------- sign-in (apple mode)

function capacitorBrowser() {
  return (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Browser) || null;
}

// Apple refuses to render its sign-in page inside an embedded webview, so natively we hand the URL
// to the system browser (ASWebAuthenticationSession). On the web a popup keeps this page alive,
// which matters: PocketBase delivers the auth code back over a realtime subscription held here.
async function openAuthUrl(url) {
  const B = capacitorBrowser();
  if (B) return B.open({ url: url, presentationStyle: "popover" });
  const w = window.open(url, "_blank", "width=520,height=700");
  if (!w) throw new Error("Popup blocked — allow popups for this site, then try again.");
}

function showSignIn() { $("#authwrap").hidden = false; }
function hideSignIn() { $("#authwrap").hidden = true; }

async function signInWithApple() {
  const btn = $("#appleSignIn");
  const note = $("#authNote");
  btn.disabled = true;
  note.className = "authnote";
  note.textContent = "Opening Apple…";
  try {
    await PB.collection("users").authWithOAuth2({ provider: "apple", urlCallback: openAuthUrl });
    const B = capacitorBrowser();
    if (B) { try { await B.close(); } catch (_) {} }
    hideSignIn();
    await start();
  } catch (e) {
    note.className = "authnote err";
    note.textContent = (e && e.message) || "Sign-in failed.";
  } finally {
    btn.disabled = false;
  }
}

// --------------------------------------------------------------------- boot

async function start() {
  try {
    ME = await api("/me");
  } catch (e) {
    if (AUTH.mode === "apple") return; // api() already sent them back to sign-in
    document.body.innerHTML = '<div style="padding:40px;text-align:center;font:16px system-ui">' +
      "🔒 Not authenticated.<br><br>Sate must sit behind an auth proxy (Cloudflare Access), " +
      "or set <code>DEV_EMAIL</code> for local development.</div>";
    return;
  }
  $("#who").textContent = ME.email;
  $("#menuEmail").textContent = ME.email;
  // Prefer the profile name's initial; fall back to the email's. Never render an empty circle.
  const who = (ME.name || ME.email || "").trim();
  $("#avatar").textContent = who ? who[0] : "?";
  if (ME.app_name) { $("#brandName").textContent = ME.app_name; document.title = ME.app_name + " — calorie chat"; }
  if (ME.isAdmin) $$("[data-admin-only]").forEach((el) => (el.hidden = false));
  $("#histDate").value = todayISO();
  refreshToday();
}

async function boot() {
  try {
    const res = await fetch("/api/sate/auth-config");
    if (res.ok) AUTH = await res.json();
  } catch (_) {}

  if (AUTH.mode !== "apple") return start();

  PB = new PocketBase(window.location.origin);
  $("#authBrand").textContent = AUTH.app_name || "Sate";
  $("#appleSignIn").addEventListener("click", signInWithApple);

  // Cloudflare's logout URL is meaningless once Sate owns the session.
  const out = document.querySelector('.menu a[href="/cdn-cgi/access/logout"]');
  if (out) {
    out.removeAttribute("href");
    out.addEventListener("click", (ev) => {
      ev.preventDefault();
      PB.authStore.clear();
      window.location.reload();
    });
  }

  if (!AUTH.apple_configured) {
    showSignIn();
    $("#appleSignIn").disabled = true;
    const note = $("#authNote");
    note.className = "authnote err";
    note.textContent = "Sign in with Apple isn't configured on this instance.";
    return;
  }
  if (!PB.authStore.isValid) return showSignIn();
  return start();
}
boot();
