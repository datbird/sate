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

// Build the intended-content object shared by a one-off planned entry (spread top-level) and a
// schedule (nested under `payload`). Matches the API: food → kcal + macros (+ items/note); activity →
// kcal(burn) + duration_min (+ distance/intensity/note).
function contentOf(form, kind) {
  const c = { kcal: num(form.kcal) };
  if (form.note != null && form.note !== "") c.note = String(form.note);
  if (kind === "activity") {
    c.duration_min = num(form.duration_min);
    if (form.distance != null && form.distance !== "") c.distance = num(form.distance);
    if (form.intensity) c.intensity = String(form.intensity);
  } else {
    const m = form.macros || {};
    c.macros = {
      protein: num(m.protein), carbs: num(m.carbs), fat: num(m.fat),
      fiber: num(m.fiber), sugar: num(m.sugar), sodium: num(m.sodium), sat_fat: num(m.sat_fat),
    };
    if (Array.isArray(form.items) && form.items.length) c.items = form.items;
  }
  return c;
}

// Map the plan-an-event form to the exact API call. repeat "none" → a one-off planned entry
// (POST /api/plan/entry, logged_at = local instant in UTC); any repeat → a recurring schedule
// (POST /api/plan/schedules) whose occurrences the timeline projects. Pure — no fetch, no Date.now().
export function buildPlanRequest(form, tzOffsetMin) {
  const kind = form.kind === "activity" ? "activity" : "food";
  const tz = Number(tzOffsetMin) || 0;
  const time = form.time || "12:00";
  const date = form.date;
  const content = contentOf(form, kind);

  if (form.repeat && form.repeat !== "none") {
    const recurrence = { unit: form.repeat, interval: Math.max(1, Number(form.interval) || 1) };
    if (form.repeat === "weekly" && Array.isArray(form.by_weekday) && form.by_weekday.length) {
      recurrence.by_weekday = form.by_weekday.slice();
    }
    if (form.repeat === "monthly" && form.day_of_month) {
      recurrence.day_of_month = Number(form.day_of_month);
    }
    return {
      method: "POST", path: "/api/plan/schedules",
      body: {
        kind,
        name: form.name || form.description || (kind === "activity" ? "Activity" : "Meal"),
        payload: content,
        recurrence,
        time_of_day: time,
        tz_offset_min: tz,
        active_from: date,
        is_active: true,
      },
    };
  }

  const body = {
    kind,
    description: form.description || form.name || "",
    logged_at: localInstantUTC(date, time, tz),
    tz_offset_min: tz,
    ...content, // one-off entry carries content top-level (POST /api/plan/entry reads b.kcal/b.macros/...)
  };
  return { method: "POST", path: "/api/plan/entry", body };
}

// ============================================================ Plan-tab pure helpers (phase 4)
// Weekday labels (0..6 = Sun..Sat), matching the projector's getUTCDay() convention.
const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// "HH:mm" (24h) → a friendly "7:30am" / "12:00pm" / "12:00am". Returns "" for a missing/blank time.
function prettyTime(time) {
  if (!time) return "";
  const [h, m] = String(time).split(":").map((x) => Number(x));
  if (!isFinite(h)) return "";
  const ap = h < 12 ? "am" : "pm";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return h12 + ":" + String(m || 0).padStart(2, "0") + ap;
}

