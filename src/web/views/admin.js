// Sate v2 SPA — Admin panel. A faithful port of the legacy PocketBase SPA's admin surface
// (pb_public/app.js §admin + pb_public/index.html §view-admin) into a core SPA view module.
//
// It is a TAB view: render(container) builds the whole panel scaffold into #view-admin once, then
// loadAdmin() populates it from the backend admin API. The panel keeps the original UX exactly:
//   • four section tabs — AI · Instance · Users · Data (#adminTabs → setAdminSect);
//   • every "<h3 class='section'>" becomes a collapsible header (initAdminCollapse), collapsed by
//     default; individual provider/prompt cards collapse too (collapsify);
//   • AI: providers (BYO keys), features, global defaults, per-function overrides, prompts, limits,
//     usage + editable price table;
//   • Instance: app name + default goals + build meta, PocketBase dashboard link, Backup & Sync,
//     local file backups;
//   • Users: promote/demote admins, per-user AI model + per-function overrides;
//   • Data: food database editor (photo / AI-web / barcode quick-add), nutrition sources, barcode
//     lookup keys.
//
// It also exposes maybeSetup() — the first-run admin setup wizard (name → AI key → model → features)
// — as a sheet(); app.js can call view('admin').maybeSetup() after enterApp() on an unconfigured
// instance (see the wiring note in the port report).
//
// All backend calls go to /api/admin/* (parallel-ported from the same pb_hooks handlers, so the
// request/response shapes are inherited unchanged — see adm() below and each render* function).

"use strict";

import {
  $, $$, el, esc, fmt, safeUrl, api, me, refreshMe, busy, toast,
  confirmDialog, showView, sheet, registerView,
} from "../lib.js";

// Cosmetic build badge in the Instance meta line (v1 used a bundled APP_VERSION constant).
const APP_VERSION = "v2";

// ------------------------------------------------------------------ admin API helper
// Every admin call is /api/admin/<path>. core's api() adds the bearer (cloud) or nothing (self-host
// proxy), the tz query, JSON encode/parse, and throws Error(server message) on failure.
const adm = (path, opts) => api("/api/admin" + path, opts);

// ------------------------------------------------------------------ static metadata (v1 verbatim)
const PROVIDER_META = {
  anthropic: { label: "Anthropic (Claude)", hint: "console.anthropic.com" },
  openai: { label: "OpenAI", hint: "platform.openai.com/api-keys" },
  google: { label: "Google (Gemini)", hint: "aistudio.google.com/apikey" },
  openrouter: { label: "OpenRouter", hint: "openrouter.ai/keys — one key, 300+ models" },
};
const FN_LABELS = {
  vision_estimate: "Image interpretation — photo → nutrition",
  text_parse: "Normal AI — meal text → nutrition",
  daily_summary: "Normal AI — daily recap",
  web_lookup: "Normal AI — web-search lookup",
  activity_estimate: "Normal AI — activity → calories burned",
  nutritionist: "Normal AI — nutrition coach",
  checkin: "Normal AI — proactive check-ins",
};
// The order functions appear in a user's per-function override tree.
const USER_FN_ORDER = ["text_parse", "vision_estimate", "web_lookup", "activity_estimate", "daily_summary", "nutritionist", "checkin"];
const AS_PROVIDERS = [["google", "Google Gemini"], ["anthropic", "Anthropic Claude"], ["openai", "OpenAI"], ["openrouter", "OpenRouter"]];

// ------------------------------------------------------------------ module state
let MODELS = {};        // provider -> [{id,label,vision}] (live model catalog)
let PROVIDERS = [];     // provider rows from the last admin load (for override dropdowns)
let FOOD_EDIT_ID = null;
let AS = null;          // first-run setup wizard state
let _built = false;     // scaffold built into #view-admin once

