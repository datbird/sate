// Sate core — admin control plane. Faithful port of the PocketBase pb_hooks admin handlers
// (pb_hooks/api.js admin* + main.pb.js /api/sate/admin/* registrations) onto the v2 ports.
// Everything an operator configures lives in the INSTANCE store (platform.data.instance()):
// providers / function_config / settings / sources / ai_usage / ai_limits / ai_prices, plus the
// shared KB collections foods / activities. Per-user rows (profiles) go through forUser(uid).
//
// Route parity (all mounted WITHOUT the pb `/api/sate` prefix — core serves `/api/admin/*`):
//   GET  /api/admin/providers            adminGetProviders   (keys REDACTED)
//   PUT  /api/admin/providers            adminPutProvider    (key stored AES-256-GCM encrypted)
//   GET  /api/admin/models               adminGetModels      (live provider model list)
//   GET  /api/admin/functions            adminGetFunctions
//   PUT  /api/admin/functions            adminPutFunction
//   GET  /api/admin/usage                adminGetUsage
//   GET  /api/admin/limits               adminGetLimits
//   POST /api/admin/limit                adminSetLimit
//   GET  /api/admin/prices               adminGetPrices
//   POST /api/admin/price                adminSetPrice
//   GET  /api/admin/settings             adminGetSettings
//   PUT  /api/admin/settings             adminPutSettings
//   GET  /api/admin/users                adminGetUsers
//   PUT  /api/admin/users/role           adminSetUserRole
//   PUT  /api/admin/users/models         adminSetUserModels
//   GET  /api/admin/foods                adminGetFoods
//   PUT  /api/admin/foods                adminPutFood
//   POST /api/admin/foods/estimate       adminFoodEstimate
//   POST /api/admin/foods/barcode        adminFoodBarcode
//   DELETE /api/admin/foods/:id          adminDeleteFood
//   GET  /api/admin/activities           adminGetActivities
//   PUT  /api/admin/activities           adminPutActivity
//   DELETE /api/admin/activities/:id     adminDeleteActivity
//   GET  /api/admin/sources              adminGetSources
//   PUT  /api/admin/sources              adminPutSource
//   DELETE /api/admin/sources/:id        adminDeleteSource
//   GET  /api/admin/prompts              adminGetPrompts
//   PUT  /api/admin/prompts              adminPutPrompt
//   GET  /api/admin/lookup               adminGetLookup
//   PUT  /api/admin/lookup               adminPutLookup

import * as crypto from "node:crypto";
import {
  getUid, getEmail, ok, err, ensureProfile,
  type App, type RouteDeps,
} from "./helpers";
import type { Platform, DataStore } from "../ports";
import type { Profile, Food, Activity } from "../schema";
import {
  listModels, estimateNutrition, webLookup, resolveDefaultModel,
  FUNCTIONS, PROMPTS, type ProviderName, type NutritionResult,
} from "../ai/index";
import * as foodsKb from "../kb/foods";
import * as activitiesKb from "../kb/activities";

// ---- small coercion helpers (mirror v1 num / string handling) -----------
const str = (v: unknown): string => (v == null ? "" : String(v));
const numOf = (v: unknown): number => {
  const n = Number(v);
  return isFinite(n) ? n : 0;
};
const r1x = (x: unknown): number => Math.round((Number(x) || 0) * 10) / 10;
const msgOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

// The four providers Sate speaks to (v1 VALID_PROVIDERS).
const VALID_PROVIDERS: ProviderName[] = ["anthropic", "openai", "google", "openrouter"];
const isProvider = (n: string): n is ProviderName => (VALID_PROVIDERS as string[]).includes(n);

// The instance settings the admin form owns (v1 SETTING_KEYS). Barcode-lookup keys are handled
// separately by adminGet/PutLookup, and editable prompts live under `prompt_<fn>` keys.
const SETTING_KEYS = [
  "app_name", "default_goal_kcal", "default_goal_protein", "default_goal_carbs", "default_goal_fat",
  "default_ai_provider", "default_ai_model", "default_vision_provider", "default_vision_model",
  "second_ai_provider", "second_ai_model", "second_vision_provider", "second_vision_model",
  "second_opinion_enabled", "checkins_enabled",
  "setup_complete",
];

// v1 PROMPT_LABELS — only these functions have friendly labels; the rest fall back to the fn name.
const PROMPT_LABELS: Record<string, string> = {
  vision_estimate: "Photo estimate (vision)",
  text_parse: "Text meal parse",
  chat: "Coach chat",
  daily_summary: "Daily recap",
  web_lookup: "Web search lookup",
};

