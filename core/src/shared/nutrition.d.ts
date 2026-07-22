// Type surface for the shared, runtime-agnostic nutrition engine (./nutrition.js).
// The .js is the implementation and the source of truth; this file only describes it for
// TypeScript consumers. Keep the two in step when either changes.

import type { ActivityLevel, GoalMethod, Sex } from "../schema";

export interface WeightGoalInput {
  target_kg: number;
  target_date: string;
}

export interface GoalAnalysis {
  target_lb: number;
  target_date: string;
  days: number;
  lb_to_change: number;
  required_rate_lb_wk: number;
  safe_rate_lb_wk: number;
  daily_kcal_delta: number;
  ambitious: boolean;
  realistic_date: string;
  realistic_target_by_date: number;
}

export interface MacroTargets {
  kcal: number;
  protein: number;
  carbs: number;
  fat: number;
  sodium: number;
}

export interface PlanInput {
  curKg: number;
  cm: number;
  age: number;
  sex: Sex;
  activity: ActivityLevel;
  method: GoalMethod;
  goals: WeightGoalInput[];
  today: string;
  name?: string;
}

export interface Plan {
  bmr: number;
  tdee: number;
  method: GoalMethod;
  goals: GoalAnalysis[];
  targets: MacroTargets;
  warnings: string[];
}

export interface RecentIntake {
  days: number;
  kcal: number;
  protein: number;
  carbs: number;
  fat: number;
}

export declare const ACTIVITY_MULT: Record<ActivityLevel, number>;

export declare function bmr(kg: number, cm: number, age: number, sex: Sex): number;
export declare function tdee(bmrVal: number, activity: ActivityLevel): number;
export declare function analyzeGoal(
  curKg: number,
  targetKg: number,
  targetDate: string,
  today: string,
): GoalAnalysis;
export declare function goalCalories(tdeeVal: number, dailyDelta: number, sex: Sex): number;
export declare function macroTargets(goalKcal: number, method: GoalMethod, kg: number): MacroTargets;
export declare function computePlan(inp: PlanInput): Plan;
export declare function cmToFtIn(cm: number): string;
export declare function contextText(inp: PlanInput, plan: Plan, recent?: RecentIntake | null): string;
