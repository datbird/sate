// Sate core — shared API helpers + the route-registration convention every domain module follows.
// These sit over the ports (never PocketBase/Firestore directly). Ported from the cross-cutting bits
// of pb_hooks/api.js: identity, tz-aware day bucketing, ensureProfile (+ default goals), and the
// food-KB grounding used to decide whether to offer a web lookup.

import type { Context, Hono, MiddlewareHandler } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { Platform } from "../ports";
import type { Food, Profile } from "../schema";
import * as foods from "../kb/foods";

// ---- Hono typing --------------------------------------------------------
// Every /api/* route runs after the auth middleware, which sets uid+email on the context.
export type AppVars = { Variables: { uid: string; email: string } };
export type App = Hono<AppVars>;

// Every domain module exports register<Name>(app, deps). `platform` is the adapter bundle; `requireAI`
// is the shared entitlement gate to mount on AI-backed routes (already wired in buildApi).
export interface RouteDeps {
  platform: Platform;
  requireAI: MiddlewareHandler<AppVars>;
}

// ---- identity -----------------------------------------------------------
// The authenticated Firebase uid / email (set by buildApi's auth middleware). uid is the per-user
// data key (v1 keyed on user_email; v2 keys on uid via data.forUser(uid)).
export const getUid = (c: Context<AppVars>): string => c.get("uid");
export const getEmail = (c: Context<AppVars>): string => c.get("email");

// ---- JSON response helpers ----------------------------------------------
export const ok = <T>(c: Context<AppVars>, data: T, status: number = 200): Response =>
  c.json(data as object, status as ContentfulStatusCode);
export const err = (c: Context<AppVars>, message: string, status: number = 400): Response =>
  c.json({ error: message }, status as ContentfulStatusCode);

// ---- tz-aware day bucketing ---------------------------------------------
// tzOffsetMin follows JS Date.getTimezoneOffset(): minutes to ADD to local time to get UTC (positive
// west of UTC). Bucket an ISO instant into the user's LOCAL calendar day — the "disappearing log" fix.
// Identical to buildApi's localDay; the one canonical day-key function for the whole API.
export function dayKey(loggedAtISO: string, tzOffsetMin = 0): string {
  const t = Date.parse(loggedAtISO) - (Number(tzOffsetMin) || 0) * 60000;
  return new Date(t).toISOString().slice(0, 10);
}

// ---- instance settings (key/value) --------------------------------------
async function instanceSettings(platform: Platform): Promise<Record<string, string>> {
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

// ---- ensureProfile ------------------------------------------------------
// Fetch the authenticated user's profile, auto-creating it (with default goals from instance settings)
// on first touch. There is exactly one profile document per user under data.forUser(uid) → "profiles".
// Ported from v1 ensureProfile/applyDefaultGoals (keyed on uid instead of email).
export async function ensureProfile(platform: Platform, uid: string, email?: string): Promise<Profile> {
  const store = platform.data.forUser(uid);
  try {
    const { items } = await store.list<Profile>("profiles", { limit: 1 });
    if (items[0]) return items[0];
  } catch {
    /* fall through to create */
  }
  const s = await instanceSettings(platform);
  const draft: Omit<Profile, "id"> & Record<string, unknown> = {
    user: uid,
    email: email || "",
    name: email ? email.split("@")[0] : "",
    sex: "",
    // v1 ensureProfile never set activity_level, so a fresh profile read back "" (the onboarding
    // "unset" signal). Seed "" here too — the plan engine falls back to the sedentary multiplier.
    activity_level: "",
    method: "calories",
    net_exercise: true,
    show_weight_in_feed: false,
    health_sync: false,
    health_sync_interval: 1440,
    hr_estimate_method: "formula",
    checkin_enabled: false,
    checkin_freq: "daily",
    role: "user",
    onboarded: false,
    edition: "", // not yet chosen — registration prompts hosted/self-host
  };
  if (s.default_goal_kcal) draft.goal_kcal = Number(s.default_goal_kcal) || 0;
  if (s.default_goal_protein) draft.goal_protein = Number(s.default_goal_protein) || 0;
  if (s.default_goal_carbs) draft.goal_carbs = Number(s.default_goal_carbs) || 0;
  if (s.default_goal_fat) draft.goal_fat = Number(s.default_goal_fat) || 0;
  try {
    return await store.create<Profile & { id?: string }>("profiles", draft as Omit<Profile, "id">);
  } catch {
    // Creation race/validation — return the draft as the effective profile so callers don't 500.
    return draft as Profile;
  }
}

// ---- food-KB grounding --------------------------------------------------
export interface FoodGrounding {
  /** The "Known foods from the database" block to prepend to the AI prompt (empty when no matches). */
  reference: string;
  /** The matched food rows (all matches, verified-first). */
  matched: Food[];
  /** True when the meal's distinctive words are covered by VERIFIED matches → suppress the web offer. */
  coverageOk: boolean;
}

// Ground a meal-logging request on the shared foods KB: search → reference block + coverage. Faithful
// to v1 estimate(): only *verified* matches count toward coverage (an unverified AI guess is exactly
// what a web search should be allowed to replace). The caller decides whether to offer a web lookup.
export async function foodGrounding(platform: Platform, text: string): Promise<FoodGrounding> {
  const store = platform.data.instance();
  let matched: Food[] = [];
  try {
    matched = await foods.searchByText(store, text);
  } catch {
    matched = [];
  }
  const reference = foods.referenceBlock(matched);
  const verified = matched.filter((f) => f.verified);
  const coverageOk = foods.coverageOk(text, verified);
  return { reference, matched, coverageOk };
}