// ============================================================ scaffold markup
// The full #view-admin inner markup, ported verbatim from pb_public/index.html (§view-admin). Built
// once into the view container; every id below is unique in the document so the populate functions
// (which query by id, v1-style) resolve correctly.
const SCAFFOLD = `
<div class="seg admin-tabs" id="adminTabs">
  <button class="on" type="button" data-group="ai">AI</button>
  <button type="button" data-group="instance">Instance</button>
  <button type="button" data-group="users">Users</button>
  <button type="button" data-group="data">Data</button>
</div>

<div class="admin-sect" data-group="instance" hidden>
  <h3 class="section">Instance</h3>
  <p class="hint">Manage this Sate deployment as a whole.</p>
  <div class="card" id="instanceCard">
    <label class="field">App name<input type="text" id="appName" placeholder="Sate" /></label>
    <div class="grid4">
      <label class="field">Default kcal <input type="number" id="dg_kcal" min="0" /></label>
      <label class="field">Protein g <input type="number" id="dg_protein" min="0" /></label>
      <label class="field">Carbs g <input type="number" id="dg_carbs" min="0" /></label>
      <label class="field">Fat g <input type="number" id="dg_fat" min="0" /></label>
    </div>
    <div class="row end"><button class="primary" id="saveInstance">Save instance settings</button></div>
    <div class="meta" id="instanceMeta"></div>
  </div>
  <!--
    NO Database / Backup & Sync / Local file backups sections here — deliberately.

    They were ported from the PocketBase SPA (pb_public) along with the rest of this panel, but
    their backend never came with them: core/src/api/admin.ts has no /admin/backup* routes, and
    the whole subsystem is still PocketBase-shaped (pb_hooks/backup.js — superuser auth, a
    sate_snapshots collection, app.createBackup() zips written to /pb/pb_data/backups).

    None of that maps onto the Cloud edition, which is the only consumer of this view today:
    Firestore has no PocketBase dashboard to link to, and Cloud Run's filesystem is ephemeral so a
    zip written "to the container" would vanish. Rendering them meant an admin saw three sections
    that could not work, and loadAdmin() fired a 404 on /admin/backup on every open.

    If Cloud ever wants a backup story it should be designed for its own stack (Firestore
    scheduled exports / PITR, which are managed at the GCP level), not by porting these routes.
    The Hosted edition keeps the working implementation in pb_hooks/backup.js + pb_public.
  -->
</div>

<div class="admin-sect" data-group="ai">
  <h3 class="section">AI Providers — bring your own keys</h3>
  <p class="hint">Keys are encrypted at rest and shown only by their last 4 characters.</p>
  <div id="providers"></div>

  <h3 class="section">AI Features</h3>
  <p class="hint">Turn optional AI behaviors on or off for the whole instance.</p>
  <div class="card" id="aiFeatures">
    <label class="switch featline"><input type="checkbox" id="feat_second"> <span><b>Second opinion</b> — let users request an alternate model for coach replies &amp; food estimates</span></label>
    <label class="switch featline"><input type="checkbox" id="feat_checkins"> <span><b>Proactive check-ins</b> — Sate reviews each opted-in user's logs and messages them when it's useful (users still choose in/out &amp; frequency)</span></label>
    <div class="row end"><button class="primary small" id="saveFeatures">Save features</button></div>
  </div>

  <h3 class="section">AI Global defaults — the model every task falls back to</h3>
  <p class="hint">Set once here; every AI function inherits these unless it (or a user) overrides them. <b>Normal</b> covers text, chat, recap, activity, web lookup; <b>Image</b> is the photo→nutrition model (👁 needed). <b>Second opinion</b> is an optional alternate model users can request on demand for coach replies and food estimates.</p>
  <div id="aiGlobals"></div>

  <h3 class="section">AI Functions — per-task overrides</h3>
  <p class="hint">Each task is collapsed and set to <b>(global default)</b> by default — expand one only to pin it to a specific model, or to give it its own second-opinion model. Individual users can override these in <b>Users &amp; Admins</b> below. 👁 = supports photos.</p>
  <div id="functions"></div>

  <h3 class="section">AI Prompts — customize what each function tells the AI</h3>
  <p class="hint">Override the built-in system prompt for any function. Clear the box and save to restore the default.</p>
  <div id="prompts"></div>

  <h3 class="section">AI Limits — cap each provider by tokens or budget</h3>
  <p class="hint">Set a monthly token cap and/or a monthly $ budget per provider. When a provider is over its cap, calls routed to it fail with a clear message until you raise the limit or the month rolls over. Leave a field blank/0 for no limit.</p>
  <div id="aiLimits"></div>

  <h3 class="section">AI Usage — this month</h3>
  <p class="hint">Tokens used and estimated spend per provider this calendar month, against any caps above. Costs use the editable price table below.</p>
  <div id="aiUsage"></div>
  <details class="pricebox"><summary>Model prices (USD per 1M tokens)</summary><div id="aiPrices"></div></details>
</div>

<div class="admin-sect" data-group="users" hidden>
  <h3 class="section">Users &amp; Admins</h3>
  <p class="hint">Promote anyone on the allow-list to admin. Emails in <code>ADMIN_EMAILS</code> are always admin. Use <b>AI models</b> on any user to override the global Normal-AI or Image-interpretation model just for them.</p>
  <ul class="users" id="users"></ul>
  <div class="row" style="margin-top:10px">
    <input type="email" id="newAdminEmail" placeholder="email to make admin" />
    <button class="primary" id="addAdminBtn">Add admin</button>
  </div>
</div>

<div class="admin-sect" data-group="data" hidden>
  <h3 class="section">Food database</h3>
  <p class="hint">The AI grounds estimates on these and auto-adds new foods (unverified) as it learns. <span id="foodCount"></span></p>
  <div class="row">
    <input type="text" id="foodSearch" placeholder="search foods…" />
    <button class="primary" id="foodSearchBtn">Search</button>
  </div>
  <div class="foods" id="foodsList"></div>
  <div class="fooded">
    <h4 id="foodEditorTitle">Add food</h4>
    <p class="hint">Auto-fill from a photo, an AI web-search, or a barcode — then review and save.</p>
    <div class="foodadd">
      <button type="button" class="method" id="faPhoto"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="7" width="18" height="13" rx="3"/><circle cx="12" cy="13.5" r="3.5"/><path d="M9 7l1.5-2h3L15 7"/></svg><b>Photo</b></button>
      <button type="button" class="method" id="faWeb"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4-4M4 11h14" stroke-linecap="round"/></svg><b>AI + web</b></button>
      <button type="button" class="method" id="faBarcode"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 5v14M7 5v14M11 5v14M14 5v14M18 5v14M21 5v14"/></svg><b>Barcode</b></button>
    </div>
    <input id="faPhotoInput" type="file" accept="image/*" capture="environment" hidden />
    <input id="fBarcode" type="hidden" />
    <div class="grid2">
      <input type="text" id="fName" placeholder="name" />
      <input type="text" id="fBrand" placeholder="brand (optional)" />
    </div>
    <div class="grid2" style="margin-top:8px">
      <input type="text" id="fServing" placeholder="serving, e.g. 1 cup" />
      <input type="number" id="fServingG" placeholder="grams" />
    </div>
    <div class="grid4" style="margin-top:8px">
      <input type="number" id="fKcal" placeholder="kcal" />
      <input type="number" id="fProtein" placeholder="protein g" />
      <input type="number" id="fCarbs" placeholder="carbs g" />
      <input type="number" id="fFat" placeholder="fat g" />
    </div>
    <div class="grid2" style="margin-top:8px">
      <input type="text" id="fAliases" placeholder="aliases, comma-separated" />
      <label class="switch"><input type="checkbox" id="fVerified" /> verified</label>
    </div>
    <div class="row end" style="margin-top:10px">
      <button class="link" id="foodClearBtn">New / clear</button>
      <button class="primary" id="foodSaveBtn">Save food</button>
    </div>
  </div>

  <h3 class="section">Nutrition sources</h3>
  <p class="hint">Trusted sites the “Search the web” button prefers when a food isn’t in the database. Toggle off any you don’t trust.</p>
  <div class="sources" id="sourcesList"></div>
  <div class="fooded">
    <h4>Add source</h4>
    <div class="grid2">
      <input type="text" id="sTitle" placeholder="title, e.g. USDA FoodData Central" />
      <input type="text" id="sUrl" placeholder="https://…" />
    </div>
    <div class="grid2" style="margin-top:8px">
      <input type="text" id="sNotes" placeholder="notes (optional)" />
      <label class="switch"><input type="checkbox" id="sEnabled" checked /> enabled</label>
    </div>
    <div class="row end" style="margin-top:10px">
      <button class="primary" id="sourceSaveBtn">Add source</button>
    </div>
  </div>

  <h3 class="section">Barcode lookup sources</h3>
  <p class="hint">When a scanned barcode isn’t in the food database, Sate queries these in order. Open Food Facts needs no key; add keys to widen coverage. Keys are shown only by their last 4.</p>
  <div class="fooded">
    <label class="field">USDA FoodData Central API key — free at <code>fdc.nal.usda.gov/api-key-signup</code>; blank uses the shared demo key (low limits)
      <input type="password" id="lk_usda" placeholder="paste key, or leave blank for DEMO_KEY" />
    </label>
    <div class="grid2" style="margin-top:8px">
      <label class="field">Nutritionix App ID <input type="text" id="lk_nix_id" placeholder="x-app-id" /></label>
      <label class="field">Nutritionix App Key <input type="password" id="lk_nix_key" placeholder="x-app-key" /></label>
    </div>
    <div class="grid2" style="margin-top:8px">
      <label class="field">FatSecret Client ID <input type="text" id="lk_fs_id" placeholder="client id" /></label>
      <label class="field">FatSecret Client Secret <input type="password" id="lk_fs_secret" placeholder="client secret" /></label>
    </div>
    <p class="hint" style="margin-top:14px">Identity fallback — when no nutrition source has the barcode, these name the product so the AI can <em>estimate</em> its macros (saved unverified). UPCitemdb works with no key.</p>
    <label class="field">UPCitemdb API key <span class="muted">(optional — blank uses the free trial endpoint)</span>
      <input type="password" id="lk_upc" placeholder="leave blank to use the free trial tier" />
    </label>
    <div class="grid2" style="margin-top:8px">
      <label class="field">Go-UPC API key <input type="password" id="lk_goupc" placeholder="bearer key" /></label>
      <label class="field">Barcode Lookup API key <input type="password" id="lk_bclookup" placeholder="api key" /></label>
    </div>
    <div class="row end" style="margin-top:10px">
      <button class="primary" id="lookupSaveBtn">Save lookup sources</button>
    </div>
    <div class="meta" id="lookupMeta"></div>
  </div>
</div>`;

