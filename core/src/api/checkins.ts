// Sate core — proactive coach check-ins: pending/seen/notified + generation run, plus HealthKit
// workout import. Ported faithfully from pb_hooks/api.js (checkinsPending/checkinSeen/checkinNotified/
// generateCheckins/generateCheckinFor/checkinContext + healthSync). v1 keyed everything on user_email;
// v2 keys on the Firebase uid via platform.data.forUser(uid). Per-user data (entries, measurements,
// weight_goals, profiles, checkins) is uid-scoped; the global `checkins_enabled` toggle + provider/model
// defaults live in the shared instance() `settings` collection.

import {
  getUid,
  getEmail,
  ok,
  err,
  dayKey,
  ensureProfile,
  type App,
  type RouteDeps,
} from "./helpers";
import { checkinDecide } from "../ai/index";
import * as nutrition from "../domain/nutrition";
import type { DataStore, Platform } from "../ports";
import type {
  Entry,
  Measurement,
  WeightGoal,
  Profile,
  Checkin,
  CheckinFreq,
} from "../schema";

// A profile document as stored — the schema type omits the store-assigned `id`, which we need to
// patch checkin_last_at / health_synced_at back onto the single per-user profile doc.
type ProfileDoc = Profile & { id: string };

// ---- small local utilities ---------------------------------------------
const num = (v: unknown): number => {
  const n = Number(v);
  return isFinite(n) ? n : 0;
};

// Read one instance setting (shared config). Missing collection/key → "".
async function instanceSetting(platform: Platform, key: string): Promise<string> {
  try {
    const { items } = await platform.data
      .instance()
      .list<{ id: string; key: string; value: string }>("settings", { limit: 500 });
    for (const r of items) if (r.key === key) return r.value;
  } catch {
    /* no settings collection */
  }
  return "";
}

// Global toggle: default ON when unset/blank; only an explicit "off" disables (v1 featureEnabled).
async function checkinsEnabled(platform: Platform): Promise<boolean> {
  return (await instanceSetting(platform, "checkins_enabled")) !== "off";
}

// The single per-user profile document (with its id), or null. ensureProfile guarantees it exists.
async function loadProfileDoc(platform: Platform, uid: string): Promise<ProfileDoc | null> {
  try {
    const { items } = await platform.data.forUser(uid).list<ProfileDoc>("profiles", { limit: 1 });
    return items[0] ?? null;
  } catch {
    return null;
  }
}

// ---- check-in generation (per-user core, reused by the run route) -------
// Per-user cadence → minimum gap between actual check-ins (hours). The AI still gates worthiness, so
// these are caps, not guarantees. "often" allows a few a day; "sparse" ~ every couple of days.
const CHECKIN_FREQ_GAP: Record<CheckinFreq, number> = { often: 3, daily: 20, sparse: 44 };
function checkinGapHours(freq: CheckinFreq): number {
  return CHECKIN_FREQ_GAP[freq] ?? CHECKIN_FREQ_GAP.daily;
}

// The latest weight sample (kg) if any, else the profile's stated body weight. (v1 latestMeasurement.)
async function currentWeightKg(store: DataStore, profile: Profile): Promise<number> {
  try {
    const { items } = await store.list<Measurement>("measurements", {
      where: [{ field: "weight_kg", op: ">", value: 0 }],
      orderBy: [{ field: "measured_at", dir: "desc" }],
      limit: 1,
    });
    if (items[0]?.weight_kg) return items[0].weight_kg;
  } catch {
    /* fall through to profile */
  }
  return profile.body_weight_kg || 0;
}

// Assemble the deterministic-engine input from the profile + saved goals (v1 buildPlanInput). Server-
// side, so `today` is UTC — the same convention v1 used for the check-in cron.
async function buildPlanInput(store: DataStore, profile: Profile): Promise<nutrition.PlanInput> {
  let goals: nutrition.WeightGoalInput[] = [];
  try {
    const { items } = await store.list<WeightGoal>("weight_goals", {
      orderBy: [{ field: "target_date", dir: "asc" }],
      limit: 5,
    });
    goals = items.map((g) => ({ target_kg: g.target_kg, target_date: g.target_date }));
  } catch {
    /* no goals */
  }
  return {
    name: (profile.name || "").split(/\s+/)[0] || "",
    curKg: await currentWeightKg(store, profile),
    cm: profile.height_cm || 0,
    age: profile.age ? Math.round(profile.age) : 0,
    sex: profile.sex || "",
    activity: profile.activity_level || "sedentary",
    method: profile.method || "calories",
    goals,
    today: new Date().toISOString().slice(0, 10),
  };
}

