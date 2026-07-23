// Sate core — AI nutrition coach (deterministic plan + nutritionist plan/chat + second opinion +
// daily summary). Ported from pb_hooks/api.js (planCompute, nutritionist, secondOpinion, daySummary).
// Identity is the Firebase uid (v1 user_email → uid); per-user data via platform.data.forUser(uid),
// shared settings via platform.data.instance(). The deterministic engine (domain/nutrition) grounds
// the coach so the AI's numbers always match the app's saved goals.

import {
  getUid,
  getEmail,
  ok,
  err,
  ensureProfile,
  foodGrounding,
  isLogged,
  type App,
  type RouteDeps,
} from "./helpers";
import * as activitiesKb from "../kb/activities";
import {
  estimateNutrition,
  estimateActivity,
  dailySummary,
  webLookup,
  nutritionist,
  resolveDefaultModel,
  allergiesLine,
  splitPlanChange,
  type AIImage,
  type AIMessage,
} from "../ai/index";
import * as nutrition from "../domain/nutrition";
import type { Platform } from "../ports";
import type {
  Entry,
  Measurement,
  WeightGoal,
  Profile,
  Sex,
  ActivityLevel,
  GoalMethod,
} from "../schema";
import { GOAL_METHODS, ACTIVITY_LEVELS } from "../schema";

// ---- local helpers ------------------------------------------------------

type Body = Record<string, any>;

const LB_PER_KG = 2.2046226;
const lbToKg = (lb: number): number => lb / LB_PER_KG;

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

// The sanitized, enum-checked plan change the client + apply route act on. Built from the RAW parsed
// trailer (splitPlanChange) using the real schema enums. Returns null if nothing valid remains.
export interface PlanChange {
  goal_kcal?: number;
  method?: GoalMethod;
  activity_level?: ActivityLevel;
  weight_goal?: { target_lb: number; target_date: string };
}
export function validatePlanChange(raw: unknown): PlanChange | null {
  if (!raw || typeof raw !== "object") return null;
  const b = raw as Record<string, any>;
  const out: PlanChange = {};
  let has = false;
  if (num(b.goal_kcal) > 0) { out.goal_kcal = Math.round(num(b.goal_kcal)); has = true; }
  if (b.method != null && (GOAL_METHODS as readonly string[]).includes(String(b.method))) {
    out.method = String(b.method) as GoalMethod; has = true;
  }
  if (b.activity_level != null && (ACTIVITY_LEVELS as readonly string[]).includes(String(b.activity_level))) {
    out.activity_level = String(b.activity_level) as ActivityLevel; has = true;
  }
  const wg = b.weight_goal;
  if (wg && typeof wg === "object" && num(wg.target_lb) > 0 && /^\d{4}-\d{2}-\d{2}$/.test(String(wg.target_date || ""))) {
    out.weight_goal = { target_lb: num(wg.target_lb), target_date: String(wg.target_date) }; has = true;
  }
  return has ? out : null;
}

// The client's local calendar date (YYYY-MM-DD) right now; tzMin follows Date.getTimezoneOffset().
const todayStr = (tzMin = 0): string =>
  new Date(Date.now() - (Number(tzMin) || 0) * 60000).toISOString().slice(0, 10);

async function readBody(c: Parameters<typeof getUid>[0]): Promise<Body> {
  try {
    return ((await c.req.json()) as Body) || {};
  } catch {
    return {};
  }
}

// Global feature toggles default ON when the setting is unset/blank; only an explicit "off" disables.
// Ported from v1 featureEnabled/secondOpinionEnabled (over the shared `settings` key/value store).
async function featureEnabled(platform: Platform, key: string): Promise<boolean> {
  try {
    const { items } = await platform.data
      .instance()
      .list<{ key: string; value: string }>("settings", { limit: 500 });
    for (const r of items) if (r.key === key) return r.value !== "off";
    return true;
  } catch {
    return true;
  }
}

