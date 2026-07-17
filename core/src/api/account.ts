// Sate core — registration + edition selection/switch (hosted vs self-host).
//
// On first Apple sign-in the client calls POST /api/register with the chosen edition; this records
// the edition on the profile and provisions a 30-day trial of that edition's SKU via the shared
// entitlements plane (idempotent — one trial per email per sku, ever). POST /api/edition switches
// later (and starts the new edition's trial if the user hasn't trialed it before).
//
// Hosted  = cloud "just works": AI is entitlement-gated (sate_hosted), no AI settings for the user.
// Selfhost = BYOAI license (sate_selfhost): run your own Docker + your own AI keys.

import type { Context } from "hono";
import { getUid, getEmail, ok, err, ensureProfile, type App, type AppVars, type RouteDeps } from "./helpers";
import type { Platform } from "../ports";
import type { Profile } from "../schema";
import { provisionTrial, getEntitlements, EDITION_SKU, type Edition } from "../entitlements/index";

const EDITIONS: Edition[] = ["hosted", "selfhost"];

async function setEdition(platform: Platform, uid: string, email: string, edition: Edition) {
  const profile = await ensureProfile(platform, uid, email);
  const pid = (profile as Profile & { id?: string }).id;
  if (pid && (profile as Profile & { edition?: string }).edition !== edition) {
    try {
      await platform.data.forUser(uid).update<Profile>("profiles", pid, { edition } as Partial<Profile>);
    } catch {
      /* best-effort; the trial + returned state are what matter */
    }
  }
  // Provision the chosen edition's trial. Idempotent server-side (one per email per sku). Entitlement
  // identity is the email; no-op when the plane/trial key isn't configured (self-host edition).
  const trial = email
    ? await provisionTrial(platform, email, EDITION_SKU[edition], 30)
    : { ok: false, reason: "no-email" };
  const entitlements = email ? await getEntitlements(platform, email) : { skus: [], expiring: {} };
  return { edition, trial, entitlements };
}

export async function registerAccount(app: App, deps: RouteDeps): Promise<void> {
  const { platform } = deps;

  const handler = async (c: Context<AppVars>) => {
    const uid = getUid(c);
    const email = getEmail(c);
    const body = await c.req.json<{ edition?: string }>().catch(() => ({}) as { edition?: string });
    const edition = body.edition as Edition;
    if (!EDITIONS.includes(edition)) return err(c, "edition must be 'hosted' or 'selfhost'", 400);
    return ok(c, await setEdition(platform, uid, email, edition));
  };

  app.post("/api/register", handler); // first-run: pick edition + start its 30-day trial
  app.post("/api/edition", handler); // switch edition later (starts the new edition's trial)
}
