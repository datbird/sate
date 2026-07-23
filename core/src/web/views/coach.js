// Sate v2 SPA — Coach view. A persistent, stat-aware chat with the AI nutrition coach.
//
//   • Tab view (container #view-coach), fixed between the header + bottom bar (sizeCoach measures both
//     and sets the --coach-top / --coach-bottom vars the CSS pins to).
//   • Chat over POST /api/nutritionist: mode:"chat" carries { message, history, image? }; the
//     "Generate my plan" button sends mode:"plan". The transcript (COACH.history) persists across
//     shows so the coach remembers the thread. Nothing said here is ever logged to the diary.
//   • Photo attach (discussion only) — a file picker reads the image to a base64 data URL and rides
//     the next turn as { image:{mimeType,data} }. Plain web file input; no native camera needed.
//   • "Second opinion" per reply — re-runs the same request with role:"second" (gated by the global
//     second_opinion_enabled toggle) and appends a labeled bubble.
//   • Proactive check-ins: on first app navigation, GET /api/checkins/pending → a dot on the Coach
//     tab. Opening Coach injects the pending check-in as a coach bubble, seeds it into history, and
//     POSTs /api/checkins/:id/seen. On native only, a local notification is scheduled for later.
//
// Mirrors v1 app.js (nutrition coach chat) over the v2 /api routes + lib.js conventions.

"use strict";

import {
  $, $$, el, api, me, registerView, onViewChange, toast, isNative, refreshMe, fmt,
} from "../lib.js";

// ---------------------------------------------------------------- persistent view state
// history: running transcript replayed to the coach so it remembers the thread.
// pending:  the image staged on the next turn ({ mimeType, data, url }), or null.
const COACH = { history: [], pending: null };
let CHECKIN_PENDING = null;   // latest server-generated check-in awaiting the user, or null
let BUILT = false;            // DOM built once
let SEEDED = false;           // greeting + plan button dropped once
let BADGE_LOADED = false;     // pending check-in fetched once on first navigation

// Cached element refs (set in build()).
let logEl = null, inputEl = null, previewEl = null, fileEl = null;

// The camera / attach glyph (matches v1's compose + attach buttons).
const CAMERA_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M21 15V6a3 3 0 0 0-3-3H6a3 3 0 0 0-3 3v12a3 3 0 0 0 3 3h9"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M4 16l4-4 3 3 4-4 3 3"/></svg>';

// ============================================================ render (tab entry point)
// Called by showView('coach') on every show. Builds the chat once, then re-measures, drops any
// pending check-in into the thread, and pins the log to the bottom.
export function render(container) {
  const host = container || $("#view-coach");
  if (!host) return;
  if (!BUILT) build(host);
  sizeCoach();
  seedChat();
  showPendingCheckin();
  scrollLog();
}

// ============================================================ one-time DOM build
function build(host) {
  host.innerHTML = "";
  logEl = el("div", { class: "coachlog tablog", id: "coachTabLog" });
  previewEl = el("div", { class: "coachpreview", id: "coachPreview", hidden: true });
  inputEl = el("input", { id: "coachTabInput", placeholder: "Ask anything, or attach a photo…", autocomplete: "off" });
  fileEl = el("input", { id: "coachImgInput", type: "file", accept: "image/*", hidden: true });

  const attach = el("button", {
    class: "iconbtn", id: "coachAttach", type: "button",
    title: "Attach a photo", "aria-label": "Attach a photo", html: CAMERA_SVG,
    onClick: () => fileEl.click(),
  });
  const send = el("button", { class: "primary small", id: "coachTabSend", type: "button", text: "Send", onClick: () => coachSend() });

  inputEl.addEventListener("keydown", (e) => { if (e.key === "Enter") coachSend(); });
  fileEl.addEventListener("change", (e) => { const f = e.target.files[0]; if (f) attachFile(f); });

  const bar = el("div", { class: "coachbar" }, attach, inputEl, send);
  const compose = el("div", { class: "coachcompose" }, previewEl, bar, fileEl);
  host.appendChild(el("div", { class: "coachtab" }, logEl, compose));

  // Keep the chat locked to the viewport as it resizes / rotates.
  window.addEventListener("resize", () => { const v = $("#view-coach"); if (v && !v.hidden) sizeCoach(); });
  window.addEventListener("orientationchange", () => setTimeout(sizeCoach, 100));
  BUILT = true;
}