// The curated "prefer these sources" hint for web lookups (v1 sourcesHint). Same block foods.ts/
// entries.ts build for the primary path; replicated here so the second-opinion web re-run is steered too.
async function sourcesHint(platform: Platform): Promise<string> {
  let recs: { title?: string; domain?: string; url?: string }[] = [];
  try {
    const { items } = await platform.data
      .instance()
      .list<{ title?: string; domain?: string; url?: string; enabled?: boolean }>("sources", {
        where: [{ field: "enabled", op: "==", value: true }],
        limit: 50,
      });
    recs = items;
  } catch {
    recs = [];
  }
  if (!recs.length) return "";
  const lines = recs.map((r) => `- ${r.title || ""}: ${r.domain || r.url || ""}`);
  const domains = recs.map((r) => r.domain || "").filter(Boolean);
  const example = domains.length ? domains.slice(0, 3).map((d) => "site:" + d).join(" OR ") : "site:fdc.nal.usda.gov";
  return (
    "Preferred sources — search THESE FIRST with Google 'site:' operators before any general search " +
    '(e.g. query: "<food> nutrition facts ' + example + '"). Fall back to a broad search only if none ' +
    "of them cover the food:\n" + lines.join("\n")
  );
}

// Latest recorded body weight → the current weight the plan is computed against (v1 currentWeightKg).
async function currentWeightKg(
  store: ReturnType<Platform["data"]["forUser"]>,
  profile: Profile,
): Promise<number> {
  try {
    // Filter to rows that actually carry a weight (v1 latestMeasurement used `weight_kg > 0`), so a
    // newer height-only measurement doesn't mask the most recent real weight and force the profile scalar.
    const { items } = await store.list<Measurement>("measurements", {
      orderBy: [{ field: "measured_at", dir: "desc" }],
      limit: 25,
    });
    const m = items.find((x) => num(x.weight_kg) > 0);
    if (m) return num(m.weight_kg);
  } catch {
    /* no measurements ⇒ fall back to the profile weight */
  }
  return num(profile.body_weight_kg);
}

interface PlanOverrides {
  curKg?: number;
  cm?: number;
  age?: number;
  sex?: string;
  activity?: string;
  method?: string;
  goals?: nutrition.WeightGoalInput[];
}

// Assemble the nutrition-engine input from the profile + saved weight goals, with optional overrides
// (onboarding previews targets from not-yet-saved stats/goals). Ported from v1 buildPlanInput.
async function buildPlanInput(
  store: ReturnType<Platform["data"]["forUser"]>,
  profile: Profile,
  today: string,
  ov: PlanOverrides,
): Promise<nutrition.PlanInput> {
  let goals = ov.goals;
  if (!goals) {
    try {
      const { items } = await store.list<WeightGoal>("weight_goals", {
        orderBy: [{ field: "target_date" }],
        limit: 5,
      });
      goals = items.map((g) => ({ target_kg: g.target_kg, target_date: g.target_date }));
    } catch {
      goals = [];
    }
  }
  return {
    name: (profile.name || "").split(/\s+/)[0] || "",
    curKg: ov.curKg || (await currentWeightKg(store, profile)),
    cm: ov.cm || num(profile.height_cm),
    age: ov.age || Math.round(num(profile.age)),
    sex: (ov.sex || profile.sex || "") as Sex,
    activity: (ov.activity || profile.activity_level || "sedentary") as ActivityLevel,
    method: (ov.method || profile.method || "calories") as GoalMethod,
    goals,
    today,
  };
}

// Average intake over the last N logged days (food entries only), bucketed by the entry's tz-aware
// `day`. Grounds the nutritionist so its "recent intake" line reflects reality. Ported from v1
// recentIntake (which keyed on user_email + logged_at slice; here we use the stored `day` bucket).
async function recentIntake(
  store: ReturnType<Platform["data"]["forUser"]>,
  days: number,
): Promise<nutrition.RecentIntake | null> {
  const now = Date.now();
  const todayK = new Date(now).toISOString().slice(0, 10);
  const startK = new Date(now - (days - 1) * 86400000).toISOString().slice(0, 10);
  let items: Entry[] = [];
  try {
    const res = await store.list<Entry>("entries", {
      where: [
        { field: "day", op: ">=", value: startK },
        { field: "day", op: "<=", value: todayK },
      ],
      orderBy: [{ field: "day" }],
      limit: 1000,
    });
    items = res.items.filter(isLogged);
  } catch {
    items = [];
  }
  const byDay: Record<string, { kcal: number; protein: number; carbs: number; fat: number }> = {};
  for (const r of items) {
    if (r.kind === "activity") continue;
    const day = r.day || (r.logged_at || "").slice(0, 10) || todayK;
    const b = byDay[day] || (byDay[day] = { kcal: 0, protein: 0, carbs: 0, fat: 0 });
    b.kcal += num(r.kcal);
    b.protein += num(r.macros?.protein);
    b.carbs += num(r.macros?.carbs);
    b.fat += num(r.macros?.fat);
  }
  const ds = Object.keys(byDay);
  if (!ds.length) return null;
  const s = ds.reduce(
    (a, d) => ({
      kcal: a.kcal + byDay[d]!.kcal,
      protein: a.protein + byDay[d]!.protein,
      carbs: a.carbs + byDay[d]!.carbs,
      fat: a.fat + byDay[d]!.fat,
    }),
    { kcal: 0, protein: 0, carbs: 0, fat: 0 },
  );
  const n = ds.length;
  return {
    days: n,
    kcal: Math.round(s.kcal / n),
    protein: Math.round(s.protein / n),
    carbs: Math.round(s.carbs / n),
    fat: Math.round(s.fat / n),
  };
}

