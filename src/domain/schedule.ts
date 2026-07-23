// Sate core — PURE recurrence projector. Given schedules + overrides and a window, produce the
// (never-stored) OCCURRENCES that fall in [fromDate, toDate]. This is the riskiest logic in the
// Planner, so it is a pure/deterministic function: NO Date.now() and NO no-arg new Date() inside —
// the caller injects `todayLocal` (the user's local YYYY-MM-DD). That makes it unit-testable in
// isolation (no HTTP, no ports) and matches the repo's tz-aware, server-authoritative day model.
// Adapted from BalanceEngine's occurrences.ts projector, trimmed to Sate's daily/weekly/monthly.
//
// This module imports NOTHING. Its input interfaces mirror the Zod schemas in ../schema (PlanSchedule,
// PlanOverride) field-for-field; the routes read schema-typed docs and pass them here, and tsc verifies
// structural assignability at those call sites — so the two definitions cannot drift silently.

export type ScheduleKind = "food" | "activity";
export type RecurrenceUnit = "daily" | "weekly" | "monthly";
export type SchedulePayload = Record<string, unknown>;

export interface ScheduleRecurrence {
  unit: RecurrenceUnit;
  interval: number;        // >= 1 ("every 2 weeks" = weekly / 2)
  by_weekday?: number[];   // 0..6 (Sun..Sat), weekly only
  day_of_month?: number;   // 1..31, monthly only
}

export interface PlanSchedule {
  id: string;
  user: string;
  kind: ScheduleKind;
  name: string;
  payload: SchedulePayload;
  recurrence: ScheduleRecurrence;
  time_of_day: string;     // "HH:mm" local wall-clock
  tz_offset_min: number;   // JS getTimezoneOffset() minutes
  active_from: string;     // YYYY-MM-DD
  active_to?: string;      // YYYY-MM-DD (open-ended if absent)
  is_active: boolean;
  created_at?: string;
  updated_at?: string;
}

export interface PlanOverride {
  id: string;
  user: string;
  schedule_id: string;
  scheduled_date: string;  // YYYY-MM-DD (the occurrence being overridden)
  is_skipped?: boolean;    // "delete just this one"
  new_time?: string;       // "HH:mm" — "edit just this one" moved time
  new_payload?: SchedulePayload; // "edit just this one" changed content
  created_at?: string;
}

export interface Occurrence {
  id: string;              // "{scheduleId}:{date}" — the occurrence identity (mirrors BE)
  schedule_id: string;
  scheduled_date: string;  // YYYY-MM-DD
  kind: ScheduleKind;
  name: string;
  payload: SchedulePayload; // override new_payload applied
  time_of_day: string;      // override new_time applied
  logged_at: string;        // ISO UTC of the local wall-clock instant
  day: string;              // local calendar day (== scheduled_date)
  is_overridden: boolean;   // a new_time/new_payload override was applied
}

// ---- pure date-string helpers (UTC-anchored; deterministic; no tz, no Date.now) ----------
const MS_DAY = 86_400_000;
// A YYYY-MM-DD as a stable UTC-midnight epoch anchor for calendar arithmetic.
function ymdToUTC(s: string): number { return Date.parse(s + "T00:00:00Z"); }
function utcToYMD(ms: number): string { return new Date(ms).toISOString().slice(0, 10); }
function addDays(ymd: string, n: number): string { return utcToYMD(ymdToUTC(ymd) + n * MS_DAY); }
// Whole days between two calendar dates (b - a).
function daysBetween(a: string, b: string): number { return Math.round((ymdToUTC(b) - ymdToUTC(a)) / MS_DAY); }
// Weekday 0..6 (Sun..Sat) of a calendar date, via its UTC anchor.
function weekdayOf(ymd: string): number { return new Date(ymdToUTC(ymd)).getUTCDay(); }
// Days in a calendar month (year, month0 = 0..11). Handles leap years.
function daysInMonth(year: number, month0: number): number { return new Date(Date.UTC(year, month0 + 1, 0)).getUTCDate(); }

