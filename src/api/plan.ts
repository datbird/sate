// Sate core — Planner routes. Phase 1: create a one-off PLANNED entry and ACCEPT it (planned→logged).
// A planned entry carries its *intended* content but is excluded from every total (see isLogged in
// helpers) until accepted here. Recurring schedules, projection, and the occurrence-accept branch are
// phase 2. All routes are non-AI. Ported onto the shared ports; identity is the Firebase uid.

import {
  getUid, getEmail, ok, err, dayKey, ensureProfile, dayIntakeTotals,
  type App, type RouteDeps,
} from "./helpers";
import type { Entry, Macros } from "../schema";

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
}
