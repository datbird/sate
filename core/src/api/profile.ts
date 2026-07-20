// Sate core — profile + daily goals + auth-config + stats-rollup routes.
// Faithful port of the v1 pb_hooks/api.js handlers: authConfig, me, setGoals, statsRange
// (see pb_hooks/main.pb.js for the original /api/sate/* wiring). Identity is the Firebase uid
// (v1 keyed profiles on user_email; v2 scopes per-user data via platform.data.forUser(uid)).

import {
  getUid, getEmail, ok, err, dayKey, ensureProfile,
  type App, type RouteDeps,
} from "./helpers";
import type { Platform } from "../ports";
import {
  GOAL_METHODS, ACTIVITY_LEVELS,
  type Entry, type Profile, type GoalMethod, type ActivityLevel,
} from "../schema";
import { getEntitlements } from "../entitlements/index";

// ---- local helpers the contract didn't provide ---------------------------

// Instance key/value settings (app_name, auth_mode, global feature toggles). Mirrors v1 settingsMap.
async function settingsMap(platform: Platform): Promise<Record<string, string>> {
  try {
    const { items } = await platform.data
      .instance()
      .list<{ id: string; key: string; value: string }>("settings", { limit: 500 });
    const m: Record<string, string> = {};
    for (const r of items) m[r.key] = r.value;
    return m;
  } catch {
    return {};
  }
}

// Global feature toggles default ON unless explicitly "off" (v1 featureEnabled).
const featureEnabled = (s: Record<string, string>, key: string): boolean => s[key] !== "off";

