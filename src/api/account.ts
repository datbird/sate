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
  //
  // But NOT for users who already hold permanent access — the god / friends-and-family super-SKUs, or
  // a non-expiring paid grant. Handing them a 30-day trial is worse than pointless: it writes an
  // `expiring.<sku>` date onto an account that never expires, which every trial-shaped piece of UI
  // then reads as "your access ends on…". That is what put a family member on a 30-day countdown.
  // `skus` is the plane's FOLDED set, so a sku inherited from a group (e.g. friends_and_family via
  // the friendsnfamily group) counts here exactly like a direct grant — which is the common case for
  // family members.
  const existing = email
    ? await getEntitlements(platform, email)
    : { skus: [], expiring: {}, ok: false };
  const permanent =
    existing.skus.includes("god") ||
    existing.skus.includes("friends_and_family") ||
    (existing.skus.includes(EDITION_SKU[edition]) && !existing.expiring?.[EDITION_SKU[edition]]);

  // If the plane could not be read we do NOT know whether this user already has permanent access, and
  // an unreachable plane looks identical to a brand-new user. Granting on that guess is what puts a
  // phantom expiry on a friends-and-family account, so hold off instead: the grant is recoverable
  // (the plane's /trial is idempotent per email+sku and re-runs on the next edition change), whereas
  // a wrong expiry date has to be cleaned out of the control plane by hand.
  const trial = !email
    ? { ok: false, reason: "no-email" }
    : permanent
      ? { ok: true, granted: false, reason: "permanent-access" }
      : !existing.ok
        ? { ok: false, granted: false, reason: "entitlements-unavailable" }
        : await provisionTrial(platform, email, EDITION_SKU[edition], 30);

  // Re-read only when a grant actually happened, so the response reflects the new trial.
  const entitlements = email && trial.granted !== false ? await getEntitlements(platform, email) : existing;
  return { edition, trial, entitlements, permanent };
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