// Server-authoritative day totals (food only; activity burn is never intake). v2 entries carry macros
// nested, so this reads entry.macros rather than v1's flat columns. Mirrors v1 sumTotals.
interface DayTotals {
  kcal: number;
  protein: number;
  carbs: number;
  fat: number;
  fiber: number;
  sugar: number;
  sodium: number;
  sat_fat: number;
  count: number;
}
function sumTotals(items: Entry[]): DayTotals {
  const t: DayTotals = {
    kcal: 0,
    protein: 0,
    carbs: 0,
    fat: 0,
    fiber: 0,
    sugar: 0,
    sodium: 0,
    sat_fat: 0,
    count: 0,
  };
  for (const r of items) {
    if (r.kind === "activity") continue;
    t.count += 1;
    t.kcal += num(r.kcal);
    const m = r.macros;
    if (m) {
      t.protein += num(m.protein);
      t.carbs += num(m.carbs);
      t.fat += num(m.fat);
      t.fiber += num(m.fiber);
      t.sugar += num(m.sugar);
      t.sodium += num(m.sodium);
      t.sat_fat += num(m.sat_fat);
    }
  }
  return t;
}

// A short, deterministic plan narrative built from the RECOMPUTED plan (not the AI's prose) — persisted
// as profiles.plan_summary so the Plan tab's "Show full plan" reflects the change. Self-consistent by
// construction (same engine numbers the goals were saved from).
function planSummaryText(inp: nutrition.PlanInput, targets: nutrition.MacroTargets, warnings: string[]): string {
  const L: string[] = [];
  L.push(
    `Your plan: ${targets.kcal.toLocaleString()} kcal/day · ${targets.protein}g protein · ` +
    `${targets.carbs}g carbs · ${targets.fat}g fat (${inp.method}).`,
  );
  if (inp.goals && inp.goals.length) {
    const g = inp.goals[0]!;
    L.push(`Goal: reach ${Math.round(g.target_kg * LB_PER_KG)} lb by ${g.target_date}.`);
  } else {
    L.push("Maintenance (no weight goal set).");
  }
  if (warnings && warnings.length) L.push(warnings[0]!);
  return L.join(" ");
}

// ---- routes -------------------------------------------------------------

