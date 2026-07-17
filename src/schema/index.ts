// Sate core — canonical data schemas (zod) + inferred TypeScript types.
// One source of truth for the shapes that flow through every layer and both platforms.

import { z } from "zod";

// ---- enumerations -------------------------------------------------------
export const SEXES = ["male", "female", ""] as const;
export type Sex = (typeof SEXES)[number];

export const GOAL_METHODS = ["calories", "carb", "protein", "fat", "balanced", "heart"] as const;
export type GoalMethod = (typeof GOAL_METHODS)[number];

export const ACTIVITY_LEVELS = ["sedentary", "light", "moderate", "active", "athlete"] as const;
export type ActivityLevel = (typeof ACTIVITY_LEVELS)[number];

export const ENTRY_KINDS = ["food", "activity"] as const;
export type EntryKind = (typeof ENTRY_KINDS)[number];

// ---- macros -------------------------------------------------------------
export const Macros = z.object({
  protein: z.number().nonnegative().default(0),
  carbs: z.number().nonnegative().default(0),
  fat: z.number().nonnegative().default(0),
  fiber: z.number().nonnegative().optional(),
  sugar: z.number().nonnegative().optional(),
  sodium: z.number().nonnegative().optional(),
  sat_fat: z.number().nonnegative().optional(),
});
export type Macros = z.infer<typeof Macros>;

// ---- food line item (inside an entry) -----------------------------------
export const FoodItem = z.object({
  name: z.string(),
  kcal: z.number().default(0),
  qty: z.string().optional(),
  macros: Macros.optional(),
  // v1 also stored flat per-item macros on food items; keep them optional so a route that
  // writes {name, qty, kcal, protein, carbs, fat} (v1 shape) still type-checks.
  protein: z.number().optional(),
  carbs: z.number().optional(),
  fat: z.number().optional(),
});
export type FoodItem = z.infer<typeof FoodItem>;

// ---- activity line item (inside an activity entry) ----------------------
// The exercise counterpart to FoodItem. kcal_burned is this item's contribution to the entry's
// burn; avg_hr/max_hr are carried through for heart-rate–derived activities.
export const ActivityItem = z.object({
  name: z.string(),
  duration_min: z.number().optional(),
  intensity: z.string().optional(),
  kcal_burned: z.number().optional(),
  avg_hr: z.number().optional(),
  max_hr: z.number().optional(),
});
export type ActivityItem = z.infer<typeof ActivityItem>;

// An entry's line items are food OR activity items depending on `kind`.
export const EntryItem = z.union([FoodItem, ActivityItem]);
export type EntryItem = z.infer<typeof EntryItem>;

// ---- diary entry (food OR activity) -------------------------------------
// kind="food": kcal = intake, macros populated. kind="activity": kcal = burn (never counted
// as intake), duration/distance/intensity populated. logged_at is ISO; tz_offset_min lets the
// server bucket by the user's LOCAL calendar day (the "disappearing log" fix, ported forward).
export const Entry = z.object({
  id: z.string(),
  user: z.string(), // Firebase uid (v1 user_email → uid)
  kind: z.enum(ENTRY_KINDS).default("food"),
  description: z.string(),
  note: z.string().optional(),
  kcal: z.number().default(0), // food: intake kcal; activity: burn kcal (never intake)
  macros: Macros.optional(),
  items: z.array(EntryItem).optional(),
  source: z.string().default("manual"), // manual|text|ai|db|web|barcode|photo|preset|activity_ai|health|heart_rate…
  provider: z.string().optional(), // AI provider that produced the estimate (audit)
  model: z.string().optional(), // AI model that produced the estimate (audit)
  photo: z.string().optional(), // FileStorage key / data-URL for a photo-logged entry
  logged_at: z.string(),
  tz_offset_min: z.number().default(0), // "tz" concept: JS getTimezoneOffset() minutes
  day: z.string().optional(), // local calendar day (tz-aware bucket) for day queries/stats
  // activity-only
  duration_min: z.number().optional(),
  distance: z.number().optional(), // miles
  intensity: z.string().optional(),
  met: z.number().optional(),
  ext_id: z.string().optional(), // external-source dedup key (e.g. Apple Health workout UUID)
});
export type Entry = z.infer<typeof Entry>;

// ---- food knowledge base (shared instance() collection "foods") ---------
// Flat macro columns (NOT nested Macros) — this mirrors the v1 `foods` collection exactly, because
// the KB modules (core/src/kb) read/write these fields directly over the DataStore. `norm_key`
// (normKey(name,brand)) is the upsert identity; `search` is the lowercased match blob; `usage_count`
// drives the "most-used" ranking tiebreak; `verified`/seed rows are protected from AI overwrites.
export const Food = z.object({
  id: z.string(),
  name: z.string(),
  brand: z.string().default(""),
  serving_desc: z.string().default("1 serving"),
  kcal: z.number().default(0),
  protein: z.number().default(0),
  carbs: z.number().default(0),
  fat: z.number().default(0),
  fiber: z.number().default(0),
  sugar: z.number().default(0),
  sodium: z.number().default(0), // milligrams
  sat_fat: z.number().default(0),
  category: z.string().default(""),
  barcode: z.string().optional(),
  aliases: z.array(z.string()).default([]),
  source: z.string().default("manual"), // seed|usda|off|ai|web|manual|barcode
  verified: z.boolean().default(false),
  usage_count: z.number().default(0),
  search: z.string().default(""),
  norm_key: z.string().default(""),
});
export type Food = z.infer<typeof Food>;

