// Sate — deterministic nutrition target engine. PURE FUNCTIONS ONLY (no I/O, no platform deps).
// Ported verbatim (typed) from the original PocketBase pb_hooks/nutrition.js. Both the
// /plan/compute endpoint (numbers the app saves as goals) and the nutritionist AI grounding run
// off this, so the algorithm and the AI always agree on the math.

import type { ActivityLevel, GoalMethod, Sex } from "../schema";

const LB = 2.2046226; // lb per kg
const KCAL_PER_LB = 3500; // energy per lb of body weight

export const ACTIVITY_MULT: Record<ActivityLevel, number> = {
  sedentary: 1.2,
  light: 1.375,
  moderate: 1.55,
  active: 1.725,
  athlete: 1.9,
};

const round1 = (n: number): number => Math.round(n * 10) / 10;

// Basal metabolic rate — Mifflin-St Jeor. Unknown sex → average the male/female constants.
export function bmr(kg: number, cm: number, age: number, sex: Sex): number {
  const w = kg > 0 ? kg : 70;
  const h = cm > 0 ? cm : 170;
  const a = age > 0 ? age : 40;
  const base = 10 * w + 6.25 * h - 5 * a;
  const s = (sex || "").toLowerCase();
  if (s === "male") return base + 5;
  if (s === "female") return base - 161;
  return base + (5 - 161) / 2;
}

export function tdee(bmrVal: number, activity: ActivityLevel): number {
  return bmrVal * (ACTIVITY_MULT[activity] ?? ACTIVITY_MULT.sedentary);
}

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

// Analyze one weight goal against a safe pace (≤1%/week, capped 2 lb/week).
export function analyzeGoal(curKg: number, targetKg: number, targetDate: string, today: string): GoalAnalysis {
  const curLb = curKg * LB;
  const tgtLb = targetKg * LB;
  const lbToChange = round1(curLb - tgtLb); // + = need to lose
  const t0 = Date.parse(today + "T00:00:00Z");
  const t1 = Date.parse(targetDate + "T00:00:00Z");
  const days = Math.max(1, Math.round((t1 - t0) / 86400000));
  const weeks = days / 7;
  const requiredRate = round1(lbToChange / weeks); // lb/week (+lose/-gain)
  const safeRate = round1(Math.min(2, 0.01 * curLb));
  const dailyDelta = Math.round((lbToChange * KCAL_PER_LB) / days); // + = deficit
  const ambitious = Math.abs(requiredRate) > safeRate + 0.05;
  const dir = lbToChange >= 0 ? 1 : -1;
  const realisticDays = safeRate > 0 ? Math.round((Math.abs(lbToChange) / safeRate) * 7) : days;
  const realisticDate = new Date(t0 + realisticDays * 86400000).toISOString().slice(0, 10);
  const realisticTargetByDate = round1(curLb - dir * safeRate * weeks);
  return {
    target_lb: round1(tgtLb),
    target_date: targetDate,
    days,
    lb_to_change: lbToChange,
    required_rate_lb_wk: requiredRate,
    safe_rate_lb_wk: safeRate,
    daily_kcal_delta: dailyDelta,
    ambitious,
    realistic_date: realisticDate,
    realistic_target_by_date: realisticTargetByDate,
  };
}

// Goal calories = TDEE minus the daily deficit (or plus surplus), never below a hard safety floor.
export function goalCalories(tdeeVal: number, dailyDelta: number, sex: Sex): number {
  const floor = (sex || "").toLowerCase() === "female" ? 1300 : 1500;
  return Math.max(floor, Math.round(tdeeVal - dailyDelta));
}

export interface MacroTargets {
  kcal: number;
  protein: number;
  carbs: number;
  fat: number;
  sodium: number;
}