// Average food intake over the last `days` logged days (v1 recentIntake). Groups by UTC calendar day
// (logged_at slice) exactly like v1 so the cron's numbers match the historical behavior.
async function recentIntake(store: DataStore, days: number): Promise<nutrition.RecentIntake | null> {
  const startISO = new Date(Date.now() - days * 86400000).toISOString();
  let rows: Entry[] = [];
  try {
    const { items } = await store.list<Entry>("entries", {
      where: [{ field: "logged_at", op: ">=", value: startISO }],
      orderBy: [{ field: "logged_at", dir: "desc" }],
      limit: 500,
    });
    rows = items;
  } catch {
    rows = [];
  }
  const byDay: Record<string, { kcal: number; protein: number; carbs: number; fat: number }> = {};
  for (const r of rows) {
    if (r.kind === "activity") continue; // burn is never intake
    const day = r.logged_at.slice(0, 10);
    const b = byDay[day] || (byDay[day] = { kcal: 0, protein: 0, carbs: 0, fat: 0 });
    b.kcal += num(r.kcal);
    b.protein += num(r.macros?.protein);
    b.carbs += num(r.macros?.carbs);
    b.fat += num(r.macros?.fat);
  }
  const dayKeys = Object.keys(byDay);
  if (!dayKeys.length) return { days: 0, kcal: 0, protein: 0, carbs: 0, fat: 0 };
  const s = dayKeys.reduce(
    (a, d) => ({
      kcal: a.kcal + byDay[d]!.kcal,
      protein: a.protein + byDay[d]!.protein,
      carbs: a.carbs + byDay[d]!.carbs,
      fat: a.fat + byDay[d]!.fat,
    }),
    { kcal: 0, protein: 0, carbs: 0, fat: 0 },
  );
  const n = dayKeys.length;
  return {
    days: n,
    kcal: Math.round(s.kcal / n),
    protein: Math.round(s.protein / n),
    carbs: Math.round(s.carbs / n),
    fat: Math.round(s.fat / n),
  };
}

// Build the CONTEXT the check-in model reasons over: the same plan/intake grounding the coach uses,
// plus how recently the user has been logging (a key signal for "should we nudge?"). v1 checkinContext.
async function checkinContext(store: DataStore, profile: Profile): Promise<string> {
  const inp = await buildPlanInput(store, profile);
  const plan = nutrition.computePlan(inp);
  const base = nutrition.contextText(inp, plan, await recentIntake(store, 7));

  const todayUTC = new Date().toISOString().slice(0, 10);
  const yestUTC = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  let loggedToday = 0;
  let loggedYest = 0;
  let lastLog = "";
  try {
    const { items } = await store.list<Entry>("entries", {
      where: [{ field: "logged_at", op: ">=", value: yestUTC + "T00:00:00.000Z" }],
      orderBy: [{ field: "logged_at", dir: "desc" }],
      limit: 500,
    });
    for (const e of items) {
      const d = e.logged_at.slice(0, 10);
      if (d === todayUTC) loggedToday++;
      else if (d === yestUTC) loggedYest++;
    }
  } catch {
    /* leave counts at 0 */
  }
  try {
    const { items } = await store.list<Entry>("entries", {
      orderBy: [{ field: "logged_at", dir: "desc" }],
      limit: 1,
    });
    if (items[0]) lastLog = items[0].logged_at.slice(0, 16);
  } catch {
    /* no entries */
  }
  return (
    base +
    "\nLogging activity: " +
    loggedToday +
    " entries today, " +
    loggedYest +
    " yesterday" +
    (lastLog ? "; last entry " + lastLog + " UTC" : "; nothing logged recently") +
    "."
  );
}

