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

import { $, el, htmlToEl, esc, api, lineChart, RC, isNative, toast, refreshMe, registerView } from "../lib.js";

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
  drawHistory(feed, d);
}

// ============================================================ stat card (current + trend + goals + log)
function drawStat(statbody, d) {
  const cur = d.current_lb || 0;
  const pts = (d.series || []).map((s) => s.weight_lb);
  const goal0 = (d.goals || [])[0];

  statbody.innerHTML = "";

  // Current weight headline.
  statbody.appendChild(htmlToEl(
    `<div class="wcur">${cur ? esc(cur) + ' <span class="wunit">lb</span>' : "No weight logged yet"}</div>`,
  ));

  // Trend chart vs the first goal's target (lib.lineChart needs ≥2 points; otherwise nudge to log more).
  if (pts.length > 1) {
    statbody.appendChild(lineChart(pts, goal0 ? goal0.target_lb : 0, RC.nutrition));
  } else {
    statbody.appendChild(el("div", { class: "subline", text: "Log a few weigh-ins to see your trend." }));
  }

  // Goals with pace (to-go + on-track / behind).
  statbody.appendChild(el("div", { class: "wgoals", html: goalsHtml(d.goals || []) }));

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

// Goals list markup (identical to v1): "<target> lb by <date> · <to-go> lb to lose/gain <pace>".
function goalsHtml(goals) {
  const rows = goals.map((g) => {
    const verb = g.to_go_lb >= 0 ? "to lose" : "to gain";
    const pace = g.pace
      ? (g.pace.on_track
          ? '<span class="ontrack">on track</span>'
          : `<span class="behind">${esc(Math.abs(g.pace.behind_lb))} lb behind</span>`)
      : "";
    return `<div class="wgoal"><b>${esc(g.target_lb)} lb</b> by ${esc(g.target_date)} · ${esc(Math.abs(g.to_go_lb))} lb ${verb} ${pace}</div>`;
  });
  return rows.join("") || '<div class="subline">No weight goal yet — set one in Goals &amp; tracking.</div>';
}

// ============================================================ weigh-in history (reverse-chronological)
function drawHistory(feed, d) {
  feed.innerHTML = "";
  const rows = (d.series || []).slice().reverse().slice(0, 40);
  if (!rows.length) {
    feed.appendChild(el("li", { class: "hint", style: { color: "var(--muted)", fontSize: "13px", padding: "10px 2px" }, text: "No weigh-ins yet — log your weight above." }));
    return;
  }
  rows.forEach((s) => {
    const dt = new Date(String(s.t).replace(" ", "T")).toLocaleDateString([], { month: "short", day: "numeric" });
    feed.appendChild(htmlToEl(
      `<div class="entry readonly"><span class="etext"><span class="t">${esc(s.weight_lb)} lb</span>` +
      `<span class="s">${esc(dt)}</span></span></div>`,
    ));
  });
}

// ============================================================ mutations
// Manual weigh-in: POST /api/weight/log (kg), refresh identity, repaint.
async function logWeightManual(input) {
  const v = Number(input && input.value);
  if (!(v > 0)) { toast("Enter a weight"); return; }
  try {
    await api("/api/weight/log", { method: "POST", json: { weight_kg: v / LB_PER_KG } });
    toast("Weight logged");
    await refreshMe();       // body_weight_kg scalar changed (used by other views' HR estimate).
    render();                // repaint the same Home Weight nodes.
  } catch (e) { toast(e.message); }
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

// ============================================================ register with the router
// Weight is delegated by Home (view('weight').render(ctx)) rather than opened as an overlay; it exposes
// no open(). We still register render() so the contract's view registry is satisfied.
registerView("weight", { render });
