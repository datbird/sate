// Sate v2 SPA — shared library. Every view imports from here. This module owns the pure helpers,
// the authenticated API client, the global toast/busy indicator, the bottom-sheet/dialog overlay
// helper, the shared UI components (feed rows, stat ring, charts), the shared APP state, the view
// registry + router, and the isNative() gate. It holds NO Firebase and NO view-specific logic, so
// it can be imported by app.js AND every view without a cycle.
//
// See views/home.js for a worked example of consuming this API, and the CONTRACT at the bottom of
// the foundation handoff for the exact signatures.

"use strict";

// ============================================================ DOM primitives
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

// el(tag, props?, ...children) — terse element builder.
//   props: { class, className, text, html, dataset:{k:v}, style:{k:v}, onClick, <attr>:val }
//   children: strings (text nodes) or Nodes; nested arrays are flattened; null/false/undefined skipped.
export function el(tag, props, ...children) {
  const node = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === "class" || k === "className") node.className = v;
      else if (k === "text") node.textContent = v;
      else if (k === "html") node.innerHTML = v;
      else if (k === "dataset") for (const [dk, dv] of Object.entries(v)) node.dataset[dk] = dv;
      else if (k === "style" && typeof v === "object") Object.assign(node.style, v);
      else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2).toLowerCase(), v);
      else node.setAttribute(k, v === true ? "" : String(v));
    }
  }
  appendKids(node, children);
  return node;
}
function appendKids(node, kids) {
  for (const c of kids) {
    if (c == null || c === false) continue;
    if (Array.isArray(c)) appendKids(node, c);
    else node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  }
}

// Parse a trusted HTML string into its first element (for SVG-heavy component markup). Callers must
// escape any user data with esc() before interpolating — htmlToEl does NOT sanitize.
export function htmlToEl(html) {
  const t = document.createElement("template");
  t.innerHTML = String(html).trim();
  return t.content.firstElementChild;
}

// HTML-escape (identical policy to v1 escapeHtml). Always run on user/AI text before interpolation.
export function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// Only http(s) URLs are safe in an href; everything else collapses to "#".
export function safeUrl(u) {
  const s = String(u || "").trim();
  return /^https?:\/\//i.test(s) ? s : "#";
}

// ============================================================ formatting / time
export const fmt = (n) => Math.round(Number(n) || 0).toLocaleString();
export const fmtSigned = (n) => (Number(n) > 0 ? "+" : "") + fmt(n);

// The user's LOCAL calendar date (days follow local time, not UTC — the "disappearing log" fix).
export function todayISO() {
  return new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}
export const tzOffset = () => new Date().getTimezoneOffset();

// Local YYYY-MM-DD for an ISO instant, and a friendly Today/Yesterday/weekday label.
export function localDayKey(iso) {
  return new Date(String(iso).replace(" ", "T")).toLocaleDateString("en-CA");
}
export function dayLabel(iso) {
  const d = new Date(String(iso).replace(" ", "T"));
  const key = d.toLocaleDateString("en-CA");
  const today = new Date().toLocaleDateString("en-CA");
  const y = new Date(); y.setDate(y.getDate() - 1);
  if (key === today) return "Today";
  if (key === y.toLocaleDateString("en-CA")) return "Yesterday";
  return d.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" });
}
export function timeOf(iso) {
  try {
    const d = new Date((iso || "").replace(" ", "T").replace(/Z?$/, "Z"));
    return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  } catch (_) { return ""; }
}

// ============================================================ native gate
// True only inside the Capacitor native shell. On web this is always false, so native-only bridges
// (HealthKit, LocalNotifications, barcode camera) must be gated behind it — the web build never
// touches them. Mirrors v1 isNativeApp().
export function isNative() {
  return !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
}

// ============================================================ API client
// The authenticated fetch wrapper. Every call:
//   • carries the Firebase ID token as `Authorization: Bearer <token>` (set by app.js via setToken),
//   • auto-appends the tz offset query (v2 handlers bucket by local day / stats windows),
//   • sends + parses JSON, throws Error(server message) on !res.ok,
//   • routes 401 → the unauthorized handler (app.js sends the user back to sign-in).
// `path` is the FULL path including /api (e.g. api("/api/feed?scope=all")). GET is the default;
// pass { method, body } for writes (stringify your own body, or pass `json` to have it stringified).
let _token = "";
let _onUnauthorized = () => {};
export function setToken(t) { _token = t || ""; }
export function getToken() { return _token; }
export function setUnauthorizedHandler(fn) { _onUnauthorized = fn || (() => {}); }

