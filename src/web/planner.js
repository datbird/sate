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