// Run the check-in model for one profile; if it says a check-in is worthwhile, create the record and
// stamp the cooldown. Returns the created Checkin or null. `force` bypasses the anti-stack + cooldown
// gates (manual/admin trigger). Faithful to v1 generateCheckinFor.
async function generateCheckinFor(
  platform: Platform,
  uid: string,
  profile: ProfileDoc,
  force: boolean,
): Promise<Checkin | null> {
  const store = platform.data.forUser(uid);
  if (!force) {
    // Don't stack: skip if there's already a pending check-in the user hasn't seen.
    try {
      const { items } = await store.list<Checkin>("checkins", {
        where: [{ field: "status", op: "==", value: "pending" }],
        limit: 1,
      });
      if (items.length) return null;
    } catch {
      /* treat as no pending */
    }
    // Min gap between check-ins (per the user's chosen frequency).
    if (profile.checkin_last_at) {
      const ms = Date.now() - Date.parse(profile.checkin_last_at);
      if (isFinite(ms) && ms < checkinGapHours(profile.checkin_freq || "daily") * 3600 * 1000) return null;
    }
  }

  let decision;
  try {
    decision = await checkinDecide(platform, await checkinContext(store, profile));
  } catch {
    return null;
  }
  if (!decision.worthwhile) return null;
  const message = decision.message.trim();
  if (!message) return null;

  const created = await store.create<Checkin>("checkins", {
    user: uid,
    topic: (decision.topic || "Check-in").slice(0, 120),
    message: message.slice(0, 2000),
    status: "pending",
    notified: false,
    created: new Date().toISOString(),
  });
  try {
    await store.update<Profile>("profiles", profile.id, { checkin_last_at: new Date().toISOString() });
  } catch {
    /* cooldown stamp best-effort */
  }
  return created;
}

