// One-shot migration: PocketBase `data.db` (the Hosted edition's current store) → the core SQLite
// schema (`docs` table) used by the self-host `@sate/core` runtime. Read-only on the source; writes a
// fresh target DB. Idempotent (PB record ids become core doc ids). Run:
//   node dist/migrate.js <pb-data.db> <target-core.db>
// Transforms follow the audit map: user_email→user, flat macros→nested, text→bool/number/enum, field
// renames (body_sex→sex, body_age→age, track_mode→method), derive tz/day, dismissed→seen, seed edition.
import Database from "better-sqlite3";
import { SqliteData } from "./adapters/sqlite";

const TZ = 300; // US-Central (family locale); PB stores no per-entry tz → bucket the local day with this.

// dayKey — byte-identical to core/src/api/helpers.ts (local calendar day for the tz-aware stats bucket).
function dayKey(iso: string, tz = 0): string {
  const t = Date.parse(iso) - (Number(tz) || 0) * 60000;
  return new Date(t).toISOString().slice(0, 10);
}
const num = (v: unknown): number | undefined => (v == null || v === "" ? undefined : Number(v));
const isoOf = (v: unknown): string => (v ? new Date(String(v)).toISOString() : "");
const boolOf = (v: unknown, dflt: boolean): boolean => {
  if (v === true || v === 1) return true;
  if (v === false || v === 0) return false;
  const s = String(v ?? "").toLowerCase();
  if (["on", "yes", "true", "1"].includes(s)) return true;
  if (["off", "no", "false", "0", ""].includes(s)) return s === "" ? dflt : false;
  return dflt;
};
// Keep only defined/non-null keys (core schema treats absent as default).
const clean = <T extends Record<string, unknown>>(o: T): T =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null)) as T;
const jsonArr = (v: unknown): unknown[] | undefined => {
  if (Array.isArray(v)) return v;
  if (typeof v === "string" && v.trim()) {
    try {
      const p = JSON.parse(v);
      return Array.isArray(p) ? p : undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
};

function macrosOf(r: Record<string, unknown>): Record<string, number> | undefined {
  const m = clean({
    protein: num(r.protein),
    carbs: num(r.carbs),
    fat: num(r.fat),
    fiber: num(r.fiber),
    sugar: num(r.sugar),
    sodium: num(r.sodium),
    sat_fat: num(r.sat_fat),
  }) as Record<string, number>;
  return Object.keys(m).length ? m : undefined;
}

type Row = Record<string, unknown>;
const rows = (db: Database.Database, table: string): Row[] => {
  try {
    return db.prepare(`SELECT * FROM ${table}`).all() as Row[];
  } catch {
    return []; // collection absent in this PB instance
  }
};

async function main() {
  const [src, dest] = process.argv.slice(2);
  if (!src || !dest) {
    console.error("usage: node migrate.js <pb-data.db> <target-core.db>");
    process.exit(1);
  }
  const pb = new Database(src, { readonly: true, fileMustExist: true });
  const data = new SqliteData(dest);
  const counts: Record<string, number> = {};
  const bump = (k: string) => (counts[k] = (counts[k] || 0) + 1);

  // ---- profiles (per-user; identity = email → uid) ----
  for (const r of rows(pb, "profiles")) {
    const email = String(r.email || "").toLowerCase();
    if (!email) continue;
    await data.forUser(email).create(
      "profiles",
      clean({
        user: email,
        email,
        name: r.name || email.split("@")[0],
        sex: r.body_sex || "",
        age: num(r.body_age),
        height_cm: num(r.height_cm),
        body_weight_kg: num(r.body_weight_kg),
        activity_level: r.activity_level || "",
        method: r.track_mode || "calories",
        goal_kcal: num(r.goal_kcal),
        goal_protein: num(r.goal_protein),
        goal_carbs: num(r.goal_carbs),
        goal_fat: num(r.goal_fat),
        goal_sodium: num(r.goal_sodium),
        net_exercise: boolOf(r.net_exercise, true),
        health_sync: boolOf(r.health_sync, false),
        health_sync_interval: num(r.health_sync_interval) ?? 1440,
        health_synced_at: r.health_synced_at || undefined,
        weight_source: r.weight_source || undefined,
        weight_synced_at: r.weight_synced_at || undefined,
        hr_estimate_method: r.hr_estimate_method || "formula",
        onboarded: boolOf(r.onboarded, false),
        checkin_enabled: boolOf(r.checkin_enabled, false),
        checkin_time: r.checkin_time || undefined,
        checkin_freq: r.checkin_freq || "daily",
        checkin_last_at: r.checkin_last_at || undefined,
        role: r.role || "user",
        edition: "selfhost",
      }),
      String(r.id || ""),
    );
    bump("profiles");
  }

  // ---- entries (per-user; user_email→user, flat macros→nested, derive day) ----
  for (const r of rows(pb, "entries")) {
    const user = String(r.user_email || "").toLowerCase();
    if (!user) continue;
    const logged_at = isoOf(r.logged_at) || new Date(0).toISOString();
    await data.forUser(user).create(
      "entries",
      clean({
        user,
        kind: r.kind || "food",
        description: r.description || "",
        note: r.note || undefined,
        kcal: num(r.kcal) ?? 0,
        macros: macrosOf(r),
        items: jsonArr(r.items),
        source: r.source || "manual",
        provider: r.provider || undefined,
        model: r.model || undefined,
        photo: r.photo || undefined,
        logged_at,
        tz_offset_min: TZ,
        day: dayKey(logged_at, TZ),
        duration_min: num(r.duration_min),
        distance: num(r.distance),
        intensity: r.intensity || undefined,
        ext_id: r.ext_id || undefined,
      }),
      String(r.id || ""),
    );
    bump("entries");
  }

  // ---- measurements (per-user) ----
  for (const r of rows(pb, "measurements")) {
    const user = String(r.user_email || "").toLowerCase();
    if (!user) continue;
    await data.forUser(user).create(
      "measurements",
      clean({ user, measured_at: r.measured_at, weight_kg: num(r.weight_kg), height_cm: num(r.height_cm), source: r.source || "manual", ext_id: r.ext_id || undefined }),
      String(r.id || ""),
    );
    bump("measurements");
  }

  // ---- weight_goals (per-user; drop achieved_at — no core field) ----
  for (const r of rows(pb, "weight_goals")) {
    const user = String(r.user_email || "").toLowerCase();
    if (!user) continue;
    await data.forUser(user).create(
      "weight_goals",
      clean({ user, target_kg: num(r.target_kg), target_date: r.target_date, start_kg: num(r.start_kg), start_date: r.start_date || undefined }),
      String(r.id || ""),
    );
    bump("weight_goals");
  }

  // ---- checkins (per-user; status dismissed→seen) ----
  for (const r of rows(pb, "checkins")) {
    const user = String(r.user_email || "").toLowerCase();
    if (!user) continue;
    const status = r.status === "pending" ? "pending" : "seen";
    await data.forUser(user).create(
      "checkins",
      clean({ user, topic: r.topic || "", message: r.message || "", status, notified: boolOf(r.notified, false), created: r.created || undefined }),
      String(r.id || ""),
    );
    bump("checkins");
  }

  // ---- foods KB (instance-scoped; flat; drop serving_g; source user→manual) ----
  for (const r of rows(pb, "foods")) {
    await data.instance().create(
      "foods",
      clean({
        name: r.name,
        brand: r.brand || "",
        serving_desc: r.serving_desc || "1 serving",
        kcal: num(r.kcal) ?? 0,
        protein: num(r.protein) ?? 0,
        carbs: num(r.carbs) ?? 0,
        fat: num(r.fat) ?? 0,
        fiber: num(r.fiber) ?? 0,
        sugar: num(r.sugar) ?? 0,
        sodium: num(r.sodium) ?? 0,
        sat_fat: num(r.sat_fat) ?? 0,
        category: r.category || "",
        barcode: r.barcode || undefined,
        aliases: jsonArr(r.aliases) || [],
        source: r.source === "user" ? "manual" : r.source || "manual",
        verified: boolOf(r.verified, false),
        usage_count: num(r.usage_count) ?? 0,
        search: r.search || "",
        norm_key: r.norm_key || "",
      }),
      String(r.id || ""),
    );
    bump("foods");
  }

  // ---- activities KB (instance-scoped; flat) ----
  for (const r of rows(pb, "activities")) {
    await data.instance().create(
      "activities",
      clean({
        name: r.name,
        category: r.category || "",
        met: num(r.met) ?? 0,
        aliases: jsonArr(r.aliases) || [],
        source: r.source || "seed",
        verified: boolOf(r.verified, false),
        usage_count: num(r.usage_count) ?? 0,
        search: r.search || "",
        norm_key: r.norm_key || "",
      }),
      String(r.id || ""),
    );
    bump("activities");
  }

  // ---- instance config/telemetry (carried verbatim into instance() store; admin reads these) ----
  for (const table of ["settings", "providers", "function_config", "sources", "ai_usage", "ai_limits", "ai_prices"]) {
    for (const r of rows(pb, table)) {
      const { created: _c, updated: _u, ...rest } = r;
      await data.instance().create(table, clean(rest as Record<string, unknown>), String(r.id || ""));
      bump(table);
    }
  }
  // Skipped by design: sync_queue (sync infra), users (auth → proxy header now).

  console.log("Migration complete → " + dest);
  for (const [k, v] of Object.entries(counts).sort()) console.log(`  ${k.padEnd(16)} ${v}`);
}

main().catch((e) => {
  console.error("MIGRATION FAILED:", e);
  process.exit(1);
});