// ============================================================ collapse helpers
// Turn every "<h3 class='section'>" in an .admin-sect into a collapsible header (collapsed by
// default) wrapping everything up to the next section. Runs once (guarded via dataset).
function initAdminCollapse() {
  const root = $("#view-admin");
  if (!root || root.dataset.collapsed) return;
  root.dataset.collapsed = "1";
  $$(".admin-sect").forEach((sect) => {
    const kids = Array.prototype.slice.call(sect.children);
    for (let i = 0; i < kids.length; i++) {
      const h = kids[i];
      if (!(h.tagName === "H3" && h.classList.contains("section"))) continue;
      const body = el("div", { class: "sect-body" });
      body.hidden = true;
      let j = i + 1;
      while (j < kids.length && !(kids[j].tagName === "H3" && kids[j].classList.contains("section"))) { body.appendChild(kids[j]); j++; }
      h.classList.add("sect-h");
      h.insertAdjacentHTML("afterbegin", '<span class="sect-chev">▸</span> ');
      h.addEventListener("click", () => { body.hidden = !body.hidden; h.querySelector(".sect-chev").textContent = body.hidden ? "▸" : "▾"; });
      h.after(body);
    }
  });
}

// Make a single card collapsible: `head` becomes the clickable toggle (gets a chevron) for a body
// wrapping `bodyNodes`, collapsed by default. Clicks on controls inside the head don't toggle.
function collapsify(head, bodyNodes) {
  const body = el("div", { class: "sect-body" });
  body.hidden = true;
  bodyNodes.forEach((n) => n && body.appendChild(n));
  head.classList.add("sect-h");
  head.insertAdjacentHTML("afterbegin", '<span class="sect-chev">▸</span> ');
  head.addEventListener("click", (e) => {
    if (e.target.closest("input,button,select,textarea,label,a")) return;
    body.hidden = !body.hidden;
    head.querySelector(".sect-chev").textContent = body.hidden ? "▸" : "▾";
  });
  return body;
}

// ---- Admin section tabs (AI / Instance / Users / Data) ----
function setAdminSect(group) {
  $$("#adminTabs button").forEach((b) => b.classList.toggle("on", b.dataset.group === group));
  $$(".admin-sect").forEach((s) => (s.hidden = s.dataset.group !== group));
}

// ============================================================ top-level load
async function loadAdmin() {
  initAdminCollapse();
  try {
    const [{ providers }, { functions }, usersResp, settingsResp] = await Promise.all([
      adm("/providers"), adm("/functions"), adm("/users"), adm("/settings"),
    ]);
    PROVIDERS = providers;
    renderInstance(settingsResp);
    renderProviders(providers);
    // Fetch live model lists for any provider that has a key.
    MODELS = {};
    await Promise.all(
      providers.filter((p) => p.key_set).map(async (p) => {
        try { const r = await adm("/models?provider=" + p.name); MODELS[p.name] = r.models || []; }
        catch (_) { MODELS[p.name] = []; }
      }),
    );
    renderGlobals(settingsResp.settings);
    renderFeatures(settingsResp.settings);
    renderFunctions(functions, providers);
    renderUsers(usersResp.users);
    loadFoods("");
    loadSources();
    loadPrompts();
    loadLookup();
    loadAiLimits();
    loadAiUsage();
    loadAiPrices();
  } catch (e) {
    toast("Couldn’t load admin: " + e.message);
  }
}

// ============================================================ instance settings
function renderInstance(s) {
  const set = s.settings || {};
  $("#appName").value = set.app_name || "";
  $("#dg_kcal").value = set.default_goal_kcal || "";
  $("#dg_protein").value = set.default_goal_protein || "";
  $("#dg_carbs").value = set.default_goal_carbs || "";
  $("#dg_fat").value = set.default_goal_fat || "";
  $("#instanceMeta").innerHTML =
    `<span class="badge">build ${APP_VERSION}</span> ` +
    `<span class="badge">host ${esc(location.host)}</span> ` +
    `<span class="badge">auth header ${esc(s.auth_header || "")}</span> ` +
    `<span class="badge">env admins: ${(s.env_admins || []).map(esc).join(", ") || "none"}</span>`;
}

async function saveInstance() {
  const payload = {
    app_name: $("#appName").value.trim() || "Sate",
    default_goal_kcal: $("#dg_kcal").value || 0,
    default_goal_protein: $("#dg_protein").value || 0,
    default_goal_carbs: $("#dg_carbs").value || 0,
    default_goal_fat: $("#dg_fat").value || 0,
  };
  try {
    await adm("/settings", { method: "PUT", json: payload });
    document.title = payload.app_name + " — calorie chat";
    $("#brandName").textContent = payload.app_name;
    toast("Instance settings saved");
  } catch (e) { toast(e.message); }
}

// ============================================================ AI limits / usage / prices
async function loadAiLimits() {
  const wrap = $("#aiLimits");
  if (!wrap) return;
  let limits = [];
  try { limits = (await adm("/limits")).limits || []; } catch (e) { wrap.innerHTML = `<p class="hint">${esc(e.message)}</p>`; return; }
  wrap.innerHTML = "";
  limits.forEach((l) => {
    const meta = PROVIDER_META[l.provider] || { label: l.provider };
    const row = el("div", { class: "limitrow", html:
      `<div class="limithead">${esc(meta.label)}</div>` +
      `<div class="grid2">` +
      `<label class="field">Monthly token cap <input type="number" min="0" step="1000" data-k="monthly_tokens" value="${l.monthly_tokens || ""}" placeholder="unlimited" /></label>` +
      `<label class="field">Monthly budget (USD) <input type="number" min="0" step="0.5" data-k="usd_budget" value="${l.usd_budget || ""}" placeholder="unlimited" /></label>` +
      `</div>` +
      `<div class="row end"><button class="primary small" data-save>Save</button></div>` });
    row.querySelector("[data-save]").onclick = async () => {
      const payload = {
        provider: l.provider,
        monthly_tokens: +row.querySelector('[data-k="monthly_tokens"]').value || 0,
        usd_budget: +row.querySelector('[data-k="usd_budget"]').value || 0,
      };
      try { await adm("/limit", { method: "POST", json: payload }); toast(l.provider + " limit saved"); loadAiUsage(); }
      catch (e) { toast(e.message); }
    };
    wrap.appendChild(row);
  });
}

async function loadAiUsage() {
  const wrap = $("#aiUsage");
  if (!wrap) return;
  let rows = [];
  try { rows = (await adm("/usage")).providers || []; } catch (e) { wrap.innerHTML = `<p class="hint">${esc(e.message)}</p>`; return; }
  const n = (x) => (x || 0).toLocaleString();
  wrap.innerHTML = rows.map((r) => {
    const meta = PROVIDER_META[r.provider] || { label: r.provider };
    const capTok = r.limit.monthly_tokens || 0, capUsd = r.limit.usd_budget || 0;
    const tokPart = capTok ? `${n(r.tokens)} / ${n(capTok)} tok` : `${n(r.tokens)} tok`;
    const usdPart = capUsd ? `$${r.cost_usd.toFixed(2)} / $${capUsd.toFixed(2)}` : `$${r.cost_usd.toFixed(2)}`;
    const over = (capTok && r.tokens >= capTok) || (capUsd && r.cost_usd >= capUsd);
    return `<div class="usagerow${over ? " over" : ""}"><span class="up">${esc(meta.label)}</span>` +
      `<span class="um">${tokPart} · ${usdPart} · ${n(r.calls)} calls${over ? " · <b>over limit</b>" : ""}</span></div>`;
  }).join("") || '<p class="hint">No AI usage recorded yet this month.</p>';
}

