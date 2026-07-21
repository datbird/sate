// Sate v2 SPA — Weight tab. Owned by the weight agent. This view does NOT own a container and is NOT
// in the nav: it renders INSIDE Home's "Weight" scope. Home calls view('weight').render({ statbody,
// feed, range }) whenever the Weight segment is active, handing us the same #statbody / #feed nodes the
// other scopes draw into. We paint the current weight + trend chart + goals-with-pace + inline log into
// `statbody`, and the reverse-chronological weigh-in history into `feed`.
//
// Faithful port of v1 renderWeight()/logWeightManual()/setWeightSource()/weightSyncNow() (pb_public/
// app.js) over the v2 API. Weights are stored in kg (canonical) but every route speaks pounds to the
// client, so we convert on the way in/out exactly as v1 did.
//
// API surface:
//   GET    /api/weight?range=day|week|month|year  → { range, series:[{t,weight_lb}], current_lb,
//                                                     height_cm, weight_source, goals:[…w/ pace] }
//   POST   /api/weight/log      { weight_kg }      → manual weigh-in
//   PATCH  /api/goals           { weight_source }  → switch manage-weight source (native prompt)
//   POST   /api/weight/sync     { weights:[…] }    → Apple Health body-mass import (NATIVE only)
//   (goal add/remove lives in the Goals view: GET/POST/DELETE /api/weight/goals)

"use strict";

import { $, el, htmlToEl, esc, api, lineChart, RC, isNative, me, toast, refreshMe, registerView, feedRow, dayDivider, localDayKey, weightRingCard } from "../lib.js";

// v1's exact conversion constant, so a value logged here round-trips to the same pounds the server
// echoes back.
const LB_PER_KG = 2.2046226;

// The last ctx Home handed us, so post-mutation re-renders (log / source switch / Health sync) can
// repaint the same nodes without Home re-driving the scope.
let CTX = null;

// ============================================================ render entry point
// Called by Home on every show of the Weight scope. `ctx` = { statbody, feed, range }.
export async function render(ctx) {
  if (ctx) CTX = ctx;
  ctx = CTX;
  if (!ctx || !ctx.statbody || !ctx.feed) return;
  const { statbody, feed, range } = ctx;

  const lbl = $("#feedlbl");
  if (lbl) lbl.textContent = "Weight history";

  let d;
  try {
    d = await api("/api/weight?range=" + (range || "month"));
  } catch (e) {
    statbody.innerHTML = "";
    statbody.appendChild(el("div", { class: "subline", text: e.message }));
    feed.innerHTML = "";
    return;
  }

  drawStat(statbody, d);
  loadHistory(feed, true); // day-divided infinite-scroll weigh-in history (independent of the range series)
}

// ============================================================ stat card (current + trend + goals + log)
function drawStat(statbody, d) {
  const cur = d.current_lb || 0;
  const pts = (d.series || []).map((s) => s.weight_lb);
  const goal0 = (d.goals || [])[0];

  statbody.innerHTML = "";

  // Hero: progress ring (start→goal journey, violet weight accent) with goal / to-go / pace tiles —
  // the same ring-card language as the nutrition & activity cards. Falls back to a prompt if no
  // weight is logged yet.
  if (cur) {
    statbody.appendChild(weightRingCard(cur, goal0));
  } else {
    statbody.appendChild(el("div", { class: "wcur", text: "No weight logged yet" }));
  }

  // Trend chart, weight-accented (lib.lineChart needs ≥2 points; otherwise nudge to log more).
  if (pts.length > 1) {
    statbody.appendChild(lineChart(pts, goal0 ? goal0.target_lb : 0, "var(--weight)"));
  } else {
    statbody.appendChild(el("div", { class: "subline", text: "Log a few weigh-ins to see your trend." }));
  }

  // Manage-weight source prompt — Apple Health vs manual. NATIVE-only (web has no Health bridge, and
  // isNative() is always false on web, so this never shows there — matching v1).
  if (!d.weight_source && isNative()) {
    const src = htmlToEl(
      '<div class="wsrc">Manage weight from <button class="link" type="button" data-src="health">Apple Health</button> or <button class="link" type="button" data-src="manual">enter it manually</button>?</div>',
    );
    src.querySelector('[data-src="health"]').addEventListener("click", () => setWeightSource("health"));
    src.querySelector('[data-src="manual"]').addEventListener("click", () => setWeightSource("manual"));
    statbody.appendChild(src);
  }

  // Inline manual log (weight in lb → kg on the wire).
  const logRow = htmlToEl(
    '<div class="wlog"><input type="number" id="wIn" placeholder="Log weight (lb)" inputmode="decimal" step="0.1"><button class="primary small" id="wLogBtn" type="button">Log</button></div>',
  );
  const input = logRow.querySelector("#wIn");
  logRow.querySelector("#wLogBtn").addEventListener("click", () => logWeightManual(input));
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") logWeightManual(input); });
  statbody.appendChild(logRow);
}

// ============================================================ weigh-in history (day-divided infinite scroll)
// Mirrors Home's entry feed: cursor-paginated (GET /api/feed?scope=weight), grouped by local day with
// a divider between days, and back-filled until the page fills so the window scroll can drive more.
const WFEED = { cursor: null, done: false, loading: false, lastDay: null, seq: 0 };

