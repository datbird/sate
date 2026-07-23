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
  $, $$, api, APP, me, registerView, openView, view, toast, busy,
  statRing, ringEl, lineChart, sparkBars, feedRow, dayDivider, tripleRingCard,
  fmt, modeOf, METRIC, RC, todayISO, timeOf, el, esc,
} from "../lib.js";
import {
  timelineWindow, expandWindow, groupByDay, dayHeading, displayFields, plannedState, itemKey, addDays,
} from "../planner.js";

// View-local UI state (mirrors v1 HOME): which slice + window + chart the dashboard is showing.
const HOME = { scope: "all", range: "day", chart: "ring", weight: null };

// Type glyphs for planned rows (occurrences aren't real entries, so they don't flow through feedRow's
// icon path). Copied from lib's TICON to keep planner rows visually identical to logged rows.
const TL_ICON = {
  n: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3v7a2 2 0 0 0 4 0V3"/><path d="M10 12v9"/><ellipse cx="16" cy="6.4" rx="2.2" ry="3.4"/><path d="M16 9.8V21"/></svg>',
  a: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="13" cy="4" r="1"/><path d="M4 17l5 1 .75-1.5"/><path d="M15 21v-4l-4-3 1-6"/><path d="M7 12V9l5-1 3 3 3 1"/></svg>',
};

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
// emptyPast/emptyFuture: consecutive-empty-slice counters per direction (reset whenever a slice adds
// ≥1 new key). stopPast/stopFuture: latched once EITHER 3 consecutive empty slices land OR the hard
// date bound is hit — never on a single empty slice, so a gap in the data (e.g. two quiet months)
// can't permanently hide older/newer content. minFrom/maxTo are the hard bounds (see initTimeline).
const TL = {
  win: null, byKey: new Map(), loading: false, seq: 0, today: null,
  emptyPast: 0, emptyFuture: 0, stopPast: false, stopFuture: false, minFrom: null, maxTo: null,
};