async function loadAiPrices() {
  const wrap = $("#aiPrices");
  if (!wrap) return;
  let prices = [];
  try { prices = (await adm("/prices")).prices || []; } catch (_) { prices = []; }
  prices.sort((a, b) => (a.provider + a.model < b.provider + b.model ? -1 : 1));
  wrap.innerHTML =
    `<div class="pricerow head"><span>Provider</span><span>Model</span><span>In $/1M</span><span>Out $/1M</span><span></span></div>` +
    prices.map((p, i) =>
      `<div class="pricerow" data-i="${i}"><span>${esc(p.provider)}</span><span class="pm">${esc(p.model)}</span>` +
      `<input type="number" step="0.01" min="0" data-k="in_usd" value="${p.in_usd}" />` +
      `<input type="number" step="0.01" min="0" data-k="out_usd" value="${p.out_usd}" />` +
      `<button class="link" data-save>Save</button></div>`,
    ).join("") +
    `<div class="pricerow add"><input type="text" id="npProv" placeholder="provider" /><input type="text" id="npModel" placeholder="model id" />` +
    `<input type="number" step="0.01" id="npIn" placeholder="in" /><input type="number" step="0.01" id="npOut" placeholder="out" />` +
    `<button class="link" id="npAdd">Add</button></div>`;
  wrap.querySelectorAll(".pricerow[data-i] [data-save]").forEach((btn) => {
    btn.onclick = async () => {
      const row = btn.closest(".pricerow"); const p = prices[+row.dataset.i];
      try {
        await adm("/price", { method: "POST", json: {
          provider: p.provider, model: p.model,
          in_usd: row.querySelector('[data-k="in_usd"]').value, out_usd: row.querySelector('[data-k="out_usd"]').value,
        } });
        toast("price saved"); loadAiUsage();
      } catch (e) { toast(e.message); }
    };
  });
  const add = wrap.querySelector("#npAdd");
  if (add) add.onclick = async () => {
    const prov = $("#npProv").value.trim(), model = $("#npModel").value.trim();
    if (!prov || !model) { toast("provider and model required"); return; }
    try {
      await adm("/price", { method: "POST", json: { provider: prov, model: model, in_usd: $("#npIn").value, out_usd: $("#npOut").value } });
      toast("price added"); loadAiPrices(); loadAiUsage();
    } catch (e) { toast(e.message); }
  };
}

// ============================================================ barcode lookup sources
async function loadLookup() {
  let r;
  try { r = await adm("/lookup"); } catch (e) { return; }
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
  try { await adm("/lookup", { method: "PUT", json: payload }); toast("Lookup sources saved"); loadLookup(); }
  catch (e) { toast(e.message); }
}

// ============================================================ editable AI prompts
async function loadPrompts() {
  let r;
  try { r = await adm("/prompts"); } catch (e) { toast(e.message); return; }
  const wrap = $("#prompts");
  wrap.innerHTML = "";
  r.prompts.forEach((p) => wrap.appendChild(promptCard(p)));
}

function promptCard(p) {
  const card = el("div", { class: "prompt" });
  const head = el("div", { class: "prompt-head", html:
    `<span class="fname">${esc(p.label)}</span>` +
    (p.customized ? ' <span class="fbadge web">customized</span>' : ' <span class="fbadge">default</span>') });
  const ta = el("textarea", { class: "prompt-ta", rows: "5", placeholder: "System prompt…" });
  ta.value = p.override || p.default;
  const reset = el("button", { class: "link", onClick: () => { ta.value = p.default; savePrompt(p.fn, ""); } }, "Reset to default");
  const save = el("button", { class: "primary", onClick: () => savePrompt(p.fn, ta.value.trim() === p.default.trim() ? "" : ta.value) }, "Save");
  const actions = el("div", { class: "row end" }, reset, save);
  card.appendChild(head);
  card.appendChild(collapsify(head, [ta, actions])); // each prompt collapsed by default
  return card;
}

async function savePrompt(fn, text) {
  try {
    const r = await adm("/prompts", { method: "PUT", json: { fn, text } });
    toast(r.reset ? "Reset to default" : "Prompt saved");
    loadPrompts();
  } catch (e) { toast(e.message); }
}

// ============================================================ model pickers
// Live model catalog per provider → a native <select>. Always keeps the saved model as an option,
// and adds an "Other…" escape hatch for a model the live list doesn't include.
function modelSelectHTML(provider, selected, attrs) {
  const list = MODELS[provider] || [];
  const ids = list.map((m) => m.id);
  let opts = "";
  if (!ids.length) {
    opts += `<option value="${esc(selected || "")}">${selected ? esc(selected) : "— set this provider's API key to load models —"}</option>`;
  } else {
    if (selected && ids.indexOf(selected) === -1)
      opts += `<option value="${esc(selected)}" selected>${esc(selected)} (saved)</option>`;
    opts += list
      .map((m) => `<option value="${esc(m.id)}" ${m.id === selected ? "selected" : ""}>${m.vision ? "👁 " : ""}${esc(m.label || m.id)}</option>`)
      .join("");
  }
  opts += `<option value="__custom__">Other — type a model id…</option>`;
  return `<select ${attrs || 'data-k="model"'}>${opts}</select>`;
}

// Wire a model <select>: picking "Other…" prompts for a custom model id and adds it as an option.
function wireModelSelect(sel, fallback) {
  if (!sel) return;
  sel.addEventListener("change", () => {
    if (sel.value !== "__custom__") return;
    const v = (window.prompt("Enter a model id:", "") || "").trim();
    if (v) {
      let o = Array.prototype.find.call(sel.options, (x) => x.value === v);
      if (!o) { o = el("option", { value: v }, v); sel.insertBefore(o, sel.options[sel.options.length - 1]); }
      sel.value = v;
    } else { sel.value = fallback || ""; }
  });
}

async function fetchModelsIfNeeded(prov) {
  if (MODELS[prov]) return;
  try { const r = await adm("/models?provider=" + prov); MODELS[prov] = r.models || []; }
  catch (_) { MODELS[prov] = []; }
}

function provOptions(selected, emptyLabel) {
  return `<option value="">${esc(emptyLabel || "(global default)")}</option>` +
    PROVIDERS.map((p) => `<option value="${p.name}" ${selected === p.name ? "selected" : ""}>${p.name}</option>`).join("");
}

// A linked provider+model picker rendered into `host`. Returns { get: () => ({provider, model}) }.
function buildModelPicker(host, provider, model, emptyLabel) {
  host.innerHTML =
    `<select class="mp-prov">${provOptions(provider, emptyLabel)}</select>` +
    `<span class="mp-model model-cell"></span>`;
  const sel = host.querySelector(".mp-prov");
  const cell = host.querySelector(".mp-model");
  const renderCell = async (cur) => {
    if (!sel.value) { cell.innerHTML = `<span class="muted">${esc(emptyLabel || "(global default)")}</span>`; return; }
    await fetchModelsIfNeeded(sel.value);
    cell.innerHTML = modelSelectHTML(sel.value, cur || "");
    wireModelSelect(cell.querySelector("select"), cur || "");
  };
  sel.addEventListener("change", () => renderCell(""));
  renderCell(model);
  return {
    get: () => {
      const p = sel.value.trim();
      const ms = cell.querySelector("select");
      const m = ms && ms.value !== "__custom__" ? ms.value : "";
      return { provider: p, model: p ? m : "" };
    },
  };
}

