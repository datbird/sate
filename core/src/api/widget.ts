// Sate core — the single glanceable-dashboard payload behind every iOS widget.
//
// One request, one presentation-ready object: units already converted, the ring goal already
// net-exercise adjusted, `left` already computed. The widget extension formats strings and draws;
// it makes NO decisions. That is what lets us change what widgets show by deploying the server
// instead of shipping a TestFlight build.
//
// DETERMINISTIC BY CONSTRUCTION: this route must never call requireAI or reach a model. A widget
// refreshing on a timer behind a paid model is exactly the accident the AI-spend guardrail exists
// to prevent. core/test/widget-summary.test.ts asserts it.

import type { App, RouteDeps } from "./helpers";
import { getUid, getEmail, ok, dayKey, tzOf, ensureProfile, dayIntakeTotals } from "./helpers";
import { MODE_PRIMARY, type GoalMethod, type PrimaryMetric } from "../schema";

type Totals = Awaited<ReturnType<typeof dayIntakeTotals>>;

const UNIT: Record<PrimaryMetric, string> = {
  kcal: "kcal", netcarbs: "g", protein: "g", fat: "g", sodium: "mg",
};
const LABEL: Record<PrimaryMetric, string> = {
  kcal: "Calories", netcarbs: "Net carbs", protein: "Protein", fat: "Fat", sodium: "Sodium",
};

function primaryValue(metric: PrimaryMetric, t: Totals): number {
  switch (metric) {
    case "kcal": return t.kcal;
    case "netcarbs": return Math.max(0, t.carbs - t.fiber);
    case "protein": return t.protein;
    case "fat": return t.fat;
    case "sodium": return t.sodium;
  }
}

function primaryGoal(metric: PrimaryMetric, p: Record<string, unknown>): number {
  const n = (v: unknown): number => { const x = Number(v); return isFinite(x) ? x : 0; };
  switch (metric) {
    case "kcal": return n(p.goal_kcal);
    case "netcarbs": return n(p.goal_carbs);
    case "protein": return n(p.goal_protein);
    case "fat": return n(p.goal_fat);
    case "sodium": return n(p.goal_sodium);
  }
}

export async function registerWidget(app: App, deps: RouteDeps): Promise<void> {
  const { platform } = deps;

  app.get("/api/widget/summary", async (c) => {
    const uid = getUid(c);
    const email = getEmail(c);
    const tz = tzOf(c);
    const day = dayKey(new Date().toISOString(), tz);
    const store = platform.data.forUser(uid);
    const profile = await ensureProfile(platform, uid, email);

    // dayIntakeTotals already enforces the honesty rule (planned counts toward nothing) and
    // excludes activity from intake. Do not re-sum entries here.
    const totals = await dayIntakeTotals(store, day);

    // Burn is read separately because it is deliberately NOT part of intake totals.
    let burn = 0;
    try {
      const { items } = await store.list<{ kind?: string; kcal?: number; status?: string }>("entries", {
        where: [{ field: "day", op: "==", value: day }], limit: 500,
      });
      for (const e of items) {
        if (e.kind !== "activity") continue;
        if (e.status === "planned") continue;
        burn += Number(e.kcal) || 0;
      }
    } catch { burn = 0; }

    const mode = (profile.method || "calories") as GoalMethod;
    const metric = MODE_PRIMARY[mode] ?? "kcal";
    const netOn = profile.net_exercise !== false && metric === "kcal";
    const netBurn = netOn ? Math.round(burn) : 0;
    const value = Math.round(primaryValue(metric, totals));
    const goal = Math.round(primaryGoal(metric, profile as Record<string, unknown>)) + netBurn;

    const macro = (v: number, g: unknown) => ({
      value: Math.round(v), goal: Math.round(Number(g) || 0), unit: "g",
    });

    return ok(c, {
      day,
      generated_at: new Date().toISOString(),
      ring: {
        mode, label: LABEL[metric], value, goal,
        left: Math.max(0, goal - value), net_burn: netBurn, unit: UNIT[metric],
      },
      macros: {
        protein: macro(totals.protein, profile.goal_protein),
        carb: macro(totals.carbs, profile.goal_carbs),
        fat: macro(totals.fat, profile.goal_fat),
      },
    });
  });
}
