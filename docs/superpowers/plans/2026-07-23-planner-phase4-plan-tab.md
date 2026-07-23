# Planner Phase 4 — Plan Tab (Your-Plan card + Scheduled manager + persisted plan_summary) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the **Plan tab** (spec §8, §9) — a management surface, distinct from Home's timeline. It has two halves plus the shared add buttons: (1) a **"Your Plan" card** rendering the tracked targets (`goal_kcal`, protein/carbs/fat, weight goal + pace, `method`, `activity_level`) reusing the ring components, editable inline via the existing Goals dialog, with **"Show full plan"** opening a modal that renders the persisted Coach narrative `profiles.plan_summary`; (2) a **"Scheduled" section** listing `plan_schedules` (from `GET /api/plan/schedules`) each with a recurrence summary ("Every weekday · 7:30am") + next occurrence, tap-to-edit (all-scope) and delete-with-confirm; (3) the same **`Log` · `Plan`** button pair as Home. Nav becomes **Home · Plan · Coach · History**. A small additive backend slice adds two optional profile fields — `plan_summary` + `allergies` — surfaced by `GET /api/me` and persisted by `PATCH /api/goals`; onboarding's existing AI-plan step is wired to persist the narrative it already generates.

**Architecture:** Split cleanly along the Phase 3 lines. The backend slice (two additive Zod fields + their read/write wiring) lands in `@sate/core` (`schema/index.ts` + `api/profile.ts`) and is full-TDD via the existing in-memory API harness (`core/test/*.test.ts`, `client()` + `app.request`). The **riskiest UI logic** — the recurrence-summary formatter and the next-occurrence computation — lands in the pure, import-free `core/src/web/planner.js` (extended from Phase 3), unit-tested directly by the esbuild + `node:test` harness (`core/test/planner-ui.test.ts`); `nextOccurrence` mirrors the Phase 2 projector's `firesOn`/active-bounds date math (the same client-copy pattern as `localInstantUTC`), so the two cannot drift and the client never re-implements projection loosely. The DOM is a **new tab view `core/src/web/views/plan.js`** (container `#view-plan`, the `home.js`/`history.js` shape) plus nav edits (`index.html` header tabs + bottom tab bar + a `#view-plan` section, `app.js` registration import), and a small **edit-mode extension to Phase 3's `views/planevent.js`** so tapping a schedule reuses the plan-an-event sheet to `PATCH` it. DOM glue stays thin (it calls the tested pure helpers + `lib.js` components) and is verified by explicit LIVE steps on sate.health (no jsdom/browser harness exists or is introduced).

**Tech Stack:** TypeScript (Node 24 via esbuild bundle + native `node:test`) for the backend slice; framework-free browser ES modules for the SPA; the existing Hono API (Phases 1–2, on `v2`). No new runtime or dev dependencies. The deployed SPA is content-hash-fingerprinted by sate-cloud's `scripts/build-web.mjs` (`app.js` + its `lib.js`/`views/*`/`planner.js` graph → `app.<hash>.js`, immutable cache; `index.html` is `no-store`).

## Global Constraints

Every task inherits these:

- **Cloud edition, core-first.** All changes land in `@sate/core` (`core/src/...`). The Hosted (`pb_hooks`/`pb_public`) port is explicitly OUT OF SCOPE.
- **Additive schema only.** `plan_summary` + `allergies` are `z.string().optional()` — no default, no migration. Existing profiles that lack them parse and read back `""`. No other `Profile` field changes.
- **The honesty rule (non-negotiable).** The Plan card's numbers come from the **server** — `me()` (`GET /api/me`, which echoes the saved `goals`) and/or `POST /api/plan/compute` (the deterministic nutrition engine). The client NEVER re-sums or re-derives targets locally. The Scheduled section shows a projected *next date* (a label), never a total. Nothing on the Plan tab counts toward intake/burn.
- **The pure module imports NOTHING.** `core/src/web/planner.js` has no `import`, no DOM, no `window`/`document`. `nextOccurrence`'s date math is deterministic (a `todayLocal` is passed in — NO `Date.now()`, NO no-arg `new Date()`; `new Date(<explicit ms/UTC>)` / `Date.parse(<string>)` are allowed). This is what makes it node-testable and is where the maximum UI logic lives.
- **Thin DOM glue.** `views/plan.js` and the `planevent.js` edit extension compute nothing risky inline — they call `planner.js` (`recurrenceSummary`, `nextOccurrence`, `buildPlanRequest`) and `lib.js` components (`ringEl`, `tripleRingCard`, `dialog`, `confirmDialog`, `sheet`, `el`, `esc`, `api`, `toast`, `openView`, `registerView`, `todayISO`, `fmt`, `me`, `refreshMe`). Escape ALL user/AI text with `esc()` — `plan_summary`, `allergies`, and every schedule `name` are user/AI-authored.
- **Reuse, don't fork.** The Plan card's inline edit REUSES `views/goals.js` (`openView("goals")`), not a new targets editor. The schedule tap-to-edit REUSES `views/planevent.js` in an edit mode (PATCH), not a second recurrence editor. The add buttons REUSE the `.logplan` markup + wiring shape from Home (Phase 3). The ring visuals REUSE `ringEl`/`tripleRingCard` from `lib.js`.
- **No asset cache-busting query strings on JS/CSS.** The build content-hashes `app.js`/`style.css`; do NOT add `?vN`. The new `views/plan.js` MUST be reachable from `app.js`'s import graph (the registration import in Task 4) or `build-web.mjs` drops it as a dead file. New CSS goes into `core/src/web/style.css` (served content-hashed).
- **Scope stays Phase-4.** This phase does NOT build the recipe suggester (§7, Phase 5 — leave the disabled seam Phase 3 already placed in `planevent`) and does NOT build coach plan-edit (§10, Phase 6). Persisting `plan_summary` here is the *storage + render* half only; Phase 6's `/api/plan/apply` will refresh it later. `allergies` is *persisted + editable* here; its consumption by `recipe_suggest`/the coach prompt is Phase 5.
- **Test/typecheck gates:** pure-module + backend tests via `cd ~/gitrepos/sate/core && npm test`; the typecheck gate `cd ~/gitrepos/sate-cloud && npx tsc --noEmit` must stay exit 0 (it does not typecheck `.js` web files, but must not regress from the schema/profile change).

---

## File Structure