// ============================================================ AI features + globals
function renderFeatures(settings) {
  const s = settings || {};
  const sec = $("#feat_second"), chk = $("#feat_checkins");
  if (sec) sec.checked = s.second_opinion_enabled !== "off";
  if (chk) chk.checked = s.checkins_enabled !== "off";
}
async function saveFeatures() {
  const payload = {
    second_opinion_enabled: $("#feat_second").checked ? "on" : "off",
    checkins_enabled: $("#feat_checkins").checked ? "on" : "off",
  };
  try { await adm("/settings", { method: "PUT", json: payload }); toast("Features saved"); }
  catch (e) { toast(e.message); }
}

// The four instance-wide AI defaults: Normal/Image × Primary/Second opinion.
function renderGlobals(settings) {
  const wrap = $("#aiGlobals");
  if (!wrap) return;
  const s = settings || {};
  wrap.innerHTML = "";
  const rows = [
    { label: "Normal · Primary", pk: "default_ai_provider", mk: "default_ai_model" },
    { label: "Normal · Second opinion", pk: "second_ai_provider", mk: "second_ai_model" },
    { label: "Image · Primary", pk: "default_vision_provider", mk: "default_vision_model" },
    { label: "Image · Second opinion", pk: "second_vision_provider", mk: "second_vision_model" },
  ];
  const pickers = [];
  rows.forEach((r) => {
    const row = el("div", { class: "gdef-row", html: `<span class="gdef-label">${r.label}</span><span class="gdef-picker mp"></span>` });
    const p = buildModelPicker(row.querySelector(".gdef-picker"), s[r.pk] || "", s[r.mk] || "", "(none set)");
    pickers.push({ r, p });
    wrap.appendChild(row);
  });
  const save = el("button", { class: "primary", style: { marginTop: "8px" }, onClick: async () => {
    const payload = {};
    pickers.forEach(({ r, p }) => { const v = p.get(); payload[r.pk] = v.provider; payload[r.mk] = v.model; });
    try { await adm("/settings", { method: "PUT", json: payload }); toast("Global defaults saved"); }
    catch (e) { toast(e.message); }
  } }, "Save global defaults");
  wrap.appendChild(save);
}

// ============================================================ AI functions (per-task overrides)
function renderFunctions(functions, providers) {
  const wrap = $("#functions");
  wrap.innerHTML = "";
  functions.forEach((fn) => {
    const needsVision = fn.fn === "vision_estimate";
    const summary = fn.provider ? `${fn.provider} · ${fn.model || "?"}` : "(global default)";
    const card = el("div", { class: "fn fncard", html:
      `<button type="button" class="fnhead" data-toggle>` +
      `<span class="fnchevron">▸</span>` +
      `<span class="fntitle">${FN_LABELS[fn.fn] || fn.fn}${needsVision ? ' <span class="badge">👁</span>' : ""}</span>` +
      `<span class="fnsummary muted">${esc(summary)}</span>` +
      `<span class="fnenabled">${fn.enabled ? "" : '<span class="badge warn">off</span>'}</span>` +
      `</button>` +
      `<div class="fnbody" hidden>` +
      `<label class="mp-lbl">Primary <span class="muted">— blank = global default</span></label>` +
      `<span class="mp fn-primary"></span>` +
      `<label class="mp-lbl">Second opinion <span class="muted">— optional; users request it on demand</span></label>` +
      `<span class="mp fn-second"></span>` +
      `<div class="row between" style="margin-top:10px">` +
      `<label class="switch"><input type="checkbox" data-k="enabled" ${fn.enabled ? "checked" : ""}/> enabled</label>` +
      `<button class="primary small" data-save>Save</button>` +
      `</div>` +
      `</div>` });
    const body = card.querySelector(".fnbody");
    const head = card.querySelector("[data-toggle]");
    const chevron = card.querySelector(".fnchevron");
    let built = false;
    let primary, second;
    head.onclick = () => {
      body.hidden = !body.hidden;
      chevron.textContent = body.hidden ? "▸" : "▾";
      if (!body.hidden && !built) {
        built = true;
        primary = buildModelPicker(card.querySelector(".fn-primary"), fn.provider || "", fn.model || "", "(global default)");
        second = buildModelPicker(card.querySelector(".fn-second"), fn.second_provider || "", fn.second_model || "", "(global default)");
      }
    };
    card.querySelector("[data-save]").onclick = async () => {
      const p = primary ? primary.get() : { provider: fn.provider, model: fn.model };
      const sc = second ? second.get() : { provider: fn.second_provider, model: fn.second_model };
      const payload = {
        fn: fn.fn,
        provider: p.provider, model: p.model,
        second_provider: sc.provider, second_model: sc.model,
        enabled: card.querySelector('[data-k="enabled"]').checked,
      };
      try { await adm("/functions", { method: "PUT", json: payload }); toast((FN_LABELS[fn.fn] || fn.fn) + " saved"); loadAdmin(); }
      catch (e) { toast(e.message); }
    };
    wrap.appendChild(card);
  });
}

// ============================================================ AI providers
function renderProviders(providers) {
  const wrap = $("#providers");
  wrap.innerHTML = "";
  providers.forEach((p) => {
    const meta = PROVIDER_META[p.name] || { label: p.name, hint: "" };
    const card = el("div", { class: "prov", html:
      `<h4>${esc(meta.label)}${meta.hint ? ` <span class="prov-hint">${esc(meta.hint)}</span>` : ""}</h4>` +
      `<div class="grid">` +
      `<input type="password" placeholder="${p.key_set ? "Key set — " + p.key_hint : "Paste API key"}" data-k="key" />` +
      `<label class="switch"><input type="checkbox" data-k="enabled" ${p.enabled ? "checked" : ""}/> enabled</label>` +
      `</div>` +
      `<div class="grid" style="margin-top:8px">` +
      `<input type="text" placeholder="Base URL (optional)" value="${esc(p.base_url || "")}" data-k="base_url" />` +
      `<button class="primary" data-save>Save</button>` +
      `</div>` });
    card.querySelector("[data-save]").onclick = async () => {
      const key = card.querySelector('[data-k="key"]').value.trim();
      const payload = {
        name: p.name,
        enabled: card.querySelector('[data-k="enabled"]').checked,
        base_url: card.querySelector('[data-k="base_url"]').value.trim(),
      };
      if (key) payload.api_key = key;
      try { await adm("/providers", { method: "PUT", json: payload }); toast(p.name + " saved"); loadAdmin(); }
      catch (e) { toast(e.message); }
    };
    // Collapse each provider under its name (a "key set" badge stays visible in the header).
    const head = card.querySelector("h4");
    if (p.key_set) head.insertAdjacentHTML("beforeend", ' <span class="fbadge web">key set</span>');
    card.appendChild(collapsify(head, Array.prototype.slice.call(card.querySelectorAll(".grid"))));
    wrap.appendChild(card);
  });
}

