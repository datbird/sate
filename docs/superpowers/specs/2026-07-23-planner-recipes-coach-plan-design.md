# Sate — Planner, Recipe Suggestions & Coach-Editable Plan (Design)

**Date:** 2026-07-23
**Edition:** Cloud (`@sate/core` → sate-cloud → sate.health). Built core-first; the Hosted (PocketBase)
UI port is explicitly out of scope for this spec. All new Firestore fields/collections are additive
(no migration needed on Cloud).
**Status:** design, pending user review.

---

## 1. Summary & goal

Add the ability to **plan** future meals and activities — one-off or recurring — alongside the existing
"log what I ate" flow, and let the user fill a planned meal with an **AI-suggested recipe that fits their
remaining budget**. A new **Plan tab** surfaces both the user's overall **nutrition plan** (the targets the
Coach set at setup, editable) and their **scheduled/recurring plans**. The **Coach can adjust the plan by
chat** at any time.

The organizing principle: a planned meal or workout is just an **entry that hasn't happened yet**. It never
counts toward totals until the user confirms they actually ate/did it ("manual accept"). This mirrors
BalanceEngine, where a *scheduled* transaction becomes a *posted* one only when it clears.

### Locked decisions (from brainstorming)

- **Accept = manual confirm.** A planned entry counts ZERO until the user taps "Ate it" / "Did it".
- **Recipe budget = user-set, prefilled from remaining budget, editable.**
- **Recipe presentation = compact ideas list → tap → full recipe** (ingredients + steps + exact macros).
- **Preferences = optional free-text box + remembered allergies** (persisted on the profile).
- **Front door = a "Plan an event" action**; the recipe suggester lives *inside* planning a meal.
- **Navigation = new `Plan` tab between Home and Coach.** Order: Home · Plan · Coach · History.
- **Home & Plan both** show a side-by-side **`Log` (left) · `Plan` (right)** button pair (replacing the
  single "+ Add to log").
- **Home stays the timeline** (today-centered infinite scroll with planned events inline); the Plan tab is
  the *management* surface (targets + recurring schedules).
- **Coach edits the plan via chat**, surfaced as an **inline confirm** ("Updated your plan: … — Apply / Undo"),
  never a silent rewrite.
- **Recurrence granularity (v1):** once (→ a one-off entry, not a schedule) · daily · weekly (pick weekdays)
  · monthly. No "1st & 15th"-style multi-anchor rules in v1.

### Terminology (resolves the "plan" collision)

- **Your Plan** — the *strategy*: the nutrition plan the Coach created (numeric targets + narrative).
- **Scheduled plans / recurring plans** — the *tactics*: `plan_schedules` (recurring meals/activities).
- **Planned entry** — a single future meal/activity on the timeline (`entries.status = "planned"`).
- **Occurrence** — a projected (never-stored) instance of a recurring schedule on a given date.

---

## 2. Data model

### 2.1 `entries` — add a planning state

New fields (Zod schema `core/src/schema/index.ts`, all optional/defaulted → additive):

| Field | Type | Meaning |
|---|---|---|
| `status` | `"logged" \| "planned"` default `"logged"` | Whether this entry has happened. Existing/normal logs are `logged`. |
| `plan_schedule_id?` | string | Set on an entry **materialized from a recurring occurrence** — the schedule it came from. |
| `scheduled_date?` | string `YYYY-MM-DD` | The occurrence date this entry materialized from. `(plan_schedule_id, scheduled_date)` is the occurrence identity, mirroring BE's `{scheduleId}:{date}`. |

- A **one-off planned meal/activity** = a stored `entry{status:"planned"}` with a future `logged_at`/`day`.
  No schedule, no occurrence machinery. Editable/deletable directly via the existing entry routes.
- A planned entry carries the same content a logged one does (kcal, macros, items, duration/distance for
  activity) — those are the *intended* values.

### 2.2 `plan_schedules` — recurring plan definitions (NEW, user-scoped)

