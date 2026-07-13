"use strict";

// Bumped with each deploy; shown in Admin → Instance so you can confirm the loaded build at a glance
// (if it lags the latest, the client is serving a cached bundle).
const APP_VERSION = "v63";

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
  if (name === "coach") { sizeCoach(); coachTabInit(); coachShowPending(); const l = $("#coachTabLog"); if (l) l.scrollTop = l.scrollHeight; }
  if (name === "history") loadHistory();
  if (name === "admin") loadAdmin();
}
$$("[data-view]").forEach((b) => b.addEventListener("click", () => showView(b.dataset.view)));
// Admin section tabs (AI / Instance / Users / Data) — one-time wiring; buttons are static markup.
$$("#adminTabs button").forEach((b) => b.addEventListener("click", () => setAdminSect(b.dataset.group)));

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
  return String(s || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// Only http(s) URLs are safe in an href; anything else (javascript:, data:, …) collapses to "#" so a
// stored string can never become a script link even if the server-side normalization is bypassed.
function safeUrl(u) {
  const s = String(u || "").trim();
  return /^https?:\/\//i.test(s) ? s : "#";
}

// ---------------------------------------------------------------------- log
// -------------------------------------------------------------- Home dashboard
const HOME = { scope: "all", range: "day", chart: "ring" };
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
  // The Weight tab is its own data source (measurements + goals), not the day stats/feed.
  const charts = $("#charts");
  if (HOME.scope === "weight") {
    if (charts) charts.style.visibility = "hidden";
    return renderWeight();
  }
  if (charts) charts.style.visibility = "";
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

// ------------------------------------------------------------------ weight tab
async function renderWeight() {
  const statbody = $("#statbody"), feed = $("#feed");
  let d;
  try { d = await api("/weight?range=" + HOME.range); } catch (e) { statbody.innerHTML = `<div class="subline">${escapeHtml(e.message)}</div>`; return; }
  $("#feedlbl").textContent = "Weight history";
  const cur = d.current_lb || 0;
  const pts = (d.series || []).map((s) => s.weight_lb);
  const goal0 = (d.goals || [])[0];
  const chart = pts.length > 1
    ? lineChart(pts, goal0 ? goal0.target_lb : 0, RC.nutrition)
    : '<div class="subline">Log a few weigh-ins to see your trend.</div>';
  const goalsHtml = (d.goals || []).map((g) => {
    const verb = g.to_go_lb >= 0 ? "to lose" : "to gain";
    const pace = g.pace ? (g.pace.on_track ? '<span class="ontrack">on track</span>' : `<span class="behind">${Math.abs(g.pace.behind_lb)} lb behind</span>`) : "";
    return `<div class="wgoal"><b>${escapeHtml(g.target_lb)} lb</b> by ${escapeHtml(g.target_date)} · ${Math.abs(g.to_go_lb)} lb ${verb} ${pace}</div>`;
  }).join("") || '<div class="subline">No weight goal yet — set one in Goals &amp; tracking.</div>';
  const srcPrompt = (!d.weight_source && isNativeApp())
    ? '<div class="wsrc">Manage weight from <button class="link" id="wsrcHealth">Apple Health</button> or <button class="link" id="wsrcManual">enter it manually</button>?</div>'
    : "";
  statbody.innerHTML =
    `<div class="wcur">${cur ? cur + ' <span class="wunit">lb</span>' : "No weight logged yet"}</div>` +
    chart +
    `<div class="wgoals">${goalsHtml}</div>` +
    srcPrompt +
    '<div class="wlog"><input type="number" id="wIn" placeholder="Log weight (lb)" inputmode="decimal" step="0.1"><button class="primary small" id="wLogBtn">Log</button></div>';
  $("#wLogBtn").addEventListener("click", logWeightManual);
  $("#wIn").addEventListener("keydown", (e) => { if (e.key === "Enter") logWeightManual(); });
  const h = $("#wsrcHealth"); if (h) h.addEventListener("click", () => setWeightSource("health"));
  const m = $("#wsrcManual"); if (m) m.addEventListener("click", () => setWeightSource("manual"));
  feed.innerHTML = (d.series || []).slice().reverse().slice(0, 40).map((s) => {
    const dt = new Date(s.t).toLocaleDateString([], { month: "short", day: "numeric" });
    return `<li class="entry"><div class="body"><b>${s.weight_lb} lb</b> <span class="s">${dt}</span></div></li>`;
  }).join("");
}

async function logWeightManual() {
  const v = +$("#wIn").value;
  if (!(v > 0)) { toast("Enter a weight"); return; }
  try {
    await api("/weight/log", { method: "POST", body: JSON.stringify({ weight_kg: v / 2.2046226 }) });
    ME.body_weight_kg = v / 2.2046226;
    toast("Weight logged");
    renderWeight();
  } catch (e) { toast(e.message); }
}

async function setWeightSource(src) {
  try { const r = await api("/goals", { method: "PATCH", body: JSON.stringify({ weight_source: src }) }); ME.weight_source = r.weight_source; } catch (_) {}
  if (src === "health" && isNativeApp()) await weightSyncNow(false);
  renderWeight();
}

// Apple Health body-mass import (native). Throttled to ≤ every 6h on launch.
async function weightSyncNow(silent) {
  const HK = healthPlugin();
  if (!HK) { if (!silent) toast("Apple Health needs the Sate app"); return; }
  try {
    await HK.requestAuthorization();
    const r = await HK.queryWeights({ months: 12 });
    const res = await api("/weight/sync", { method: "POST", body: JSON.stringify({ weights: (r && r.samples) || [] }) });
    ME.weight_synced_at = res.synced_at; ME.weight_source = "health";
    if (!silent) toast(res.added ? ("Imported " + res.added + " weigh-in" + (res.added === 1 ? "" : "s")) : "Weight up to date");
    if (HOME.scope === "weight" && $("#view-home") && !$("#view-home").hidden) renderWeight();
  } catch (e) { if (!silent) toast((e && e.message) || "Weight sync failed"); }
}
function weightSyncDue() {
  if (!ME || ME.weight_source !== "health") return false;
  const last = ME.weight_synced_at ? Date.parse(ME.weight_synced_at) : 0;
  if (!last) return true;
  return Date.now() - last >= 6 * 3600 * 1000;
}

// ---------------------------------------------------------- nutrition coach chat (Coach tab)
// A persistent, stat-aware chat. Keeps a running transcript so the coach remembers the thread, and
// lets the user attach a photo (menu / plate) to talk through — nothing here is logged.
let COACH = { history: [], pending: null }; // pending = { mimeType, data } image on the next turn
let CHECKIN_PENDING = null; // the latest server-generated check-in awaiting the user, or null

// Entry point used by the nav, the home chatline link, and the account menu.
function openCoach() { showView("coach"); }

// Put a dot on the Coach tab (header + bottom bar) when a check-in is waiting.
function setCheckinBadge(on) {
  $$('[data-view="coach"]').forEach((b) => b.classList.toggle("has-badge", !!on));
}

// On app open (and after a notification), pull the latest pending check-in and flag it. The native
// layer (if present) also schedules a local notification for it.
async function loadPendingCheckin() {
  if (!ME || ME.checkins_enabled === false) { setCheckinBadge(false); return; }
  try { const r = await api("/checkins/pending"); CHECKIN_PENDING = r.checkin || null; }
  catch (_) { CHECKIN_PENDING = null; }
  setCheckinBadge(!!CHECKIN_PENDING);
  if (CHECKIN_PENDING && typeof scheduleCheckinNotification === "function") {
    try { scheduleCheckinNotification(CHECKIN_PENDING); } catch (_) {}
  }
}

// ---- native local notifications for check-ins (delivered via the Capacitor bridge) ----
function localNotifPlugin() {
  if (!window.Capacitor || !window.Capacitor.registerPlugin) return null;
  return window.Capacitor.registerPlugin("LocalNotifications");
}
// LocalNotifications ids must be 32-bit ints; hash the check-in's string id into one deterministically.
function checkinNotifId(s) {
  let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return (Math.abs(h) % 2000000000) + 1;
}
// Deliver the nudge later (not while they're in the app): ~3h out, nudged into 9:00–21:00 local.
function nextCheckinFireTime() {
  const d = new Date(Date.now() + 3 * 3600 * 1000);
  const h = d.getHours();
  if (h < 8) d.setHours(9, 0, 0, 0);
  else if (h >= 21) { d.setDate(d.getDate() + 1); d.setHours(9, 0, 0, 0); }
  return d;
}
let CHECKIN_NOTIF_WIRED = false;
function wireCheckinNotifTap(ln) {
  if (CHECKIN_NOTIF_WIRED) return;
  CHECKIN_NOTIF_WIRED = true;
  try {
    ln.addListener("localNotificationActionPerformed", (ev) => {
      const extra = ev && ev.notification && ev.notification.extra;
      if (extra && extra.view === "coach") loadPendingCheckin().then(() => showView("coach"));
    });
  } catch (_) {}
}
async function scheduleCheckinNotification(c) {
  const ln = isNativeApp() ? localNotifPlugin() : null;
  if (!ln || !c) return;
  wireCheckinNotifTap(ln);
  if (c.notified) return; // already scheduled server-side-tracked
  try {
    const perm = await ln.requestPermissions();
    if (perm && perm.display && perm.display !== "granted") return;
  } catch (_) {}
  try {
    await ln.schedule({ notifications: [{
      id: checkinNotifId(c.id),
      title: (ME && ME.app_name ? ME.app_name : "Sate") + " coach",
      body: c.message,
      schedule: { at: nextCheckinFireTime() },
      extra: { checkinId: c.id, view: "coach" },
    }] });
    api("/checkins/" + c.id + "/notified", { method: "POST" }).catch(() => {});
  } catch (_) {}
}

// When the Coach tab opens, drop any pending check-in into the chat as a coach message and mark it
// seen so it isn't re-shown. It seeds the conversation history so the user's reply is in context.
function coachShowPending() {
  if (!CHECKIN_PENDING) return;
  const c = CHECKIN_PENDING;
  CHECKIN_PENDING = null;
  setCheckinBadge(false);
  const bubble = coachAppend("coach", c.message);
  const tag = document.createElement("div");
  tag.className = "second-tag";
  tag.textContent = "Check-in" + (c.topic ? " · " + c.topic : "");
  bubble.insertBefore(tag, bubble.firstChild);
  COACH.history.push({ role: "assistant", text: c.message });
  const log = $("#coachTabLog"); if (log) log.scrollTop = log.scrollHeight;
  api("/checkins/" + c.id + "/seen", { method: "POST" }).catch(() => {});
}

function coachTabInit() {
  const log = $("#coachTabLog");
  if (!log || log.dataset.init) return;
  log.dataset.init = "1";
  coachAppend("coach", "Hi! I'm your nutrition coach — I know your stats, goals, and recent intake. Ask me anything, or attach a photo of a menu or plate to talk it through. Nothing here gets logged.");
  const q = document.createElement("button");
  q.className = "link coachplan"; q.textContent = "📋 Generate my plan";
  q.onclick = () => coachSend("__plan__");
  log.appendChild(q);
}

function coachAppend(who, text) {
  const el = document.createElement("div");
  el.className = "cmsg " + who; el.textContent = text;
  const log = $("#coachTabLog"); log.appendChild(el); log.scrollTop = log.scrollHeight;
  return el;
}

// ---- image attach ----
function coachAttachFile(file) {
  if (!file) return;
  const fr = new FileReader();
  fr.onload = () => {
    const res = String(fr.result);
    const m = res.match(/^data:([^;]+);base64,(.*)$/);
    if (!m) { toast("Could not read that image"); return; }
    COACH.pending = { mimeType: m[1], data: m[2], url: res };
    const p = $("#coachPreview");
    p.hidden = false;
    p.innerHTML = `<img src="${res}" alt="attached"><button class="cpx" id="coachPrevX" aria-label="Remove photo">×</button>`;
    $("#coachPrevX").onclick = coachClearAttach;
  };
  fr.readAsDataURL(file);
}
function coachClearAttach() {
  COACH.pending = null;
  const p = $("#coachPreview");
  if (p) { p.hidden = true; p.innerHTML = ""; }
  const inp = $("#coachImgInput"); if (inp) inp.value = "";
}

async function coachSend(preset) {
  const inp = $("#coachTabInput");
  const isPlan = preset === "__plan__";
  const msg = isPlan ? "" : (typeof preset === "string" ? preset : (inp ? inp.value : "") || "").trim();
  const image = isPlan ? null : COACH.pending;
  if (!isPlan && !msg && !image) return;
  if (!isPlan) {
    const bubble = coachAppend("me", msg || "");
    if (image) {
      const im = document.createElement("img");
      im.className = "cmsg-img"; im.src = image.url;
      bubble.appendChild(im);
    }
  }
  if (inp) inp.value = "";
  coachClearAttach();
  const thinking = coachAppend("coach", "…");
  const reqBody = isPlan
    ? { mode: "plan" }
    : { mode: "chat", message: msg, history: COACH.history.slice(-20) };
  if (image) reqBody.image = { mimeType: image.mimeType, data: image.data };
  try {
    const r = await api("/nutritionist", { method: "POST", body: JSON.stringify(reqBody) });
    thinking.textContent = r.reply || "(no reply)";
    if (!isPlan) {
      COACH.history.push({ role: "user", text: msg || "(shared a photo to discuss)" });
      COACH.history.push({ role: "assistant", text: r.reply || "" });
    }
    coachSecondOpinionBtn(reqBody);
  } catch (e) { thinking.textContent = (e && e.message) || "Coach unavailable"; }
  $("#coachTabLog").scrollTop = $("#coachTabLog").scrollHeight;
}

// Offer a "Second opinion" on the last coach reply: re-runs the coach with the second-opinion model
// and appends a labeled bubble alongside the original.
function coachSecondOpinionBtn(reqBody) {
  if (ME && ME.second_opinion_enabled === false) return; // admin disabled the feature globally
  const log = $("#coachTabLog");
  const bar = document.createElement("div");
  bar.className = "cmsg-actions";
  const btn = document.createElement("button");
  btn.className = "link";
  btn.textContent = "🔀 Second opinion";
  btn.onclick = async () => {
    btn.disabled = true;
    const thinking = coachAppend("coach second", "…");
    try {
      const r = await api("/nutritionist", { method: "POST", body: JSON.stringify(Object.assign({}, reqBody, { role: "second" })) });
      thinking.textContent = r.reply || "(no reply)";
      thinking.dataset.model = r.model || "";
      const tag = document.createElement("div");
      tag.className = "second-tag";
      tag.textContent = "Second opinion" + (r.model ? " · " + r.model : "");
      thinking.insertBefore(tag, thinking.firstChild);
      bar.remove();
    } catch (e) { thinking.textContent = (e && e.message) || "Second opinion unavailable"; btn.disabled = false; }
    log.scrollTop = log.scrollHeight;
  };
  bar.appendChild(btn);
  log.appendChild(bar);
}

// The coach view is position:fixed between the header and the bottom tab bar; measure both so it
// locks to exactly the free space (heights include safe-area insets and vary by device/orientation).
function sizeCoach() {
  const v = document.getElementById("view-coach");
  if (!v) return;
  const top = document.querySelector(".topbar");
  const tab = document.getElementById("tabbar");
  const topH = top ? Math.round(top.getBoundingClientRect().height) : 0;
  const tabShown = tab && getComputedStyle(tab).display !== "none";
  const tabH = tabShown ? Math.round(tab.getBoundingClientRect().height) : 0;
  v.style.setProperty("--coach-top", topH + "px");
  v.style.setProperty("--coach-bottom", tabH + "px");
}
window.addEventListener("resize", () => { if (!$("#view-coach").hidden) sizeCoach(); });
window.addEventListener("orientationchange", () => setTimeout(sizeCoach, 100));

// Coach tab wiring (static elements → one-time).
(function initCoachTab() {
  const send = $("#coachTabSend"), inp = $("#coachTabInput"), attach = $("#coachAttach"), file = $("#coachImgInput");
  if (send) send.onclick = () => coachSend();
  if (inp) inp.onkeydown = (e) => { if (e.key === "Enter") coachSend(); };
  if (attach && file) attach.onclick = () => file.click();
  if (file) file.addEventListener("change", (e) => { if (e.target.files[0]) coachAttachFile(e.target.files[0]); });
})();

// ------------------------------------------------------------- onboarding wizard
let OB = null;
const OB_ACT = [["sedentary", "Sedentary"], ["light", "Light (1-3 d/wk)"], ["moderate", "Moderate (3-5 d/wk)"], ["active", "Active (6-7 d/wk)"], ["athlete", "Athlete"]];
const OB_METHODS = [["calories", "Calories (simple)"], ["carb", "Carb-focused (low-carb/keto)"], ["protein", "High-protein"], ["fat", "Low-fat"], ["balanced", "Balanced macros"], ["heart", "Heart-healthy"]];
const OB_CHECKIN_FREQ = [["often", "A few times a day"], ["daily", "Once a day"], ["sparse", "Every couple of days"]];

function maybeOnboard() {
  if (!ME || ME.onboarded || OB) return;
  OB = {
    i: 0, name: ME.name || "", weight_lb: "", height_ft: "", height_in: "", age: ME.body_age || "", sex: ME.body_sex || "male",
    activity: ME.activity_level || "moderate", source: isNativeApp() ? "" : "manual",
    goals: [{ target_lb: "", target_date: "" }], method: ME.track_mode || "calories",
    checkin_enabled: ME.checkin_enabled || false, checkin_freq: ME.checkin_freq || "daily",
    targets: null, bmr: 0, tdee: 0, warnings: [],
  };
  // The check-in step only appears when the admin has the feature enabled instance-wide.
  const checkinStep = ME.checkins_enabled !== false ? "checkin" : null;
  OB.steps = ["welcome", "stats", isNativeApp() ? "source" : null, "goals", "method", "review", checkinStep, "plan"].filter(Boolean);
  $("#onboard").hidden = false;
  obRender();
}
function obClose() { $("#onboard").hidden = true; OB = null; }
function obNavBar(back, nextLabel, canNext, skip) {
  return '<div class="ob-nav">' +
    (back ? '<button type="button" class="link" id="obBack">Back</button>' : "<span></span>") +
    '<span class="ob-navr">' + (skip ? '<button type="button" class="link" id="obSkip">Skip</button>' : "") +
    `<button type="button" class="primary" id="obNext"${canNext === false ? " disabled" : ""}>${nextLabel || "Next"}</button></span></div>`;
}
function obGoalRow(g, i) {
  return `<div class="ob-goalrow">` +
    `<label class="ob-gf"><span>Target weight (lb)</span><input type="number" placeholder="e.g. 185" inputmode="decimal" data-gi="${i}" data-gk="target_lb" value="${g.target_lb}"></label>` +
    `<label class="ob-gf"><span>📅 By date</span><input type="date" data-gi="${i}" data-gk="target_date" value="${g.target_date}"></label>` +
    (OB.goals.length > 1 ? `<button type="button" class="link ob-grm" data-grm="${i}">×</button>` : "") + "</div>";
}
const OB_STEP = {
  welcome: () => `<img class="ob-logo" src="/icons/icon-192.png?v2" alt="Sate">` +
    `<h2 style="text-align:center">Welcome to ${escapeHtml((ME && ME.app_name) || "Sate")}</h2>` +
    '<p class="ob-sub" style="text-align:center">Let\'s set up your stats and goals, then build a plan to reach them. Takes about a minute.</p>' +
    '<div class="ob-nav"><button type="button" class="link" id="obDismiss">Skip setup</button><button type="button" class="primary" id="obNext">Get started</button></div>',
  stats: () => '<h2>About you</h2><p class="ob-sub">Used to personalize your coach and calculate your calorie needs.</p>' +
    `<label class="ob-full" style="margin-bottom:10px">Your name<input type="text" id="obName" placeholder="first name" value="${escapeHtml(OB.name)}"></label>` +
    '<div class="ob-grid">' +
    `<label>Weight (lb)<input type="number" id="obW" inputmode="decimal" value="${OB.weight_lb}"></label>` +
    `<label>Height<div class="ob-ht"><input type="number" id="obHf" placeholder="ft" value="${OB.height_ft}"><input type="number" id="obHi" placeholder="in" value="${OB.height_in}"></div></label>` +
    `<label>Age<input type="number" id="obA" value="${OB.age}"></label>` +
    `<label>Sex<select id="obS"><option value="male"${OB.sex === "male" ? " selected" : ""}>Male</option><option value="female"${OB.sex === "female" ? " selected" : ""}>Female</option></select></label>` +
    "</div>" +
    `<label class="ob-full">Activity level<select id="obAct">${OB_ACT.map(([v, l]) => `<option value="${v}"${OB.activity === v ? " selected" : ""}>${l}</option>`).join("")}</select></label>` +
    obNavBar(true, "Next"),
  source: () => '<h2>Weight tracking</h2><p class="ob-sub">How do you want to manage your weight history?</p>' +
    '<div class="ob-choices">' +
    `<button type="button" class="ob-choice${OB.source === "health" ? " on" : ""}" data-src="health">🍎 Apple Health<small>Import automatically</small></button>` +
    `<button type="button" class="ob-choice${OB.source === "manual" ? " on" : ""}" data-src="manual">✏️ Manually<small>Enter it yourself</small></button>` +
    "</div>" + obNavBar(true, "Next", !!OB.source),
  goals: () => '<h2>Your goal</h2><p class="ob-sub">Set up to 3 weight goals — or skip to just track.</p>' +
    `<div id="obGoals">${OB.goals.map((g, i) => obGoalRow(g, i)).join("")}</div>` +
    (OB.goals.length < 3 ? '<button type="button" class="link" id="obAddGoal">+ Add another goal</button>' : "") +
    obNavBar(true, "Next", true, true),
  method: () => '<h2>Tracking method</h2><p class="ob-sub">How do you want to hit your goal?</p>' +
    `<div class="ob-methods">${OB_METHODS.map(([v, l]) => `<button type="button" class="ob-method${OB.method === v ? " on" : ""}" data-m="${v}">${l}</button>`).join("")}</div>` +
    obNavBar(true, "Calculate my plan"),
  review: () => '<h2>Your targets</h2>' +
    (OB.targets ? '<div class="ob-targets">' +
      `<div><b>${OB.targets.kcal}</b><span>kcal/day</span></div><div><b>${OB.targets.protein}g</b><span>protein</span></div>` +
      `<div><b>${OB.targets.carbs}g</b><span>carbs</span></div><div><b>${OB.targets.fat}g</b><span>fat</span></div></div>` +
      `<p class="ob-sub">BMR ${OB.bmr} · maintenance ${OB.tdee} kcal/day.</p>` : '<p class="ob-sub">Calculating…</p>') +
    (OB.warnings.length ? `<div class="ob-warn">⚠ ${OB.warnings.map(escapeHtml).join("<br>")}</div>` : "") +
    obNavBar(true, "See my plan"),
  checkin: () => '<h2>Coach check-ins</h2>' +
    '<p class="ob-sub">Want Sate to review your logs and reach out with a helpful, personal nudge when it spots something useful? You can change this anytime in settings.</p>' +
    '<div class="ob-choices">' +
    `<button type="button" class="ob-choice${OB.checkin_enabled ? " on" : ""}" data-ci="1">🔔 Yes, check in with me<small>Proactive coaching nudges</small></button>` +
    `<button type="button" class="ob-choice${!OB.checkin_enabled ? " on" : ""}" data-ci="0">🔕 No thanks<small>I'll open the coach myself</small></button>` +
    "</div>" +
    (OB.checkin_enabled ? '<label class="ob-full" style="margin-top:12px">How often, at most?' +
      `<select id="obCiFreq">${OB_CHECKIN_FREQ.map(([v, l]) => `<option value="${v}"${OB.checkin_freq === v ? " selected" : ""}>${l}</option>`).join("")}</select></label>` : "") +
    obNavBar(true, "Next"),
  plan: () => '<h2>Your plan</h2><div class="ob-plan" id="obPlan">Generating your plan…</div>' +
    '<div class="ob-nav"><button type="button" class="link" id="obBack">Back</button><button type="button" class="primary" id="obNext">Finish</button></div>',
};
function obRender() {
  const s = OB.steps[OB.i];
  const dots = '<div class="ob-progress">' + OB.steps.map((_, i) => `<i class="${i === OB.i ? "on" : ""}"></i>`).join("") + "</div>";
  $("#onboardBody").innerHTML = dots + OB_STEP[s]();
  obWire(s);
}
function obCaptureStats() {
  if ($("#obName")) OB.name = $("#obName").value;
  if ($("#obW")) OB.weight_lb = $("#obW").value;
  if ($("#obHf")) OB.height_ft = $("#obHf").value;
  if ($("#obHi")) OB.height_in = $("#obHi").value;
  if ($("#obA")) OB.age = $("#obA").value;
  if ($("#obS")) OB.sex = $("#obS").value;
  if ($("#obAct")) OB.activity = $("#obAct").value;
}
function obCaptureGoals() { $$("#obGoals [data-gk]").forEach((el) => { const i = +el.dataset.gi; if (OB.goals[i]) OB.goals[i][el.dataset.gk] = el.value; }); }
function obHeightCm() { return Math.round((+OB.height_ft * 12 + (+OB.height_in || 0)) * 2.54); }
function obGo() { OB.i = Math.min(OB.steps.length - 1, OB.i + 1); obRender(); }
function obWire(s) {
  const back = $("#obBack"); if (back) back.onclick = () => { OB.i = Math.max(0, OB.i - 1); obRender(); };
  const next = $("#obNext"); if (next) next.onclick = () => obNext(s);
  const skip = $("#obSkip"); if (skip) skip.onclick = () => { OB.goals = []; obGo(); };
  const dis = $("#obDismiss"); if (dis) dis.onclick = obDismiss;
  if (s === "source") $$(".ob-choice").forEach((b) => (b.onclick = () => { OB.source = b.dataset.src; obRender(); }));
  if (s === "method") $$(".ob-method").forEach((b) => (b.onclick = () => { OB.method = b.dataset.m; obRender(); }));
  if (s === "checkin") {
    $$(".ob-choice[data-ci]").forEach((b) => (b.onclick = () => { OB.checkin_enabled = b.dataset.ci === "1"; obRender(); }));
    const f = $("#obCiFreq"); if (f) f.onchange = () => { OB.checkin_freq = f.value; };
  }
  if (s === "goals") {
    const add = $("#obAddGoal"); if (add) add.onclick = () => { obCaptureGoals(); OB.goals.push({ target_lb: "", target_date: "" }); obRender(); };
    $$("#obGoals [data-gk]").forEach((el) => (el.onchange = () => { const i = +el.dataset.gi; if (OB.goals[i]) OB.goals[i][el.dataset.gk] = el.value; }));
    $$("#obGoals [data-grm]").forEach((el) => (el.onclick = () => { obCaptureGoals(); OB.goals.splice(+el.dataset.grm, 1); obRender(); }));
  }
  if (s === "plan") obPlan();
}
async function obNext(s) {
  if (s === "stats") { obCaptureStats(); return obGo(); }
  if (s === "goals") { obCaptureGoals(); return obGo(); }
  if (s === "method") return obComputeThenReview();
  if (s === "review") return obSaveThenPlan();
  if (s === "checkin") {
    const f = $("#obCiFreq"); if (f) OB.checkin_freq = f.value;
    try {
      await api("/goals", { method: "PATCH", body: JSON.stringify({ checkin_enabled: !!OB.checkin_enabled, checkin_freq: OB.checkin_freq }) });
      if (ME) { ME.checkin_enabled = !!OB.checkin_enabled; ME.checkin_freq = OB.checkin_freq; }
    } catch (_) {}
    return obGo();
  }
  if (s === "plan") return obFinish();
  obGo();
}
async function obCompute() {
  const goals = OB.goals.filter((g) => +g.target_lb > 0 && g.target_date).map((g) => ({ target_lb: +g.target_lb, target_date: g.target_date }));
  const r = await api("/plan/compute", { method: "POST", body: JSON.stringify({
    weight_lb: +OB.weight_lb, height_cm: obHeightCm(), age: +OB.age, sex: OB.sex, activity: OB.activity, method: OB.method, goals: goals,
  }) });
  OB.targets = r.targets; OB.bmr = r.bmr; OB.tdee = r.tdee; OB.warnings = r.warnings || [];
}
async function obComputeThenReview() {
  const n = $("#obNext"); if (n) { n.disabled = true; n.textContent = "Calculating…"; }
  try { await obCompute(); } catch (e) { toast(e.message); if (n) { n.disabled = false; n.textContent = "Calculate my plan"; } return; }
  obGo();
}
async function obSaveAll() {
  const cm = obHeightCm();
  const payload = {
    name: (OB.name || "").trim(),
    body_age: +OB.age || 0, body_sex: OB.sex, height_cm: cm, activity_level: OB.activity,
    track_mode: OB.method, weight_source: OB.source || "manual", onboarded: true,
  };
  if (OB.targets) {
    payload.goal_kcal = OB.targets.kcal; payload.goal_protein = OB.targets.protein;
    payload.goal_carbs = OB.targets.carbs; payload.goal_fat = OB.targets.fat; payload.goal_sodium = OB.targets.sodium;
  }
  await api("/goals", { method: "PATCH", body: JSON.stringify(payload) });
  if (+OB.weight_lb > 0) await api("/weight/log", { method: "POST", body: JSON.stringify({ weight_kg: +OB.weight_lb / 2.2046226, height_cm: cm }) });
  for (const g of OB.goals) {
    if (+g.target_lb > 0 && g.target_date) { try { await api("/weight/goals", { method: "POST", body: JSON.stringify({ target_lb: +g.target_lb, target_date: g.target_date }) }); } catch (_) {} }
  }
  try { ME = await api("/me"); } catch (_) {}
  if (OB.source === "health" && isNativeApp()) { try { await weightSyncNow(true); } catch (_) {} }
}
async function obSaveThenPlan() {
  const n = $("#obNext"); if (n) { n.disabled = true; n.textContent = "Saving…"; }
  try { await obSaveAll(); } catch (e) { toast(e.message); if (n) { n.disabled = false; n.textContent = "See my plan"; } return; }
  obGo();
}
async function obPlan() {
  if (OB._planned) return;
  OB._planned = true;
  try { const r = await api("/nutritionist", { method: "POST", body: JSON.stringify({ mode: "plan" }) }); $("#obPlan").textContent = r.reply || "(no plan)"; }
  catch (e) { $("#obPlan").textContent = (e && e.message) || "Couldn't generate a plan right now."; }
}
async function obDismiss() {
  try { await api("/goals", { method: "PATCH", body: JSON.stringify({ onboarded: true }) }); ME.onboarded = true; } catch (_) {}
  obClose();
}
function obFinish() {
  obClose();
  if (ME && ME.app_name) $("#brandName").textContent = ME.app_name;
  if (ME && ME.isAdmin) $$("[data-admin-only]").forEach((el) => (el.hidden = false));
  showView("home");
}

// ------------------------------------------------------- first-run admin setup wizard
// Shown to an admin on an unconfigured instance (no AI key yet). Walks through app name → first AI
// key → default model → feature toggles, using the existing admin endpoints, then marks setup done.
let AS = null;
const AS_PROVIDERS = [["google", "Google Gemini"], ["anthropic", "Anthropic Claude"], ["openai", "OpenAI"], ["openrouter", "OpenRouter"]];

function maybeAdminSetup() {
  if (!ME || !ME.isAdmin || ME.setup_done || AS) return false;
  AS = { i: 0, app_name: ME.app_name || "Sate", provider: "google", api_key: "", model: "", models: [], checkins: true, second: true, admins: "" };
  AS.steps = ["welcome", "provider", "model", "features"];
  $("#adminSetup").hidden = false;
  asRender();
  return true;
}
function asClose() { $("#adminSetup").hidden = true; AS = null; }
function asNavBar(back, nextLabel, canNext) {
  return '<div class="ob-nav">' +
    (back ? '<button type="button" class="link" id="asBack">Back</button>' : "<span></span>") +
    `<button type="button" class="primary" id="asNext"${canNext === false ? " disabled" : ""}>${nextLabel || "Next"}</button></div>`;
}
const AS_STEP = {
  welcome: () => `<img class="ob-logo" src="/icons/icon-192.png?v2" alt="Sate">` +
    '<h2 style="text-align:center">Set up your instance</h2>' +
    '<p class="ob-sub" style="text-align:center">A few quick steps to get Sate running: name it, add an AI key, pick a default model.</p>' +
    `<label class="ob-full">Instance name<input type="text" id="asName" value="${escapeHtml(AS.app_name)}" placeholder="Sate"></label>` +
    asNavBar(false, "Get started"),
  provider: () => '<h2>Add an AI provider</h2><p class="ob-sub">Bring your own key. You can add more later in Admin.</p>' +
    `<label class="ob-full">Provider<select id="asProv">${AS_PROVIDERS.map(([v, l]) => `<option value="${v}"${AS.provider === v ? " selected" : ""}>${l}</option>`).join("")}</select></label>` +
    `<label class="ob-full" style="margin-top:10px">API key<input type="password" id="asKey" value="${escapeHtml(AS.api_key)}" placeholder="paste your key" autocomplete="off"></label>` +
    asNavBar(true, "Add key"),
  model: () => '<h2>Default model</h2><p class="ob-sub">Every AI task uses this unless you override it per-task later. Pick one that supports 👁 images so photo logging works.</p>' +
    (AS.models.length
      ? `<label class="ob-full">Model<select id="asModel">${AS.models.map((m) => `<option value="${escapeHtml(m.id)}"${AS.model === m.id ? " selected" : ""}>${m.vision ? "👁 " : ""}${escapeHtml(m.label || m.id)}</option>`).join("")}</select></label>`
      : '<p class="ob-warn">No models loaded — check the key. You can set this later in Admin.</p>') +
    asNavBar(true, "Next"),
  features: () => '<h2>Optional features</h2><p class="ob-sub">Turn these on or off for everyone (adjustable anytime in Admin).</p>' +
    `<label class="checkrow"><input type="checkbox" id="asCheckins"${AS.checkins ? " checked" : ""}> <span>Proactive check-ins<small>Sate reviews logs and nudges users when useful.</small></span></label>` +
    `<label class="checkrow"><input type="checkbox" id="asSecond"${AS.second ? " checked" : ""}> <span>Second opinion<small>Let users request an alternate model.</small></span></label>` +
    `<label class="ob-full" style="margin-top:10px">Extra admin emails <small class="muted">(comma-separated, optional)</small><input type="text" id="asAdmins" value="${escapeHtml(AS.admins)}" placeholder="alex@example.com, sam@example.com"></label>` +
    asNavBar(true, "Finish setup"),
};
function asRender() {
  $("#adminSetupBody").innerHTML = AS_STEP[AS.steps[AS.i]]();
  const s = AS.steps[AS.i];
  const back = $("#asBack"); if (back) back.onclick = () => { AS.i = Math.max(0, AS.i - 1); asRender(); };
  const next = $("#asNext"); if (next) next.onclick = () => asNext(s);
}
function asGo() { AS.i = Math.min(AS.steps.length - 1, AS.i + 1); asRender(); }
async function asNext(s) {
  const n = $("#asNext");
  if (s === "welcome") { AS.app_name = ($("#asName").value || "Sate").trim(); return asGo(); }
  if (s === "provider") {
    AS.provider = $("#asProv").value; AS.api_key = $("#asKey").value.trim();
    if (!AS.api_key) return toast("Paste an API key");
    if (n) { n.disabled = true; n.textContent = "Checking…"; }
    try {
      await api("/admin/providers", { method: "PUT", body: JSON.stringify({ name: AS.provider, api_key: AS.api_key, enabled: true }) });
      const r = await api("/admin/models?provider=" + AS.provider);
      AS.models = r.models || [];
      const vis = AS.models.find((m) => m.vision) || AS.models[0];
      AS.model = vis ? vis.id : "";
    } catch (e) { toast(e.message); if (n) { n.disabled = false; n.textContent = "Add key"; } return; }
    return asGo();
  }
  if (s === "model") { if ($("#asModel")) AS.model = $("#asModel").value; return asGo(); }
  if (s === "features") {
    AS.checkins = $("#asCheckins").checked; AS.second = $("#asSecond").checked; AS.admins = $("#asAdmins").value.trim();
    if (n) { n.disabled = true; n.textContent = "Saving…"; }
    try {
      await api("/admin/settings", { method: "PUT", body: JSON.stringify({
        app_name: AS.app_name,
        default_ai_provider: AS.provider, default_ai_model: AS.model,
        default_vision_provider: AS.provider, default_vision_model: AS.model,
        checkins_enabled: AS.checkins ? "on" : "off",
        second_opinion_enabled: AS.second ? "on" : "off",
        setup_complete: "yes",
      }) });
      for (const em of AS.admins.split(",").map((x) => x.trim().toLowerCase()).filter((x) => x.indexOf("@") !== -1)) {
        try { await api("/admin/users/role", { method: "PUT", body: JSON.stringify({ email: em, role: "admin" }) }); } catch (_) {}
      }
      ME = await api("/me");
    } catch (e) { toast(e.message); if (n) { n.disabled = false; n.textContent = "Finish setup"; } return; }
    asClose();
    if (ME.app_name) { $("#brandName").textContent = ME.app_name; document.title = ME.app_name + " — calorie chat"; }
    toast("Instance ready 🎉");
    showView("admin");
    return;
  }
  asGo();
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
      : HOME.scope === "all"
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
$("#mfBg").addEventListener("click", closeManualFood);
$("#fsBg").addEventListener("click", closeFoodSearch);

// Keyboard-aware bottom sheets: track the visual viewport and publish the on-screen keyboard
// height as --kb, so .sheet lifts above the keyboard and shrinks to the visible area (iOS
// otherwise anchors position:fixed to the layout viewport, burying the sheet behind the keyboard).
(function () {
  const vv = window.visualViewport;
  if (!vv) return;
  let raf = 0;
  const apply = () => {
    raf = 0;
    const kb = Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop));
    document.documentElement.style.setProperty("--kb", kb + "px");
  };
  const schedule = () => { if (!raf) raf = requestAnimationFrame(apply); };
  vv.addEventListener("resize", schedule);
  vv.addEventListener("scroll", schedule);
  apply();
})();