// Macro grams for a calorie target under the chosen tracking method.
export function macroTargets(goalKcal: number, method: GoalMethod, kg: number): MacroTargets {
  const w = kg > 0 ? kg : 70;
  const perKgMap: Record<GoalMethod, number> = {
    protein: 2.0,
    carb: 1.8,
    fat: 1.6,
    balanced: 1.6,
    heart: 1.4,
    calories: 1.6,
  };
  const perKg = perKgMap[method] ?? 1.6;
  let proteinG = Math.round(perKg * w);
  if (proteinG * 4 > goalKcal * 0.5) proteinG = Math.round((goalKcal * 0.4) / 4); // don't crowd out energy
  const remain = Math.max(0, goalKcal - proteinG * 4);
  let carbKcal: number;
  let fatKcal: number;
  if (method === "carb") {
    carbKcal = goalKcal * 0.15;
    fatKcal = remain - carbKcal;
  } else if (method === "fat") {
    fatKcal = goalKcal * 0.22;
    carbKcal = remain - fatKcal;
  } else if (method === "heart") {
    fatKcal = goalKcal * 0.28;
    carbKcal = remain - fatKcal;
  } else {
    carbKcal = remain * 0.55;
    fatKcal = remain * 0.45;
  }
  carbKcal = Math.max(0, carbKcal);
  fatKcal = Math.max(0, fatKcal);
  return {
    kcal: Math.round(goalKcal),
    protein: proteinG,
    carbs: Math.round(carbKcal / 4),
    fat: Math.round(fatKcal / 9),
    sodium: method === "heart" ? 1500 : 2300,
  };
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

// Full deterministic plan. The first goal drives the calorie delta.
export function computePlan(inp: PlanInput): Plan {
  const kg = inp.curKg || 0;
  const b = bmr(kg, inp.cm, inp.age, inp.sex);
  const t = tdee(b, inp.activity);
  const method = inp.method || "calories";
  const goals = (inp.goals || [])
    .filter((g) => g && g.target_kg > 0 && g.target_date)
    .map((g) => analyzeGoal(kg, g.target_kg, g.target_date, inp.today));
  const primary = goals.length ? goals[0]! : null;
  const delta = primary ? primary.daily_kcal_delta : 0;
  const goalKcal = goalCalories(t, delta, inp.sex);
  const targets = macroTargets(goalKcal, method, kg);
  const warnings: string[] = [];
  for (const g of goals) {
    if (g.ambitious) {
      warnings.push(
        `Reaching ${g.target_lb} lb by ${g.target_date} needs ${Math.abs(g.required_rate_lb_wk)} lb/week — ` +
          `faster than a safe ~${g.safe_rate_lb_wk} lb/week. A realistic goal is about ${g.realistic_target_by_date} lb ` +
          `by that date, or ${g.target_lb} lb by ~${g.realistic_date}.`,
      );
    }
  }
  return { bmr: Math.round(b), tdee: Math.round(t), method, goals, targets, warnings };
}

export function cmToFtIn(cm: number): string {
  if (!(cm > 0)) return "unspecified";
  const totalIn = Math.round(cm / 2.54);
  return Math.floor(totalIn / 12) + "'" + (totalIn % 12) + '"';
}

export interface RecentIntake {
  days: number;
  kcal: number;
  protein: number;
  carbs: number;
  fat: number;
}

// The grounding block handed to the nutritionist AI so its advice matches the algorithm's numbers.
export function contextText(inp: PlanInput, plan: Plan, recent?: RecentIntake | null): string {
  const L: string[] = [];
  L.push("USER PROFILE:");
  if (inp.name) L.push(`- Name: ${inp.name}`);
  L.push(
    `- Sex: ${inp.sex || "unspecified"}, Age: ${inp.age || "unknown"}, Height: ${cmToFtIn(inp.cm)}, ` +
      `Current weight: ${round1((inp.curKg || 0) * LB)} lb`,
  );
  L.push(`- Activity level: ${inp.activity || "unspecified"}`);
  L.push(`- BMR (Mifflin-St Jeor): ${plan.bmr} kcal/day; Maintenance (TDEE): ${plan.tdee} kcal/day`);
  L.push(`- Tracking method: ${inp.method}`);
  if (plan.goals.length) {
    L.push("WEIGHT GOALS:");
    plan.goals.forEach((g, i) => {
      L.push(
        `- Goal ${i + 1}: reach ${g.target_lb} lb by ${g.target_date} (${g.days} days). ` +
          `${g.lb_to_change >= 0 ? "Lose" : "Gain"} ${Math.abs(g.lb_to_change)} lb → required ` +
          `${Math.abs(g.required_rate_lb_wk)} lb/week (safe ≤ ${g.safe_rate_lb_wk} lb/week; daily ` +
          `${g.daily_kcal_delta >= 0 ? "deficit" : "surplus"} ${Math.abs(g.daily_kcal_delta)} kcal).` +
          (g.ambitious
            ? ` AGGRESSIVE: a safe pace reaches it ~${g.realistic_date}, or ~${g.realistic_target_by_date} lb by the requested date.`
            : " Pace is safe."),
      );
    });
  } else {
    L.push("WEIGHT GOALS: none set (maintenance).");
  }
  L.push(
    `RECOMMENDED DAILY TARGETS (${inp.method}): ${plan.targets.kcal} kcal · ${plan.targets.protein}g protein · ` +
      `${plan.targets.carbs}g carbs · ${plan.targets.fat}g fat · sodium ≤ ${plan.targets.sodium}mg.`,
  );
  if (recent && recent.days > 0) {
    L.push(
      `RECENT INTAKE (avg of last ${recent.days} logged day(s)): ${recent.kcal} kcal · ${recent.protein}g protein · ` +
        `${recent.carbs}g carbs · ${recent.fat}g fat.`,
    );
  }
  return L.join("\n");
}