// ---- activity knowledge base (shared instance() collection "activities") -
// The exercise counterpart to Food. Stores a MET value; kcal/min is derived (kb/activities burnFor).
export const Activity = z.object({
  id: z.string(),
  name: z.string(),
  category: z.string().default(""),
  met: z.number().default(0),
  aliases: z.array(z.string()).default([]),
  source: z.string().default("manual"), // seed|ai
  verified: z.boolean().default(false),
  usage_count: z.number().default(0),
  search: z.string().default(""),
  norm_key: z.string().default(""),
});
export type Activity = z.infer<typeof Activity>;

// ---- body measurements (weight/height time series) ----------------------
export const Measurement = z.object({
  id: z.string(),
  user: z.string(),
  measured_at: z.string(), // ISO — the weight/height sample time (v1 field name preserved)
  weight_kg: z.number().optional(),
  height_cm: z.number().optional(),
  source: z.string().default("manual"), // manual|health
  ext_id: z.string().optional(), // Apple Health sample UUID (dedup)
});
export type Measurement = z.infer<typeof Measurement>;

// ---- weight goals (cap 3, enforced by the API) --------------------------
export const WeightGoal = z.object({
  id: z.string(),
  user: z.string(),
  target_kg: z.number().positive(),
  target_date: z.string(),
  start_kg: z.number().optional(),
  start_date: z.string().optional(),
});
export type WeightGoal = z.infer<typeof WeightGoal>;

// ---- proactive coach check-in -------------------------------------------
export const CHECKIN_STATUSES = ["pending", "seen"] as const;
export type CheckinStatus = (typeof CHECKIN_STATUSES)[number];

export const CHECKIN_FREQS = ["often", "daily", "sparse"] as const;
export type CheckinFreq = (typeof CHECKIN_FREQS)[number];

export const HR_ESTIMATE_METHODS = ["formula", "ai"] as const;
export type HrEstimateMethod = (typeof HR_ESTIMATE_METHODS)[number];

// One per-user check-in the coach decided was worthwhile. status starts "pending" (unseen);
// `notified` guards re-scheduling a local notification. Ported from the v1 `checkins` collection.
export const Checkin = z.object({
  id: z.string(),
  user: z.string(),
  topic: z.string().default(""), // 3-6 word notification title
  message: z.string(),
  status: z.enum(CHECKIN_STATUSES).default("pending"),
  notified: z.boolean().default(false),
  created: z.string().optional(), // server create timestamp
});
export type Checkin = z.infer<typeof Checkin>;

// ---- per-user profile ---------------------------------------------------
// Identity is the Firebase uid (`user`); `email` is carried for display + entitlement checks.
export const Profile = z.object({
  user: z.string(),
  email: z.string().optional(),
  name: z.string().optional(),
  sex: z.enum(SEXES).default(""), // v1 body_sex
  age: z.number().optional(), // v1 body_age
  height_cm: z.number().optional(),
  body_weight_kg: z.number().optional(),
  // "" = never-onboarded (the client's "hasn't picked a level yet" signal); the plan engine falls
  // back to the sedentary multiplier for it. v1 setGoals stored "" for an unset/unrecognized level
  // and ensureProfile never seeded one, so a fresh profile read back "".
  activity_level: z.enum([...ACTIVITY_LEVELS, ""] as const).default(""),
  method: z.enum(GOAL_METHODS).default("calories"), // v1 track_mode
  // Saved daily goals (what the ring counts down; stats echoes these back).
  goal_kcal: z.number().optional(),
  goal_protein: z.number().optional(),
  goal_carbs: z.number().optional(),
  goal_fat: z.number().optional(),
  goal_sodium: z.number().optional(),
  net_exercise: z.boolean().default(true), // exercise burn adds to the daily budget
  // Apple Health sync (native, opt-in).
  health_sync: z.boolean().default(false),
  health_synced_at: z.string().optional(),
  health_sync_interval: z.number().default(1440), // minutes between launch auto-syncs (0 = every launch)
  // Body-weight source + last body-mass sync.
  weight_source: z.string().optional(), // ""|manual|health
  weight_synced_at: z.string().optional(),
  // Heart-rate → burn method for the HR-window logger.
  hr_estimate_method: z.enum(HR_ESTIMATE_METHODS).default("formula"),
  // Proactive coach check-ins (per-user opt-in + cadence).
  checkin_enabled: z.boolean().default(false),
  checkin_time: z.string().optional(), // preferred local time-of-day
  checkin_freq: z.enum(CHECKIN_FREQS).default("daily"),
  checkin_last_at: z.string().optional(), // cooldown anchor
  role: z.enum(["user", "admin"]).default("user"),
  onboarded: z.boolean().default(false),
  // Edition the user registered/switched to. "" = not yet chosen (registration UI must prompt).
  // hosted = cloud "just works" (AI via entitlement); selfhost = BYOAI self-host license.
  edition: z.enum(["hosted", "selfhost", ""] as const).default(""),
  // TODO(phase2): per-user AI routing (fn_overrides + ov_ai/ov_vision provider/model + second-opinion)
  // lives here in v1. Phase 1 uses the instance default provider/model, so these are intentionally omitted.
});
export type Profile = z.infer<typeof Profile>;
