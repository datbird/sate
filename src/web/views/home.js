// Sate v2 SPA — Home dashboard. THE worked reference view: it exercises every foundation convention
// the other views follow. Read this alongside the CONTRACT.
//
//   • registers with the router as a tab view (container #view-home) exporting render();
//   • reads shared state from APP.me (goals, track_mode, net_exercise);
//   • drives the scope (All/Nutrition/Activity/Weight) + range (Day/Week/Month/Year) + chart
//     (ring/line/hybrid) segmented controls that live in index.html;
//   • pulls GET /api/stats and renders the mode-aware stat card via lib's statRing/lineChart/sparkBars;
//   • pulls GET /api/feed (cursor + scope) into a day-grouped, infinite-scroll feed of lib.feedRow's;
//   • "+ Add to log" → openView('compose', …) and row tap/edit → openView('editentry', entry),
//     with delete calling DELETE /api/entries/:id then re-rendering;
//   • delegates the Weight scope to view('weight').render(...) (a stub today).

"use strict";

import {
  $, $$, api, APP, me, registerView, openView, view, toast,
  statRing, ringEl, lineChart, sparkBars, feedRow, dayDivider, inOutSub, weightTile,
  fmt, modeOf, METRIC, RC, localDayKey,
} from "../lib.js";

// View-local UI state (mirrors v1 HOME): which slice + window + chart the dashboard is showing.
const HOME = { scope: "all", range: "day", chart: "ring" };

// ============================================================ render entry point
// Called by showView('home') on every show. Weight is its own data source (delegated); all other
// scopes render the stat card (from /api/stats) + the day-grouped feed (from /api/feed).
async function render() {
  const charts = $("#charts");
  if (HOME.scope === "weight") {
    if (charts) charts.style.visibility = "hidden";
    const w = view("weight");
    if (w && typeof w.render === "function") return w.render({ statbody: $("#statbody"), feed: $("#feed"), range: HOME.range });
    $("#statbody").innerHTML = '<div class="subline">Weight tracking loads here.</div>';
    $("#feed").innerHTML = "";
    return;
  }
  if (charts) charts.style.visibility = "";
  let stats;
  try { stats = await api("/api/stats?range=" + HOME.range); }
  catch (e) { toast(e.message); return; }
  renderStats(stats);
  $("#feedlbl").textContent = "Log";
  loadFeed(true);
}

// ============================================================ stat card
function renderStats(s) {
  const body = $("#statbody");
  const goals = s.goals || (me() && me().goals) || {};
  const inKcal = (s.in && s.in.kcal) || 0;
  const out = s.out || { kcal: 0, minutes: 0, workouts: 0 };
  const nutSeries = (s.series || []).map((b) => b.in_kcal);
  const actSeries = (s.series || []).map((b) => b.out_kcal);
  const days = s.days || 1;
  const burnKcal = out.kcal || 0;
  const M = me() || {};
  // Net-exercise: exercise kcal raise the budget when the user opts in, the server allows it, and
  // the ring actually tracks calories.
  const applyNet = !!M.net_exercise && s.net_exercise !== false && modeOf().primary === "kcal" && burnKcal > 0;

  body.innerHTML = "";

  // ---- Activity scope
  if (HOME.scope === "activity") {
    if (HOME.chart === "line") {
      body.appendChild(lineChart(actSeries, 0, RC.activity));
      body.appendChild(htmlRow(`Avg burn <b>${fmt(s.avg_out_kcal)} cal</b>`, `Total <b>${fmt(out.kcal)}</b>`));
      return;
    }
    const pct = Math.min(100, Math.round((out.kcal / 500) * 100));
    const extra = `<div class="kpis"><div class="kpi"><b>${fmt(out.minutes)}</b><span>active min</span></div>` +
      `<div class="kpi"><b>${fmt(out.workouts)}</b><span>workouts</span></div></div>`;
    body.appendChild(ringEl(out.kcal, "cal burned", pct, RC.activity, extra));
    if (HOME.chart === "hybrid" && actSeries.length > 1) body.appendChild(sparkBars(actSeries));
    const netMsg = (M.net_exercise && s.net_exercise !== false)
      ? "Exercise calories are added to your daily budget."
      : "Burn is shown as context — not added to your food budget.";
    body.appendChild(sub(netMsg));
    return;
  }

  // ---- Nutrition / All scope
  if (HOME.chart === "line") {
    body.appendChild(lineChart(nutSeries, goals.kcal, RC.nutrition));
    body.appendChild(htmlRow(`Avg intake <b>${fmt(s.avg_in_kcal)} kcal</b>`, `Goal <b>${fmt(goals.kcal)}</b>`));
    return;
  }
  // In the All view, if the user opted weight in, add a weight stat tile to the ring card itself
  // (matching the kcal/protein/fiber tiles) so weight reads as part of the combined stats.
  const wTile = (HOME.scope === "all" && M.show_weight_in_feed && M.body_weight_kg)
    ? weightTile(Math.round(M.body_weight_kg * 2.2046226))
    : "";
  body.appendChild(statRing(s.in, goals, { days, netBurn: applyNet ? burnKcal : 0, extraTiles: wTile }));
  if (HOME.chart === "hybrid" && nutSeries.length > 1) body.appendChild(sparkBars(nutSeries));
  if (applyNet) {
    const base = (goals.kcal || 0) * days, eff = base + burnKcal, left = eff - inKcal;
    body.appendChild(sub(`Budget ${fmt(base)} + ${fmt(burnKcal)} burned = ${fmt(eff)} · eaten ${fmt(inKcal)} → ${fmt(Math.abs(Math.round(left)))} ${left >= 0 ? "left" : "over"}`));
  } else if (HOME.scope === "all") {
    body.appendChild(inOutSub(inKcal, out.kcal));
  } else {
    body.appendChild(sub(`${s.range === "day" ? "Today" : "This " + s.range} · ring tracks ${METRIC[modeOf().primary].label} vs goal`));
  }
}
const sub = (text) => { const d = document.createElement("div"); d.className = "subline"; d.textContent = text; return d; };
function htmlRow(a, b) { const d = document.createElement("div"); d.className = "avgrow"; d.innerHTML = `<span>${a}</span><span>${b}</span>`; return d; }

