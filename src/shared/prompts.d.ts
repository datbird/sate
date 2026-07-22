// Type surface for the shared, runtime-agnostic AI prompt registry (./prompts.js).
// The .js is the implementation and the source of truth; this file only describes it for
// TypeScript consumers. Keep the two in step when either changes.

export declare const FUNCTIONS: readonly [
  "vision_estimate",
  "text_parse",
  "daily_summary",
  "web_lookup",
  "activity_estimate",
  "nutritionist",
  "checkin",
];
export type AIFunction = (typeof FUNCTIONS)[number];

export interface PromptDef {
  system: string;
  jsonMode: boolean;
}
export declare const PROMPTS: Record<AIFunction, PromptDef>;

export declare function parseJSON(text: string): any;

export interface NutritionItem {
  name: string;
  qty: string;
  kcal: number;
  protein: number;
  carbs: number;
  fat: number;
  fiber: number;
  sugar: number;
  sodium: number;
  sat_fat: number;
}
export interface NutritionResult {
  items: NutritionItem[];
  total: Omit<NutritionItem, "name" | "qty">;
  note: string;
}
export declare function normalizeNutrition(obj: any): NutritionResult;

export interface ActivityItem {
  name: string;
  duration_min: number;
  intensity: string;
  kcal_burned: number;
}
export interface ActivityResult {
  items: ActivityItem[];
  total: { kcal_burned: number; duration_min: number };
  note: string;
}
export declare function normalizeActivity(obj: any): ActivityResult;