// ============================================================ users & admins
// A labeled provider+model picker line inside a user's override area.
function userPickerRow(host, label, provider, model) {
  const row = el("div", { class: "uov-line", html: `<label class="mp-lbl">${esc(label)}</label><span class="mp uov-picker"></span>` });
  host.appendChild(row);
  return buildModelPicker(row.querySelector(".uov-picker"), provider || "", model || "", "(global default)");
}

function renderUsers(users) {
  const ul = $("#users");
  ul.innerHTML = "";
  users.forEach((u) => {
    const badge = u.env_admin
      ? '<span class="badge lock">env-admin</span>'
      : `<span class="badge ${u.role === "admin" ? "adminb" : ""}">${u.role}</span>`;
    const fnOv = u.fn_overrides || {};
    const hasOv = u.ov_ai_provider || u.ov_vision_provider || u.ov_ai_second_provider ||
      u.ov_vision_second_provider || Object.keys(fnOv).length;
    const li = el("li", { class: "u", html: `<span class="uemail">${esc(u.email)}${hasOv ? ' <span class="badge">custom AI</span>' : ""}</span>` });
    const right = el("span", { class: "urow-right", html: badge });
    if (!u.env_admin) {
      const btn = el("button", { class: "link", onClick: () => setRole(u.email, u.role === "admin" ? "user" : "admin") },
        u.role === "admin" ? "demote" : "make admin");
      right.appendChild(btn);
    }
    // AI model overrides (collapsed by default). Collects pickers into a registry the save reads.
    const ov = el("div", { class: "uoverrides" });
    ov.hidden = true;
    const reg = { globals: {}, fns: {}, original: fnOv };

    const gWrap = el("div");
    reg.globals.ai = userPickerRow(gWrap, "Normal · Primary", u.ov_ai_provider, u.ov_ai_model);
    reg.globals.ai_second = userPickerRow(gWrap, "Normal · Second opinion", u.ov_ai_second_provider, u.ov_ai_second_model);
    reg.globals.vision = userPickerRow(gWrap, "Image · Primary", u.ov_vision_provider, u.ov_vision_model);
    reg.globals.vision_second = userPickerRow(gWrap, "Image · Second opinion", u.ov_vision_second_provider, u.ov_vision_second_model);
    ov.appendChild(gWrap);

    // Nested, collapsed "AI Functions" tree — one collapsed row per function (primary + second).
    const fnsWrap = el("div", { class: "ufns" });
    const fnsHead = el("button", { type: "button", class: "ufns-head", html: `<span class="fnchevron">▸</span> AI Functions — per-function override` });
    const fnsBody = el("div", { class: "ufns-body" });
    fnsBody.hidden = true;
    fnsHead.onclick = () => {
      fnsBody.hidden = !fnsBody.hidden;
      fnsHead.querySelector(".fnchevron").textContent = fnsBody.hidden ? "▸" : "▾";
    };
    USER_FN_ORDER.forEach((fnKey) => {
      const cur = fnOv[fnKey] || {};
      const card = el("div", { class: "ufn" });
      const set = cur.p || cur.sp;
      const cHead = el("button", { type: "button", class: "ufn-head", html:
        `<span class="fnchevron">▸</span> <span class="ufn-title">${esc(FN_LABELS[fnKey] || fnKey)}</span>${set ? ' <span class="badge">set</span>' : ""}` });
      const cBody = el("div", { class: "ufn-body" });
      cBody.hidden = true;
      let built = false, prim, sec;
      cHead.onclick = () => {
        cBody.hidden = !cBody.hidden;
        cHead.querySelector(".fnchevron").textContent = cBody.hidden ? "▸" : "▾";
        if (!cBody.hidden && !built) {
          built = true;
          prim = userPickerRow(cBody, "Primary", cur.p, cur.m);
          sec = userPickerRow(cBody, "Second opinion", cur.sp, cur.sm);
          reg.fns[fnKey] = { get: () => ({ prim: prim.get(), sec: sec.get() }) };
        }
      };
      card.appendChild(cHead);
      card.appendChild(cBody);
      fnsBody.appendChild(card);
    });
    fnsWrap.appendChild(fnsHead);
    fnsWrap.appendChild(fnsBody);
    ov.appendChild(fnsWrap);

    const save = el("button", { class: "primary small", style: { marginTop: "10px" }, onClick: () => saveUserModels(u.email, reg) }, "Save overrides");
    ov.appendChild(save);

    const toggle = el("button", { class: "link", onClick: () => { ov.hidden = !ov.hidden; } }, "AI models");
    right.appendChild(toggle);

    li.appendChild(right);
    li.appendChild(ov);
    ul.appendChild(li);
  });
}

async function saveUserModels(email, reg) {
  const g = reg.globals;
  const ai = g.ai.get(), aiS = g.ai_second.get(), vi = g.vision.get(), viS = g.vision_second.get();
  const payload = {
    email: email,
    ov_ai_provider: ai.provider, ov_ai_model: ai.model,
    ov_ai_second_provider: aiS.provider, ov_ai_second_model: aiS.model,
    ov_vision_provider: vi.provider, ov_vision_model: vi.model,
    ov_vision_second_provider: viS.provider, ov_vision_second_model: viS.model,
  };
  // The server replaces fn_overrides wholesale, so start from the untouched originals and apply only
  // the function cards the admin actually expanded (the only ones with live pickers). An expanded
  // card that was cleared removes that function's override.
  const merged = Object.assign({}, reg.original || {});
  Object.keys(reg.fns).forEach((fnKey) => {
    const v = reg.fns[fnKey].get();
    const row = { p: v.prim.provider, m: v.prim.model, sp: v.sec.provider, sm: v.sec.model };
    if (row.p || row.m || row.sp || row.sm) merged[fnKey] = row;
    else delete merged[fnKey];
  });
  payload.fn_overrides = merged;
  try {
    await adm("/users/models", { method: "PUT", json: payload });
    toast("AI overrides saved for " + email);
    loadAdmin();
  } catch (e) { toast(e.message); }
}

async function setRole(email, role) {
  try {
    await adm("/users/role", { method: "PUT", json: { email, role } });
    toast(email + " → " + role);
    loadAdmin();
  } catch (e) { toast(e.message); }
}

function addAdmin() {
  const email = $("#newAdminEmail").value.trim().toLowerCase();
  if (!email || email.indexOf("@") === -1) return toast("enter a valid email");
  $("#newAdminEmail").value = "";
  setRole(email, "admin");
}

// ============================================================ food database
async function loadFoods(q) {
  let r;
  try { r = await adm("/foods" + (q ? "?q=" + encodeURIComponent(q) : "")); }
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
  const brand = f.brand ? ` · ${esc(f.brand)}` : "";
  const src = esc(f.source || "");
  const badges =
    `<span class="fbadge ${src}">${src}</span>` +
    (f.verified ? "" : ' <span class="fbadge warn">unverified</span>');
  const macros = `${fmt(f.protein)}P · ${fmt(f.carbs)}C · ${fmt(f.fat)}F`;
  const serv = esc(f.serving_desc || "1 serving");
  const body = el("div", { class: "fbody", html:
    `<div class="fname">${esc(f.name)}${brand} ${badges}</div>` +
    `<div class="fsub">${serv} · ${macros} · used ${fmt(f.usage_count)}×</div>` });
  const kcal = el("div", { class: "fkcal", text: String(fmt(f.kcal)) });
  const edit = el("button", { class: "fx", title: "edit", onClick: () => fillFoodEditor(f) }, "✎");
  const del = el("button", { class: "fx danger", title: "delete", onClick: () => deleteFood(f) }, "✕");
  return el("div", { class: "food" }, body, kcal, edit, del);
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
  if ($("#fBarcode")) $("#fBarcode").value = f.barcode || "";
  $("#foodEditorTitle").scrollIntoView({ behavior: "smooth", block: "nearest" });
}