Adapted from BalanceEngine's `Schedule`, trimmed to Sate's needs.

```
{
  id, user,
  kind: "food" | "activity",
  name: string,                       // "Overnight oats", "Morning run"
  payload: {                          // the intended entry content
    // food:     kcal, macros{protein,carbs,fat,fiber,sugar,sodium,sat_fat}, items[], description, note
    // activity: kcal (burn), duration_min, distance, intensity, description
    // (a recipe-sourced meal stores its recipe in items/note for reference)
  },
  recurrence: {
    unit: "daily" | "weekly" | "monthly",
    interval: number,                 // >= 1 ("every 2 weeks" = weekly/2)
    by_weekday?: number[],            // 0..6 (Sun..Sat), weekly only
    day_of_month?: number,            // 1..31, monthly only (default = anchor DOM)
  },
  time_of_day: "HH:mm",               // local wall-clock
  tz_offset_min: number,              // tz the schedule was authored in (getTimezoneOffset)
  active_from: "YYYY-MM-DD",
  active_to?: "YYYY-MM-DD",           // open-ended if absent
  is_active: boolean,
  created_at, updated_at
}
```

`unit:"once"` is intentionally NOT a schedule value — one-offs are plain planned entries (§2.1).

### 2.3 `plan_overrides` — per-occurrence exceptions (NEW, user-scoped)

BE's `ScheduleOverride`. One row per edited/skipped occurrence.

```
{
  id, user, schedule_id,
  scheduled_date: "YYYY-MM-DD",       // the occurrence being overridden
  is_skipped: boolean,                // "delete just this one"
  new_time?: "HH:mm",                 // "edit just this one" — moved time
  new_payload?: { ... },              // "edit just this one" — changed content
  created_at
}
```

### 2.4 `profiles` — persist the plan narrative + allergies

| Field | Type | Meaning |
|---|---|---|
| `plan_summary?` | string | The Coach's setup plan narrative (today shown in onboarding but not saved). Rendered by the Plan tab's "Show full plan". Updated whenever the plan changes. |
| `allergies?` | string | Remembered dietary restrictions/allergies. Auto-applied to recipe suggestions AND the coach. Free-text (e.g. "no dairy, shellfish allergy"). |

---

## 3. The honesty rule (non-negotiable)

`dayTotals`, `statsRange` (`GET /api/stats`), and the day/feed reads **must filter to `status == "logged"`**.
Planned entries and projected occurrences NEVER count toward intake/burn/remaining until accepted. This is
the correctness spine that makes "manual accept" meaningful and is the single most important regression to
test.

- `core/src/api/entries.ts` `dayTotals()` and the stats aggregation add a `status:"logged"` (or
  `status != "planned"`) filter.
- The existing rule "activity is excluded from intake" is unchanged.

---

## 4. Timeline projection

### 4.1 Endpoint

`GET /api/timeline?from=YYYY-MM-DD&to=YYYY-MM-DD&scope=all|nutrition|activity&tz=<min>`

Returns a chronologically-sorted, merged list over `[from, to]`:

1. **Stored entries** in range — both `logged` (past/today actuals) and `planned` one-offs. Query
   `entries where day in [from,to]` (+ scope→kind filter).
2. **Projected occurrences** from active schedules, generated by the pure projector (§4.2), EXCEPT:
   - dates with a `plan_override{is_skipped:true}` → dropped;
   - dates already materialized (a stored entry exists with `plan_schedule_id == schedule.id &&
     scheduled_date == date`) → dropped (accepted or edited-into-an-entry);
   - `plan_override{new_time|new_payload}` applied to the projected item.

Each returned item is tagged:
- `state: "logged" | "planned"`,
- `origin: "entry" | "occurrence"`,
- occurrences carry `schedule_id`, `scheduled_date`, and synthetic `id = "{scheduleId}:{date}"`.

### 4.2 The projector (pure function — the riskiest logic, unit-tested in isolation)