export async function registerCoach(app: App, deps: RouteDeps): Promise<void> {
  const { platform, requireAI } = deps;

  // POST /api/plan/compute — deterministic BMR/TDEE/targets/warnings. Optional onboarding-preview
  // overrides (weight_lb/height_cm/age/sex/activity/method/goals[]) let the client preview targets
  // from not-yet-saved stats. Pure compute — no AI, so no requireAI gate. (v1 planCompute)
  app.post("/api/plan/compute", async (c) => {
    const uid = getUid(c);
    const profile = await ensureProfile(platform, uid, getEmail(c));
    const body = await readBody(c);
    const store = platform.data.forUser(uid);

    const ov: PlanOverrides = {};
    if (num(body.weight_lb) > 0) ov.curKg = lbToKg(num(body.weight_lb));
    if (num(body.height_cm) > 0) ov.cm = num(body.height_cm);
    if (num(body.age) > 0) ov.age = num(body.age);
    if (body.sex) ov.sex = String(body.sex);
    if (body.activity) ov.activity = String(body.activity);
    if (body.method) ov.method = String(body.method);
    if (Array.isArray(body.goals)) {
      ov.goals = body.goals
        .map((g: Body) => ({
          target_kg: lbToKg(num(g.target_lb)),
          target_date: String(g.target_date || "").slice(0, 10),
        }))
        .filter((g: nutrition.WeightGoalInput) => g.target_kg > 0 && /^\d{4}-\d{2}-\d{2}$/.test(g.target_date));
    }

    const inp = await buildPlanInput(store, profile, todayStr(), ov);
    const plan = nutrition.computePlan(inp);
    return ok(c, plan);
  });

  // POST /api/plan/apply — apply a coach-proposed <<PLAN_CHANGE>> AFTER the user tapped Apply (spec §10).
  // DETERMINISTIC (no AI, no requireAI): validate the change, apply it as overrides, RE-RUN computePlan +
  // macroTargets so the numbers are the engine's (never the AI's arithmetic), then persist goals through
  // the same Profile fields PATCH /api/goals writes + any weight goal through the same weight_goals path
  // POST /api/weight/goals writes + a refreshed plan_summary. This is the AUTHORITY step.
  app.post("/api/plan/apply", async (c) => {
    const uid = getUid(c);
    const email = getEmail(c);
    const profile = await ensureProfile(platform, uid, email);
    const store = platform.data.forUser(uid);

    const change = validatePlanChange(await readBody(c));
    if (!change) return err(c, "no valid plan change to apply", 400);

    // Apply the change as overrides on the profile's current values.
    const ov: PlanOverrides = {};
    if (change.method) ov.method = change.method;
    if (change.activity_level) ov.activity = change.activity_level;
    // A proposed weight goal drives the calorie delta; otherwise the user's existing goals do.
    if (change.weight_goal) {
      ov.goals = [{ target_kg: lbToKg(change.weight_goal.target_lb), target_date: change.weight_goal.target_date }];
    }

    const inp = await buildPlanInput(store, profile, todayStr(), ov);
    const plan = nutrition.computePlan(inp);

    // Authority: the engine's kcal — unless the user asked for an explicit target, clamped to the safe
    // floor (male 1500 / female 1300) and a sane ceiling. Macros are ALWAYS re-derived for the final kcal.
    const floor = (inp.sex || "").toLowerCase() === "female" ? 1300 : 1500;
    const goalKcal = change.goal_kcal
      ? Math.max(floor, Math.min(6000, Math.round(change.goal_kcal)))
      : plan.targets.kcal;
    const targets = nutrition.macroTargets(goalKcal, inp.method, inp.curKg);
    const summary = planSummaryText(inp, targets, plan.warnings);

    // Persist goals — exactly the Profile fields PATCH /api/goals writes.
    const patch: Partial<Profile> = {
      goal_kcal: targets.kcal,
      goal_protein: targets.protein,
      goal_carbs: targets.carbs,
      goal_fat: targets.fat,
      goal_sodium: targets.sodium,
      method: inp.method as GoalMethod,
      plan_summary: summary,
    };
    if (change.activity_level) patch.activity_level = change.activity_level;
    const pid = (profile as Profile & { id?: string }).id;
    try {
      if (pid) await store.update<Profile>("profiles", pid, patch);
    } catch (e) {
      return err(c, String((e as Error)?.message || e), 502);
    }

    // Persist a proposed weight goal via the same weight_goals path (cap 3, lb→kg) as /api/weight/goals.
    if (change.weight_goal) {
      try {
        const { items } = await store.list<WeightGoal>("weight_goals", { limit: 10 });
        if (items.length < 3) {
          await store.create<WeightGoal>("weight_goals", {
            user: uid,
            target_kg: lbToKg(change.weight_goal.target_lb),
            target_date: change.weight_goal.target_date,
            start_kg: inp.curKg,
            start_date: todayStr(),
          } as Omit<WeightGoal, "id">);
        }
      } catch {
        /* non-fatal — the goals/targets already persisted */
      }
    }

    return ok(c, {
      applied: change,
      plan: { bmr: plan.bmr, tdee: plan.tdee, targets, warnings: plan.warnings },
      goals: { kcal: targets.kcal, protein: targets.protein, carbs: targets.carbs, fat: targets.fat, sodium: targets.sodium },
      plan_summary: summary,
    });
  });

  // POST /api/nutritionist — the AI coach. Body { mode:"plan"|"chat", message?, history?, image?, role? }.
  // Grounded on the deterministic plan + 7-day recent intake so advice matches the app's numbers.
  // Multi-turn: prior history replays; an optional image rides the current turn (discussed, NOT logged).
  // role:"second" is honored only when second_opinion_enabled. (v1 nutritionist)
  app.post("/api/nutritionist", requireAI, async (c) => {
    const uid = getUid(c);
    const profile = await ensureProfile(platform, uid, getEmail(c));
    const body = await readBody(c);
    const store = platform.data.forUser(uid);

    const mode: "plan" | "chat" = body.mode === "chat" ? "chat" : "plan";
    const secondEnabled = await featureEnabled(platform, "second_opinion_enabled");
    const role: "primary" | "second" = body.role === "second" && secondEnabled ? "second" : "primary";
    // TODO(phase2): role:"second" should route to the per-function second-opinion model; Phase 1's
    // nutritionist() always uses the instance-default model (see ai/index resolveDefaultModel).

    const inp = await buildPlanInput(store, profile, todayStr(), {});
    const plan = nutrition.computePlan(inp);
    const recent = await recentIntake(store, 7);
    const context = nutrition.contextText(inp, plan, recent);
    // Remembered dietary restrictions/allergies steer the coach too (spec §7.3), read server-side
    // from the profile — never from the request body.
    const alLine = allergiesLine(profile.allergies);
    const contextWithAllergies = alLine ? context + "\n" + alLine : context;

    const image: AIImage | undefined =
      body.image && body.image.data
        ? { mimeType: String(body.image.mimeType || ""), data: String(body.image.data) }
        : undefined;
    // nutritionist() re-validates each turn (role/text), so a loose cast of untrusted history is safe.
    const history = (Array.isArray(body.history) ? body.history : []) as AIMessage[];

    let reply: string;
    try {
      reply = await nutritionist(platform, {
        mode,
        context: contextWithAllergies,
        message: typeof body.message === "string" ? body.message : undefined,
        history,
        image,
        role,
      });
    } catch (e) {
      return err(c, String((e as Error)?.message || e), 502);
    }

    // Split off the machine-readable <<PLAN_CHANGE>> trailer (spec §10): the user only ever sees the
    // stripped visibleText; the proposal is validated (enum/range) before it reaches the client.
    const { visibleText, planChange } = splitPlanChange(reply);
    const proposed = validatePlanChange(planChange);

    // Report the model/provider that (by default) served the reply, for parity with v1's response.
    const { provider, model } = await resolveDefaultModel(platform, image ? "vision" : "ai");
    return ok(c, {
      reply: visibleText,
      plan_change: proposed,
      role,
      provider,
      model,
      plan: { bmr: plan.bmr, tdee: plan.tdee, targets: plan.targets, warnings: plan.warnings },
    });
  });

  // POST /api/second-opinion — re-run an estimate WITHOUT logging (never mutates the diary). Two shapes:
  //   { entry_id } → derive fn+text from the owned entry (403 on non-owner)
  //   { fn, text?, image? } → ad-hoc re-estimate
  // Gated by the global second_opinion_enabled toggle. (v1 secondOpinion)
  app.post("/api/second-opinion", requireAI, async (c) => {
    const uid = getUid(c);
    if (!(await featureEnabled(platform, "second_opinion_enabled")))
      return err(c, "second opinion is disabled", 403);
    const body = await readBody(c);
    const store = platform.data.forUser(uid);

    let fn = String(body.fn || "");
    let text = String(body.text || "").trim();
    const image: AIImage | undefined =
      body.image && body.image.data
        ? { mimeType: String(body.image.mimeType || ""), data: String(body.image.data) }
        : undefined;

    if (body.entry_id) {
      let rec: Entry | null;
      try {
        rec = await store.get<Entry>("entries", String(body.entry_id));
      } catch {
        rec = null;
      }
      if (!rec) return err(c, "not found", 404);
      if (rec.user !== uid) return err(c, "forbidden", 403); // defense-in-depth (adapter already scopes)
      text = String(rec.description || "");
      // v2 concept map: v1 keyed on entry.source ("activity"/"web"); here kind drives activity.
      if (rec.kind === "activity") fn = "activity_estimate";
      else if (rec.source === "web") fn = "web_lookup";
      else fn = fn || "text_parse";
      if ((!text || text === "(photo)") && !image)
        return err(c, "this entry has no description to re-estimate", 400);
    }
    if (!fn) return err(c, "fn is required", 400);

    // A second opinion runs the STRONGER second-opinion model ("Latest Pro"), distinct from the
    // standard model ("Latest Flash") the primary estimate used — that difference is the whole point.
    // resolveDefaultModel(…, "second") returns it (settings default_second_model, else the built-in
    // gemini-pro-latest). Pro is vision-capable, so it covers photo re-estimates too.
    try {
      if (fn === "activity_estimate") {
        const { provider, model } = await resolveDefaultModel(platform, "second");
        // Reproduce the primary activity path's grounding (v1 estimateActivity 'second'): the known-
        // activities MET reference block + the person's body weight, so the burn is grounded + scaled.
        let userMsg = text;
        try {
          const matched = await activitiesKb.searchByText(platform.data.instance(), text);
          const ref = activitiesKb.referenceBlock(matched);
          if (ref) userMsg = ref + "\n\nActivity to log:\n" + text;
        } catch {
          /* grounding is best-effort */
        }
        try {
          const profile = await ensureProfile(platform, uid, getEmail(c));
          const kg = await currentWeightKg(store, profile);
          if (kg > 0) {
            userMsg = "Person's body weight: " + Math.round(kg) + " kg (" + Math.round(kg * LB_PER_KG) + " lb).\n" + userMsg;
          }
        } catch {
          /* body-weight personalization is best-effort */
        }
        const r = await estimateActivity(platform, { provider, model, text: userMsg });
        return ok(c, { items: r.items, total: r.total, note: r.note, provider, model });
      }
      if (fn === "web_lookup") {
        const { provider, model } = await resolveDefaultModel(platform, "second");
        // v1 webEstimate 'second' prepends the curated "Preferred sources" hint to the query.
        const hint = await sourcesHint(platform);
        const r = await webLookup(platform, text, hint, "second");
        return ok(c, { items: r.items, total: r.total, note: r.note, provider, model });
      }
      // text_parse / vision_estimate: estimateNutrition selects the prompt by image presence. Both run
      // on the second-opinion (Pro) model; Pro handles vision, so no separate vision category is needed.
      const { provider, model } = await resolveDefaultModel(platform, "second");
      // Ground on the user's known foods (v1 estimate 'text_parse' searchByText + referenceBlock), the
      // same block entries.ts's primary path passes via `known` — so the re-run is anchored, not bare.
      const g = await foodGrounding(platform, text);
      const r = await estimateNutrition(platform, {
        provider,
        model,
        text: text || (image ? "Identify this single food and estimate its nutrition." : ""),
        image,
        known: g.reference || undefined,
      });
      return ok(c, { items: r.items, total: r.total, note: r.note, provider, model });
    } catch (e) {
      return err(c, String((e as Error)?.message || e), 502);
    }
  });

  // GET /api/day/summary?date=YYYY-MM-DD[&tz=] — AI recap of one local day vs the user's goal.
  // Totals are server-authoritative (food only). No entries → deterministic message, no AI call.
  // (v1 daySummary)
  app.get("/api/day/summary", requireAI, async (c) => {
    const uid = getUid(c);
    const store = platform.data.forUser(uid);
    const tz = num(c.req.query("tz"));
    const date = (c.req.query("date") || todayStr(tz)).toString();

    let items: Entry[] = [];
    try {
      const res = await store.list<Entry>("entries", {
        where: [{ field: "day", op: "==", value: date }],
        orderBy: [{ field: "logged_at", dir: "desc" }],
        limit: 500,
      });
      items = res.items.filter(isLogged);
    } catch {
      items = [];
    }
    const totals = sumTotals(items);
    if (items.length === 0) return ok(c, { summary: "Nothing logged yet for this day.", totals });

    const profile = await ensureProfile(platform, uid, getEmail(c));
    const lines = items
      .map((r) => `- ${r.description}: ${Math.round(num(r.kcal))} kcal`)
      .join("\n");
    const userText =
      `Date: ${date}\nGoal: ${num(profile.goal_kcal) || "not set"} kcal/day\n` +
      `Entries:\n${lines}\n\n` +
      `Totals: ${Math.round(totals.kcal)} kcal, ${Math.round(totals.protein)}g protein, ` +
      `${Math.round(totals.carbs)}g carbs, ${Math.round(totals.fat)}g fat.`;

    try {
      const summary = await dailySummary(platform, userText);
      return ok(c, { summary, totals });
    } catch (e) {
      return err(c, String((e as Error)?.message || e), 502);
    }
  });
}
