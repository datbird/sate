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
// The trial/paid expiry the plane reports for the hosted SKU, or null when the grant is permanent.
export function hostedExpiry(m = me()) {
  const exp = m && m.entitlements && m.entitlements.expiring;
  return (exp && exp.sate_hosted) || null;
}
// Permanent (non-trial) access — the god / friends-and-family super-SKUs, or a real non-expiring
// paid hosted grant. These users are entitled forever, so they must NEVER be shown a trial offer, a
// trial countdown, a "trial ended — AI paused" nag, or an upgrade prompt.
//
// Registration provisions a 30-day sate_hosted trial for anyone who picks the hosted edition, which
// includes god/f&f holders — so any check that keys off the sate_hosted *expiry* alone misfires for
// them. Gate FEATURES on hasSku() (already god/f&f-aware); gate anything trial- or money-shaped on
// this. Lives here rather than in a view so register.js and upgrade.js share one definition.
export function permanentAccess(m = me()) {
  const skus = (m && m.entitlements && m.entitlements.skus) || [];
  if (skus.includes("god") || skus.includes("friends_and_family")) return true;
  return skus.includes("sate_hosted") && !hostedExpiry(m); // paid hosted with no expiry
}
// Short noun for how permanent access was granted — for menus/badges. null when not permanent.
export function accessLabel(m = me()) {
  const skus = (m && m.entitlements && m.entitlements.skus) || [];
  if (skus.includes("god")) return "Full access";
  if (skus.includes("friends_and_family")) return "Friends & Family";
  return permanentAccess(m) ? "Active plan" : null;
}
// One-sentence acknowledgement of permanent access, as trusted HTML (the only markup is our own
// <b>). null when access is not permanent. Suppressing the trial nag is not enough on its own —
// someone on Friends & Family should be TOLD that is what they have, rather than just silently
// never being asked for money.
export function accessNote(m = me()) {
  const skus = (m && m.entitlements && m.entitlements.skus) || [];
  if (skus.includes("friends_and_family")) {
    return "You’re on <b>Friends &amp; Family</b> — everything’s unlocked, permanently. No trial, no card, nothing to renew. Enjoy!";
  }
  if (skus.includes("god")) return "You have <b>full access</b> — everything’s unlocked, permanently.";
  return permanentAccess(m) ? "You’re on an <b>active plan</b> — everything’s unlocked." : null;
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

// The active tab view — tracked so pull-to-refresh can re-render whatever's on screen.
let _currentView = "home";
export function currentView() { return _currentView; }
// Re-run the active tab view's render (re-fetches its data). Used by pull-to-refresh.
export async function refreshCurrentView() {
  const v = VIEWS.get(_currentView);
  const containerSel = (v && v.container) || ("#view-" + _currentView);
  if (v && typeof v.render === "function") {
    try { await v.render($(containerSel)); } catch (e) { console.error("[refresh]", _currentView, e); }
  }
}

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
    _currentView = name;
    try { v.render($(containerSel)); } catch (e) { console.error("[showView]", name, e); }
  }
  window.scrollTo(0, 0);
  _viewListeners.forEach((fn) => { try { fn(name); } catch (_) {} });
}
export const isRendered = (name) => _rendered.has(name);