// ---- routes -------------------------------------------------------------
export async function registerCheckins(app: App, deps: RouteDeps): Promise<void> {
  const { platform, requireAI } = deps;

  // GET /api/checkins/pending — the user's latest pending (unseen) check-in, or null. Respects the
  // global toggle (returns null when check-ins are disabled instance-wide).
  app.get("/api/checkins/pending", async (c) => {
    const uid = getUid(c);
    if (!(await checkinsEnabled(platform))) return ok(c, { checkin: null });
    let latest: Checkin | null = null;
    try {
      const { items } = await platform.data.forUser(uid).list<Checkin>("checkins", {
        where: [{ field: "status", op: "==", value: "pending" }],
        orderBy: [{ field: "created", dir: "desc" }],
        limit: 1,
      });
      latest = items[0] ?? null;
    } catch {
      latest = null;
    }
    return ok(c, { checkin: latest });
  });

  // POST /api/checkins/:id/seen — mark a check-in seen (opened in the coach). 403 on non-owner.
  app.post("/api/checkins/:id/seen", async (c) => {
    const uid = getUid(c);
    const id = c.req.param("id");
    const store = platform.data.forUser(uid);
    let rec: Checkin | null;
    try {
      rec = await store.get<Checkin>("checkins", id);
    } catch {
      rec = null;
    }
    if (!rec) return err(c, "not found", 404);
    if (rec.user !== uid) return err(c, "forbidden", 403);
    await store.update<Checkin>("checkins", id, { status: "seen" });
    return ok(c, { ok: true });
  });

  // POST /api/checkins/:id/notified — mark that a local notification has been scheduled, so the app
  // doesn't schedule it again on the next open. 403 on non-owner.
  app.post("/api/checkins/:id/notified", async (c) => {
    const uid = getUid(c);
    const id = c.req.param("id");
    const store = platform.data.forUser(uid);
    let rec: Checkin | null;
    try {
      rec = await store.get<Checkin>("checkins", id);
    } catch {
      rec = null;
    }
    if (!rec) return err(c, "not found", 404);
    if (rec.user !== uid) return err(c, "forbidden", 403);
    await store.update<Checkin>("checkins", id, { notified: true });
    return ok(c, { ok: true });
  });

  // POST /api/checkins/run — generation. In v1 this was the daily cron body that iterated EVERY
  // opted-in profile. v2 identity is the uid and the DataStore only exposes forUser(uid)/instance(),
  // so there is no cross-user profile enumeration yet — this runs for the AUTHENTICATED user (the
  // manual/self path). A Cloud Scheduler cron authenticated as one user will still self-check; a true
  // all-users fan-out needs a cross-user index. Body { force? } bypasses the anti-stack + cooldown
  // gates; `email?` is accepted only when it matches the caller (no email→uid resolver in Phase 1).
  // Gated by requireAI (the generation makes an AI call).
  // TODO(phase2): add a users/collection-group enumeration port + email→uid resolver so a single
  // service-authenticated cron call can evaluate all opted-in users, and honor an arbitrary `email`.
  app.post("/api/checkins/run", requireAI, async (c) => {
    const uid = getUid(c);
    const email = getEmail(c);
    if (!(await checkinsEnabled(platform))) return ok(c, { evaluated: 0, created: 0, disabled: true });
    const body = (await c.req.json().catch(() => ({}))) as { email?: string; force?: boolean };
    const force = !!body.force;
    // v2 cannot resolve an arbitrary email to a uid/store; only the caller's own is reachable.
    if (body.email && String(body.email).toLowerCase() !== (email || "").toLowerCase()) {
      return ok(c, { evaluated: 0, created: 0, note: "cross-user email targeting is phase2" });
    }
    await ensureProfile(platform, uid, email);
    const profile = await loadProfileDoc(platform, uid);
    // v1 only ever evaluates profiles with checkin_enabled = true (the opt-in is not bypassed by force).
    if (!profile || !profile.checkin_enabled) return ok(c, { evaluated: 0, created: 0 });
    let made = 0;
    try {
      if (await generateCheckinFor(platform, uid, profile, force)) made = 1;
    } catch {
      made = 0;
    }
    return ok(c, { evaluated: 1, created: made });
  });

  // POST /api/health/sync — import Apple Health workouts from the native app as activity entries.
  // Body: { workouts: [{ id|uuid, name, start, end, duration_min, kcal, distance_m, intensity }],
  //         tz_offset_min? }. `id` is the HealthKit workout UUID; it dedupes re-syncs via entry.ext_id.
  // `kcal` is Apple's Active Energy (trustworthy) stored as the burn; distance_m → miles. Reaching
  // this endpoint means Health is connected, so health_sync is flipped on + health_synced_at stamped.
  app.post("/api/health/sync", async (c) => {
    const uid = getUid(c);
    const email = getEmail(c);
    await ensureProfile(platform, uid, email);
    const store = platform.data.forUser(uid);
    const body = (await c.req.json().catch(() => ({}))) as {
      workouts?: unknown;
      tz_offset_min?: number;
    };
    const tz = num(body.tz_offset_min);
    const workouts = Array.isArray(body.workouts) ? (body.workouts as Record<string, unknown>[]).slice(0, 500) : [];

    let added = 0;
    let skipped = 0;
    for (const w of workouts) {
      const ext = String((w && (w.id || w.uuid)) || "").trim();
      if (!ext) {
        skipped++;
        continue;
      }
      // Dedupe by external workout UUID.
      try {
        const { items } = await store.list<Entry>("entries", {
          where: [{ field: "ext_id", op: "==", value: ext }],
          limit: 1,
        });
        if (items.length) {
          skipped++;
          continue;
        }
      } catch {
        /* not found → import */
      }
      try {
        const kcal = Math.round(num(w.kcal));
        const minutes = Math.round(num(w.duration_min));
        const name = String(w.name || "Workout");
        const distanceMi = num(w.distance_m) > 0 ? +(num(w.distance_m) / 1609.34).toFixed(2) : 0;
        const loggedAt = new Date((w.start as string) || (w.end as string) || Date.now()).toISOString();
        await store.create<Entry>("entries", {
          user: uid,
          kind: "activity",
          source: "health",
          ext_id: ext,
          description: name,
          kcal, // burn (never counted as intake)
          duration_min: minutes,
          distance: distanceMi,
          intensity: w.intensity ? String(w.intensity) : "",
          items: [{ name, duration_min: minutes, kcal_burned: kcal }],
          logged_at: loggedAt,
          tz_offset_min: tz,
          day: dayKey(loggedAt, tz),
        });
        added++;
      } catch {
        skipped++;
      }
    }

    const syncedAt = new Date().toISOString();
    const profile = await loadProfileDoc(platform, uid);
    if (profile) {
      const patch: Partial<Profile> = { health_synced_at: syncedAt };
      if (!profile.health_sync) patch.health_sync = true;
      try {
        await store.update<Profile>("profiles", profile.id, patch);
      } catch {
        /* best-effort flag/stamp */
      }
    }

    // Today's intake totals (activity burn excluded), bucketed by the caller's local day.
    const today = dayKey(syncedAt, tz);
    const totals = { kcal: 0, protein: 0, carbs: 0, fat: 0, fiber: 0, sugar: 0, sodium: 0, sat_fat: 0, count: 0 };
    try {
      const { items } = await store.list<Entry>("entries", {
        where: [{ field: "day", op: "==", value: today }],
        limit: 500,
      });
      for (const e of items) {
        if (e.kind === "activity") continue;
        totals.count += 1;
        totals.kcal += num(e.kcal);
        totals.protein += num(e.macros?.protein);
        totals.carbs += num(e.macros?.carbs);
        totals.fat += num(e.macros?.fat);
        totals.fiber += num(e.macros?.fiber);
        totals.sugar += num(e.macros?.sugar);
        totals.sodium += num(e.macros?.sodium);
        totals.sat_fat += num(e.macros?.sat_fat);
      }
    } catch {
      /* leave totals zeroed */
    }

    return ok(c, { added, skipped, synced_at: syncedAt, totals });
  });
}