// Deploy-time admin allow-list (v1 ADMIN_EMAILS env). Core has no direct env access, so it is provided
// through the Secrets port as the comma/space-separated secret `admin-emails`. This is the bootstrap
// that mints the FIRST admin (before any admin exists to promote others): an env admin is always admin
// and is force-promoted to role="admin" on first /me touch so the role persists for later admin checks.
async function envAdminEmails(platform: Platform): Promise<string[]> {
  try {
    const raw = (await platform.secrets.get("admin-emails")) || "";
    return raw.toLowerCase().split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

// Intake totals for the ring/goals. Activity entries carry kcal as *burn* (never intake) so they
// are skipped — faithful to v1 sumTotals. v2 food entries keep macros nested under `macros`.
interface Totals {
  kcal: number; protein: number; carbs: number; fat: number;
  fiber: number; sugar: number; sodium: number; sat_fat: number; count: number;
}
function sumIntake(entries: Entry[]): Totals {
  const t: Totals = { kcal: 0, protein: 0, carbs: 0, fat: 0, fiber: 0, sugar: 0, sodium: 0, sat_fat: 0, count: 0 };
  for (const e of entries) {
    if (e.kind === "activity") continue;
    const m = e.macros;
    t.count += 1;
    t.kcal += e.kcal || 0;
    t.protein += m?.protein || 0;
    t.carbs += m?.carbs || 0;
    t.fat += m?.fat || 0;
    t.fiber += m?.fiber || 0;
    t.sugar += m?.sugar || 0;
    t.sodium += m?.sodium || 0;
    t.sat_fat += m?.sat_fat || 0;
  }
  return t;
}

// The five saved daily goals the ring counts down (v1 goalsOf).
function goalsOf(p: Profile) {
  return {
    kcal: p.goal_kcal || 0,
    protein: p.goal_protein || 0,
    carbs: p.goal_carbs || 0,
    fat: p.goal_fat || 0,
    sodium: p.goal_sodium || 0,
  };
}

// The profile-derived block shared by /me and /goals responses. v1 concept map applied:
// method←track_mode, sex←body_sex, age←body_age. v2 stores booleans natively (v1 used "on"/"yes").
function profileView(p: Profile) {
  return {
    name: p.name || "",
    goals: goalsOf(p),
    track_mode: p.method || "calories",
    net_exercise: p.net_exercise !== false,
    show_weight_in_feed: !!p.show_weight_in_feed,
    health_sync: !!p.health_sync,
    health_sync_interval:
      typeof p.health_sync_interval === "number" && p.health_sync_interval >= 0 ? p.health_sync_interval : 1440,
    health_synced_at: p.health_synced_at || "",
    hr_estimate_method: p.hr_estimate_method === "ai" ? "ai" : "formula",
    body_weight_kg: p.body_weight_kg || 0,
    body_age: Math.round(p.age || 0),
    body_sex: p.sex || "",
    weight_source: p.weight_source || "",
    height_cm: p.height_cm || 0,
    weight_synced_at: p.weight_synced_at || "",
    activity_level: p.activity_level || "",
    onboarded: !!p.onboarded,
    checkin_enabled: !!p.checkin_enabled,
    checkin_time: p.checkin_time || "",
    checkin_freq: p.checkin_freq || "daily",
  };
}

// ---- stats windowing (v1 periodWindow + rangeEntries, over the local `day` bucket) --------
type Range = "day" | "week" | "month" | "year";

// Half-open [startDay, endDay) window of LOCAL calendar days ending today (inclusive), plus the
// trend-series bucket granularity. Uses the stored `day` field (already the tz-aware local bucket),
// so string comparison on YYYY-MM-DD gives the same window v1 computed from logged_at bounds.
function rangeWindow(range: Range, tzOffsetMin: number) {
  const days = range === "day" ? 1 : range === "week" ? 7 : range === "month" ? 30 : 365;
  const bucket: "day" | "month" = range === "year" ? "month" : "day";
  const today = dayKey(new Date().toISOString(), tzOffsetMin);
  const anchor = Date.parse(today + "T00:00:00.000Z");
  const startDay = new Date(anchor - (days - 1) * 86400000).toISOString().slice(0, 10);
  const endDay = new Date(anchor + 86400000).toISOString().slice(0, 10); // exclusive
  return { days, bucket, startDay, endDay, today };
}

// Fetch every entry in the local-day window, paging past the per-list cap (month/year windows).
async function fetchDayRange(platform: Platform, uid: string, startDay: string, endDay: string): Promise<Entry[]> {
  const store = platform.data.forUser(uid);
  const out: Entry[] = [];
  let cursor: string | undefined;
  for (let guard = 0; guard < 50; guard++) {
    const page = await store.list<Entry>("entries", {
      where: [
        { field: "day", op: ">=", value: startDay },
        { field: "day", op: "<", value: endDay },
      ],
      orderBy: [{ field: "day", dir: "asc" }],
      limit: 500,
      cursor,
    });
    out.push(...page.items);
    if (!page.nextCursor || page.items.length === 0) break;
    cursor = page.nextCursor;
  }
  return out;
}

// ---- registration --------------------------------------------------------

export async function registerProfile(app: App, deps: RouteDeps): Promise<void> {
  const { platform } = deps;

  // GET /api/auth-config — PUBLIC. v1 authConfig reported the auth mode + app name pre-login so the
  // client knows how to sign in. v2 auth is Firebase; `mode` comes from settings.auth_mode (default
  // "firebase"). Deliberately registered OUTSIDE the /api/* auth guard so it is reachable unauthenticated.
  // TODO(phase2): surface the Apple-provider-configured flag once provider admin lands (v1 apple_configured).
  app.get("/auth-config", async (c) => {
    const s = await settingsMap(platform);
    return ok(c, {
      mode: s.auth_mode || "firebase",
      app_name: s.app_name || "Sate",
    });
  });

  // GET /api/me — identity + role + saved goals/prefs + today's intake totals (v1 me()).
  app.get("/api/me", async (c) => {
    const uid = getUid(c);
    const email = getEmail(c);
    const profile = await ensureProfile(platform, uid, email);
    const s = await settingsMap(platform);
    const tz = Number(c.req.query("tz") || 0);
    const today = dayKey(new Date().toISOString(), tz);
    const { items } = await platform.data.forUser(uid).list<Entry>("entries", {
      where: [{ field: "day", op: "==", value: today }],
      limit: 500,
    });

    // Admin = env-admin (deploy-time bootstrap) OR in-app promoted role (v1 resolveIsAdmin). An env
    // admin is force-promoted to role="admin" on first touch so it survives + drives later role checks.
    const admins = await envAdminEmails(platform);
    const isEnvAdmin = !!email && admins.includes(email.toLowerCase());
    let role = profile.role || "user";
    if (isEnvAdmin && role !== "admin") {
      role = "admin";
      const pid = (profile as Profile & { id?: string }).id;
      if (pid) {
        try {
          await platform.data.forUser(uid).update<Profile>("profiles", pid, { role: "admin" });
        } catch {
          /* force-promotion is best-effort; isAdmin below still reflects env-admin this request */
        }
      }
    }
    // Edition + effective entitlements (skus + expiring{sku→ISO}) so the client can render the
    // hosted/self-host state and any active trial countdown. Reuses the 60s entitlement cache.
    const ent = await getEntitlements(platform, email);
    return ok(c, {
      email,
      role,
      isAdmin: role === "admin",
      auth_mode: s.auth_mode || "firebase",
      app_name: s.app_name || "Sate",
      ...profileView(profile),
      edition: (profile as Profile & { edition?: string }).edition || "",
      entitlements: { skus: ent.skus, expiring: ent.expiring },
      checkins_enabled: featureEnabled(s, "checkins_enabled"), // global admin toggle
      second_opinion_enabled: featureEnabled(s, "second_opinion_enabled"), // global admin toggle
      // TODO(phase2): provider-key-based setup detection (v1 setupDone also inspected `providers`).
      setup_done: s.setup_complete === "yes",
      today,
      totals: sumIntake(items),
    });
  });

  // PATCH /api/goals — update saved goals + track mode + body/HR/health/check-in prefs + onboarding
  // (v1 setGoals()). Only provided keys are touched; unknown/invalid values are coerced or ignored.
  app.patch("/api/goals", async (c) => {
    const uid = getUid(c);
    const email = getEmail(c);
    const profile = await ensureProfile(platform, uid, email);
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const patch: Partial<Profile> & Record<string, unknown> = {};

    for (const k of ["goal_kcal", "goal_protein", "goal_carbs", "goal_fat", "goal_sodium"] as const) {
      const v = b[k];
      if (v !== undefined && v !== null && v !== "") patch[k] = Number(v) || 0;
    }
    // v1 client sends `track_mode`; v2 field is `method`. Accept either.
    const mode = b.track_mode ?? b.method;
    if (mode !== undefined && (GOAL_METHODS as readonly string[]).includes(String(mode))) {
      patch.method = String(mode) as GoalMethod;
    }
    if (b.net_exercise !== undefined) patch.net_exercise = !!b.net_exercise;
    if (b.show_weight_in_feed !== undefined) patch.show_weight_in_feed = !!b.show_weight_in_feed;
    if (b.health_sync !== undefined) patch.health_sync = !!b.health_sync;
    if (b.health_sync_interval !== undefined) {
      const v = parseInt(String(b.health_sync_interval), 10);
      if (!isNaN(v) && v >= 0) patch.health_sync_interval = v;
    }
    if (b.hr_estimate_method !== undefined) {
      patch.hr_estimate_method = b.hr_estimate_method === "ai" ? "ai" : "formula";
    }
    if (b.body_weight_kg !== undefined && b.body_weight_kg !== null && b.body_weight_kg !== "") {
      patch.body_weight_kg = Number(b.body_weight_kg) || 0;
    }
    // v1 body_age → v2 age.
    if (b.body_age !== undefined && b.body_age !== null && b.body_age !== "") {
      patch.age = Number(b.body_age) || 0;
    }
    // v1 body_sex → v2 sex.
    if (b.body_sex !== undefined) {
      const sx = String(b.body_sex).toLowerCase();
      patch.sex = sx === "male" || sx === "female" ? sx : "";
    }
    if (b.weight_source !== undefined) {
      const ws = String(b.weight_source);
      patch.weight_source = ws === "health" || ws === "manual" ? ws : "";
    }
    if (b.height_cm !== undefined && b.height_cm !== null && b.height_cm !== "") {
      patch.height_cm = Number(b.height_cm) || 0;
    }
    if (b.activity_level !== undefined) {
      const a = String(b.activity_level);
      // v1 setGoals stored "" for an unrecognized level (N.ACTIVITY_MULT[a] ? a : ""), preserving the
      // onboarding "unset" signal; coercing to "sedentary" would falsely look like a chosen level.
      patch.activity_level = ((ACTIVITY_LEVELS as readonly string[]).includes(a) ? a : "") as ActivityLevel | "";
    }
    if (b.onboarded !== undefined) patch.onboarded = !!b.onboarded;
    if (b.name !== undefined) patch.name = String(b.name).slice(0, 60).trim();
    if (b.checkin_enabled !== undefined) patch.checkin_enabled = !!b.checkin_enabled;
    if (b.checkin_time !== undefined) {
      const t = String(b.checkin_time || "");
      patch.checkin_time = /^\d{1,2}:\d{2}$/.test(t) ? t : "";
    }
    if (b.checkin_freq !== undefined) {
      const f = String(b.checkin_freq || "");
      patch.checkin_freq = (["often", "daily", "sparse"].includes(f) ? f : "daily") as Profile["checkin_freq"];
    }

    const store = platform.data.forUser(uid);
    const pid = (profile as Profile & { id?: string }).id;
    // Defense-in-depth ownership check (forUser already isolates the user, but v1 kept the guard).
    if (pid && profile.user && profile.user !== uid) return err(c, "forbidden", 403);
    const updated: Profile = pid
      ? await store.update<Profile>("profiles", pid, patch as Partial<Profile>)
      : ({ ...profile, ...patch } as Profile);

    return ok(c, profileView(updated));
  });

  // GET /api/stats?range=day|week|month|year&tz=<min> — server-side dashboard rollup with a
  // local-day (or month, for year) trend series + averages (v1 statsRange()).
  // SEAM: buildApi (api/index.ts) still defines a day-only /api/stats stub — its owner should DELETE
  // that stub when wiring registerProfile so this range-aware handler is the sole /api/stats.
  app.get("/api/stats", async (c) => {
    const uid = getUid(c);
    const email = getEmail(c);
    const raw = String(c.req.query("range") || "day");
    const range: Range = (["day", "week", "month", "year"] as const).includes(raw as Range) ? (raw as Range) : "day";
    const tz = Number(c.req.query("tz") || 0);
    const w = rangeWindow(range, tz);

    const recs = await fetchDayRange(platform, uid, w.startDay, w.endDay);
    const nutrition: Entry[] = [];
    const activity: Entry[] = [];
    for (const r of recs) (r.kind === "activity" ? activity : nutrition).push(r);

    const intake = sumIntake(nutrition);
    let burn = 0;
    let minutes = 0;
    for (const r of activity) {
      burn += r.kcal || 0;
      minutes += r.duration_min || 0;
    }

    // Trend series bucketed by local day (week/month) or local month (year). entry.day is already
    // the tz-aware local bucket, so slice(0,7) collapses to the month with no re-mapping.
    const bucketOf = (e: Entry): string => (w.bucket === "month" ? (e.day || "").slice(0, 7) : e.day || "");
    const buckets: Record<string, { bucket: string; in_kcal: number; out_kcal: number }> = {};
    const order: string[] = [];
    for (const r of recs) {
      const k = bucketOf(r);
      if (!k) continue;
      if (!buckets[k]) {
        buckets[k] = { bucket: k, in_kcal: 0, out_kcal: 0 };
        order.push(k);
      }
      if (r.kind === "activity") buckets[k].out_kcal += r.kcal || 0;
      else buckets[k].in_kcal += r.kcal || 0;
    }
    order.sort();
    const series = order.map((k) => buckets[k]);

    const profile = await ensureProfile(platform, uid, email);
    const activeDays = new Set(recs.map(bucketOf).filter(Boolean)).size || 1;

    return ok(c, {
      range,
      days: w.days, // calendar days in the window (goal scaling)
      in: intake, // kcal + 7 nutrients + count, summed over the window
      out: { kcal: Math.round(burn), minutes: Math.round(minutes), workouts: activity.length },
      avg_in_kcal: Math.round(intake.kcal / activeDays),
      avg_out_kcal: Math.round(burn / activeDays),
      goals: goalsOf(profile),
      net_exercise: profile.net_exercise !== false,
      series,
    });
  });
}
