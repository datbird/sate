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
  if (name === "home") renderHome();
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


function escapeHtml(s) {
  return String(s || "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

// ---------------------------------------------------------------------- log
// -------------------------------------------------------------- Home dashboard
const HOME = { scope: "both", range: "day", chart: "ring" };
const RC = { nutrition: "var(--brand)", activity: "var(--activity)" };
// The two type icons (kept identical to the compose tabs and the mockup).
const TICON = {
  n: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3v7a2 2 0 0 0 4 0V3"/><path d="M10 12v9"/><ellipse cx="16" cy="6.4" rx="2.2" ry="3.4"/><path d="M16 9.8V21"/></svg>',
  a: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="13" cy="4" r="1"/><path d="M4 17l5 1 .75-1.5"/><path d="M15 21v-4l-4-3 1-6"/><path d="M7 12V9l5-1 3 3 3 1"/></svg>',
};
// Opening tag for the small inline icons used in the "in / out / net" subline (sized by .iico).
const SPARK = '<svg class="iico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">';
// Apple-Health-style heart glyph for the "Health" source badge (sized by .health svg).
const HEART = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 21s-7.5-4.9-10-9.3C.6 8.9 1.7 5.5 4.8 4.8 7 4.3 8.9 5.6 12 8.5c3.1-2.9 5-4.2 7.2-3.7 3.1.7 4.2 4.1 2.8 6.9C19.5 16.1 12 21 12 21z"/></svg>';

async function renderHome() {
  let stats = null, feed = null;
  try {
    [stats, feed] = await Promise.all([
      api("/stats?range=" + HOME.range),
      api("/entries?date=" + todayISO()),
    ]);
  } catch (e) { toast(e.message); return; }
  renderStats(stats);
  renderFeed(feed.entries || []);
}

// Explicit refresh (pull-to-refresh on Home). Unlike the launch auto-sync this ignores the
// interval throttle — a deliberate pull always pulls Health now, then re-renders the dashboard.
async function refreshHome() {
  if (isNativeApp() && ME && ME.health_sync) {
    try { await healthSyncNow(true); } catch (_) {}
  }
  await renderHome();
}

// Ring markup for an intake totals object, using the user's tracking mode (reuses MODES/METRIC).
// opts.days scales the per-day goals to the window (so a week's sum compares to a week's goal);
// opts.netBurn adds exercise calories to the budget, but only when the ring tracks calories.
function ringHTML(totals, goals, opts) {
  const mode = modeOf();
  const days = (opts && opts.days) || 1;
  const netBurn = (opts && mode.primary === "kcal") ? (opts.netBurn || 0) : 0;
  const pm = METRIC[mode.primary];
  const val = pm.get(totals || {});
  const goal = (pm.goalKey ? (goals[pm.goalKey] || 0) * days : 0) + netBurn;
  const pct = goal ? Math.min(100, (val / goal) * 100) : 0;
  const ushort = pm.u ? " " + pm.u : (mode.primary === "kcal" ? " kcal" : "");
  const sub = goal ? "of " + fmt(goal) + ushort : (pm.u || pm.label);
  const macros = mode.stats.map((key) => {
    const m = METRIC[key], v = m.get(totals || {}), g = m.goalKey ? (goals[m.goalKey] || 0) * days : 0;
    return `<div class="macro"><b>${fmt(v)}${m.u}</b><span>${m.label}${g ? " / " + fmt(g) : ""}</span></div>`;
  }).join("");
  return `<div class="ringwrap"><div class="ring" style="--pct:${pct.toFixed(1)};--rc:${RC.nutrition}">` +
    `<div class="ring-inner"><strong>${fmt(val)}</strong><small>${sub}</small></div></div>` +
    `<div class="macros">${macros}</div></div>`;
}

function lineChart(pts, goal, accent) {
  const w = 360, h = 150, n = pts.length;
  if (n < 2) return `<div class="subline">Not enough data yet for a trend — keep logging.</div>`;
  const max = Math.max(goal || 0, Math.max.apply(null, pts)) * 1.1 || 1;
  const step = w / (n - 1);
  const xy = pts.map((v, i) => [i * step, h - (v / max) * h]);
  const d = xy.map((p, i) => (i ? "L" : "M") + p[0].toFixed(1) + " " + p[1].toFixed(1)).join(" ");
  const area = d + ` L${w} ${h} L0 ${h} Z`;
  const gy = goal ? (h - (goal / max) * h).toFixed(1) : -1;
  const end = xy[xy.length - 1];
  return `<div class="chart"><svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">` +
    `<defs><linearGradient id="lg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${accent}" stop-opacity=".28"/><stop offset="1" stop-color="${accent}" stop-opacity="0"/></linearGradient></defs>` +
    (goal ? `<line x1="0" y1="${gy}" x2="${w}" y2="${gy}" stroke="var(--muted)" stroke-width="1" stroke-dasharray="4 4" opacity=".5"/>` : "") +
    `<path d="${area}" fill="url(#lg)"/><path d="${d}" fill="none" stroke="${accent}" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>` +
    `<circle cx="${end[0].toFixed(1)}" cy="${end[1].toFixed(1)}" r="4.5" fill="${accent}" stroke="var(--card)" stroke-width="2.5"/></svg></div>`;
}

function sparkBars(pts) {
  const max = Math.max.apply(null, pts) || 1;
  return `<div class="spark">` + pts.map((v, i) =>
    `<i class="${i === pts.length - 1 ? "today" : ""}" style="height:${((v / max) * 100).toFixed(0)}%"></i>`).join("") + `</div>`;
}

function renderStats(s) {
  const body = $("#statbody");
  const goals = (s.goals || ME.goals || {});
  const inKcal = s.in.kcal || 0, out = s.out || { kcal: 0, minutes: 0, workouts: 0 };
  const nutSeries = s.series.map((b) => b.in_kcal);
  const actSeries = s.series.map((b) => b.out_kcal);
  const days = s.days || 1;
  const burnKcal = out.kcal || 0;
  // Net-exercise: exercise calories raise the calorie budget, if the user hasn't opted out and
  // the ring actually tracks calories (calories/balanced modes). Server can also force it off.
  const applyNet = !!(ME && ME.net_exercise) && s.net_exercise !== false && modeOf().primary === "kcal" && burnKcal > 0;
  const ringOpts = { days: days, netBurn: applyNet ? burnKcal : 0 };
  // "Goal 2,000 + 280 burned = 2,280 · eaten 1,565 → 715 left"
  const netCaption = () => {
    const base = (goals.kcal || 0) * days, eff = base + burnKcal, left = eff - inKcal;
    return `<div class="subline">Budget ${fmt(base)} + ${fmt(burnKcal)} burned = <b>${fmt(eff)}</b> · eaten ${fmt(inKcal)} → ${fmt(Math.abs(Math.round(left)))} ${left >= 0 ? "left" : "over"}</div>`;
  };

  if (HOME.scope === "activity") {
    if (HOME.chart === "line") {
      body.innerHTML = lineChart(actSeries, 0, RC.activity) +
        `<div class="avgrow"><span>Avg burn <b>${fmt(s.avg_out_kcal)} cal</b></span><span>Total <b>${fmt(out.kcal)}</b></span></div>`;
    } else {
      const pct = Math.min(100, Math.round((out.kcal / 500) * 100));
      const ring = `<div class="ringwrap"><div class="ring" style="--pct:${pct};--rc:${RC.activity}">` +
        `<div class="ring-inner"><strong>${fmt(out.kcal)}</strong><small>cal burned</small></div></div>` +
        `<div class="kpis"><div class="kpi"><b>${fmt(out.minutes)}</b><span>active min</span></div>` +
        `<div class="kpi"><b>${fmt(out.workouts)}</b><span>workouts</span></div></div></div>`;
      const netMsg = (ME && ME.net_exercise && s.net_exercise !== false)
        ? "Exercise calories are added to your daily budget."
        : "Burn is shown as context — not added to your food budget.";
      body.innerHTML = ring + (HOME.chart === "hybrid" && actSeries.length > 1 ? sparkBars(actSeries) : "") +
        `<div class="subline">${netMsg}</div>`;
    }
    return;
  }

  // nutrition or both
  if (HOME.chart === "line") {
    body.innerHTML = lineChart(nutSeries, goals.kcal, RC.nutrition) +
      `<div class="avgrow"><span>Avg intake <b>${fmt(s.avg_in_kcal)} kcal</b></span><span>Goal <b>${fmt(goals.kcal)}</b></span></div>`;
  } else {
    const both = applyNet ? netCaption()
      : HOME.scope === "both"
      ? `<div class="subline"><span style="color:var(--brand)">${SPARK}<path d="M8 3v7a2 2 0 0 0 4 0V3"/><path d="M10 12v9"/><ellipse cx="16" cy="6.4" rx="2.2" ry="3.4" fill="none"/><path d="M16 9.8V21"/></svg></span> in ${fmt(inKcal)} kcal · <span style="color:var(--activity)">${SPARK}<circle cx="13" cy="4" r="1"/><path d="M4 17l5 1 .75-1.5"/><path d="M15 21v-4l-4-3 1-6"/><path d="M7 12V9l5-1 3 3 3 1"/></svg></span> out ${fmt(out.kcal)} cal · net ${fmt(inKcal - out.kcal)}</div>`
      : `<div class="subline">${s.range === "day" ? "Today" : "This " + s.range} · ring tracks ${METRIC[modeOf().primary].label} vs goal</div>`;
    body.innerHTML = ringHTML(s.in, goals, ringOpts) + (HOME.chart === "hybrid" && nutSeries.length > 1 ? sparkBars(nutSeries) : "") + both;
  }
}
// Wire the Home controls with a generic segmented handler ([data-*] is the contract).
function segControl(sel, key, after) {
  $(sel).addEventListener("click", (ev) => {
    const btn = ev.target.closest("button"); if (!btn) return;
    $$(sel + " button").forEach((b) => b.classList.remove("on"));
    btn.classList.add("on");
    HOME[key] = btn.dataset[key];
    after();
  });
}
segControl("#scope", "scope", renderHome);   // scope changes both stats + feed
segControl("#range", "range", renderHome);   // range refetches stats
segControl("#charts", "chart", () => api("/stats?range=" + HOME.range).then(renderStats).catch(() => {}));
$("#addBtn").addEventListener("click", openAdd);
$("#addBg").addEventListener("click", closeAdd);
$("#editBg").addEventListener("click", closeEdit);
$$("#addScope button").forEach((b) => b.addEventListener("click", () => setAddTab(b.dataset.add)));

function renderFeed(entries) {
  $("#feedlbl").textContent = "Today";
  const scope = HOME.scope;
  const rows = entries.filter((en) => scope === "both" || (scope === "nutrition" && en.kind !== "activity") || (scope === "activity" && en.kind === "activity"));
  const ul = $("#feed");
  ul.innerHTML = "";
  if (!rows.length) {
    ul.innerHTML = '<li class="hint" style="color:var(--muted);font-size:13px;padding:10px 2px">Nothing logged yet — tap <b>+ Add to log</b>.</li>';
    return;
  }
  rows.forEach((en) => ul.appendChild(entryLi(en)));
}

function entryLi(en, readonly) {
  const li = document.createElement(readonly ? "div" : "button");
  li.className = "entry" + (readonly ? " readonly" : "");
  li.type = readonly ? "" : "button";
  const activity = en.kind === "activity";
  const items = (en.items || []).map((i) => i.name).join(", ");
  const title = en.description || items || (activity ? "Activity" : "Entry");
  const timeStr = timeOf(en.logged_at);
  const sub = activity
    ? [timeStr, en.duration_min ? Math.round(en.duration_min) + " min" : "", en.intensity].filter(Boolean).join(" · ")
    : [timeStr, items || en.source].filter(Boolean).join(" · ");
  const kcal = activity
    ? `<span class="ekcal out">−${fmt(en.kcal)}<small> cal</small></span>`
    : `<span class="ekcal">${fmt(en.kcal)}<small> kcal</small></span>`;
  // Apple Health-imported workouts get a small badge so the source is unmistakable.
  const badge = en.source === "health"
    ? `<span class="health" title="From Apple Health">${HEART}Health</span>` : "";
  li.innerHTML =
    `<span class="ticon ${activity ? "a" : "n"}">${activity ? TICON.a : TICON.n}</span>` +
    `<span class="etext"><span class="t">${escapeHtml(title)}${badge}</span><span class="s">${escapeHtml(sub)}</span></span>` + kcal;
  if (!readonly) li.addEventListener("click", () => openEdit(en));
  return li;
}

function timeOf(iso) {
  try {
    const d = new Date((iso || "").replace(" ", "T").replace(/Z?$/, "Z"));
    return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  } catch (_) { return ""; }
}

async function deleteEntry(id) {
  await api("/entries/" + id, { method: "DELETE" });
  renderHome();
}

// --------------------------------------------------------------- logging flows
// Free-text meal → text_parse. Called from the compose overlay's Nutrition tab.
async function logMeal(text) {
  if (!text.trim()) return;
  closeAdd();
  toast("Estimating…");
  try {
    const r = await api("/log/text", { method: "POST", body: JSON.stringify({ text: text.trim() }) });
    toast(r.note || `Logged ${fmt(r.entry.kcal)} kcal.`);
    renderHome();
  } catch (e) { toast(e.message); }
}

async function webLookup(entryId) {
  toast("Searching the web…");
  try {
    const r = await api("/entries/" + entryId + "/web-lookup", { method: "POST" });
    toast(r.note || `Updated to ${fmt(r.entry.kcal)} kcal from the web.`);
    renderHome();
  } catch (e) { toast(e.message); }
}

async function logPhoto(file) {
  const dataUrl = await new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result); fr.onerror = reject;
    fr.readAsDataURL(file);
  });
  closeAdd();
  toast("Analyzing photo…");
  try {
    const r = await api("/log/photo", { method: "POST", body: JSON.stringify({ image: dataUrl }) });
    toast(r.note || `Logged ${fmt(r.entry.kcal)} kcal from photo.`);
    renderHome();
  } catch (e) { toast(e.message); }
}
$("#photoInput").addEventListener("change", (e) => { if (e.target.files[0]) logPhoto(e.target.files[0]); e.target.value = ""; });

