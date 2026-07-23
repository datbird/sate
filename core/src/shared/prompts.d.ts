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
  "recipe_suggest",
  "recipe_expand",
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

// A single grounding line naming the user's remembered dietary restrictions/allergies, injected
// server-side into the recipe prompts and the nutritionist coach context. Empty string when the
// user has none, so callers can concatenate unconditionally.
export declare function allergiesLine(allergies: string | undefined | null): string;

export interface RecipeIdea { name: string; kcal: number; protein: number; carbs: number; fat: number; blurb: string; }
export interface RecipeIdeas { ideas: RecipeIdea[]; }
export interface RecipeIngredient { item: string; amount: string; }
export interface Recipe {
  name: string; servings: number; ingredients: RecipeIngredient[]; steps: string[];
  kcal: number; macros: { protein: number; carbs: number; fat: number; fiber: number; sugar: number; sodium: number; sat_fat: number };
}
export interface RecipeTarget { kcal: number; protein: number; carbs: number; fat: number; }
export declare function buildRecipeSuggestMsg(inp: { target: RecipeTarget; method?: string; prefs?: string; allergies?: string }): string;
export declare function buildRecipeExpandMsg(inp: { idea: string | { name?: string }; target?: RecipeTarget; prefs?: string; allergies?: string }): string;
export declare function normalizeRecipeIdeas(obj: unknown): RecipeIdeas;
export declare function normalizeRecipe(obj: unknown): Recipe;

// The raw, UNVALIDATED plan-change object parsed from the model's <<PLAN_CHANGE>> trailer. The route
// (validatePlanChange) enforces the GOAL_METHODS/ACTIVITY_LEVELS enums + ranges before anything is used.
export interface PlanChangeRaw {
  goal_kcal?: unknown;
  method?: unknown;
  activity_level?: unknown;
  weight_goal?: { target_lb?: unknown; target_date?: unknown };
}
export interface PlanChangeSplit {
  visibleText: string;
  planChange: PlanChangeRaw | null;
}
// Split a raw model reply into the user-visible text (trailer stripped) + the parsed proposal (or null).
export declare function splitPlanChange(raw: string | null | undefined): PlanChangeSplit;
