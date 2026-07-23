// Sate core — the shared HTTP API (Hono) over the ports. Both the cloud (Firestore/Firebase) and
// self-host (SQLite/local) platforms mount this exact app; only the adapters differ. Ported from
// the PocketBase pb_hooks/api.js diary routes (the auth model is now a verified bearer token, and
// data goes through the DataStore port instead of PocketBase collections).
//
// This file is the ROUTER: it stands up the Hono app, the bearer-token auth middleware (which sets
// uid+email on the context for every /api/* route), and the shared requireAI entitlement gate — then
// delegates the actual routes to the per-domain modules (profile/entries/foods/weight/coach/checkins),
// each of which exports register<Name>(app, deps). The register bodies add their routes synchronously,
// so buildApi stays a synchronous factory (adapters mount it as `app.route("/", buildApi(platform))`).

import { Hono } from "hono";
import type { Platform } from "../ports";
import type { ProviderName } from "../ai/index";
import { checkFeature, FEATURES } from "../entitlements/index";
import type { App, AppVars, RouteDeps } from "./helpers";
import { registerProfile } from "./profile";
import { registerEntries } from "./entries";
import { registerFoods } from "./foods";
import { registerWeight } from "./weight";
import { registerCoach } from "./coach";
import { registerCheckins } from "./checkins";
import { registerAccount } from "./account";
import { registerAdmin } from "./admin";
import { registerPlan } from "./plan";

export interface ApiConfig {
  // TODO(phase2): v1 routed each function to a per-user/per-function provider+model. Phase 1 resolves
  // the default provider/model from the instance `settings` collection (see ai/index resolveDefaultModel),
  // so these hints are accepted for call-site compatibility but no longer steer routing.
  aiProvider?: ProviderName;
  aiModel?: string;
  // Self-host trusts a proxy-injected email header (e.g. Cloudflare Access) for identity instead of a
  // bearer token. When set AND present on the request, the header's email IS the identity (uid=email,
  // emailVerified). The origin MUST be reachable only through the proxy — the self-host host enforces
  // this with an origin-secret guard. Unset on cloud → bearer-token auth only (behavior unchanged).
  trustEmailHeader?: string;
}

export function buildApi(platform: Platform, cfg: ApiConfig = {}): App {
  const app = new Hono<AppVars>();
  const trustHeader = cfg.trustEmailHeader ? cfg.trustEmailHeader.toLowerCase() : "";

  // Auth: every /api/* route resolves a user identity. Self-host (trustHeader set) reads the trusted
  // proxy email header; otherwise a verified bearer token is required (cloud). Public routes (e.g.
  // /auth-config, registered by registerProfile) live OUTSIDE the /api/* prefix and are not gated.
  app.use("/api/*", async (c, next) => {
    if (trustHeader) {
      const email = (c.req.header(trustHeader) ?? "").trim().toLowerCase();
      if (email) {
        c.set("uid", email);
        c.set("email", email);
        await next();
        return;
      }
    }
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

  // AI features (nutrition/activity estimation, coach, web lookups, check-in generation) are gated by
  // the shared entitlements plane — same model as BalanceEngine's byo_ai_engines gate. Open when no
  // plane is configured (self-host). Each domain module mounts this per-route on its AI-backed handlers.
  const requireAI: RouteDeps["requireAI"] = async (c, next) => {
    if (!(await checkFeature(platform, FEATURES.AI, c.get("email")))) {
      return c.json({ error: "Feature not available", feature: FEATURES.AI }, 403);
    }
    await next();
  };

  const deps: RouteDeps = { platform, requireAI };

  // Mount every domain's routes. The register bodies add their routes synchronously (all awaits are
  // inside handler closures), so calling them here — after the auth middleware is in place — leaves the
  // app fully wired by the time buildApi returns. Ordering only matters relative to the auth middleware,
  // which is already registered above; the domains are mutually exclusive on their paths.
  void registerProfile(app, deps); // /auth-config (public), /api/me, /api/goals, /api/stats
  void registerEntries(app, deps); // /api/log/*, /api/entries, /api/feed, PATCH/DELETE /api/entries/:id, /api/activities/search
  void registerFoods(app, deps); // /api/foods/search, /search-online, /web-candidate, /accept, /manual
  void registerWeight(app, deps); // /api/weight, /api/weight/log, /sync, /goals (GET/POST/DELETE)
  void registerCoach(app, deps); // /api/plan/compute, /api/nutritionist, /api/second-opinion, /api/day/summary
  void registerCheckins(app, deps); // /api/checkins/*, /api/checkins/run, /api/health/sync
  void registerAccount(app, deps); // /api/register, /api/edition (hosted/self-host + trial provisioning)
  void registerAdmin(app, deps); // /api/admin/* (admin-gated: env ADMIN_EMAILS or profile role==admin)
  void registerPlan(app, deps); // /api/plan/entry (create planned), /api/plan/accept (planned→logged)

  return app;
}