async function logActivityPreset(id, minutes) {
  closeAdd();
  toast("Logging…");
  try {
    const r = await api("/log/activity", { method: "POST", body: JSON.stringify({ activity_id: id, duration_min: minutes }) });
    toast(`Logged ${r.entry.description} — ${fmt(r.entry.kcal)} cal burned.`);
    renderHome();
  } catch (e) { toast(e.message); }
}
async function logActivityText(text) {
  if (!text.trim()) return;
  closeAdd();
  toast("Estimating…");
  try {
    const r = await api("/log/activity", { method: "POST", body: JSON.stringify({ text: text.trim() }) });
    toast(r.note || `Logged ${fmt(r.entry.kcal)} cal burned.`);
    renderHome();
  } catch (e) { toast(e.message); }
}

// -------------------------------------------------------------- compose overlay
let addTab = "nutrition";
function openAdd() { addTab = "nutrition"; setAddTab("nutrition"); $("#addBg").hidden = false; $("#addSheet").hidden = false; }
function closeAdd() { $("#addBg").hidden = true; $("#addSheet").hidden = true; }
function setAddTab(t) {
  addTab = t;
  $$("#addScope button").forEach((b) => b.classList.toggle("on", b.dataset.add === t));
  renderAddBody();
}

let actTimer = null;
function renderAddBody() {
  const b = $("#addBody");
  if (addTab === "nutrition") {
    b.innerHTML =
      `<div class="search"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 6h16M4 12h10M4 18h7" stroke-linecap="round"/></svg>` +
      `<input id="mealInput" placeholder="What did you eat? e.g. two eggs and toast" autocomplete="off"></div>` +
      `<div class="methods">` +
      `<button class="method" id="mBarcode"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 5v14M7 5v14M11 5v14M14 5v14M18 5v14M21 5v14"/></svg><b>Barcode</b><span>scan a package</span></button>` +
      `<button class="method" id="mPhoto"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="7" width="18" height="13" rx="3"/><circle cx="12" cy="13.5" r="3.5"/><path d="M9 7l1.5-2h3L15 7"/></svg><b>Photo AI</b><span>snap your plate</span></button>` +
      `</div>` +
      `<button class="aibtn" id="mLog" style="background:var(--brand);color:var(--brand-ink);border-style:solid;border-color:var(--brand)">Log this meal</button>`;
    const inp = $("#mealInput");
    inp.addEventListener("keydown", (e) => { if (e.key === "Enter") logMeal(inp.value); });
    $("#mLog").addEventListener("click", () => logMeal(inp.value));
    $("#mBarcode").addEventListener("click", () => { closeAdd(); openScanner(); });
    $("#mPhoto").addEventListener("click", () => $("#photoInput").click());
    setTimeout(() => inp.focus(), 60);
  } else {
    b.innerHTML =
      `<div class="search"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4-4" stroke-linecap="round"/></svg>` +
      `<input id="actInput" placeholder="Search activities… e.g. running" autocomplete="off"></div>` +
      `<div class="dur"><label>Duration</label><input id="actDur" type="number" min="1" value="30"> <label>min</label></div>` +
      `<div class="reslist" id="actResults"></div>` +
      `<button class="aibtn" id="actAI" style="border-color:color-mix(in srgb,var(--activity) 45%,var(--line));color:var(--activity)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l1.8 4.2L18 9l-4.2 1.8L12 15l-1.8-4.2L6 9l4.2-1.8z"/></svg>Estimate with AI — describe the workout</button>` +
      (isNativeApp() ? `<button class="aibtn" id="actHR" style="border-color:color-mix(in srgb,var(--activity) 45%,var(--line));color:var(--activity)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12h4l2.5 6 4-14 2.5 8H22"/></svg>From heart rate — pick a window from your watch</button>` : "");
    const inp = $("#actInput");
    const runSearch = async () => {
      let acts = [];
      try { acts = (await api("/activities/search?q=" + encodeURIComponent(inp.value))).activities || []; } catch (_) {}
      const dur = Math.max(1, +$("#actDur").value || 30);
      $("#actResults").innerHTML = acts.map((a) =>
        `<button class="res" data-id="${a.id}"><div class="rt"><b>${escapeHtml(a.name)}</b><span>${a.kcal_min} cal/min · ~${Math.round(a.kcal_min * dur)} cal for ${dur} min</span></div><span class="add">+</span></button>`
      ).join("") || '<div class="grouplbl">No matches — try the AI estimate below</div>';
      $$("#actResults .res").forEach((r) => r.addEventListener("click", () => logActivityPreset(r.dataset.id, Math.max(1, +$("#actDur").value || 30))));
    };
    inp.addEventListener("input", () => { clearTimeout(actTimer); actTimer = setTimeout(runSearch, 180); });
    $("#actDur").addEventListener("input", () => { clearTimeout(actTimer); actTimer = setTimeout(runSearch, 180); });
    $("#actAI").addEventListener("click", () => logActivityText(inp.value || $("#actInput").value));
    const hrb = $("#actHR"); if (hrb) hrb.addEventListener("click", openHrPicker);
    runSearch();
    setTimeout(() => inp.focus(), 60);
  }
}