// Background scroll-lock while any bottom sheet is open. Without this, focusing an input in a
// position:fixed sheet lets iOS scroll the document to "reveal" the field — which drags the whole
// fixed sheet up off-screen (the field ends up above the top, and you see the results instead).
// Pinning the body defeats that: with nothing to scroll, the sheet stays anchored above the keyboard.
let _lockedScrollY = 0;
function syncScrollLock() {
  const open = !!document.querySelector(".sheet:not([hidden])");
  const locked = document.body.classList.contains("sheet-open");
  if (open && !locked) {
    _lockedScrollY = window.scrollY || window.pageYOffset || 0;
    document.body.style.top = `-${_lockedScrollY}px`;
    document.body.classList.add("sheet-open");
  } else if (!open && locked) {
    document.body.classList.remove("sheet-open");
    document.body.style.top = "";
    window.scrollTo(0, _lockedScrollY);
  }
}
$$("#addScope button").forEach((b) => b.addEventListener("click", () => setAddTab(b.dataset.add)));

function renderFeed(entries) {
  $("#feedlbl").textContent = "Today";
  const scope = HOME.scope;
  const rows = entries.filter((en) => scope === "all" || (scope === "nutrition" && en.kind !== "activity") || (scope === "activity" && en.kind === "activity"));
  const ul = $("#feed");
  ul.innerHTML = "";
  if (!rows.length) {
    ul.innerHTML = '<li class="hint" style="color:var(--muted);font-size:13px;padding:10px 2px">Nothing logged yet — tap <b>+ Add to log</b>.</li>';
    return;
  }
  rows.forEach((en) => ul.appendChild(entryLi(en)));
}