`projectOccurrences(schedules, overrides, fromDate, toDate, todayLocal) → Occurrence[]`

- **Only generates occurrences with date ≥ `todayLocal`.** Past recurring occurrences that were never
  accepted simply do not appear — a recurring plan you didn't act on is moot. (Explicit one-off planned
  entries in the past DO persist and show, because the user created them deliberately; they can be accepted
  late or deleted.) This asymmetry is intentional and keeps the past clutter-free.
- Date math per `unit`:
  - `daily`: every `interval` days from `active_from`.
  - `weekly`: for each weekday in `by_weekday`, every `interval` weeks from `active_from`.
  - `monthly`: `day_of_month` each `interval` months (clamp to month length — e.g. day 31 → last day).
- Bounded by `active_from`/`active_to` and the requested window.
- Local wall-clock via `time_of_day` + `tz_offset_min`; the occurrence's `logged_at` = that local instant in
  UTC, `day` via `dayKey`. Pure/deterministic given inputs (no `Date.now()` inside — `todayLocal` is passed
  in, matching the workflow/runtime constraint and making it testable).

### 4.3 Infinite scroll (Home)

This **replaces Home's current day-grouped feed** (`GET /api/feed`, newest-first, today-at-top,
scroll-down-only). Home's feed becomes the merged timeline from `/api/timeline`. The client requests
windows around today, centers today on open (`scrollIntoView`, BE's ledger pattern),
scroll **up** extends `to` further into the future (more projected occurrences + future one-offs), scroll
**down** extends `from` further into the past (logged actuals + any past one-off planned entries). Day
dividers as today; "Today" pill centered.

---

## 5. Accept flow (manual confirm)

`POST /api/plan/accept`

- Body: `{ entry_id }` (one-off planned entry) **or** `{ schedule_id, scheduled_date }` (occurrence).
  Optional `{ edits: {...} }` to tweak before confirming (portion, exact numbers).
- **One-off planned entry:** flip `status: planned → logged` (+ apply edits); `logged_at` defaults to the
  planned time, `day` recomputed. It now counts.
- **Occurrence:** create a stored `entry{status:"logged", ...schedule.payload merged with override + edits,
  logged_at from date+time, plan_schedule_id, scheduled_date}`. This **materializes** the occurrence; the
  projector now skips that date (idempotent — a second accept of the same occurrence is a no-op / returns the
  existing entry).
- Returns updated `totals` for the affected day.

UI: planned items on the timeline render **ghosted/dashed with an "unconfirmed" badge** and an **"Ate it"
(food) / "Did it" (activity)** button; tapping accepts (optionally opening the edit sheet first).

---

## 6. Recurrence edit / delete — "this occurrence vs. all"

The scope prompt appears **only for recurring plans** (schedules). One-off planned entries use the existing
`PATCH`/`DELETE /api/entries/:id` with no scope prompt (there is only one).

- **Edit occurrence:** `PATCH /api/plan/schedules/:id/occurrences/:date` `{ scope: "one"|"all", ...changes }`
  - `one` → upsert a `plan_override` (`new_time` / `new_payload`).
  - `all` → PATCH the `plan_schedule` (payload and/or recurrence).
- **Delete occurrence:** `DELETE /api/plan/schedules/:id/occurrences/:date?scope=one|all`
  - `one` → `plan_override{is_skipped:true}`.
  - `all` → deactivate/delete the `plan_schedule` (+ cascade its overrides).
- **Schedule CRUD:** `GET/POST/PATCH/DELETE /api/plan/schedules[/:id]` for the Plan-tab manager. Editing a
  schedule directly from the Plan tab is inherently "all".

Client shows the "Just this one / All future" prompt on edit and delete of any occurrence-origin item.

---

## 7. Recipe suggester (inside "plan a meal")

### 7.1 AI function

Add `recipe_suggest` to the registry (`core/src/shared/prompts.js`: `FUNCTIONS`, `PROMPTS`). Two calls:

- **Suggest (compact ideas):** `POST /api/recipes/suggest`
  Body `{ target: {kcal, protein, carbs, fat}, method, prefs }`. Allergies pulled from the profile
  server-side (never trust client). Prompt → strict JSON `{ ideas: [{name, kcal, protein, carbs, fat,
  blurb}] }`, ~5 ideas, each fitting the target and honoring method (low-carb/high-protein/etc.), prefs,
  and allergies. Grounded on the numeric target so results actually fit.
- **Expand (full recipe):** `POST /api/recipes/expand`
  Body `{ idea, target, prefs }` → strict JSON `{ name, servings, ingredients: [{item, amount}], steps:
  [...], kcal, macros{...} }`.

Model: standard **Latest Flash** by default (cost); a per-instance setting can point it at Pro later.
Runs through `callAI` (usage/limits accounting) like every other function.

### 7.2 Flow

1. In the "plan a meal" flow (or a "Suggest a recipe" fill option), the **target is prefilled from the
   remaining budget** (`goal − today's logged totals`, from `/api/stats`/`/api/me`), editable. Optional
   free-text prefs box. Allergies auto-applied.
2. Compact ideas list (name · kcal · macros · one-line blurb). Re-roll button.
3. Tap an idea → full recipe (ingredients + steps + exact macros).
4. **"Add to plan"** → creates the planned entry/schedule for the chosen date/time (recipe stored in
   `items`/`note` for reference); or **"Log now"** → creates a `logged` entry immediately.

### 7.3 Preferences persistence

`profiles.allergies` (§2.4) editable in Settings and via the Plan tab; auto-applied to `recipe_suggest`
AND the nutritionist coach prompt.

---

## 8. Plan tab

Two halves, plus the shared add buttons.

### 8.1 "Your Plan" card (the strategy)

- Shows the tracked targets the user follows: `goal_kcal`, protein/carbs/fat, weight goal(s) + pace,
  `method`, `activity_level` — reusing the nutrition engine's computed plan and the ring components.
- **Editable** inline (reuses/extends the existing Goals dialog editor).
- **"Show full plan"** → modal rendering `profiles.plan_summary` (the Coach's setup narrative).
- `plan_summary` is persisted at onboarding (the AI-plan step) and refreshed whenever the plan changes
  (user edit or coach edit).

### 8.2 "Scheduled" section (the tactics)

- Lists `plan_schedules`: name, kind icon, recurrence summary ("Every weekday · 7:30am"), next occurrence.
- Tap → edit the schedule (this is "all"); delete with confirm.

### 8.3 Add buttons

Same **`Log` · `Plan`** pair as Home (§9). Adding here lands the same event on Home's timeline.

---

## 9. Navigation & the Log/Plan buttons

- **Tab bar / header nav:** insert **`Plan`** between Home and Coach → **Home · Plan · Coach · History**.
  (`index.html` nav + `app.js` view registry + `showView` wiring.)
- **Log/Plan button pair** (Home + Plan tab): replace the single full-width "+ Add to log" with two buttons,
  **`Log`** (left, opens the existing compose sheet) and **`Plan`** (right, opens the plan-an-event flow).
- **Plan-an-event flow:** pick **meal or activity** → **date & time** → **repeat?** (none / daily / weekly
  (weekdays) / monthly) → **fill** the content: manual entry, food search, or **Suggest a recipe** (§7).
  "None" → a planned entry; a repeat → a `plan_schedule`.

---

## 10. Coach edits the plan by chat

The Coach can change the plan when asked ("bump me to 1,800 kcal", "higher protein", "push my goal to
October"). Implemented **without** building a full Gemini tool-calling framework into the thin
`providers.ts` REST wrapper:

- The `nutritionist` prompt is extended so that, when the user asks to change targets/goals, the reply
  includes a machine-readable trailer `<<PLAN_CHANGE>>{...json...}` (e.g. `{goal_kcal?, method?,
  activity_level?, weight_goal?: {target_lb, target_date}}`). The server strips it from the visible text and
  returns it as `plan_change` in the `/api/nutritionist` response.
- Client renders an **inline confirmation** ("Update your plan: 1,800 kcal · 150g protein · … — **Apply** /
  **Dismiss**"). No silent rewrite.
- On Apply: `POST /api/plan/apply` validates the change, **re-runs the deterministic nutrition engine**
  (`computePlan`) so all numbers stay self-consistent, persists the new targets (+ any weight goal) and a
  refreshed `plan_summary`, and returns the updated plan. Plan-tab card + Home rings reflect it immediately
  (via `refreshMe`).
- This keeps the AI as *proposer* and the deterministic engine + explicit user confirm as *authority*.

---

## 11. Cross-edition & data notes

- **Core-first, Cloud target.** All schema/logic lands in `@sate/core`; deployed via sate-cloud to
  sate.health. The Hosted (`pb_hooks`/`pb_public`) port is out of scope (Hosted has deferred catch-up).
- **No Cloud migration** — Firestore is schemaless; new fields default in, new collections auto-create.
- Firestore composite indexes may be needed for timeline queries (`entries` by `day` range + `status`;
  `plan_schedules` by `is_active`); add to the project's index config as they surface.

---

## 12. Testing strategy

- **Projector unit tests (highest priority):** `projectOccurrences` over daily/weekly-by-weekday/monthly,
  interval > 1, `active_from/to` bounds, month-length clamping, tz/`time_of_day` correctness, and the
  "future-only" rule. Pure function, deterministic (`todayLocal` injected).
- **Overrides:** skip drops the date; `new_time`/`new_payload` apply; materialized dates drop.
- **Accept idempotency:** accepting an occurrence twice yields one entry.
- **Honesty regression:** planned entries/occurrences excluded from `dayTotals`/`stats`; accepting flips
  them in.
- **This/all semantics:** edit-one writes an override and leaves the series; edit-all changes the schedule;
  delete-one skips; delete-all deactivates.
- **Recipe suggester:** returns valid JSON fitting the target; allergies honored (server-injected).
- **Coach plan-edit:** `<<PLAN_CHANGE>>` parsed, engine recompute correct, apply persists + refreshes
  `plan_summary`; dismiss changes nothing.
- **Live smoke tests** on sate.health via the established Firebase-custom-token harness (as used for the
  edit-entry / model-routing work), against a throwaway or the `god` account, cleaning up after.

---

## 13. Implementation phasing (one spec, phased build — for the plan doc)

1. **Foundation:** `entries.status`, accept endpoint, totals/stats exclusion (§2.1, §3, §5).
2. **Schedules + projection:** `plan_schedules`, `plan_overrides`, `projectOccurrences`, `/api/timeline` (§2.2–2.3, §4, §6).
3. **Home timeline UI:** today-centered infinite scroll, planned differentiator + accept, Log/Plan button pair (§4.3, §9).
4. **Plan tab:** Your-Plan card + persisted `plan_summary` + Scheduled manager + add buttons (§8).
5. **Recipe suggester + preferences:** `recipe_suggest` function, suggest/expand endpoints, allergies (§7).
6. **Coach edits plan:** `<<PLAN_CHANGE>>` proposal, `/api/plan/apply`, inline confirm (§10).

Each phase ships working and is independently verifiable on sate.health.

---

## 14. Out of scope (v1)

- Multi-anchor recurrence ("1st & 15th"), and semimonth/quarter units (BE has them; not needed yet).
- Auto-accepting planned items (explicitly rejected — accept is manual).
- Hosted (PocketBase) UI port.
- Full Gemini tool-calling framework (the `<<PLAN_CHANGE>>` proposal pattern covers coach edits).
- Sharing/collaborating on plans; notifications/reminders for upcoming planned items (candidate v2 — could
  reuse the existing check-ins/local-notifications plumbing).
