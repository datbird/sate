// Sate core — weight tracking: measurements, body-mass sync, and weight goals (cap 3).
// Ported faithfully from pb_hooks/api.js (weightLog/weightSync/weightGet/weightGoalsList/
// weightGoalSet/weightGoalDelete + latestMeasurement/currentWeightKg/addMeasurement/goalsWithPace).
// v1 keyed on user_email; v2 keys on the Firebase uid via platform.data.forUser(uid). Weights are
// stored in kg (canonical) but the API speaks pounds to the client, exactly as v1 did.

import { getUid, ensureProfile, ok, err, type App, type RouteDeps } from "./helpers";
import type { Platform } from "../ports";
import type { Measurement, WeightGoal, Profile } from "../schema";

// ---- units --------------------------------------------------------------
const LB_PER_KG = 2.2046226;
const kgToLb = (kg: number): number => +(kg * LB_PER_KG).toFixed(1);
const lbToKg = (lb: number): number => lb / LB_PER_KG;

// Numeric coercion mirroring v1's num(): non-finite / NaN → 0.
const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

// ---- day / window helpers (ported from v1 todayStr/periodWindow) --------
// Local calendar day as YYYY-MM-DD (tzMin follows JS getTimezoneOffset(): minutes to ADD for UTC).
function todayStr(tzMin = 0): string {
  return new Date(Date.now() - (Number(tzMin) || 0) * 60000).toISOString().slice(0, 10);
}

// Rolling [start,end) ISO window anchored on the user's local "tomorrow midnight", so the window
// covers full local days. day=1, week=7, month=30, year=365 — identical to v1 periodWindow.
function periodWindow(range: string, tzMin = 0): { start: string; end: string; days: number } {
  const tz = Number(tzMin) || 0;
  const days = range === "day" ? 1 : range === "week" ? 7 : range === "month" ? 30 : 365;
  const endMs = Date.parse(todayStr(tz) + "T00:00:00.000Z") + tz * 60000 + 86400000;
  return {
    start: new Date(endMs - days * 86400000).toISOString(),
    end: new Date(endMs).toISOString(),
    days,
  };
}

// ---- measurement helpers ------------------------------------------------
// The newest weight measurement (weight_kg > 0) for the user, or null.
async function latestMeasurement(
  store: ReturnType<Platform["data"]["forUser"]>,
): Promise<Measurement | null> {
  try {
    // No `weight_kg > 0` in the query: Firestore rejects an inequality on one field combined with an
    // orderBy on another (measured_at). Order by measured_at and filter out zero-weight rows here.
    const { items } = await store.list<Measurement>("measurements", {
      orderBy: [{ field: "measured_at", dir: "desc" }],
      limit: 25,
    });
    return items.find((m) => num(m.weight_kg) > 0) || null;
  } catch {
    return null;
  }
}

// Current body weight in kg: newest logged measurement, else the profile scalar. Mirrors v1
// currentWeightKg (falls back through the profile the caller already resolved).
async function currentWeightKg(
  store: ReturnType<Platform["data"]["forUser"]>,
  profile: Profile,
): Promise<number> {
  const l = await latestMeasurement(store);
  if (l && num(l.weight_kg) > 0) return num(l.weight_kg);
  return num(profile.body_weight_kg);
}

// Insert a measurement. `measured_at` normalizes to ISO ("now" when absent), matching v1 addMeasurement.
async function addMeasurement(
  store: ReturnType<Platform["data"]["forUser"]>,
  uid: string,
  data: { weight_kg?: number; height_cm?: number; source: string; ext_id?: string; measured_at?: string },
): Promise<Measurement> {
  const draft: Omit<Measurement, "id"> = {
    user: uid,
    measured_at: data.measured_at ? new Date(data.measured_at).toISOString() : new Date().toISOString(),
    weight_kg: num(data.weight_kg),
    height_cm: num(data.height_cm),
    source: data.source || "manual",
  };
  if (data.ext_id) draft.ext_id = String(data.ext_id);
  return store.create<Measurement>("measurements", draft);
}