// ============================================================ greeting + plan CTA (once)
function seedChat() {
  if (SEEDED || !logEl) return;
  SEEDED = true;
  append("coach",
    "Hi! I'm your nutrition coach — I know your stats, goals, and recent intake. Ask me anything, " +
    "or attach a photo of a menu or plate to talk it through. Nothing here gets logged.");
  const plan = el("button", { class: "link coachplan", type: "button", text: "📋 Generate my plan", onClick: () => coachSend("__plan__") });
  logEl.appendChild(plan);
}

// ============================================================ chat send
async function coachSend(preset) {
  const isPlan = preset === "__plan__";
  const msg = isPlan ? "" : String(typeof preset === "string" ? preset : (inputEl ? inputEl.value : "") || "").trim();
  const image = isPlan ? null : COACH.pending;
  if (!isPlan && !msg && !image) return;

  if (!isPlan) {
    const bubble = append("me", msg || "");
    if (image) bubble.appendChild(el("img", { class: "cmsg-img", src: image.url, alt: "attached photo" }));
  }
  if (inputEl) inputEl.value = "";
  clearAttach();

  const thinking = append("coach", "");
  thinking.classList.add("dots");

  const reqBody = isPlan ? { mode: "plan" } : { mode: "chat", message: msg, history: COACH.history.slice(-20) };
  if (image) reqBody.image = { mimeType: image.mimeType, data: image.data };

  try {
    const r = await api("/api/nutritionist", { method: "POST", json: reqBody });
    thinking.classList.remove("dots");
    thinking.textContent = r.reply || "(no reply)";
    if (!isPlan) {
      COACH.history.push({ role: "user", text: msg || "(shared a photo to discuss)" });
      COACH.history.push({ role: "assistant", text: r.reply || "" });
    }
    if (!isPlan && r.plan_change) renderPlanChange(r.plan_change);
    secondOpinionBtn(reqBody);
  } catch (e) {
    thinking.classList.remove("dots");
    thinking.textContent = (e && e.message) || "Coach unavailable";
  }
  scrollLog();
}

// ============================================================ second opinion
// Re-runs the last request with role:"second" (the second-opinion model) and appends a labeled
// bubble. Suppressed entirely when the instance disabled the feature.
function secondOpinionBtn(reqBody) {
  const M = me() || {};
  if (M.second_opinion_enabled === false || !logEl) return;
  const btn = el("button", { class: "link", type: "button", text: "🔀 Second opinion" });
  const bar = el("div", { class: "cmsg-actions" }, btn);
  btn.addEventListener("click", async () => {
    btn.disabled = true;
    const thinking = append("coach second", "");
    thinking.classList.add("dots");
    try {
      const r = await api("/api/nutritionist", { method: "POST", json: { ...reqBody, role: "second" } });
      thinking.classList.remove("dots");
      thinking.textContent = r.reply || "(no reply)";
      thinking.insertBefore(el("div", { class: "second-tag", text: "Second opinion" + (r.model ? " · " + r.model : "") }), thinking.firstChild);
      bar.remove();
    } catch (e) {
      thinking.classList.remove("dots");
      thinking.textContent = (e && e.message) || "Second opinion unavailable";
      btn.disabled = false;
    }
    scrollLog();
  });
  logEl.appendChild(bar);
}