// Pull-to-refresh: at the top of the page, a downward drag past the threshold re-renders the active
// view. Touch-only (harmless on desktop); skipped while a sheet/overlay is open or the app is hidden.
export function initPullToRefresh(onRefresh) {
  if (document.getElementById("ptrInd")) return; // once
  const ind = document.createElement("div");
  ind.id = "ptrInd";
  ind.className = "ptr-ind";
  ind.innerHTML = '<div class="ptr-spin"></div>';
  document.body.appendChild(ind);

  let startY = 0, pulling = false, dist = 0, busy = false;
  const THRESH = 68;
  const blocked = () => busy || $("#app")?.hidden || document.body.classList.contains("sheet-open");
  const reset = () => { ind.style.transform = ""; ind.classList.remove("on", "ready", "spin"); dist = 0; };

  window.addEventListener("touchstart", (e) => {
    if (blocked() || window.scrollY > 0) { pulling = false; return; }
    startY = e.touches[0].clientY; pulling = true; dist = 0;
  }, { passive: true });

  window.addEventListener("touchmove", (e) => {
    if (!pulling) return;
    if (window.scrollY > 0 || blocked()) { pulling = false; reset(); return; }
    dist = e.touches[0].clientY - startY;
    if (dist <= 0) { reset(); return; }
    ind.classList.add("on");
    ind.style.transform = `translateX(-50%) translateY(${Math.min(dist * 0.5, 84)}px)`;
    ind.classList.toggle("ready", dist > THRESH);
  }, { passive: true });

  window.addEventListener("touchend", async () => {
    if (!pulling) return;
    pulling = false;
    if (dist > THRESH && !blocked()) {
      busy = true;
      ind.classList.add("spin");
      ind.style.transform = "translateX(-50%) translateY(56px)";
      try { await onRefresh(); } catch (_) {}
      busy = false;
    }
    reset();
  }, { passive: true });
}

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
  // Optional pinned footer: the body scrolls, this bar (e.g. a Save button) stays put at the bottom.
  let footEl = null;
  if (opts.footer !== undefined) {
    root.classList.add("sheet-hasfoot");
    footEl = el("div", { class: "sheet-foot" });
    root.appendChild(footEl);
  }

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
  if (footEl) setContent(footEl, opts.footer);
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
  // Weight: a bathroom-scale glyph (rounded platform + dial/needle) — the third log type's icon.
  w: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="3"/><path d="M12 7.5l2.2 3.2"/><path d="M8 13a4 4 0 0 1 8 0"/></svg>',
};
// Weight log-type icon, exported for the Weight view (history rows + header) so it matches the feed.
export const WEIGHT_ICON = TICON.w;

// The All-scope stat subline with small inline icons (nutrition intake vs activity burn), mirroring
// the Hosted app's "🍴 in X kcal · 🏃 out Y cal · net Z" line. When the user opts weight into the All
// view, current weight is folded in with its icon so the combined stats read as one line.
export function inOutSub(inKcal, outKcal, opts = {}) {
  const w = opts.weightLb
    ? ` · <span class="iico" style="color:var(--weight)">${TICON.w}</span> ${fmt(opts.weightLb)} lb`
    : "";
  const outStr = opts.burnGoal ? `${fmt(outKcal)} / ${fmt(opts.burnGoal)}` : fmt(outKcal);
  return el("div", { class: "subline", html:
    `<span class="iico" style="color:var(--brand)">${TICON.n}</span> in ${fmt(inKcal)} kcal · ` +
    `<span class="iico" style="color:var(--activity)">${TICON.a}</span> out ${outStr} cal · ` +
    `net ${fmt(Math.round(inKcal - outKcal))}${w}` });
}