export async function api(path, opts = {}) {
  const o = { ...opts };
  o.headers = { "content-type": "application/json", ...(o.headers || {}) };
  if (_token) o.headers["Authorization"] = "Bearer " + _token;
  if (o.json !== undefined) { o.body = JSON.stringify(o.json); delete o.json; }
  const sep = path.indexOf("?") === -1 ? "?" : "&";
  const url = path + sep + "tz=" + tzOffset();
  netStart();
  try {
    const res = await fetch(url, o);
    let data = {};
    try { data = await res.json(); } catch (_) {}
    if (!res.ok) {
      if (res.status === 401) _onUnauthorized();
      throw new Error((data && data.error) || res.status + " error");
    }
    return data;
  } finally { netEnd(); }
}

// Unauthenticated JSON GET (for /config, /auth-config). No token, no tz.
export async function getJSON(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error(res.status + " error");
  return res.json();
}

// ============================================================ busy / toast
let NET = 0, netTimer = null, busyLabel = "Working…";
export function busy(label) {
  busyLabel = label || "Working…";
  const w = $("#working");
  if (w && !w.hidden) { const l = w.querySelector(".wlabel"); if (l) l.textContent = busyLabel; }
}
function netStart() {
  NET++;
  if (netTimer == null) netTimer = setTimeout(() => {
    const nb = $("#netbar"), w = $("#working");
    if (nb) nb.hidden = false;
    if (w) { const l = w.querySelector(".wlabel"); if (l) l.textContent = busyLabel; w.hidden = false; }
  }, 220);
}
function netEnd() {
  NET = Math.max(0, NET - 1);
  if (NET === 0) {
    if (netTimer != null) { clearTimeout(netTimer); netTimer = null; }
    const nb = $("#netbar"), w = $("#working");
    if (nb) nb.hidden = true;
    if (w) w.hidden = true;
    busyLabel = "Working…";
  }
}
export function toast(msg) {
  const t = $("#toast");
  if (!t) return;
  t.textContent = String(msg);
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (t.hidden = true), 2600);
}

// ============================================================ shared APP state
// Populated by app.js from GET /api/me after auth. Views READ this; they never write it directly —
// after a mutation that changes identity/goals/edition, call refreshMe() (app.js re-fetches /api/me).
// Shape mirrors the /api/me response (see api/profile.ts):
//   email, role, isAdmin, app_name, edition ("hosted"|"selfhost"|""),
//   entitlements:{ skus:string[], expiring:{sku:ISO} },
//   goals:{ kcal,protein,carbs,fat,sodium }, track_mode, net_exercise,
//   body_weight_kg, body_age, body_sex, height_cm, activity_level, weight_source,
//   health_sync, health_sync_interval, hr_estimate_method, onboarded,
//   checkin_enabled, checkin_time, checkin_freq, checkins_enabled, second_opinion_enabled,
//   today ("YYYY-MM-DD"), totals:{ kcal,protein,carbs,fat,fiber,sugar,sodium,sat_fat,count }
export const APP = {
  me: null,       // raw /api/me object, or null before load
  ready: false,
};
export function setMe(me) { APP.me = me; APP.ready = true; }
export const me = () => APP.me;
// Entitlement check against /api/me. "god" & "friends_and_family" are cross-app super-SKUs that
// unlock everything (kept in sync with the shared entitlements plane).
export function hasSku(sku) {
  const skus = (APP.me && APP.me.entitlements && APP.me.entitlements.skus) || [];
  return skus.includes(sku) || skus.includes("god") || skus.includes("friends_and_family");
}
// app.js registers its /api/me re-fetcher here so any view can request a state refresh.
let _refreshMe = async () => {};
export function setRefreshMe(fn) { _refreshMe = fn || (async () => {}); }
export const refreshMe = () => _refreshMe();