// ============================================================ inline plan-change confirm (spec §10)
// A coach reply may carry a validated plan_change proposal. Show an Apply/Dismiss card — NEVER a silent
// rewrite. Apply → POST /api/plan/apply (deterministic recompute + persist) → refreshMe() so the Plan
// card + Home rings reflect the new goals. Dismiss changes nothing.
const METHOD_LABEL = { calories: "Calories", carb: "Carb-focused", protein: "High-protein", fat: "Low-fat", balanced: "Balanced", heart: "Heart-healthy" };
const ACTIVITY_LABEL = { sedentary: "Sedentary", light: "Light", moderate: "Moderate", active: "Active", athlete: "Athlete" };

function planChangeSummary(ch) {
  const parts = [];
  if (ch.goal_kcal) parts.push(fmt(ch.goal_kcal) + " kcal");
  if (ch.method) parts.push(METHOD_LABEL[ch.method] || ch.method);
  if (ch.activity_level) parts.push(ACTIVITY_LABEL[ch.activity_level] || ch.activity_level);
  if (ch.weight_goal) parts.push(Math.round(ch.weight_goal.target_lb) + " lb by " + ch.weight_goal.target_date);
  return parts.join(" · ");
}

function renderPlanChange(change) {
  if (!logEl || !change) return;
  const card = el("div", { class: "planchange" });
  const label = el("div", { class: "pc-label" },
    el("strong", { text: "Update your plan: " }),
    el("span", { text: planChangeSummary(change) }));

  const apply = el("button", { class: "primary small", type: "button", text: "Apply" });
  const dismiss = el("button", { class: "link", type: "button", text: "Dismiss" });
  const actions = el("div", { class: "pc-actions" }, apply, dismiss);

  apply.addEventListener("click", async () => {
    apply.disabled = true; dismiss.disabled = true;
    try {
      await api("/api/plan/apply", { method: "POST", json: change });
      await refreshMe(); // Plan card + Home rings read the new goals on their next render.
      card.innerHTML = "";
      card.classList.add("done");
      card.appendChild(el("div", { class: "pc-done", text: "✓ Plan updated — " + planChangeSummary(change) }));
      toast("Plan updated");
    } catch (e) {
      apply.disabled = false; dismiss.disabled = false;
      toast((e && e.message) || "Could not update your plan");
    }
    scrollLog();
  });
  dismiss.addEventListener("click", () => { card.remove(); });

  card.append(label, actions);
  logEl.appendChild(card);
  scrollLog();
}

// ============================================================ photo attach (discussion only)
function attachFile(file) {
  if (!file) return;
  const fr = new FileReader();
  fr.onload = () => {
    const res = String(fr.result);
    const m = res.match(/^data:([^;]+);base64,(.*)$/);
    if (!m) { toast("Could not read that image"); return; }
    COACH.pending = { mimeType: m[1], data: m[2], url: res };
    previewEl.hidden = false;
    previewEl.innerHTML = "";
    previewEl.appendChild(el("img", { src: res, alt: "attached" }));
    previewEl.appendChild(el("button", { class: "cpx", type: "button", "aria-label": "Remove photo", text: "×", onClick: clearAttach }));
  };
  fr.readAsDataURL(file);
}
function clearAttach() {
  COACH.pending = null;
  if (previewEl) { previewEl.hidden = true; previewEl.innerHTML = ""; }
  if (fileEl) fileEl.value = "";
}

// ============================================================ proactive check-ins
// Dot on the Coach tab (header tabs + bottom bar) while a check-in is waiting.
function setBadge(on) {
  $$('[data-view="coach"]').forEach((b) => b.classList.toggle("has-badge", !!on));
}

// Pull the latest pending check-in and flag it. Respects the per-user opt-out (checkins_enabled).
// On native, also schedule a local notification for later.
async function loadPendingCheckin() {
  const M = me() || {};
  if (M.checkins_enabled === false) { setBadge(false); return; }
  try { const r = await api("/api/checkins/pending"); CHECKIN_PENDING = (r && r.checkin) || null; }
  catch (_) { CHECKIN_PENDING = null; }
  setBadge(!!CHECKIN_PENDING);
  if (CHECKIN_PENDING && isNative()) { try { scheduleCheckinNotification(CHECKIN_PENDING); } catch (_) {} }
}