// ------------------------------------------------------------------- edit sheet
let editEntry = null;
function openEdit(en) {
  editEntry = en;
  const activity = en.kind === "activity";
  $("#editTitle").textContent = en.description || "Edit entry";
  const unit = activity ? "cal burned" : "kcal";
  const scales = [["½", 0.5], ["¾", 0.75], ["1¼", 1.25], ["1½", 1.5], ["2×", 2]];
  $("#editBody").innerHTML =
    `<div class="subline" style="text-align:left;margin:0 0 10px">Currently <b style="color:var(--ink)">${fmt(en.kcal)} ${unit}</b>${activity && en.duration_min ? " · " + Math.round(en.duration_min) + " min" : ""}</div>` +
    `<div class="menu-label" style="padding-left:0">Adjust the amount</div>` +
    `<div class="quickscale">${scales.map(([l, v]) => `<button data-scale="${v}">${l}</button>`).join("")}</div>` +
    `<div class="menu-label" style="padding-left:0">${activity ? "Or re-describe the workout" : "Or re-describe the meal"}</div>` +
    `<div class="editrow"><input id="editText" placeholder="${activity ? "e.g. a 5 mile run" : "e.g. half a cup of rice"}" value="${escapeHtml(en.description || "")}"></div>` +
    `<div class="sheet-actions"><button class="primary" id="editApply" style="flex:1">Re-estimate</button><button class="danger-btn" id="editDelete">Delete</button></div>`;
  $$("#editBody [data-scale]").forEach((b) => b.addEventListener("click", () => applyEdit({ scale: +b.dataset.scale })));
  $("#editApply").addEventListener("click", () => applyEdit({ re_estimate: true, text: $("#editText").value }));
  $("#editDelete").addEventListener("click", async () => { await deleteEntry(en.id); closeEdit(); });
  $("#editBg").hidden = false; $("#editSheet").hidden = false;
}
function closeEdit() { $("#editBg").hidden = true; $("#editSheet").hidden = true; editEntry = null; }
async function applyEdit(payload) {
  if (!editEntry) return;
  closeEdit();
  toast("Updating…");
  try {
    const r = await api("/entries/" + editEntry.id, { method: "PATCH", body: JSON.stringify(payload) });
    toast(`Updated to ${fmt(r.entry.kcal)} ${r.entry.kind === "activity" ? "cal" : "kcal"}.`);
    renderHome();
  } catch (e) { toast(e.message); }
}

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
      toast(`Logged ${r.name} — ${fmt(r.entry.kcal)} kcal (via ${r.found_via}).`);
      renderHome();
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
    logMeal(raw);
  }
}
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
  $("#goalNet").checked = ME.net_exercise !== false;
  renderHealthRow();
  const hrRow = $("#hrMethodRow");
  if (hrRow) {
    hrRow.hidden = !isNativeApp();
    if (isNativeApp()) $("#hrMethod").value = ME.hr_estimate_method === "ai" ? "ai" : "formula";
  }
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
    net_exercise: $("#goalNet").checked,
    goal_kcal: f.goal_kcal.value, goal_protein: f.goal_protein.value,
    goal_carbs: f.goal_carbs.value, goal_fat: f.goal_fat.value, goal_sodium: f.goal_sodium.value,
  };
  if (isNativeApp() && $("#hrMethod")) payload.hr_estimate_method = $("#hrMethod").value;
  const r = await api("/goals", { method: "PATCH", body: JSON.stringify(payload) });
  ME.goals = r.goals;
  if (r.track_mode) ME.track_mode = r.track_mode;
  if (typeof r.net_exercise === "boolean") ME.net_exercise = r.net_exercise;
  if (r.hr_estimate_method) ME.hr_estimate_method = r.hr_estimate_method;
  renderHome();
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
  data.entries.forEach((en) => ul.appendChild(entryLi(en, true)));
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