// Active weight goals with pace vs the linear start→target path. to_go_lb > 0 = still to lose;
// pace.behind_lb > 0 = behind the schedule needed to hit the target on time. Faithful to v1 goalsWithPace.
// NOTE: v1 ordered by the PB-managed "created" column; WeightGoal has no such field in v2, so we order
// by target_date (stable + meaningful) instead.
async function goalsWithPace(
  store: ReturnType<Platform["data"]["forUser"]>,
  uid: string,
  curKg: number,
): Promise<unknown[]> {
  let rows: WeightGoal[] = [];
  try {
    const { items } = await store.list<WeightGoal>("weight_goals", {
      orderBy: [{ field: "target_date", dir: "asc" }],
      limit: 10,
    });
    rows = items;
  } catch {
    rows = [];
  }
  const today = todayStr();
  return rows.map((r) => {
    const targetKg = num(r.target_kg);
    const startKg = num(r.start_kg) || curKg;
    const startDate = r.start_date || today;
    const targetDate = r.target_date;
    let pace: { behind_lb: number; on_track: boolean } | null = null;
    const t0 = Date.parse(startDate + "T00:00:00Z");
    const t1 = Date.parse(targetDate + "T00:00:00Z");
    const tn = Date.parse(today + "T00:00:00Z");
    if (t1 > t0 && curKg > 0) {
      const frac = Math.min(1, Math.max(0, (tn - t0) / (t1 - t0)));
      const expectedKg = startKg + (targetKg - startKg) * frac;
      // "behind" = on the wrong side of where you should be by now, in the goal's direction.
      const behindKg = targetKg < startKg ? curKg - expectedKg : expectedKg - curKg;
      pace = { behind_lb: +(behindKg * LB_PER_KG).toFixed(1), on_track: behindKg <= 0.25 };
    }
    return {
      id: r.id,
      target_lb: kgToLb(targetKg),
      target_date: targetDate,
      start_lb: startKg > 0 ? kgToLb(startKg) : 0,
      start_date: startDate,
      to_go_lb: curKg > 0 && targetKg > 0 ? +((curKg - targetKg) * LB_PER_KG).toFixed(1) : 0,
      pace,
    };
  });
}