// ============================================================ view registry + router
// Each view module calls registerView(name, def) at import time. def:
//   { render(container?), open(args?), container? }
//   • Tab views (home/coach/history) set `container` (a selector) and `render`; showView() reveals
//     the container and calls render(containerEl). render may run on every show (views cache if heavy).
//   • Feature/overlay views (compose/editentry/foodsearch/goals/weight/onboarding/register/upgrade)
//     expose open(args) and build their own UI via sheet()/dialog(); they have no container and are
//     NOT in the nav. Invoke them with view('compose').open({...}) — see openView() for a safe call.
const VIEWS = new Map();
const _rendered = new Set();
export function registerView(name, def) { VIEWS.set(name, def || {}); }
export function view(name) { return VIEWS.get(name) || null; }

// Safe cross-view invocation: openView('compose', {scope}) calls view('compose').open(args) if it
// exists, else toasts a friendly stub notice. Home uses this for "+ add" and row edit so the app is
// fully wired even before the overlay agents ship their modules.
export function openView(name, args) {
  const v = VIEWS.get(name);
  if (v && typeof v.open === "function") return v.open(args);
  toast(name + " — coming soon");
  return undefined;
}

const _viewListeners = [];
export function onViewChange(fn) { _viewListeners.push(fn); }

// The router. Header tabs + bottom tab bar share the [data-view] contract, so one showView drives
// both. Only tab views (those with a `container`) participate; overlays are opened directly.
export function showView(name) {
  const v = VIEWS.get(name);
  const containerSel = (v && v.container) || ("#view-" + name);
  $$(".view").forEach((sec) => (sec.hidden = sec.id !== containerSel.replace(/^#/, "")));
  $$("[data-view]").forEach((b) => {
    const on = b.dataset.view === name;
    b.classList.toggle("active", on);
    b.classList.toggle("on", on);
  });
  if (v && typeof v.render === "function") {
    _rendered.add(name);
    try { v.render($(containerSel)); } catch (e) { console.error("[showView]", name, e); }
  }
  window.scrollTo(0, 0);
  _viewListeners.forEach((fn) => { try { fn(name); } catch (_) {} });
}
export const isRendered = (name) => _rendered.has(name);

// ============================================================ overlay: bottom sheet / dialog
// sheet(opts) mounts a keyboard-aware bottom sheet into #overlay and returns a controller.
//   opts: { title?, className?, body?, onClose?, dismissable=true }
//     title      — optional <h3> header
//     className  — extra class on the .sheet (e.g. "addsheet", "fssheet")
//     body       — Node | string(html) | (bodyEl)=>void builder; populates the scrollable body
//     onClose    — called after the sheet is removed
//     dismissable— background click / ✕ / Esc close it (default true)
//   controller: { root, body, close(), setBody(node|html|fn) }
// Scroll-lock + the --kb / --sheet-max keyboard-lift vars are managed globally (see the
// visualViewport wiring below), so multiple/stacked sheets all stay above the on-screen keyboard.
export function sheet(opts = {}) {
  const host = $("#overlay") || document.body;
  const bg = el("div", { class: "sheet-bg" });
  const root = el("div", { class: "sheet" + (opts.className ? " " + opts.className : "") });
  root.appendChild(el("div", { class: "grab" }));
  if (opts.dismissable !== false) {
    root.appendChild(el("button", { class: "sheet-x", type: "button", "aria-label": "Close", onClick: () => ctrl.close() }, "✕"));
  }
  if (opts.title) root.appendChild(el("h3", { text: opts.title }));
  const bodyEl = el("div", { class: "sheet-body" });
  root.appendChild(bodyEl);

  const ctrl = {
    root, body: bodyEl,
    setBody(content) { setContent(bodyEl, content); return ctrl; },
    close() {
      if (ctrl._closed) return;
      ctrl._closed = true;
      bg.remove(); root.remove();
      document.removeEventListener("keydown", onKey);
      syncScrollLock();
      if (typeof opts.onClose === "function") opts.onClose();
    },
  };
  function onKey(e) { if (e.key === "Escape" && opts.dismissable !== false) ctrl.close(); }
  if (opts.dismissable !== false) bg.addEventListener("click", () => ctrl.close());
  document.addEventListener("keydown", onKey);

  host.appendChild(bg);
  host.appendChild(root);
  if (opts.body !== undefined) ctrl.setBody(opts.body);
  syncScrollLock();
  return ctrl;
}

// dialog(opts) — a centered modal built on the same host (for confirms / short forms).
//   opts: { title?, body?, actions?:[{label, class?, value?, onClick?}], onClose? }
// Returns { root, body, close() }. If no actions are given, a single "Close" is added.
export function dialog(opts = {}) {
  const host = $("#overlay") || document.body;
  const bg = el("div", { class: "sheet-bg" });
  const root = el("div", { class: "modal-card" });
  if (opts.title) root.appendChild(el("h3", { text: opts.title }));
  const bodyEl = el("div", { class: "modal-body" });
  root.appendChild(bodyEl);
  if (opts.body !== undefined) setContent(bodyEl, opts.body);
  const actions = el("div", { class: "row end" });
  (opts.actions || [{ label: "Close", value: "close" }]).forEach((a) => {
    actions.appendChild(el("button", {
      class: a.class || "link", type: "button",
      onClick: () => { if (a.onClick) a.onClick(); if (a.value !== false) ctrl.close(); },
    }, a.label));
  });
  root.appendChild(actions);
  const ctrl = {
    root, body: bodyEl,
    close() { if (ctrl._closed) return; ctrl._closed = true; bg.remove(); root.remove(); document.removeEventListener("keydown", onKey); syncScrollLock(); if (opts.onClose) opts.onClose(); },
  };
  function onKey(e) { if (e.key === "Escape") ctrl.close(); }
  bg.addEventListener("click", () => ctrl.close());
  document.addEventListener("keydown", onKey);
  host.appendChild(bg); host.appendChild(root);
  syncScrollLock();
  return ctrl;
}

// Promise-based confirm on top of dialog(). Resolves true (confirm) / false (cancel).
export function confirmDialog(message, { title = "", confirmLabel = "OK", cancelLabel = "Cancel", danger = false } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const d = dialog({
      title, body: el("p", { class: "hint", style: { margin: "2px 0 4px" }, text: message }),
      actions: [
        { label: cancelLabel, class: "link", onClick: () => { done = true; resolve(false); } },
        { label: confirmLabel, class: danger ? "primary danger" : "primary", onClick: () => { done = true; resolve(true); } },
      ],
      onClose: () => { if (!done) resolve(false); },
    });
    void d;
  });
}

function setContent(host, content) {
  host.innerHTML = "";
  if (content == null) return;
  if (typeof content === "function") content(host);
  else if (typeof content === "string") host.innerHTML = content;
  else host.appendChild(content);
}

// Background scroll-lock + keyboard-lift, shared by every sheet/dialog. Any open overlay pins the
// body (defeats iOS scrolling a focused field — and the fixed sheet — off-screen).
let _lockedScrollY = 0;
export function syncScrollLock() {
  const open = !!document.querySelector("#overlay .sheet, #overlay .modal-card");
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
(function keyboardAwareSheets() {
  const vv = window.visualViewport;
  if (!vv) return;
  let raf = 0;
  const apply = () => {
    raf = 0;
    const kb = Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop));
    document.documentElement.style.setProperty("--kb", kb + "px");
    document.documentElement.style.setProperty("--sheet-max", Math.max(220, Math.round(vv.height - 12)) + "px");
  };
  const schedule = () => { if (!raf) raf = requestAnimationFrame(apply); };
  vv.addEventListener("resize", schedule);
  vv.addEventListener("scroll", schedule);
  apply();
})();