// ------------------------------------------------------------- apple health (native)
// Read-only workout import. Native-only: the HealthKit plugin exists only inside the iOS
// shell, so on the web these are no-ops and the Health UI stays hidden.
function isNativeApp() {
  return !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
}
function healthPlugin() {
  if (!window.Capacitor || !window.Capacitor.registerPlugin) return null;
  return window.Capacitor.registerPlugin("HealthKit");
}

// Auto-sync-on-open throttle. Sync only if Health is connected AND enough time has passed
// since the last sync. interval 0 = every launch; never synced = due. Purely a launch-time
// check — nothing polls in the background.
const HEALTH_INTERVALS = [
  [0, "Every time I open the app"],
  [60, "At most once an hour"],
  [360, "At most every 6 hours"],
  [1440, "Once a day"],
  [4320, "Every 3 days"],
  [10080, "Weekly"],
];
function healthSyncDue() {
  if (!ME || !ME.health_sync) return false;
  const interval = Number(ME.health_sync_interval);
  if (!interval) return true; // 0 / unset → sync on every open
  const last = ME.health_synced_at ? Date.parse(ME.health_synced_at) : 0;
  if (!last) return true; // connected but never synced
  return Date.now() - last >= interval * 60000;
}

// Pull recent workouts from Health and POST them for dedup/import. `silent` suppresses the
// "nothing new" toast used by the auto-sync on launch.
async function healthSyncNow(silent) {
  const HK = healthPlugin();
  if (!HK) return;
  try {
    const res = await HK.queryWorkouts({ days: 30 });
    const workouts = (res && res.workouts) || [];
    const r = await api("/health/sync", { method: "POST", body: JSON.stringify({ workouts: workouts }) });
    ME.health_sync = true;
    ME.health_synced_at = r.synced_at || new Date().toISOString();
    if (!silent) toast(r.added ? ("Imported " + r.added + " workout" + (r.added === 1 ? "" : "s")) : "Apple Health up to date");
    if ($("#view-home") && !$("#view-home").hidden) renderHome();
    renderHealthRow();
  } catch (e) {
    if (!silent) toast((e && e.message) || "Health sync failed");
  }
}