async function loadHistory(feedEl, reset) {
  const feed = feedEl || (CTX && CTX.feed);
  if (!feed || WFEED.loading) return;
  if (reset) { WFEED.cursor = null; WFEED.done = false; WFEED.lastDay = null; WFEED.seq++; feed.innerHTML = ""; }
  if (WFEED.done) return;
  const seq = WFEED.seq;
  WFEED.loading = true;
  try {
    const qs = "/api/feed?limit=40&scope=weight" + (WFEED.cursor ? "&before=" + encodeURIComponent(WFEED.cursor) : "");
    const r = await api(qs);
    if (seq !== WFEED.seq) return; // a reset happened mid-flight
    appendHistory(feed, r.entries || []);
    WFEED.cursor = r.next;
    if (!r.next) WFEED.done = true;
    if (reset && !feed.children.length) {
      feed.innerHTML = '<li class="hint" style="color:var(--muted);font-size:13px;padding:10px 2px">No weigh-ins yet — log your weight above.</li>';
      WFEED.done = true;
    }
  } catch (_) { /* keep whatever is already shown */ }
  finally { if (seq === WFEED.seq) WFEED.loading = false; }
  // Backfill until the page fills the screen so scrolling can begin.
  if (!WFEED.done && document.body.offsetHeight <= window.innerHeight + 200) loadHistory(feed, false);
}

function appendHistory(feed, rows) {
  rows.forEach((en) => {
    const key = localDayKey(en.logged_at);
    if (key !== WFEED.lastDay) { WFEED.lastDay = key; feed.appendChild(dayDivider(en.logged_at)); }
    feed.appendChild(feedRow({ kind: "weight", logged_at: en.logged_at, weight_lb: en.weight_lb, source: en.source }));
  });
}

// ============================================================ mutations
// Manual weigh-in: POST /api/weight/log (kg), refresh identity, repaint.
async function logWeightManual(input) {
  const v = Number(input && input.value);
  if (!(v > 0)) { toast("Enter a weight"); return; }
  const kg = v / LB_PER_KG;
  try {
    const r = await api("/api/weight/log", { method: "POST", json: { weight_kg: kg } });
    toast("Weight logged");
    // Two-way (opt-in): also write this weigh-in back to Apple Health. Best-effort — a Health write
    // failure must never break logging. The sample is tagged with the Sate id so import skips it.
    if (isNative() && me() && me().health_write) writeWeightToHealth(kg, r && r.id);
    await refreshMe();       // body_weight_kg scalar changed (used by other views' HR estimate).
    render();                // repaint the same Home Weight nodes.
  } catch (e) { toast(e.message); }
}

// Fire-and-forget write-back to Apple Health for a manual weigh-in (native + opt-in only).
async function writeWeightToHealth(kg, entryId) {
  const HK = healthPlugin();
  if (!HK || typeof HK.saveWeight !== "function") return;
  try { await HK.saveWeight({ kg, entryId: entryId ? String(entryId) : undefined }); }
  catch (_) { /* non-fatal: the weigh-in is already saved in Sate */ }
}

// Switch the manage-weight source (native prompt only). Health → kick off an import.
async function setWeightSource(src) {
  try { await api("/api/goals", { method: "PATCH", json: { weight_source: src } }); } catch (_) {}
  await refreshMe();
  if (src === "health" && isNative()) await weightSyncNow(false);
  render();
}

// Apple Health body-mass import — NATIVE only. On web isNative() is false so this is never reached; we
// still gate the Capacitor bridge access defensively. Mirrors v1 weightSyncNow().
async function weightSyncNow(silent) {
  const HK = healthPlugin();
  if (!HK) { if (!silent) toast("Apple Health needs the Sate app"); return; }
  try {
    await HK.requestAuthorization();
    const r = await HK.queryWeights({ months: 12 });
    const res = await api("/api/weight/sync", { method: "POST", json: { weights: (r && r.samples) || [] } });
    await refreshMe();
    if (!silent) toast(res.added ? ("Imported " + res.added + " weigh-in" + (res.added === 1 ? "" : "s")) : "Weight up to date");
    render();
  } catch (e) { if (!silent) toast((e && e.message) || "Weight sync failed"); }
}

// The Capacitor HealthKit bridge, or null off-native. Gated so the web build never touches it. The
// remotely-loaded SPA doesn't bundle @capacitor/core, so registerPlugin isn't injected — reach the
// native plugin through Capacitor.Plugins (how the launcher reaches Preferences), with a fallback.
function healthPlugin() {
  const cap = window.Capacitor;
  if (!isNative() || !cap) return null;
  return (cap.Plugins && cap.Plugins.HealthKit) ||
         (typeof cap.registerPlugin === "function" ? cap.registerPlugin("HealthKit") : null);
}

// Infinite scroll for the weigh-in history. Home's own scroll listener bails on the Weight scope, so
// we drive paging here — but only while the Weight segment is actually the active scope.
window.addEventListener("scroll", () => {
  const home = $("#view-home");
  if (!home || home.hidden) return;
  const onBtn = $("#scope button.on");
  if (!onBtn || onBtn.dataset.scope !== "weight") return;
  if (window.innerHeight + window.scrollY >= document.body.offsetHeight - 500) loadHistory(null, false);
}, { passive: true });

// ============================================================ register with the router
// Weight is delegated by Home (view('weight').render(ctx)) rather than opened as an overlay; it exposes
// no open(). We still register render() so the contract's view registry is satisfied.
registerView("weight", { render });
