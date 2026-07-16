// Sate core — the shared HTTP API (Hono) over the ports. Both the cloud (Firestore/Firebase) and
// self-host (SQLite/local) platforms mount this exact app; only the adapters differ. Ported from
// the PocketBase pb_hooks/api.js diary routes (the auth model is now a verified bearer token, and
// data goes through the DataStore port instead of PocketBase collections).

import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import type { Platform } from "../ports";
import { estimateNutrition, estimateActivity, type ProviderName } from "../ai/index";
import { checkFeature, FEATURES } from "../entitlements/index";
import type { Entry, Macros } from "../schema";

export interface ApiConfig {
  aiProvider?: ProviderName;
  aiModel?: string;
}

type Vars = { Variables: { uid: string; email: string } };

// tzOffsetMin follows JS Date.getTimezoneOffset(): minutes to ADD to local time to get UTC
// (positive west of UTC). Bucket an ISO instant into the user's LOCAL calendar day.
function localDay(iso: string, tzOffsetMin: number): string {
  const t = Date.parse(iso) - tzOffsetMin * 60000;
  return new Date(t).toISOString().slice(0, 10);
}

function macrosOf(t: { protein: number; carbs: number; fat: number; fiber: number; sugar: number; sodium: number; sat_fat: number }): Macros {
  return { protein: t.protein, carbs: t.carbs, fat: t.fat, fiber: t.fiber, sugar: t.sugar, sodium: t.sodium, sat_fat: t.sat_fat };
}

export function buildApi(platform: Platform, cfg: ApiConfig = {}): Hono<Vars> {
  const app = new Hono<Vars>();
  const provider: ProviderName = cfg.aiProvider ?? "google";
  const model = cfg.aiModel ?? "gemini-2.5-flash";

  // Auth: every /api/* route requires a verified bearer token → user identity.
  app.use("/api/*", async (c, next) => {
    const h = c.req.header("Authorization") ?? "";
    if (!h.startsWith("Bearer ")) return c.json({ error: "unauthorized" }, 401);
    try {
      const u = await platform.auth.verify(h.slice(7));
      c.set("uid", u.uid);
      c.set("email", u.email);
    } catch {
      return c.json({ error: "invalid or expired token" }, 401);
    }
    await next();
  });

  app.get("/api/me", (c) => c.json({ uid: c.get("uid"), email: c.get("email") }));

  // AI features (nutrition/activity estimation) are gated by the shared entitlements plane —
  // same model as BalanceEngine's byo_ai_engines gate. Open when no plane is configured (self-host).
  const requireAI: MiddlewareHandler<Vars> = async (c, next) => {
    if (!(await checkFeature(platform.secrets, FEATURES.AI, c.get("email")))) {
      return c.json({ error: "Feature not available", feature: FEATURES.AI }, 403);
    }
    await next();
  };
  app.use("/api/entries/food", requireAI);
  app.use("/api/entries/activity", requireAI);

  // Log food by text → AI nutrition estimate → entry.
  app.post("/api/entries/food", async (c) => {
    const uid = c.get("uid");
    const b = (await c.req.json().catch(() => ({}))) as { text?: string; logged_at?: string; tz_offset_min?: number };
    const text = (b.text || "").trim();
    if (!text) return c.json({ error: "text required" }, 400);
    const est = await estimateNutrition(platform, { provider, model, text });
    const logged_at = b.logged_at || new Date().toISOString();
    const tz = b.tz_offset_min ?? 0;
    const entry = await platform.data.forUser(uid).create<Entry>("entries", {
      user: uid,
      kind: "food",
      description: text,
      kcal: est.total.kcal,
      macros: macrosOf(est.total),
      items: est.items.map((it) => ({
        name: it.name,
        kcal: it.kcal,
        qty: it.qty,
        macros: macrosOf(it),
      })),
      source: "ai",
      logged_at,
      tz_offset_min: tz,
      day: localDay(logged_at, tz),
    });
    return c.json(entry);
  });

  // Log activity by text → AI burn estimate → entry (kcal = burn, excluded from intake).
  app.post("/api/entries/activity", async (c) => {
    const uid = c.get("uid");
    const b = (await c.req.json().catch(() => ({}))) as { text?: string; logged_at?: string; tz_offset_min?: number };
    const text = (b.text || "").trim();
    if (!text) return c.json({ error: "text required" }, 400);
    const est = await estimateActivity(platform, { provider, model, text });
    const logged_at = b.logged_at || new Date().toISOString();
    const tz = b.tz_offset_min ?? 0;
    const entry = await platform.data.forUser(uid).create<Entry>("entries", {
      user: uid,
      kind: "activity",
      description: text,
      kcal: est.total.kcal_burned,
      duration_min: est.total.duration_min,
      source: "ai",
      logged_at,
      tz_offset_min: tz,
      day: localDay(logged_at, tz),
    });
    return c.json(entry);
  });

  // List entries — a specific local day (?day=YYYY-MM-DD) or the most recent overall.
  app.get("/api/entries", async (c) => {
    const uid = c.get("uid");
    const day = c.req.query("day");
    const limit = Number(c.req.query("limit") || 100);
    const store = platform.data.forUser(uid);
    const spec = day
      ? { where: [{ field: "day", op: "==" as const, value: day }], limit }
      : { orderBy: [{ field: "logged_at", dir: "desc" as const }], limit };
    const { items } = await store.list<Entry>("entries", spec);
    items.sort((a, b) => (a.logged_at < b.logged_at ? 1 : -1)); // newest first
    return c.json({ entries: items });
  });

  // Day stats: food intake totals + activity burn + net.
  app.get("/api/stats", async (c) => {
    const uid = c.get("uid");
    const tz = Number(c.req.query("tz") || 0);
    const day = c.req.query("day") || localDay(new Date().toISOString(), tz);
    const { items } = await platform.data.forUser(uid).list<Entry>("entries", {
      where: [{ field: "day", op: "==", value: day }],
      limit: 500,
    });
    const intake = { kcal: 0, protein: 0, carbs: 0, fat: 0 };
    let burn = 0;
    for (const e of items) {
      if (e.kind === "activity") {
        burn += e.kcal || 0;
      } else {
        intake.kcal += e.kcal || 0;
        intake.protein += e.macros?.protein || 0;
        intake.carbs += e.macros?.carbs || 0;
        intake.fat += e.macros?.fat || 0;
      }
    }
    return c.json({ day, intake, burn, net: intake.kcal - burn, count: items.length });
  });

  // Manual edit (partial fields; id/user immutable).
  app.patch("/api/entries/:id", async (c) => {
    const uid = c.get("uid");
    const patch = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    delete patch.id;
    delete patch.user;
    const entry = await platform.data.forUser(uid).update<Entry>("entries", c.req.param("id"), patch as Partial<Entry>);
    return c.json(entry);
  });

  app.delete("/api/entries/:id", async (c) => {
    const uid = c.get("uid");
    await platform.data.forUser(uid).delete("entries", c.req.param("id"));
    return c.json({ ok: true });
  });

  return app;
}