// The Connect button: ask HealthKit for read access, then do a first import.
async function healthConnect() {
  const HK = healthPlugin();
  if (!HK) { toast("Apple Health needs the Sate app"); return; }
  try {
    const r = await HK.requestAuthorization();
    if (r && r.available === false) { toast("Apple Health isn't available on this device"); return; }
    await api("/goals", { method: "PATCH", body: JSON.stringify({ health_sync: true }) });
    ME.health_sync = true;
    await healthSyncNow(false);
  } catch (e) { toast((e && e.message) || "Couldn't connect Apple Health"); }
}

async function healthDisconnect() {
  try {
    const r = await api("/goals", { method: "PATCH", body: JSON.stringify({ health_sync: false }) });
    if (typeof r.health_sync === "boolean") ME.health_sync = r.health_sync;
    renderHealthRow();
    toast("Apple Health disconnected");
  } catch (e) { toast((e && e.message) || "Couldn't disconnect"); }
}

// Render the Health row in the Goals dialog. Hidden entirely off-native (no plugin to talk to).
function renderHealthRow() {
  const row = $("#healthRow");
  if (!row) return;
  if (!isNativeApp()) { row.hidden = true; return; }
  row.hidden = false;
  const connected = ME && ME.health_sync;
  $("#healthStatus").textContent = connected ? "Connected — workouts import automatically" : "Import workouts and their calorie burn";
  $("#healthActions").innerHTML = connected
    ? '<button type="button" class="link" id="healthSyncBtn">Sync now</button><button type="button" class="link danger" id="healthDiscBtn">Disconnect</button>'
    : '<button type="button" class="primary" id="healthConnectBtn">Connect Apple Health</button>';
  const c = $("#healthConnectBtn"); if (c) c.addEventListener("click", healthConnect);
  const s = $("#healthSyncBtn"); if (s) s.addEventListener("click", () => healthSyncNow(false));
  const d = $("#healthDiscBtn"); if (d) d.addEventListener("click", healthDisconnect);

  // Auto-sync interval picker — only meaningful while connected.
  const opts = $("#healthSyncOpts");
  if (opts) {
    if (connected) {
      const cur = Number(ME.health_sync_interval);
      opts.hidden = false;
      opts.innerHTML = '<label class="healthintlbl">Auto-sync when I open the app' +
        '<select id="healthInterval">' +
        HEALTH_INTERVALS.map(([v, l]) => '<option value="' + v + '"' + (v === cur ? " selected" : "") + ">" + l + "</option>").join("") +
        "</select></label>";
      $("#healthInterval").addEventListener("change", onHealthIntervalChange);
    } else {
      opts.hidden = true;
      opts.innerHTML = "";
    }
  }
}

async function onHealthIntervalChange(ev) {
  const v = parseInt(ev.target.value, 10);
  try {
    const r = await api("/goals", { method: "PATCH", body: JSON.stringify({ health_sync_interval: v }) });
    if (r && typeof r.health_sync_interval === "number") ME.health_sync_interval = r.health_sync_interval;
    toast("Auto-sync updated");
  } catch (e) {
    toast((e && e.message) || "Couldn't update auto-sync");
  }
}

