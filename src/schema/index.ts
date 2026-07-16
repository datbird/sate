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
});
export type FoodItem = z.infer<typeof FoodItem>;

// ---- diary entry (food OR activity) -------------------------------------
// kind="food": kcal = intake, macros populated. kind="activity": kcal = burn (never counted
// as intake), duration/distance/met populated. logged_at is ISO; tz_offset_min lets the server
// bucket by the user's LOCAL calendar day (the "disappearing log" fix, ported forward).
export const Entry = z.object({
  id: z.string(),
  user: z.string(),
  kind: z.enum(ENTRY_KINDS).default("food"),
  description: z.string(),
  note: z.string().optional(),
  kcal: z.number().default(0),
  macros: Macros.optional(),
  items: z.array(FoodItem).optional(),
  source: z.string().default("manual"), // manual|ai|db|web|barcode|photo|health|heart_rate…
  logged_at: z.string(),
  tz_offset_min: z.number().default(0),
  // activity-only
  duration_min: z.number().optional(),
  distance_mi: z.number().optional(),
  met: z.number().optional(),
  ext_id: z.string().optional(), // external-source dedup key (e.g. Apple Health)
});
export type Entry = z.infer<typeof Entry>;

// ---- food knowledge base -----------------------------------------------
export const Food = z.object({
  id: z.string(),
  name: z.string(),
  serving: z.string().optional(),
  kcal: z.number().default(0),
  macros: Macros,
  barcode: z.string().optional(),
  source: z.string().default("manual"), // usda|off|ai|web|manual|barcode
  aliases: z.array(z.string()).default([]),
  verified: z.boolean().default(false),
});
export type Food = z.infer<typeof Food>;

// ---- body measurements (weight/height time series) ----------------------
export const Measurement = z.object({
  id: z.string(),
  user: z.string(),
  at: z.string(), // ISO
  weight_kg: z.number().optional(),
  height_cm: z.number().optional(),
  source: z.string().default("manual"), // manual|health
  ext_id: z.string().optional(),
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

// ---- per-user profile ---------------------------------------------------
export const Profile = z.object({
  user: z.string(),
  email: z.string().optional(),
  name: z.string().optional(),
  sex: z.enum(SEXES).default(""),
  age: z.number().optional(),
  height_cm: z.number().optional(),
  body_weight_kg: z.number().optional(),
  activity_level: z.enum(ACTIVITY_LEVELS).default("sedentary"),
  method: z.enum(GOAL_METHODS).default("calories"),
  goal_kcal: z.number().optional(),
  net_exercise: z.boolean().default(true), // exercise burn adds to the daily budget
  role: z.enum(["user", "admin"]).default("user"),
  onboarded: z.boolean().default(false),
});
export type Profile = z.infer<typeof Profile>;