// ============================================================ tracking modes (mode-aware ring)
// Per-metric display metadata + the tracking modes. Shared so every view's ring/stat reads the same
// primary metric + secondary stats for the user's mode. Ported verbatim from v1.
export const METRIC = {
  kcal:     { label: "kcal",      u: "",   goalKey: "kcal",   get: (t) => t.kcal || 0 },
  protein:  { label: "protein",   u: "g",  goalKey: "protein", get: (t) => t.protein || 0 },
  carbs:    { label: "carbs",     u: "g",  goalKey: "carbs",  get: (t) => t.carbs || 0 },
  fat:      { label: "fat",       u: "g",  goalKey: "fat",    get: (t) => t.fat || 0 },
  fiber:    { label: "fiber",     u: "g",  goalKey: null,     get: (t) => t.fiber || 0 },
  sugar:    { label: "sugar",     u: "g",  goalKey: null,     get: (t) => t.sugar || 0 },
  sodium:   { label: "sodium",    u: "mg", goalKey: "sodium", get: (t) => t.sodium || 0 },
  sat_fat:  { label: "sat fat",   u: "g",  goalKey: null,     get: (t) => t.sat_fat || 0 },
  netcarbs: { label: "net carbs", u: "g",  goalKey: "carbs",  get: (t) => Math.max(0, (t.carbs || 0) - (t.fiber || 0)) },
};
export const MODES = {
  calories: { label: "Calories",        primary: "kcal",     stats: ["protein", "carbs", "fat"] },
  carb:     { label: "Carb-focused",    primary: "netcarbs", stats: ["kcal", "protein", "fiber"] },
  protein:  { label: "High-protein",    primary: "protein",  stats: ["kcal", "carbs", "fat"] },
  fat:      { label: "Low-fat",         primary: "fat",      stats: ["kcal", "carbs", "protein"] },
  balanced: { label: "Balanced macros", primary: "kcal",     stats: ["protein", "carbs", "fat"] },
  heart:    { label: "Heart-healthy",   primary: "sodium",   stats: ["sat_fat", "fiber", "kcal"] },
};
export function modeOf(m = APP.me) { return MODES[(m && m.track_mode)] || MODES.calories; }
export const RC = { nutrition: "var(--brand)", activity: "var(--activity)" };