// ------------------------------------------------------ add from heart rate (native)
// Retroactively log unlogged exertion the watch captured only as heart rate: read the last 24h
// of HR, drag a window on the graph, name it, and Sate estimates the burn (Keytel formula by
// default, or AI). Native-only — HR is unreadable on the web. State lives in HR while open.
let HR = null;

// Client-side twin of the backend Keytel (api.js keytelKcalPerMin) for instant drag preview;
// the server recomputes authoritatively on save.
function keytelPerMin(hr, w, a, sex) {
  w = w > 0 ? w : 70; a = a > 0 ? a : 40;
  const male = (-55.0969 + 0.6309 * hr + 0.1988 * w + 0.2017 * a) / 4.184;
  const female = (-20.4022 + 0.4472 * hr - 0.1263 * w + 0.074 * a) / 4.184;
  const s = (sex || "").toLowerCase();
  const v = s === "male" ? male : s === "female" ? female : (male + female) / 2;
  return Math.max(0, v);
}
function hrMethod() { return ME && ME.hr_estimate_method === "ai" ? "ai" : "formula"; }
function hrClock(ms) { try { return new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }); } catch (_) { return ""; } }

function openHrPicker() {
  closeAdd();
  const bg = $("#hrBg"), sheet = $("#hrSheet");
  bg.hidden = false; sheet.hidden = false;
  bg.onclick = closeHrPicker;
  $("#hrBody").innerHTML = '<div class="hrload">Reading the last 24 hours of heart rate…</div>';
  loadHr();
}
function closeHrPicker() { $("#hrBg").hidden = true; $("#hrSheet").hidden = true; HR = null; }

async function loadHr() {
  const HK = healthPlugin();
  if (!HK) { $("#hrBody").innerHTML = '<div class="hrload">Apple Health needs the Sate app.</div>'; return; }
  // Heart rate + body stats are read types this build added; ensure they're authorized (iOS
  // only prompts for types not yet determined, so this is a no-op once granted).
  try { await HK.requestAuthorization(); } catch (_) {}
  let samples = [], body = { weight_kg: 0, age: 0, sex: "" };
  try {
    const r = await HK.queryHeartRate({ hours: 24 });
    samples = ((r && r.samples) || [])
      .map((s) => ({ t: Date.parse(s.t), bpm: +s.bpm }))
      .filter((s) => s.t && s.bpm > 0)
      .sort((a, b) => a.t - b.t);
  } catch (_) {}
  try {
    const b = await HK.queryBodyStats();
    if (b) body = { weight_kg: +b.weight_kg || 0, age: +b.age || 0, sex: (b.sex || "").toLowerCase() };
  } catch (_) {}
  // Fill any gaps Apple Health didn't have from the saved profile.
  if (!body.weight_kg) body.weight_kg = +ME.body_weight_kg || 0;
  if (!body.age) body.age = +ME.body_age || 0;
  if (!body.sex) body.sex = (ME.body_sex || "").toLowerCase();

  if (!samples.length) {
    $("#hrBody").innerHTML =
      '<div class="hrload">No heart-rate data in the last 24 hours.<br>Wear your watch, then try again.</div>' +
      '<div class="row end"><button class="link" id="hrCancel">Close</button></div>';
    $("#hrCancel").addEventListener("click", closeHrPicker);
    return;
  }
  const tMin = samples[0].t, tMax = samples[samples.length - 1].t;
  const span = tMax - tMin;
  // Default selection: the most recent ~30 min (clamped to what's available).
  const selEnd = tMax;
  const selStart = Math.max(tMin, tMax - Math.min(30 * 60000, Math.max(span * 0.25, 5 * 60000)));
  HR = { samples, tMin, tMax, selStart, selEnd, body };
  renderHr();
}

// Fixed SVG geometry + time/bpm scales for the current HR data.
function hrGeom() {
  const W = 340, H = 148, x0 = 4, x1 = W - 4, y0 = 10, y1 = H - 20;
  const bpms = HR.samples.map((s) => s.bpm);
  const loB = Math.max(30, Math.min.apply(null, bpms) - 5);
  const hiB = Math.max.apply(null, bpms) + 5;
  const span = HR.tMax - HR.tMin || 1, brange = hiB - loB || 1;
  return {
    W, H, x0, x1, y0, y1, loB, hiB,
    tx: (t) => x0 + (x1 - x0) * (t - HR.tMin) / span,
    ty: (b) => y1 - (y1 - y0) * (b - loB) / brange,
    xt: (x) => HR.tMin + span * (Math.max(x0, Math.min(x1, x)) - x0) / (x1 - x0),
  };
}

// Stats over the currently-selected window.
function hrStats() {
  const inSel = HR.samples.filter((s) => s.t >= HR.selStart && s.t <= HR.selEnd);
  if (!inSel.length) return { avg: 0, max: 0, min: 0, n: 0 };
  let sum = 0, max = 0, min = 1e9;
  for (const s of inSel) { sum += s.bpm; if (s.bpm > max) max = s.bpm; if (s.bpm < min) min = s.bpm; }
  return { avg: Math.round(sum / inSel.length), max: max, min: min, n: inSel.length };
}
function hrDurationMin() { return Math.max(1, Math.round((HR.selEnd - HR.selStart) / 60000)); }