// Compute logged_at (ISO UTC) for a local wall-clock (date + "HH:mm") in a tz whose getTimezoneOffset
// is `tzOffsetMin`. Inverse of helpers.dayKey: dayKey(localInstantUTC(d,t,tz), tz) === d by construction
// (dayKey subtracts tz*60000 to go UTC→local; we add it to go local→UTC).
export function localInstantUTC(date: string, time: string, tzOffsetMin: number): string {
  const [h, m] = String(time || "00:00").split(":").map((x) => Number(x) || 0);
  const localAsUTC = ymdToUTC(date) + (h * 60 + m) * 60_000;
  return new Date(localAsUTC + (Number(tzOffsetMin) || 0) * 60_000).toISOString();
}

// Does a schedule fire on the given calendar date? (Date is already known to be within active bounds.)
function firesOn(s: PlanSchedule, unit: RecurrenceUnit, interval: number, d: string): boolean {
  switch (unit) {
    case "daily": {
      const diff = daysBetween(s.active_from, d);
      return diff >= 0 && diff % interval === 0;
    }
    case "weekly": {
      const days = s.recurrence.by_weekday && s.recurrence.by_weekday.length
        ? s.recurrence.by_weekday
        : [weekdayOf(s.active_from)];
      if (!days.includes(weekdayOf(d))) return false;
      if (interval === 1) return true;
      const weeks = Math.floor(daysBetween(s.active_from, d) / 7);
      return weeks >= 0 && weeks % interval === 0;
    }
    case "monthly": {
      const y = Number(d.slice(0, 4));
      const m0 = Number(d.slice(5, 7)) - 1;
      const ay = Number(s.active_from.slice(0, 4));
      const am0 = Number(s.active_from.slice(5, 7)) - 1;
      const monthsDiff = (y - ay) * 12 + (m0 - am0);
      if (monthsDiff < 0 || monthsDiff % interval !== 0) return false;
      const wantDom = Math.max(1, Math.floor(Number(s.recurrence.day_of_month) || Number(s.active_from.slice(8, 10))));
      const firingDom = Math.min(wantDom, daysInMonth(y, m0)); // day 31 → last day of a shorter month
      return Number(d.slice(8, 10)) === firingDom;
    }
    default:
      return false;
  }
}

export function projectOccurrences(
  schedules: PlanSchedule[],
  overrides: PlanOverride[],
  fromDate: string,
  toDate: string,
  todayLocal: string,
): Occurrence[] {
  // Future-only rule: never project a recurring occurrence before the user's local today.
  const start = fromDate < todayLocal ? todayLocal : fromDate;
  const out: Occurrence[] = [];
  if (start > toDate) return out;

  // Index overrides by "{scheduleId}:{date}" — the occurrence identity.
  const ovByKey = new Map<string, PlanOverride>();
  for (const o of overrides) ovByKey.set(`${o.schedule_id}:${o.scheduled_date}`, o);

  for (const s of schedules) {
    if (!s.is_active) continue;
    const unit = s.recurrence?.unit;
    const interval = Math.max(1, Math.floor(Number(s.recurrence?.interval) || 1));
    // Intersect the request window with the schedule's active range.
    let d = s.active_from > start ? s.active_from : start;
    const end = s.active_to && s.active_to < toDate ? s.active_to : toDate;
    for (; d <= end; d = addDays(d, 1)) {
      if (d < s.active_from) continue;             // before the schedule began
      if (!firesOn(s, unit, interval, d)) continue;

      const o = ovByKey.get(`${s.id}:${d}`);
      if (o?.is_skipped) continue;                      // "delete just this one"
      const overridden = !!(o && (o.new_time || o.new_payload));
      const time = o?.new_time || s.time_of_day || "00:00";
      const payload = o?.new_payload ?? s.payload ?? {};
      out.push({
        id: `${s.id}:${d}`,
        schedule_id: s.id,
        scheduled_date: d,
        kind: s.kind,
        name: s.name,
        payload,
        time_of_day: time,
        logged_at: localInstantUTC(d, time, s.tz_offset_min),
        day: d,
        is_overridden: overridden,
      });
    }
  }
  // Chronological, ties broken by schedule id for determinism.
  out.sort((a, b) =>
    a.logged_at < b.logged_at ? -1 : a.logged_at > b.logged_at ? 1 : a.schedule_id.localeCompare(b.schedule_id));
  return out;
}