// Merge AI/barcode-derived fields into the editor without wiping the id/verified state.
function prefillFoodEditor(f, msg) {
  if (f.name) $("#fName").value = f.name;
  if (f.brand) $("#fBrand").value = f.brand;
  if (f.serving_desc) $("#fServing").value = f.serving_desc;
  if (f.serving_g) $("#fServingG").value = f.serving_g;
  if (f.kcal !== undefined) $("#fKcal").value = f.kcal;
  if (f.protein !== undefined) $("#fProtein").value = f.protein;
  if (f.carbs !== undefined) $("#fCarbs").value = f.carbs;
  if (f.fat !== undefined) $("#fFat").value = f.fat;
  if (f.barcode && $("#fBarcode")) $("#fBarcode").value = f.barcode;
  $("#foodEditorTitle").scrollIntoView({ behavior: "smooth", block: "nearest" });
  toast(msg || "Filled — review, mark verified, and Save");
}

// Admin quick-add: photo → vision AI.
async function adminFoodPhoto(file) {
  const dataUrl = await new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.onerror = rej; fr.readAsDataURL(file); });
  toast("Reading photo…");
  try {
    const r = await adm("/foods/estimate", { method: "POST", json: { method: "photo", image: dataUrl } });
    prefillFoodEditor(r.food, "Filled from photo — review & Save");
  } catch (e) { toast(e.message); }
}
// Admin quick-add: name → AI web-search lookup.
async function adminFoodWeb() {
  const name = ($("#fName").value || window.prompt("Food name to look up?", "") || "").trim();
  if (!name) return;
  $("#fName").value = name;
  busy("Searching the web…");
  try {
    const r = await adm("/foods/estimate", { method: "POST", json: { method: "web", text: name } });
    prefillFoodEditor(r.food, "Filled from web search — review & Save");
  } catch (e) { toast(e.message); }
}
// Admin quick-add: enter a barcode → product lookup. (Web build has no camera scanner here; the
// compose flow owns the html5-qrcode scanner — admin uses a manual prompt, matching that simplification.)
function adminFoodBarcode() {
  const code = (window.prompt("Enter the barcode number:", "") || "").replace(/[^0-9]/g, "");
  if (!code) return;
  (async () => {
    toast("Looking up " + code + "…");
    try {
      const r = await adm("/foods/barcode", { method: "POST", json: { barcode: code } });
      prefillFoodEditor(r.food, "Found via " + (r.via || "lookup") + " — review & Save");
    } catch (e) { toast(e.message); }
  })();
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
    barcode: ($("#fBarcode") && $("#fBarcode").value) || undefined,
  };
  try {
    await adm("/foods", { method: "PUT", json: payload });
    toast(FOOD_EDIT_ID ? "Food updated" : "Food added");
    clearFoodEditor();
    loadFoods($("#foodSearch").value.trim());
  } catch (e) { toast(e.message); }
}

async function deleteFood(f) {
  const ok = await confirmDialog(`Delete “${f.name}” from the food database?`, { confirmLabel: "Delete", danger: true });
  if (!ok) return;
  try {
    await adm("/foods/" + f.id, { method: "DELETE" });
    if (FOOD_EDIT_ID === f.id) clearFoodEditor();
    loadFoods($("#foodSearch").value.trim());
  } catch (e) { toast(e.message); }
}

// ============================================================ nutrition sources
async function loadSources() {
  let r;
  try { r = await adm("/sources"); } catch (e) { toast(e.message); return; }
  const wrap = $("#sourcesList");
  wrap.innerHTML = "";
  if (!r.sources.length) { wrap.innerHTML = '<div class="hint">No sources yet.</div>'; return; }
  r.sources.forEach((s) => wrap.appendChild(sourceRow(s)));
}

function sourceRow(s) {
  const body = el("div", { class: "fbody", html:
    `<div class="fname">${esc(s.title)}</div>` +
    `<div class="fsub"><a href="${esc(safeUrl(s.url))}" target="_blank" rel="noopener">${esc(s.domain || s.url)}</a>` +
    (s.notes ? ` · ${esc(s.notes)}` : "") + `</div>` });
  const cb = el("input", { type: "checkbox" });
  cb.checked = s.enabled;
  cb.onchange = () => saveSource({ id: s.id, title: s.title, url: s.url, notes: s.notes, enabled: cb.checked }, true);
  const toggle = el("label", { class: "switch" }, cb);
  const del = el("button", { class: "fx danger", title: "delete", onClick: () => deleteSource(s) }, "✕");
  return el("div", { class: "source" + (s.enabled ? "" : " off") }, body, toggle, del);
}

async function saveSource(payload, quiet) {
  try {
    await adm("/sources", { method: "PUT", json: payload });
    if (!quiet) {
      $("#sTitle").value = ""; $("#sUrl").value = ""; $("#sNotes").value = ""; $("#sEnabled").checked = true;
      toast("Source added");
    }
    loadSources();
  } catch (e) { toast(e.message); }
}

async function deleteSource(s) {
  const ok = await confirmDialog(`Remove “${s.title}” from your nutrition sources?`, { confirmLabel: "Remove", danger: true });
  if (!ok) return;
  try { await adm("/sources/" + s.id, { method: "DELETE" }); loadSources(); }
  catch (e) { toast(e.message); }
}