// ---- routes -------------------------------------------------------------
export async function registerWeight(app: App, deps: RouteDeps): Promise<void> {
  const { platform } = deps;

  // POST /api/weight/log — manual measurement. Body { weight_kg, height_cm?, measured_at? }.
  // A manual log is "now" → refresh the current-weight/height scalars used elsewhere (Keytel HR).
  app.post("/api/weight/log", async (c) => {
    const uid = getUid(c);
    const store = platform.data.forUser(uid);
    const profile = await ensureProfile(platform, uid);
    const body = (await c.req.json().catch(() => ({}))) as {
      weight_kg?: unknown;
      height_cm?: unknown;
      measured_at?: string;
    };
    const kg = num(body.weight_kg);
    const heightCm = num(body.height_cm);
    if (!(kg > 0) && !(heightCm > 0)) return err(c, "weight_kg or height_cm required", 400);
    const rec = await addMeasurement(store, uid, {
      weight_kg: kg,
      height_cm: heightCm,
      source: "manual",
      measured_at: body.measured_at,
    });
    const patch: Partial<Profile> = {};
    if (kg > 0) patch.body_weight_kg = kg;
    if (heightCm > 0) patch.height_cm = heightCm;
    const profileId = (profile as { id?: string }).id;
    if (profileId && (patch.body_weight_kg !== undefined || patch.height_cm !== undefined)) {
      try {
        await store.update<Profile>("profiles", profileId, patch);
      } catch {
        /* non-fatal: measurement is saved either way */
      }
    }
    return ok(c, { ok: true, id: rec.id });
  });

  // POST /api/weight/sync — Apple Health body-mass import (native). Body { weights:[{id,date,kg}] }.
  // Dedupe by ext_id; then refresh the profile weight scalar + sync marker to the newest sample.
  app.post("/api/weight/sync", async (c) => {
    const uid = getUid(c);
    const store = platform.data.forUser(uid);
    const profile = await ensureProfile(platform, uid);
    const body = (await c.req.json().catch(() => ({}))) as {
      weights?: Array<{ id?: string; uuid?: string; kg?: unknown; date?: string }>;
    };
    const weights = Array.isArray(body.weights) ? body.weights.slice(0, 2000) : [];
    let added = 0;
    let skipped = 0;
    for (const w of weights) {
      const ext = ((w && (w.id || w.uuid)) || "").toString().trim();
      const kg = num(w.kg);
      if (!ext || !(kg > 0)) {
        skipped++;
        continue;
      }
      // Dedupe on ext_id (Apple Health sample UUID) — a re-sync must not double-count.
      let exists = false;
      try {
        const { items } = await store.list<Measurement>("measurements", {
          where: [{ field: "ext_id", op: "==", value: ext }],
          limit: 1,
        });
        exists = items.length > 0;
      } catch {
        exists = false;
      }
      if (exists) {
        skipped++;
        continue;
      }
      try {
        await addMeasurement(store, uid, { weight_kg: kg, source: "health", ext_id: ext, measured_at: w.date });
        added++;
      } catch {
        skipped++;
      }
    }
    const latest = await latestMeasurement(store);
    const syncedAt = new Date().toISOString();
    const patch: Partial<Profile> = { weight_synced_at: syncedAt };
    if (latest && num(latest.weight_kg) > 0) patch.body_weight_kg = num(latest.weight_kg);
    if (profile.weight_source !== "health") patch.weight_source = "health";
    const profileId = (profile as { id?: string }).id;
    if (profileId) {
      try {
        await store.update<Profile>("profiles", profileId, patch);
      } catch {
        /* non-fatal */
      }
    }
    return ok(c, { added, skipped, synced_at: syncedAt });
  });

  // GET /api/weight?range=day|week|month|year — series + current + goals-with-pace for the Weight tab.
  app.get("/api/weight", async (c) => {
    const uid = getUid(c);
    const store = platform.data.forUser(uid);
    const profile = await ensureProfile(platform, uid);
    const range = (c.req.query("range") || "month").toString();
    const win = periodWindow(range);
    let rows: Measurement[] = [];
    try {
      // Only the measured_at range is in the query (a range + orderBy on the SAME field is valid in
      // Firestore); the `weight_kg > 0` guard is applied app-side to avoid a second inequality field.
      const { items } = await store.list<Measurement>("measurements", {
        where: [
          { field: "measured_at", op: ">=", value: win.start },
          { field: "measured_at", op: "<", value: win.end },
        ],
        orderBy: [{ field: "measured_at", dir: "asc" }],
        limit: 2000,
      });
      rows = items.filter((r) => num(r.weight_kg) > 0);
    } catch {
      rows = [];
    }
    const series = rows.map((r) => ({ t: r.measured_at, weight_lb: kgToLb(num(r.weight_kg)) }));
    const curKg = await currentWeightKg(store, profile);
    return ok(c, {
      range,
      series,
      current_lb: curKg > 0 ? kgToLb(curKg) : 0,
      height_cm: num(profile.height_cm),
      weight_source: profile.weight_source || "",
      goals: await goalsWithPace(store, uid, curKg),
    });
  });

  // GET /api/weight/goals — active goals w/ pace vs the linear path.
  app.get("/api/weight/goals", async (c) => {
    const uid = getUid(c);
    const store = platform.data.forUser(uid);
    const profile = await ensureProfile(platform, uid);
    const curKg = await currentWeightKg(store, profile);
    return ok(c, { goals: await goalsWithPace(store, uid, curKg) });
  });

  // POST /api/weight/goals — { target_lb, target_date }. Caps at 3 active per user.
  app.post("/api/weight/goals", async (c) => {
    const uid = getUid(c);
    const store = platform.data.forUser(uid);
    const profile = await ensureProfile(platform, uid);
    const body = (await c.req.json().catch(() => ({}))) as { target_lb?: unknown; target_date?: string };
    const targetLb = num(body.target_lb);
    const targetDate = (body.target_date || "").toString().slice(0, 10);
    if (!(targetLb > 0)) return err(c, "target_lb required", 400);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(targetDate)) return err(c, "target_date (YYYY-MM-DD) required", 400);
    let count = 0;
    try {
      const { items } = await store.list<WeightGoal>("weight_goals", { limit: 10 });
      count = items.length;
    } catch {
      count = 0;
    }
    if (count >= 3) return err(c, "You can track up to 3 weight goals — remove one first.", 400);
    const curKg = await currentWeightKg(store, profile);
    const draft: Omit<WeightGoal, "id"> = {
      user: uid,
      target_kg: lbToKg(targetLb),
      target_date: targetDate,
      start_kg: curKg,
      start_date: todayStr(),
    };
    const rec = await store.create<WeightGoal>("weight_goals", draft);
    return ok(c, { ok: true, id: rec.id });
  });

  // DELETE /api/weight/goals/:id — owner-only (defense-in-depth 403 even though forUser scopes).
  app.delete("/api/weight/goals/:id", async (c) => {
    const uid = getUid(c);
    const store = platform.data.forUser(uid);
    const id = c.req.param("id");
    let rec: WeightGoal | null = null;
    try {
      rec = await store.get<WeightGoal>("weight_goals", id);
    } catch {
      rec = null;
    }
    if (!rec) return err(c, "not found", 404);
    if (rec.user !== uid) return err(c, "forbidden", 403);
    await store.delete("weight_goals", id);
    return ok(c, { deleted: id });
  });
}