// ---- provider API-key encryption (AES-256-GCM) --------------------------
// v1 used PocketBase's $security.encrypt with a 32-char APP_ENCRYPTION_KEY. Core has no $security,
// so we use Node crypto directly with a self-describing "v1:<iv>:<tag>:<ct>" (base64) envelope.
// NOTE: keys migrated from PocketBase were encrypted with PB's $security.encrypt and will NOT
// decrypt here (different scheme) — they must be RE-ENTERED once via this admin. That is acceptable:
// GET routes redact keys anyway, and a decrypt failure just surfaces as "(unreadable — re-enter)".
async function encKey(platform: Platform): Promise<string> {
  let k = "";
  try {
    k = (await platform.secrets.get("app-encryption-key")) || "";
  } catch {
    k = "";
  }
  if (!k) k = process.env.APP_ENCRYPTION_KEY || "";
  return k;
}
function requireEncKey(k: string): string {
  if (k.length !== 32) {
    throw new Error(
      "APP_ENCRYPTION_KEY must be exactly 32 characters (AES-256). Generate one with `openssl rand -hex 16`.",
    );
  }
  return k;
}
export function encryptKey(plaintext: string, key: string): string {
  if (!plaintext) return "";
  const k = requireEncKey(key);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", Buffer.from(k, "utf8"), iv);
  const ct = Buffer.concat([cipher.update(String(plaintext), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString("base64")}:${tag.toString("base64")}:${ct.toString("base64")}`;
}
export function decryptKey(cipher: string, key: string): string {
  if (!cipher) return "";
  const k = requireEncKey(key);
  const parts = String(cipher).split(":");
  if (parts.length !== 4 || parts[0] !== "v1") {
    throw new Error("unrecognized ciphertext (not encrypted by this core — re-enter the key)");
  }
  const iv = Buffer.from(parts[1]!, "base64");
  const tag = Buffer.from(parts[2]!, "base64");
  const ct = Buffer.from(parts[3]!, "base64");
  const d = crypto.createDecipheriv("aes-256-gcm", Buffer.from(k, "utf8"), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]).toString("utf8");
}
// v1 F.redact — show only the last 4 chars of a secret.
const redact = (plaintext: string): string => {
  if (!plaintext) return "";
  const s = String(plaintext);
  return s.length <= 4 ? "••••" : "••••" + s.slice(-4);
};

// ---- instance settings key/value helpers --------------------------------
interface SettingRow {
  id: string;
  key: string;
  value: string;
}
async function settingsMap(store: DataStore): Promise<Record<string, string>> {
  try {
    const { items } = await store.list<SettingRow>("settings", { limit: 500 });
    const m: Record<string, string> = {};
    for (const r of items) m[r.key] = r.value;
    return m;
  } catch {
    return {};
  }
}
async function setSetting(store: DataStore, key: string, value: string): Promise<void> {
  const { items } = await store.list<SettingRow>("settings", {
    where: [{ field: "key", op: "==", value: key }],
    limit: 1,
  });
  if (items[0]) await store.update<SettingRow>("settings", items[0].id, { value });
  else await store.create<SettingRow>("settings", { key, value });
}
async function delSetting(store: DataStore, key: string): Promise<void> {
  try {
    const { items } = await store.list<SettingRow>("settings", {
      where: [{ field: "key", op: "==", value: key }],
      limit: 1,
    });
    if (items[0]) await store.delete("settings", items[0].id);
  } catch {
    /* best-effort */
  }
}

// Deploy-time admin allow-list (v1 ADMIN_EMAILS env). Core gets it from the Secrets port
// ("admin-emails") AND/OR process.env.ADMIN_EMAILS (comma/space separated).
async function envAdminEmails(platform: Platform): Promise<string[]> {
  const out = new Set<string>();
  const add = (raw: string) => {
    for (const s of raw.toLowerCase().split(/[,\s]+/)) {
      const t = s.trim();
      if (t) out.add(t);
    }
  };
  try {
    add((await platform.secrets.get("admin-emails")) || "");
  } catch {
    /* ignore */
  }
  try {
    add(process.env.ADMIN_EMAILS || "");
  } catch {
    /* ignore */
  }
  return [...out];
}

// The authenticated user's role (v1 profiles.role). Read-only; does not auto-create.
async function currentRole(platform: Platform, uid: string): Promise<string> {
  try {
    const { items } = await platform.data.forUser(uid).list<Profile>("profiles", { limit: 1 });
    return items[0]?.role || "user";
  } catch {
    return "user";
  }
}

// ---- provider config ----------------------------------------------------
interface ProviderRow {
  id: string;
  name: string;
  enabled?: boolean;
  base_url?: string;
  api_key_enc?: string;
}
async function providerRecord(store: DataStore, name: string): Promise<ProviderRow | null> {
  try {
    const { items } = await store.list<ProviderRow>("providers", {
      where: [{ field: "name", op: "==", value: name }],
      limit: 1,
    });
    return items[0] ?? null;
  } catch {
    return null;
  }
}

// ---- function_config ----------------------------------------------------
interface FnConfigRow {
  id: string;
  fn: string;
  provider?: string;
  model?: string;
  second_provider?: string;
  second_model?: string;
  enabled?: boolean;
}

// ---- AI usage / limits / prices (ported from pb_hooks/ailimits.js; same collections the core
// ai/usage.ts recordUsage/checkLimit already read+write) ------------------
interface UsageRow {
  id: string;
  provider: string;
  model: string;
  day: string;
  calls: number;
  input_tokens: number;
  output_tokens: number;
}
interface LimitRow {
  id: string;
  provider: string;
  monthly_tokens?: number;
  usd_budget?: number;
  in_cap?: number;
  out_cap?: number;
}
interface PriceRow {
  id: string;
  provider: string;
  model: string;
  in_usd: number;
  out_usd: number;
}
interface LimitCaps {
  monthly_tokens: number;
  usd_budget: number;
  in_cap: number;
  out_cap: number;
}
const pad2 = (n: number): string => (n < 10 ? "0" + n : "" + n);
function monthBounds(): { start: string; end: string } {
  const d = new Date();
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  const start = y + "-" + pad2(m + 1) + "-01";
  const ny = m === 11 ? y + 1 : y;
  const nm = m === 11 ? 0 : m + 1;
  return { start, end: ny + "-" + pad2(nm + 1) + "-01" };
}
async function monthRows(store: DataStore, provider: string): Promise<UsageRow[]> {
  const b = monthBounds();
  try {
    const { items } = await store.list<UsageRow>("ai_usage", {
      where: [
        { field: "provider", op: "==", value: provider },
        { field: "day", op: ">=", value: b.start },
        { field: "day", op: "<", value: b.end },
      ],
      limit: 2000,
    });
    return items;
  } catch {
    return [];
  }
}
function ioOfRows(rows: UsageRow[]): { input: number; output: number; tokens: number; calls: number } {
  let input = 0, output = 0, calls = 0;
  for (const r of rows) {
    input += r.input_tokens || 0;
    output += r.output_tokens || 0;
    calls += r.calls || 0;
  }
  return { input, output, tokens: input + output, calls };
}
async function priceMap(store: DataStore): Promise<Record<string, { in_usd: number; out_usd: number }>> {
  const m: Record<string, { in_usd: number; out_usd: number }> = {};
  try {
    const { items } = await store.list<PriceRow>("ai_prices", { limit: 1000 });
    for (const r of items) m[r.provider + "|" + r.model] = { in_usd: r.in_usd, out_usd: r.out_usd };
  } catch {
    /* no prices */
  }
  return m;
}
function costOfRows(rows: UsageRow[], provider: string, pm: Record<string, { in_usd: number; out_usd: number }>): number {
  let usd = 0;
  for (const r of rows) {
    const p = pm[provider + "|" + (r.model || "")];
    if (p) usd += (r.input_tokens / 1e6) * p.in_usd + (r.output_tokens / 1e6) * p.out_usd;
  }
  return usd;
}
async function limitFor(store: DataStore, provider: string): Promise<LimitCaps | null> {
  try {
    const { items } = await store.list<LimitRow>("ai_limits", {
      where: [{ field: "provider", op: "==", value: provider }],
      limit: 1,
    });
    const r = items[0];
    if (!r) return null;
    return {
      monthly_tokens: r.monthly_tokens || 0,
      usd_budget: r.usd_budget || 0,
      in_cap: r.in_cap || 0,
      out_cap: r.out_cap || 0,
    };
  } catch {
    return null;
  }
}
async function setLimit(store: DataStore, provider: string, caps: Record<string, unknown>): Promise<void> {
  const patch: Record<string, number> = {};
  for (const k of ["monthly_tokens", "usd_budget", "in_cap", "out_cap"]) {
    if (caps[k] !== undefined) patch[k] = Number(caps[k]) || 0;
  }
  const { items } = await store.list<LimitRow>("ai_limits", {
    where: [{ field: "provider", op: "==", value: provider }],
    limit: 1,
  });
  if (items[0]) await store.update<LimitRow>("ai_limits", items[0].id, patch as Partial<LimitRow>);
  else await store.create<LimitRow>("ai_limits", { provider, ...patch } as Omit<LimitRow, "id">);
}
async function pricesList(store: DataStore): Promise<Array<{ provider: string; model: string; in_usd: number; out_usd: number }>> {
  try {
    const { items } = await store.list<PriceRow>("ai_prices", { limit: 1000 });
    return items.map((r) => ({ provider: r.provider, model: r.model, in_usd: r.in_usd, out_usd: r.out_usd }));
  } catch {
    return [];
  }
}
async function setPrice(store: DataStore, provider: string, model: string, inUsd: unknown, outUsd: unknown): Promise<void> {
  const { items } = await store.list<PriceRow>("ai_prices", {
    where: [
      { field: "provider", op: "==", value: provider },
      { field: "model", op: "==", value: model },
    ],
    limit: 1,
  });
  const clear = (inUsd === "" || inUsd == null) && (outUsd === "" || outUsd == null);
  if (clear) {
    if (items[0]) await store.delete("ai_prices", items[0].id);
    return;
  }
  const patch = { in_usd: Number(inUsd) || 0, out_usd: Number(outUsd) || 0 };
  if (items[0]) await store.update<PriceRow>("ai_prices", items[0].id, patch);
  else await store.create<PriceRow>("ai_prices", { provider, model, ...patch } as Omit<PriceRow, "id">);
}
async function usageSummary(store: DataStore, providers: string[]) {
  const pm = await priceMap(store);
  const out = [];
  for (const provider of providers) {
    const rows = await monthRows(store, provider);
    const io = ioOfRows(rows);
    const lim = (await limitFor(store, provider)) || { monthly_tokens: 0, usd_budget: 0, in_cap: 0, out_cap: 0 };
    out.push({
      provider,
      input: io.input,
      output: io.output,
      tokens: io.tokens,
      calls: io.calls,
      cost_usd: +costOfRows(rows, provider, pm).toFixed(4),
      limit: lim,
    });
  }
  return out;
}

// ---- barcode prefill (minimal replica — see note in registerAdmin) ------
// entries.ts owns the full multi-source barcode chain but does not export it, and this file may not
// modify it. For the admin "prefill from barcode" convenience we replicate only the local-DB match +
// free (keyless) Open Food Facts lookup. The keyed nutrition chain (USDA/Nutritionix/FatSecret), the
// identity chain (UPCitemdb/Go-UPC/Barcode Lookup) and the AI-estimate fallback remain on the consumer
// /api/log/barcode route; they are NOT reproduced here (documented simplification).
function normUpc(s: unknown): string {
  return String(s || "").replace(/^0+/, "");
}
function upcACheck(b11: string): string {
  let sum = 0;
  for (let i = 0; i < 11; i++) sum += (i % 2 === 0 ? 3 : 1) * Number(b11[i] || 0);
  return String((10 - (sum % 10)) % 10);
}
function upcEtoA(e: string): string | null {
  let s = String(e || "");
  let ns = "0";
  if (s.length === 8) { ns = s[0]!; s = s.slice(1, 7); }
  else if (s.length === 7) { ns = s[0]!; s = s.slice(1); }
  else if (s.length !== 6) return null;
  if (!/^\d{6}$/.test(s) || (ns !== "0" && ns !== "1")) return null;
  const d = s.split("");
  const last = d[5];
  let b: string;
  if (last === "0" || last === "1" || last === "2") b = ns + d[0] + d[1] + last + "0000" + d[2] + d[3] + d[4];
  else if (last === "3") b = ns + d[0] + d[1] + d[2] + "00000" + d[3] + d[4];
  else if (last === "4") b = ns + d[0] + d[1] + d[2] + d[3] + "00000" + d[4];
  else b = ns + d[0] + d[1] + d[2] + d[3] + d[4] + "0000" + last;
  return b + upcACheck(b);
}
function barcodeVariants(code: string): string[] {
  const out: string[] = [];
  const push = (c: string) => { if (c && /^\d{6,14}$/.test(c) && out.indexOf(c) < 0) out.push(c); };
  push(code);
  const a = upcEtoA(code);
  if (a) { push(a); push("0" + a); }
  if (code.length === 12) push("0" + code);
  if (code.length === 13 && code[0] === "0") push(code.slice(1));
  if (code.length === 14 && code.slice(0, 2) === "00") push(code.slice(2));
  return out;
}
interface BarcodeFood {
  name: string; brand: string; serving_desc: string; serving_g: number;
  kcal: number; protein: number; carbs: number; fat: number;
}
async function fetchOpenFoodFacts(code: string): Promise<BarcodeFood | null> {
  const url =
    "https://world.openfoodfacts.org/api/v2/product/" + encodeURIComponent(code) +
    ".json?fields=product_name,brands,serving_size,serving_quantity,nutriments";
  let j: any;
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "Sate/1.0 (self-hosted calorie app)" },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return null;
    j = await res.json();
  } catch {
    return null;
  }
  if (!j || !j.product || j.status === 0) return null;
  const p = j.product;
  const nut = p.nutriments || {};
  const name = String(p.product_name || "").trim();
  if (!name) return null;
  const sq = Number(p.serving_quantity) || 0;
  let kcal: number, protein: number, carbs: number, fat: number, servingDesc: string, servingG: number;
  const perServ = Number(nut["energy-kcal_serving"]);
  if (isFinite(perServ) && perServ > 0) {
    kcal = perServ;
    protein = numOf(nut["proteins_serving"]);
    carbs = numOf(nut["carbohydrates_serving"]);
    fat = numOf(nut["fat_serving"]);
    servingDesc = String(p.serving_size || (sq ? sq + " g" : "1 serving"));
    servingG = sq || 0;
  } else {
    const f = sq ? sq / 100 : 1;
    kcal = numOf(nut["energy-kcal_100g"]) * f;
    protein = numOf(nut["proteins_100g"]) * f;
    carbs = numOf(nut["carbohydrates_100g"]) * f;
    fat = numOf(nut["fat_100g"]) * f;
    servingDesc = sq ? String(p.serving_size || sq + " g") : "100 g";
    servingG = sq || 100;
  }
  if (!(kcal > 0)) return null;
  return {
    name,
    brand: String(p.brands || "").split(",")[0]!.trim(),
    serving_desc: servingDesc.slice(0, 40),
    serving_g: Math.round(servingG),
    kcal: Math.round(kcal),
    protein: r1x(protein),
    carbs: r1x(carbs),
    fat: r1x(fat),
  };
}

// The curated "prefer these sources" hint for the web-estimate prefill (v1 sourcesHint, trimmed).
async function sourcesHint(store: DataStore): Promise<string> {
  let recs: { title?: string; domain?: string; url?: string }[] = [];
  try {
    const { items } = await store.list<{ title?: string; domain?: string; url?: string; enabled?: boolean }>("sources", {
      where: [{ field: "enabled", op: "==", value: true }],
      limit: 50,
    });
    recs = items;
  } catch {
    recs = [];
  }
  if (!recs.length) return "";
  const lines = recs.map((r) => `- ${r.title || ""}: ${r.domain || r.url || ""}`);
  return (
    "Preferred sources — search THESE FIRST with Google 'site:' operators before any general search. " +
    "Fall back to a broad search only if none of them cover the food:\n" + lines.join("\n")
  );
}

// ---- record → response JSON shapes (kept faithful to v1) ----------------
function foodJSON(f: Food) {
  return {
    id: f.id,
    name: f.name,
    brand: f.brand || "",
    serving_desc: f.serving_desc || "",
    serving_g: numOf((f as unknown as { serving_g?: number }).serving_g), // schema has no serving_g → 0
    kcal: numOf(f.kcal),
    protein: numOf(f.protein),
    carbs: numOf(f.carbs),
    fat: numOf(f.fat),
    category: f.category || "",
    aliases: Array.isArray(f.aliases) ? f.aliases : [],
    barcode: (f as unknown as { barcode?: string }).barcode || "",
    source: f.source || "",
    verified: !!f.verified,
    usage_count: numOf(f.usage_count),
  };
}
function activityJSON(a: Activity) {
  return {
    id: a.id,
    name: a.name,
    category: a.category || "",
    met: numOf(a.met),
    aliases: Array.isArray(a.aliases) ? a.aliases : [],
    source: a.source || "",
    verified: !!a.verified,
    usage_count: numOf(a.usage_count),
  };
}
interface SourceRow {
  id: string;
  title: string;
  url: string;
  domain: string;
  notes: string;
  enabled: boolean;
}
function sourceJSON(s: SourceRow) {
  return { id: s.id, title: s.title || "", url: s.url || "", domain: s.domain || "", notes: s.notes || "", enabled: !!s.enabled };
}

// =========================================================================
// Registration
// =========================================================================
export function registerAdmin(app: App, deps: RouteDeps): void {
  const { platform } = deps;
  const instance = platform.data.instance();

  // ---- admin gate: env-admin (ADMIN_EMAILS / secret admin-emails) OR profiles.role == "admin".
  // Mounted on the whole /api/admin/* prefix; runs after buildApi's auth middleware (which set
  // uid+email on the context), so getEmail(c) is the authenticated identity. Rejects everyone else 403.
  app.use("/api/admin/*", async (c, next) => {
    const email = (getEmail(c) || "").toLowerCase();
    if (!email) return err(c, "not authenticated", 401);
    const admins = await envAdminEmails(platform);
    let allowed = admins.includes(email);
    if (!allowed) allowed = (await currentRole(platform, getUid(c))) === "admin";
    if (!allowed) return err(c, "admin only", 403);
    await next();
  });

  // ================= providers =================
  app.get("/api/admin/providers", async (c) => {
    const key = await encKey(platform);
    let providers: ProviderRow[] = [];
    try {
      ({ items: providers } = await instance.list<ProviderRow>("providers", { limit: 100 }));
    } catch {
      providers = [];
    }
    const out = providers.map((r) => {
      const enc = r.api_key_enc || "";
      let hint = "";
      try {
        hint = enc ? redact(decryptKey(enc, key)) : "";
      } catch {
        hint = "(unreadable — re-enter the key)";
      }
      return {
        name: r.name,
        enabled: !!r.enabled,
        base_url: r.base_url || "",
        key_set: enc.length > 0,
        key_hint: hint,
      };
    });
    return ok(c, { providers: out });
  });

  app.put("/api/admin/providers", async (c) => {
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const name = str(b.name);
    if (!isProvider(name)) return err(c, "invalid provider name", 400);
    let rec = await providerRecord(instance, name);
    try {
      const patch: Partial<ProviderRow> = {};
      if (b.api_key !== undefined && b.api_key !== null && String(b.api_key).length > 0) {
        patch.api_key_enc = encryptKey(String(b.api_key), requireEncKey(await encKey(platform)));
      }
      if (b.enabled !== undefined) patch.enabled = !!b.enabled;
      if (b.base_url !== undefined) patch.base_url = str(b.base_url);
      if (rec) await instance.update<ProviderRow>("providers", rec.id, patch);
      else rec = await instance.create<ProviderRow>("providers", { name, ...patch } as Omit<ProviderRow, "id">);
      return ok(c, { ok: true });
    } catch (e) {
      return err(c, msgOf(e), 400);
    }
  });

  // Live model list for a provider (populates the admin model pickers).
  app.get("/api/admin/models", async (c) => {
    const name = str(c.req.query("provider"));
    if (!isProvider(name)) return err(c, "invalid provider", 400);
    const rec = await providerRecord(instance, name);
    const enc = rec?.api_key_enc || "";
    if (!enc) return ok(c, { provider: name, models: [], note: "no API key set" });
    try {
      const key = requireEncKey(await encKey(platform));
      const models = await listModels({ provider: name, apiKey: decryptKey(enc, key), baseUrl: rec!.base_url || "" });
      return ok(c, { provider: name, models });
    } catch (e) {
      return ok(c, { provider: name, models: [], error: msgOf(e) });
    }
  });

  // ================= function_config =================
  app.get("/api/admin/functions", async (c) => {
    let rows: FnConfigRow[] = [];
    try {
      ({ items: rows } = await instance.list<FnConfigRow>("function_config", { limit: 200 }));
    } catch {
      rows = [];
    }
    return ok(c, {
      functions: rows.map((r) => ({
        fn: r.fn,
        provider: r.provider || "",
        model: r.model || "",
        second_provider: r.second_provider || "",
        second_model: r.second_model || "",
        enabled: !!r.enabled,
      })),
    });
  });

  app.put("/api/admin/functions", async (c) => {
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const fn = str(b.fn);
    if (!(FUNCTIONS as readonly string[]).includes(fn)) return err(c, "invalid function", 400);
    const { items } = await instance.list<FnConfigRow>("function_config", {
      where: [{ field: "fn", op: "==", value: fn }],
      limit: 1,
    });
    const patch: Partial<FnConfigRow> = {};
    if (b.provider !== undefined) {
      const p = str(b.provider).trim();
      if (p && !isProvider(p)) return err(c, "invalid provider", 400);
      patch.provider = p;
    }
    if (b.model !== undefined) patch.model = str(b.model).trim();
    if (b.second_provider !== undefined) {
      const sp = str(b.second_provider).trim();
      if (sp && !isProvider(sp)) return err(c, "invalid second provider", 400);
      patch.second_provider = sp;
    }
    if (b.second_model !== undefined) patch.second_model = str(b.second_model).trim();
    if (b.enabled !== undefined) patch.enabled = !!b.enabled;
    try {
      if (items[0]) await instance.update<FnConfigRow>("function_config", items[0].id, patch);
      else await instance.create<FnConfigRow>("function_config", { fn, ...patch } as Omit<FnConfigRow, "id">);
      return ok(c, { ok: true });
    } catch (e) {
      return err(c, msgOf(e), 400);
    }
  });

  // ================= AI usage / limits / prices =================
  app.get("/api/admin/usage", async (c) => {
    return ok(c, { providers: await usageSummary(instance, VALID_PROVIDERS) });
  });

  app.get("/api/admin/limits", async (c) => {
    const limits = [];
    for (const p of VALID_PROVIDERS) {
      const l = (await limitFor(instance, p)) || { monthly_tokens: 0, usd_budget: 0, in_cap: 0, out_cap: 0 };
      limits.push({ provider: p, monthly_tokens: l.monthly_tokens, usd_budget: l.usd_budget, in_cap: l.in_cap, out_cap: l.out_cap });
    }
    return ok(c, { limits });
  });

  app.post("/api/admin/limit", async (c) => {
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const provider = str(b.provider);
    if (!isProvider(provider)) return err(c, "invalid provider", 400);
    try {
      await setLimit(instance, provider, b);
      return ok(c, { ok: true });
    } catch (e) {
      return err(c, msgOf(e), 400);
    }
  });

  app.get("/api/admin/prices", async (c) => {
    return ok(c, { prices: await pricesList(instance) });
  });

  app.post("/api/admin/price", async (c) => {
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const provider = str(b.provider);
    const model = str(b.model);
    if (!isProvider(provider)) return err(c, "invalid provider", 400);
    if (!model) return err(c, "model required", 400);
    try {
      await setPrice(instance, provider, model, b.in_usd, b.out_usd);
      return ok(c, { ok: true });
    } catch (e) {
      return err(c, msgOf(e), 400);
    }
  });

  // ================= instance settings =================
  app.get("/api/admin/settings", async (c) => {
    const s = await settingsMap(instance);
    // v1 also surfaced env-level AUTH_MODE / AUTH_HEADER (PocketBase env). Core auth is Firebase and
    // the trusted-proxy header is a buildApi cfg not visible here, so we report them from settings
    // (auth_mode default "firebase"); auth_header is null unless an operator stored settings.auth_header.
    return ok(c, {
      settings: s,
      env_admins: await envAdminEmails(platform),
      auth_mode: s.auth_mode || "firebase",
      auth_header: s.auth_header || null,
    });
  });

  app.put("/api/admin/settings", async (c) => {
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    for (const k of SETTING_KEYS) {
      if (b[k] === undefined) continue;
      await setSetting(instance, k, str(b[k]));
    }
    return ok(c, { settings: await settingsMap(instance) });
  });

  // ================= users =================
  // NOTE (port limitation): v1 kept all profiles in one instance collection keyed by email, so the
  // admin could enumerate every user and target any of them by email. In core, per-user data lives
  // under forUser(uid) (cloud → users/{uid}; self-host → filtered by user column), and the ports
  // expose no cross-user enumeration or uid↔email index. So:
  //  • adminGetUsers surfaces the env admins for certain, plus any rows an adapter happens to mirror
  //    into an instance-level "profiles" collection (best-effort) — it cannot list every user in the
  //    cloud/per-user model.
  //  • adminSetUserRole / adminSetUserModels treat the email AS the user key (forUser(email)). That is
  //    correct on the self-host edition (trustEmailHeader → uid == email, which is where the admin SPA
  //    runs); on the cloud edition (uid == Firebase uid) they won't resolve another user's profile.
  app.get("/api/admin/users", async (c) => {
    const admins = await envAdminEmails(platform);
    const emptyOverrides = {
      ov_ai_provider: "", ov_ai_model: "", ov_vision_provider: "", ov_vision_model: "",
      ov_ai_second_provider: "", ov_ai_second_model: "", ov_vision_second_provider: "", ov_vision_second_model: "",
      fn_overrides: {} as Record<string, unknown>,
    };
    const seen = new Set<string>();
    const users: Array<Record<string, unknown>> = [];
    // Best-effort: some adapters may mirror profiles into an instance-scope collection.
    try {
      const { items } = await instance.list<Profile>("profiles", { limit: 1000 });
      for (const r of items) {
        const email = (r.email || "").toLowerCase();
        if (!email || seen.has(email)) continue;
        seen.add(email);
        users.push({
          email,
          name: r.name || email.split("@")[0],
          role: admins.includes(email) ? "admin" : r.role || "user",
          env_admin: admins.includes(email),
          ...emptyOverrides,
        });
      }
    } catch {
      /* no instance-level profiles mirror — env admins only */
    }
    for (const email of admins) {
      if (seen.has(email)) continue;
      seen.add(email);
      users.push({ email, name: email.split("@")[0], role: "admin", env_admin: true, ...emptyOverrides });
    }
    return ok(c, { users });
  });

  app.put("/api/admin/users/role", async (c) => {
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const email = str(b.email).toLowerCase().trim();
    const role = str(b.role);
    if (!email || email.indexOf("@") === -1) return err(c, "valid email required", 400);
    if (role !== "admin" && role !== "user") return err(c, "role must be admin or user", 400);
    const admins = await envAdminEmails(platform);
    if (admins.includes(email)) return err(c, "this email is an env admin (ADMIN_EMAILS) and is always admin", 400);
    try {
      const store = platform.data.forUser(email); // self-host: uid == email
      const p = await ensureProfile(platform, email, email);
      const pid = (p as Profile & { id?: string }).id;
      if (pid) await store.update<Profile>("profiles", pid, { role: role as Profile["role"] });
      return ok(c, { ok: true, email, role });
    } catch (e) {
      return err(c, msgOf(e), 400);
    }
  });

  app.put("/api/admin/users/models", async (c) => {
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const email = str(b.email).toLowerCase().trim();
    if (!email || email.indexOf("@") === -1) return err(c, "valid email required", 400);
    const scalarKeys = [
      "ov_ai_provider", "ov_ai_model", "ov_vision_provider", "ov_vision_model",
      "ov_ai_second_provider", "ov_ai_second_model", "ov_vision_second_provider", "ov_vision_second_model",
    ];
    const patch: Record<string, unknown> = {};
    for (const k of scalarKeys) {
      if (b[k] === undefined) continue;
      const v = str(b[k]).trim();
      if (k.indexOf("_provider") !== -1 && v && !isProvider(v)) return err(c, "invalid provider for " + k, 400);
      patch[k] = v;
    }
    // Per-function overrides { "<fn>": { p, m, sp, sm } } — validate shape + any non-empty provider.
    if (b.fn_overrides !== undefined) {
      let ov: unknown = b.fn_overrides;
      if (typeof ov === "string") {
        try {
          ov = JSON.parse(ov || "{}");
        } catch {
          return err(c, "fn_overrides is not valid JSON", 400);
        }
      }
      if (!ov || typeof ov !== "object") return err(c, "fn_overrides must be an object", 400);
      const clean: Record<string, { p: string; m: string; sp: string; sm: string }> = {};
      for (const fn of Object.keys(ov as Record<string, unknown>)) {
        if (!(FUNCTIONS as readonly string[]).includes(fn)) continue;
        const o = ((ov as Record<string, unknown>)[fn] || {}) as Record<string, unknown>;
        const p = str(o.p).trim(), sp = str(o.sp).trim();
        if (p && !isProvider(p)) return err(c, "invalid provider for " + fn, 400);
        if (sp && !isProvider(sp)) return err(c, "invalid second provider for " + fn, 400);
        const row = { p, m: str(o.m).trim(), sp, sm: str(o.sm).trim() };
        if (row.p || row.m || row.sp || row.sm) clean[fn] = row;
      }
      patch.fn_overrides = clean;
    }
    try {
      const store = platform.data.forUser(email); // self-host: uid == email
      const prof = await ensureProfile(platform, email, email);
      const pid = (prof as Profile & { id?: string }).id;
      // Per-user AI routing overrides (ov_*/fn_overrides) are phase-2 fields not in the Profile schema
      // and not yet consumed by resolveDefaultModel; persisted best-effort for forward-compat.
      if (pid) await store.update<Profile>("profiles", pid, patch as unknown as Partial<Profile>);
      return ok(c, { ok: true, email });
    } catch (e) {
      return err(c, msgOf(e), 400);
    }
  });

  // ================= foods KB =================
  app.get("/api/admin/foods", async (c) => {
    const term = foodsKb.norm(str(c.req.query("q")));
    let all: Food[] = [];
    try {
      ({ items: all } = await instance.list<Food>("foods", { limit: 2000 }));
    } catch (e) {
      return err(c, msgOf(e), 500);
    }
    const total = all.length; // approximate: bounded scan (DataStore has no count)
    let recs = term ? all.filter((f) => (f.search || (f.name || "").toLowerCase()).indexOf(term) !== -1) : all;
    recs = recs.sort(
      (a, b) =>
        (b.verified ? 1 : 0) - (a.verified ? 1 : 0) ||
        numOf(b.usage_count) - numOf(a.usage_count) ||
        String(a.name).localeCompare(String(b.name)),
    ).slice(0, 200);
    return ok(c, { foods: recs.map(foodJSON), shown: recs.length, total });
  });

  app.put("/api/admin/foods", async (c) => {
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const name = str(b.name).trim();
    if (!name) return err(c, "name is required", 400);
    const brand = str(b.brand).trim();
    const aliases = (Array.isArray(b.aliases) ? (b.aliases as unknown[]) : str(b.aliases).split(","))
      .map((s) => String(s).trim())
      .filter(Boolean);
    const search = (name + " " + brand + " " + aliases.join(" ")).toLowerCase();
    const norm_key = foodsKb.normKey(name, brand);
    // v1 admin food editor only edits name/brand/barcode/serving/kcal/protein/carbs/fat/category/
    // aliases/verified — fiber/sugar/sodium/sat_fat are left untouched (default 0 on create).
    const common: Record<string, unknown> = {
      name, brand,
      serving_desc: str(b.serving_desc),
      kcal: numOf(b.kcal), protein: numOf(b.protein), carbs: numOf(b.carbs), fat: numOf(b.fat),
      category: str(b.category),
      aliases, search, norm_key,
    };
    if (b.barcode !== undefined) common.barcode = str(b.barcode).replace(/[^0-9]/g, "");
    if (b.verified !== undefined) common.verified = !!b.verified;
    try {
      let saved: Food;
      if (b.id) {
        const existing = await instance.get<Food>("foods", str(b.id));
        if (!existing) return err(c, "not found", 404);
        saved = await instance.update<Food>("foods", str(b.id), common as Partial<Food>);
      } else {
        saved = await instance.create<Food>("foods", {
          brand: "", fiber: 0, sugar: 0, sodium: 0, sat_fat: 0, barcode: "",
          source: "user", verified: !!b.verified, usage_count: 0,
          ...common,
        } as unknown as Omit<Food, "id">);
      }
      return ok(c, { ok: true, food: foodJSON(saved) });
    } catch (e) {
      return err(c, msgOf(e), 400);
    }
  });

  // Estimate nutrition to prefill the food editor WITHOUT logging. method photo|web|text.
  app.post("/api/admin/foods/estimate", async (c) => {
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const method = str(b.method) || "text";
    try {
      let est: NutritionResult;
      let name: string;
      if (method === "photo") {
        let data = str(b.image);
        let mimeType = "image/jpeg";
        const m = data.match(/^data:([^;]+);base64,(.*)$/);
        if (m) { mimeType = m[1]!; data = m[2]!; }
        if (!data) return err(c, "image required", 400);
        const { provider, model } = await resolveDefaultModel(platform, "vision");
        est = await estimateNutrition(platform, {
          provider, model,
          text: "Identify this single food or packaged product and estimate its nutrition per typical serving.",
          image: { mimeType, data },
        });
        name = String(est.items[0]?.name || "Food from photo");
      } else {
        const text = str(b.text).trim();
        if (!text) return err(c, "name required", 400);
        if (method === "web") {
          est = await webLookup(platform, text, await sourcesHint(instance));
        } else {
          const { provider, model } = await resolveDefaultModel(platform, "ai");
          est = await estimateNutrition(platform, { provider, model, text });
        }
        name = text;
      }
      const t = est.total;
      const first = est.items[0];
      return ok(c, {
        food: {
          name,
          serving_desc: (first && first.qty) || "1 serving",
          kcal: Math.round(t.kcal || 0),
          protein: Math.round(t.protein || 0),
          carbs: Math.round(t.carbs || 0),
          fat: Math.round(t.fat || 0),
        },
        note: est.note || "",
      });
    } catch (e) {
      return err(c, msgOf(e), 502);
    }
  });

  // Look up a barcode's product nutrition to prefill the food editor (no logging). Reduced source
  // chain — see the barcode-prefill note above.
  app.post("/api/admin/foods/barcode", async (c) => {
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const code = str(b.barcode).replace(/[^0-9]/g, "");
    if (!code) return err(c, "no barcode", 400);
    const asFood = (o: Partial<BarcodeFood>, via: string) =>
      ok(c, {
        via,
        food: {
          name: o.name || "", brand: o.brand || "", barcode: code,
          serving_desc: o.serving_desc || "1 serving", serving_g: Math.round(numOf(o.serving_g)),
          kcal: Math.round(numOf(o.kcal)), protein: Math.round(numOf(o.protein)),
          carbs: Math.round(numOf(o.carbs)), fat: Math.round(numOf(o.fat)),
        },
      });
    // Local foods DB first — try every equivalent barcode form.
    for (const bc of barcodeVariants(code)) {
      try {
        const { items } = await instance.list<Food>("foods", { where: [{ field: "barcode", op: "==", value: bc }], limit: 1 });
        const f = items[0];
        if (f) {
          return asFood(
            { name: f.name, brand: f.brand, serving_desc: f.serving_desc, serving_g: 0, kcal: numOf(f.kcal), protein: numOf(f.protein), carbs: numOf(f.carbs), fat: numOf(f.fat) },
            "database",
          );
        }
      } catch {
        /* keep trying */
      }
    }
    // Open Food Facts (keyless).
    for (const bc of barcodeVariants(code)) {
      let hit: BarcodeFood | null = null;
      try {
        hit = await fetchOpenFoodFacts(bc);
      } catch {
        hit = null;
      }
      if (hit) return asFood(hit, "Open Food Facts");
    }
    return err(c, "no product found for that barcode", 404);
  });

  app.delete("/api/admin/foods/:id", async (c) => {
    const id = c.req.param("id");
    try {
      const existing = await instance.get<Food>("foods", id);
      if (!existing) return err(c, "not found", 404);
      await instance.delete("foods", id);
    } catch {
      return err(c, "not found", 404);
    }
    return ok(c, { deleted: id });
  });

  // ================= activities KB =================
  app.get("/api/admin/activities", async (c) => {
    const q = str(c.req.query("q"));
    let total = 0;
    try {
      const all = await instance.list<Activity>("activities", { limit: 5000 });
      total = all.items.length;
    } catch {
      total = 0;
    }
    const recs = await activitiesKb.searchByPrefix(instance, q, 200);
    return ok(c, { activities: recs.map(activityJSON), total });
  });

  app.put("/api/admin/activities", async (c) => {
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const name = str(b.name).trim();
    if (!name) return err(c, "name is required", 400);
    const aliases = (Array.isArray(b.aliases) ? (b.aliases as unknown[]) : str(b.aliases).split(","))
      .map((s) => String(s).trim())
      .filter(Boolean);
    const common: Record<string, unknown> = {
      name,
      category: str(b.category),
      met: numOf(b.met),
      aliases,
      verified: !!b.verified,
      search: (name + " " + aliases.join(" ")).toLowerCase(),
      norm_key: activitiesKb.normKey(name),
    };
    try {
      let saved: Activity;
      if (b.id) {
        const existing = await instance.get<Activity>("activities", str(b.id));
        if (!existing) return err(c, "not found", 404);
        saved = await instance.update<Activity>("activities", str(b.id), common as Partial<Activity>);
      } else {
        saved = await instance.create<Activity>("activities", {
          source: "user", usage_count: 0,
          ...common,
        } as unknown as Omit<Activity, "id">);
      }
      return ok(c, { activity: activityJSON(saved) });
    } catch (e) {
      return err(c, msgOf(e), 400);
    }
  });

  app.delete("/api/admin/activities/:id", async (c) => {
    const id = c.req.param("id");
    try {
      const existing = await instance.get<Activity>("activities", id);
      if (!existing) return err(c, "not found", 404);
      await instance.delete("activities", id);
    } catch {
      return err(c, "not found", 404);
    }
    return ok(c, { ok: true });
  });

  // ================= sources (web-lookup preferred domains) =================
  app.get("/api/admin/sources", async (c) => {
    let recs: SourceRow[] = [];
    try {
      ({ items: recs } = await instance.list<SourceRow>("sources", { orderBy: [{ field: "title", dir: "asc" }], limit: 200 }));
    } catch (e) {
      return err(c, msgOf(e), 500);
    }
    return ok(c, { sources: recs.map(sourceJSON) });
  });

  app.put("/api/admin/sources", async (c) => {
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const title = str(b.title).trim();
    let url = str(b.url).trim();
    if (!title || !url) return err(c, "title and url are required", 400);
    if (!/^https?:\/\//i.test(url)) url = "https://" + url;
    const domain = url.replace(/^https?:\/\//i, "").split("/")[0] || "";
    const common: Record<string, unknown> = {
      title, url, domain,
      notes: str(b.notes),
      enabled: b.enabled === undefined ? true : !!b.enabled,
    };
    try {
      let saved: SourceRow;
      if (b.id) {
        const existing = await instance.get<SourceRow>("sources", str(b.id));
        if (!existing) return err(c, "not found", 404);
        saved = await instance.update<SourceRow>("sources", str(b.id), common as Partial<SourceRow>);
      } else {
        saved = await instance.create<SourceRow>("sources", common as unknown as Omit<SourceRow, "id">);
      }
      return ok(c, { ok: true, source: sourceJSON(saved) });
    } catch (e) {
      return err(c, msgOf(e), 400);
    }
  });

  app.delete("/api/admin/sources/:id", async (c) => {
    const id = c.req.param("id");
    try {
      const existing = await instance.get<SourceRow>("sources", id);
      if (!existing) return err(c, "not found", 404);
      await instance.delete("sources", id);
    } catch {
      return err(c, "not found", 404);
    }
    return ok(c, { deleted: id });
  });

  // ================= editable AI system prompts =================
  app.get("/api/admin/prompts", async (c) => {
    const s = await settingsMap(instance);
    const prompts = (FUNCTIONS as readonly string[]).map((fn) => {
      const override = s["prompt_" + fn] || "";
      return {
        fn,
        label: PROMPT_LABELS[fn] || fn,
        default: (PROMPTS as Record<string, { system: string }>)[fn]?.system || "",
        override,
        customized: !!(override && override.trim()),
      };
    });
    return ok(c, { prompts });
  });

  app.put("/api/admin/prompts", async (c) => {
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const fn = str(b.fn);
    if (!(FUNCTIONS as readonly string[]).includes(fn)) return err(c, "invalid function", 400);
    const text = str(b.text);
    const key = "prompt_" + fn;
    // empty text = reset to the built-in default (remove the override).
    if (!text.trim()) {
      await delSetting(instance, key);
      return ok(c, { ok: true, reset: true });
    }
    try {
      await setSetting(instance, key, text);
      return ok(c, { ok: true });
    } catch (e) {
      return err(c, msgOf(e), 400);
    }
  });

  // ================= barcode-lookup source credentials =================
  // These provider keys are stored as PLAINTEXT settings (as in v1) and only redacted on read.
  app.get("/api/admin/lookup", async (c) => {
    const s = await settingsMap(instance);
    const set = (v: string | undefined) => !!(v && String(v).trim());
    return ok(c, {
      usda: { set: set(s.usda_api_key), hint: redact(s.usda_api_key || "") },
      nutritionix: { app_id: s.nutritionix_app_id || "", set: set(s.nutritionix_app_key), hint: redact(s.nutritionix_app_key || "") },
      fatsecret: { client_id: s.fatsecret_client_id || "", set: set(s.fatsecret_client_secret), hint: redact(s.fatsecret_client_secret || "") },
      upcitemdb: { set: set(s.upcitemdb_key), hint: redact(s.upcitemdb_key || "") },
      go_upc: { set: set(s.go_upc_key), hint: redact(s.go_upc_key || "") },
      barcode_lookup: { set: set(s.barcode_lookup_key), hint: redact(s.barcode_lookup_key || "") },
    });
  });

  app.put("/api/admin/lookup", async (c) => {
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    // [key, isSecret] — secrets kept when submitted blank (so re-saving doesn't wipe them).
    const fields: Array<[string, boolean]> = [
      ["usda_api_key", true], ["nutritionix_app_id", false], ["nutritionix_app_key", true],
      ["fatsecret_client_id", false], ["fatsecret_client_secret", true],
      ["upcitemdb_key", true], ["go_upc_key", true], ["barcode_lookup_key", true],
    ];
    try {
      for (const [k, secret] of fields) {
        if (b[k] === undefined) continue;
        const v = str(b[k]);
        if (secret && v === "") continue;
        await setSetting(instance, k, v);
      }
      // FatSecret creds changed → drop the cached OAuth token so the new ones take effect.
      if (b.fatsecret_client_id !== undefined || b.fatsecret_client_secret !== undefined) {
        await delSetting(instance, "_fs_token");
        await delSetting(instance, "_fs_token_exp");
      }
      return ok(c, { ok: true });
    } catch (e) {
      return err(c, msgOf(e), 400);
    }
  });
}