// ============================================================ feed (cursor + scope + day groups)
const FEED = { cursor: null, done: false, loading: false, lastDay: null, seq: 0 };

async function loadFeed(reset) {
  if (FEED.loading) return;
  const ul = $("#feed");
  if (reset) { FEED.cursor = null; FEED.done = false; FEED.lastDay = null; FEED.seq++; ul.innerHTML = ""; }
  if (FEED.done) return;
  const seq = FEED.seq;
  FEED.loading = true;
  try {
    const qs = "/api/feed?limit=40&scope=" + HOME.scope + (FEED.cursor ? "&before=" + encodeURIComponent(FEED.cursor) : "");
    const r = await api(qs);
    if (seq !== FEED.seq) return; // a reset happened mid-flight
    appendFeed(r.entries || []);
    FEED.cursor = r.next;
    if (!r.next) FEED.done = true;
    if (reset && !ul.children.length) {
      ul.innerHTML = '<li class="hint" style="color:var(--muted);font-size:13px;padding:10px 2px">Nothing logged yet — tap <b>+ Add to log</b>.</li>';
      FEED.done = true;
    }
  } catch (_) { /* keep whatever is already shown */ }
  finally { if (seq === FEED.seq) FEED.loading = false; }
  // Backfill until the page fills the screen so scrolling can begin.
  if (!FEED.done && document.body.offsetHeight <= window.innerHeight + 200) loadFeed(false);
}

function appendFeed(entries) {
  const ul = $("#feed");
  entries.forEach((en) => {
    const key = localDayKey(en.logged_at);
    if (key !== FEED.lastDay) { FEED.lastDay = key; ul.appendChild(dayDivider(en.logged_at)); }
    ul.appendChild(feedRow(en, {
      onEdit: (e) => openView("editentry", e),
      onDelete: (e) => deleteEntry(e.id),
      // onClick defaults to onEdit inside feedRow.
    }));
  });
}

async function deleteEntry(id) {
  try { await api("/api/entries/" + id, { method: "DELETE" }); toast("Deleted"); render(); }
  catch (e) { toast(e.message); }
}

// ============================================================ one-time control wiring
// The scope/range/chart segmented controls + the add button are static markup in index.html; wire
// them once at module load (module scripts are deferred, so the DOM is ready).
function segControl(sel, key, after) {
  const root = $(sel);
  if (!root) return;
  root.addEventListener("click", (ev) => {
    const btn = ev.target.closest("button");
    if (!btn || !btn.dataset[key]) return;
    $$(sel + " button").forEach((b) => b.classList.remove("on"));
    btn.classList.add("on");
    HOME[key] = btn.dataset[key];
    after();
  });
}
// Scope changes both the stat card and the feed → full re-render. Range/chart re-render stats only.
segControl("#scope", "scope", render);
segControl("#range", "range", () => api("/api/stats?range=" + HOME.range).then(renderStats).catch(() => {}));
segControl("#charts", "chart", () => api("/api/stats?range=" + HOME.range).then(renderStats).catch(() => {}));

const addBtn = $("#addBtn");
if (addBtn) addBtn.addEventListener("click", () =>
  openView("compose", { scope: HOME.scope === "activity" ? "activity" : "nutrition" }));

// Infinite scroll: pull the next page as the user nears the bottom of the Home feed.
window.addEventListener("scroll", () => {
  const home = $("#view-home");
  if (!home || home.hidden || HOME.scope === "weight") return;
  if (window.innerHeight + window.scrollY >= document.body.offsetHeight - 500) loadFeed(false);
}, { passive: true });

// ============================================================ register with the router
registerView("home", { container: "#view-home", render });

// Expose a couple of hooks other views may call after they mutate data (e.g. compose after logging,
// editentry after saving) so Home refreshes without the user re-tapping the tab.
export { render };