const ICON_EDIT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>';
const ICON_TRASH = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M6 6l1 14h10l1-14"/></svg>';

function entryLi(en) {
  const li = document.createElement("div");
  li.className = "entry";
  const activity = en.kind === "activity";
  const items = (en.items || []).map((i) => i.name).join(", ");
  const title = en.description || items || (activity ? "Activity" : "Entry");
  const timeStr = timeOf(en.logged_at);
  const sub = activity
    ? [timeStr, en.duration_min ? Math.round(en.duration_min) + " min" : "", en.intensity, en.note].filter(Boolean).join(" · ")
    : [timeStr, items || en.source, en.note].filter(Boolean).join(" · ");
  const kcal = activity
    ? `<span class="ekcal out">−${fmt(en.kcal)}<small> cal</small></span>`
    : `<span class="ekcal">${fmt(en.kcal)}<small> kcal</small></span>`;
  // Apple Health-imported workouts get a small badge so the source is unmistakable.
  const badge = en.source === "health"
    ? `<span class="health" title="From Apple Health">${HEART}Health</span>` : "";
  li.innerHTML =
    `<span class="ticon ${activity ? "a" : "n"}">${activity ? TICON.a : TICON.n}</span>` +
    `<span class="etext"><span class="t">${escapeHtml(title)}${badge}</span><span class="s">${escapeHtml(sub)}</span></span>` +
    kcal +
    `<span class="eactions">` +
    `<button class="eact" type="button" data-edit title="Edit" aria-label="Edit">${ICON_EDIT}</button>` +
    `<button class="eact del" type="button" data-del title="Delete" aria-label="Delete">${ICON_TRASH}</button>` +
    `</span>`;
  li.querySelector("[data-edit]").addEventListener("click", (ev) => { ev.stopPropagation(); openEdit(en); });
  li.querySelector("[data-del]").addEventListener("click", async (ev) => {
    ev.stopPropagation();
    if (!confirm("Delete this " + (activity ? "activity" : "food") + " entry?")) return;
    try { await deleteEntry(en.id); toast("Deleted"); } catch (e) { toast(e.message); }
  });
  li.addEventListener("click", () => openEdit(en));
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
  afterEntryChange();
}
// Refresh whichever log view is showing after an edit/delete (Home feed or History).
function afterEntryChange() {
  const h = document.getElementById("view-history");
  if (h && !h.hidden) loadHistory(); else renderHome();
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
function openAdd() { addTab = "nutrition"; setAddTab("nutrition"); $("#addBg").hidden = false; $("#addSheet").hidden = false; syncScrollLock(); }
function closeAdd() { $("#addBg").hidden = true; $("#addSheet").hidden = true; syncScrollLock(); }
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
      `<div class="addscroll">` +
      `<div class="reslist" id="mealResults"></div>` +
      `<div class="methods">` +
      `<button class="method" id="mBarcode"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 5v14M7 5v14M11 5v14M14 5v14M18 5v14M21 5v14"/></svg><b>Barcode</b><span>scan a package</span></button>` +
      `<button class="method" id="mPhoto"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="7" width="18" height="13" rx="3"/><circle cx="12" cy="13.5" r="3.5"/><path d="M9 7l1.5-2h3L15 7"/></svg><b>Photo AI</b><span>snap your plate</span></button>` +
      `</div>` +
      `<button class="aibtn" id="mLog" style="background:var(--brand);color:var(--brand-ink);border-style:solid;border-color:var(--brand)">Log with AI estimate</button>` +
      `</div>`;
    const inp = $("#mealInput");
    inp.addEventListener("keydown", (e) => { if (e.key === "Enter") logMeal(inp.value); });
    inp.addEventListener("input", () => { clearTimeout(mealTimer); mealTimer = setTimeout(runMealSearch, 180); });
    $("#mLog").addEventListener("click", () => logMeal(inp.value));
    $("#mBarcode").addEventListener("click", () => { closeAdd(); openScanner(); });
    $("#mPhoto").addEventListener("click", () => $("#photoInput").click());
    setTimeout(() => inp.focus(), 60);
  } else {
    b.innerHTML =
      `<div class="search"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4-4" stroke-linecap="round"/></svg>` +
      `<input id="actInput" placeholder="Search activities… e.g. running" autocomplete="off"></div>` +
      `<div class="dur"><label>Duration</label><input id="actDur" type="number" min="1" value="30"> <label>min</label></div>` +
      `<div class="addscroll">` +
      `<div class="reslist" id="actResults"></div>` +
      `<button class="aibtn" id="actAI" style="border-color:color-mix(in srgb,var(--activity) 45%,var(--line));color:var(--activity)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l1.8 4.2L18 9l-4.2 1.8L12 15l-1.8-4.2L6 9l4.2-1.8z"/></svg>Estimate with AI — describe the workout</button>` +
      (isNativeApp() ? `<button class="aibtn" id="actHR" style="border-color:color-mix(in srgb,var(--activity) 45%,var(--line));color:var(--activity)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12h4l2.5 6 4-14 2.5 8H22"/></svg>From heart rate — pick a window from your watch</button>` : "") +
      `</div>`;
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

// -------------------------------------------------- food autocomplete + search
let mealTimer = null;
let mealFoods = [];
function n1(x) { return Math.round((+x || 0) * 10) / 10; }

// Live dropdown under the "What did you eat?" input: two pinned actions on top
// (add manually / search the internet), then matching foods from your database.
async function runMealSearch() {
  const inp = $("#mealInput");
  const box = $("#mealResults");
  if (!inp || !box) return;
  const q = inp.value.trim();
  if (!q) { box.innerHTML = ""; mealFoods = []; return; }
  try { mealFoods = (await api("/foods/search?q=" + encodeURIComponent(q))).foods || []; }
  catch (_) { mealFoods = []; }
  if ($("#mealInput") !== inp || inp.value.trim() !== q) return; // a newer keystroke won
  const esc = escapeHtml(q);
  let html =
    `<button class="res act" data-mact="manual"><div class="rt"><b>➕ Add “${esc}” manually</b><span>enter the nutrition facts yourself</span></div><span class="add">›</span></button>` +
    `<button class="res act" data-mact="web"><div class="rt"><b>🔎 Search the internet for “${esc}”</b><span>your database, USDA, Open Food Facts &amp; the web</span></div><span class="add">›</span></button>`;
  if (mealFoods.length) {
    html += `<div class="grouplbl">In your database</div>` + mealFoods.map((f, i) => foodResRow(f, i)).join("");
  }
  box.innerHTML = html;
  $("#mealResults [data-mact='manual']").addEventListener("click", () => openManualFood(q));
  $("#mealResults [data-mact='web']").addEventListener("click", () => openFoodSearch(q));
  $$("#mealResults .res.food").forEach((el) => el.addEventListener("click", () => pickFood(mealFoods[+el.dataset.i])));
}
function foodResRow(f, i) {
  const brand = f.brand ? " · " + escapeHtml(f.brand) : "";
  return `<button class="res food" data-i="${i}"><div class="rt"><b>${escapeHtml(f.name)}</b>` +
    `<span>${escapeHtml(f.serving_desc || "1 serving")}${brand} · ${Math.round(f.kcal)} kcal · ${Math.round(f.protein || 0)}P ${Math.round(f.carbs || 0)}C ${Math.round(f.fat || 0)}F</span></div>` +
    `<span class="add">+</span></button>`;
}
async function pickFood(f) {
  if (!f) return;
  closeAdd();
  toast("Logging…");
  try {
    const r = await api("/log/food", { method: "POST", body: JSON.stringify({ food_id: f.id }) });
    toast(`Logged ${fmt(r.entry.kcal)} kcal.`);
    afterEntryChange();
  } catch (e) { toast(e.message); }
}

// "Add manually" — a food editor prefilled with the typed name; saves to your DB and logs it.
function openManualFood(name) {
  const fields = MANUAL_FIELDS.food;
  $("#mfBody").innerHTML =
    `<label class="mfield"><span>Name</span><input id="mfName" maxlength="200" value="${escapeHtml(name || "")}" placeholder="e.g. Grandma's chili"></label>` +
    `<label class="mfield"><span>Serving <em>(optional)</em></span><input id="mfServing" maxlength="40" placeholder="e.g. 1 cup"></label>` +
    `<label class="mfield"><span>Note <em>(optional)</em></span><input id="mfNote" maxlength="2000" placeholder="Add a note…"></label>` +
    `<div class="manualgrid">` + fields.map(([k, label, u]) =>
      `<label class="mfield"><span>${label}${u ? ` <em>(${u})</em>` : ""}</span><input type="number" step="any" inputmode="decimal" data-mf="${k}"></label>`).join("") + `</div>` +
    `<div class="sheet-actions"><button class="primary" id="mfSave" style="flex:1">Add &amp; log</button></div>`;
  $("#mfSave").addEventListener("click", saveManualFood);
  $("#mfBg").hidden = false; $("#mfSheet").hidden = false; $("#mfSheet").scrollTop = 0; syncScrollLock();
  setTimeout(() => $("#mfName").focus(), 60);
}
function closeManualFood() { $("#mfBg").hidden = true; $("#mfSheet").hidden = true; syncScrollLock(); }
async function saveManualFood() {
  const name = $("#mfName").value.trim();
  if (!name) { toast("Name is required"); return; }
  const payload = { name: name, serving_desc: $("#mfServing").value.trim(), note: $("#mfNote").value.trim() };
  $$("#mfBody [data-mf]").forEach((inp) => { const raw = inp.value.trim(); if (raw !== "" && !isNaN(+raw)) payload[inp.dataset.mf] = +raw; });
  closeManualFood(); closeAdd();
  toast("Adding…");
  try {
    const r = await api("/foods/manual", { method: "POST", body: JSON.stringify(payload) });
    toast(`Logged ${fmt(r.entry.kcal)} kcal.`);
    afterEntryChange();
  } catch (e) { toast(e.message); }
}

// Internet search overlay — a taller, scrollable sheet of results from every source.
const FS_SOURCE = { local: "In your database", usda: "USDA FoodData Central", off: "Open Food Facts", web: "From the web (AI)" };
const FS_ORDER = ["local", "usda", "off", "web"];
let fsResults = [];
let fsSeq = 0;
function openFoodSearch(q) {
  $("#fsBody").innerHTML =
    `<div class="search"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4-4" stroke-linecap="round"/></svg>` +
    `<input id="fsInput" value="${escapeHtml(q || "")}" placeholder="Search foods…" autocomplete="off"></div>` +
    `<div class="fsresults" id="fsResults"></div>`;
  const inp = $("#fsInput");
  inp.addEventListener("keydown", (e) => { if (e.key === "Enter") runFoodSearch(inp.value.trim()); });
  $("#fsBg").hidden = false; $("#fsSheet").hidden = false; syncScrollLock();
  runFoodSearch(q);
  setTimeout(() => inp.focus(), 60);
}
function closeFoodSearch() { $("#fsBg").hidden = true; $("#fsSheet").hidden = true; syncScrollLock(); }
async function runFoodSearch(q) {
  q = (q || "").trim();
  const box = $("#fsResults");
  if (!q) { box.innerHTML = `<div class="grouplbl">Type something to search.</div>`; return; }
  const seq = ++fsSeq;
  fsResults = [];
  box.innerHTML = `<div class="grouplbl">Searching your database, USDA &amp; Open Food Facts…</div>`;
  try {
    const r = await api("/foods/search-online?q=" + encodeURIComponent(q));
    if (seq !== fsSeq) return;
    fsResults = r.results || [];
  } catch (e) { if (seq === fsSeq) box.innerHTML = `<div class="grouplbl">${escapeHtml(e.message || "Search failed")}</div>`; }
  renderFsResults();
  // AI/web candidate streams in separately so it never blocks the structured results.
  api("/foods/web-candidate", { method: "POST", body: JSON.stringify({ q: q }) })
    .then((r) => { if (seq === fsSeq && r && r.result) { fsResults.push(r.result); renderFsResults(); } })
    .catch(() => {});
}
function renderFsResults() {
  const box = $("#fsResults");
  if (!fsResults.length) {
    box.innerHTML = `<div class="grouplbl">No matches yet — the AI web result may still be loading, or add it manually.</div>`;
    return;
  }
  const groups = {};
  fsResults.forEach((r, i) => { (groups[r.source] = groups[r.source] || []).push(i); });
  let html = "";
  FS_ORDER.forEach((s) => {
    if (!groups[s]) return;
    html += `<div class="grouplbl">${FS_SOURCE[s] || s}</div>`;
    html += groups[s].map((i) => {
      const f = fsResults[i], brand = f.brand ? " · " + escapeHtml(f.brand) : "";
      return `<button class="res" data-i="${i}"><div class="rt"><b>${escapeHtml(f.name)}</b>` +
        `<span>${escapeHtml(f.serving_desc || "1 serving")}${brand} · ${Math.round(f.kcal)} kcal · ${Math.round(f.protein || 0)}P ${Math.round(f.carbs || 0)}C ${Math.round(f.fat || 0)}F</span></div>` +
        `<span class="add">›</span></button>`;
    }).join("");
  });
  box.innerHTML = html;
  $$("#fsResults .res").forEach((el) => el.addEventListener("click", () => openFsDetail(+el.dataset.i)));
}
function openFsDetail(i) {
  const f = fsResults[i];
  if (!f) return;
  const rows = [["Serving", escapeHtml(f.serving_desc || "1 serving")], ["Calories", Math.round(f.kcal) + " kcal"],
    ["Protein", n1(f.protein) + " g"], ["Carbs", n1(f.carbs) + " g"], ["Fat", n1(f.fat) + " g"],
    ["Fiber", n1(f.fiber) + " g"], ["Sugar", n1(f.sugar) + " g"], ["Sodium", Math.round(f.sodium || 0) + " mg"], ["Sat. fat", n1(f.sat_fat) + " g"]];
  $("#fsResults").innerHTML =
    `<button class="link" id="fsBack">‹ Back to results</button>` +
    `<div class="fsdetail"><h4>${escapeHtml(f.name)}${f.brand ? ` <span class="muted">${escapeHtml(f.brand)}</span>` : ""}</h4>` +
    `<div class="muted" style="font-size:12px;margin-bottom:8px">${FS_SOURCE[f.source] || f.source}</div>` +
    `<div class="kvs">${rows.map(([k, v]) => `<div class="kv"><span>${k}</span><b>${v}</b></div>`).join("")}</div>` +
    `<div class="sheet-actions"><button class="primary" id="fsAccept" style="flex:1">Accept &amp; log this</button></div>` +
    `<div class="subline" style="text-align:left;margin-top:8px">We'll ask AI to tidy the numbers, fill any gaps, and save it to your database.</div></div>`;
  $("#fsBack").addEventListener("click", renderFsResults);
  $("#fsAccept").addEventListener("click", () => acceptFood(f));
}
async function acceptFood(f) {
  toast("Normalizing with AI…");
  try {
    const r = await api("/foods/accept", { method: "POST", body: JSON.stringify({ candidate: f }) });
    closeFoodSearch(); closeAdd();
    toast(`Logged ${fmt(r.entry.kcal)} kcal.`);
    afterEntryChange();
  } catch (e) { toast(e.message); }
}

// ------------------------------------------------------------------- edit sheet
let editEntry = null;
// Editable numeric fields per entry kind, for the "edit manually" section.
const MANUAL_FIELDS = {
  food: [["kcal", "Calories", "kcal"], ["protein", "Protein", "g"], ["carbs", "Carbs", "g"], ["fat", "Fat", "g"],
    ["fiber", "Fiber", "g"], ["sugar", "Sugar", "g"], ["sodium", "Sodium", "mg"], ["sat_fat", "Sat. fat", "g"]],
  activity: [["kcal", "Calories burned", "cal"], ["duration_min", "Duration", "min"], ["distance", "Distance", "mi"]],
};
function openEdit(en) {
  editEntry = en;
  const activity = en.kind === "activity";
  $("#editTitle").textContent = en.description || "Edit entry";
  const unit = activity ? "cal burned" : "kcal";
  const scales = [["½", 0.5], ["¾", 0.75], ["1¼", 1.25], ["1½", 1.5], ["2×", 2]];
  const fields = MANUAL_FIELDS[activity ? "activity" : "food"];
  const numFor = (k) => { const v = en[k]; return v === undefined || v === null ? "" : (Math.round(v * 100) / 100); };
  const manualCells = fields.map(([k, label, u]) =>
    `<label class="mfield"><span>${label}${u ? ` <em>(${u})</em>` : ""}</span>` +
    `<input type="number" step="any" inputmode="decimal" data-mnum="${k}" value="${numFor(k)}"></label>`).join("");
  $("#editBody").innerHTML =
    `<div class="subline" style="text-align:left;margin:0 0 10px">Currently <b style="color:var(--ink)">${fmt(en.kcal)} ${unit}</b>${activity && en.duration_min ? " · " + Math.round(en.duration_min) + " min" : ""}</div>` +
    `<div class="menu-label" style="padding-left:0">Adjust the amount</div>` +
    `<div class="quickscale">${scales.map(([l, v]) => `<button data-scale="${v}">${l}</button>`).join("")}</div>` +
    `<div class="menu-label" style="padding-left:0">${activity ? "Or re-describe the workout" : "Or re-describe the meal"}</div>` +
    `<div class="editrow"><input id="editText" placeholder="${activity ? "e.g. a 5 mile run" : "e.g. half a cup of rice"}" value="${escapeHtml(en.description || "")}"></div>` +
    `<div class="sheet-actions"><button class="primary" id="editApply" style="flex:1">Re-estimate</button><button class="danger-btn" id="editDelete">Delete</button></div>` +
    (en.description && en.description !== "(photo)" && !(ME && ME.second_opinion_enabled === false) ? `<div class="row" style="margin-top:8px"><button class="link" id="editSecond">🔀 Get a second opinion</button></div><div id="secondPanel"></div>` : "") +
    `<div class="menu-label" style="padding-left:0;margin-top:14px">Or edit the details manually</div>` +
    `<label class="mfield"><span>Name</span><input id="mName" maxlength="2000" value="${escapeHtml(en.description || "")}" placeholder="${activity ? "e.g. Morning run" : "e.g. Chicken and rice"}"></label>` +
    `<label class="mfield"><span>Description <em>(optional)</em></span><input id="mNote" maxlength="2000" value="${escapeHtml(en.note || "")}" placeholder="Add a note…"></label>` +
    `<div class="manualgrid">${manualCells}</div>` +
    `<div class="sheet-actions"><button class="primary" id="mSave" style="flex:1">Save changes</button></div>`;
  $$("#editBody [data-scale]").forEach((b) => b.addEventListener("click", () => applyEdit({ scale: +b.dataset.scale })));
  $("#editApply").addEventListener("click", () => applyEdit({ re_estimate: true, text: $("#editText").value }));
  $("#editDelete").addEventListener("click", async () => { await deleteEntry(en.id); closeEdit(); });
  $("#mSave").addEventListener("click", saveManualEdit);
  const secondBtn = $("#editSecond");
  if (secondBtn) secondBtn.addEventListener("click", () => requestSecondOpinion(en, secondBtn));
  $("#editBg").hidden = false; $("#editSheet").hidden = false; $("#editSheet").scrollTop = 0; syncScrollLock();
}
// Apply the hand-typed name / note / numbers. Blank number fields are left unchanged;
// a typed value (including 0) overrides. Tags the entry source as user-provided.
function saveManualEdit() {
  const payload = { manual: true, description: $("#mName").value.trim(), note: $("#mNote").value.trim() };
  $$("#editBody [data-mnum]").forEach((inp) => {
    const raw = inp.value.trim();
    if (raw === "") return;
    const n = Number(raw);
    if (!isNaN(n)) payload[inp.dataset.mnum] = n;
  });
  applyEdit(payload);
}
function closeEdit() { $("#editBg").hidden = true; $("#editSheet").hidden = true; editEntry = null; syncScrollLock(); }
async function applyEdit(payload) {
  if (!editEntry) return;
  closeEdit();
  toast("Updating…");
  try {
    const r = await api("/entries/" + editEntry.id, { method: "PATCH", body: JSON.stringify(payload) });
    toast(`Updated to ${fmt(r.entry.kcal)} ${r.entry.kind === "activity" ? "cal" : "kcal"}.`);
    afterEntryChange();
  } catch (e) { toast(e.message); }
}

// Ask the second-opinion model to independently re-estimate this entry; show it alongside the
// current numbers with a one-tap "Use this" to adopt it.
async function requestSecondOpinion(en, btn) {
  const panel = $("#secondPanel");
  if (!panel) return;
  btn.disabled = true;
  panel.innerHTML = '<div class="second-card"><span class="muted">Getting a second opinion…</span></div>';
  try {
    const r = await api("/second-opinion", { method: "POST", body: JSON.stringify({ entry_id: en.id }) });
    const activity = en.kind === "activity";
    const t = r.total || {};
    const alt = activity ? Math.round(t.kcal_burned || 0) : Math.round(t.kcal || 0);
    const cur = Math.round(en.kcal || 0);
    const unit = activity ? "cal" : "kcal";
    const macros = activity ? "" :
      `<span class="second-macros">${Math.round(t.protein || 0)}P · ${Math.round(t.carbs || 0)}C · ${Math.round(t.fat || 0)}F</span>`;
    panel.innerHTML =
      `<div class="second-card">` +
      `<div class="second-tag">Second opinion${r.model ? " · " + escapeHtml(r.model) : ""}</div>` +
      `<div class="second-cmp"><b>${alt} ${unit}</b> ${macros} <span class="muted">(was ${cur} ${unit})</span></div>` +
      (r.note ? `<div class="second-note muted">${escapeHtml(r.note)}</div>` : "") +
      `<button class="primary small" id="secondUse">Use this estimate</button>` +
      `</div>`;
    $("#secondUse").addEventListener("click", () =>
      applyEdit({ set_total: r.total, set_items: r.items || [], set_provider: r.provider, set_model: r.model }));
  } catch (e) {
    panel.innerHTML = `<div class="second-card"><span class="muted">${escapeHtml((e && e.message) || "Second opinion unavailable")}</span></div>`;
    btn.disabled = false;
  }
}

// -------------------------------------------------------- barcode scanning
let scanner = null;
let scanBusy = false;

let SCAN_ONRESULT = null; // when set, a decoded barcode is handed to this callback instead of logged
async function openScanner(onResult) {
  SCAN_ONRESULT = typeof onResult === "function" ? onResult : null;
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
  SCAN_ONRESULT = null;
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
  if (gtin && SCAN_ONRESULT) {
    const cb = SCAN_ONRESULT; SCAN_ONRESULT = null;
    await closeScanner();
    cb(gtin);
    return;
  }
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
  const act = $("#goalActivity");
  if (act) {
    act.innerHTML = '<option value="">— set —</option>' + OB_ACT.map(([v, l]) => `<option value="${v}"${ME.activity_level === v ? " selected" : ""}>${l}</option>`).join("");
  }
  // Check-in preferences — hidden entirely when the admin has the feature off instance-wide.
  const ciSec = $("#checkinSection");
  if (ciSec) {
    ciSec.hidden = ME.checkins_enabled === false;
    const on = !!ME.checkin_enabled;
    $("#goalCheckin").checked = on;
    $("#goalCheckinFreq").value = ME.checkin_freq || "daily";
    $("#checkinFreqRow").hidden = !on;
    $("#goalCheckin").onchange = () => { $("#checkinFreqRow").hidden = !$("#goalCheckin").checked; };
  }
  loadGoalWeightGoals();
  goalModeHint();
  goalsDialog.showModal();
}

// The weight-goals editor inside the Goals dialog (up to 3), backed by /weight/goals.
async function loadGoalWeightGoals() {
  const wrap = $("#goalWeightGoals"); if (!wrap) return;
  let goals = [];
  try { goals = (await api("/weight/goals")).goals || []; } catch (_) {}
  wrap.innerHTML = goals.map((g) =>
    `<div class="wgrow"><span>${escapeHtml(g.target_lb)} lb by ${escapeHtml(g.target_date)}</span><button type="button" class="link danger" data-del="${g.id}">remove</button></div>`
  ).join("") || '<div class="dim" style="font-size:12px">No weight goals yet.</div>';
  wrap.querySelectorAll("[data-del]").forEach((b) => (b.onclick = async () => {
    try { await api("/weight/goals/" + b.dataset.del, { method: "DELETE" }); loadGoalWeightGoals(); } catch (e) { toast(e.message); }
  }));
  const add = $("#wgAdd"); if (add) add.onclick = addWeightGoalPrompt;
  const rc = $("#wgRecompute"); if (rc) rc.onclick = recomputeTargets;
}
async function addWeightGoalPrompt() {
  const lb = parseFloat(prompt("Target weight (lb)?", "") || "");
  if (!(lb > 0)) return;
  const date = (prompt("Target date (YYYY-MM-DD)?", todayISO()) || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { toast("Enter a date as YYYY-MM-DD"); return; }
  try { await api("/weight/goals", { method: "POST", body: JSON.stringify({ target_lb: lb, target_date: date }) }); loadGoalWeightGoals(); }
  catch (e) { toast(e.message); }
}
// Recompute calorie/macro targets from saved stats + goals and fill the goal fields.
async function recomputeTargets() {
  const act = $("#goalActivity");
  try {
    const r = await api("/plan/compute", { method: "POST", body: JSON.stringify({ method: $("#goalMode").value, activity: act ? act.value : undefined }) });
    const t = r.targets, f = $("#goalsForm");
    f.goal_kcal.value = t.kcal; f.goal_protein.value = t.protein; f.goal_carbs.value = t.carbs; f.goal_fat.value = t.fat; f.goal_sodium.value = t.sodium;
    toast(r.warnings && r.warnings.length ? r.warnings[0] : "Targets recomputed — Save to keep them");
  } catch (e) { toast(e.message); }
}
$("#goalsBtn").addEventListener("click", openGoals);
$("#menuGoals").addEventListener("click", () => { $("#userMenu").hidden = true; openGoals(); });
$("#menuCoach").addEventListener("click", () => { $("#userMenu").hidden = true; openCoach(); });
// Native-only: forget the saved instance host and return to the launcher to pick/enter a new one.
async function switchInstance() {
  $("#userMenu").hidden = true;
  try {
    const P = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Preferences;
    if (P) await P.remove({ key: "sate_host" });
  } catch (_) {}
  window.location.href = "capacitor://localhost/";
}
(function initSwitchInstance() {
  const btn = $("#menuSwitch");
  if (!btn) return;
  if (isNativeApp()) { btn.hidden = false; btn.addEventListener("click", switchInstance); }
})();
// Persistent coach entry point under the Home stats — visible on every scope (all/nutrition/activity/weight).
(function initChatline() {
  const cl = $("#chatline");
  if (!cl) return;
  cl.innerHTML = '<button class="link coachlink" id="coachOpen">💬 Ask your nutrition coach</button>';
  cl.querySelector("#coachOpen").addEventListener("click", openCoach);
})();
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
  if ($("#goalActivity") && $("#goalActivity").value) payload.activity_level = $("#goalActivity").value;
  if (ME.checkins_enabled !== false && $("#goalCheckin")) {
    payload.checkin_enabled = $("#goalCheckin").checked;
    payload.checkin_freq = $("#goalCheckinFreq").value;
  }
  const r = await api("/goals", { method: "PATCH", body: JSON.stringify(payload) });
  ME.goals = r.goals;
  if (r.track_mode) ME.track_mode = r.track_mode;
  if (typeof r.net_exercise === "boolean") ME.net_exercise = r.net_exercise;
  if (r.hr_estimate_method) ME.hr_estimate_method = r.hr_estimate_method;
  if (r.activity_level !== undefined) ME.activity_level = r.activity_level;
  if (typeof r.checkin_enabled === "boolean") ME.checkin_enabled = r.checkin_enabled;
  if (r.checkin_freq) ME.checkin_freq = r.checkin_freq;
  renderHome();
  toast("Goals saved");
});