// A single weight-goal line for the Weight tab — matches the other tabs' subline style (one clean
// goal, not a stacked list). g = { target_lb, target_date, to_go_lb, pace:{on_track,behind_lb} }.
export function weightGoalSub(g) {
  if (!g) return null;
  const verb = g.to_go_lb >= 0 ? "to lose" : "to gain";
  const pace = g.pace ? (g.pace.on_track ? "on track" : `${fmt(Math.abs(g.pace.behind_lb))} lb behind`) : "";
  let dt = String(g.target_date || "");
  try { dt = new Date(dt.replace(" ", "T")).toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" }); } catch { /* keep raw */ }
  return el("div", { class: "subline", html:
    `<span class="iico" style="color:var(--weight)">${TICON.w}</span> Goal <b>${fmt(g.target_lb)} lb</b> by ${dt} · ${fmt(Math.abs(g.to_go_lb))} lb ${verb}${pace ? " · " + pace : ""}` });
}
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
  let mainHtml, actions = [], onTap = null;
  if (en.kind === "weight") {
    mainHtml =
      `<span class="ticon w">${TICON.w}</span>` +
      `<span class="etext"><span class="t">Weigh-in</span>` +
      `<span class="s">${esc(en.when || timeOf(en.logged_at))}${en.source === "health" ? " · Apple Health" : ""}</span></span>` +
      `<span class="ekcal wgt">${esc(en.weight_lb)}<small> lb</small></span>`;
    if (handlers.onWeightEdit) { actions.push({ cls: "swact-edit", icon: ICON_EDIT, label: "Edit", tap: () => handlers.onWeightEdit(en) }); onTap = () => handlers.onWeightEdit(en); }
    if (handlers.onWeightDelete) actions.push({ cls: "swact-del", icon: ICON_TRASH, label: "Delete", tap: () => _confirmDelete(`Delete this weigh-in?`, () => handlers.onWeightDelete(en)) });
  } else {
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
    mainHtml =
      `<span class="ticon ${activity ? "a" : "n"}">${activity ? TICON.a : TICON.n}</span>` +
      `<span class="etext"><span class="t">${esc(title)}${badge}</span><span class="s">${esc(sub)}</span></span>` +
      kcalHtml;
    const edit = () => (handlers.onEdit ? handlers.onEdit(en) : openView("editentry", en));
    actions.push({ cls: "swact-edit", icon: ICON_EDIT, label: "Edit", tap: edit });
    actions.push({ cls: "swact-del", icon: ICON_TRASH, label: "Delete", tap: () => _confirmDelete(`Delete this ${activity ? "activity" : "food"} entry?`, () => handlers.onDelete && handlers.onDelete(en)) });
    onTap = handlers.onClick ? () => handlers.onClick(en) : edit;
  }
  return _swipeEntry(mainHtml, actions, onTap);
}

async function _confirmDelete(msg, fn) {
  if (await confirmDialog(msg, { confirmLabel: "Delete", danger: true })) fn();
}

// One-at-a-time swipe state: only the currently-open row is tracked (no leak on an infinite feed).
let _openSwipeRow = null, _swipeScrollWired = false;

// Build a feed row whose `.entry-main` slides left to reveal an `.entry-actions` strip (edit/delete).
// `actions` = [{ cls, icon, label, tap }]. A plain tap (no drag) fires `onTap`; a tap on an open row
// closes it. With no actions the row is read-only.
function _swipeEntry(mainHtml, actions, onTap) {
  const actionsEl = el("div", { class: "entry-actions" });
  actions.forEach((a) => {
    const btn = el("button", { class: "swact " + a.cls, type: "button", html: a.icon });
    btn.setAttribute("aria-label", a.label);
    btn.addEventListener("click", (ev) => { ev.stopPropagation(); collapse(); a.tap(); });
    actionsEl.appendChild(btn);
  });
  const main = el("div", { class: "entry-main", html: mainHtml });
  const row = el("div", { class: actions.length ? "entry" : "entry readonly" }, actionsEl, main);
  const W = actions.length * 58;
  let open = false, moved = false;

  const setX = (x, anim) => { main.style.transition = anim ? "transform .2s ease" : "none"; main.style.transform = `translateX(${x}px)`; };
  const expand = () => { if (_openSwipeRow && _openSwipeRow !== row) _openSwipeRow._collapse(); open = true; _openSwipeRow = row; setX(-W, true); };
  const collapse = () => { open = false; if (_openSwipeRow === row) _openSwipeRow = null; setX(0, true); };
  row._collapse = collapse;

  if (W > 0) {
    let sx = 0, sy = 0, dragging = false, decided = false, horiz = false;
    main.addEventListener("touchstart", (e) => { sx = e.touches[0].clientX; sy = e.touches[0].clientY; dragging = true; decided = false; horiz = false; moved = false; }, { passive: true });
    main.addEventListener("touchmove", (e) => {
      if (!dragging) return;
      const dx = e.touches[0].clientX - sx, dy = e.touches[0].clientY - sy;
      if (!decided) { if (Math.abs(dx) < 6 && Math.abs(dy) < 6) return; decided = true; horiz = Math.abs(dx) > Math.abs(dy); }
      if (!horiz) { dragging = false; return; } // vertical → let the feed scroll
      moved = true;
      const x = Math.max(-W - 16, Math.min(0, (open ? -W : 0) + dx));
      setX(x, false);
    }, { passive: true });
    main.addEventListener("touchend", () => {
      if (!dragging) return; dragging = false;
      if (!horiz) return;
      const m = main.style.transform.match(/-?\d+(\.\d+)?/);
      ((m ? parseFloat(m[0]) : 0) < -W / 2) ? expand() : collapse();
    }, { passive: true });
    if (!_swipeScrollWired) { _swipeScrollWired = true; window.addEventListener("scroll", () => { if (_openSwipeRow) _openSwipeRow._collapse(); }, { passive: true }); }
  }

  main.addEventListener("click", () => {
    if (moved) { moved = false; return; }
    if (open) { collapse(); return; }
    if (onTap) onTap();
  });
  return row;
}

