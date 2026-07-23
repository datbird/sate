// Sate core — Planner routes. Phase 1: create a one-off PLANNED entry and ACCEPT it (planned→logged).
// A planned entry carries its *intended* content but is excluded from every total (see isLogged in
// helpers) until accepted here. Recurring schedules, projection, and the occurrence-accept branch are
// phase 2. All routes are non-AI. Ported onto the shared ports; identity is the Firebase uid.

import {
  getUid, getEmail, ok, err, dayKey, ensureProfile, dayIntakeTotals,
  type App, type RouteDeps,
} from "./helpers";
import { PlanSchedule, PlanOverride, ScheduleRecurrence } from "../schema";
import type { Entry, Macros } from "../schema";
import type { DataStore } from "../ports";
import { projectOccurrences, localInstantUTC, type Occurrence } from "../domain/schedule";

function num(v: unknown): number {
  const n = Number(v);
  return isFinite(n) ? n : 0;
}
const msgOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

function macrosOf(m: any): Macros {
  return {
    protein: num(m?.protein), carbs: num(m?.carbs), fat: num(m?.fat),
    fiber: num(m?.fiber), sugar: num(m?.sugar), sodium: num(m?.sodium), sat_fat: num(m?.sat_fat),
  };
}

// Find the single override for (schedule_id, scheduled_date), or null. Shared by occurrence edit/delete.
export async function findOverride(store: DataStore, scheduleId: string, date: string): Promise<(PlanOverride & { id: string }) | null> {
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

// Upsert the override for (schedule_id, scheduled_date): update if one exists, else create. MUST
// remain a true upsert — the projector indexes overrides last-wins on this key, so a duplicate row
// would make behavior order-dependent (Task 4 review carry-forward).
export async function upsertOverride(
  store: DataStore, scheduleId: string, date: string, patch: Record<string, unknown>,
): Promise<PlanOverride> {
  const existing = await findOverride(store, scheduleId, date);
  if (existing) return await store.update<PlanOverride>("plan_overrides", existing.id, patch as Partial<PlanOverride>);
  return await store.create<PlanOverride>("plan_overrides", patch as Omit<PlanOverride, "id">);
}

export async function registerPlan(app: App, deps: RouteDeps): Promise<void> {
  const { platform } = deps;

  // ---- POST /api/plan/entry — create a one-off PLANNED entry (no AI, no schedule).
  app.post("/api/plan/entry", async (c) => {
    const uid = getUid(c);
    await ensureProfile(platform, uid, getEmail(c));
    const b = (await c.req.json().catch(() => ({}))) as Record<string, any>;
    const description = String(b.description || "").trim();
    if (!description) return err(c, "description is required", 400);
    const kind: Entry["kind"] = b.kind === "activity" ? "activity" : "food";
    const store = platform.data.forUser(uid);
    const logged_at = b.logged_at ? new Date(b.logged_at).toISOString() : new Date().toISOString();
    const tz = num(b.tz_offset_min);
    const day = dayKey(logged_at, tz);
    const draft: Record<string, any> = {
      user: uid,
      kind,
      status: "planned",
      description: description.slice(0, 2000),
      note: b.note !== undefined ? String(b.note).slice(0, 2000) : undefined,
      source: "plan",
      kcal: num(b.kcal),
      items: Array.isArray(b.items) ? b.items : undefined,
      logged_at,
      tz_offset_min: tz,
      day,
    };
    if (kind === "food") {
      draft.macros = macrosOf(b.macros);
    } else {
      draft.duration_min = num(b.duration_min);
      if (b.distance !== undefined) draft.distance = num(b.distance);
      if (b.intensity !== undefined) draft.intensity = String(b.intensity);
    }
    try {
      const entry = await store.create<Entry>("entries", draft as Omit<Entry, "id">);
      return ok(c, { entry });
    } catch (e) {
      return err(c, msgOf(e), 502);
    }
  });

  // ---- POST /api/plan/accept — manual confirm: flip a planned entry to logged (+ optional edits).
  // Body: { entry_id, edits? }. The occurrence branch ({ schedule_id, scheduled_date }) is phase 2.
  app.post("/api/plan/accept", async (c) => {
    const uid = getUid(c);
    const b = (await c.req.json().catch(() => ({}))) as Record<string, any>;
    const store = platform.data.forUser(uid);

    if (!b.entry_id && b.schedule_id) {
      return err(c, "accepting a recurring occurrence is not supported yet (phase 2)", 400);
    }
    const id = String(b.entry_id || "");
    if (!id) return err(c, "entry_id is required", 400);
    const rec = await store.get<Entry>("entries", id);
    if (!rec) return err(c, "not found", 404);
    if (rec.user !== uid) return err(c, "forbidden", 403);

    const edits = (b.edits && typeof b.edits === "object" ? b.edits : {}) as Record<string, any>;
    const activity = rec.kind === "activity";
    const patch: Record<string, any> = { status: "logged" };

    // Optional edits applied at accept time (portion tweaks, corrected numbers, moved time).
    if (edits.kcal !== undefined) patch.kcal = num(edits.kcal);
    if (!activity) {
      const macros: Macros = { protein: 0, carbs: 0, fat: 0, ...(rec.macros || {}) };
      let touched = false;
      for (const k of ["protein", "carbs", "fat", "fiber", "sugar", "sodium", "sat_fat"] as const) {
        if (edits[k] !== undefined) { (macros as any)[k] = num(edits[k]); touched = true; }
      }
      if (touched) patch.macros = macros;
    } else {
      if (edits.duration_min !== undefined) patch.duration_min = num(edits.duration_min);
      if (edits.distance !== undefined) patch.distance = num(edits.distance);
    }
    if (edits.description !== undefined) patch.description = String(edits.description).slice(0, 2000);
    if (edits.note !== undefined) patch.note = String(edits.note).slice(0, 2000);

    // Accepting defaults logged_at to the planned time (already on the record); an edit can move it,
    // which re-buckets the day (same tz-aware rule as logging).
    if (edits.logged_at !== undefined) {
      const ts = new Date(String(edits.logged_at));
      if (!isNaN(ts.getTime())) {
        const tz = edits.tz_offset_min !== undefined ? num(edits.tz_offset_min) : num(rec.tz_offset_min);
        patch.logged_at = ts.toISOString();
        patch.tz_offset_min = tz;
        patch.day = dayKey(patch.logged_at, tz);
      }
    }

    try {
      const entry = await store.update<Entry>("entries", id, patch as Partial<Entry>);
      const day = entry.day || dayKey(entry.logged_at, num(entry.tz_offset_min));
      return ok(c, { entry, totals: await dayIntakeTotals(store, day) });
    } catch (e) {
      return err(c, msgOf(e), 502);
    }
  });

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
}
