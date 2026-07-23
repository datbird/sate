// Sate core — Recipe suggester routes (spec §7). Two AI-backed endpoints inside "plan a meal":
//   POST /api/recipes/suggest  → ~5 compact ideas fitting a numeric target
//   POST /api/recipes/expand   → one idea → a full recipe with per-serving macros
// Both are gated by requireAI and run through the AI callers (callAI → usage/limits accounting).
// ALLERGIES ARE SERVER-AUTHORITATIVE: read from profile.allergies (ensureProfile), never from the
// client body — a client cannot spoof or suppress a user's dietary restrictions.

import {
  getUid,
  getEmail,
  ok,
  err,
  ensureProfile,
  type App,
  type RouteDeps,
} from "./helpers";
import { suggestRecipes, expandRecipe } from "../ai/index";
import type { RecipeTarget } from "../ai/prompts";

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const msgOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

// A usable target needs at least a positive calorie figure; macros default to 0 when absent.
function readTarget(raw: any): RecipeTarget | null {
  if (!raw || typeof raw !== "object") return null;
  const t: RecipeTarget = { kcal: num(raw.kcal), protein: num(raw.protein), carbs: num(raw.carbs), fat: num(raw.fat) };
  if (t.kcal <= 0) return null;
  return t;
}

export async function registerRecipes(app: App, deps: RouteDeps): Promise<void> {
  const { platform, requireAI } = deps;

  // POST /api/recipes/suggest — compact ideas fitting the (server-validated) target. Allergies from profile.
  app.post("/api/recipes/suggest", requireAI, async (c) => {
    const uid = getUid(c);
    const profile = await ensureProfile(platform, uid, getEmail(c));
    const b = (await c.req.json().catch(() => ({}))) as Record<string, any>;
    const target = readTarget(b.target);
    if (!target) return err(c, "a target with a positive kcal is required", 400);
    const method = b.method !== undefined ? String(b.method).slice(0, 200) : "";
    const prefs = b.prefs !== undefined ? String(b.prefs).slice(0, 1000) : "";
    try {
      const out = await suggestRecipes(platform, {
        target,
        method,
        prefs,
        allergies: profile.allergies || "", // SERVER-SIDE ONLY — never b.allergies
      });
      return ok(c, out);
    } catch (e) {
      return err(c, msgOf(e), 502);
    }
  });

  // POST /api/recipes/expand — one idea → full recipe. Allergies from profile.
  app.post("/api/recipes/expand", requireAI, async (c) => {
    const uid = getUid(c);
    const profile = await ensureProfile(platform, uid, getEmail(c));
    const b = (await c.req.json().catch(() => ({}))) as Record<string, any>;
    const ideaName =
      b.idea && typeof b.idea === "object" ? String(b.idea.name || "") : String(b.idea || "");
    if (!ideaName.trim()) return err(c, "idea is required", 400);
    const target = readTarget(b.target) || undefined;
    const prefs = b.prefs !== undefined ? String(b.prefs).slice(0, 1000) : "";
    try {
      const out = await expandRecipe(platform, {
        idea: ideaName.slice(0, 300),
        target,
        prefs,
        allergies: profile.allergies || "", // SERVER-SIDE ONLY
      });
      return ok(c, out);
    } catch (e) {
      return err(c, msgOf(e), 502);
    }
  });
}