// A "Today"/"Yesterday"/date divider row for day-grouped feeds.
export function dayDivider(iso) {
  return el("div", { class: "day-divider", html: `<span>${esc(dayLabel(iso))}</span>` });
}

// Shared weigh-in edit/delete (used by BOTH the Weight tab and the All feed). `row` = a weight feed
// row ({ id, weight_lb, logged_at }); `onDone` repaints the caller's view after a change. Weights are
// pounds on the wire → kg for the API.
const _LB_PER_KG = 2.2046226;
export async function weighInDelete(row, onDone) {
  if (!row || !row.id) return;
  try {
    await api("/api/weight/" + row.id, { method: "DELETE" });
    toast("Weigh-in deleted");
    await refreshMe();
    if (typeof onDone === "function") onDone();
  } catch (e) { toast(e.message); }
}
export function weighInEdit(row, onDone) {
  if (!row || !row.id) return;
  const lbInput = el("input", { type: "number", step: "0.1", min: "0", inputmode: "decimal", value: row.weight_lb != null ? String(row.weight_lb) : "" });
  const dateInput = el("input", { type: "date", value: String(row.logged_at || "").slice(0, 10) });
  const saveBtn = el("button", { type: "button", class: "primary" }, "Save");
  const delBtn = el("button", { type: "button", class: "danger-btn" }, "Delete");
  const form = el("form", {},
    el("label", { class: "field" }, "Weight (lb)", lbInput),
    el("label", { class: "field" }, "Date", dateInput),
    el("div", { class: "sheet-actions", style: { marginTop: "6px" } }, delBtn));
  form.addEventListener("submit", (e) => e.preventDefault());
  const s = sheet({ title: "Edit weigh-in", body: form, footer: saveBtn });
  saveBtn.addEventListener("click", async () => {
    const lb = parseFloat(lbInput.value);
    if (!(lb > 0)) { toast("Enter a valid weight"); return; }
    const payload = { weight_kg: lb / _LB_PER_KG };
    const d = (dateInput.value || "").trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(d)) payload.measured_at = new Date(d + "T12:00:00").toISOString();
    try {
      await api("/api/weight/" + row.id, { method: "PATCH", json: payload });
      toast("Weigh-in updated");
      s.close();
      await refreshMe();
      if (typeof onDone === "function") onDone();
    } catch (e) { toast(e.message); }
  });
  delBtn.addEventListener("click", async () => {
    if (!(await confirmDialog("Delete this weigh-in?", { confirmLabel: "Delete", danger: true }))) return;
    s.close();
    weighInDelete(row, onDone);
  });
}

// ============================================================ shared component: stat ring
// statRing(totals, goals, opts) → HTMLElement. Renders the mode-aware progress ring + secondary
// macro stats (reuses MODES/METRIC). opts:
//   { mode?  — a MODES entry (defaults to modeOf(APP.me)),
//     days=1 — scales per-day goals to the window (a week's sum vs a week's goal),
//     netBurn=0 — exercise kcal added to the budget (only applied when the ring tracks kcal),
//     rc — ring color (defaults RC.nutrition) }
// Small type icon for the CENTER of a single-scope ring (nutrition/activity/weight), tinted with the
// ring's accent. `key` is 'n'|'a'|'w'; returns "" when absent so callers can pass through unchanged.
function ringCenterIcon(key, color) {
  if (!key || !TICON[key]) return "";
  return `<span class="ring-ico" style="color:${color}">${TICON[key]}</span>`;
}

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
    `<div class="ring-inner">${ringCenterIcon(opts.iconKey || "n", rc)}<strong>${fmt(val)}</strong><small>${esc(sub)}</small></div></div>` +
    `<div class="macros">${macros}${opts.extraTiles || ""}</div></div>`,
  );
}

