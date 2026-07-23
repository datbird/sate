// Sate v2 SPA — PURE planner web helpers. This module imports NOTHING and touches NO DOM, so it is
// unit-tested directly by the esbuild + node:test harness (core/test/planner-ui.test.ts) — the same
// treatment as the backend's domain/schedule.ts. The riskiest UI logic (window math, day grouping,
// the ghosted/accept-state decision, entry-vs-occurrence display normalization, and the plan-an-event
// request builder) lives here so the DOM glue in views/home.js and views/planevent.js stays trivial.
//
// Determinism: the date helpers take an explicit todayLocal/tz — NO Date.now(), NO no-arg new Date().
// (new Date(<explicit ms/UTC>) and Date.parse(<string>) are deterministic and allowed.) Do NOT import
// lib.js here: lib.js runs a window.visualViewport IIFE at module load and would crash under node.

"use strict";

const MS_DAY = 86_400_000;
const ymdToUTC = (s) => Date.parse(String(s) + "T00:00:00Z");
const utcToYMD = (ms) => new Date(ms).toISOString().slice(0, 10);

// Calendar add on a YYYY-MM-DD (UTC-anchored → no tz/DST drift on the date string).
export function addDays(ymd, n) { return utcToYMD(ymdToUTC(ymd) + (Number(n) || 0) * MS_DAY); }

// Local wall-clock (date + "HH:mm") in a tz whose getTimezoneOffset() is tzOffsetMin, as an ISO UTC
// instant. Inverse of the server's helpers.dayKey (dayKey subtracts tz*60000 to go UTC→local; we add
// it to go local→UTC), so dayKey(localInstantUTC(d,t,tz), tz) === d by construction. Mirrors
// domain/schedule.localInstantUTC — kept here as the client copy (planner.js imports nothing).
export function localInstantUTC(date, time, tzOffsetMin) {
  const [h, m] = String(time || "00:00").split(":").map((x) => Number(x) || 0);
  const localAsUTC = ymdToUTC(date) + (h * 60 + m) * 60_000;
  return new Date(localAsUTC + (Number(tzOffsetMin) || 0) * 60_000).toISOString();
}

// The initial today-centered window: past days below "Today", future days above it (see groupByDay).
export function timelineWindow(todayLocal, pastDays = 7, futureDays = 14) {
  return { from: addDays(todayLocal, -Math.abs(pastDays)), to: addDays(todayLocal, Math.abs(futureDays)) };
}

// Extend the window as the user scrolls: "future" grows `to` (scroll UP toward more planned events),
// "past" grows `from` (scroll DOWN toward older logged actuals). Pure — the DOM decides the direction.
export function expandWindow(win, direction, step = 14) {
  const s = Math.abs(step);
  if (direction === "future") return { from: win.from, to: addDays(win.to, s) };
  if (direction === "past") return { from: addDays(win.from, -s), to: win.to };
  return { from: win.from, to: win.to };
}

// Group timeline items into day buckets. Default order is DESCENDING — the Home timeline shows the
// furthest-future day at the top and scrolls DOWN into the past (spec §4.3: scroll up = more future).
// Within a day, items are ordered newest-first too. Grouping keys on the item's server-provided `day`
// (YYYY-MM-DD), falling back to logged_at's date, so no tz/Date parsing is needed here.
export function groupByDay(items, opts = {}) {
  const desc = opts.descending !== false;
  const map = new Map();
  for (const it of items || []) {
    const day = it.day || String(it.logged_at || "").slice(0, 10);
    if (!day) continue;
    if (!map.has(day)) map.set(day, []);
    map.get(day).push(it);
  }
  const days = [...map.keys()].sort(); // ascending YYYY-MM-DD (lexicographic == chronological)
  if (desc) days.reverse();
  const cmp = (a, b) => {
    const x = String(a.logged_at || ""), y = String(b.logged_at || "");
    const r = x < y ? -1 : x > y ? 1 : 0;
    return desc ? -r : r;
  };
  return days.map((day) => ({ day, items: map.get(day).slice().sort(cmp) }));
}

// Relative-day label for a divider. Returns null for any other day so the caller can format the
// absolute date (lib.dayLabel) — planner.js stays locale/Date-format free.
export function dayHeading(day, todayLocal) {
  if (day === todayLocal) return "Today";
  if (day === addDays(todayLocal, -1)) return "Yesterday";
  if (day === addDays(todayLocal, 1)) return "Tomorrow";
  return null;
}

const num = (v) => { const n = Number(v); return isFinite(n) ? n : 0; };

// Normalize a timeline item's DISPLAY content across the two shapes: a stored `entry` carries content
// top-level (description/kcal/macros/duration_min/...); a projected `occurrence` carries it under
// `payload` with the schedule `name` as its title. The row DOM (Task 5) reads only this — so it never
// has to know which shape it got.
export function displayFields(item) {
  const isOcc = item.origin === "occurrence";
  const p = isOcc ? (item.payload || {}) : item;
  const kind = item.kind || "food";
  const activity = kind === "activity";
  const listed = Array.isArray(p.items) ? p.items.map((i) => i && i.name).filter(Boolean).join(", ") : "";
  const title = (isOcc ? (item.name || p.description) : p.description) || listed || (activity ? "Activity" : "Entry");
  return {
    kind, activity,
    title: String(title),
    kcal: num(p.kcal),
    macros: p.macros || {},
    duration_min: num(p.duration_min),
    distance: p.distance != null ? num(p.distance) : null,
    intensity: p.intensity || "",
    note: p.note || "",
    items: Array.isArray(p.items) ? p.items : [],
  };
}

// The accept body: a planned one-off entry is accepted by id; a projected occurrence is accepted by
// its (schedule_id, scheduled_date) identity. Exactly what POST /api/plan/accept branches on (plan.ts).
export function acceptBody(item) {
  if (item.origin === "occurrence") return { schedule_id: item.schedule_id, scheduled_date: item.scheduled_date };
  return { entry_id: item.id };
}

// The ghosted/badge/accept decision for a timeline row. `planned` iff the server tagged it planned
// (a one-off planned entry OR a projected occurrence). "Ate it" for food, "Did it" for activity.
export function plannedState(item) {
  if (item.state !== "planned") return { planned: false, ghosted: false, badge: null, accept: null };
  const activity = (item.kind || "food") === "activity";
  return {
    planned: true,
    ghosted: true,
    badge: "unconfirmed",
    accept: { label: activity ? "Did it" : "Ate it", body: acceptBody(item) },
  };
}

// A stable render/de-dupe key. Entries and occurrences can never collide (entries are namespaced;
// occurrences use their "{scheduleId}:{date}" synthetic id, which contains a colon an entry id never has).
export function itemKey(item) {
  return item.origin === "occurrence" ? String(item.id) : "entry:" + String(item.id);
}
