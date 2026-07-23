// Sate core — Planner routes. Phase 1: create a one-off PLANNED entry and ACCEPT it (planned→logged).
// A planned entry carries its *intended* content but is excluded from every total (see isLogged in
// helpers) until accepted here. Recurring schedules, projection, and the occurrence-accept branch are
// phase 2. All routes are non-AI. Ported onto the shared ports; identity is the Firebase uid.

import {
  getUid, getEmail, ok, err, dayKey, ensureProfile,
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

// eslint-disable-next-line @typescript-eslint/no-unused-vars
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
}