// When Coach opens, drop the pending check-in in as a coach bubble, seed it into history so the
// user's reply is in context, and mark it seen so it isn't re-shown.
function showPendingCheckin() {
  if (!CHECKIN_PENDING || !logEl) return;
  const c = CHECKIN_PENDING;
  CHECKIN_PENDING = null;
  setBadge(false);
  const bubble = append("coach", c.message || "");
  bubble.insertBefore(el("div", { class: "second-tag", text: "Check-in" + (c.topic ? " · " + c.topic : "") }), bubble.firstChild);
  COACH.history.push({ role: "assistant", text: c.message || "" });
  api("/api/checkins/" + c.id + "/seen", { method: "POST" }).catch(() => {});
}

// ---- native local notification for the check-in (Capacitor bridge; web no-ops via isNative gate) ----
function checkinNotifId(s) {
  let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return (Math.abs(h) % 2000000000) + 1;
}
function nextCheckinFireTime() {
  const d = new Date(Date.now() + 3 * 3600 * 1000);
  const h = d.getHours();
  if (h < 8) d.setHours(9, 0, 0, 0);
  else if (h >= 21) { d.setDate(d.getDate() + 1); d.setHours(9, 0, 0, 0); }
  return d;
}
let NOTIF_WIRED = false;
async function scheduleCheckinNotification(c) {
  if (!isNative() || !c || c.notified) return;
  const ln = (window.Capacitor && window.Capacitor.registerPlugin) ? window.Capacitor.registerPlugin("LocalNotifications") : null;
  if (!ln) return;
  if (!NOTIF_WIRED) {
    NOTIF_WIRED = true;
    try {
      ln.addListener("localNotificationActionPerformed", (ev) => {
        const extra = ev && ev.notification && ev.notification.extra;
        if (extra && extra.view === "coach") loadPendingCheckin();
      });
    } catch (_) {}
  }
  try {
    const perm = await ln.requestPermissions();
    if (perm && perm.display && perm.display !== "granted") return;
  } catch (_) {}
  try {
    const M = me() || {};
    await ln.schedule({ notifications: [{
      id: checkinNotifId(c.id),
      title: (M.app_name || "Sate") + " coach",
      body: c.message,
      schedule: { at: nextCheckinFireTime() },
      extra: { checkinId: c.id, view: "coach" },
    }] });
    api("/api/checkins/" + c.id + "/notified", { method: "POST" }).catch(() => {});
  } catch (_) {}
}

// ============================================================ helpers
function append(who, text) {
  const node = el("div", { class: "cmsg " + who, text: text || "" });
  if (logEl) { logEl.appendChild(node); scrollLog(); }
  return node;
}
function scrollLog() { if (logEl) logEl.scrollTop = logEl.scrollHeight; }

// The Coach view is position:fixed between the header and the bottom tab bar; measure both so the
// log locks to exactly the free space (heights include safe-area insets, vary by device/orientation).
function sizeCoach() {
  const v = $("#view-coach");
  if (!v) return;
  const top = $(".topbar");
  const tab = $("#tabbar");
  const topH = top ? Math.round(top.getBoundingClientRect().height) : 0;
  const tabShown = tab && getComputedStyle(tab).display !== "none" && !tab.hidden;
  const tabH = tabShown ? Math.round(tab.getBoundingClientRect().height) : 0;
  v.style.setProperty("--coach-top", topH + "px");
  v.style.setProperty("--coach-bottom", tabH + "px");
}

// ============================================================ badge on first navigation
// app.js has no per-view init hook, so ride the first showView (fired from enterApp AFTER /api/me is
// loaded) to fetch the pending check-in once and light the Coach tab.
onViewChange(() => {
  if (BADGE_LOADED) return;
  BADGE_LOADED = true;
  loadPendingCheckin();
});

// ============================================================ register with the router
registerView("coach", { container: "#view-coach", render });
