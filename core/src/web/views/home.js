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
  statRing, ringEl, lineChart, sparkBars, feedRow, dayDivider, tripleRingCard,
  fmt, modeOf, METRIC, RC, localDayKey, weighInEdit, weighInDelete, dayLabel, todayISO,
} from "../lib.js";
import {
  timelineWindow, expandWindow, groupByDay, dayHeading, displayFields, plannedState, itemKey,
} from "../planner.js";

// View-local UI state (mirrors v1 HOME): which slice + window + chart the dashboard is showing.
const HOME = { scope: "all", range: "day", chart: "ring", weight: null };

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
  let stats, wp = null;
  try {
    // The All view's 3-ring hero needs weight too, so fetch it alongside stats (day window is enough
    // for the current weight + primary goal). Other scopes skip it.
    [stats, wp] = await Promise.all([
      api("/api/stats?range=" + HOME.range),
      HOME.scope === "all" ? api("/api/weight?range=day").catch(() => null) : Promise.resolve(null),
    ]);
  } catch (e) { toast(e.message); return; }
  HOME.weight = wp;
  renderStats(stats);
  $("#feedlbl").textContent = "Timeline";
  initTimeline();
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
  const burnGoal = (goals.burn || 0) * days; // daily calorie-burn goal, scaled to the window
  if (HOME.scope === "activity") {
    if (HOME.chart === "line") {
      body.appendChild(lineChart(actSeries, goals.burn || 0, RC.activity));
      body.appendChild(htmlRow(`Avg burn <b>${fmt(s.avg_out_kcal)} cal</b>`,
        burnGoal ? `Goal <b>${fmt(goals.burn)}/day</b>` : `Total <b>${fmt(out.kcal)}</b>`));
      return;
    }
    const pct = Math.min(100, Math.round((out.kcal / (burnGoal || 500 * days)) * 100));
    const caption = burnGoal ? "of " + fmt(burnGoal) + " cal" : "cal burned";
    const extra = `<div class="kpis"><div class="kpi"><b>${fmt(out.minutes)}</b><span>active min</span></div>` +
      `<div class="kpi"><b>${fmt(out.workouts)}</b><span>workouts</span></div></div>`;
    body.appendChild(ringEl(out.kcal, caption, pct, RC.activity, extra, "a"));
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

  // ---- All scope: the 3-ring hero (nutrition intake, activity burn, weight journey vs each goal).
  if (HOME.scope === "all") {
    const kcalGoal = (goals.kcal || 0) * days;
    const items = [
      { key: "n", color: "var(--brand)", label: "Nutrition", value: inKcal, goal: kcalGoal, unit: "kcal", pct: kcalGoal ? inKcal / kcalGoal : 0 },
      { key: "a", color: "var(--activity)", label: "Activity", value: out.kcal, goal: burnGoal, unit: "cal", pct: burnGoal ? out.kcal / burnGoal : 0 },
    ];
    const wp = HOME.weight;
    if (wp && (wp.current_lb || (wp.goals || []).length)) {
      const g0 = (wp.goals || [])[0], cur = wp.current_lb || 0;
      let wpct = 0;
      if (g0 && g0.start_lb && g0.target_lb && g0.start_lb !== g0.target_lb) {
        wpct = Math.max(0, Math.min(1, (g0.start_lb - cur) / (g0.start_lb - g0.target_lb)));
      }
      items.push({ key: "w", color: "var(--weight)", label: "Weight", value: cur, goal: g0 ? g0.target_lb : 0, unit: "lb", pct: wpct });
    }
    body.appendChild(tripleRingCard(items));
    if (HOME.chart === "hybrid" && nutSeries.length > 1) body.appendChild(sparkBars(nutSeries));
    if (applyNet) {
      const base = (goals.kcal || 0) * days, eff = base + burnKcal, left = eff - inKcal;
      body.appendChild(sub(`Budget ${fmt(base)} + ${fmt(burnKcal)} burned = ${fmt(eff)} · eaten ${fmt(inKcal)} → ${fmt(Math.abs(Math.round(left)))} ${left >= 0 ? "left" : "over"}`));
    } else {
      body.appendChild(sub(`net ${fmt(Math.round(inKcal - out.kcal))} kcal · ${s.range === "day" ? "today" : "this " + s.range}`));
    }
    return;
  }

  // ---- Nutrition scope: single mode-aware ring.
  body.appendChild(statRing(s.in, goals, { days, netBurn: applyNet ? burnKcal : 0 }));
  if (HOME.chart === "hybrid" && nutSeries.length > 1) body.appendChild(sparkBars(nutSeries));
  if (applyNet) {
    const base = (goals.kcal || 0) * days, eff = base + burnKcal, left = eff - inKcal;
    body.appendChild(sub(`Budget ${fmt(base)} + ${fmt(burnKcal)} burned = ${fmt(eff)} · eaten ${fmt(inKcal)} → ${fmt(Math.abs(Math.round(left)))} ${left >= 0 ? "left" : "over"}`));
  } else {
    body.appendChild(sub(`${s.range === "day" ? "Today" : "This " + s.range} · ring tracks ${METRIC[modeOf().primary].label} vs goal`));
  }
}
const sub = (text) => { const d = document.createElement("div"); d.className = "subline"; d.textContent = text; return d; };
function htmlRow(a, b) { const d = document.createElement("div"); d.className = "avgrow"; d.innerHTML = `<span>${a}</span><span>${b}</span>`; return d; }

// ============================================================ timeline (merged /api/timeline)
// Home's feed IS the merged timeline (spec §4.3): logged actuals + planned one-offs + projected
// occurrences over a window around today, newest-future at the top scrolling DOWN into the past.
// HONESTY: this list is NEVER summed. The stat card reads /api/stats (server, planned-excluded);
// planned/occurrence rows carry no totals of their own. Accepting a row (Task 5) refreshes totals
// from the server, never from this array.
const TL = { win: null, byKey: new Map(), loading: false, seq: 0, today: null, reachedPast: false, reachedFuture: false };

