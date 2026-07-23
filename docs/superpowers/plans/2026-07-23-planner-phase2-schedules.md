# Planner Phase 2 — Schedules + Projection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add recurring plan definitions (`plan_schedules`) and per-occurrence exceptions (`plan_overrides`), a **pure, deterministic occurrence projector** (`projectOccurrences`), the merged `GET /api/timeline`, schedule CRUD + "this-vs-all" occurrence edit/delete, and the occurrence branch of `POST /api/plan/accept` — turning Phase 1's one-off planner into a recurring one, with projected occurrences that (like planned entries) count toward NO total until accepted.

**Architecture:** The riskiest logic — recurrence math — lands in a new **pure** module `core/src/domain/schedule.ts` (sibling to `domain/nutrition.ts`; imports nothing, so the esbuild+`node:test` harness unit-tests it directly with no HTTP). `projectOccurrences(schedules, overrides, fromDate, toDate, todayLocal)` is deterministic: the caller injects `todayLocal`, so there is no `Date.now()`/no-arg `new Date()` inside. Two additive Zod entities go in `core/src/schema/index.ts`. All routes extend the existing `core/src/api/plan.ts` (`registerPlan`). Occurrences are never stored, so they can never enter a total; accepting one **materializes** a `status:"logged"` entry, after which the projector's date is dropped by the timeline route.

**Tech Stack:** TypeScript (Node 24, run via esbuild bundle + native `node:test`), Hono, Zod, the ports/adapters `DataStore` abstraction. No new runtime dependencies. Adapted from BalanceEngine's `occurrences.ts` projector, trimmed to Sate's daily/weekly/monthly recurrence.

## Global Constraints

Copied from the spec (`docs/superpowers/specs/2026-07-23-planner-recipes-coach-plan-design.md`) — every task inherits these:

- **Cloud edition only, core-first.** All schema/logic lands in `@sate/core`. The Hosted (`pb_hooks`/`pb_public`) port is explicitly OUT OF SCOPE.
- **No Cloud migration.** Firestore is schemaless; new collections auto-create and new fields default in. Every new Zod field MUST be optional or defaulted so partial/legacy documents still parse.
- **Additive only.** `plan_schedules` and `plan_overrides` are NEW collections; the Phase 1 `entries` schema (`status`, `plan_schedule_id`, `scheduled_date`) is unchanged and reused as-is.
- **The honesty rule (non-negotiable):** planned entries AND projected occurrences count ZERO toward intake/burn/remaining until accepted. Phase 1 enforces this for stored entries via `isLogged`; occurrences are NEVER stored, so they never reach `dayIntakeTotals`/`/api/stats`. `GET /api/timeline` returns a list only — it computes no totals and must not cause any occurrence/planned item to be counted anywhere.
- **The projector is pure and deterministic.** `core/src/domain/schedule.ts` imports nothing (no ports, no schema, no Firestore). No `Date.now()` and no no-argument `new Date()` inside it — `todayLocal` is injected. `new Date(<explicit ms/UTC parts>)` and `Date.parse(<string>)` are allowed (deterministic). This is what makes it unit-testable in isolation and is the single most important correctness target (spec §12).
- **Future-only rule:** the projector emits only occurrences with `date ≥ todayLocal`. Past un-accepted recurring occurrences never appear. (Explicit one-off *planned entries* in the past still persist — they are stored `entries`, not occurrences — and are surfaced by the timeline's stored-entry branch.)
- **tz model:** `tz_offset_min` follows JS `Date.getTimezoneOffset()` (minutes to ADD to local to get UTC, positive west of UTC), exactly as `helpers.dayKey`. The projector's `localInstantUTC(date, time, tz)` is the inverse of `dayKey`, so `dayKey(occurrence.logged_at, tz) === occurrence.scheduled_date` holds by construction.
- **DRY:** reuse `dayKey` and `dayIntakeTotals` from `api/helpers` and `localInstantUTC` from `domain/schedule` — never re-implement day bucketing, intake summation, or the local→UTC inversion. `once` is NOT a schedule unit — one-offs remain plain planned entries (Phase 1).
- **Typecheck gate:** `cd ~/gitrepos/sate-cloud && npx tsc --noEmit` must stay exit 0 after every task. Tests run via `cd ~/gitrepos/sate/core && npm test`.

---

## File Structure

- **Create `core/src/domain/schedule.ts`** — the pure projector + its structural input/output interfaces (`PlanSchedule`, `PlanOverride`, `ScheduleRecurrence`, `Occurrence`) and the exported `localInstantUTC` + `projectOccurrences`. No imports. Tasks 1–4.
- **Create `core/test/schedule.test.ts`** — projector unit tests (pure, no HTTP). Tasks 1–4.
- **Modify `core/src/schema/index.ts`** — add the `ScheduleRecurrence`, `PlanSchedule`, `PlanOverride` Zod schemas + inferred types (the canonical persisted validators, mirroring the projector's interfaces field-for-field). Task 5.
- **Create `core/test/plan-schema.test.ts`** — Zod parse/default tests for the two new entities. Task 5.
- **Modify `core/src/api/plan.ts`** — extend `registerPlan` with schedule CRUD (Task 6), `GET /api/timeline` (Task 7), occurrence edit/delete (Task 8), and the occurrence branch of `POST /api/plan/accept` (Task 9).
- **Create `core/test/schedules.test.ts`** — schedule CRUD + occurrence edit/delete route tests. Tasks 6, 8.
- **Create `core/test/timeline.test.ts`** — `GET /api/timeline` merge/drop/tag tests. Task 7.
- **Modify `core/test/plan.test.ts`** — replace the Phase 1 "occurrence branch 400s" stub test with real occurrence-accept tests. Task 9.

Note: `core/src/api/index.ts` already mounts `registerPlan` (Phase 1) — no change needed there. `core/package.json` already has the `test` script + `esbuild` devDep (Phase 1) — no change needed there.

**Type-consistency note (read before Task 1):** the projector's input interfaces in `domain/schedule.ts` (Task 1) and the Zod schemas in `schema/index.ts` (Task 5) describe the SAME shape in two forms — a pure structural interface (so the projector is import-free and unit-testable first) and a runtime validator (so writes are checked). Their field names and types MUST stay identical. The timeline/accept routes read docs typed with the **schema** types and pass them to `projectOccurrences` (whose params are the **domain** interfaces); `tsc` verifies structural assignability at those call sites, so any drift between the two definitions fails the typecheck gate.

---

### Task 1: The projector — core loop, daily recurrence, future-only, bounds, logged_at/day/tz

The pure heart of Phase 2. Establishes `domain/schedule.ts` with the input/output types, the deterministic date-string helpers, the exported `localInstantUTC` (reused by the accept route in Task 9), and `projectOccurrences` covering the **daily** unit, the future-only rule, window + `active_from`/`active_to` bounds, and correct `logged_at`/`day`. Weekly/monthly return nothing yet (Tasks 2–3); overrides are ignored yet (Task 4). Verified runnable via the harness before this plan was written.

**Files:**
- Create: `core/src/domain/schedule.ts`
- Create: `core/test/schedule.test.ts`

**Interfaces:**
- Produces:
  - `interface PlanSchedule { id; user; kind: "food"|"activity"; name; payload: Record<string,unknown>; recurrence: ScheduleRecurrence; time_of_day: string; tz_offset_min: number; active_from: string; active_to?: string; is_active: boolean; created_at?: string; updated_at?: string }`
  - `interface ScheduleRecurrence { unit: "daily"|"weekly"|"monthly"; interval: number; by_weekday?: number[]; day_of_month?: number }`
  - `interface PlanOverride { id; user; schedule_id; scheduled_date: string; is_skipped?: boolean; new_time?: string; new_payload?: Record<string,unknown>; created_at?: string }`
  - `interface Occurrence { id: string /* "{scheduleId}:{date}" */; schedule_id: string; scheduled_date: string; kind: "food"|"activity"; name: string; payload: Record<string,unknown>; time_of_day: string; logged_at: string; day: string; is_overridden: boolean }`
  - `function localInstantUTC(date: string, time: string, tzOffsetMin: number): string` — the inverse of `dayKey`.
  - `function projectOccurrences(schedules: PlanSchedule[], overrides: PlanOverride[], fromDate: string, toDate: string, todayLocal: string): Occurrence[]`

- [ ] **Step 1: Write the failing test `core/test/schedule.test.ts`**

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { projectOccurrences, localInstantUTC, type PlanSchedule } from "../src/domain/schedule.ts";

// A minimal daily schedule factory; override fields per test.
function daily(over: Partial<PlanSchedule> = {}): PlanSchedule {
  return {
    id: "s1", user: "u", kind: "food", name: "Oats",
    payload: { kcal: 300, description: "Overnight oats" },
    recurrence: { unit: "daily", interval: 1 },
    time_of_day: "07:30", tz_offset_min: 0,
    active_from: "2026-07-01", is_active: true, ...over,
  };
}

test("daily interval=1 emits one occurrence per day across the window", () => {
  const occ = projectOccurrences([daily()], [], "2026-07-10", "2026-07-13", "2026-07-10");
  assert.deepEqual(occ.map((o) => o.scheduled_date), ["2026-07-10", "2026-07-11", "2026-07-12", "2026-07-13"]);
  assert.equal(occ[0].id, "s1:2026-07-10");
  assert.equal(occ[0].kind, "food");
  assert.equal(occ[0].name, "Oats");
  assert.deepEqual(occ[0].payload, { kcal: 300, description: "Overnight oats" });
  assert.equal(occ[0].is_overridden, false);
});

test("daily interval=3 emits every third day counted from active_from", () => {
  // active_from 2026-07-01; fires on 01,04,07,10,13,16,19,22,25 — window picks 2026-07-10..-19.
  const occ = projectOccurrences([daily({ recurrence: { unit: "daily", interval: 3 } })],
    [], "2026-07-10", "2026-07-19", "2026-07-10");
  assert.deepEqual(occ.map((o) => o.scheduled_date), ["2026-07-10", "2026-07-13", "2026-07-16", "2026-07-19"]);
});

test("future-only: occurrences before todayLocal are dropped even if in the window", () => {
  const occ = projectOccurrences([daily()], [], "2026-07-01", "2026-07-05", "2026-07-03");
  assert.deepEqual(occ.map((o) => o.scheduled_date), ["2026-07-03", "2026-07-04", "2026-07-05"]);
});

test("active_from and active_to bound the series", () => {
  const occ = projectOccurrences([daily({ active_from: "2026-07-12", active_to: "2026-07-14" })],
    [], "2026-07-10", "2026-07-20", "2026-07-01");
  assert.deepEqual(occ.map((o) => o.scheduled_date), ["2026-07-12", "2026-07-13", "2026-07-14"]);
});

test("an inactive schedule emits nothing", () => {
  const occ = projectOccurrences([daily({ is_active: false })], [], "2026-07-10", "2026-07-12", "2026-07-01");
  assert.equal(occ.length, 0);
});

test("logged_at is the local wall-clock instant in UTC and day == scheduled_date (tz=0)", () => {
  const occ = projectOccurrences([daily({ time_of_day: "07:30", tz_offset_min: 0 })],
    [], "2026-07-10", "2026-07-10", "2026-07-10");
  assert.equal(occ[0].logged_at, "2026-07-10T07:30:00.000Z");
  assert.equal(occ[0].day, "2026-07-10");
  assert.equal(occ[0].time_of_day, "07:30");
});

test("tz_offset_min shifts logged_at but day stays the local scheduled_date (America/Chicago = 300)", () => {
  // 08:00 local at offset 300 (UTC = local + 300min) => 13:00 UTC, still the same local day.
  const occ = projectOccurrences([daily({ time_of_day: "08:00", tz_offset_min: 300 })],
    [], "2026-07-10", "2026-07-10", "2026-07-10");
  assert.equal(occ[0].logged_at, "2026-07-10T13:00:00.000Z");
  assert.equal(occ[0].day, "2026-07-10");
});

test("localInstantUTC is the inverse of dayKey by construction", () => {
  // Late-evening local time west of UTC crosses into the next UTC day, but the local day is preserved.
  const iso = localInstantUTC("2026-07-10", "23:30", 300);
  assert.equal(iso, "2026-07-11T04:30:00.000Z");
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd ~/gitrepos/sate/core && npm test`
Expected: FAIL — `Cannot find module '../src/domain/schedule.ts'` (esbuild resolve error) / the file does not exist.

- [ ] **Step 3: Create `core/src/domain/schedule.ts`**

```typescript
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
    // "weekly" and "monthly" are added in Tasks 2 and 3.
    default:
      return false;
  }
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars -- `overrides` is consulted in Task 4.
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

      const time = s.time_of_day || "00:00";
      out.push({
        id: `${s.id}:${d}`,
        schedule_id: s.id,
        scheduled_date: d,
        kind: s.kind,
        name: s.name,
        payload: s.payload ?? {},
        time_of_day: time,
        logged_at: localInstantUTC(d, time, s.tz_offset_min),
        day: d,
        is_overridden: false,
      });
    }
  }
  // Chronological, ties broken by schedule id for determinism.
  out.sort((a, b) =>
    a.logged_at < b.logged_at ? -1 : a.logged_at > b.logged_at ? 1 : a.schedule_id.localeCompare(b.schedule_id));
  return out;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd ~/gitrepos/sate/core && npm test`
Expected: PASS — all eight Task 1 tests green; the Phase 1 suite (harness/schema/honesty/plan) still green.

- [ ] **Step 5: Typecheck**

Run: `cd ~/gitrepos/sate-cloud && npx tsc --noEmit`
Expected: exit 0, no output.

- [ ] **Step 6: Commit**

```bash
cd ~/gitrepos/sate
git add core/src/domain/schedule.ts core/test/schedule.test.ts
git commit -m "feat(core): pure occurrence projector — daily recurrence, future-only, tz/day (Planner phase 2)"
```

---

### Task 2: Projector — weekly-by-weekday recurrence

Add the `weekly` case: fire on each weekday in `by_weekday` (default = `active_from`'s weekday when absent/empty), respecting `interval` weeks measured from `active_from`.

**Files:**
- Modify: `core/src/domain/schedule.ts` (the `firesOn` switch)
- Test: `core/test/schedule.test.ts` (append)

**Interfaces:**
- Consumes: `PlanSchedule`, `projectOccurrences` (Task 1). No signature change.

- [ ] **Step 1: Append the failing weekly tests to `core/test/schedule.test.ts`**

```typescript
function weekly(over: Partial<PlanSchedule> = {}): PlanSchedule {
  return {
    id: "w1", user: "u", kind: "activity", name: "Run",
    payload: { kcal: 250, duration_min: 30 },
    recurrence: { unit: "weekly", interval: 1, by_weekday: [1, 3, 5] }, // Mon/Wed/Fri
    time_of_day: "06:00", tz_offset_min: 0,
    active_from: "2026-07-01", is_active: true, ...over,
  };
}

test("weekly by_weekday emits only the listed weekdays", () => {
  // 2026-07-06 Mon, -07 Tue, -08 Wed, -09 Thu, -10 Fri, -11 Sat, -12 Sun.
  const occ = projectOccurrences([weekly()], [], "2026-07-06", "2026-07-12", "2026-07-01");
  assert.deepEqual(occ.map((o) => o.scheduled_date), ["2026-07-06", "2026-07-08", "2026-07-10"]);
});

test("weekly with no by_weekday defaults to active_from's weekday", () => {
  // 2026-07-01 is a Wednesday → fire only on Wednesdays.
  const occ = projectOccurrences([weekly({ recurrence: { unit: "weekly", interval: 1 }, active_from: "2026-07-01" })],
    [], "2026-07-06", "2026-07-19", "2026-07-01");
  assert.deepEqual(occ.map((o) => o.scheduled_date), ["2026-07-08", "2026-07-15"]);
});

test("weekly interval=2 fires every other week from active_from", () => {
  // Mondays only, every 2 weeks. active_from 2026-07-01 (Wed); week 0 = 06-28..07-04.
  // Mondays: 07-06 (wk1), 07-13 (wk2), 07-20 (wk3), 07-27 (wk4). weeksDiff = floor((d-active_from)/7).
  // 07-06 diff5 wk0; 07-13 diff12 wk1; 07-20 diff19 wk2; 07-27 diff26 wk3 → even weeks: 07-06, 07-20.
  const occ = projectOccurrences([weekly({ recurrence: { unit: "weekly", interval: 2, by_weekday: [1] } })],
    [], "2026-07-06", "2026-07-31", "2026-07-01");
  assert.deepEqual(occ.map((o) => o.scheduled_date), ["2026-07-06", "2026-07-20"]);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd ~/gitrepos/sate/core && npm test`
Expected: FAIL — the three weekly tests return `[]` (the `weekly` case is not yet in `firesOn`).

- [ ] **Step 3: Add the `weekly` case to `firesOn` in `core/src/domain/schedule.ts`**

Replace the comment line `// "weekly" and "monthly" are added in Tasks 2 and 3.` and the `default` with the weekly case followed by the default:

```typescript
    case "weekly": {
      const days = s.recurrence.by_weekday && s.recurrence.by_weekday.length
        ? s.recurrence.by_weekday
        : [weekdayOf(s.active_from)];
      if (!days.includes(weekdayOf(d))) return false;
      if (interval === 1) return true;
      const weeks = Math.floor(daysBetween(s.active_from, d) / 7);
      return weeks >= 0 && weeks % interval === 0;
    }
    // "monthly" is added in Task 3.
    default:
      return false;
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd ~/gitrepos/sate/core && npm test`
Expected: PASS — all weekly tests green; Task 1 tests + Phase 1 suite still green.

- [ ] **Step 5: Typecheck**

Run: `cd ~/gitrepos/sate-cloud && npx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
cd ~/gitrepos/sate
git add core/src/domain/schedule.ts core/test/schedule.test.ts
git commit -m "feat(core): projector weekly-by-weekday recurrence (interval + default weekday)"
```

---

### Task 3: Projector — monthly recurrence + month-length clamping

Add the `monthly` case: fire on `day_of_month` (default = `active_from`'s day-of-month) every `interval` months, **clamping** a day past the month's length to the last day (day 31 → Feb 28/29, etc.).

**Files:**
- Modify: `core/src/domain/schedule.ts` (the `firesOn` switch)
- Test: `core/test/schedule.test.ts` (append)

**Interfaces:**
- Consumes: `PlanSchedule`, `projectOccurrences` (Task 1). No signature change.

- [ ] **Step 1: Append the failing monthly tests to `core/test/schedule.test.ts`**

```typescript
function monthly(over: Partial<PlanSchedule> = {}): PlanSchedule {
  return {
    id: "m1", user: "u", kind: "food", name: "Cheat meal",
    payload: { kcal: 1200 },
    recurrence: { unit: "monthly", interval: 1, day_of_month: 15 },
    time_of_day: "18:00", tz_offset_min: 0,
    active_from: "2026-01-15", is_active: true, ...over,
  };
}

test("monthly fires on day_of_month each month", () => {
  const occ = projectOccurrences([monthly()], [], "2026-07-01", "2026-09-30", "2026-07-01");
  assert.deepEqual(occ.map((o) => o.scheduled_date), ["2026-07-15", "2026-08-15", "2026-09-15"]);
});

test("monthly with no day_of_month defaults to active_from's day-of-month", () => {
  const occ = projectOccurrences([monthly({ recurrence: { unit: "monthly", interval: 1 }, active_from: "2026-06-09" })],
    [], "2026-07-01", "2026-08-31", "2026-07-01");
  assert.deepEqual(occ.map((o) => o.scheduled_date), ["2026-07-09", "2026-08-09"]);
});

test("monthly day 31 clamps to the last day of shorter months", () => {
  const occ = projectOccurrences([monthly({ recurrence: { unit: "monthly", interval: 1, day_of_month: 31 }, active_from: "2026-01-31" })],
    [], "2026-02-01", "2026-04-30", "2026-02-01");
  assert.deepEqual(occ.map((o) => o.scheduled_date), ["2026-02-28", "2026-03-31", "2026-04-30"]);
});

test("monthly interval=2 fires every other month from active_from", () => {
  const occ = projectOccurrences([monthly({ recurrence: { unit: "monthly", interval: 2, day_of_month: 10 }, active_from: "2026-01-10" })],
    [], "2026-01-01", "2026-06-30", "2026-01-01");
  assert.deepEqual(occ.map((o) => o.scheduled_date), ["2026-01-10", "2026-03-10", "2026-05-10"]);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd ~/gitrepos/sate/core && npm test`
Expected: FAIL — the four monthly tests return `[]` (the `monthly` case is not yet in `firesOn`).

- [ ] **Step 3: Add the `monthly` case to `firesOn` in `core/src/domain/schedule.ts`**

Replace the comment line `// "monthly" is added in Task 3.` with the monthly case (keeping the `default` below it):

```typescript
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd ~/gitrepos/sate/core && npm test`
Expected: PASS — all monthly tests green; Tasks 1–2 + Phase 1 suite still green.

- [ ] **Step 5: Typecheck**

Run: `cd ~/gitrepos/sate-cloud && npx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
cd ~/gitrepos/sate
git add core/src/domain/schedule.ts core/test/schedule.test.ts
git commit -m "feat(core): projector monthly recurrence + month-length clamping (day 31 -> last day)"
```

---

### Task 4: Projector — per-occurrence overrides (skip / new_time / new_payload)

Consult the `overrides` parameter. A matching `plan_override` on an occurrence's `{schedule_id}:{date}` key either **drops** it (`is_skipped`) or **rewrites** its time (`new_time`) and/or content (`new_payload`), flagging `is_overridden`.

**Files:**
- Modify: `core/src/domain/schedule.ts` (`projectOccurrences` — index overrides, apply in the loop; remove the eslint-disable)
- Test: `core/test/schedule.test.ts` (append)

**Interfaces:**
- Consumes: `PlanOverride`, `PlanSchedule`, `projectOccurrences` (Task 1). No signature change (the `overrides` param already exists).

- [ ] **Step 1: Append the failing override tests to `core/test/schedule.test.ts`**

```typescript
import { type PlanOverride } from "../src/domain/schedule.ts";

function ov(over: Partial<PlanOverride>): PlanOverride {
  return { id: "o1", user: "u", schedule_id: "s1", scheduled_date: "2026-07-11", ...over };
}

test("override is_skipped drops that occurrence only", () => {
  const occ = projectOccurrences([daily()], [ov({ is_skipped: true })], "2026-07-10", "2026-07-12", "2026-07-10");
  assert.deepEqual(occ.map((o) => o.scheduled_date), ["2026-07-10", "2026-07-12"]);
});

test("override new_time moves the occurrence's time_of_day and logged_at, flags is_overridden", () => {
  const occ = projectOccurrences([daily({ time_of_day: "07:30" })],
    [ov({ scheduled_date: "2026-07-11", new_time: "20:00" })], "2026-07-11", "2026-07-11", "2026-07-11");
  assert.equal(occ[0].time_of_day, "20:00");
  assert.equal(occ[0].logged_at, "2026-07-11T20:00:00.000Z");
  assert.equal(occ[0].is_overridden, true);
});

test("override new_payload replaces the occurrence payload, flags is_overridden", () => {
  const occ = projectOccurrences([daily({ payload: { kcal: 300 } })],
    [ov({ scheduled_date: "2026-07-11", new_payload: { kcal: 550, description: "Bigger oats" } })],
    "2026-07-11", "2026-07-11", "2026-07-11");
  assert.deepEqual(occ[0].payload, { kcal: 550, description: "Bigger oats" });
  assert.equal(occ[0].is_overridden, true);
});

test("a non-matching override leaves the series untouched", () => {
  const occ = projectOccurrences([daily()], [ov({ schedule_id: "other", scheduled_date: "2026-07-11", is_skipped: true })],
    "2026-07-10", "2026-07-12", "2026-07-10");
  assert.deepEqual(occ.map((o) => o.scheduled_date), ["2026-07-10", "2026-07-11", "2026-07-12"]);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd ~/gitrepos/sate/core && npm test`
Expected: FAIL — skip is not dropped (all three dates present), new_time/new_payload not applied, `is_overridden` stays false.

- [ ] **Step 3: Apply overrides in `projectOccurrences` (`core/src/domain/schedule.ts`)**

First, remove the eslint-disable comment line above `export function projectOccurrences(` (the `overrides` param is now used).

Then, immediately after `if (start > toDate) return out;`, insert the override index:

```typescript
  // Index overrides by "{scheduleId}:{date}" — the occurrence identity.
  const ovByKey = new Map<string, PlanOverride>();
  for (const o of overrides) ovByKey.set(`${o.schedule_id}:${o.scheduled_date}`, o);
```

Finally, REPLACE the occurrence-building block (from `const time = s.time_of_day || "00:00";` through the `out.push({ ... });` call) with the override-aware version:

```typescript
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd ~/gitrepos/sate/core && npm test`
Expected: PASS — all four override tests green; Tasks 1–3 + Phase 1 suite still green.

- [ ] **Step 5: Typecheck**

Run: `cd ~/gitrepos/sate-cloud && npx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
cd ~/gitrepos/sate
git add core/src/domain/schedule.ts core/test/schedule.test.ts
git commit -m "feat(core): projector applies per-occurrence overrides (skip / new_time / new_payload)"
```

---

### Task 5: Zod schemas — `plan_schedules` + `plan_overrides`

Add the two canonical persisted-entity validators to `schema/index.ts`, mirroring the projector's interfaces field-for-field (spec §2.2/§2.3). Additive: every field is required-with-content or optional/defaulted.

**Files:**
- Modify: `core/src/schema/index.ts` (add after the `Entry`/`Food`/`Activity` block, before `Measurement` — anywhere in the entity section is fine)
- Test: `core/test/plan-schema.test.ts`

**Interfaces:**
- Produces (Zod objects + inferred types):
  - `ScheduleRecurrence` — `{ unit: "daily"|"weekly"|"monthly"; interval: number (default 1); by_weekday?: number[]; day_of_month?: number }`
  - `PlanSchedule` — the §2.2 shape; `type PlanSchedule = z.infer<typeof PlanSchedule>`.
  - `PlanOverride` — the §2.3 shape; `type PlanOverride = z.infer<typeof PlanOverride>`.
- These are the read/write types for the routes (Tasks 6–9). They structurally satisfy `domain/schedule.ts`'s like-named interfaces (verified by tsc at the `projectOccurrences` call site in Task 7).

- [ ] **Step 1: Write the failing test `core/test/plan-schema.test.ts`**

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { PlanSchedule, PlanOverride } from "../src/schema/index.ts";

test("PlanSchedule applies defaults (interval, is_active, payload, kind)", () => {
  const s = PlanSchedule.parse({
    id: "s1", user: "u", name: "Oats",
    recurrence: { unit: "daily" },
    active_from: "2026-07-01",
  });
  assert.equal(s.kind, "food");
  assert.equal(s.recurrence.interval, 1);
  assert.equal(s.is_active, true);
  assert.deepEqual(s.payload, {});
  assert.equal(s.time_of_day, "12:00");
  assert.equal(s.tz_offset_min, 0);
});

test("PlanSchedule keeps weekly by_weekday and open-ended active_to", () => {
  const s = PlanSchedule.parse({
    id: "s1", user: "u", kind: "activity", name: "Run",
    recurrence: { unit: "weekly", interval: 2, by_weekday: [1, 3, 5] },
    payload: { kcal: 250 }, time_of_day: "06:00", tz_offset_min: 300,
    active_from: "2026-07-01",
  });
  assert.deepEqual(s.recurrence.by_weekday, [1, 3, 5]);
  assert.equal(s.active_to, undefined);
  assert.equal(s.payload.kcal, 250);
});

test("PlanSchedule rejects a bad recurrence unit", () => {
  assert.throws(() => PlanSchedule.parse({
    id: "s1", user: "u", name: "x", recurrence: { unit: "yearly" }, active_from: "2026-07-01",
  }));
});

test("PlanOverride defaults is_skipped false and allows new_time/new_payload", () => {
  const o = PlanOverride.parse({ id: "o1", user: "u", schedule_id: "s1", scheduled_date: "2026-07-11" });
  assert.equal(o.is_skipped, false);
  const o2 = PlanOverride.parse({
    id: "o2", user: "u", schedule_id: "s1", scheduled_date: "2026-07-12",
    new_time: "20:00", new_payload: { kcal: 550 },
  });
  assert.equal(o2.new_time, "20:00");
  assert.equal(o2.new_payload!.kcal, 550);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd ~/gitrepos/sate/core && npm test`
Expected: FAIL — `PlanSchedule`/`PlanOverride` are not exported from `../src/schema/index.ts`.

- [ ] **Step 3: Add the schemas to `core/src/schema/index.ts`**

Insert after the `Activity` schema block (after `export type Activity = z.infer<typeof Activity>;`) and before the `Measurement` block:

```typescript
// ---- recurring plan schedules (Planner phase 2) -------------------------
// A recurring meal/activity definition. `payload` carries the same INTENDED content a planned entry
// would (food: kcal/macros/items/description/note; activity: kcal-burn/duration_min/distance/intensity/
// description). Occurrences are PROJECTED (never stored) by domain/schedule.projectOccurrences until the
// user accepts one, which materializes a status:"logged" entry. `once` is intentionally NOT a unit —
// one-offs are plain planned entries (§2.1). Field names mirror domain/schedule.PlanSchedule exactly.
export const RECURRENCE_UNITS = ["daily", "weekly", "monthly"] as const;
export type RecurrenceUnit = (typeof RECURRENCE_UNITS)[number];

export const ScheduleRecurrence = z.object({
  unit: z.enum(RECURRENCE_UNITS),
  interval: z.number().int().positive().default(1), // >= 1 ("every 2 weeks" = weekly / 2)
  by_weekday: z.array(z.number().int().min(0).max(6)).optional(), // 0..6 (Sun..Sat), weekly only
  day_of_month: z.number().int().min(1).max(31).optional(), // 1..31, monthly only (default = anchor DOM)
});
export type ScheduleRecurrence = z.infer<typeof ScheduleRecurrence>;

export const PlanSchedule = z.object({
  id: z.string(),
  user: z.string(), // Firebase uid
  kind: z.enum(ENTRY_KINDS).default("food"),
  name: z.string(),
  payload: z.record(z.string(), z.unknown()).default({}), // intended entry content (see above)
  recurrence: ScheduleRecurrence,
  time_of_day: z.string().default("12:00"), // "HH:mm" local wall-clock
  tz_offset_min: z.number().default(0), // JS getTimezoneOffset() minutes the schedule was authored in
  active_from: z.string(), // YYYY-MM-DD
  active_to: z.string().optional(), // YYYY-MM-DD; open-ended if absent
  is_active: z.boolean().default(true),
  created_at: z.string().optional(),
  updated_at: z.string().optional(),
});
export type PlanSchedule = z.infer<typeof PlanSchedule>;

// ---- per-occurrence exceptions (Planner phase 2) ------------------------
// One row per edited/skipped occurrence of a schedule. (schedule_id, scheduled_date) is the occurrence
// identity, mirroring BalanceEngine's {scheduleId}:{date}. is_skipped = "delete just this one";
// new_time/new_payload = "edit just this one". Applied by the projector at read time.
export const PlanOverride = z.object({
  id: z.string(),
  user: z.string(),
  schedule_id: z.string(),
  scheduled_date: z.string(), // YYYY-MM-DD (the occurrence being overridden)
  is_skipped: z.boolean().default(false),
  new_time: z.string().optional(), // "HH:mm"
  new_payload: z.record(z.string(), z.unknown()).optional(),
  created_at: z.string().optional(),
});
export type PlanOverride = z.infer<typeof PlanOverride>;
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd ~/gitrepos/sate/core && npm test`
Expected: PASS — all four plan-schema tests green; every prior test still green.

- [ ] **Step 5: Typecheck**

Run: `cd ~/gitrepos/sate-cloud && npx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
cd ~/gitrepos/sate
git add core/src/schema/index.ts core/test/plan-schema.test.ts
git commit -m "feat(core): add plan_schedules + plan_overrides Zod schemas (Planner phase 2)"
```

---

### Task 6: Schedule CRUD — `GET/POST/PATCH/DELETE /api/plan/schedules[/:id]`

The Plan-tab manager's backend: list, create, edit (all-scope), and delete (cascading its overrides) recurring schedules. All non-AI, user-scoped, owner-guarded.

**Files:**
- Modify: `core/src/api/plan.ts` (add the CRUD routes + `findOverride`/`upsertOverride` helpers used here and in Task 8; add imports)
- Test: `core/test/schedules.test.ts`

**Interfaces:**
- Consumes: `PlanSchedule`, `PlanOverride` (Zod + types) from `../schema`; `DataStore` from `../ports`; existing `getUid`, `getEmail`, `ok`, `err`, `ensureProfile` from `./helpers`.
- Produces: routes `GET /api/plan/schedules` → `{ schedules }`; `POST /api/plan/schedules` (body = schedule minus id/user/timestamps) → `{ schedule }`; `PATCH /api/plan/schedules/:id` (partial) → `{ schedule }`; `DELETE /api/plan/schedules/:id` → `{ deleted }`. Module helpers `findOverride(store, scheduleId, date)` and `upsertOverride(store, scheduleId, date, patch)` (reused in Task 8).

- [ ] **Step 1: Write the failing test `core/test/schedules.test.ts`**

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { client } from "./mem.ts";

const NEW_SCHED = {
  kind: "food", name: "Overnight oats",
  payload: { kcal: 300, description: "Overnight oats", macros: { protein: 12, carbs: 40, fat: 8 } },
  recurrence: { unit: "daily", interval: 1 },
  time_of_day: "07:30", tz_offset_min: 0, active_from: "2026-07-01",
};

async function createSchedule(req: any, over: Record<string, unknown> = {}) {
  const res = await req("/api/plan/schedules", { method: "POST", body: JSON.stringify({ ...NEW_SCHED, ...over }) });
  return { res, body: await res.json() };
}

test("POST /api/plan/schedules creates a schedule with defaults + server fields", async () => {
  const { req } = client();
  const { res, body } = await createSchedule(req);
  assert.equal(res.status, 200);
  assert.equal(body.schedule.name, "Overnight oats");
  assert.equal(body.schedule.is_active, true);
  assert.equal(body.schedule.recurrence.interval, 1);
  assert.ok(body.schedule.id, "server assigns an id");
  assert.ok(body.schedule.created_at, "server stamps created_at");
});

test("POST /api/plan/schedules 400s a bad recurrence unit", async () => {
  const { req } = client();
  const { res } = await createSchedule(req, { recurrence: { unit: "yearly" } });
  assert.equal(res.status, 400);
});

test("POST /api/plan/schedules 400s a missing active_from", async () => {
  const { req } = client();
  const res = await req("/api/plan/schedules", { method: "POST",
    body: JSON.stringify({ name: "x", recurrence: { unit: "daily" } }) });
  assert.equal(res.status, 400);
});

test("GET /api/plan/schedules lists the caller's schedules", async () => {
  const { req } = client();
  await createSchedule(req);
  await createSchedule(req, { name: "Morning run", kind: "activity" });
  const res = await req("/api/plan/schedules");
  const body = await res.json();
  assert.equal(body.schedules.length, 2);
});

test("PATCH /api/plan/schedules/:id edits the schedule (all-scope)", async () => {
  const { req } = client();
  const { body } = await createSchedule(req);
  const res = await req(`/api/plan/schedules/${body.schedule.id}`, {
    method: "PATCH", body: JSON.stringify({ name: "Steel-cut oats", time_of_day: "08:00" }),
  });
  const patched = await res.json();
  assert.equal(res.status, 200);
  assert.equal(patched.schedule.name, "Steel-cut oats");
  assert.equal(patched.schedule.time_of_day, "08:00");
});

test("DELETE /api/plan/schedules/:id removes it and cascades its overrides", async () => {
  const { req, platform } = client();
  const { body } = await createSchedule(req);
  const id = body.schedule.id;
  // Seed an override for this schedule to prove the cascade.
  const store = platform.data.forUser("tester@example.com");
  await store.create("plan_overrides", { user: "tester@example.com", schedule_id: id, scheduled_date: "2026-07-11", is_skipped: true });
  const res = await req(`/api/plan/schedules/${id}`, { method: "DELETE" });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).deleted, id);
  const gone = await req("/api/plan/schedules");
  assert.equal((await gone.json()).schedules.length, 0);
  const { items } = await store.list("plan_overrides", {});
  assert.equal(items.length, 0, "overrides cascaded");
});

test("PATCH /api/plan/schedules/:id 404s an unknown id", async () => {
  const { req } = client();
  const res = await req("/api/plan/schedules/nope", { method: "PATCH", body: JSON.stringify({ name: "x" }) });
  assert.equal(res.status, 404);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd ~/gitrepos/sate/core && npm test`
Expected: FAIL — the schedule routes 404 (not mounted).

- [ ] **Step 3: Extend `core/src/api/plan.ts` — imports + helpers + CRUD routes**

Replace the top import block of `plan.ts`:

```typescript
import {
  getUid, getEmail, ok, err, dayKey, ensureProfile, dayIntakeTotals,
  type App, type RouteDeps,
} from "./helpers";
import type { Entry, Macros } from "../schema";
```

with:

```typescript
import {
  getUid, getEmail, ok, err, dayKey, ensureProfile, dayIntakeTotals,
  type App, type RouteDeps,
} from "./helpers";
import { PlanSchedule, PlanOverride, ScheduleRecurrence } from "../schema";
import type { Entry, Macros } from "../schema";
import type { DataStore } from "../ports";
import { projectOccurrences, localInstantUTC, type Occurrence } from "../domain/schedule";
```

(The `projectOccurrences`/`localInstantUTC`/`Occurrence` imports are used in Tasks 7 and 9; adding them now keeps the import block stable.)

Add these module-level helpers after the existing `macrosOf` function (before `registerPlan`):

```typescript
// Find the single override for (schedule_id, scheduled_date), or null. Shared by occurrence edit/delete.
async function findOverride(store: DataStore, scheduleId: string, date: string): Promise<(PlanOverride & { id: string }) | null> {
  try {
    const { items } = await store.list<PlanOverride & { id: string }>("plan_overrides", {
      where: [
        { field: "schedule_id", op: "==", value: scheduleId },
        { field: "scheduled_date", op: "==", value: date },
      ],
      limit: 1,
    });
    return items[0] ?? null;
  } catch {
    return null;
  }
}

// Upsert the override for (schedule_id, scheduled_date): update if one exists, else create.
async function upsertOverride(
  store: DataStore, scheduleId: string, date: string, patch: Record<string, unknown>,
): Promise<PlanOverride> {
  const existing = await findOverride(store, scheduleId, date);
  if (existing) return await store.update<PlanOverride>("plan_overrides", existing.id, patch as Partial<PlanOverride>);
  return await store.create<PlanOverride>("plan_overrides", patch as Omit<PlanOverride, "id">);
}
```

Add the CRUD routes inside `registerPlan`, after the `/api/plan/accept` handler:

```typescript
  // ---- Schedule CRUD (the Plan-tab manager). Editing a schedule directly is inherently "all".
  const ScheduleCreate = PlanSchedule.omit({ id: true, user: true, created_at: true, updated_at: true });

  app.get("/api/plan/schedules", async (c) => {
    const uid = getUid(c);
    const store = platform.data.forUser(uid);
    let items: PlanSchedule[] = [];
    try {
      ({ items } = await store.list<PlanSchedule>("plan_schedules", { limit: 500 }));
    } catch {
      items = [];
    }
    return ok(c, { schedules: items });
  });

  app.post("/api/plan/schedules", async (c) => {
    const uid = getUid(c);
    await ensureProfile(platform, uid, getEmail(c));
    const b = await c.req.json().catch(() => ({}));
    const parsed = ScheduleCreate.safeParse(b);
    if (!parsed.success) return err(c, parsed.error.issues[0]?.message || "invalid schedule", 400);
    const store = platform.data.forUser(uid);
    const now = new Date().toISOString();
    try {
      const schedule = await store.create<PlanSchedule>("plan_schedules", {
        ...parsed.data, user: uid, created_at: now, updated_at: now,
      } as Omit<PlanSchedule, "id">);
      return ok(c, { schedule });
    } catch (e) {
      return err(c, msgOf(e), 502);
    }
  });

  app.patch("/api/plan/schedules/:id", async (c) => {
    const uid = getUid(c);
    const store = platform.data.forUser(uid);
    const id = c.req.param("id");
    const rec = await store.get<PlanSchedule>("plan_schedules", id);
    if (!rec) return err(c, "not found", 404);
    if (rec.user !== uid) return err(c, "forbidden", 403);
    const b = await c.req.json().catch(() => ({}));
    const parsed = ScheduleCreate.partial().safeParse(b);
    if (!parsed.success) return err(c, parsed.error.issues[0]?.message || "invalid patch", 400);
    try {
      const schedule = await store.update<PlanSchedule>("plan_schedules", id, {
        ...parsed.data, updated_at: new Date().toISOString(),
      } as Partial<PlanSchedule>);
      return ok(c, { schedule });
    } catch (e) {
      return err(c, msgOf(e), 502);
    }
  });

  app.delete("/api/plan/schedules/:id", async (c) => {
    const uid = getUid(c);
    const store = platform.data.forUser(uid);
    const id = c.req.param("id");
    const rec = await store.get<PlanSchedule>("plan_schedules", id);
    if (!rec) return err(c, "not found", 404);
    if (rec.user !== uid) return err(c, "forbidden", 403);
    // Cascade: remove this schedule's per-occurrence overrides.
    try {
      const { items } = await store.list<PlanOverride & { id: string }>("plan_overrides", {
        where: [{ field: "schedule_id", op: "==", value: id }], limit: 1000,
      });
      for (const o of items) await store.delete("plan_overrides", o.id);
    } catch {
      /* best-effort cascade */
    }
    await store.delete("plan_schedules", id);
    return ok(c, { deleted: id });
  });
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd ~/gitrepos/sate/core && npm test`
Expected: PASS — all seven CRUD tests green; every prior test still green.

- [ ] **Step 5: Typecheck**

Run: `cd ~/gitrepos/sate-cloud && npx tsc --noEmit`
Expected: exit 0. (`ScheduleRecurrence` is imported now and used in Task 8; if a `noUnusedLocals`-style lint flags it before then, it is intentional — keep it.)

- [ ] **Step 6: Commit**

```bash
cd ~/gitrepos/sate
git add core/src/api/plan.ts core/test/schedules.test.ts
git commit -m "feat(core): schedule CRUD routes /api/plan/schedules[/:id] + override upsert helpers"
```

---

### Task 7: `GET /api/timeline` — merge stored entries + projected occurrences

The merged, chronologically-sorted read (spec §4.1): stored entries in `[from,to]` (logged actuals + planned one-offs) plus projected occurrences from active schedules, dropping skipped and already-materialized dates, each item tagged `state`/`origin` (+ occurrence `schedule_id`/`scheduled_date`/synthetic id). Reuses `projectOccurrences`. Returns a list only — no totals, so the honesty rule is preserved (occurrences are never stored, planned entries are excluded from every total by Phase 1's `isLogged`).

**Files:**
- Modify: `core/src/api/plan.ts` (add the route inside `registerPlan`)
- Test: `core/test/timeline.test.ts`

**Interfaces:**
- Consumes: `projectOccurrences`, `Occurrence` (`../domain/schedule`); `PlanSchedule`, `PlanOverride`, `Entry` (`../schema`); `dayKey`, `isLogged`? — NO: honesty is preserved by not totaling here. Uses `dayKey` for `todayLocal`.
- Produces: route `GET /api/timeline?from&to&scope&tz` → `{ from, to, scope, items }` where each item is a stored entry `{...entry, state: "logged"|"planned", origin: "entry"}` or an occurrence `{...occurrence, state: "planned", origin: "occurrence"}` (occurrence already carries `id`, `schedule_id`, `scheduled_date`), sorted by `logged_at`.

- [ ] **Step 1: Write the failing test `core/test/timeline.test.ts`**

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { client, TEST_EMAIL } from "./mem.ts";

// today (tz=0) so future-only occurrences land inside the requested window.
const TODAY = new Date().toISOString().slice(0, 10);
function plusDays(base: string, n: number): string {
  return new Date(Date.parse(base + "T00:00:00Z") + n * 86400000).toISOString().slice(0, 10);
}

async function seedDailySchedule(platform: any, over: Record<string, unknown> = {}) {
  const store = platform.data.forUser(TEST_EMAIL);
  return await store.create("plan_schedules", {
    user: TEST_EMAIL, kind: "food", name: "Oats", payload: { kcal: 300, description: "Oats", macros: { protein: 12, carbs: 40, fat: 8 } },
    recurrence: { unit: "daily", interval: 1 }, time_of_day: "07:30", tz_offset_min: 0,
    active_from: TODAY, is_active: true, ...over,
  });
}

test("GET /api/timeline merges stored entries and projected occurrences, tagged", async () => {
  const { req, platform } = client();
  const store = platform.data.forUser(TEST_EMAIL);
  // A logged actual + a planned one-off, both today.
  await store.create("entries", { user: TEST_EMAIL, kind: "food", description: "logged lunch", kcal: 500,
    macros: { protein: 30, carbs: 40, fat: 20 }, status: "logged", logged_at: `${TODAY}T12:00:00.000Z`, day: TODAY });
  await store.create("entries", { user: TEST_EMAIL, kind: "food", description: "planned snack", kcal: 150,
    status: "planned", logged_at: `${TODAY}T15:00:00.000Z`, day: TODAY });
  await seedDailySchedule(platform);

  const res = await req(`/api/timeline?from=${TODAY}&to=${TODAY}&tz=0`);
  assert.equal(res.status, 200);
  const body = await res.json();
  const byOrigin = (o: string) => body.items.filter((i: any) => i.origin === o);
  assert.equal(byOrigin("entry").length, 2, "logged + planned one-off");
  assert.equal(byOrigin("occurrence").length, 1, "one projected occurrence today");
  const occ = byOrigin("occurrence")[0];
  assert.equal(occ.state, "planned");
  assert.equal(occ.scheduled_date, TODAY);
  assert.equal(occ.id, `${occ.schedule_id}:${TODAY}`);
  const planned = byOrigin("entry").find((i: any) => i.description === "planned snack");
  assert.equal(planned.state, "planned");
  const logged = byOrigin("entry").find((i: any) => i.description === "logged lunch");
  assert.equal(logged.state, "logged");
});

test("GET /api/timeline drops a skipped occurrence date", async () => {
  const { req, platform } = client();
  const store = platform.data.forUser(TEST_EMAIL);
  const sched = await seedDailySchedule(platform);
  await store.create("plan_overrides", { user: TEST_EMAIL, schedule_id: sched.id, scheduled_date: TODAY, is_skipped: true });
  const res = await req(`/api/timeline?from=${TODAY}&to=${TODAY}&tz=0`);
  const body = await res.json();
  assert.equal(body.items.filter((i: any) => i.origin === "occurrence").length, 0);
});

test("GET /api/timeline drops an already-materialized occurrence date", async () => {
  const { req, platform } = client();
  const store = platform.data.forUser(TEST_EMAIL);
  const sched = await seedDailySchedule(platform);
  // A materialized entry for today's occurrence (as the accept flow would create).
  await store.create("entries", { user: TEST_EMAIL, kind: "food", description: "Oats", kcal: 300, status: "logged",
    plan_schedule_id: sched.id, scheduled_date: TODAY, logged_at: `${TODAY}T07:30:00.000Z`, day: TODAY });
  const res = await req(`/api/timeline?from=${TODAY}&to=${TODAY}&tz=0`);
  const body = await res.json();
  assert.equal(body.items.filter((i: any) => i.origin === "occurrence").length, 0, "materialized date not double-shown");
  assert.equal(body.items.filter((i: any) => i.origin === "entry").length, 1, "the materialized entry shows once");
});

test("GET /api/timeline scope=activity filters to activity items", async () => {
  const { req, platform } = client();
  await seedDailySchedule(platform); // food
  await seedDailySchedule(platform, { kind: "activity", name: "Run", payload: { kcal: 250, duration_min: 30 } });
  const res = await req(`/api/timeline?from=${TODAY}&to=${TODAY}&scope=activity&tz=0`);
  const body = await res.json();
  assert.equal(body.items.length, 1);
  assert.equal(body.items[0].kind, "activity");
});

test("GET /api/timeline occurrences never enter day totals (honesty rule)", async () => {
  const { req, platform } = client();
  await seedDailySchedule(platform);
  await req(`/api/timeline?from=${TODAY}&to=${TODAY}&tz=0`); // project some occurrences
  const day = await req(`/api/entries?day=${TODAY}&tz=0`);
  const body = await day.json();
  assert.equal(body.totals.kcal, 0, "a projected occurrence contributes nothing to totals");
});

test("GET /api/timeline defaults from/to to today and returns future occurrences on scroll-up window", async () => {
  const { req, platform } = client();
  await seedDailySchedule(platform);
  const to = plusDays(TODAY, 2);
  const res = await req(`/api/timeline?from=${TODAY}&to=${to}&tz=0`);
  const body = await res.json();
  const dates = body.items.filter((i: any) => i.origin === "occurrence").map((i: any) => i.scheduled_date);
  assert.deepEqual(dates, [TODAY, plusDays(TODAY, 1), plusDays(TODAY, 2)]);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd ~/gitrepos/sate/core && npm test`
Expected: FAIL — `GET /api/timeline` 404 (not mounted).

- [ ] **Step 3: Add the timeline route to `core/src/api/plan.ts`**

Add inside `registerPlan`, after the schedule CRUD routes:

```typescript
  // ---- GET /api/timeline?from&to&scope&tz — the merged Home/Plan timeline (spec §4.1).
  // Stored entries in [from,to] (logged actuals + planned one-offs) merged with projected occurrences
  // from active schedules; skipped + already-materialized occurrence dates are dropped. Occurrences are
  // never stored, so they never reach any total — this route returns a list only (honesty preserved).
  app.get("/api/timeline", async (c) => {
    const uid = getUid(c);
    const store = platform.data.forUser(uid);
    const tz = Number(c.req.query("tz") || 0);
    const todayLocal = dayKey(new Date().toISOString(), tz);
    const from = String(c.req.query("from") || todayLocal);
    const to = String(c.req.query("to") || from);
    const scope = String(c.req.query("scope") || "all");
    const wantActivity = scope === "activity" ? true : scope === "nutrition" ? false : null;
    const kindOk = (k?: string) => wantActivity === null || (k === "activity") === wantActivity;

    // 1) Stored entries whose local day falls in [from,to]. Single inequality on `day` + orderBy day
    //    (no composite index); the upper bound is applied in code. Covers logged actuals + planned one-offs.
    let entries: Entry[] = [];
    try {
      ({ items: entries } = await store.list<Entry>("entries", {
        where: [{ field: "day", op: ">=", value: from }],
        orderBy: [{ field: "day", dir: "asc" }],
        limit: 2000,
      }));
    } catch {
      entries = [];
    }
    entries = entries.filter((e) => (e.day || "") <= to);

    type Item = Record<string, unknown> & { logged_at: string };
    const items: Item[] = [];
    const materialized = new Set<string>();
    for (const e of entries) {
      if (e.plan_schedule_id && e.scheduled_date) materialized.add(`${e.plan_schedule_id}:${e.scheduled_date}`);
      if (!kindOk(e.kind)) continue;
      items.push({ ...e, state: e.status === "planned" ? "planned" : "logged", origin: "entry" });
    }

    // 2) Projected occurrences from active schedules + overrides, minus skipped/materialized dates.
    let schedules: PlanSchedule[] = [];
    let overrides: PlanOverride[] = [];
    try {
      ({ items: schedules } = await store.list<PlanSchedule>("plan_schedules", {
        where: [{ field: "is_active", op: "==", value: true }], limit: 500,
      }));
    } catch {
      schedules = [];
    }
    try {
      ({ items: overrides } = await store.list<PlanOverride>("plan_overrides", { limit: 2000 }));
    } catch {
      overrides = [];
    }
    const occ: Occurrence[] = projectOccurrences(schedules, overrides, from, to, todayLocal);
    for (const o of occ) {
      if (!kindOk(o.kind)) continue;
      if (materialized.has(o.id)) continue; // accepted/edited-into-an-entry → the stored entry represents it
      items.push({ ...o, state: "planned", origin: "occurrence" });
    }

    // 3) Chronological merge.
    items.sort((a, b) => (a.logged_at < b.logged_at ? -1 : a.logged_at > b.logged_at ? 1 : 0));
    return ok(c, { from, to, scope, items });
  });
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd ~/gitrepos/sate/core && npm test`
Expected: PASS — all six timeline tests green; every prior test still green.

- [ ] **Step 5: Typecheck**

Run: `cd ~/gitrepos/sate-cloud && npx tsc --noEmit`
Expected: exit 0. (This is where `tsc` verifies the schema `PlanSchedule[]`/`PlanOverride[]` are structurally assignable to `projectOccurrences`'s domain interfaces.)

- [ ] **Step 6: Commit**

```bash
cd ~/gitrepos/sate
git add core/src/api/plan.ts core/test/timeline.test.ts
git commit -m "feat(core): GET /api/timeline — merge stored entries + projected occurrences (tagged)"
```

---

### Task 8: Occurrence edit + delete — "this occurrence vs. all"

The scope prompt's backend (spec §6): `PATCH .../occurrences/:date {scope}` (one → upsert override; all → patch schedule) and `DELETE .../occurrences/:date?scope` (one → skip override; all → deactivate schedule). Reuses `upsertOverride` (Task 6).

**Files:**
- Modify: `core/src/api/plan.ts` (add the two routes inside `registerPlan`)
- Test: `core/test/schedules.test.ts` (append)

**Interfaces:**
- Consumes: `upsertOverride` (Task 6), `ScheduleRecurrence` (`../schema`), `PlanSchedule`.
- Produces: `PATCH /api/plan/schedules/:id/occurrences/:date` body `{ scope: "one"|"all", new_time?, new_payload?, recurrence? }` → `{ override, scope:"one" }` or `{ schedule, scope:"all" }`; `DELETE /api/plan/schedules/:id/occurrences/:date?scope=one|all` → `{ override, scope:"one", skipped:true }` or `{ schedule, scope:"all", deactivated:true }`.

- [ ] **Step 1: Append the failing tests to `core/test/schedules.test.ts`**

```typescript
test("PATCH occurrence scope=one upserts an override (leaves the series)", async () => {
  const { req, platform } = client();
  const { body } = await createSchedule(req);
  const id = body.schedule.id;
  const res = await req(`/api/plan/schedules/${id}/occurrences/2026-07-11`, {
    method: "PATCH", body: JSON.stringify({ scope: "one", new_time: "20:00", new_payload: { kcal: 550 } }),
  });
  assert.equal(res.status, 200);
  const out = await res.json();
  assert.equal(out.scope, "one");
  assert.equal(out.override.new_time, "20:00");
  assert.equal(out.override.new_payload.kcal, 550);
  // Series unchanged: the schedule keeps its original time.
  const store = platform.data.forUser("tester@example.com");
  const sched = await store.get("plan_schedules", id);
  assert.equal(sched.time_of_day, "07:30");
});

test("PATCH occurrence scope=one twice updates the same override (no duplicate)", async () => {
  const { req, platform } = client();
  const { body } = await createSchedule(req);
  const id = body.schedule.id;
  await req(`/api/plan/schedules/${id}/occurrences/2026-07-11`, { method: "PATCH", body: JSON.stringify({ scope: "one", new_time: "20:00" }) });
  await req(`/api/plan/schedules/${id}/occurrences/2026-07-11`, { method: "PATCH", body: JSON.stringify({ scope: "one", new_time: "21:00" }) });
  const store = platform.data.forUser("tester@example.com");
  const { items } = await store.list("plan_overrides", {});
  assert.equal(items.length, 1, "one override row for the date");
  assert.equal(items[0].new_time, "21:00");
});

test("PATCH occurrence scope=all edits the schedule", async () => {
  const { req } = client();
  const { body } = await createSchedule(req);
  const id = body.schedule.id;
  const res = await req(`/api/plan/schedules/${id}/occurrences/2026-07-11`, {
    method: "PATCH", body: JSON.stringify({ scope: "all", new_time: "09:00", recurrence: { unit: "weekly", interval: 1, by_weekday: [1] } }),
  });
  const out = await res.json();
  assert.equal(out.scope, "all");
  assert.equal(out.schedule.time_of_day, "09:00");
  assert.equal(out.schedule.recurrence.unit, "weekly");
});

test("DELETE occurrence scope=one writes a skip override", async () => {
  const { req, platform } = client();
  const { body } = await createSchedule(req);
  const id = body.schedule.id;
  const res = await req(`/api/plan/schedules/${id}/occurrences/2026-07-11?scope=one`, { method: "DELETE" });
  assert.equal(res.status, 200);
  const out = await res.json();
  assert.equal(out.skipped, true);
  const store = platform.data.forUser("tester@example.com");
  const { items } = await store.list("plan_overrides", {});
  assert.equal(items[0].is_skipped, true);
});

test("DELETE occurrence scope=all deactivates the schedule", async () => {
  const { req } = client();
  const { body } = await createSchedule(req);
  const id = body.schedule.id;
  const res = await req(`/api/plan/schedules/${id}/occurrences/2026-07-11?scope=all`, { method: "DELETE" });
  const out = await res.json();
  assert.equal(out.deactivated, true);
  assert.equal(out.schedule.is_active, false);
});

test("PATCH occurrence 404s an unknown schedule", async () => {
  const { req } = client();
  const res = await req("/api/plan/schedules/nope/occurrences/2026-07-11", { method: "PATCH", body: JSON.stringify({ scope: "one", new_time: "20:00" }) });
  assert.equal(res.status, 404);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd ~/gitrepos/sate/core && npm test`
Expected: FAIL — the occurrence routes 404 (not mounted).

- [ ] **Step 3: Add the occurrence edit/delete routes to `core/src/api/plan.ts`**

Add inside `registerPlan`, after the `/api/timeline` route:

```typescript
  // ---- PATCH /api/plan/schedules/:id/occurrences/:date — edit one (override) or all (schedule).
  app.patch("/api/plan/schedules/:id/occurrences/:date", async (c) => {
    const uid = getUid(c);
    const store = platform.data.forUser(uid);
    const id = c.req.param("id");
    const date = c.req.param("date");
    const rec = await store.get<PlanSchedule>("plan_schedules", id);
    if (!rec) return err(c, "not found", 404);
    if (rec.user !== uid) return err(c, "forbidden", 403);
    const b = (await c.req.json().catch(() => ({}))) as Record<string, any>;

    if (b.scope === "all") {
      // Edit-all = patch the schedule (payload / time / recurrence).
      const patch: Record<string, any> = { updated_at: new Date().toISOString() };
      const nextPayload = b.new_payload ?? b.payload;
      if (nextPayload && typeof nextPayload === "object") patch.payload = nextPayload;
      const nextTime = b.new_time ?? b.time_of_day;
      if (nextTime !== undefined) patch.time_of_day = String(nextTime);
      if (b.recurrence && typeof b.recurrence === "object") {
        const r = ScheduleRecurrence.safeParse(b.recurrence);
        if (!r.success) return err(c, "invalid recurrence", 400);
        patch.recurrence = r.data;
      }
      try {
        const schedule = await store.update<PlanSchedule>("plan_schedules", id, patch as Partial<PlanSchedule>);
        return ok(c, { schedule, scope: "all" });
      } catch (e) {
        return err(c, msgOf(e), 502);
      }
    }

    // scope=one (default) → upsert a plan_override with new_time / new_payload.
    const draft: Record<string, unknown> = {
      user: uid, schedule_id: id, scheduled_date: date, is_skipped: false,
      created_at: new Date().toISOString(),
    };
    const nextTime = b.new_time ?? b.time_of_day;
    if (nextTime !== undefined) draft.new_time = String(nextTime);
    const nextPayload = b.new_payload ?? b.payload;
    if (nextPayload && typeof nextPayload === "object") draft.new_payload = nextPayload;
    try {
      const override = await upsertOverride(store, id, date, draft);
      return ok(c, { override, scope: "one" });
    } catch (e) {
      return err(c, msgOf(e), 502);
    }
  });

  // ---- DELETE /api/plan/schedules/:id/occurrences/:date?scope=one|all — skip one or deactivate all.
  app.delete("/api/plan/schedules/:id/occurrences/:date", async (c) => {
    const uid = getUid(c);
    const store = platform.data.forUser(uid);
    const id = c.req.param("id");
    const date = c.req.param("date");
    const rec = await store.get<PlanSchedule>("plan_schedules", id);
    if (!rec) return err(c, "not found", 404);
    if (rec.user !== uid) return err(c, "forbidden", 403);

    if (c.req.query("scope") === "all") {
      try {
        const schedule = await store.update<PlanSchedule>("plan_schedules", id, {
          is_active: false, updated_at: new Date().toISOString(),
        } as Partial<PlanSchedule>);
        return ok(c, { schedule, scope: "all", deactivated: true });
      } catch (e) {
        return err(c, msgOf(e), 502);
      }
    }

    // scope=one (default) → upsert an is_skipped override.
    try {
      const override = await upsertOverride(store, id, date, {
        user: uid, schedule_id: id, scheduled_date: date, is_skipped: true, created_at: new Date().toISOString(),
      });
      return ok(c, { override, scope: "one", skipped: true });
    } catch (e) {
      return err(c, msgOf(e), 502);
    }
  });
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd ~/gitrepos/sate/core && npm test`
Expected: PASS — all six occurrence edit/delete tests green; every prior test still green.

- [ ] **Step 5: Typecheck**

Run: `cd ~/gitrepos/sate-cloud && npx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
cd ~/gitrepos/sate
git add core/src/api/plan.ts core/test/schedules.test.ts
git commit -m "feat(core): occurrence edit/delete this-vs-all (override upsert | schedule patch/deactivate)"
```

---

### Task 9: `POST /api/plan/accept` — the occurrence branch (materialize)

Replace the Phase 1 stub (which 400s `{schedule_id, scheduled_date}`) with real materialization (spec §5): create a `status:"logged"` entry from `schedule.payload` merged with the occurrence's override then the caller's `edits`, stamped with `plan_schedule_id` + `scheduled_date`, `logged_at` from date+time. Idempotent: a second accept of the same occurrence returns the existing entry (and the timeline then drops that date via Task 7's materialized-set). Reuses `findOverride` (Task 6) and `localInstantUTC` (Task 1).

**Files:**
- Modify: `core/src/api/plan.ts` (the `/api/plan/accept` handler — replace the occurrence-branch guard)
- Modify: `core/test/plan.test.ts` (replace the "occurrence branch 400s" test with real accept tests)

**Interfaces:**
- Consumes: `PlanSchedule`, `PlanOverride`, `Entry`, `Macros`, `findOverride`, `localInstantUTC`, `dayKey`, `dayIntakeTotals`, `macrosOf` (all already imported/defined in `plan.ts` after Tasks 1/6).
- Produces: `POST /api/plan/accept` body `{ schedule_id, scheduled_date, edits? }` → `{ entry, totals }`; idempotent; 404 unknown schedule; 409 skipped occurrence.

- [ ] **Step 1: Replace the Phase 1 stub test in `core/test/plan.test.ts`**

Delete the existing test block (lines that begin `test("POST /api/plan/accept 400s the occurrence branch (phase 2)"` through its closing `});`) and append these in its place:

```typescript
import { TEST_EMAIL } from "./mem.ts"; // (already imported at top; keep a single import)

async function seedSchedule(platform: any, over: Record<string, unknown> = {}) {
  const store = platform.data.forUser(TEST_EMAIL);
  return await store.create("plan_schedules", {
    user: TEST_EMAIL, kind: "food", name: "Overnight oats",
    payload: { kcal: 300, description: "Overnight oats", macros: { protein: 12, carbs: 40, fat: 8 } },
    recurrence: { unit: "daily", interval: 1 }, time_of_day: "07:30", tz_offset_min: 0,
    active_from: "2026-07-01", is_active: true, ...over,
  });
}

test("POST /api/plan/accept (occurrence) materializes a logged entry from the schedule payload", async () => {
  const { req, platform } = client();
  const sched = await seedSchedule(platform);
  const res = await req("/api/plan/accept", { method: "POST", body: JSON.stringify({ schedule_id: sched.id, scheduled_date: "2026-07-24" }) });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.entry.status, "logged");
  assert.equal(body.entry.plan_schedule_id, sched.id);
  assert.equal(body.entry.scheduled_date, "2026-07-24");
  assert.equal(body.entry.day, "2026-07-24");
  assert.equal(body.entry.logged_at, "2026-07-24T07:30:00.000Z");
  assert.equal(body.entry.kcal, 300);
  assert.equal(body.entry.macros.protein, 12);
  assert.equal(body.totals.kcal, 300, "materialized entry counts");
});

test("POST /api/plan/accept (occurrence) is idempotent — a second accept returns the same entry", async () => {
  const { req, platform } = client();
  const sched = await seedSchedule(platform);
  const first = await (await req("/api/plan/accept", { method: "POST", body: JSON.stringify({ schedule_id: sched.id, scheduled_date: "2026-07-24" }) })).json();
  const second = await (await req("/api/plan/accept", { method: "POST", body: JSON.stringify({ schedule_id: sched.id, scheduled_date: "2026-07-24" }) })).json();
  assert.equal(second.entry.id, first.entry.id, "no duplicate materialization");
  assert.equal(second.totals.kcal, 300, "no double-count");
  const store = platform.data.forUser(TEST_EMAIL);
  const { items } = await store.list("entries", {});
  assert.equal(items.length, 1);
});

test("POST /api/plan/accept (occurrence) applies the override then the caller's edits", async () => {
  const { req, platform } = client();
  const sched = await seedSchedule(platform);
  const store = platform.data.forUser(TEST_EMAIL);
  await store.create("plan_overrides", { user: TEST_EMAIL, schedule_id: sched.id, scheduled_date: "2026-07-24", new_time: "09:00", new_payload: { kcal: 500, description: "Bigger oats", macros: { protein: 20, carbs: 60, fat: 10 } } });
  const res = await req("/api/plan/accept", { method: "POST", body: JSON.stringify({ schedule_id: sched.id, scheduled_date: "2026-07-24", edits: { kcal: 450 } }) });
  const body = await res.json();
  assert.equal(body.entry.logged_at, "2026-07-24T09:00:00.000Z", "override new_time applied");
  assert.equal(body.entry.description, "Bigger oats", "override new_payload applied");
  assert.equal(body.entry.kcal, 450, "caller edit wins over override payload");
});

test("POST /api/plan/accept (occurrence) 404s an unknown schedule", async () => {
  const { req } = client();
  const res = await req("/api/plan/accept", { method: "POST", body: JSON.stringify({ schedule_id: "nope", scheduled_date: "2026-07-24" }) });
  assert.equal(res.status, 404);
});

test("POST /api/plan/accept (occurrence) 409s a skipped occurrence", async () => {
  const { req, platform } = client();
  const sched = await seedSchedule(platform);
  const store = platform.data.forUser(TEST_EMAIL);
  await store.create("plan_overrides", { user: TEST_EMAIL, schedule_id: sched.id, scheduled_date: "2026-07-24", is_skipped: true });
  const res = await req("/api/plan/accept", { method: "POST", body: JSON.stringify({ schedule_id: sched.id, scheduled_date: "2026-07-24" }) });
  assert.equal(res.status, 409);
});
```

Note: `TEST_EMAIL` is already imported at the top of `plan.test.ts` (line 3). Do NOT add a duplicate import — the `import { TEST_EMAIL } from "./mem.ts";` line above is a reminder, not a new statement; if your editor added a second import, remove it.

- [ ] **Step 2: Run to verify it fails**

Run: `cd ~/gitrepos/sate/core && npm test`
Expected: FAIL — the occurrence accept still 400s (Phase 1 stub), so materialize/idempotent/override/404/409 assertions fail.

- [ ] **Step 3: Replace the occurrence-branch guard in `core/src/api/plan.ts`**

In the `/api/plan/accept` handler, REPLACE this Phase 1 block:

```typescript
    if (!b.entry_id && b.schedule_id) {
      return err(c, "accepting a recurring occurrence is not supported yet (phase 2)", 400);
    }
```

with the materialization branch:

```typescript
    // Occurrence branch (phase 2): materialize a logged entry from a recurring schedule occurrence.
    if (!b.entry_id && b.schedule_id && b.scheduled_date) {
      const scheduleId = String(b.schedule_id);
      const date = String(b.scheduled_date);

      // Idempotent: if this occurrence already materialized, return that entry (no double-count).
      try {
        const { items } = await store.list<Entry>("entries", {
          where: [
            { field: "plan_schedule_id", op: "==", value: scheduleId },
            { field: "scheduled_date", op: "==", value: date },
          ],
          limit: 1,
        });
        const existing = items[0];
        if (existing) {
          const eday = existing.day || dayKey(existing.logged_at, num(existing.tz_offset_min));
          return ok(c, { entry: existing, totals: await dayIntakeTotals(store, eday) });
        }
      } catch {
        /* fall through to create */
      }

      const sched = await store.get<PlanSchedule>("plan_schedules", scheduleId);
      if (!sched) return err(c, "schedule not found", 404);
      if (sched.user !== uid) return err(c, "forbidden", 403);

      const override = await findOverride(store, scheduleId, date);
      if (override?.is_skipped) return err(c, "occurrence was skipped", 409);

      const edits = (b.edits && typeof b.edits === "object" ? b.edits : {}) as Record<string, any>;
      // payload = schedule.payload  <-  override.new_payload  <-  (numeric edits applied below)
      const payload = { ...(sched.payload || {}), ...(override?.new_payload || {}) } as Record<string, any>;
      const time = String(edits.time_of_day || override?.new_time || sched.time_of_day || "12:00");
      const tz = edits.tz_offset_min !== undefined ? num(edits.tz_offset_min) : num(sched.tz_offset_min);
      const logged_at = localInstantUTC(date, time, tz);
      const day = dayKey(logged_at, tz);
      const activity = sched.kind === "activity";

      const draft: Record<string, any> = {
        user: uid,
        kind: sched.kind,
        status: "logged",
        plan_schedule_id: scheduleId,
        scheduled_date: date,
        description: String(edits.description ?? payload.description ?? sched.name).slice(0, 2000),
        note: payload.note !== undefined ? String(payload.note).slice(0, 2000) : undefined,
        source: "plan",
        kcal: edits.kcal !== undefined ? num(edits.kcal) : num(payload.kcal),
        items: Array.isArray(payload.items) ? payload.items : undefined,
        logged_at,
        tz_offset_min: tz,
        day,
      };
      if (activity) {
        draft.duration_min = edits.duration_min !== undefined ? num(edits.duration_min) : num(payload.duration_min);
        if (edits.distance !== undefined) draft.distance = num(edits.distance);
        else if (payload.distance !== undefined) draft.distance = num(payload.distance);
        if (payload.intensity !== undefined) draft.intensity = String(payload.intensity);
      } else {
        const m = macrosOf(payload.macros);
        for (const k of ["protein", "carbs", "fat", "fiber", "sugar", "sodium", "sat_fat"] as const) {
          if (edits[k] !== undefined) (m as any)[k] = num(edits[k]);
        }
        draft.macros = m;
      }

      try {
        const entry = await store.create<Entry>("entries", draft as Omit<Entry, "id">);
        return ok(c, { entry, totals: await dayIntakeTotals(store, day) });
      } catch (e) {
        return err(c, msgOf(e), 502);
      }
    }
    // A schedule_id with no scheduled_date is malformed.
    if (!b.entry_id && b.schedule_id) return err(c, "scheduled_date is required", 400);
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd ~/gitrepos/sate/core && npm test`
Expected: PASS — the five occurrence-accept tests green; the Phase 1 one-off accept tests (flip, edits, idempotent, 404, 403, missing-id) still green; every other test still green.

- [ ] **Step 5: Typecheck**

Run: `cd ~/gitrepos/sate-cloud && npx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
cd ~/gitrepos/sate
git add core/src/api/plan.ts core/test/plan.test.ts
git commit -m "feat(core): POST /api/plan/accept occurrence branch — materialize logged entry (idempotent)"
```

---

### Task 10: Full-suite green + typecheck gate + sync to sate-cloud

The final gate: whole suite green, core typecheck clean, and the `core/` change reflected into the sate-cloud subtree. No new behavior — verification + sync.

**Files:**
- None new. Verification + subtree sync.

- [ ] **Step 1: Run the whole suite**

Run: `cd ~/gitrepos/sate/core && npm test`
Expected: PASS — projector (schedule) + plan-schema + schedules (CRUD + occurrence) + timeline + plan (one-off + occurrence accept) + Phase 1 (harness/schema/honesty) all green; `ℹ fail 0`.

- [ ] **Step 2: Typecheck core via sate-cloud**

Run: `cd ~/gitrepos/sate-cloud && npx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 3: Confirm git state + the phase-2 commits**

Run: `cd ~/gitrepos/sate && git log --oneline -10 && git status --porcelain`
Expected: the nine task commits (Tasks 1–9) present; no uncommitted changes.

- [ ] **Step 4: Sync `core/` into sate-cloud (subtree)**

Per the `sate-core-unification` memory, sate-cloud vendors `core/` as a subtree and MUST stay byte-identical. Use the repo's `scripts/dist-core.sh` sync tool — **run it with `bash`, not `sh`** — and coordinate the exact sync/push step with the user (this plan's scope is core-side; the sate-cloud PR/deploy is a follow-up).

Run (verify byte-identical after sync): `diff -rq ~/gitrepos/sate/core/src ~/gitrepos/sate-cloud/core/src`
Expected: no differences once synced.

- [ ] **Step 5: Live smoke test on sate.health (after sate-cloud deploy)**

Using the established Firebase-custom-token harness against the `god` account, on the deployed Cloud revision: `POST /api/plan/schedules` a daily food schedule → `GET /api/timeline?from=<today>&to=<+3d>` shows projected occurrences with no total impact → `POST /api/plan/accept {schedule_id, scheduled_date}` materializes a logged entry (`GET /api/me` totals now reflect it) → `GET /api/timeline` no longer shows that occurrence → edit-one (`PATCH .../occurrences/:date {scope:"one", new_time}`) and delete-one (`DELETE .../occurrences/:date?scope=one`) → `DELETE /api/plan/schedules/:id` to clean up. Document the result. (Runs only after the sate-cloud deploy in the follow-up; noted here so Phase 2 isn't marked "done" until verified live.)

---

## Self-Review

**Spec coverage (Phase 2 scope = spec §13.2: §2.2, §2.3, §4, §6, §12 projector priorities):**

| Spec | Requirement | Task |
|---|---|---|
| §2.2 | `plan_schedules` collection + shape (kind/name/payload/recurrence/time_of_day/tz_offset_min/active_from/to/is_active) | Task 5 (Zod) + Task 1 (projector interface) |
| §2.2 | `unit: daily|weekly|monthly`, `interval>=1`, `by_weekday`, `day_of_month`; `once` is NOT a unit | Task 5 (`RECURRENCE_UNITS`), Tasks 1–3 (each unit) |
| §2.3 | `plan_overrides` collection + shape (schedule_id/scheduled_date/is_skipped/new_time/new_payload) | Task 5 (Zod) + Task 1 (interface); applied Task 4 |
| §4.1 | `GET /api/timeline?from&to&scope&tz` merging stored entries + occurrences; drop skipped + materialized; tag `state`/`origin`/(schedule_id, scheduled_date, synthetic id) | Task 7 |
| §4.2 | pure `projectOccurrences(schedules, overrides, fromDate, toDate, todayLocal)`; future-only; daily/weekly/monthly date math; clamp; active bounds; local wall-clock → logged_at/day | Tasks 1–4 |
| §5 | occurrence accept — materialize `status:"logged"` entry from payload+override+edits, plan_schedule_id+scheduled_date, idempotent | Task 9 |
| §6 | edit occurrence one→override / all→schedule; delete one→skip / all→deactivate; schedule CRUD | Tasks 6, 8 |
| §12 | projector unit tests: daily, weekly-by-weekday, monthly, interval>1, active_from/to bounds, month clamp, tz/time_of_day, future-only | Tasks 1–3 |
| §12 | overrides: skip drops; new_time/new_payload apply | Task 4 |
| §12 | materialized dates drop | Task 7 (timeline-level; see resolution below) |
| §12 | accept idempotency (one entry) | Task 9 |
| §12 | honesty regression: occurrences/planned never in totals | Task 7 test ("occurrences never enter day totals") + Phase 1 honesty suite (unchanged) |
| §12 | this/all semantics | Task 8 |

**Resolved ambiguity — "materialized dates drop":** spec §4.1 places materialized-date dropping in the timeline endpoint (it needs the stored entries), while the §12 bullet lists it alongside overrides. The projector's pinned 5-arg signature has no access to stored entries, so it CANNOT drop materialized dates and stay pure. Resolution: the projector handles override-driven drops (skip); the **timeline route** (Task 7) computes the materialized `{schedule_id}:{date}` set from stored entries and drops those occurrences — tested in `timeline.test.ts` ("drops an already-materialized occurrence date"). This keeps the projector's signature exactly as the spec dictates and is called out for the reader's ruling if a different split is wanted.

**Deferred (not Phase 2):** §4.3 Home infinite-scroll UI, §7 recipe suggester, §8 Plan tab, §9 nav/buttons, §10 coach plan-edit are Phases 3–6. `plan_summary`/`allergies` profile fields (§2.4) belong to Phases 4/5. Firestore composite indexes (§11) are noted inline (Task 7 uses a single-inequality `day>=from` query + in-code upper bound specifically to avoid needing one).

**Placeholder scan:** No TBD/TODO-in-code/"add validation"/"similar to Task N". Every code step shows complete code; every test step shows full assertions; every run step gives the exact command + expected result. The one eslint-disable (Task 1's unused `overrides`) is a real repo convention and is explicitly removed in Task 4. ✓

**Type consistency:**
- The projector's structural interfaces (`PlanSchedule`/`PlanOverride`/`ScheduleRecurrence`/`Occurrence`, `domain/schedule.ts`, Task 1) and the Zod-inferred types (`schema/index.ts`, Task 5) share field names and types exactly — verified at the `projectOccurrences(schedules, overrides, …)` call in Task 7 (schema types → domain params), which `tsc` checks. Any drift fails Step 5's typecheck.
- `localInstantUTC(date, time, tzOffsetMin)` — defined Task 1, reused unchanged in Task 9.
- `findOverride`/`upsertOverride(store, scheduleId, date, patch)` — defined Task 6, reused in Task 8.
- Occurrence id format `"{scheduleId}:{date}"` — identical in the projector (Task 1), the timeline materialized-set check (Task 7), and BE's convention.
- `dayKey(localInstantUTC(d,t,tz), tz) === d` — the tz round-trip invariant asserted in Task 1 (`localInstantUTC`/tz tests) and relied on by Task 9 (materialized `day === scheduled_date`).
- `payload` is `Record<string, unknown>` everywhere (domain interface, Zod `z.record(z.string(), z.unknown())`, route merge); `kind` is `"food"|"activity"` (`ENTRY_KINDS`) in schema, projector, and materialized entry.
- Route return shapes are consistent: CRUD → `{ schedule(s) }`/`{ deleted }`; occurrence edit/delete → `{ override|schedule, scope, ... }`; timeline → `{ from, to, scope, items }`; accept → `{ entry, totals }` (matching Phase 1's accept). ✓

**Projector test recipe — verified runnable:** before finalizing, a throwaway `src/domain/schedule_stub.ts` + `test/zzz_throwaway.test.ts` were bundled by the existing `test/run.sh` (esbuild → cjs → `node --test`) and executed a pure-function assertion (`✔ ... pure unit test (no HTTP)`, 16 pass / 0 fail), then removed. The plan's projector commands (`npm test` picking up `test/schedule.test.ts` importing `../src/domain/schedule.ts`) are therefore real.