// The two type icons (identical to the compose tabs + feed rows).
const TICON = {
  n: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3v7a2 2 0 0 0 4 0V3"/><path d="M10 12v9"/><ellipse cx="16" cy="6.4" rx="2.2" ry="3.4"/><path d="M16 9.8V21"/></svg>',
  a: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="13" cy="4" r="1"/><path d="M4 17l5 1 .75-1.5"/><path d="M15 21v-4l-4-3 1-6"/><path d="M7 12V9l5-1 3 3 3 1"/></svg>',
};
const HEART = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 21s-7.5-4.9-10-9.3C.6 8.9 1.7 5.5 4.8 4.8 7 4.3 8.9 5.6 12 8.5c3.1-2.9 5-4.2 7.2-3.7 3.1.7 4.2 4.1 2.8 6.9C19.5 16.1 12 21 12 21z"/></svg>';
const ICON_EDIT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>';
const ICON_TRASH = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M6 6l1 14h10l1-14"/></svg>';

// ============================================================ shared component: feed row
// feedRow(entry, handlers) → HTMLElement (a `.entry` row). Used by Home's feed AND History. The row
// shows the type icon, title, a "time · items/source · note" subline, kcal (activity shows −burn),
// a Health badge for Apple-Health imports, and edit/delete affordances.
//   handlers: { onEdit(entry), onDelete(entry), onClick(entry) }
//   Defaults: clicking the row (or Edit) → onEdit; Delete confirms then → onDelete.
export function feedRow(en, handlers = {}) {
  const activity = en.kind === "activity";
  const items = (en.items || []).map((i) => i && i.name).filter(Boolean).join(", ");
  const title = en.description || items || (activity ? "Activity" : "Entry");
  const sub = activity
    ? [timeOf(en.logged_at), en.duration_min ? Math.round(en.duration_min) + " min" : "", en.intensity, en.note].filter(Boolean).join(" · ")
    : [timeOf(en.logged_at), items || en.source, en.note].filter(Boolean).join(" · ");
  const kcalHtml = activity
    ? `<span class="ekcal out">−${fmt(en.kcal)}<small> cal</small></span>`
    : `<span class="ekcal">${fmt(en.kcal)}<small> kcal</small></span>`;
  const badge = en.source === "health" ? `<span class="health" title="From Apple Health">${HEART}Health</span>` : "";

  const li = el("div", { class: "entry", html:
    `<span class="ticon ${activity ? "a" : "n"}">${activity ? TICON.a : TICON.n}</span>` +
    `<span class="etext"><span class="t">${esc(title)}${badge}</span><span class="s">${esc(sub)}</span></span>` +
    kcalHtml +
    `<span class="eactions">` +
    `<button class="eact" type="button" data-edit title="Edit" aria-label="Edit">${ICON_EDIT}</button>` +
    `<button class="eact del" type="button" data-del title="Delete" aria-label="Delete">${ICON_TRASH}</button>` +
    `</span>`,
  });
  const edit = () => (handlers.onEdit ? handlers.onEdit(en) : openView("editentry", en));
  li.querySelector("[data-edit]").addEventListener("click", (ev) => { ev.stopPropagation(); edit(); });
  li.querySelector("[data-del]").addEventListener("click", async (ev) => {
    ev.stopPropagation();
    const okDel = await confirmDialog(`Delete this ${activity ? "activity" : "food"} entry?`, { confirmLabel: "Delete", danger: true });
    if (!okDel) return;
    if (handlers.onDelete) handlers.onDelete(en);
  });
  li.addEventListener("click", () => (handlers.onClick ? handlers.onClick(en) : edit()));
  return li;
}