// Body stats currently in effect (live-edited fields override the resolved defaults).
function hrCurrentBody() {
  const w = $("#hrWeight"), a = $("#hrAge"), s = $("#hrSex");
  return {
    weight_kg: w && w.value ? (+w.value / 2.2046226) : HR.body.weight_kg,
    age: a && a.value ? +a.value : HR.body.age,
    sex: s && s.value ? s.value : HR.body.sex,
  };
}
function hrNeedsBody() {
  if (hrMethod() === "ai") return false; // AI doesn't need body stats
  const b = hrCurrentBody();
  return !(b.weight_kg > 0) || !(b.age > 0);
}

function renderHr() {
  const g = hrGeom();
  const line = HR.samples.map((s, i) => (i ? "L" : "M") + g.tx(s.t).toFixed(1) + " " + g.ty(s.bpm).toFixed(1)).join(" ");
  // A few hour ticks across the window.
  let ticks = "";
  for (let i = 0; i <= 4; i++) {
    const t = HR.tMin + (HR.tMax - HR.tMin) * (i / 4), x = g.tx(t);
    ticks += `<text x="${x.toFixed(1)}" y="${g.H - 6}" class="hrtick" text-anchor="${i === 0 ? "start" : i === 4 ? "end" : "middle"}">${hrClock(t)}</text>`;
  }
  const bodyFields = `
    <div class="hrbody" id="hrBodyFields"${hrNeedsBody() ? "" : " hidden"}>
      <div class="hrbodylbl">For an accurate estimate</div>
      <div class="hrbodygrid">
        <label>Weight (lb)<input type="number" id="hrWeight" min="0" inputmode="decimal" value="${HR.body.weight_kg ? Math.round(HR.body.weight_kg * 2.2046226) : ""}"></label>
        <label>Age<input type="number" id="hrAge" min="0" inputmode="numeric" value="${HR.body.age || ""}"></label>
        <label>Sex<select id="hrSex"><option value=""${HR.body.sex ? "" : " selected"}>—</option><option value="male"${HR.body.sex === "male" ? " selected" : ""}>Male</option><option value="female"${HR.body.sex === "female" ? " selected" : ""}>Female</option></select></label>
      </div>
    </div>`;

  $("#hrBody").innerHTML =
    `<div class="hrgraphwrap">
      <svg id="hrSvg" viewBox="0 0 ${g.W} ${g.H}" preserveAspectRatio="none">
        <rect id="hrBand" x="0" y="${g.y0}" width="0" height="${g.y1 - g.y0}" class="hrband"/>
        <path d="${line}" fill="none" class="hrline"/>
        <line id="hrH0" class="hrhandle" x1="0" y1="${g.y0}" x2="0" y2="${g.y1}"/>
        <line id="hrH1" class="hrhandle" x1="0" y1="${g.y0}" x2="0" y2="${g.y1}"/>
        <circle id="hrG0" class="hrgrip" cx="0" cy="${g.y1}" r="7"/>
        <circle id="hrG1" class="hrgrip" cx="0" cy="${g.y1}" r="7"/>
        ${ticks}
      </svg>
    </div>
    <div class="hrreadout" id="hrReadout"></div>
    <input id="hrName" class="hrname" placeholder="Name this activity — e.g. Yard work" autocomplete="off" maxlength="80">
    ${bodyFields}
    <div class="row end hractions">
      <button class="link" id="hrCancel">Cancel</button>
      <button class="primary" id="hrSave">Add activity</button>
    </div>`;

  hrPaint();
  const svg = $("#hrSvg");
  attachHrDrag(svg);
  $("#hrCancel").addEventListener("click", closeHrPicker);
  $("#hrSave").addEventListener("click", saveHr);
  ["hrWeight", "hrAge", "hrSex"].forEach((id) => { const el = $("#" + id); if (el) el.addEventListener("input", hrPaint); });
}

// Update the band, handles, and readout without rebuilding the SVG (keeps dragging smooth).
function hrPaint() {
  const g = hrGeom();
  const xs = g.tx(HR.selStart), xe = g.tx(HR.selEnd);
  const band = $("#hrBand"); if (band) { band.setAttribute("x", xs.toFixed(1)); band.setAttribute("width", Math.max(0, xe - xs).toFixed(1)); }
  const set = (id, x) => { const el = $("#" + id); if (el) { el.setAttribute("x1", x.toFixed(1)); el.setAttribute("x2", x.toFixed(1)); } };
  const setc = (id, x) => { const el = $("#" + id); if (el) el.setAttribute("cx", x.toFixed(1)); };
  set("hrH0", xs); set("hrH1", xe); setc("hrG0", xs); setc("hrG1", xe);

  const st = hrStats(), mins = hrDurationMin(), method = hrMethod();
  const bf = $("#hrBodyFields"); if (bf) bf.hidden = !hrNeedsBody();
  let est;
  if (method === "ai") {
    est = "calories estimated by AI on save";
  } else {
    const b = hrCurrentBody();
    est = "~" + Math.round(keytelPerMin(st.avg, b.weight_kg, b.age, b.sex) * mins) + " cal";
  }
  const ro = $("#hrReadout");
  if (ro) ro.innerHTML =
    `<b>${est}</b><span>${hrClock(HR.selStart)}–${hrClock(HR.selEnd)} · ${mins} min · avg ${st.avg}${st.max ? " / max " + st.max : ""} bpm</span>`;
}

