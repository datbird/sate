// Sate core — feature entitlements. A faithful port of BalanceEngine's checkFeature model
// (apps/api/src/lib/features.ts): both apps share ONE entitlements-api control plane, so a `god`
// or `friends_and_family` grant lights up features across Sate and BalanceEngine at once.
//
// The plane holds two Firestore collections (databaseId 'entitlements'):
//   feature_flags/{id}        → { enabled, allowed_users[], requires_entitlement }
//   user_entitlements/{email} → { skus[] }
//
// Super-SKU precedence (identical to BE):
//   god                → access granted, bypasses everything including the kill switch
//   friends_and_family → access granted unless the flag is globally disabled
//
// Config (plane URL + read key) flows through the Secrets port, exactly like AI keys — the cloud
// resolves them from env/Secret Manager; the self-host edition leaves them unset. Divergence from
// BE: when the plane is UNSET (self-host Docker, no control plane), every feature is OPEN — a
// self-hoster owns their instance and should not be gated.

import type { Platform, Secrets, Identity } from "../ports";

interface FlagResponse {
  id: string;
  enabled: boolean;
  allowed_users?: string[];
  requires_entitlement?: string | null;
}

interface EntitlementResponse {
  email: string;
  skus: string[];
}

const TTL_MS = 60_000;
type CacheEntry<T> = { value: T; expiresAt: number };
const flagCache = new Map<string, CacheEntry<FlagResponse | null>>();
const entCache = new Map<string, CacheEntry<EntitlementResponse>>();

interface PlaneConfig {
  url: string;
  key: string;
  identity?: Identity;
}

async function planeConfig(secrets: Secrets, identity?: Identity): Promise<PlaneConfig | null> {
  const [url, key] = await Promise.all([
    secrets.get("entitlements-api-url"),
    secrets.get("entitlements-read-key"),
  ]);
  if (!url || !key) return null;
  return { url: url.replace(/\/$/, ""), key, identity };
}

// Build auth headers for a plane request. When the host can mint a GCP identity token (the plane is
// a private, IAM-gated Cloud Run service), the token goes in Authorization (consumed by Cloud Run)
// and the app key travels in X-Api-Key. Without an identity provider (self-host / public plane) the
// key stays in Authorization — the plane's backward-compatible fallback.
async function planeHeaders(cfg: PlaneConfig): Promise<Record<string, string>> {
  if (cfg.identity) {
    const idToken = await cfg.identity.token(cfg.url);
    if (idToken) return { Authorization: `Bearer ${idToken}`, "X-Api-Key": cfg.key };
  }
  return { Authorization: `Bearer ${cfg.key}` };
}

async function fetchFlag(cfg: PlaneConfig, featureId: string): Promise<FlagResponse | null> {
  const cached = flagCache.get(featureId);
  if (cached && Date.now() < cached.expiresAt) return cached.value;
  const res = await fetch(`${cfg.url}/flags/${encodeURIComponent(featureId)}`, {
    headers: await planeHeaders(cfg),
  });
  const value = res.status === 404 ? null : ((await res.json()) as FlagResponse);
  flagCache.set(featureId, { value, expiresAt: Date.now() + TTL_MS });
  return value;
}

async function fetchEntitlements(cfg: PlaneConfig, email: string): Promise<EntitlementResponse> {
  const cached = entCache.get(email);
  if (cached && Date.now() < cached.expiresAt) return cached.value;
  const res = await fetch(`${cfg.url}/entitlements/${encodeURIComponent(email)}`, {
    headers: await planeHeaders(cfg),
  });
  const value = (await res.json()) as EntitlementResponse;
  entCache.set(email, { value, expiresAt: Date.now() + TTL_MS });
  return value;
}

/**
 * Is `email` entitled to `featureId`? Returns true when no control plane is configured
 * (self-host), applies BE's exact precedence when it is, and fails CLOSED on any plane error.
 */
export async function checkFeature(platform: Platform, featureId: string, email: string): Promise<boolean> {
  const cfg = await planeConfig(platform.secrets, platform.identity);
  if (!cfg) return true; // self-host / unconfigured → open
  try {
    const [flag, ent] = await Promise.all([fetchFlag(cfg, featureId), fetchEntitlements(cfg, email)]);
    if (!flag) return false; // unknown flag → deny
    if (ent.skus.includes("god")) return true; // total bypass
    if ((flag.allowed_users ?? []).includes(email)) return true; // per-user override
    if (!flag.enabled) return false; // global kill switch
    if (ent.skus.includes("friends_and_family")) return true; // bypasses paid req, not kill switch
    if (flag.requires_entitlement) return ent.skus.includes(flag.requires_entitlement);
    return true;
  } catch {
    return false; // fail closed
  }
}

/** Feature ids Sate gates. App-prefixed to share the plane cleanly with BalanceEngine's flags. */
export const FEATURES = {
  AI: "sate_ai",
} as const;