// ============================================================ first-run setup wizard
// name → first AI key → default model → feature toggles, using the same admin endpoints, then marks
// setup complete. Rendered as a non-dismissable sheet(). Call maybeSetup() after enterApp().
function asNavBar(back, nextLabel, canNext) {
  return '<div class="ob-nav">' +
    (back ? '<button type="button" class="link" id="asBack">Back</button>' : "<span></span>") +
    `<button type="button" class="primary" id="asNext"${canNext === false ? " disabled" : ""}>${nextLabel || "Next"}</button></div>`;
}
const AS_STEP = {
  welcome: () => `<img class="ob-logo" src="/icons/icon-192.png?v2" alt="Sate">` +
    '<h2 style="text-align:center">Set up your instance</h2>' +
    '<p class="ob-sub" style="text-align:center">A few quick steps to get Sate running: name it, add an AI key, pick a default model.</p>' +
    `<label class="ob-full">Instance name<input type="text" id="asName" value="${esc(AS.app_name)}" placeholder="Sate"></label>` +
    asNavBar(false, "Get started"),
  provider: () => '<h2>Add an AI provider</h2><p class="ob-sub">Bring your own key. You can add more later in Admin.</p>' +
    `<label class="ob-full">Provider<select id="asProv">${AS_PROVIDERS.map(([v, l]) => `<option value="${v}"${AS.provider === v ? " selected" : ""}>${l}</option>`).join("")}</select></label>` +
    `<label class="ob-full" style="margin-top:10px">API key<input type="password" id="asKey" value="${esc(AS.api_key)}" placeholder="paste your key" autocomplete="off"></label>` +
    asNavBar(true, "Add key"),
  model: () => '<h2>Default model</h2><p class="ob-sub">Every AI task uses this unless you override it per-task later. Pick one that supports 👁 images so photo logging works.</p>' +
    (AS.models.length
      ? `<label class="ob-full">Model<select id="asModel">${AS.models.map((m) => `<option value="${esc(m.id)}"${AS.model === m.id ? " selected" : ""}>${m.vision ? "👁 " : ""}${esc(m.label || m.id)}</option>`).join("")}</select></label>`
      : '<p class="ob-warn">No models loaded — check the key. You can set this later in Admin.</p>') +
    asNavBar(true, "Next"),
  features: () => '<h2>Optional features</h2><p class="ob-sub">Turn these on or off for everyone (adjustable anytime in Admin).</p>' +
    `<label class="checkrow"><input type="checkbox" id="asCheckins"${AS.checkins ? " checked" : ""}> <span>Proactive check-ins<small>Sate reviews logs and nudges users when useful.</small></span></label>` +
    `<label class="checkrow"><input type="checkbox" id="asSecond"${AS.second ? " checked" : ""}> <span>Second opinion<small>Let users request an alternate model.</small></span></label>` +
    `<label class="ob-full" style="margin-top:10px">Extra admin emails <small class="muted">(comma-separated, optional)</small><input type="text" id="asAdmins" value="${esc(AS.admins)}" placeholder="alex@example.com, sam@example.com"></label>` +
    asNavBar(true, "Finish setup"),
};
function asRender() {
  const body = AS.sheet.body;
  body.innerHTML = AS_STEP[AS.steps[AS.i]]();
  const s = AS.steps[AS.i];
  const back = body.querySelector("#asBack"); if (back) back.onclick = () => { AS.i = Math.max(0, AS.i - 1); asRender(); };
  const next = body.querySelector("#asNext"); if (next) next.onclick = () => asNext(s);
}
function asGo() { AS.i = Math.min(AS.steps.length - 1, AS.i + 1); asRender(); }
async function asNext(s) {
  const n = AS.sheet.body.querySelector("#asNext");
  const q = (sel) => AS.sheet.body.querySelector(sel);
  if (s === "welcome") { AS.app_name = (q("#asName").value || "Sate").trim(); return asGo(); }
  if (s === "provider") {
    AS.provider = q("#asProv").value; AS.api_key = q("#asKey").value.trim();
    if (!AS.api_key) return toast("Paste an API key");
    if (n) { n.disabled = true; n.textContent = "Checking…"; }
    try {
      await adm("/providers", { method: "PUT", json: { name: AS.provider, api_key: AS.api_key, enabled: true } });
      const r = await adm("/models?provider=" + AS.provider);
      AS.models = r.models || [];
      const vis = AS.models.find((m) => m.vision) || AS.models[0];
      AS.model = vis ? vis.id : "";
    } catch (e) { toast(e.message); if (n) { n.disabled = false; n.textContent = "Add key"; } return; }
    return asGo();
  }
  if (s === "model") { if (q("#asModel")) AS.model = q("#asModel").value; return asGo(); }
  if (s === "features") {
    AS.checkins = q("#asCheckins").checked; AS.second = q("#asSecond").checked; AS.admins = q("#asAdmins").value.trim();
    if (n) { n.disabled = true; n.textContent = "Saving…"; }
    try {
      await adm("/settings", { method: "PUT", json: {
        app_name: AS.app_name,
        default_ai_provider: AS.provider, default_ai_model: AS.model,
        default_vision_provider: AS.provider, default_vision_model: AS.model,
        checkins_enabled: AS.checkins ? "on" : "off",
        second_opinion_enabled: AS.second ? "on" : "off",
        setup_complete: "yes",
      } });
      for (const em of AS.admins.split(",").map((x) => x.trim().toLowerCase()).filter((x) => x.indexOf("@") !== -1)) {
        try { await adm("/users/role", { method: "PUT", json: { email: em, role: "admin" } }); } catch (_) {}
      }
      await refreshMe();
    } catch (e) { toast(e.message); if (n) { n.disabled = false; n.textContent = "Finish setup"; } return; }
    const m = me() || {};
    if (m.app_name) { $("#brandName").textContent = m.app_name; document.title = m.app_name + " — calorie chat"; }
    if (AS.sheet) AS.sheet.close();
    AS = null;
    toast("Instance ready 🎉");
    showView("admin");
    return;
  }
  asGo();
}

// Open the setup wizard sheet if this admin is on an unconfigured instance. Returns true if shown.
function maybeSetup() {
  const m = me();
  if (!m || !m.isAdmin || m.setup_done || AS) return false;
  AS = { i: 0, app_name: m.app_name || "Sate", provider: "google", api_key: "", model: "", models: [], checkins: true, second: true, admins: "" };
  AS.steps = ["welcome", "provider", "model", "features"];
  AS.sheet = sheet({ title: "", className: "addsheet ob-sheet", dismissable: false, onClose: () => { AS = null; } });
  asRender();
  return true;
}

// ============================================================ static-control wiring
// One-time bindings for the scaffold's fixed controls (v1 bound these at module load; here they run
// once, after the scaffold is built).
function wireStatic(root) {
  $$("#adminTabs button").forEach((b) => b.addEventListener("click", () => setAdminSect(b.dataset.group)));

  $("#saveInstance").addEventListener("click", saveInstance);
  $("#saveFeatures").addEventListener("click", saveFeatures);
  $("#lookupSaveBtn").addEventListener("click", saveLookup);

  // Food DB
  $("#foodSearchBtn").addEventListener("click", () => loadFoods($("#foodSearch").value.trim()));
  $("#foodSearch").addEventListener("keydown", (ev) => { if (ev.key === "Enter") { ev.preventDefault(); loadFoods($("#foodSearch").value.trim()); } });
  $("#foodSaveBtn").addEventListener("click", saveFood);
  $("#foodClearBtn").addEventListener("click", clearFoodEditor);
  $("#faPhoto").addEventListener("click", () => $("#faPhotoInput").click());
  $("#faPhotoInput").addEventListener("change", (e) => { if (e.target.files[0]) adminFoodPhoto(e.target.files[0]); e.target.value = ""; });
  $("#faWeb").addEventListener("click", adminFoodWeb);
  $("#faBarcode").addEventListener("click", adminFoodBarcode);

  // Sources
  $("#sourceSaveBtn").addEventListener("click", () => {
    const title = $("#sTitle").value.trim();
    const url = $("#sUrl").value.trim();
    if (!title || !url) return toast("title and url are required");
    saveSource({ title, url, notes: $("#sNotes").value.trim(), enabled: $("#sEnabled").checked }, false);
  });

  // Users
  $("#addAdminBtn").addEventListener("click", addAdmin);

  void root;
}

// ============================================================ view registration
// Tab view: showView("admin") reveals #view-admin and calls render(). The scaffold builds once; every
// subsequent show just reloads data (v1's `if (name === "admin") loadAdmin()`).
export function render(container) {
  const root = container || $("#view-admin");
  if (!root) return;
  if (!_built) {
    root.innerHTML = SCAFFOLD;
    _built = true;
    wireStatic(root);
  }
  loadAdmin();
}

registerView("admin", { render, container: "#view-admin", maybeSetup });