function initTimeline() {
  TL.today = todayISO();
  TL.win = timelineWindow(TL.today);
  TL.byKey = new Map();
  TL.reachedPast = false;
  TL.reachedFuture = false;
  TL.seq++;
  $("#feed").innerHTML = "";
  loadSlice(TL.win.from, TL.win.to, TL.seq).then(() => {
    renderTimeline();
    // Center Today on open (BE ledger pattern): bring the "Today" divider to the top of the viewport.
    const today = $('#feed [data-day="' + TL.today + '"]');
    if (today && typeof today.scrollIntoView === "function") today.scrollIntoView({ block: "start" });
  });
}

// Fetch a [from,to] slice and merge into TL.byKey (keyed → idempotent; overlapping windows dedupe).
async function loadSlice(from, to, seq) {
  if (TL.loading) return;
  TL.loading = true;
  try {
    const r = await api("/api/timeline?scope=" + HOME.scope + "&from=" + from + "&to=" + to);
    if (seq !== TL.seq) return; // a scope change / reset happened mid-flight
    for (const it of r.items || []) TL.byKey.set(itemKey(it), it);
  } catch (_) { /* keep whatever is already shown */ }
  finally { if (seq === TL.seq) TL.loading = false; }
}

// Rebuild #feed from TL.byKey, preserving scroll position by anchoring on the element under the
// viewport top (prepending future content above the fold must not jump the view).
function renderTimeline() {
  const ul = $("#feed");
  const anchor = anchorInfo(ul);
  const groups = groupByDay([...TL.byKey.values()]); // descending: future day → today → past day
  ul.innerHTML = "";
  if (!groups.length) {
    ul.innerHTML = '<li class="hint" style="color:var(--muted);font-size:13px;padding:10px 2px">Nothing here yet — <b>Log</b> what you ate or <b>Plan</b> an event.</li>';
    return;
  }
  for (const g of groups) {
    const divider = dayDivider(g.items[0].logged_at);
    // Prefer the pure relative heading; fall back to lib.dayLabel's absolute format.
    const rel = dayHeading(g.day, TL.today);
    if (rel) { const span = divider.querySelector("span"); if (span) span.textContent = rel; }
    divider.dataset.day = g.day;
    ul.appendChild(divider);
    for (const it of g.items) ul.appendChild(timelineRowEl(it));
  }
  restoreAnchor(ul, anchor);
}

// One timeline row: a logged stored entry uses the existing swipe feedRow; planned items (one-off
// entries + occurrences) get the ghosted accept row (Task 5). Until Task 5, planned rows fall back to
// a plain read-only feedRow so the merge is verifiable on its own.
function timelineRowEl(it) {
  if (it.state === "logged" && it.origin === "entry") {
    return feedRow(it, { onEdit: (e) => openView("editentry", e), onDelete: (e) => deleteEntry(e.id) });
  }
  return feedRow(it, {}); // TEMP (Task 5 replaces with plannedRowEl)
}

async function deleteEntry(id) {
  try { await api("/api/entries/" + id, { method: "DELETE" }); toast("Deleted"); render(); }
  catch (e) { toast(e.message); }
}

// ---- scroll-anchor preservation (keep the viewport steady across a re-render) ----
function anchorInfo(ul) {
  const kids = Array.from(ul.children);
  for (const node of kids) {
    const r = node.getBoundingClientRect();
    if (r.bottom > 0) return { day: node.dataset ? node.dataset.day : null, top: r.top };
  }
  return null;
}
function restoreAnchor(ul, anchor) {
  if (!anchor || !anchor.day) return;
  const el2 = ul.querySelector('[data-day="' + anchor.day + '"]');
  if (!el2) return;
  const delta = el2.getBoundingClientRect().top - anchor.top;
  if (delta) window.scrollBy(0, delta);
}

// ---- bidirectional infinite scroll: near the top → more future; near the bottom → more past ----
async function extendFuture() {
  if (TL.loading || TL.reachedFuture) return;
  const oldTo = TL.win.to;
  TL.win = expandWindow(TL.win, "future");
  const before = TL.byKey.size;
  await loadSlice(addDays1(oldTo), TL.win.to, TL.seq);
  if (TL.byKey.size === before) TL.reachedFuture = true; // no new items → stop asking (bounded)
  renderTimeline();
}
async function extendPast() {
  if (TL.loading || TL.reachedPast) return;
  const oldFrom = TL.win.from;
  TL.win = expandWindow(TL.win, "past");
  const before = TL.byKey.size;
  await loadSlice(TL.win.from, addDays1(oldFrom, -1), TL.seq);
  if (TL.byKey.size === before) TL.reachedPast = true;
  renderTimeline();
}
const addDays1 = (ymd, n = 1) => new Date(Date.parse(ymd + "T00:00:00Z") + n * 86400000).toISOString().slice(0, 10);

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

// Bidirectional infinite scroll: near the top loads more future, near the bottom loads more past.
window.addEventListener("scroll", () => {
  const home = $("#view-home");
  if (!home || home.hidden || HOME.scope === "weight") return;
  if (window.scrollY <= 400) extendFuture();                                              // near top → future
  else if (window.innerHeight + window.scrollY >= document.body.offsetHeight - 500) extendPast(); // near bottom → past
}, { passive: true });

// ============================================================ register with the router
registerView("home", { container: "#view-home", render });

// Expose a couple of hooks other views may call after they mutate data (e.g. compose after logging,
// editentry after saving) so Home refreshes without the user re-tapping the tab.
export { render };