// ----------------------------------------------------------------- history
async function loadHistory() {
  const d = $("#histDate");
  if (!d.value) d.value = todayISO();
  $("#summary").hidden = true;
  const ul = $("#histEntries");
  try {
    const data = await api("/entries?date=" + d.value);
    ul.innerHTML = "";
    if (!data.entries.length) ul.innerHTML = '<li class="hint">No entries for this day.</li>';
    data.entries.forEach((en) => ul.appendChild(entryLi(en)));
  } catch (e) {
    toast(e.message);
    ul.innerHTML = '<li class="hint">Couldn’t load this day — ' + escapeHtml(e.message) + "</li>";
  }
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

// Turn every "<h3 class='section'>" in the admin view into a collapsible header (collapsed by
// default) that wraps everything up to the next section. Runs once; wrapping moves the inner
// containers but keeps their ids, so the render functions still target them.
function initAdminCollapse() {
  const root = $("#view-admin");
  if (!root || root.dataset.collapsed) return;
  root.dataset.collapsed = "1";
  $$(".admin-sect").forEach((sect) => {
    const kids = Array.prototype.slice.call(sect.children);
    for (let i = 0; i < kids.length; i++) {
      const h = kids[i];
      if (!(h.tagName === "H3" && h.classList.contains("section"))) continue;
      const body = document.createElement("div");
      body.className = "sect-body"; body.hidden = true;
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
// Returns the body element (caller inserts it after head).
function collapsify(head, bodyNodes) {
  const body = document.createElement("div");
  body.className = "sect-body"; body.hidden = true;
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

async function loadAdmin() {
  initAdminCollapse();
  try {
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
    loadBackup();
  } catch (e) {
    toast("Couldn’t load admin: " + e.message);
  }
}

// ---- external backup / sync ----
function bkTypeToggle() {
  const t = $("#bkType").value;
  $("#bkPb").hidden = t !== "pocketbase";
  $("#bkFb").hidden = t !== "firebase";
}
async function loadBackup() {
  const card = $("#backupCard"); if (!card) return;
  let c;
  try { c = await api("/admin/backup"); } catch (e) { $("#bkStatus").textContent = e.message; return; }
  $("#bkType").value = c.type || "";
  $("#bkPbUrl").value = c.pb.url || ""; $("#bkPbEmail").value = c.pb.email || "";
  $("#bkPbPass").placeholder = c.pb.password_set ? "•••••• (saved)" : "password";
  $("#bkFbProject").value = c.fb.project || ""; $("#bkFbEmail").value = c.fb.email || "";
  $("#bkFbKey").placeholder = c.fb.api_key_set ? "•••••• (saved)" : "web API key";
  $("#bkFbPass").placeholder = c.fb.password_set ? "•••••• (saved)" : "password";
  $("#bkAuto").checked = !!c.auto;
  $("#bkLive").checked = !!c.sync_live;
  bkTypeToggle();
  const bits = [];
  if (c.last_at) bits.push(`<span class="badge">last backup ${escapeHtml(c.last_at.slice(0, 16).replace("T", " "))} — ${escapeHtml(c.last_status || "")}</span>`);
  if (c.sync_live) bits.push(`<span class="badge">live sync ${c.sync_queued ? "· " + c.sync_queued + " queued" : "· up to date"}${c.sync_last_at ? " · " + escapeHtml(c.sync_last_at.slice(11, 16)) : ""}</span>`);
  $("#bkStatus").innerHTML = bits.length ? bits.join(" ") : '<span class="muted">No backup yet.</span>';
  $("#bkMirror").hidden = !(c.type && c.sync_live);
  if (c.type) renderBackupList();
  else $("#bkList").innerHTML = "";
  // Local file backups
  const L = c.local || {};
  if ($("#lbEnabled")) {
    $("#lbEnabled").checked = !!L.enabled;
    $("#lbDir").value = L.dir || "";
    $("#lbKeep").value = L.keep || 14;
    $("#lbStatus").innerHTML = L.last_at
      ? `<span class="badge">last file backup ${escapeHtml(L.last_at.slice(0, 16).replace("T", " "))}</span>`
      : '<span class="muted">No file backup yet.</span>';
    const files = L.files || [];
    $("#lbList").innerHTML = files.length
      ? files.map((f) => `<div class="snaprow"><span class="snapmeta">${escapeHtml(f.name)} <span class="muted">${fmtBytes(f.size)}</span></span></div>`).join("")
      : '<p class="muted" style="margin:8px 0">No backup files in that directory.</p>';
  }
}
function fmtBytes(n) { n = +n || 0; return n < 1024 ? n + " B" : n < 1048576 ? (n / 1024).toFixed(0) + " KB" : (n / 1048576).toFixed(1) + " MB"; }
function backupPayload() {
  return {
    type: $("#bkType").value,
    auto: $("#bkAuto").checked,
    sync_live: $("#bkLive").checked,
    pb: { url: $("#bkPbUrl").value.trim(), email: $("#bkPbEmail").value.trim(), password: $("#bkPbPass").value },
    fb: { project: $("#bkFbProject").value.trim(), email: $("#bkFbEmail").value.trim(), api_key: $("#bkFbKey").value, password: $("#bkFbPass").value },
    local: { enabled: $("#lbEnabled").checked, dir: $("#lbDir").value.trim(), keep: +$("#lbKeep").value || 14 },
  };
}
async function renderBackupList() {
  const wrap = $("#bkList"); wrap.innerHTML = '<p class="muted" style="margin:8px 0">Loading snapshots…</p>';
  let snaps = [];
  try { snaps = (await api("/admin/backup/list")).snapshots || []; }
  catch (e) { wrap.innerHTML = `<p class="hint">${escapeHtml(e.message)}</p>`; return; }
  if (!snaps.length) { wrap.innerHTML = '<p class="muted" style="margin:8px 0">No snapshots on the destination yet.</p>'; return; }
  wrap.innerHTML = "";
  snaps.forEach((s) => {
    const row = document.createElement("div");
    row.className = "snaprow";
    row.innerHTML = `<span class="snapmeta"><b>${escapeHtml((s.created || "").slice(0, 16).replace("T", " "))}</b> <span class="muted">${escapeHtml(s.label || s.id)}</span></span>`;
    const btn = document.createElement("button");
    btn.className = "link danger"; btn.textContent = "Restore";
    btn.onclick = () => restoreSnapshot(s);
    row.appendChild(btn);
    wrap.appendChild(row);
  });
}
async function restoreSnapshot(s) {
  if (!confirm("Restore from " + (s.created || s.id) + "?\n\nThis REPLACES this instance's data (entries, profiles, foods, settings…) with the snapshot. It cannot be undone.")) return;
  toast("Restoring…");
  try {
    const r = await api("/admin/backup/restore", { method: "POST", body: JSON.stringify({ id: s.id }) });
    const total = Object.values(r.restored || {}).reduce((a, n) => a + n, 0);
    toast("Restored " + total + " records. Reloading…");
    setTimeout(() => location.reload(), 1200);
  } catch (e) { toast(e.message); }
}
(function wireBackup() {
  const t = $("#bkType"); if (!t) return;
  t.addEventListener("change", bkTypeToggle);
  $("#bkSave").onclick = async () => { try { await api("/admin/backup", { method: "PUT", body: JSON.stringify(backupPayload()) }); toast("Saved"); loadBackup(); } catch (e) { toast(e.message); } };
  $("#bkTest").onclick = async () => { toast("Testing…"); try { await api("/admin/backup", { method: "PUT", body: JSON.stringify(backupPayload()) }); await api("/admin/backup/test", { method: "POST" }); toast("Connection OK ✓"); } catch (e) { toast(e.message); } };
  $("#bkNow").onclick = async () => { toast("Backing up…"); try { const r = await api("/admin/backup/run", { method: "POST" }); toast("Backed up " + r.records + " records ✓"); loadBackup(); } catch (e) { toast(e.message); } };
  $("#bkRefresh").onclick = renderBackupList;
  if ($("#lbSave")) $("#lbSave").onclick = async () => { try { await api("/admin/backup", { method: "PUT", body: JSON.stringify(backupPayload()) }); toast("Saved"); loadBackup(); } catch (e) { toast(e.message); } };
  if ($("#lbNow")) $("#lbNow").onclick = async () => { toast("Writing backup file…"); try { const r = await api("/admin/backup/local-now", { method: "POST" }); toast("Wrote " + r.name); loadBackup(); } catch (e) { toast(e.message); } };
  $("#bkRestoreMirror").onclick = async () => {
    if (!confirm("Rebuild this instance's data from the live remote mirror?\n\nThis REPLACES local data with the remote's current state. It cannot be undone.")) return;
    toast("Restoring from mirror…");
    try {
      const r = await api("/admin/backup/restore-mirror", { method: "POST" });
      const total = Object.values(r.restored || {}).reduce((a, n) => a + n, 0);
      toast("Restored " + total + " records. Reloading…");
      setTimeout(() => location.reload(), 1200);
    } catch (e) { toast(e.message); }
  };
})();

// ---- Admin section tabs (AI / Instance / Users / Data) ----
function setAdminSect(group) {
  $$("#adminTabs button").forEach((b) => b.classList.toggle("on", b.dataset.group === group));
  $$(".admin-sect").forEach((s) => (s.hidden = s.dataset.group !== group));
}

// ---- AI limits (per-provider token / $ caps) ----
async function loadAiLimits() {
  const wrap = $("#aiLimits");
  if (!wrap) return;
  let limits = [];
  try { limits = (await api("/admin/limits")).limits || []; } catch (e) { wrap.innerHTML = `<p class="hint">${escapeHtml(e.message)}</p>`; return; }
  wrap.innerHTML = "";
  limits.forEach((l) => {
    const meta = PROVIDER_META[l.provider] || { label: l.provider };
    const el = document.createElement("div");
    el.className = "limitrow";
    el.innerHTML =
      `<div class="limithead">${escapeHtml(meta.label)}</div>` +
      `<div class="grid2">` +
      `<label class="field">Monthly token cap <input type="number" min="0" step="1000" data-k="monthly_tokens" value="${l.monthly_tokens || ""}" placeholder="unlimited" /></label>` +
      `<label class="field">Monthly budget (USD) <input type="number" min="0" step="0.5" data-k="usd_budget" value="${l.usd_budget || ""}" placeholder="unlimited" /></label>` +
      `</div>` +
      `<div class="row end"><button class="primary small" data-save>Save</button></div>`;
    el.querySelector("[data-save]").onclick = async () => {
      const payload = {
        provider: l.provider,
        monthly_tokens: +el.querySelector('[data-k="monthly_tokens"]').value || 0,
        usd_budget: +el.querySelector('[data-k="usd_budget"]').value || 0,
      };
      try { await api("/admin/limit", { method: "POST", body: JSON.stringify(payload) }); toast(l.provider + " limit saved"); loadAiUsage(); }
      catch (e) { toast(e.message); }
    };
    wrap.appendChild(el);
  });
}

// ---- AI usage (this month, per provider) ----
async function loadAiUsage() {
  const wrap = $("#aiUsage");
  if (!wrap) return;
  let rows = [];
  try { rows = (await api("/admin/usage")).providers || []; } catch (e) { wrap.innerHTML = `<p class="hint">${escapeHtml(e.message)}</p>`; return; }
  const fmt = (n) => (n || 0).toLocaleString();
  wrap.innerHTML = rows.map((r) => {
    const meta = PROVIDER_META[r.provider] || { label: r.provider };
    const capTok = r.limit.monthly_tokens || 0, capUsd = r.limit.usd_budget || 0;
    const tokPart = capTok ? `${fmt(r.tokens)} / ${fmt(capTok)} tok` : `${fmt(r.tokens)} tok`;
    const usdPart = capUsd ? `$${r.cost_usd.toFixed(2)} / $${capUsd.toFixed(2)}` : `$${r.cost_usd.toFixed(2)}`;
    const over = (capTok && r.tokens >= capTok) || (capUsd && r.cost_usd >= capUsd);
    return `<div class="usagerow${over ? " over" : ""}"><span class="up">${escapeHtml(meta.label)}</span>` +
      `<span class="um">${tokPart} · ${usdPart} · ${fmt(r.calls)} calls${over ? " · <b>over limit</b>" : ""}</span></div>`;
  }).join("") || '<p class="hint">No AI usage recorded yet this month.</p>';
}

// ---- AI model prices (USD per 1M tokens) ----
async function loadAiPrices() {
  const wrap = $("#aiPrices");
  if (!wrap) return;
  let prices = [];
  try { prices = (await api("/admin/prices")).prices || []; } catch (_) { prices = []; }
  prices.sort((a, b) => (a.provider + a.model < b.provider + b.model ? -1 : 1));
  wrap.innerHTML =
    `<div class="pricerow head"><span>Provider</span><span>Model</span><span>In $/1M</span><span>Out $/1M</span><span></span></div>` +
    prices.map((p, i) =>
      `<div class="pricerow" data-i="${i}"><span>${escapeHtml(p.provider)}</span><span class="pm">${escapeHtml(p.model)}</span>` +
      `<input type="number" step="0.01" min="0" data-k="in_usd" value="${p.in_usd}" />` +
      `<input type="number" step="0.01" min="0" data-k="out_usd" value="${p.out_usd}" />` +
      `<button class="link" data-save>Save</button></div>`
    ).join("") +
    `<div class="pricerow add"><input type="text" id="npProv" placeholder="provider" /><input type="text" id="npModel" placeholder="model id" />` +
    `<input type="number" step="0.01" id="npIn" placeholder="in" /><input type="number" step="0.01" id="npOut" placeholder="out" />` +
    `<button class="link" id="npAdd">Add</button></div>`;
  wrap.querySelectorAll(".pricerow[data-i] [data-save]").forEach((btn) => {
    btn.onclick = async () => {
      const row = btn.closest(".pricerow"); const p = prices[+row.dataset.i];
      try {
        await api("/admin/price", { method: "POST", body: JSON.stringify({
          provider: p.provider, model: p.model,
          in_usd: row.querySelector('[data-k="in_usd"]').value, out_usd: row.querySelector('[data-k="out_usd"]').value,
        }) });
        toast("price saved"); loadAiUsage();
      } catch (e) { toast(e.message); }
    };
  });
  const add = wrap.querySelector("#npAdd");
  if (add) add.onclick = async () => {
    const prov = $("#npProv").value.trim(), model = $("#npModel").value.trim();
    if (!prov || !model) { toast("provider and model required"); return; }
    try {
      await api("/admin/price", { method: "POST", body: JSON.stringify({ provider: prov, model: model, in_usd: $("#npIn").value, out_usd: $("#npOut").value }) });
      toast("price added"); loadAiPrices(); loadAiUsage();
    } catch (e) { toast(e.message); }
  };
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
  el.appendChild(head);
  el.appendChild(collapsify(head, [ta, actions])); // each prompt collapsed by default
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
    `<span class="badge">build ${APP_VERSION}</span> ` +
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

// Live model catalog per provider → a native <select> (replaces the old <datalist> inputs, which
// filtered options to the typed text and wouldn't let you browse/change). Always keeps the saved
// model as an option, and adds an "Other…" escape hatch for a model the live list doesn't include.
function modelSelectHTML(provider, selected, attrs) {
  const list = MODELS[provider] || [];
  const ids = list.map((m) => m.id);
  let opts = "";
  if (!ids.length) {
    opts += `<option value="${escapeHtml(selected || "")}">${selected ? escapeHtml(selected) : "— set this provider's API key to load models —"}</option>`;
  } else {
    if (selected && ids.indexOf(selected) === -1)
      opts += `<option value="${escapeHtml(selected)}" selected>${escapeHtml(selected)} (saved)</option>`;
    opts += list
      .map((m) => `<option value="${escapeHtml(m.id)}" ${m.id === selected ? "selected" : ""}>${m.vision ? "👁 " : ""}${escapeHtml(m.label || m.id)}</option>`)
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
    const v = (prompt("Enter a model id:", "") || "").trim();
    if (v) {
      let o = Array.prototype.find.call(sel.options, (x) => x.value === v);
      if (!o) { o = document.createElement("option"); o.value = v; o.textContent = v; sel.insertBefore(o, sel.options[sel.options.length - 1]); }
      sel.value = v;
    } else { sel.value = fallback || ""; }
  });
}

// Fetch a provider's live model list on demand (when a provider dropdown changes).
async function fetchModelsIfNeeded(prov) {
  if (MODELS[prov]) return;
  try { const r = await api("/admin/models?provider=" + prov); MODELS[prov] = r.models || []; }
  catch (_) { MODELS[prov] = []; }
}

function provOptions(selected, emptyLabel) {
  return `<option value="">${escapeHtml(emptyLabel || "(global default)")}</option>` +
    PROVIDERS.map((p) => `<option value="${p.name}" ${selected === p.name ? "selected" : ""}>${p.name}</option>`).join("");
}

// A linked provider+model picker rendered into `host`. Blank provider = defer (emptyLabel explains
// to what). Returns { get: () => ({provider, model}) }. Used by globals, function cards, user rows.
function buildModelPicker(host, provider, model, emptyLabel) {
  host.innerHTML =
    `<select class="mp-prov">${provOptions(provider, emptyLabel)}</select>` +
    `<span class="mp-model model-cell"></span>`;
  const sel = host.querySelector(".mp-prov");
  const cell = host.querySelector(".mp-model");
  const renderCell = async (cur) => {
    if (!sel.value) { cell.innerHTML = `<span class="muted">${escapeHtml(emptyLabel || "(global default)")}</span>`; return; }
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

// Global feature toggles (default ON unless explicitly "off").
function renderFeatures(settings) {
  const s = settings || {};
  const sec = $("#feat_second"), chk = $("#feat_checkins");
  if (sec) sec.checked = s.second_opinion_enabled !== "off";
  if (chk) chk.checked = s.checkins_enabled !== "off";
}
(function wireFeatures() {
  const btn = $("#saveFeatures");
  if (!btn) return;
  btn.onclick = async () => {
    const payload = {
      second_opinion_enabled: $("#feat_second").checked ? "on" : "off",
      checkins_enabled: $("#feat_checkins").checked ? "on" : "off",
    };
    try { await api("/admin/settings", { method: "PUT", body: JSON.stringify(payload) }); toast("Features saved"); }
    catch (e) { toast(e.message); }
  };
})();

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
    const row = document.createElement("div");
    row.className = "gdef-row";
    row.innerHTML = `<span class="gdef-label">${r.label}</span><span class="gdef-picker mp"></span>`;
    const p = buildModelPicker(row.querySelector(".gdef-picker"), s[r.pk] || "", s[r.mk] || "", "(none set)");
    pickers.push({ r, p });
    wrap.appendChild(row);
  });
  const save = document.createElement("button");
  save.className = "primary";
  save.style.marginTop = "8px";
  save.textContent = "Save global defaults";
  save.onclick = async () => {
    const payload = {};
    pickers.forEach(({ r, p }) => { const v = p.get(); payload[r.pk] = v.provider; payload[r.mk] = v.model; });
    try { await api("/admin/settings", { method: "PUT", body: JSON.stringify(payload) }); toast("Global defaults saved"); }
    catch (e) { toast(e.message); }
  };
  wrap.appendChild(save);
}

// A labeled provider+model picker line inside a user's override area. `key` is stashed on the
// element so saveUserModels can gather it. Returns { get } from buildModelPicker.
function userPickerRow(host, label, provider, model) {
  const row = document.createElement("div");
  row.className = "uov-line";
  row.innerHTML = `<label class="mp-lbl">${escapeHtml(label)}</label><span class="mp uov-picker"></span>`;
  host.appendChild(row);
  return buildModelPicker(row.querySelector(".uov-picker"), provider || "", model || "", "(global default)");
}

// The order functions appear in a user's per-function override tree.
const USER_FN_ORDER = ["text_parse", "vision_estimate", "web_lookup", "activity_estimate", "daily_summary", "nutritionist", "checkin"];

function renderUsers(users) {
  const ul = $("#users");
  ul.innerHTML = "";
  users.forEach((u) => {
    const li = document.createElement("li");
    li.className = "u";
    const badge = u.env_admin
      ? '<span class="badge lock">env-admin</span>'
      : `<span class="badge ${u.role === "admin" ? "adminb" : ""}">${u.role}</span>`;
    const fnOv = u.fn_overrides || {};
    const hasOv = u.ov_ai_provider || u.ov_vision_provider || u.ov_ai_second_provider ||
      u.ov_vision_second_provider || Object.keys(fnOv).length;
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
    // AI model overrides (collapsed by default). Collects pickers into a registry the save reads.
    const ov = document.createElement("div");
    ov.className = "uoverrides";
    ov.hidden = true;
    const reg = { globals: {}, fns: {}, original: fnOv };

    const gWrap = document.createElement("div");
    reg.globals.ai = userPickerRow(gWrap, "Normal · Primary", u.ov_ai_provider, u.ov_ai_model);
    reg.globals.ai_second = userPickerRow(gWrap, "Normal · Second opinion", u.ov_ai_second_provider, u.ov_ai_second_model);
    reg.globals.vision = userPickerRow(gWrap, "Image · Primary", u.ov_vision_provider, u.ov_vision_model);
    reg.globals.vision_second = userPickerRow(gWrap, "Image · Second opinion", u.ov_vision_second_provider, u.ov_vision_second_model);
    ov.appendChild(gWrap);

    // Nested, collapsed "AI Functions" tree — one collapsed row per function (primary + second).
    const fnsWrap = document.createElement("div");
    fnsWrap.className = "ufns";
    const fnsHead = document.createElement("button");
    fnsHead.type = "button";
    fnsHead.className = "ufns-head";
    fnsHead.innerHTML = `<span class="fnchevron">▸</span> AI Functions — per-function override`;
    const fnsBody = document.createElement("div");
    fnsBody.className = "ufns-body";
    fnsBody.hidden = true;
    fnsHead.onclick = () => {
      fnsBody.hidden = !fnsBody.hidden;
      fnsHead.querySelector(".fnchevron").textContent = fnsBody.hidden ? "▸" : "▾";
    };
    USER_FN_ORDER.forEach((fnKey) => {
      const cur = fnOv[fnKey] || {};
      const card = document.createElement("div");
      card.className = "ufn";
      const cHead = document.createElement("button");
      cHead.type = "button";
      cHead.className = "ufn-head";
      const set = cur.p || cur.sp;
      cHead.innerHTML = `<span class="fnchevron">▸</span> <span class="ufn-title">${escapeHtml(FN_LABELS[fnKey] || fnKey)}</span>${set ? ' <span class="badge">set</span>' : ""}`;
      const cBody = document.createElement("div");
      cBody.className = "ufn-body";
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

    const save = document.createElement("button");
    save.className = "primary small";
    save.style.marginTop = "10px";
    save.textContent = "Save overrides";
    save.onclick = () => saveUserModels(u.email, reg);
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
    const r = await api("/admin/foods/estimate", { method: "POST", body: JSON.stringify({ method: "photo", image: dataUrl }) });
    prefillFoodEditor(r.food, "Filled from photo — review & Save");
  } catch (e) { toast(e.message); }
}
// Admin quick-add: name → AI web-search lookup.
async function adminFoodWeb() {
  const name = ($("#fName").value || prompt("Food name to look up?", "") || "").trim();
  if (!name) return;
  $("#fName").value = name;
  toast("Searching the web…");
  try {
    const r = await api("/admin/foods/estimate", { method: "POST", body: JSON.stringify({ method: "web", text: name }) });
    prefillFoodEditor(r.food, "Filled from web search — review & Save");
  } catch (e) { toast(e.message); }
}
// Admin quick-add: scan/enter a barcode → product lookup.
function adminFoodBarcode() {
  const run = async (code) => {
    toast("Looking up " + code + "…");
    try {
      const r = await api("/admin/foods/barcode", { method: "POST", body: JSON.stringify({ barcode: code }) });
      prefillFoodEditor(r.food, "Found via " + (r.via || "lookup") + " — review & Save");
    } catch (e) { toast(e.message); }
  };
  if (isNativeApp() || (navigator.mediaDevices && navigator.mediaDevices.getUserMedia)) {
    openScanner(run);
  } else {
    const code = (prompt("Enter the barcode number:", "") || "").replace(/[^0-9]/g, "");
    if (code) run(code);
  }
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
$("#faPhoto").addEventListener("click", () => $("#faPhotoInput").click());
$("#faPhotoInput").addEventListener("change", (e) => { if (e.target.files[0]) adminFoodPhoto(e.target.files[0]); e.target.value = ""; });
$("#faWeb").addEventListener("click", adminFoodWeb);
$("#faBarcode").addEventListener("click", adminFoodBarcode);

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
    `<div class="fsub"><a href="${escapeHtml(safeUrl(s.url))}" target="_blank" rel="noopener">${escapeHtml(s.domain || s.url)}</a>` +
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

const PROVIDER_META = {
  anthropic: { label: "Anthropic (Claude)", hint: "console.anthropic.com" },
  openai: { label: "OpenAI", hint: "platform.openai.com/api-keys" },
  google: { label: "Google (Gemini)", hint: "aistudio.google.com/apikey" },
  openrouter: { label: "OpenRouter", hint: "openrouter.ai/keys — one key, 300+ models" },
};

function renderProviders(providers) {
  const wrap = $("#providers");
  wrap.innerHTML = "";
  providers.forEach((p) => {
    const meta = PROVIDER_META[p.name] || { label: p.name, hint: "" };
    const el = document.createElement("div");
    el.className = "prov";
    el.innerHTML =
      `<h4>${escapeHtml(meta.label)}${meta.hint ? ` <span class="prov-hint">${escapeHtml(meta.hint)}</span>` : ""}</h4>` +
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
    // Collapse each provider under its name (a "key set" badge stays visible in the header).
    const head = el.querySelector("h4");
    if (p.key_set) head.insertAdjacentHTML("beforeend", ' <span class="fbadge web">key set</span>');
    el.appendChild(collapsify(head, Array.prototype.slice.call(el.querySelectorAll(".grid"))));
    wrap.appendChild(el);
  });
}

const FN_LABELS = {
  vision_estimate: "Image interpretation — photo → nutrition",
  text_parse: "Normal AI — meal text → nutrition",
  daily_summary: "Normal AI — daily recap",
  web_lookup: "Normal AI — web-search lookup",
  activity_estimate: "Normal AI — activity → calories burned",
  nutritionist: "Normal AI — nutrition coach",
  checkin: "Normal AI — proactive check-ins",
};

function renderFunctions(functions, providers) {
  const wrap = $("#functions");
  wrap.innerHTML = "";
  functions.forEach((fn) => {
    const el = document.createElement("div");
    el.className = "fn fncard";
    const needsVision = fn.fn === "vision_estimate";
    // Header summary: how the primary currently resolves (its own model, or the global default).
    const summary = fn.provider ? `${fn.provider} · ${fn.model || "?"}` : "(global default)";
    el.innerHTML =
      `<button type="button" class="fnhead" data-toggle>` +
      `<span class="fnchevron">▸</span>` +
      `<span class="fntitle">${FN_LABELS[fn.fn] || fn.fn}${needsVision ? ' <span class="badge">👁</span>' : ""}</span>` +
      `<span class="fnsummary muted">${escapeHtml(summary)}</span>` +
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
      `</div>`;
    const body = el.querySelector(".fnbody");
    const head = el.querySelector("[data-toggle]");
    const chevron = el.querySelector(".fnchevron");
    let built = false;
    let primary, second;
    head.onclick = () => {
      body.hidden = !body.hidden;
      chevron.textContent = body.hidden ? "▸" : "▾";
      if (!body.hidden && !built) {
        built = true;
        primary = buildModelPicker(el.querySelector(".fn-primary"), fn.provider || "", fn.model || "", "(global default)");
        second = buildModelPicker(el.querySelector(".fn-second"), fn.second_provider || "", fn.second_model || "", "(global default)");
      }
    };
    el.querySelector("[data-save]").onclick = async () => {
      const p = primary ? primary.get() : { provider: fn.provider, model: fn.model };
      const s = second ? second.get() : { provider: fn.second_provider, model: fn.second_model };
      const payload = {
        fn: fn.fn,
        provider: p.provider, model: p.model,
        second_provider: s.provider, second_model: s.model,
        enabled: el.querySelector('[data-k="enabled"]').checked,
      };
      try { await api("/admin/functions", { method: "PUT", body: JSON.stringify(payload) }); toast((FN_LABELS[fn.fn] || fn.fn) + " saved"); loadAdmin(); }
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
  if (isNativeApp() && weightSyncDue()) weightSyncNow(true);
  loadPendingCheckin();
  if ((location.hash || "").replace("#", "") === "coach") showView("coach");
  // A fresh instance: the admin configures it first; user goal-onboarding waits until it's set up.
  if (!maybeAdminSetup()) maybeOnboard();
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
  const THRESHOLD = 70, MAX = 110, DAMP = 0.5, SIZE = 34, SETTLE = 56;
  const EASE = "transform .26s cubic-bezier(.2,.7,.3,1), opacity .2s ease";
  let startY = 0, active = false, pulling = false, busy = false;

  const ind = document.createElement("div");
  ind.className = "ptr";
  ind.innerHTML = '<div class="ptr-spin" aria-hidden="true"></div>';
  document.body.appendChild(ind);
  const main = document.querySelector("main");
  const header = document.querySelector(".topbar");
  const headerH = () => (header ? header.offsetHeight : 52);

  const atTop = () => (window.scrollY || document.documentElement.scrollTop || 0) <= 0;
  function blocked() {
    const home = document.getElementById("view-home");
    if (!home || home.hidden) return true;
    if (document.querySelector("dialog[open]")) return true;               // goals dialog
    for (const id of ["addSheet", "editSheet", "hrSheet", "onboard"]) {
      const el = document.getElementById(id);
      if (el && !el.hidden) return true;   // a sheet/overlay is open
    }
    if (HOME.scope === "weight") return true; // weight tab isn't day-refreshable
    return false;
  }
  // Pull the whole page (main) down by `d`; the spinner rides just above the content, tucked
  // behind the opaque sticky header at rest and revealed into the gap as the page slides down.
  function place(d, animate) {
    const t = animate ? EASE : "none";
    main.style.transition = t; ind.style.transition = t;
    main.style.transform = d ? "translateY(" + d + "px)" : "";
    ind.style.transform = "translateY(" + (headerH() - SIZE + d) + "px)";
    ind.style.opacity = String(Math.min(1, d / THRESHOLD));
    ind.classList.toggle("ready", d >= THRESHOLD);
  }
  function show(dist) { place(Math.min(dist, MAX), false); }
  function reset() { place(0, true); ind.classList.remove("ready", "spin"); }

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
    place(SETTLE, true);         // settle the page + spinner into the refreshing position
    ind.style.opacity = "1";
    try { await refreshHome(); } catch (_) {} finally { busy = false; reset(); }
  }, { passive: true });
})();

boot();