function initTimeline() {
  TL.today = todayISO();
  TL.win = timelineWindow(TL.today);
  TL.byKey = new Map();
  TL.emptyPast = 0;
  TL.emptyFuture = 0;
  TL.stopPast = false;
  TL.stopFuture = false;
  TL.minFrom = addDays(TL.today, -3 * 365); // don't probe further back than ~3 years
  TL.maxTo = addDays(TL.today, 365);        // don't probe further forward than ~1 year
  TL.seq++;
  $("#feed").innerHTML = "";
  TL.loading = false;
  loadSlice(TL.win.from, TL.win.to, TL.seq).then(() => {
    renderTimeline();
    // Center Today on open (BE ledger pattern): bring the "Today" divider to the top of the viewport.
    const today = $('#feed [data-day="' + TL.today + '"]');
    if (today && typeof today.scrollIntoView === "function") today.scrollIntoView({ block: "start" });
    fillViewportIfNeeded();
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
// entries + occurrences) get the ghosted accept row (Task 5).
function timelineRowEl(it) {
  if (it.state === "logged" && it.origin === "entry") {
    return feedRow(it, { onEdit: (e) => openView("editentry", e), onDelete: (e) => deleteEntry(e.id) });
  }
  return plannedRowEl(it);
}

// A ghosted/dashed planned row: type icon + title/subline + the intended kcal, an "unconfirmed" badge,
// and the accept button. All display data + the accept decision come from the tested pure helpers, so
// this is a trivial template (no jsdom needed to trust it).
function plannedRowEl(it) {
  const d = displayFields(it);
  const st = plannedState(it);
  const timeStr = timeOf(it.logged_at);
  const sub = d.activity
    ? [timeStr, d.duration_min ? Math.round(d.duration_min) + " min" : "", d.intensity, d.note].filter(Boolean).join(" · ")
    : [timeStr, d.note].filter(Boolean).join(" · ");
  const kcalHtml = d.activity
    ? '<span class="ekcal out">−' + fmt(d.kcal) + "<small> cal</small></span>"
    : '<span class="ekcal">' + fmt(d.kcal) + "<small> kcal</small></span>";
  const main = el("div", { class: "entry-main", html:
    '<span class="ticon ' + (d.activity ? "a" : "n") + '">' + TL_ICON[d.activity ? "a" : "n"] + "</span>" +
    '<span class="etext"><span class="t">' + esc(d.title) +
    '<span class="badge-unconfirmed">' + esc(st.badge) + "</span></span>" +
    '<span class="s">' + esc(sub) + "</span></span>" +
    kcalHtml,
  });
  const row = el("div", { class: "entry planned" }, main);
  const acceptBtn = el("button", { class: "accept-btn", type: "button", text: st.accept.label,
    onClick: (ev) => { ev.stopPropagation(); acceptItem(it, row); } });
  row.appendChild(acceptBtn);
  return row;
}

// Manual confirm. POST /api/plan/accept with the pure acceptBody; on success the item becomes logged.
// Totals ALWAYS come from the server — we take the accept response and re-fetch /api/stats; we never
// sum the timeline.
async function acceptItem(it, rowEl) {
  const st = plannedState(it);
  if (!st.accept) return;
  const btn = rowEl.querySelector(".accept-btn");
  if (btn) { btn.disabled = true; btn.textContent = "…"; }
  busy("Confirming…");
  try {
    const r = await api("/api/plan/accept", { method: "POST", json: st.accept.body });
    toast(((it.kind || "food") === "activity") ? "Logged it." : "Marked eaten.");
    // Replace the planned item with the server's materialized/flipped logged entry (keyed de-dupe),
    // then re-render the list and refresh the stat card from the server.
    if (it.origin === "occurrence") TL.byKey.delete(itemKey(it));
    if (r && r.entry) TL.byKey.set(itemKey({ ...r.entry, origin: "entry", state: "logged" }), { ...r.entry, origin: "entry", state: "logged" });
    renderTimeline();
    const stats = await api("/api/stats?range=" + HOME.range).catch(() => null);
    if (stats) renderStats(stats);
  } catch (e) {
    toast(e.message);
    if (btn) { btn.disabled = false; btn.textContent = st.accept.label; }
  }
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
// Each direction stops independently once EITHER 3 consecutive fetched slices add zero new item-keys
// (a real end of data) OR its hard date bound is reached — a single empty slice only means that date
// range is empty, not that no further content exists (see Task 4 review: don't latch on first empty).
async function extendFuture() {
  if (TL.loading || TL.stopFuture) return;
  const oldTo = TL.win.to;
  if (oldTo >= TL.maxTo) { TL.stopFuture = true; return; } // already at the hard bound
  let next = expandWindow(TL.win, "future");
  const hitBound = next.to >= TL.maxTo;
  if (hitBound) next = { from: next.from, to: TL.maxTo }; // clamp to the bound, fetch the final slice
  TL.win = next;
  const before = TL.byKey.size;
  await loadSlice(addDays1(oldTo), TL.win.to, TL.seq);
  if (TL.byKey.size > before) TL.emptyFuture = 0; // got new content → reset the counter
  else TL.emptyFuture++;
  if (hitBound || TL.emptyFuture >= 3) TL.stopFuture = true;
  renderTimeline();
  fillViewportIfNeeded();
}
async function extendPast() {
  if (TL.loading || TL.stopPast) return;
  const oldFrom = TL.win.from;
  if (oldFrom <= TL.minFrom) { TL.stopPast = true; return; } // already at the hard bound
  let next = expandWindow(TL.win, "past");
  const hitBound = next.from <= TL.minFrom;
  if (hitBound) next = { from: TL.minFrom, to: next.to }; // clamp to the bound, fetch the final slice
  TL.win = next;
  const before = TL.byKey.size;
  await loadSlice(TL.win.from, addDays1(oldFrom, -1), TL.seq);
  if (TL.byKey.size > before) TL.emptyPast = 0; // got new content → reset the counter
  else TL.emptyPast++;
  if (hitBound || TL.emptyPast >= 3) TL.stopPast = true;
  renderTimeline();
  fillViewportIfNeeded();
}
const addDays1 = (ymd, n = 1) => new Date(Date.parse(ymd + "T00:00:00Z") + n * 86400000).toISOString().slice(0, 10);

// ---- viewport backfill: a sparse timeline (few logged/planned days) may not fill the screen, which
// leaves the user with no scroll event to trigger further expansion. Mirrors the old feed's "keep
// backfilling until the page fills" behavior. Prefers past first, then future; each call only fires
// one more extend, and extend* re-invokes this after render, so it self-terminates via the same
// counters/bounds as manual scrolling (both directions latched → no-op).
function fillViewportIfNeeded() {
  if (document.body.offsetHeight > window.innerHeight + 200) return; // already fills the viewport
  if (!TL.stopPast) extendPast();
  else if (!TL.stopFuture) extendFuture();
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

const logBtn = $("#logBtn");
if (logBtn) logBtn.addEventListener("click", () =>
  openView("compose", { scope: HOME.scope === "activity" ? "activity" : "nutrition" }));
const planBtn = $("#planBtn");
if (planBtn) planBtn.addEventListener("click", () =>
  openView("planevent", { scope: HOME.scope === "activity" ? "activity" : "nutrition" }));

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
