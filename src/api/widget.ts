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
import { projectOccurrences, type Occurrence } from "../domain/schedule";
import type { Entry, PlanSchedule, PlanOverride } from "../schema";

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

// The next still-planned item for the local day, from BOTH stored planned entries and projected
// schedule occurrences — the same two sources GET /api/timeline merges. Occurrences already
// materialized into an entry are dropped so an accepted meal cannot reappear as "next".
async function nextPlanned(
  store: ReturnType<RouteDeps["platform"]["data"]["forUser"]>,
  day: string,
  nowISO: string,
): Promise<{ id: string; title: string; at_local: string; kcal: number } | null> {
  // Entries created via the Planner test seams (and some legacy write paths) carry a display
  // `name` that isn't part of the Entry zod schema (which only declares `description`); widen the
  // fetched type locally so reading it type-checks without adding `name` to the shared schema.
  let entries: (Entry & { name?: string })[] = [];
  try {
    ({ items: entries } = await store.list<Entry & { name?: string }>("entries", {
      where: [{ field: "day", op: "==", value: day }], limit: 500,
    }));
  } catch { entries = []; }

  const materialized = new Set<string>();
  for (const e of entries) {
    if (e.plan_schedule_id && e.scheduled_date) materialized.add(`${e.plan_schedule_id}:${e.scheduled_date}`);
  }

  const cands: { at: string; title: string; kcal: number; id: string }[] = [];
  for (const e of entries) {
    if (e.status !== "planned") continue;
    if (e.kind === "activity") continue;
    cands.push({ at: e.logged_at || "", title: e.name || "Planned meal", kcal: Math.round(Number(e.kcal) || 0), id: e.id });
  }

  let schedules: PlanSchedule[] = [];
  let overrides: PlanOverride[] = [];
  try {
    ({ items: schedules } = await store.list<PlanSchedule>("plan_schedules", {
      where: [{ field: "is_active", op: "==", value: true }], limit: 500,
    }));
  } catch { schedules = []; }
  try {
    ({ items: overrides } = await store.list<PlanOverride>("plan_overrides", { limit: 2000 }));
  } catch { overrides = []; }

  const occ: Occurrence[] = projectOccurrences(schedules, overrides, day, day, day);
  for (const o of occ) {
    if (o.kind === "activity") continue;
    if (materialized.has(o.id)) continue;
    const kcal = Math.round(Number((o.payload as { kcal?: unknown })?.kcal) || 0);
    cands.push({ at: o.logged_at, title: o.name || "Planned meal", kcal, id: o.id });
  }

  const future = cands.filter((x) => x.at && x.at >= nowISO).sort((a, b) => (a.at < b.at ? -1 : 1));
  const pick = future[0];
  if (!pick) return null;
  return { id: pick.id, title: pick.title, at_local: pick.at.slice(11, 16), kcal: pick.kcal };
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

    const nowISO = new Date().toISOString();
    const next = await nextPlanned(store, day, nowISO);

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
      next_planned: next,
    });
  });
}