// A "Today"/"Yesterday"/date divider row for day-grouped feeds.
export function dayDivider(iso) {
  return el("div", { class: "day-divider", html: `<span>${esc(dayLabel(iso))}</span>` });
}

// ============================================================ shared component: stat ring
// statRing(totals, goals, opts) → HTMLElement. Renders the mode-aware progress ring + secondary
// macro stats (reuses MODES/METRIC). opts:
//   { mode?  — a MODES entry (defaults to modeOf(APP.me)),
//     days=1 — scales per-day goals to the window (a week's sum vs a week's goal),
//     netBurn=0 — exercise kcal added to the budget (only applied when the ring tracks kcal),
//     rc — ring color (defaults RC.nutrition) }
export function statRing(totals, goals = {}, opts = {}) {
  const mode = opts.mode || modeOf();
  const days = opts.days || 1;
  const netBurn = mode.primary === "kcal" ? (opts.netBurn || 0) : 0;
  const rc = opts.rc || RC.nutrition;
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
  return htmlToEl(
    `<div class="ring-card"><div class="ring" style="--pct:${pct.toFixed(1)};--rc:${rc}">` +
    `<div class="ring-inner"><strong>${fmt(val)}</strong><small>${esc(sub)}</small></div></div>` +
    `<div class="macros">${macros}</div></div>`,
  );
}

// A bare ring (single number + caption + percent), for activity/weight cards that aren't macro-based.
export function ringEl(value, caption, pct, rc = RC.nutrition, extraHtml = "") {
  return htmlToEl(
    `<div class="ring-card"><div class="ring" style="--pct:${Number(pct) || 0};--rc:${rc}">` +
    `<div class="ring-inner"><strong>${fmt(value)}</strong><small>${esc(caption)}</small></div></div>` +
    (extraHtml || "") + `</div>`,
  );
}

// ============================================================ shared component: charts
// lineChart(points, goal, accent) → HTMLElement (an SVG trend area). sparkBars(points) → bar strip.
export function lineChart(pts, goal, accent = RC.nutrition) {
  const w = 360, h = 150, n = pts.length;
  if (n < 2) return el("div", { class: "subline", text: "Not enough data yet for a trend — keep logging." });
  const max = Math.max(goal || 0, Math.max.apply(null, pts)) * 1.1 || 1;
  const step = w / (n - 1);
  const xy = pts.map((v, i) => [i * step, h - (v / max) * h]);
  const d = xy.map((p, i) => (i ? "L" : "M") + p[0].toFixed(1) + " " + p[1].toFixed(1)).join(" ");
  const area = d + ` L${w} ${h} L0 ${h} Z`;
  const gy = goal ? (h - (goal / max) * h).toFixed(1) : -1;
  const end = xy[xy.length - 1];
  return htmlToEl(
    `<div class="chart"><svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">` +
    `<defs><linearGradient id="lg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${accent}" stop-opacity=".28"/><stop offset="1" stop-color="${accent}" stop-opacity="0"/></linearGradient></defs>` +
    (goal ? `<line x1="0" y1="${gy}" x2="${w}" y2="${gy}" stroke="var(--muted)" stroke-width="1" stroke-dasharray="4 4" opacity=".5"/>` : "") +
    `<path d="${area}" fill="url(#lg)"/><path d="${d}" fill="none" stroke="${accent}" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>` +
    `<circle cx="${end[0].toFixed(1)}" cy="${end[1].toFixed(1)}" r="4.5" fill="${accent}" stroke="var(--card)" stroke-width="2.5"/></svg></div>`,
  );
}
export function sparkBars(pts) {
  const max = Math.max.apply(null, pts) || 1;
  return htmlToEl(`<div class="spark">` + pts.map((v, i) =>
    `<i class="${i === pts.length - 1 ? "today" : ""}" style="height:${((v / max) * 100).toFixed(0)}%"></i>`).join("") + `</div>`);
}