// A human recurrence summary for the Plan tab's Scheduled rows: "Every weekday · 7:30am",
// "Every day · 6:00pm", "Weekly on Mon, Wed, Fri · 6:00am", "Monthly on day 15 · 12:00pm".
// Pure — reads only the schedule's recurrence/time_of_day/active_from.
export function recurrenceSummary(schedule) {
  const r = (schedule && schedule.recurrence) || {};
  const iv = Math.max(1, Number(r.interval) || 1);
  let base = "";
  if (r.unit === "daily") {
    base = iv === 1 ? "Every day" : "Every " + iv + " days";
  } else if (r.unit === "weekly") {
    const wd = Array.isArray(r.by_weekday) ? r.by_weekday.slice().sort((a, b) => a - b) : [];
    const isWeekday = wd.length === 5 && [1, 2, 3, 4, 5].every((x) => wd.includes(x));
    if (isWeekday) {
      base = iv === 1 ? "Every weekday" : "Every " + iv + " weeks on weekdays";
    } else {
      const label = wd.length ? wd.map((d) => DOW[d]).join(", ") : "week";
      base = iv === 1 ? "Weekly on " + label : "Every " + iv + " weeks on " + label;
    }
  } else if (r.unit === "monthly") {
    const dom = Number(r.day_of_month) || Number(String(schedule.active_from || "").slice(8, 10)) || 1;
    base = (iv === 1 ? "Monthly on day " : "Every " + iv + " months on day ") + dom;
  }
  const t = prettyTime(schedule && schedule.time_of_day);
  return t ? (base ? base + " · " + t : t) : base;
}

// --- next-occurrence: a MIRROR of domain/schedule.ts firesOn + active-bounds, kept here as the
// client copy (planner.js imports nothing). Same date math as the server projector, so the "Next: …"
// label on a Scheduled row matches the timeline exactly. Deterministic — todayLocal is passed in.
const _daysBetween = (a, b) => Math.round((ymdToUTC(b) - ymdToUTC(a)) / MS_DAY);
const _weekdayOf = (ymd) => new Date(ymdToUTC(ymd)).getUTCDay();
const _daysInMonth = (y, m0) => new Date(Date.UTC(y, m0 + 1, 0)).getUTCDate();

function firesOn(schedule, d) {
  const r = schedule.recurrence || {};
  const unit = r.unit;
  const interval = Math.max(1, Math.floor(Number(r.interval) || 1));
  if (unit === "daily") {
    const diff = _daysBetween(schedule.active_from, d);
    return diff >= 0 && diff % interval === 0;
  }
  if (unit === "weekly") {
    const days = Array.isArray(r.by_weekday) && r.by_weekday.length ? r.by_weekday : [_weekdayOf(schedule.active_from)];
    if (!days.includes(_weekdayOf(d))) return false;
    if (interval === 1) return true;
    const weeks = Math.floor(_daysBetween(schedule.active_from, d) / 7);
    return weeks >= 0 && weeks % interval === 0;
  }
  if (unit === "monthly") {
    const y = Number(d.slice(0, 4)), m0 = Number(d.slice(5, 7)) - 1;
    const ay = Number(schedule.active_from.slice(0, 4)), am0 = Number(schedule.active_from.slice(5, 7)) - 1;
    const monthsDiff = (y - ay) * 12 + (m0 - am0);
    if (monthsDiff < 0 || monthsDiff % interval !== 0) return false;
    const want = Math.max(1, Math.floor(Number(r.day_of_month) || Number(schedule.active_from.slice(8, 10))));
    return Number(d.slice(8, 10)) === Math.min(want, _daysInMonth(y, m0));
  }
  return false;
}

// The first calendar date >= todayLocal (and within active bounds, honoring skip overrides) on which
// the schedule fires, or null if none within a bounded 366-day forward window. Pure/deterministic.
export function nextOccurrence(schedule, todayLocal, overrides = []) {
  if (!schedule || !schedule.is_active) return null;
  const skip = new Set(
    (overrides || [])
      .filter((o) => o && o.is_skipped && o.schedule_id === schedule.id)
      .map((o) => o.scheduled_date),
  );
  let d = schedule.active_from > todayLocal ? schedule.active_from : todayLocal;
  const end = schedule.active_to && schedule.active_to < addDays(todayLocal, 366)
    ? schedule.active_to
    : addDays(todayLocal, 366);
  for (; d <= end; d = addDays(d, 1)) {
    if (d < schedule.active_from) continue;
    if (firesOn(schedule, d) && !skip.has(d)) return d;
  }
  return null;
}
