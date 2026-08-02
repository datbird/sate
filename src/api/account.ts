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

// Every collection stored UNDER the user (platform.data.forUser(uid)) — the complete set that makes up
// "this user's record". Verified against every forUser() call site in api/. Instance-scoped collections
// (foods, activities, sources, settings, providers, ai_usage/limits/prices) are shared instance data and
// are deliberately absent. Keep this list in step with any new per-user collection, or export will be
// incomplete and deletion will leave orphaned health data behind.
const USER_COLLECTIONS = [
  "entries",
  "profiles",
  "measurements",
  "weight_goals",
  "checkins",
  "plan_schedules",
  "plan_overrides",
] as const;

// Page through a whole user collection. The store caps a single list() at its page size, so a naive
// one-shot read would silently miss anything past the first page — the same defect that truncated
// /api/stats at 500 rows. Export must be complete and deletion must not leave a tail behind.
async function readAll(store: ReturnType<Platform["data"]["forUser"]>, coll: string): Promise<unknown[]> {
  const out: unknown[] = [];
  let cursor: string | undefined;
  for (let guard = 0; guard < 200; guard++) {
    const page = await store.list<Record<string, unknown>>(coll, { limit: 500, cursor });
    out.push(...page.items);
    if (!page.nextCursor || page.items.length === 0) break;
    cursor = page.nextCursor;
  }
  return out;
}

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
    : { skus: [] as string[], permanent: [] as string[], expiring: {} as Record<string, string>, ok: false };
  // Permanent iff a super-SKU, or the plane lists the edition's SKU as permanent (authoritative —
  // not "present in skus but with no expiry", which a live trial would satisfy). Falls back to the
  // expiry heuristic only if the plane omits `permanent` (older build).
  const editionSku = EDITION_SKU[edition];
  const permanent =
    existing.skus.includes("god") ||
    existing.skus.includes("friends_and_family") ||
    (Array.isArray(existing.permanent)
      ? existing.permanent.includes(editionSku)
      : existing.skus.includes(editionSku) && !existing.expiring?.[editionSku]);

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

  // GET /api/account/export — everything Sate holds about the caller, as one JSON document.
  // Health data should never be a one-way door: a user can take their record with them.
  app.get("/api/account/export", async (c) => {
    const uid = getUid(c);
    const email = getEmail(c);
    const store = platform.data.forUser(uid);
    const data: Record<string, unknown[]> = {};
    for (const coll of USER_COLLECTIONS) {
      data[coll] = await readAll(store, coll);
    }
    return ok(c, {
      exported_at: new Date().toISOString(),
      account: { uid, email },
      // Shared reference data (the foods/activities catalogues) is deliberately NOT included: it is
      // instance-wide, not the user's, and would bury their own record in thousands of rows.
      note: "Contains every record stored under your account. Shared catalogue data is not included.",
      data,
    });
  });

  // DELETE /api/account — erase every record stored under the caller's account.
  // Requires an explicit {"confirm":"DELETE"} body so a stray request cannot destroy a health history.
  // Deletes ONLY user-scoped collections; the shared foods/activities catalogues are instance-wide and
  // are left intact (a user's contributions there are not "their" rows to remove).
  // NB this erases Sate's copy — it does not delete the Firebase Auth identity, so the same Apple ID
  // signing in again starts clean rather than being locked out.
  app.delete("/api/account", async (c) => {
    const uid = getUid(c);
    const body = (await c.req.json().catch(() => ({}))) as { confirm?: string };
    if (body.confirm !== "DELETE") {
      return err(c, 'account deletion requires {"confirm":"DELETE"}', 400);
    }
    const store = platform.data.forUser(uid);
    const deleted: Record<string, number> = {};
    const failed: string[] = [];
    for (const coll of USER_COLLECTIONS) {
      let n = 0;
      try {
        for (const row of await readAll(store, coll)) {
          const id = (row as { id?: string }).id;
          if (!id) continue;
          await store.delete(coll, id);
          n++;
        }
      } catch (e) {
        console.error(`[account/delete] ${coll} failed:`, e);
        failed.push(coll);
      }
      deleted[coll] = n;
    }
    // Report a partial deletion honestly rather than returning a clean 200 over a half-erased account.
    if (failed.length) return err(c, `partially deleted; these did not clear: ${failed.join(", ")}`, 500);
    return ok(c, { deleted });
  });
}