// A weight stat tile (for the All ring card when weight is opted in) — matches the .macro tiles.
export function weightTile(currentLb, goalLb) {
  return `<div class="macro"><b style="color:var(--weight)">${fmt(currentLb)}</b><span>lb${goalLb ? " / " + fmt(goalLb) : " · weight"}</span></div>`;
}

// The Weight-tab hero: a progress ring around the current weight showing how far along the
// start→goal journey you are (violet weight accent), with goal / to-go / pace tiles — the same
// ring-card language as the nutrition & activity cards. `g` = primary goal (or null).
export function weightRingCard(currentLb, g) {
  const target = g ? fmt(g.target_lb) : 0;
  const start = g ? (Number(g.start_lb) || 0) : 0;
  let pct = 0;
  if (g && g.target_lb && start && start !== g.target_lb) {
    pct = Math.max(0, Math.min(100, ((start - currentLb) / (start - g.target_lb)) * 100));
  }
  const small = g && g.target_lb ? `lb · ${Math.round(pct)}% to goal` : "lb logged";
  let tiles;
  if (g) {
    const verb = g.to_go_lb >= 0 ? "to lose" : "to gain";
    const pace = g.pace
      ? (g.pace.on_track ? '<span style="color:var(--brand)">On track</span>' : `<span style="color:var(--danger)">${fmt(Math.abs(g.pace.behind_lb))} lb behind</span>`)
      : "—";
    tiles =
      `<div class="macro"><b>${target}</b><span>goal lb</span></div>` +
      `<div class="macro"><b>${fmt(Math.abs(g.to_go_lb))}</b><span>lb ${verb}</span></div>` +
      `<div class="macro"><b>${pace}</b><span>pace</span></div>`;
  } else {
    tiles = '<div class="macro"><b>—</b><span>set a goal in Goals &amp; tracking</span></div>';
  }
  return htmlToEl(
    `<div class="ring-card"><div class="ring" style="--pct:${pct.toFixed(1)};--rc:var(--weight)">` +
    `<div class="ring-inner">${ringCenterIcon("w", "var(--weight)")}<strong>${fmt(currentLb)}</strong><small>${esc(small)}</small></div></div>` +
    `<div class="macros">${tiles}</div></div>`,
  );
}