// Drag either handle (whichever the pointer is nearer) to reshape the window.
function attachHrDrag(svg) {
  const g = hrGeom();
  let active = null;
  const timeAt = (clientX) => {
    const r = svg.getBoundingClientRect();
    return g.xt(g.x0 + (clientX - r.left) / r.width * (g.x1 - g.x0));
  };
  const move = (which, t) => {
    const MIN = 60000;
    if (which === "start") HR.selStart = Math.min(t, HR.selEnd - MIN);
    else HR.selEnd = Math.max(t, HR.selStart + MIN);
    HR.selStart = Math.max(HR.tMin, HR.selStart);
    HR.selEnd = Math.min(HR.tMax, HR.selEnd);
    hrPaint();
  };
  svg.addEventListener("pointerdown", (ev) => {
    ev.preventDefault();
    const t = timeAt(ev.clientX);
    active = Math.abs(t - HR.selStart) <= Math.abs(t - HR.selEnd) ? "start" : "end";
    try { svg.setPointerCapture(ev.pointerId); } catch (_) {}
    move(active, t);
  });
  svg.addEventListener("pointermove", (ev) => { if (active) move(active, timeAt(ev.clientX)); });
  const done = () => { active = null; };
  svg.addEventListener("pointerup", done);
  svg.addEventListener("pointercancel", done);
}

async function saveHr(confirmOverlap) {
  const name = ($("#hrName").value || "").trim();
  if (!name) { toast("Give it a name"); $("#hrName").focus(); return; }
  const st = hrStats();
  if (!st.n) { toast("That window has no heart-rate data"); return; }
  if (hrNeedsBody()) { toast("Add your weight and age for the formula"); return; }
  const btn = $("#hrSave"); if (btn) btn.disabled = true;
  const b = hrCurrentBody();
  const payload = {
    name: name,
    start: new Date(HR.selStart).toISOString(),
    end: new Date(HR.selEnd).toISOString(),
    duration_min: hrDurationMin(),
    avg_hr: st.avg, max_hr: st.max, min_hr: st.min,
    weight_kg: b.weight_kg, age: b.age, sex: b.sex,
    confirm_overlap: !!confirmOverlap,
  };
  try {
    const r = await api("/log/heart-rate", { method: "POST", body: JSON.stringify(payload) });
    if (r && r.overlap) {
      if (btn) btn.disabled = false;
      if (confirm("This window " + r.warning + ". Add it anyway?")) return saveHr(true);
      return;
    }
    // Persist any body stats the user typed so we don't ask again.
    if ($("#hrBodyFields") && ($("#hrWeight").value || $("#hrAge").value || $("#hrSex").value)) {
      try {
        const g = await api("/goals", { method: "PATCH", body: JSON.stringify({ body_weight_kg: b.weight_kg, body_age: b.age, body_sex: b.sex }) });
        ME.body_weight_kg = g.body_weight_kg; ME.body_age = g.body_age; ME.body_sex = g.body_sex;
      } catch (_) {}
    }
    closeHrPicker();
    toast(r.kcal ? ("Logged " + name + " · " + r.kcal + " cal burned") : ("Logged " + name));
    renderHome();
  } catch (e) {
    if (btn) btn.disabled = false;
    toast((e && e.message) || "Couldn't log activity");
  }
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
  renderHome();
  // Native + connected + past the user's chosen interval → quietly pull new workouts.
  // Throttled at launch only; nothing syncs in the background.
  if (isNativeApp() && healthSyncDue()) healthSyncNow(true);
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

// ------------------------------------------------------ pull-to-refresh (home)
// Drag the Home view down from the very top to force a refresh (Health sync + re-render).
// Document-level scroll, so we watch window.scrollY. Non-passive touchmove lets us suppress
// the native overscroll bounce while our own indicator tracks the pull.
(function setupPullToRefresh() {
  const THRESHOLD = 70, MAX = 110, DAMP = 0.5;
  let startY = 0, active = false, pulling = false, busy = false;

  const ind = document.createElement("div");
  ind.className = "ptr";
  ind.innerHTML = '<div class="ptr-spin" aria-hidden="true"></div>';
  document.body.appendChild(ind);

  const atTop = () => (window.scrollY || document.documentElement.scrollTop || 0) <= 0;
  function blocked() {
    const home = document.getElementById("view-home");
    if (!home || home.hidden) return true;
    if (document.querySelector("dialog[open]")) return true;               // goals dialog
    const add = document.getElementById("addSheet"), edit = document.getElementById("editSheet"), hr = document.getElementById("hrSheet");
    if ((add && !add.hidden) || (edit && !edit.hidden) || (hr && !hr.hidden)) return true;  // compose / edit / HR sheets
    return false;
  }
  function show(dist) {
    const d = Math.min(dist, MAX);
    ind.style.transition = "none";               // track the finger 1:1 during the drag
    ind.style.transform = "translateY(" + d + "px)";
    ind.style.opacity = String(Math.min(1, dist / THRESHOLD));
    ind.classList.toggle("ready", dist >= THRESHOLD);
  }
  function reset() { ind.style.transition = ""; ind.style.transform = ""; ind.style.opacity = ""; ind.classList.remove("ready", "spin"); }

  window.addEventListener("touchstart", (e) => {
    if (busy || e.touches.length !== 1 || blocked() || !atTop()) { active = false; return; }
    startY = e.touches[0].clientY; active = true; pulling = false;
  }, { passive: true });

  window.addEventListener("touchmove", (e) => {
    if (!active || busy) return;
    const dy = e.touches[0].clientY - startY;
    if (dy <= 0 || !atTop()) { if (pulling) { pulling = false; reset(); } if (!atTop()) active = false; return; }
    pulling = true;
    e.preventDefault();          // suppress native rubber-band while we own the pull
    show(dy * DAMP);
  }, { passive: false });

  window.addEventListener("touchend", async () => {
    if (!active || !pulling) { active = false; return; }
    active = false; pulling = false;
    if (!ind.classList.contains("ready")) { reset(); return; }
    busy = true;
    ind.classList.add("spin");
    ind.style.transition = "";                   // animate the settle to the spin position
    ind.style.transform = "translateY(56px)";
    ind.style.opacity = "1";
    try { await refreshHome(); } catch (_) {} finally { busy = false; reset(); }
  }, { passive: true });
})();

boot();