- **Modify `core/src/schema/index.ts`** — add `plan_summary?` + `allergies?` to `Profile` (both `z.string().optional()`, additive). Task 1.
- **Modify `core/src/api/profile.ts`** — `profileView()` echoes `plan_summary`/`allergies`; `PATCH /api/goals` accepts + length-caps them. Task 1.
- **Create `core/test/profile-plan.test.ts`** — backend TDD for the two fields (PATCH → `GET /api/me` round-trip, caps, non-string ignore, backward-compat). Task 1.
- **Modify `core/src/web/planner.js`** — add pure `recurrenceSummary(schedule)` (Task 2) + `nextOccurrence(schedule, todayLocal, overrides?)` (Task 3).
- **Modify `core/test/planner-ui.test.ts`** — append pure tests for both helpers. Tasks 2–3.
- **Modify `core/src/web/index.html`** — insert the `Plan` tab into the header `.tabs` and the bottom `.tabbar` (both between Home and Coach), and add the `#view-plan` section. Task 4.
- **Create `core/src/web/views/plan.js`** — the Plan tab view (`registerView("plan", { container:"#view-plan", render })`): Your-Plan card (Task 5), Scheduled section (Task 6), Log·Plan buttons (Task 7).
- **Modify `core/src/web/app.js`** — add `import "./views/plan.js";` (registration side effect). Task 4.
- **Modify `core/src/web/views/planevent.js`** — accept `open({ schedule, mode:"edit" })`: prefill from the schedule + `PATCH /api/plan/schedules/:id` on submit (reusing `buildPlanRequest`'s schedule body). Task 6.
- **Modify `core/src/web/views/onboarding.js`** — after the AI-plan step generates the narrative, `PATCH /api/goals { plan_summary }` to persist it. Task 5.
- **Modify `core/src/web/style.css`** — Plan-tab card + scheduled-list + full-plan-modal styles. Tasks 5–7.

**Verification-approach note (read before Task 1):** Backend (the two profile fields, `/api/me`, `/api/goals`) → **full TDD** via the API harness (`client()` + `app.request`), exactly like Phases 1–2. Pure SPA helpers (`recurrenceSummary`, `nextOccurrence`) → **full TDD** with `node:test` in `planner-ui.test.ts` (failing → implement → green); a throwaway probe of both helpers was bundled by `test/run.sh` and run green (88 pass) before this plan was finalized, so the recipe is real. DOM (the Plan tab view, nav, card, scheduled list, add buttons, planevent edit mode) → **complete code + explicit LIVE steps** on sate.health, since the repo has no jsdom/browser harness and none is introduced — justified because the row/summary/next-date content all comes from the tested pure helpers, so a browser is only needed to confirm layout/wiring, which the live steps do.

---

### Task 1: Backend — persist + expose `plan_summary` and `allergies` (schema + `/api/me` + `PATCH /api/goals`)

Add the two additive profile fields the Plan tab needs: `plan_summary` (the Coach's setup narrative, rendered by "Show full plan") and `allergies` (remembered dietary restrictions; Phase 5 feeds them to recipes/coach). Surface both in the `/api/me` and `/api/goals` responses (`profileView`), and accept them in `PATCH /api/goals` with sane length caps. Backend-only, fully TDD via the harness.

**Files:**
- Modify: `core/src/schema/index.ts`
- Modify: `core/src/api/profile.ts`
- Create: `core/test/profile-plan.test.ts`

**Interfaces:**
- Produces: `Profile.plan_summary?: string`, `Profile.allergies?: string`; `profileView()` gains `plan_summary`/`allergies` (default `""`); `PATCH /api/goals` accepts `{ plan_summary?, allergies? }` (strings, capped, only-when-provided).

- [ ] **Step 1: Write the failing test `core/test/profile-plan.test.ts`**

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { client, TEST_EMAIL } from "./mem.ts";

test("GET /api/me returns empty plan_summary/allergies for a fresh profile (backward-compat)", async () => {
  const { req } = client();
  const res = await req("/api/me?tz=0");
  assert.equal(res.status, 200);
  const me = await res.json();
  assert.equal(me.plan_summary, "");
  assert.equal(me.allergies, "");
});

test("PATCH /api/goals persists plan_summary + allergies; GET /api/me echoes them", async () => {
  const { req } = client();
  const patch = await req("/api/goals", {
    method: "PATCH",
    body: JSON.stringify({ plan_summary: "Aim for 1,800 kcal · 150g protein to reach 180 lb by Oct.", allergies: "no dairy, shellfish allergy" }),
  });
  assert.equal(patch.status, 200);
  const pv = await patch.json();
  assert.equal(pv.plan_summary, "Aim for 1,800 kcal · 150g protein to reach 180 lb by Oct.");
  assert.equal(pv.allergies, "no dairy, shellfish allergy");
  const me = await (await req("/api/me?tz=0")).json();
  assert.equal(me.plan_summary, "Aim for 1,800 kcal · 150g protein to reach 180 lb by Oct.");
  assert.equal(me.allergies, "no dairy, shellfish allergy");
});

test("PATCH /api/goals leaves the fields untouched when not provided, and clears with an empty string", async () => {
  const { req } = client();
  await req("/api/goals", { method: "PATCH", body: JSON.stringify({ plan_summary: "keep me", allergies: "peanuts" }) });
  // A patch that omits them must not wipe them.
  await req("/api/goals", { method: "PATCH", body: JSON.stringify({ goal_kcal: 2000 }) });
  let me = await (await req("/api/me?tz=0")).json();
  assert.equal(me.plan_summary, "keep me");
  assert.equal(me.allergies, "peanuts");
  // An explicit empty string clears.
  await req("/api/goals", { method: "PATCH", body: JSON.stringify({ allergies: "" }) });
  me = await (await req("/api/me?tz=0")).json();
  assert.equal(me.allergies, "");
  assert.equal(me.plan_summary, "keep me");
});

test("PATCH /api/goals coerces non-strings and caps length", async () => {
  const { req } = client();
  const long = "x".repeat(9000);
  const res = await req("/api/goals", { method: "PATCH", body: JSON.stringify({ plan_summary: long, allergies: 42 }) });
  const pv = await res.json();
  assert.equal(pv.plan_summary.length, 8000); // capped
  assert.equal(pv.allergies, "42");           // coerced to string
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd ~/gitrepos/sate/core && npm test`
Expected: FAIL — `me.plan_summary`/`me.allergies` are `undefined` (fields not in `profileView`; `PATCH` ignores them).

- [ ] **Step 3: Add the two optional fields to `Profile` in `core/src/schema/index.ts`**

Inside `export const Profile = z.object({ ... })`, immediately after the `edition:` field (the last field before the closing `})`), add:

```typescript
  // The Coach's setup plan narrative — shown by the Plan tab's "Show full plan". Persisted at
  // onboarding's AI-plan step and refreshed whenever the plan changes (Phase 6 coach-edit). Optional
  // and additive: existing profiles read back "" (see profileView). (spec §2.4)
  plan_summary: z.string().optional(),
  // Remembered dietary restrictions/allergies (free-text, e.g. "no dairy, shellfish allergy").
  // Editable in Settings and the Plan tab; auto-applied to recipe suggestions + the coach in Phase 5.
  allergies: z.string().optional(),
```

- [ ] **Step 4: Echo both in `profileView()` in `core/src/api/profile.ts`**

In `profileView(p: Profile)`, add to the returned object (e.g. after `checkin_freq:`):

```typescript
    plan_summary: p.plan_summary || "",
    allergies: p.allergies || "",
```

- [ ] **Step 5: Accept both in `PATCH /api/goals` in `core/src/api/profile.ts`**

In the `PATCH /api/goals` handler, alongside the other `if (b.<field> !== undefined)` blocks (e.g. after the `name` block), add:

```typescript
    // Plan narrative (Coach setup text) + remembered allergies. Strings only; only touched when
    // provided so an unrelated goals PATCH never wipes them. plan_summary can be long (a paragraph);
    // allergies is a short line. (spec §2.4)
    if (b.plan_summary !== undefined) patch.plan_summary = String(b.plan_summary).slice(0, 8000);
    if (b.allergies !== undefined) patch.allergies = String(b.allergies).slice(0, 2000);
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd ~/gitrepos/sate/core && npm test`
Expected: PASS — the four `profile-plan` tests green; every Phase 1/2/3 test still green.

- [ ] **Step 7: Typecheck (must not regress)**

Run: `cd ~/gitrepos/sate-cloud && npx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 8: Commit**

```bash
cd ~/gitrepos/sate
git add core/src/schema/index.ts core/src/api/profile.ts core/test/profile-plan.test.ts
git commit -m "feat(core): persist + expose profile plan_summary + allergies (Planner phase 4)"
```

---

### Task 2: Pure — recurrence-summary formatter (`recurrenceSummary`)

The Scheduled section (§8.2) labels each schedule with a human recurrence summary ("Every weekday · 7:30am", "Every day · 6:00pm", "Monthly on day 31 · 9:00am"). Extract that formatting as a pure, tested function in `planner.js` so the DOM row is a trivial template.

**Files:**
- Modify: `core/src/web/planner.js`
- Test: `core/test/planner-ui.test.ts` (append)

**Interfaces:**
- Produces: `recurrenceSummary(schedule): string` — `schedule` carries `recurrence{unit,interval,by_weekday?,day_of_month?}`, `time_of_day` ("HH:mm"), `active_from` ("YYYY-MM-DD"). Returns `"<cadence> · <time>"` (time omitted if absent).

- [ ] **Step 1: Append the failing tests to `core/test/planner-ui.test.ts`**

```typescript
import { recurrenceSummary } from "../src/web/planner.js";

const wd = (recurrence, time = "07:30", active_from = "2026-07-01") =>
  ({ recurrence, time_of_day: time, active_from });

test("recurrenceSummary: daily", () => {
  assert.equal(recurrenceSummary(wd({ unit: "daily", interval: 1 }, "18:00")), "Every day · 6:00pm");
  assert.equal(recurrenceSummary(wd({ unit: "daily", interval: 2 }, "06:00")), "Every 2 days · 6:00am");
});

test("recurrenceSummary: weekly weekday-set collapses Mon–Fri to 'Every weekday'", () => {
  assert.equal(recurrenceSummary(wd({ unit: "weekly", interval: 1, by_weekday: [1, 2, 3, 4, 5] })), "Every weekday · 7:30am");
  assert.equal(recurrenceSummary(wd({ unit: "weekly", interval: 1, by_weekday: [1, 3, 5] }, "06:00")), "Weekly on Mon, Wed, Fri · 6:00am");
  assert.equal(recurrenceSummary(wd({ unit: "weekly", interval: 2, by_weekday: [0, 6] }, "09:00")), "Every 2 weeks on Sun, Sat · 9:00am");
});

test("recurrenceSummary: monthly uses day_of_month, else the active_from day-of-month", () => {
  assert.equal(recurrenceSummary(wd({ unit: "monthly", interval: 1, day_of_month: 15 }, "12:00")), "Monthly on day 15 · 12:00pm");
  assert.equal(recurrenceSummary(wd({ unit: "monthly", interval: 3 }, "08:00", "2026-07-05")), "Every 3 months on day 5 · 8:00am");
});

test("recurrenceSummary: midnight formats as 12:00am; missing time drops the suffix", () => {
  assert.equal(recurrenceSummary(wd({ unit: "daily", interval: 1 }, "00:00")), "Every day · 12:00am");
  assert.equal(recurrenceSummary({ recurrence: { unit: "daily", interval: 1 }, active_from: "2026-07-01" }), "Every day");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd ~/gitrepos/sate/core && npm test`
Expected: FAIL — `recurrenceSummary` is not exported.

- [ ] **Step 3: Add `recurrenceSummary` (+ its two private helpers) to `core/src/web/planner.js`**

Append after the existing `buildPlanRequest` (end of the module):

```javascript
// ============================================================ Plan-tab pure helpers (phase 4)
// Weekday labels (0..6 = Sun..Sat), matching the projector's getUTCDay() convention.
const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// "HH:mm" (24h) → a friendly "7:30am" / "12:00pm" / "12:00am". Returns "" for a missing/blank time.
function prettyTime(time) {
  const [h, m] = String(time || "").split(":").map((x) => Number(x));
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd ~/gitrepos/sate/core && npm test`
Expected: PASS — the four `recurrenceSummary` tests green; Phase 1/2/3 still green.

- [ ] **Step 5: Commit**

```bash
cd ~/gitrepos/sate
git add core/src/web/planner.js core/test/planner-ui.test.ts
git commit -m "feat(web): pure recurrenceSummary formatter (Planner phase 4)"
```

---

### Task 3: Pure — next-occurrence computation (`nextOccurrence`)

Each Scheduled row shows the next upcoming occurrence date. Compute it with a pure helper that mirrors the Phase 2 projector's `firesOn` + active-bounds math (the same client-copy discipline as `localInstantUTC`), so the label matches the server timeline exactly and the client never re-implements projection loosely.

**Files:**
- Modify: `core/src/web/planner.js`
- Test: `core/test/planner-ui.test.ts` (append)

**Interfaces:**
- Produces: `nextOccurrence(schedule, todayLocal, overrides?): string | null` — the first calendar date `≥ todayLocal` (and `≥ active_from`, `≤ active_to` if set) on which the schedule fires and which is NOT skip-overridden; `null` if inactive or none within a bounded 366-day forward window.

- [ ] **Step 1: Append the failing tests to `core/test/planner-ui.test.ts`**

```typescript
import { nextOccurrence } from "../src/web/planner.js";

const weekday = { id: "s1", is_active: true, active_from: "2026-07-01", time_of_day: "07:30",
  recurrence: { unit: "weekly", interval: 1, by_weekday: [1, 2, 3, 4, 5] } };
const daily = { id: "s2", is_active: true, active_from: "2026-07-01", time_of_day: "18:00",
  recurrence: { unit: "daily", interval: 1 } };
const monthly31 = { id: "s3", is_active: true, active_from: "2026-01-31", time_of_day: "09:00",
  recurrence: { unit: "monthly", interval: 1, day_of_month: 31 } };

test("nextOccurrence returns today when the schedule fires today", () => {
  // 2026-07-23 is a Thursday → the weekday schedule fires today.
  assert.equal(nextOccurrence(weekday, "2026-07-23"), "2026-07-23");
});

test("nextOccurrence skips forward over non-firing days", () => {
  // 2026-07-25 is Saturday → next weekday occurrence is Monday 2026-07-27.
  assert.equal(nextOccurrence(weekday, "2026-07-25"), "2026-07-27");
});

test("nextOccurrence clamps a monthly day-31 to the month's last day", () => {
  assert.equal(nextOccurrence(monthly31, "2026-02-01"), "2026-02-28");
});

test("nextOccurrence honors a skip override on the otherwise-next date", () => {
  assert.equal(
    nextOccurrence(daily, "2026-07-23", [{ schedule_id: "s2", scheduled_date: "2026-07-23", is_skipped: true }]),
    "2026-07-24",
  );
});

test("nextOccurrence respects active_from (future start) and active_to (past end)", () => {
  const future = { ...daily, active_from: "2026-08-10" };
  assert.equal(nextOccurrence(future, "2026-07-23"), "2026-08-10");
  const ended = { ...daily, active_to: "2026-07-20" };
  assert.equal(nextOccurrence(ended, "2026-07-23"), null);
});

test("nextOccurrence returns null for an inactive schedule", () => {
  assert.equal(nextOccurrence({ ...daily, is_active: false }, "2026-07-23"), null);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd ~/gitrepos/sate/core && npm test`
Expected: FAIL — `nextOccurrence` is not exported.

- [ ] **Step 3: Add `nextOccurrence` (+ its private `firesOn`) to `core/src/web/planner.js`**

Append after `recurrenceSummary`. (`addDays` + `ymdToUTC` already exist at the top of the module from Phase 3; reuse them.)

```javascript
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd ~/gitrepos/sate/core && npm test`
Expected: PASS — the six `nextOccurrence` tests green; Tasks 1–2 + Phase 1/2/3 still green. (A throwaway probe of this exact logic ran green — 88 pass — before this plan was written.)

- [ ] **Step 5: Commit**

```bash
cd ~/gitrepos/sate
git add core/src/web/planner.js core/test/planner-ui.test.ts
git commit -m "feat(web): pure nextOccurrence (mirrors the projector's date math)"
```

---

### Task 4: Nav — insert the `Plan` tab (Home · Plan · Coach · History) + the `plan` view skeleton

Add the tab to both nav surfaces (header tabs + bottom tab bar) between Home and Coach, add the `#view-plan` section, and register a minimal `views/plan.js` tab view (a placeholder body for now) so switching to Plan works before its content lands. Independently shippable: the tab appears, is selectable, and shows a "loading" placeholder.

**Files:**
- Modify: `core/src/web/index.html`
- Create: `core/src/web/views/plan.js`
- Modify: `core/src/web/app.js`

- [ ] **Step 1: Add the header-tab button in `core/src/web/index.html`**

In `<nav class="tabs">`, insert between the Home and Coach buttons:

```html
        <button data-view="plan" type="button">Plan</button>
```

- [ ] **Step 2: Add the bottom-tab-bar button in `core/src/web/index.html`**

In `<nav class="tabbar" id="tabbar">`, insert between the Home and Coach `<button>`s (matching the icon-over-label shape; a calendar-check glyph):

```html
      <button data-view="plan" type="button" aria-label="Plan">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4.5" width="18" height="16" rx="3"/><path d="M8 3v3M16 3v3M3 9.5h18"/><path d="M8.5 14l2 2 3.5-4"/></svg>
        <span>Plan</span>
      </button>
```

- [ ] **Step 3: Add the `#view-plan` section in `core/src/web/index.html`**

In `<main id="app">`, insert after the `#view-home` `</section>` (before `#view-coach`):

```html
      <!-- PLAN (owned by views/plan.js) -->
      <section id="view-plan" class="view" hidden>
        <div id="planRoot" class="view-empty">Plan loads here.</div>
      </section>
```

- [ ] **Step 4: Create the skeleton `core/src/web/views/plan.js`**

```javascript
// Sate v2 SPA — Plan tab (spec §8, §9). The management surface (distinct from Home's timeline):
//   • "Your Plan" card — the tracked targets (server-authoritative), editable via the Goals dialog,
//     with "Show full plan" → the persisted Coach narrative (profiles.plan_summary).  [Task 5]
//   • Log · Plan buttons — the same pair as Home.                                       [Task 7]
//   • "Scheduled" section — plan_schedules with a recurrence summary + next occurrence,
//     tap-to-edit (all-scope) + delete-with-confirm.                                    [Task 6]
//
// Registers as a TAB view (container #view-plan) exporting render(container), like home.js/history.js.
// HONESTY: every number on this tab comes from the server (me()/GET /api/plan/compute) — the client
// never re-sums or re-derives targets. Escapes all user/AI text (plan_summary, allergies, schedule
// names) with esc().

"use strict";

import {
  $, el, esc, api, toast, me, refreshMe, openView, registerView, confirmDialog, dialog,
  ringEl, tripleRingCard, fmt, todayISO,
} from "../lib.js";
import { recurrenceSummary, nextOccurrence } from "../planner.js";

// Cached DOM (built once by ensureUI, reused on every show).
let UI = null;

function ensureUI(container) {
  if (UI && container.contains(UI.root)) return UI;
  container.innerHTML = "";
  const planCard = el("div", { id: "yourPlanCard" });
  const logplan = el("div", { class: "logplan", id: "planLogplan" }); // Task 7 fills this
  const schedHead = el("h3", { class: "section" }, "Scheduled");
  const schedList = el("div", { id: "schedList", class: "sched-list" });
  const root = el("div", null, planCard, logplan, schedHead, schedList);
  container.appendChild(root);
  UI = { root, planCard, logplan, schedHead, schedList };
  return UI;
}

// Called by showView('plan') on every show.
function render(container) {
  const host = container || $("#view-plan");
  if (!host) return;
  ensureUI(host);
  // Task 5 fills renderYourPlan(); Task 6 fills loadSchedules(); Task 7 fills renderLogPlan().
  UI.planCard.innerHTML = '<div class="hint">Your plan loads here.</div>';
  UI.schedList.innerHTML = "";
}

registerView("plan", { container: "#view-plan", render });
export { render };
```

- [ ] **Step 5: Register the view by importing it in `core/src/web/app.js`**

Add after the existing `import "./views/home.js";` line (order does not matter for side-effect imports; keep it near Home for readability):

```javascript
import "./views/plan.js";
```

- [ ] **Step 6: LIVE verification on sate.health** (against the deployed revision or a local build; the sate-cloud sync/deploy is Task 8)

1. **Nav order:** the header tabs and the bottom tab bar both read **Home · Plan · Coach · History**.
2. **Selectable:** tapping `Plan` reveals `#view-plan`, hides the others, and highlights the Plan tab in both nav surfaces (`.active`/`.on`), matching how Home/Coach/History behave.
3. **Placeholder:** the Plan tab shows the "Your plan loads here." / "Scheduled" scaffold with no console errors.
4. **No regression:** Home, Coach, History still switch and render normally.

- [ ] **Step 7: Commit**

```bash
cd ~/gitrepos/sate
git add core/src/web/index.html core/src/web/views/plan.js core/src/web/app.js
git commit -m "feat(web): insert Plan tab into nav (Home·Plan·Coach·History) + view skeleton"
```

---

### Task 5: "Your Plan" card (§8.1) — targets (server) + edit via Goals + "Show full plan" modal; persist plan_summary at onboarding

Fill the Your-Plan card: render the tracked targets (from the server — `me()`'s saved goals + `method`/`activity_level`, plus the deterministic `POST /api/plan/compute` plan for the macro rings and any pace warnings), an **Edit** affordance that opens the existing Goals dialog, and a **Show full plan** button that opens a modal rendering `esc(me().plan_summary)`. Also wire onboarding's AI-plan step to persist the narrative it already generates, so "Show full plan" has content.

**Files:**
- Modify: `core/src/web/views/plan.js`
- Modify: `core/src/web/views/onboarding.js`
- Modify: `core/src/web/style.css`

**Interfaces:**
- Consumes: `me()` (goals, method, activity_level, plan_summary); `POST /api/plan/compute` (server targets + warnings); `lib.js` `ringEl`/`tripleRingCard`/`dialog`/`fmt`/`esc`; `openView("goals")`.
- Produces: `renderYourPlan()` + `showFullPlan()` in `plan.js`; a `PATCH /api/goals { plan_summary }` call in onboarding's `obPlan()`.

- [ ] **Step 1: Implement `renderYourPlan()` in `core/src/web/views/plan.js`**

Add the imports it needs are already in Task 4's import block (`ringEl`, `tripleRingCard`, `dialog`, `fmt`, `me`, `openView`, `esc`, `api`, `toast`). Replace the `render()` body's `UI.planCard.innerHTML = ...` placeholder line with a call to `renderYourPlan()`, and add the functions:

```javascript
// ---- "Your Plan" card: server-authoritative targets + edit + full-plan narrative.
async function renderYourPlan() {
  const card = UI.planCard;
  const m = me() || {};
  const g = m.goals || {};
  const method = m.track_mode || "calories";
  const activity = m.activity_level || "";

  // The macro-target rings reuse tripleRingCard. These are TARGETS (from the saved goals), not
  // progress — value === goal, so each ring reads "full" as a visual of the plan's composition.
  const RC = { n: "#16a34a", c: "#0ea5e9", f: "#f59e0b" };
  const ring = tripleRingCard([
    { key: "n", label: "Protein", value: g.protein || 0, goal: g.protein || 0, pct: g.protein ? 1 : 0, color: RC.n, unit: "g" },
    { key: "c", label: "Carbs", value: g.carbs || 0, goal: g.carbs || 0, pct: g.carbs ? 1 : 0, color: RC.c, unit: "g" },
    { key: "f", label: "Fat", value: g.fat || 0, goal: g.fat || 0, pct: g.fat ? 1 : 0, color: RC.f, unit: "g" },
  ]);

  const kcalLine = el("div", { class: "plan-kcal" },
    el("strong", {}, fmt(g.kcal || 0)), el("small", {}, " kcal/day target"));
  const metaLine = el("div", { class: "plan-meta" },
    "Method: " + esc(labelForMethod(method)) + (activity ? " · Activity: " + esc(labelForActivity(activity)) : ""));

  const editBtn = el("button", { class: "link", type: "button", text: "Edit plan",
    onClick: () => openView("goals") });
  const fullBtn = el("button", { class: "link", type: "button", text: "Show full plan", onClick: showFullPlan });
  const actions = el("div", { class: "plan-actions" }, editBtn, fullBtn);

  card.innerHTML = "";
  card.className = "statcard yourplan";
  card.append(el("h3", { class: "section", style: { marginTop: "0" } }, "Your Plan"),
    kcalLine, ring, metaLine, weightGoalsLine(), actions);
}

// Human labels (kept local + tiny; the Goals dialog owns the authoritative option lists).
function labelForMethod(m) {
  return ({ calories: "Calories", carb: "Carb-focused", protein: "High-protein", fat: "Low-fat", balanced: "Balanced", heart: "Heart-healthy" })[m] || m;
}
function labelForActivity(a) {
  return ({ sedentary: "Sedentary", light: "Light", moderate: "Moderate", active: "Active", athlete: "Athlete" })[a] || a;
}

// A one-line weight-goal readout (server truth via /api/weight/goals). Empty → "Maintenance".
function weightGoalsLine() {
  const line = el("div", { class: "plan-meta plan-weightgoals" }, "Weight goal: …");
  api("/api/weight/goals").then((r) => {
    const goals = (r && r.goals) || [];
    line.textContent = goals.length
      ? "Weight goal: " + goals.map((wg) => Math.round(wg.target_lb) + " lb by " + wg.target_date).join(" · ")
      : "Weight goal: Maintenance";
  }).catch(() => { line.textContent = "Weight goal: Maintenance"; });
  return line;
}

// "Show full plan" → a modal rendering the persisted Coach narrative (profiles.plan_summary).
function showFullPlan() {
  const summary = (me() || {}).plan_summary || "";
  const body = summary
    ? el("div", { class: "fullplan-text" }, ...summary.split(/\n{2,}/).map((p) => el("p", {}, p)))
    : el("div", { class: "hint" }, "No saved plan narrative yet. Your Coach writes this at setup — finish onboarding or ask the Coach to build your plan.");
  // esc: paragraphs are added as text nodes (el's string children are textContent), so no HTML injection.
  dialog({ title: "Your full plan", body });
}
```

Note: `el(tag, props, ...children)` inserts string children as **text nodes** (see `lib.el`), so the paragraph split renders `plan_summary` safely without manual `esc()`. Do NOT switch these to `innerHTML`.

- [ ] **Step 2: Call `renderYourPlan()` from `render()`**

In `render()`, replace:

```javascript
  UI.planCard.innerHTML = '<div class="hint">Your plan loads here.</div>';
  UI.schedList.innerHTML = "";
```

with:

```javascript
  renderYourPlan();
  loadSchedules();   // Task 6
  renderLogPlan();   // Task 7
```

(Add `loadSchedules`/`renderLogPlan` in Tasks 6/7; until then, define them as `function loadSchedules(){}` / `function renderLogPlan(){}` no-op stubs so this task ships independently — remove the stubs when those tasks land.)

- [ ] **Step 3: Persist `plan_summary` at onboarding's AI-plan step in `core/src/web/views/onboarding.js`**

In `obPlan()`, after the narrative is fetched and shown (`if (box) box.textContent = r.reply || "(no plan)";`), persist it so the Plan tab can render it later. Add immediately after that line:

```javascript
    // Persist the setup narrative so the Plan tab's "Show full plan" can render it (spec §2.4). Best-
    // effort: a failed save must not break onboarding. refreshMe() is already called on finish.
    if (r.reply) { try { await api("/api/goals", { method: "PATCH", json: { plan_summary: r.reply } }); } catch (_) {} }
```

(`obPlan` is already `async` and imports `api`; confirm both — if `obPlan` is not `async`, make it `async` and `await` the existing `api("/api/nutritionist", …)` call it already makes.)

- [ ] **Step 4: Add the Your-Plan card + full-plan-modal styles to `core/src/web/style.css`**

```css
/* ---- Planner: "Your Plan" card ---- */
.yourplan .plan-kcal { margin: 2px 0 10px; }
.yourplan .plan-kcal strong { font-size: 30px; font-weight: 800; }
.yourplan .plan-kcal small { color: var(--muted); font-size: 13px; }
.yourplan .plan-meta { color: var(--muted); font-size: 13px; margin-top: 8px; }
.yourplan .plan-actions { display: flex; gap: 16px; margin-top: 12px; }
.fullplan-text p { margin: 0 0 12px; line-height: 1.5; }
.fullplan-text p:last-child { margin-bottom: 0; }
```

- [ ] **Step 5: LIVE verification on sate.health**

As the `god` account, on the Plan tab:
1. **Targets render:** the Your-Plan card shows the kcal/day target, the protein/carbs/fat ring, and the method (+ activity) line — and the kcal number EQUALS `GET /api/me`'s `goals.kcal` (server truth; not client-computed). The weight-goal line matches `GET /api/weight/goals`.
2. **Edit:** tapping **Edit plan** opens the existing Goals sheet; changing a target + Save updates the card after `refreshMe()` (re-open the tab or confirm the card reflects the new number).
3. **Show full plan:** tapping **Show full plan** opens a modal. With a saved `plan_summary` (set one via `PATCH /api/goals {plan_summary}` or by finishing onboarding), the narrative renders as paragraphs; with none, the empty-state hint shows. Inject a `<script>`-laden string into `plan_summary` and confirm it renders as literal text (no execution) — the esc/text-node guard holds.
4. **Onboarding persist:** run onboarding to its plan step (or re-trigger it), then open the Plan tab → "Show full plan" shows the generated narrative.

- [ ] **Step 6: Commit**

```bash
cd ~/gitrepos/sate
git add core/src/web/views/plan.js core/src/web/views/onboarding.js core/src/web/style.css
git commit -m "feat(web): Your-Plan card (targets + edit + full-plan modal) + persist plan_summary at onboarding"
```

---

### Task 6: "Scheduled" section (§8.2) — list schedules with recurrence summary + next occurrence, tap-to-edit (all), delete-with-confirm

Fill the Scheduled list from `GET /api/plan/schedules`: each row shows the schedule name, a kind icon, the pure `recurrenceSummary`, and the pure `nextOccurrence` ("Next: Mon, Jul 27"). Tapping a row opens `planevent` in **edit mode** (a schedule edit is inherently "all" → `PATCH /api/plan/schedules/:id`); a delete control confirms then `DELETE /api/plan/schedules/:id`. Extend `planevent.js` with the edit mode.

**Files:**
- Modify: `core/src/web/views/plan.js`
- Modify: `core/src/web/views/planevent.js`
- Modify: `core/src/web/style.css`

**Interfaces:**
- Consumes: `GET /api/plan/schedules`; `planner.js` `recurrenceSummary`/`nextOccurrence`; `lib.js` `confirmDialog`/`el`/`esc`/`api`/`toast`/`openView`/`todayISO`; `planevent.open({ schedule, mode:"edit" })`.
- Produces: `loadSchedules()` + `scheduleRow(sched)` + `deleteSchedule(id, name)` in `plan.js`; `planevent` edit mode (prefill + `PATCH`).

- [ ] **Step 1: Implement `loadSchedules` + `scheduleRow` + `deleteSchedule` in `core/src/web/views/plan.js`**

Replace the `loadSchedules(){}` stub (from Task 5 Step 2) with:

```javascript
// ---- "Scheduled" section: the recurring plan manager (spec §8.2).
async function loadSchedules() {
  const list = UI.schedList;
  list.innerHTML = '<div class="loadrow"><span class="spinner"></span><span>Loading…</span></div>';
  let schedules = [];
  try {
    schedules = (await api("/api/plan/schedules")).schedules || [];
  } catch (e) {
    list.innerHTML = '<div class="hint">Couldn’t load schedules — ' + esc(e.message) + "</div>";
    return;
  }
  list.innerHTML = "";
  if (!schedules.length) {
    list.appendChild(el("div", { class: "hint" }, "No recurring plans yet. Tap ", el("b", {}, "Plan"), " above and pick a repeat to create one."));
    return;
  }
  // Soonest-next first; schedules with no upcoming occurrence sink to the bottom.
  const today = todayISO();
  schedules
    .map((s) => ({ s, next: nextOccurrence(s, today) }))
    .sort((a, b) => (a.next || "9999").localeCompare(b.next || "9999"))
    .forEach(({ s, next }) => list.appendChild(scheduleRow(s, next)));
}

const KIND_ICON = {
  food: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3v7a2 2 0 0 0 4 0V3"/><path d="M10 12v9"/><ellipse cx="16" cy="6.4" rx="2.2" ry="3.4"/><path d="M16 9.8V21"/></svg>',
  activity: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="13" cy="4" r="1"/><path d="M4 17l5 1 .75-1.5"/><path d="M15 21v-4l-4-3 1-6"/><path d="M7 12V9l5-1 3 3 3 1"/></svg>',
};

function scheduleRow(s, next) {
  const icon = el("span", { class: "sched-ico " + (s.kind === "activity" ? "a" : "n"),
    html: KIND_ICON[s.kind === "activity" ? "activity" : "food"] });
  const nextLabel = next ? "Next: " + prettyDate(next) : "No upcoming occurrence";
  const text = el("div", { class: "sched-text" },
    el("span", { class: "sched-name" }, esc(s.name || "(unnamed)")),
    el("span", { class: "sched-sub" }, esc(recurrenceSummary(s)) + " · " + esc(nextLabel)));
  const del = el("button", { class: "sched-del", type: "button", "aria-label": "Delete", title: "Delete",
    html: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M9 7V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2M6 7l1 13a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-13"/></svg>' });
  del.addEventListener("click", (ev) => { ev.stopPropagation(); deleteSchedule(s); });
  const row = el("div", { class: "sched-row", role: "button", tabindex: "0" }, icon, text, del);
  row.addEventListener("click", () => openView("planevent", { schedule: s, mode: "edit" }));
  return row;
}

// A short absolute date label ("Mon, Jul 27") from a YYYY-MM-DD, parsed as a UTC anchor so it never
// tz-shifts a day. (The pure helper returns the label-free date; formatting stays in the DOM layer.)
function prettyDate(ymd) {
  const d = new Date(ymd + "T00:00:00Z");
  return d.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
}

async function deleteSchedule(s) {
  const ok = await confirmDialog("Delete “" + (s.name || "this plan") + "” and all its future occurrences?",
    { title: "Delete schedule", confirmLabel: "Delete", danger: true });
  if (!ok) return;
  try {
    await api("/api/plan/schedules/" + s.id, { method: "DELETE" });
    toast("Schedule deleted");
    loadSchedules();
  } catch (e) { toast(e.message); }
}
```

(Add `confirmDialog`, `todayISO` to the `plan.js` import block if not already present from Task 4 — Task 4's block includes both.)

- [ ] **Step 2: Add the edit mode to `core/src/web/views/planevent.js`**

`planevent.open(args)` currently only creates. Extend it to prefill from an existing schedule and PATCH on submit. In `open(args = {})`, after building the default `F`, add a prefill branch, and stash the edit target:

```javascript
export function open(args = {}) {
  const sched = args && args.mode === "edit" && args.schedule ? args.schedule : null;
  editing = sched ? sched.id : null;
  F = {
    kind: (sched ? sched.kind : (args && args.scope === "activity" ? "activity" : "food")),
    description: "", name: sched ? (sched.name || "") : "",
    kcal: "", macros: { protein: "", carbs: "", fat: "" }, duration_min: "", distance: "", intensity: "", note: "",
    date: todayISO(), time: sched ? (sched.time_of_day || "12:00") : "12:00",
    repeat: "none", interval: 1, by_weekday: [], day_of_month: undefined,
  };
  if (sched) prefillFromSchedule(sched);
  planCtrl = sheet({
    title: sched ? "Edit schedule" : "Plan an event",
    className: "plansheet",
    onClose: () => { planCtrl = null; editing = null; },
    body: (b) => renderForm(b),
  });
}
```

Add the module-local `editing` handle near `let F = null;`:

```javascript
let editing = null; // schedule id when in edit mode; null when creating
```

Add the prefill helper (maps the schedule's payload/recurrence back into the form state):

```javascript
// Map an existing plan_schedule into the form state for edit mode. Recurrence unit → repeat;
// payload numbers → the content fields (top-level for the form, which contentOf re-nests on submit).
function prefillFromSchedule(s) {
  const r = s.recurrence || {};
  F.repeat = r.unit || "daily";
  F.interval = Math.max(1, Number(r.interval) || 1);
  F.by_weekday = Array.isArray(r.by_weekday) ? r.by_weekday.slice() : [];
  F.day_of_month = r.day_of_month;
  F.date = s.active_from || todayISO();
  const p = s.payload || {};
  F.kcal = p.kcal != null ? String(p.kcal) : "";
  F.note = p.note || "";
  if (F.kind === "activity") {
    F.duration_min = p.duration_min != null ? String(p.duration_min) : "";
    F.distance = p.distance != null ? String(p.distance) : "";
    F.intensity = p.intensity || "";
  } else {
    const m = p.macros || {};
    F.macros = { protein: m.protein != null ? String(m.protein) : "", carbs: m.carbs != null ? String(m.carbs) : "", fat: m.fat != null ? String(m.fat) : "" };
  }
}
```

In `submit()`, after building `const req = buildPlanRequest(form, tzOffset());`, branch on `editing` (an edit forces a schedule PATCH; `buildPlanRequest`'s schedule body IS the `ScheduleCreate` shape the PATCH accepts). Replace the single `await api(req.path, …)` call with:

```javascript
  busy("Saving plan…");
  try {
    if (editing) {
      // Editing a schedule directly is inherently "all" (spec §6). buildPlanRequest returns the
      // schedule POST body when repeat != none; reuse it as the PATCH body (ScheduleCreate.partial()).
      const body = req.path === "/api/plan/schedules" ? req.body : scheduleBodyFromEntry(form, tzOffset());
      await api("/api/plan/schedules/" + editing, { method: "PATCH", json: body });
      toast("Schedule updated");
    } else {
      await api(req.path, { method: req.method, json: req.body });
      toast(F.repeat === "none" ? "Added to your plan." : "Recurring plan created.");
    }
    if (planCtrl) planCtrl.close();
    planCtrl = null; editing = null;
    try { renderHome(); } catch (_) {}
    try { const p = view("plan"); if (p && p.render) p.render(); } catch (_) {}
  } catch (e) { toast(e.message); }
```

Guard the one edge case: in edit mode the user could switch `repeat` to "none" (which `buildPlanRequest` would map to an entry create). A schedule must stay a schedule, so add a tiny fallback `scheduleBodyFromEntry(form, tz)` that forces a `daily/interval:1` recurrence, OR simpler — in edit mode disable the "Does not repeat" option. Choose the simpler guard: in `renderForm`'s repeat `<select>`, when `editing` is set, omit the `["none","Does not repeat"]` option so a schedule can never be turned into a one-off. Then `req.path` is always `/api/plan/schedules` in edit mode and `scheduleBodyFromEntry` is unneeded — delete that fallback reference and use `req.body` directly:

```javascript
      await api("/api/plan/schedules/" + editing, { method: "PATCH", json: req.body });
```

Add `view` to the `planevent.js` lib import (for the Plan-tab refresh after edit). Confirm `renderForm`'s repeat options are built from a list you can filter on `editing`.

- [ ] **Step 3: Add the Scheduled-list styles to `core/src/web/style.css`**

```css
/* ---- Planner: Scheduled list ---- */
.sched-list { display: flex; flex-direction: column; gap: 8px; }
.sched-row { display: flex; align-items: center; gap: 12px; padding: 12px; border: 1px solid var(--line); border-radius: 12px; background: var(--card); cursor: pointer; }
.sched-row:active { transform: translateY(1px); }
.sched-ico { flex: none; width: 34px; height: 34px; display: grid; place-items: center; border-radius: 9px; background: color-mix(in srgb, var(--brand) 12%, transparent); color: var(--brand); }
.sched-ico svg { width: 20px; height: 20px; }
.sched-text { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; }
.sched-name { font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.sched-sub { color: var(--muted); font-size: 12.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.sched-del { flex: none; background: transparent; border: none; color: var(--muted); padding: 6px; border-radius: 8px; cursor: pointer; }
.sched-del:active { color: var(--danger, #dc2626); }
.sched-del svg { width: 18px; height: 18px; }
```

- [ ] **Step 4: LIVE verification on sate.health**

As the `god` account (create schedules via the Plan button / Home's Plan flow, or `POST /api/plan/schedules`):
1. **List:** each active schedule appears as a row with its name, kind icon, the recurrence summary, and "Next: <date>". Compare the summary + next date against `GET /api/plan/schedules` + `GET /api/timeline?from=<today>&to=<+30d>` — the next date must equal the earliest projected occurrence for that schedule.
2. **Weekday case:** a Mon–Fri weekly schedule reads "Every weekday · <time>"; a Mon/Wed/Fri one reads "Weekly on Mon, Wed, Fri · <time>".
3. **Monthly clamp:** a monthly day-31 schedule's "Next" lands on the correct clamped day for a short month.
4. **Edit (all):** tapping a row opens the "Edit schedule" sheet prefilled (kind, name, time, repeat, content). Change the time + Save → "Schedule updated"; the row's summary/next reflect it, and `GET /api/plan/schedules` shows the PATCH persisted. Confirm on the timeline that ALL future occurrences moved (all-scope), not just one.
5. **Delete:** the trash control prompts "Delete … and all its future occurrences?"; confirming removes the row and the schedule (`GET /api/plan/schedules` no longer lists it) and its occurrences vanish from the timeline. Cancel leaves it.
6. **Empty state:** with no schedules, the friendly empty hint shows.

- [ ] **Step 5: Commit**

```bash
cd ~/gitrepos/sate
git add core/src/web/views/plan.js core/src/web/views/planevent.js core/src/web/style.css
git commit -m "feat(web): Plan-tab Scheduled manager (summary + next occ + edit-all + delete)"
```

---

### Task 7: Add buttons (§8.3) — the `Log` · `Plan` pair on the Plan tab

Render the same `Log` · `Plan` button pair as Home into the Plan tab (the `#planLogplan` slot built in Task 4). `Log` opens the compose sheet; `Plan` opens the plan-an-event flow. Adding here lands the event on Home's timeline and (for a recurring plan) in the Scheduled list, so the Plan-tab refreshes after a create.

**Files:**
- Modify: `core/src/web/views/plan.js`

**Interfaces:**
- Consumes: `openView("compose")` / `openView("planevent")`; the `.logplan`/`.addbtn` styles already exist (Phase 3).
- Produces: `renderLogPlan()` in `plan.js`.

- [ ] **Step 1: Implement `renderLogPlan()` in `core/src/web/views/plan.js`**

Replace the `renderLogPlan(){}` stub (from Task 5 Step 2) with:

```javascript
// ---- Log · Plan buttons (spec §8.3, §9) — the same pair as Home; built into the Plan tab's slot.
function renderLogPlan() {
  const host = UI.logplan;
  host.innerHTML = "";
  const logBtn = el("button", { class: "addbtn", type: "button" },
    htmlSvg('<path d="M12 5v14M5 12h14"/>', 2.4), "Log");
  const planBtn = el("button", { class: "addbtn plan", type: "button" },
    htmlSvg('<rect x="3" y="4.5" width="18" height="16" rx="3"/><path d="M8 3v3M16 3v3M3 9.5h18"/>', 1.9), "Plan");
  logBtn.addEventListener("click", () => openView("compose", { scope: "nutrition" }));
  planBtn.addEventListener("click", () => openView("planevent", { scope: "nutrition" }));
  host.append(logBtn, planBtn);
}

// Small inline-SVG helper (keeps the two buttons visually identical to Home's markup).
function htmlSvg(inner, sw) {
  const s = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  s.setAttribute("viewBox", "0 0 24 24"); s.setAttribute("fill", "none");
  s.setAttribute("stroke", "currentColor"); s.setAttribute("stroke-width", String(sw));
  s.setAttribute("stroke-linecap", "round"); s.setAttribute("stroke-linejoin", "round");
  s.innerHTML = inner;
  return s;
}
```

(`renderLogPlan()` is already called from `render()` per Task 5 Step 2. Ensure the Task 5 no-op stub is removed.)

- [ ] **Step 2: LIVE verification on sate.health**

As the `god` account, on the Plan tab:
1. **Pair renders:** `Log` (filled) and `Plan` (outlined) sit side by side below the Your-Plan card, matching Home's pair.
2. **Log:** tapping `Log` opens the compose sheet; logging a meal there works and (returning to Home) appears on the timeline.
3. **Plan → one-off:** tapping `Plan` → the plan-an-event sheet; a "does not repeat" meal appears as a planned item on Home's timeline (ghosted) and does NOT appear in the Plan tab's Scheduled list (it's not a schedule).
4. **Plan → recurring:** a repeat plan appears in the Scheduled list immediately (the Plan tab refreshes after create — see Task 6's post-submit `view("plan").render()`), and its occurrences show on the timeline.

- [ ] **Step 3: Commit**

```bash
cd ~/gitrepos/sate
git add core/src/web/views/plan.js
git commit -m "feat(web): Log · Plan button pair on the Plan tab"
```

---

### Task 8: Full-suite green + typecheck gate + build + sync to sate-cloud + live smoke

The final gate: backend + pure suites green, typecheck clean, the SPA builds (so `plan.js` lands in the fingerprinted bundle), the `core/` change synced into the sate-cloud subtree, and the end-to-end Plan-tab scenario verified live. No new behavior.

**Files:**
- None new. Verification + build + subtree sync.

- [ ] **Step 1: Run the whole suite**

Run: `cd ~/gitrepos/sate/core && npm test`
Expected: PASS — `profile-plan` (4) + `planner-ui` recurrenceSummary (4) + nextOccurrence (6) + all Phase 1/2/3 tests green; `ℹ fail 0`.

- [ ] **Step 2: Typecheck core via sate-cloud (must not regress)**

Run: `cd ~/gitrepos/sate-cloud && npx tsc --noEmit`
Expected: exit 0. (Web `.js` files aren't typechecked; this catches the schema/profile change.)

- [ ] **Step 3: Build the SPA to confirm `views/plan.js` bundles (no dead file, no build error)**

Run (against a local copy of the web dir, OR after Step 5's sync): `cd ~/gitrepos/sate-cloud && node scripts/build-web.mjs`
Expected: completes; `web/app.<hash>.js` is rewritten and includes `views/plan.js` (reachable from `app.js`'s registration import) + the extended `planner.js`/`planevent.js`. The build asserts `index.html` still references `/app.js` + `/style.css` — unchanged, so it passes.

- [ ] **Step 4: Confirm git state + the phase-4 commits**

Run: `cd ~/gitrepos/sate && git log --oneline -8 && git status --porcelain`
Expected: the seven task commits (Tasks 1–7) present; no uncommitted changes.

- [ ] **Step 5: Sync `core/` into sate-cloud (subtree)**

Per the `sate-core-unification` memory, sate-cloud vendors `core/` as a subtree and MUST stay byte-identical (this includes `core/src/web/*` + `core/src/schema` + `core/src/api`). Use the repo's `scripts/dist-core.sh` sync tool — **run it with `bash`, not `sh`** — and coordinate the exact sync/push step with the user (this plan's scope is core-side; the sate-cloud PR/deploy is a follow-up).

Run (verify byte-identical after sync): `diff -rq ~/gitrepos/sate/core/src ~/gitrepos/sate-cloud/core/src`
Expected: no differences once synced.

- [ ] **Step 6: Live smoke test on sate.health (after the sate-cloud deploy)**

As the `god` account on the deployed Cloud revision:
1. **Nav:** Home · **Plan** · Coach · History in both nav surfaces; Plan selects cleanly.
2. **Your Plan:** the card's kcal target == `GET /api/me` `goals.kcal`; Edit opens Goals and a saved change reflects; "Show full plan" renders the persisted `plan_summary` (set one via onboarding or `PATCH /api/goals`).
3. **Scheduled:** create a weekday schedule (via the Plan button) → it lists with "Every weekday · <time> · Next: <date>", the next date matching `GET /api/timeline`. Edit its time (all-scope) → all future occurrences move. Delete → it and its occurrences vanish.
4. **Add buttons:** `Log` and `Plan` both open their sheets; a recurring create refreshes the Scheduled list; a one-off shows on Home only.
5. **Honesty:** the Plan tab shows no intake/burn totals; a planned/occurrence item never affects the Home stat card (Phase 1/3 spine, unchanged). Clean up created schedules/entries + the test `plan_summary` via the API. Document the result. (Runs only after the sate-cloud deploy in the follow-up; noted here so Phase 4 isn't marked "done" until verified live.)

---

## Self-Review

**Spec coverage (Phase 4 scope = spec §13.4: §8 Plan tab, §9 nav insert, §2.4 profile fields):**

| Spec | Requirement | Task |
|---|---|---|
| §2.4 | `profiles.plan_summary?` (Coach narrative, rendered by "Show full plan", persisted at onboarding) | Task 1 (schema + `/api/me` + `PATCH /api/goals`), Task 5 (onboarding persist + modal render) |
| §2.4 | `profiles.allergies?` (remembered restrictions, editable) | Task 1 (persist + expose). Editing UI + Phase-5 consumption flagged below |
| §8.1 | Your-Plan card: tracked targets (goal_kcal, P/C/F, weight goal + pace, method, activity_level) reusing rings | Task 5 (`renderYourPlan` — `tripleRingCard`, server `goals`, `/api/weight/goals`, method/activity) |
| §8.1 | editable inline via the existing Goals dialog | Task 5 (Edit → `openView("goals")`) |
| §8.1 | "Show full plan" → modal rendering `plan_summary` | Task 5 (`showFullPlan` → `dialog`) |
| §8.2 | list `plan_schedules` with recurrence summary + next occurrence | Task 6 (`loadSchedules`/`scheduleRow`), Task 2 (`recurrenceSummary`), Task 3 (`nextOccurrence`) |
| §8.2 | tap → edit the schedule (all-scope); delete with confirm | Task 6 (`planevent` edit mode → `PATCH`; `deleteSchedule` → `confirmDialog` + `DELETE`) |
| §8.3 | the shared `Log` · `Plan` add buttons (as Home) | Task 7 (`renderLogPlan`) |
| §9 | insert the `Plan` tab → Home · Plan · Coach · History (`index.html` nav + `app.js` registry + `views/plan.js`) | Task 4 |

**Verification split (decided + stated):** **Backend** (the two profile fields, `/api/me`, `/api/goals`) → full TDD via the API harness (`profile-plan.test.ts`, `client()` + `app.request`), Task 1. **Pure SPA helpers** (`recurrenceSummary`, `nextOccurrence`) → full TDD with `node:test` in `planner-ui.test.ts`, Tasks 2–3 — `nextOccurrence` is a deterministic mirror of the Phase 2 projector's `firesOn`/bounds, so its label matches the server timeline and is testable without a browser. **DOM** (the Plan tab view, nav, Your-Plan card, Scheduled list, add buttons, `planevent` edit mode) → complete code + explicit LIVE steps on sate.health, Tasks 4–7 — no jsdom is introduced, justified because every rendered string (summary, next date, targets) comes from the tested pure/backend layers, so a browser is only needed to confirm layout/wiring.

**Test recipe — verified runnable:** before finalizing, a throwaway `core/src/web/_phase4probe.js` (holding `recurrenceSummary` + `nextOccurrence`) + `core/test/_phase4probe.test.ts` were bundled by the existing `test/run.sh` (esbuild → cjs → `node --test`) and run **green — 88 pass / 0 fail** (weekday/daily/monthly-clamp summaries, next-date incl. skip-override + monthly-clamp), then removed. The plan's pure-helper commands (`npm test` picking up `planner-ui.test.ts` importing `../src/web/planner.js`) are therefore real.

**Placeholder scan:** No TBD/TODO-in-code/"similar to Task N". Every backend + pure step shows complete code + full assertions; every DOM step shows complete code; every run/live step gives the exact command or user action + expected result. The one intentional seam ("Suggest a recipe (soon)", disabled) is Phase 3's already-placed Phase-5 boundary, untouched here. The Task-5 no-op stubs for `loadSchedules`/`renderLogPlan` are explicitly flagged for removal when Tasks 6/7 land (so Task 5 ships independently without dangling calls).

**API/field-name consistency (vs `plan.ts`/`profile.ts`):**
- `plan_summary`/`allergies` are read (`profileView`) and written (`PATCH /api/goals`) under the exact same names the schema defines (Task 1); `/api/me` echoes them; the client reads `me().plan_summary`/`me().allergies` — one spelling everywhere.
- `recurrenceSummary`/`nextOccurrence` consume the `plan_schedules` shape from `plan.ts`/`schema` exactly: `recurrence{unit,interval,by_weekday?,day_of_month?}`, `time_of_day` ("HH:mm"), `active_from`/`active_to` ("YYYY-MM-DD"), `is_active`, `id`. `nextOccurrence`'s `firesOn` is field-for-field identical to `domain/schedule.ts`'s `firesOn` (daily diff%interval, weekly by_weekday+week%interval, monthly monthsDiff%interval + day-clamp) — the same math the server timeline runs, so labels cannot drift.
- The Scheduled edit reuses `buildPlanRequest`'s schedule body (`{kind,name,payload,recurrence,time_of_day,tz_offset_min,active_from,is_active}`) as the `PATCH /api/plan/schedules/:id` body — which `plan.ts` validates with `ScheduleCreate.partial()`; the field set matches. Delete uses `DELETE /api/plan/schedules/:id` (cascades overrides server-side). Schedule list uses `GET /api/plan/schedules` → `{ schedules }`.
- The card reuses `GET /api/me` `goals` (`{kcal,protein,carbs,fat,sodium,burn}` from `goalsOf`) and `GET /api/weight/goals` `{ goals:[{target_lb,target_date}] }`, both server-authoritative — no client re-computation (honesty).
- View registration matches the `registerView(name, { container, render })` tab contract (like `home`/`history`); `app.js` gets the side-effect import; the router's `showView`/`[data-view]` toggling drives both nav surfaces with no per-tab code.

**Open questions flagged for the reader (also in the report):**
1. **`allergies` editing surface.** Task 1 persists + exposes `allergies`; §7.3 says it's editable "in Settings and via the Plan tab". This plan adds no editor UI for it in Phase 4 (its only consumer — recipes/coach — is Phase 5). Confirm deferring the allergies *editor* to Phase 5 is acceptable, or add a small free-text field to the Your-Plan card / Goals dialog now.
2. **Your-Plan macro rings at 100%.** The card renders protein/carbs/fat as full `tripleRingCard` rings (value == target) as a composition visual, since there is no "progress" on a plan card. Confirm this reads as intended, vs. a plain target readout (chips) with no rings.
3. **Schedule edit can't become a one-off.** Edit mode omits the "Does not repeat" option so a schedule stays a schedule (a clean PATCH). Confirm that's the desired constraint (the alternative — delete-the-schedule-and-create-an-entry — is heavier and not built).
4. **`plan_summary` cap = 8000 chars.** Chosen to hold a multi-paragraph narrative; confirm that's ample (Phase 6 coach-edit will rewrite it).