// Apple-Watch-style hero: two fat concentric progress rings + a filled inner PIE, coloured with the
// three log-type accents. `rings` outer→inner: [{ pct:0-1, color, key }]. Each ring/pie starts at
// 12 o'clock and sweeps clockwise; a card-cut icon marker sits at each start, so the three type icons
// stack vertically down the top. Same overall footprint as before, just fatter bands.
export function tripleRing(rings) {
  const S = 118, c = S / 2, sw = 13, gap = 3;
  const r1 = S / 2 - sw / 2 - 2;      // outer ring centerline
  const r2 = r1 - sw - gap;           // middle ring centerline
  const pieR = r2 - sw / 2 - gap;     // inner pie radius — fills the center up to inside the mid ring
  const clamp = (p) => Math.max(0, Math.min(1, p || 0));
  const arc = (rad, color, pct) => {
    const C = 2 * Math.PI * rad, dash = (C * clamp(pct)).toFixed(2);
    return `<circle cx="${c}" cy="${c}" r="${rad.toFixed(2)}" fill="none" stroke="${color}" stroke-opacity=".15" stroke-width="${sw}"/>` +
      `<circle cx="${c}" cy="${c}" r="${rad.toFixed(2)}" fill="none" stroke="${color}" stroke-width="${sw}" stroke-linecap="round" stroke-dasharray="${dash} ${(C + 1).toFixed(2)}" transform="rotate(-90 ${c} ${c})"/>`;
  };
  const pie = (rad, color, pct) => {
    const p = clamp(pct);
    const bg = `<circle cx="${c}" cy="${c}" r="${rad.toFixed(2)}" fill="${color}" fill-opacity=".15"/>`;
    if (p <= 0) return bg;
    if (p >= 0.999) return bg + `<circle cx="${c}" cy="${c}" r="${rad.toFixed(2)}" fill="${color}"/>`;
    const a = -Math.PI / 2 + p * 2 * Math.PI;
    const x = (c + rad * Math.cos(a)).toFixed(2), y = (c + rad * Math.sin(a)).toFixed(2), big = p > 0.5 ? 1 : 0;
    return bg + `<path d="M${c} ${c} L${c} ${(c - rad).toFixed(2)} A${rad.toFixed(2)} ${rad.toFixed(2)} 0 ${big} 1 ${x} ${y} Z" fill="${color}"/>`;
  };
  const marker = (rad, color, key) => {
    const y = c - rad, inner = (TICON[key] || "").replace(/<svg[^>]*>/, "").replace(/<\/svg>/, "");
    return `<circle cx="${c}" cy="${y.toFixed(2)}" r="7.8" fill="var(--card)"/>` +
      `<g transform="translate(${(c - 5.6).toFixed(2)} ${(y - 5.6).toFixed(2)}) scale(0.467)" fill="none" stroke="${color}" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">${inner}</g>`;
  };
  let svg = `<svg class="trir" viewBox="0 0 ${S} ${S}" width="${S}" height="${S}" aria-hidden="true">`;
  if (rings[0]) svg += arc(r1, rings[0].color, rings[0].pct);
  if (rings[1]) svg += arc(r2, rings[1].color, rings[1].pct);
  if (rings[2]) svg += pie(pieR, rings[2].color, rings[2].pct);
  // Icon markers on top, stacked down the 12 o'clock line (outer → mid → pie).
  if (rings[0]) svg += marker(r1, rings[0].color, rings[0].key);
  if (rings[1]) svg += marker(r2, rings[1].color, rings[1].key);
  // The pie has no "ring start" to sit on; nudge its icon just inside the pie so the marker's top
  // edge kisses the pie's top edge, clear of the activity marker above it.
  if (rings[2]) svg += marker(pieR - 6, rings[2].color, rings[2].key);
  return svg + "</svg>";
}

// The 3-ring hero card for the All view: the rings/pie + a legend row per metric (colour dot, label,
// value / goal, %). `items` outer→inner: [{ key:'n'|'a'|'w', color, label, value, goal, unit, pct }].
export function tripleRingCard(items) {
  const svg = tripleRing(items.map((it) => ({ pct: it.pct, color: it.color, key: it.key })));
  const legend = items.map((it) => {
    const pctTxt = it.goal ? Math.round(Math.max(0, Math.min(1, it.pct || 0)) * 100) + "%" : "";
    const goalTxt = it.goal ? ` <span class="trir-goal">/ ${fmt(it.goal)}${it.unit ? " " + esc(it.unit) : ""}</span>` : (it.unit ? ` <span class="trir-goal">${esc(it.unit)}</span>` : "");
    return `<div class="trir-leg"><span class="trir-ico" style="color:${it.color}">${TICON[it.key] || ""}</span>` +
      `<span class="trir-ll">${esc(it.label)}</span>` +
      `<span class="trir-val"><b>${fmt(it.value)}</b>${goalTxt}${pctTxt ? `<small style="color:${it.color}">${pctTxt}</small>` : ""}</span></div>`;
  }).join("");
  return htmlToEl(`<div class="ring-card trir-card"><div class="trir-wrap">${svg}</div><div class="trir-legend">${legend}</div></div>`);
}

// A bare ring (single number + caption + percent), for activity/weight cards that aren't macro-based.
// `iconKey` ('n'|'a'|'w') drops that type's icon into the ring center, tinted with the accent.
export function ringEl(value, caption, pct, rc = RC.nutrition, extraHtml = "", iconKey = "") {
  return htmlToEl(
    `<div class="ring-card"><div class="ring" style="--pct:${Number(pct) || 0};--rc:${rc}">` +
    `<div class="ring-inner">${ringCenterIcon(iconKey, rc)}<strong>${fmt(value)}</strong><small>${esc(caption)}</small></div></div>` +
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
