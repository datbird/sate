// Sate core — diary entries: log food/activity (text/AI/photo/barcode/heart-rate), the day list +
// cursor feed, edit/scale/re-estimate/delete, and activity autocomplete. Ported faithfully from
// PocketBase pb_hooks/api.js (logText/logFood/logPhoto/logActivity/logBarcode/logHeartRate/
// listEntries/feedPage/updateEntry/deleteEntry/activitiesSearch) onto the v2 ports + helpers + KB +
// AI callers. Identity is the Firebase uid (v1 user_email → uid); day bucketing + intake totals are
// server-authoritative.

import type { Context } from "hono";
import {
  getUid, getEmail, ok, err, dayKey, ensureProfile, foodGrounding,
  type App, type AppVars, type RouteDeps,
} from "./helpers";
import {
  estimateNutrition, estimateActivity, resolveDefaultModel, webLookup,
  type NutritionResult, type NutritionItem, type ActivityResult,
} from "../ai/index";
import * as foodsKb from "../kb/foods";
import * as activitiesKb from "../kb/activities";
import type { Entry, Food, Activity, Macros, FoodItem, Profile, Measurement } from "../schema";
import type { Platform, DataStore } from "../ports";

// ---- small numeric helpers (mirrors v1 num / r1x) -----------------------
const LB_PER_KG = 2.2046226;
function num(v: unknown): number {
  const n = Number(v);
  return isFinite(n) ? n : 0;
}
const r1x = (x: unknown): number => Math.round((Number(x) || 0) * 10) / 10;
const msgOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

// A flat nutrition total the way v1 addEntry consumed it.
interface FlatTotal {
  kcal: number;
  protein: number;
  carbs: number;
  fat: number;
  fiber: number;
  sugar: number;
  sodium: number;
  sat_fat: number;
}

function macrosOf(t: Partial<FlatTotal>): Macros {
  return {
    protein: num(t.protein),
    carbs: num(t.carbs),
    fat: num(t.fat),
    fiber: num(t.fiber),
    sugar: num(t.sugar),
    sodium: num(t.sodium),
    sat_fat: num(t.sat_fat),
  };
}

// v1 stored per-item nutrition flat AND we keep a nested macros mirror so the v2 shape is consistent.
function foodItemsOf(items: NutritionItem[]): FoodItem[] {
  return (items || []).map((it) => ({
    name: String(it.name || "item"),
    qty: it.qty || undefined,
    kcal: num(it.kcal),
    protein: num(it.protein),
    carbs: num(it.carbs),
    fat: num(it.fat),
    macros: macrosOf(it),
  }));
}

// ---- server-authoritative day intake totals (v1 sumTotals) --------------
// Activity entries carry kcal as *burn* and are excluded from intake.
async function dayTotals(store: DataStore, day: string): Promise<FlatTotal & { count: number }> {
  const t = { kcal: 0, protein: 0, carbs: 0, fat: 0, fiber: 0, sugar: 0, sodium: 0, sat_fat: 0, count: 0 };
  if (!day) return t;
  let items: Entry[] = [];
  try {
    ({ items } = await store.list<Entry>("entries", {
      where: [{ field: "day", op: "==", value: day }],
      limit: 500,
    }));
  } catch {
    return t;
  }
  for (const e of items) {
    if (e.kind === "activity") continue;
    t.count += 1;
    t.kcal += num(e.kcal);
    const m = e.macros || ({} as Macros);
    t.protein += num(m.protein);
    t.carbs += num(m.carbs);
    t.fat += num(m.fat);
    t.fiber += num(m.fiber);
    t.sugar += num(m.sugar);
    t.sodium += num(m.sodium);
    t.sat_fat += num(m.sat_fat);
  }
  return t;
}

const dayOf = (e: Entry): string => e.day || dayKey(e.logged_at, num(e.tz_offset_min));

// ---- instance settings (barcode source keys, curated sources) -----------
async function readSettings(instance: DataStore): Promise<Record<string, string>> {
  try {
    const { items } = await instance.list<{ key: string; value: string }>("settings", { limit: 500 });
    const m: Record<string, string> = {};
    for (const r of items) m[r.key] = r.value;
    return m;
  } catch {
    return {};
  }
}

// The latest known body weight (measurement first, then profile) — burn scales with it.
async function currentWeightKg(store: DataStore, profile: Profile): Promise<number> {
  try {
    // No `weight_kg > 0` in the query (Firestore forbids an inequality on one field with an orderBy on
    // another); order by measured_at and pick the newest row that actually carries a weight.
    const { items } = await store.list<Measurement>("measurements", {
      orderBy: [{ field: "measured_at", dir: "desc" }],
      limit: 25,
    });
    const m = items.find((x) => num(x.weight_kg) > 0);
    if (m) return num(m.weight_kg);
  } catch {
    /* fall through to profile */
  }
  return num(profile.body_weight_kg);
}

// ---- shared AI estimate helpers (ported v1 estimate / estimateActivity) --

// text_parse: ground on the foods KB, estimate, self-grow the KB. coverageOk gates the web-lookup
// button exactly as v1's inDb did.
async function estimateFoodText(
  platform: Platform,
  instance: DataStore,
  text: string,
): Promise<{ est: NutritionResult; provider: string; model: string; coverageOk: boolean }> {
  const g = await foodGrounding(platform, text);
  const { provider, model } = await resolveDefaultModel(platform, "ai");
  const est = await estimateNutrition(platform, { provider, model, text, known: g.reference });
  try {
    await foodsKb.upsertItems(instance, est.items);
  } catch {
    /* self-growth is best-effort */
  }
  return { est, provider, model, coverageOk: g.coverageOk };
}

// activity_estimate: ground on the activities KB + the person's body weight, estimate, self-grow.
async function estimateActivityText(
  platform: Platform,
  instance: DataStore,
  store: DataStore,
  profile: Profile,
  text: string,
): Promise<{ est: ActivityResult; provider: string; model: string }> {
  let userMsg = text;
  let matched: Activity[] = [];
  try {
    matched = await activitiesKb.searchByText(instance, text);
    const ref = activitiesKb.referenceBlock(matched);
    if (ref) userMsg = ref + "\n\nActivity to log:\n" + text;
  } catch {
    /* grounding is best-effort */
  }
  try {
    const kg = await currentWeightKg(store, profile);
    if (kg > 0) {
      userMsg = "Person's body weight: " + Math.round(kg) + " kg (" + Math.round(kg * LB_PER_KG) + " lb).\n" + userMsg;
    }
  } catch {
    /* body-weight personalization is best-effort */
  }
  const { provider, model } = await resolveDefaultModel(platform, "ai");
  const est = await estimateActivity(platform, { provider, model, text: userMsg });
  try {
    if (matched.length) await activitiesKb.bumpUsage(instance, matched);
    await activitiesKb.upsertItems(instance, est.items);
  } catch {
    /* self-growth is best-effort */
  }
  return { est, provider, model };
}

// Keytel et al. (2005) kcal/min from heart rate. Unknown sex → average the equations. (v1 verbatim.)
function keytelKcalPerMin(hr: number, weightKg: number, age: number, sex: string): number {
  const w = weightKg > 0 ? weightKg : 70;
  const a = age > 0 ? age : 40;
  const male = (-55.0969 + 0.6309 * hr + 0.1988 * w + 0.2017 * a) / 4.184;
  const female = (-20.4022 + 0.4472 * hr - 0.1263 * w + 0.074 * a) / 4.184;
  const s = (sex || "").toLowerCase();
  let v: number;
  if (s === "male" || s === "m") v = male;
  else if (s === "female" || s === "f") v = female;
  else v = (male + female) / 2;
  return Math.max(0, v);
}

// =========================================================================
// Barcode lookup — runtime API calls (not redistributed data). Nutrition chain
// OFF → USDA → Nutritionix → FatSecret, then identity chain UPCitemdb → Go-UPC →
// Barcode-Lookup + an AI estimate fallback. Ported verbatim from v1.
// =========================================================================

interface BarcodeFood {
  name: string;
  brand: string;
  serving_desc: string;
  serving_g: number;
  kcal: number;
  protein: number;
  carbs: number;
  fat: number;
  fiber: number;
  sugar: number;
  sodium: number;
  sat_fat: number;
}
interface BarcodeIdent {
  name: string;
  brand: string;
}

const HTTP_TIMEOUT = 20000;
function timeoutSignal(): AbortSignal {
  return AbortSignal.timeout(HTTP_TIMEOUT);
}
function normUpc(s: unknown): string {
  return String(s || "").replace(/^0+/, "");
}

// UPC-A check digit for an 11-digit body (mod-10, odd positions ×3).
function upcACheck(b11: string): string {
  let sum = 0;
  for (let i = 0; i < 11; i++) sum += (i % 2 === 0 ? 3 : 1) * Number(b11[i] || 0);
  return String((10 - (sum % 10)) % 10);
}
// Expand a compressed UPC-E barcode to its 12-digit UPC-A form (null if not UPC-E-shaped). Small
// packages (bottles/cans) print UPC-E; product databases key on the expanded UPC-A, so a raw UPC-E
// lookup misses. Accepts 8 (NS+6+check), 7 (NS+6), or 6 (bare data) digit inputs.
function upcEtoA(e: string): string | null {
  let s = String(e || "");
  let ns = "0";
  if (s.length === 8) { ns = s[0]; s = s.slice(1, 7); }
  else if (s.length === 7) { ns = s[0]; s = s.slice(1); }
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
// Ordered, deduped barcode forms to try against each source. A scanner may emit UPC-E, UPC-A (12),
// EAN-13 (13, leading 0), or GTIN-14; a database stores one canonical form, so trying the common
// equivalents recovers matches a single-form lookup would miss.
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

async function fetchOpenFoodFacts(code: string): Promise<BarcodeFood | null> {
  const url =
    "https://world.openfoodfacts.org/api/v2/product/" + encodeURIComponent(code) +
    ".json?fields=product_name,brands,serving_size,serving_quantity,nutriments";
  let j: any;
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "Sate/1.0 (self-hosted calorie app)" },
      signal: timeoutSignal(),
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
  let kcal: number, protein: number, carbs: number, fat: number, fiber: number, sugar: number, sodium: number, sat_fat: number, servingDesc: string, servingG: number;
  const perServ = Number(nut["energy-kcal_serving"]);
  if (isFinite(perServ) && perServ > 0) {
    kcal = perServ;
    protein = num(nut["proteins_serving"]);
    carbs = num(nut["carbohydrates_serving"]);
    fat = num(nut["fat_serving"]);
    fiber = num(nut["fiber_serving"]);
    sugar = num(nut["sugars_serving"]);
    sodium = num(nut["sodium_serving"]) * 1000;
    sat_fat = num(nut["saturated-fat_serving"]);
    servingDesc = String(p.serving_size || (sq ? sq + " g" : "1 serving"));
    servingG = sq || 0;
  } else {
    const f = sq ? sq / 100 : 1;
    kcal = num(nut["energy-kcal_100g"]) * f;
    protein = num(nut["proteins_100g"]) * f;
    carbs = num(nut["carbohydrates_100g"]) * f;
    fat = num(nut["fat_100g"]) * f;
    fiber = num(nut["fiber_100g"]) * f;
    sugar = num(nut["sugars_100g"]) * f;
    sodium = num(nut["sodium_100g"]) * 1000 * f;
    sat_fat = num(nut["saturated-fat_100g"]) * f;
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
    fiber: r1x(fiber),
    sugar: r1x(sugar),
    sodium: Math.round(sodium),
    sat_fat: r1x(sat_fat),
  };
}

async function fetchUSDA(code: string, apiKey: string): Promise<BarcodeFood | null> {
  const key = apiKey || "DEMO_KEY";
  const url =
    "https://api.nal.usda.gov/fdc/v1/foods/search?api_key=" + encodeURIComponent(key) +
    "&dataType=Branded&pageSize=10&query=" + encodeURIComponent(code);
  let j: any;
  try {
    const res = await fetch(url, { signal: timeoutSignal() });
    if (!res.ok) return null;
    j = await res.json();
  } catch {
    return null;
  }
  const foods = (j && j.foods) || [];
  let hit: any = null;
  for (const f of foods) {
    if (normUpc(f.gtinUpc) === normUpc(code)) {
      hit = f;
      break;
    }
  }
  if (!hit) return null;
  const sg = Number(hit.servingSize) || 0;
  const ln = hit.labelNutrients || {};
  const lv = (o: any): number => (o && isFinite(o.value) ? Number(o.value) : 0);
  let kcal = lv(ln.calories), protein = lv(ln.protein), carbs = lv(ln.carbohydrates), fat = lv(ln.fat);
  let fiber = lv(ln.fiber), sugar = lv(ln.sugars), sodium = lv(ln.sodium), sat_fat = lv(ln.saturatedFat);
  if (!(kcal > 0)) {
    const per: any = {};
    for (const n of hit.foodNutrients || []) {
      const id = String(n.nutrientId || n.nutrientNumber || "");
      const v = Number(n.value);
      if (!isFinite(v)) continue;
      if ((id === "1008" || id === "208" || id === "2048" || id === "2047") && per.kcal === undefined) per.kcal = v;
      else if (id === "1003" || id === "203") per.protein = v;
      else if (id === "1004" || id === "204") per.fat = v;
      else if (id === "1005" || id === "205") per.carbs = v;
      else if (id === "1079" || id === "291") per.fiber = v;
      else if (id === "2000" || id === "269") per.sugar = v;
      else if (id === "1093" || id === "307") per.sodium = v;
      else if (id === "1258" || id === "606") per.sat_fat = v;
    }
    if (per.kcal > 0) {
      const f = sg ? sg / 100 : 1;
      kcal = per.kcal * f;
      protein = (per.protein || 0) * f;
      carbs = (per.carbs || 0) * f;
      fat = (per.fat || 0) * f;
      fiber = (per.fiber || 0) * f;
      sugar = (per.sugar || 0) * f;
      sodium = (per.sodium || 0) * f;
      sat_fat = (per.sat_fat || 0) * f;
    }
  }
  if (!(kcal > 0)) return null;
  const servingG = sg || 100;
  const sdesc = sg ? hit.householdServingFullText || sg + " " + (hit.servingSizeUnit || "g") : "100 g";
  return {
    name: String(hit.description || "").trim().slice(0, 58),
    brand: String(hit.brandName || hit.brandOwner || "").trim().slice(0, 30),
    serving_desc: String(sdesc).slice(0, 40),
    serving_g: Math.round(servingG),
    kcal: Math.round(kcal),
    protein: r1x(protein),
    carbs: r1x(carbs),
    fat: r1x(fat),
    fiber: r1x(fiber),
    sugar: r1x(sugar),
    sodium: Math.round(sodium),
    sat_fat: r1x(sat_fat),
  };
}

async function fetchNutritionix(code: string, appId: string, appKey: string): Promise<BarcodeFood | null> {
  if (!appId || !appKey) return null;
  const url = "https://trackapi.nutritionix.com/v2/search/item?upc=" + encodeURIComponent(code);
  let j: any;
  try {
    const res = await fetch(url, { headers: { "x-app-id": appId, "x-app-key": appKey }, signal: timeoutSignal() });
    if (!res.ok) return null;
    j = await res.json();
  } catch {
    return null;
  }
  const f = (j && j.foods && j.foods[0]) || null;
  if (!f) return null;
  const kcal = num(f.nf_calories);
  if (!(kcal > 0)) return null;
  const sdesc = f.serving_qty && f.serving_unit ? f.serving_qty + " " + f.serving_unit : "1 serving";
  return {
    name: String(f.food_name || "").trim().slice(0, 58),
    brand: String(f.brand_name || "").trim().slice(0, 30),
    serving_desc: String(sdesc).slice(0, 40),
    serving_g: Math.round(num(f.serving_weight_grams)),
    kcal: Math.round(kcal),
    protein: r1x(f.nf_protein),
    carbs: r1x(f.nf_total_carbohydrate),
    fat: r1x(f.nf_total_fat),
    fiber: r1x(f.nf_dietary_fiber),
    sugar: r1x(f.nf_sugars),
    sodium: Math.round(num(f.nf_sodium)),
    sat_fat: r1x(f.nf_saturated_fat),
  };
}

// FatSecret OAuth2 token (client_credentials), cached in-process until near expiry.
// TODO(phase2): v1 persisted this token in the settings collection so it survives restarts; an
// in-process cache is functionally equivalent per instance and avoids settings writes from core.
let fsTokenCache: { token: string; exp: number } | null = null;
async function fatsecretToken(id: string, secret: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  if (fsTokenCache && fsTokenCache.exp > now + 30) return fsTokenCache.token;
  try {
    const res = await fetch("https://oauth.fatsecret.com/connect/token", {
      method: "POST",
      headers: {
        Authorization: "Basic " + btoa(id + ":" + secret),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=client_credentials&scope=barcode+premier",
      signal: timeoutSignal(),
    });
    if (!res.ok) return "";
    const j: any = await res.json();
    if (!j || !j.access_token) return "";
    fsTokenCache = { token: j.access_token, exp: now + (Number(j.expires_in) || 3600) };
    return j.access_token;
  } catch {
    return "";
  }
}

async function fetchFatSecret(code: string, id: string, secret: string): Promise<BarcodeFood | null> {
  if (!id || !secret) return null;
  const tok = await fatsecretToken(id, secret);
  if (!tok) return null;
  let j: any;
  try {
    const res = await fetch(
      "https://platform.fatsecret.com/rest/food/barcode/find-by-id/v1?format=json&barcode=" + encodeURIComponent(code),
      { headers: { Authorization: "Bearer " + tok }, signal: timeoutSignal() },
    );
    if (!res.ok) return null;
    j = await res.json();
  } catch {
    return null;
  }
  const fid = j && j.food_id && (j.food_id.value || j.food_id);
  if (!fid || String(fid) === "0") return null;
  let d: any;
  try {
    const res = await fetch(
      "https://platform.fatsecret.com/rest/food/v4?format=json&food_id=" + encodeURIComponent(String(fid)),
      { headers: { Authorization: "Bearer " + tok }, signal: timeoutSignal() },
    );
    if (!res.ok) return null;
    d = await res.json();
  } catch {
    return null;
  }
  if (!d || !d.food) return null;
  const food = d.food;
  let serv = food.servings && food.servings.serving;
  if (Array.isArray(serv)) serv = serv[0];
  if (!serv) return null;
  const kcal = num(serv.calories);
  if (!(kcal > 0)) return null;
  return {
    name: String(food.food_name || "").trim().slice(0, 58),
    brand: String(food.brand_name || "").trim().slice(0, 30),
    serving_desc: String(serv.serving_description || "1 serving").slice(0, 40),
    serving_g: Math.round(num(serv.metric_serving_amount)),
    kcal: Math.round(kcal),
    protein: r1x(serv.protein),
    carbs: r1x(serv.carbohydrate),
    fat: r1x(serv.fat),
    fiber: r1x(serv.fiber),
    sugar: r1x(serv.sugar),
    sodium: Math.round(num(serv.sodium)),
    sat_fat: r1x(serv.saturated_fat),
  };
}

// --- identity-only sources (name/brand only; AI estimates the macros) ---
async function fetchUpcItemDb(code: string, key: string): Promise<BarcodeIdent | null> {
  let url: string;
  const headers: Record<string, string> = { Accept: "application/json" };
  if (key) {
    url = "https://api.upcitemdb.com/prod/v1/lookup?upc=" + encodeURIComponent(code);
    headers.user_key = key;
    headers.key_type = "3scale";
  } else {
    url = "https://api.upcitemdb.com/prod/trial/lookup?upc=" + encodeURIComponent(code);
  }
  let j: any;
  try {
    const res = await fetch(url, { headers, signal: timeoutSignal() });
    if (!res.ok) return null;
    j = await res.json();
  } catch {
    return null;
  }
  const it = (j && j.items && j.items[0]) || null;
  if (!it) return null;
  const name = String(it.title || "").trim();
  if (!name) return null;
  return { name: name.slice(0, 70), brand: String(it.brand || "").trim().slice(0, 30) };
}

async function fetchGoUpc(code: string, key: string): Promise<BarcodeIdent | null> {
  if (!key) return null;
  let j: any;
  try {
    const res = await fetch("https://go-upc.com/api/v1/code/" + encodeURIComponent(code), {
      headers: { Authorization: "Bearer " + key },
      signal: timeoutSignal(),
    });
    if (!res.ok) return null;
    j = await res.json();
  } catch {
    return null;
  }
  if (!j || !j.product) return null;
  const name = String(j.product.name || "").trim();
  if (!name) return null;
  return { name: name.slice(0, 70), brand: String(j.product.brand || "").trim().slice(0, 30) };
}

async function fetchBarcodeLookup(code: string, key: string): Promise<BarcodeIdent | null> {
  if (!key) return null;
  let j: any;
  try {
    const res = await fetch(
      "https://api.barcodelookup.com/v3/products?formatted=y&barcode=" + encodeURIComponent(code) + "&key=" + encodeURIComponent(key),
      { signal: timeoutSignal() },
    );
    if (!res.ok) return null;
    j = await res.json();
  } catch {
    return null;
  }
  const p = (j && j.products && j.products[0]) || null;
  if (!p) return null;
  const name = String(p.product_name || p.title || "").trim();
  if (!name) return null;
  return { name: name.slice(0, 70), brand: String(p.brand || p.manufacturer || "").trim().slice(0, 30) };
}

interface LookupCfg {
  usdaKey: string;
  nixId: string;
  nixKey: string;
  fsId: string;
  fsSecret: string;
  upcKey: string;
  goUpcKey: string;
  barcodeLookupKey: string;
}
function lookupCfg(s: Record<string, string>): LookupCfg {
  return {
    usdaKey: (s.usda_api_key || "").trim(),
    nixId: (s.nutritionix_app_id || "").trim(),
    nixKey: (s.nutritionix_app_key || "").trim(),
    fsId: (s.fatsecret_client_id || "").trim(),
    fsSecret: (s.fatsecret_client_secret || "").trim(),
    upcKey: (s.upcitemdb_key || "").trim(),
    goUpcKey: (s.go_upc_key || "").trim(),
    barcodeLookupKey: (s.barcode_lookup_key || "").trim(),
  };
}

// Nutrition chain: OFF → USDA → Nutritionix → FatSecret. Prefer the first "complete" hit.
async function barcodeLookupOnline(code: string, cfg: LookupCfg): Promise<{ food: BarcodeFood; via: string; src: string } | null> {
  const variants = barcodeVariants(code);
  const chain: { src: string; via: string; fn: (bc: string) => Promise<BarcodeFood | null> }[] = [
    { src: "off", via: "Open Food Facts", fn: (bc) => fetchOpenFoodFacts(bc) },
    { src: "usda", via: "USDA FoodData Central", fn: (bc) => fetchUSDA(bc, cfg.usdaKey) },
    { src: "nutritionix", via: "Nutritionix", fn: (bc) => fetchNutritionix(bc, cfg.nixId, cfg.nixKey) },
    { src: "fatsecret", via: "FatSecret", fn: (bc) => fetchFatSecret(bc, cfg.fsId, cfg.fsSecret) },
  ];
  let partial: { food: BarcodeFood; via: string; src: string } | null = null;
  for (const step of chain) {
    for (const bc of variants) {
      let food: BarcodeFood | null = null;
      try {
        food = await step.fn(bc);
      } catch {
        food = null;
      }
      if (!food) continue;
      const complete = food.kcal > 0 && food.serving_g > 0;
      if (complete) return { food, via: step.via, src: step.src };
      if (!partial) partial = { food, via: step.via, src: step.src };
    }
  }
  return partial;
}

// Identity chain: first source to name the product wins (UPCitemdb runs even unkeyed).
async function barcodeIdentifyOnline(code: string, cfg: LookupCfg): Promise<{ name: string; brand: string; via: string; src: string } | null> {
  const variants = barcodeVariants(code);
  const chain: { src: string; via: string; fn: (bc: string) => Promise<BarcodeIdent | null> }[] = [
    { src: "upcitemdb", via: "UPCitemdb", fn: (bc) => fetchUpcItemDb(bc, cfg.upcKey) },
    { src: "go_upc", via: "Go-UPC", fn: (bc) => fetchGoUpc(bc, cfg.goUpcKey) },
    { src: "barcode_lookup", via: "Barcode Lookup", fn: (bc) => fetchBarcodeLookup(bc, cfg.barcodeLookupKey) },
  ];
  for (const step of chain) {
    for (const bc of variants) {
      let id: BarcodeIdent | null = null;
      try {
        id = await step.fn(bc);
      } catch {
        id = null;
      }
      if (id && id.name) return { name: id.name, brand: id.brand, via: step.via, src: step.src };
    }
  }
  return null;
}

// The curated "prefer these sources" hint for web lookups (v1 sourcesHint).
async function sourcesHint(instance: DataStore): Promise<string> {
  let recs: { title?: string; domain?: string; url?: string }[] = [];
  try {
    const { items } = await instance.list<{ title?: string; domain?: string; url?: string; enabled?: boolean }>("sources", {
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
    "(e.g. query: \"<food> nutrition facts " + example + "\"). Fall back to a broad search only if none " +
    "of them cover the food:\n" + lines.join("\n")
  );
}

// =========================================================================
// Routes
// =========================================================================
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export async function registerEntries(app: App, deps: RouteDeps): Promise<void> {
  const { platform, requireAI } = deps;
  const instance = platform.data.instance();

  // Enforce the AI entitlement INSIDE a handler, before an AI branch on a route that also has a non-AI
  // path (activity preset vs free-text, barcode structured-lookup vs AI fallback, HR formula vs AI,
  // entry edit vs re-estimate). buildApi intends requireAI to gate every AI-backed handler, but these
  // routes can't mount it whole (it would block their free paths too). Invoking the middleware with a
  // no-op next runs just its check: it returns the 403 Response when AI is denied, else undefined.
  const gateAI = async (c: Context<AppVars>): Promise<Response | undefined> => {
    const denied = await requireAI(c, async () => undefined);
    return denied ?? undefined;
  };

  // ---- POST /api/log/text — AI nutrition estimate, grounded on the foods KB.
  app.post("/api/log/text", requireAI, async (c) => {
    const uid = getUid(c);
    await ensureProfile(platform, uid, getEmail(c));
    const b = (await c.req.json().catch(() => ({}))) as { text?: string; logged_at?: string; tz_offset_min?: number };
    const text = String(b.text || "").trim();
    if (!text) return err(c, "text is required", 400);
    const store = platform.data.forUser(uid);
    try {
      const { est, provider, model, coverageOk } = await estimateFoodText(platform, instance, text);
      const logged_at = b.logged_at ? new Date(b.logged_at).toISOString() : new Date().toISOString();
      const tz = num(b.tz_offset_min);
      const day = dayKey(logged_at, tz);
      const entry = await store.create<Entry>("entries", {
        user: uid,
        kind: "food",
        description: text,
        source: "text",
        kcal: est.total.kcal,
        macros: macrosOf(est.total),
        items: foodItemsOf(est.items),
        provider,
        model,
        logged_at,
        tz_offset_min: tz,
        day,
      });
      return ok(c, { entry, note: est.note, in_db: coverageOk, totals: await dayTotals(store, day) });
    } catch (e) {
      return err(c, msgOf(e), 502);
    }
  });

  // ---- POST /api/log/food — log a known food by id × servings (no AI).
  app.post("/api/log/food", async (c) => {
    const uid = getUid(c);
    const b = (await c.req.json().catch(() => ({}))) as { food_id?: string; servings?: number; logged_at?: string; tz_offset_min?: number };
    const store = platform.data.forUser(uid);
    const servings = num(b.servings) > 0 ? num(b.servings) : 1;
    const f = await instance.get<Food>("foods", String(b.food_id || ""));
    if (!f) return err(c, "food not found", 404);
    const s = servings > 0 ? servings : 1;
    const total: FlatTotal = {
      kcal: Math.round(num(f.kcal) * s),
      protein: r1x(num(f.protein) * s),
      carbs: r1x(num(f.carbs) * s),
      fat: r1x(num(f.fat) * s),
      fiber: r1x(num(f.fiber) * s),
      sugar: r1x(num(f.sugar) * s),
      sodium: Math.round(num(f.sodium) * s),
      sat_fat: r1x(num(f.sat_fat) * s),
    };
    const brand = f.brand || "";
    const name = f.name + (brand ? ` (${brand})` : "");
    const qty = (servings === 1 ? "" : servings + "× ") + (f.serving_desc || "1 serving");
    const items: FoodItem[] = [
      { name: f.name, qty, kcal: total.kcal, protein: total.protein, carbs: total.carbs, fat: total.fat, macros: macrosOf(total) },
    ];
    try {
      await instance.update<Food>("foods", f.id, { usage_count: num(f.usage_count) + 1 });
    } catch {
      /* usage bump is best-effort */
    }
    const logged_at = b.logged_at ? new Date(b.logged_at).toISOString() : new Date().toISOString();
    const tz = num(b.tz_offset_min);
    const day = dayKey(logged_at, tz);
    const entry = await store.create<Entry>("entries", {
      user: uid,
      kind: "food",
      description: name,
      source: "db",
      kcal: total.kcal,
      macros: macrosOf(total),
      items,
      logged_at,
      tz_offset_min: tz,
      day,
    });
    return ok(c, { entry, totals: await dayTotals(store, day) });
  });

  // ---- POST /api/log/photo — vision estimate from a base64 image.
  app.post("/api/log/photo", requireAI, async (c) => {
    const uid = getUid(c);
    await ensureProfile(platform, uid, getEmail(c));
    const b = (await c.req.json().catch(() => ({}))) as { image?: string; mimeType?: string; note?: string; logged_at?: string; tz_offset_min?: number };
    let data = String(b.image || "");
    let mimeType = String(b.mimeType || "image/jpeg");
    const m = data.match(/^data:([^;]+);base64,(.*)$/);
    if (m) {
      mimeType = m[1]!;
      data = m[2]!;
    }
    if (!data) return err(c, "image is required (base64)", 400);
    const note = String(b.note || "").trim();
    const store = platform.data.forUser(uid);
    try {
      const prompt = note
        ? "Estimate the nutrition of the food in this photo. Context: " + note
        : "Estimate the nutrition of the food in this photo.";
      const { provider, model } = await resolveDefaultModel(platform, "vision");
      const est = await estimateNutrition(platform, { provider, model, text: prompt, image: { mimeType, data } });
      try {
        await foodsKb.upsertItems(instance, est.items);
      } catch {
        /* best-effort */
      }
      const names = (est.items || []).map((i) => (i && i.name ? String(i.name) : "")).filter(Boolean);
      const summary = names.length ? names.slice(0, 4).join(", ") + (names.length > 4 ? "…" : "") : "";
      const logged_at = b.logged_at ? new Date(b.logged_at).toISOString() : new Date().toISOString();
      const tz = num(b.tz_offset_min);
      const day = dayKey(logged_at, tz);
      const entry = await store.create<Entry>("entries", {
        user: uid,
        kind: "food",
        description: note || summary || "(photo)",
        source: "photo",
        kcal: est.total.kcal,
        macros: macrosOf(est.total),
        items: foodItemsOf(est.items),
        provider,
        model,
        logged_at,
        tz_offset_min: tz,
        day,
      });
      return ok(c, { entry, note: est.note, totals: await dayTotals(store, day) });
    } catch (e) {
      return err(c, msgOf(e), 502);
    }
  });

  // ---- POST /api/log/activity — preset MET path (no AI) OR free-text AI estimate.
  app.post("/api/log/activity", async (c) => {
    const uid = getUid(c);
    const profile = await ensureProfile(platform, uid, getEmail(c));
    const b = (await c.req.json().catch(() => ({}))) as {
      activity_id?: string;
      duration_min?: number;
      distance?: number;
      intensity?: string;
      text?: string;
      logged_at?: string;
      tz_offset_min?: number;
    };
    const store = platform.data.forUser(uid);
    const durationIn = num(b.duration_min);
    const distance = num(b.distance);
    const logged_at = b.logged_at ? new Date(b.logged_at).toISOString() : new Date().toISOString();
    const tz = num(b.tz_offset_min);
    const day = dayKey(logged_at, tz);
    try {
      // Preset path — deterministic burn from the seeded MET, no AI call.
      if (b.activity_id) {
        const act = await instance.get<Activity>("activities", String(b.activity_id));
        if (!act) return err(c, "unknown activity", 404);
        const minutes = durationIn > 0 ? durationIn : 30;
        const kcal = activitiesKb.burnFor(act, minutes);
        const name = act.name;
        try {
          await activitiesKb.bumpUsage(instance, [act]);
        } catch {
          /* best-effort */
        }
        const entry = await store.create<Entry>("entries", {
          user: uid,
          kind: "activity",
          description: name,
          source: "preset",
          kcal,
          duration_min: minutes,
          distance,
          intensity: b.intensity ? String(b.intensity) : "",
          items: [{ name, duration_min: minutes, kcal_burned: kcal }],
          logged_at,
          tz_offset_min: tz,
          day,
        });
        return ok(c, { entry, note: "", totals: await dayTotals(store, day) });
      }

      // Free-text path — AI estimate (gated: this branch invokes the model, the preset path above does not).
      const text = String(b.text || "").trim();
      if (!text) return err(c, "text or activity_id is required", 400);
      const denied = await gateAI(c);
      if (denied) return denied;
      const { est, provider, model } = await estimateActivityText(platform, instance, store, profile, text);
      const t = est.total;
      const entry = await store.create<Entry>("entries", {
        user: uid,
        kind: "activity",
        description: text,
        source: "activity_ai",
        kcal: Math.round(t.kcal_burned),
        duration_min: durationIn > 0 ? durationIn : t.duration_min,
        distance,
        items: est.items,
        provider,
        model,
        logged_at,
        tz_offset_min: tz,
        day,
      });
      return ok(c, { entry, note: est.note, totals: await dayTotals(store, day) });
    } catch (e) {
      return err(c, msgOf(e), 502);
    }
  });

  // ---- POST /api/log/barcode — local foods → nutrition chain → identity+AI fallback → cache → log.
  app.post("/api/log/barcode", async (c) => {
    const uid = getUid(c);
    await ensureProfile(platform, uid, getEmail(c));
    const b = (await c.req.json().catch(() => ({}))) as { barcode?: string; logged_at?: string; tz_offset_min?: number };
    const code = String(b.barcode || "").replace(/[^0-9]/g, "");
    if (!code) return err(c, "no barcode provided", 400);
    const store = platform.data.forUser(uid);

    // Local foods DB first — try every equivalent barcode form (UPC-E→UPC-A, UPC-12↔EAN-13).
    let food: Food | null = null;
    for (const bc of barcodeVariants(code)) {
      if (food) break;
      try {
        const { items } = await instance.list<Food>("foods", { where: [{ field: "barcode", op: "==", value: bc }], limit: 1 });
        food = items[0] ?? null;
      } catch {
        food = null;
      }
    }

    let item: BarcodeFood | null = null;
    let via = "";
    if (food) {
      via = "database";
      item = {
        name: food.name,
        brand: food.brand || "",
        serving_desc: food.serving_desc || "1 serving",
        serving_g: 0,
        kcal: num(food.kcal),
        protein: num(food.protein),
        carbs: num(food.carbs),
        fat: num(food.fat),
        fiber: num(food.fiber),
        sugar: num(food.sugar),
        sodium: num(food.sodium),
        sat_fat: num(food.sat_fat),
      };
      try {
        await instance.update<Food>("foods", food.id, { usage_count: num(food.usage_count) + 1 });
      } catch {
        /* best-effort */
      }
    } else {
      const s = await readSettings(instance);
      const cfg = lookupCfg(s);
      let hit = await barcodeLookupOnline(code, cfg);
      // No authoritative nutrition anywhere → name it via the identity sources, then AI-estimate the
      // macros (web-grounded if possible, else a plain estimate). Saved unverified — it's an estimate.
      if (!hit) {
        // This fallback is the only AI branch of the barcode route (local DB + the OFF/USDA/Nutritionix/
        // FatSecret nutrition chain above are all non-AI), so gate it here rather than on the whole route.
        const denied = await gateAI(c);
        if (denied) return denied;
        let ident: { name: string; brand: string; via: string; src: string } | null = null;
        try {
          ident = await barcodeIdentifyOnline(code, cfg);
        } catch {
          ident = null;
        }
        if (ident) {
          const label = ident.brand ? ident.name + " " + ident.brand : ident.name;
          let est: NutritionResult | null = null;
          try {
            est = await webLookup(platform, label, await sourcesHint(instance));
            try {
              await foodsKb.upsertItems(instance, est.items, "web");
            } catch {
              /* best-effort */
            }
          } catch {
            est = null;
          }
          if (!est || !(est.total && est.total.kcal > 0)) {
            try {
              est = (await estimateFoodText(platform, instance, label)).est;
            } catch {
              est = null;
            }
          }
          const t = est && est.total;
          if (t && t.kcal > 0) {
            hit = {
              food: {
                name: ident.name,
                brand: ident.brand,
                serving_desc: "1 serving",
                serving_g: 0,
                kcal: Math.round(t.kcal),
                protein: r1x(t.protein),
                carbs: r1x(t.carbs),
                fat: r1x(t.fat),
                fiber: r1x(t.fiber),
                sugar: r1x(t.sugar),
                sodium: Math.round(num(t.sodium)),
                sat_fat: r1x(t.sat_fat),
              },
              via: ident.via + " → AI estimate",
              src: "barcode-id",
            };
          }
        }
      }
      if (!hit) {
        return c.json(
          { error: "Barcode not found in the database, Open Food Facts, or your configured sources.", barcode: code },
          404,
        );
      }
      via = hit.via;
      item = hit.food;
      const off = hit.food;
      // Cache it so the next scan is instant and the DB grows. (Food schema has no serving_g column;
      // v1's serving_g is dropped here.)
      try {
        await instance.create<Food>("foods", {
          name: off.name,
          brand: off.brand,
          serving_desc: off.serving_desc,
          kcal: off.kcal,
          protein: off.protein,
          carbs: off.carbs,
          fat: off.fat,
          fiber: num(off.fiber),
          sugar: num(off.sugar),
          sodium: num(off.sodium),
          sat_fat: num(off.sat_fat),
          category: "",
          barcode: code,
          aliases: [],
          source: hit.src,
          verified: false,
          usage_count: 1,
          search: (off.name + " " + off.brand + " " + code).toLowerCase(),
          norm_key: foodsKb.normKey(off.name, off.brand),
        });
      } catch {
        /* cache write is best-effort */
      }
    }

    const label = item.brand ? item.name + " (" + item.brand + ")" : item.name;
    const total = macrosOf(item);
    const logged_at = b.logged_at ? new Date(b.logged_at).toISOString() : new Date().toISOString();
    const tz = num(b.tz_offset_min);
    const day = dayKey(logged_at, tz);
    const entry = await store.create<Entry>("entries", {
      user: uid,
      kind: "food",
      description: label,
      source: "barcode",
      kcal: num(item.kcal),
      macros: total,
      items: [
        {
          name: item.name,
          qty: item.serving_desc || "1 serving",
          kcal: num(item.kcal),
          protein: num(item.protein),
          carbs: num(item.carbs),
          fat: num(item.fat),
          macros: total,
        },
      ],
      logged_at,
      tz_offset_min: tz,
      day,
    });
    return ok(c, { entry, found_via: via, name: label, totals: await dayTotals(store, day) });
  });

  // ---- POST /api/log/heart-rate — HR window → activity via Keytel (default) or AI, overlap-guarded.
  app.post("/api/log/heart-rate", async (c) => {
    const uid = getUid(c);
    const profile = await ensureProfile(platform, uid, getEmail(c));
    const b = (await c.req.json().catch(() => ({}))) as {
      name?: string;
      start?: string;
      end?: string;
      duration_min?: number;
      avg_hr?: number;
      max_hr?: number;
      weight_kg?: number;
      age?: number;
      sex?: string;
      method?: string;
      confirm_overlap?: boolean;
      tz_offset_min?: number;
    };
    const store = platform.data.forUser(uid);

    const name = String(b.name || "").trim() || "Heart-rate activity";
    const avgHr = num(b.avg_hr);
    const maxHr = num(b.max_hr);
    const startMs = b.start ? Date.parse(String(b.start)) : NaN;
    const endMs = b.end ? Date.parse(String(b.end)) : NaN;
    let minutes = Math.round(num(b.duration_min));
    if ((!minutes || minutes <= 0) && isFinite(startMs) && isFinite(endMs)) {
      minutes = Math.max(1, Math.round((endMs - startMs) / 60000));
    }
    if (!minutes || minutes <= 0) return err(c, "duration_min (or start+end) required", 400);
    if (!avgHr) return err(c, "avg_hr required", 400);
    const tz = num(b.tz_offset_min);

    // Overlap guard — scan the day(s) the window touches for an activity that intersects it.
    if (!b.confirm_overlap && isFinite(startMs) && isFinite(endMs)) {
      try {
        const days = [dayKey(new Date(startMs).toISOString(), tz)];
        const endDay = dayKey(new Date(endMs).toISOString(), tz);
        if (endDay !== days[0]) days.push(endDay);
        for (const d of days) {
          const { items } = await store.list<Entry>("entries", { where: [{ field: "day", op: "==", value: d }], limit: 500 });
          for (const rec of items) {
            if (rec.kind !== "activity") continue;
            const rs = Date.parse(rec.logged_at);
            const re = rs + (num(rec.duration_min) || 0) * 60000;
            if (rs < endMs && re > startMs) {
              return ok(c, { warning: 'overlaps "' + rec.description + '"', overlap: true });
            }
          }
        }
      } catch {
        /* best-effort guard; never block the log on it */
      }
    }

    // Estimate the burn per the chosen method.
    const method = b.method === "ai" || b.method === "formula" ? b.method : profile.hr_estimate_method === "ai" ? "ai" : "formula";
    let kcal = 0;
    let provider = "";
    let model = "";
    let note = "";
    try {
      if (method === "ai") {
        const denied = await gateAI(c);
        if (denied) return denied;
        const desc =
          name + " — about " + minutes + " min at avg " + Math.round(avgHr) + " bpm" +
          (maxHr ? ", peak " + Math.round(maxHr) + " bpm" : "");
        const r = await estimateActivityText(platform, instance, store, profile, desc);
        kcal = Math.round(num(r.est.total.kcal_burned));
        provider = r.provider;
        model = r.model;
        note = r.est.note || "";
      } else {
        const weight = num(b.weight_kg) || num(profile.body_weight_kg);
        const age = num(b.age) || num(profile.age);
        const sex = String(b.sex || profile.sex || "");
        kcal = Math.round(keytelKcalPerMin(avgHr, weight, age, sex) * minutes);
      }
    } catch (e) {
      return err(c, msgOf(e), 502);
    }
    if (kcal < 0) kcal = 0;

    const logged_at = isFinite(startMs) ? new Date(startMs).toISOString() : new Date().toISOString();
    const day = dayKey(logged_at, tz);
    const entry = await store.create<Entry>("entries", {
      user: uid,
      kind: "activity",
      description: name,
      source: "heart_rate",
      kcal,
      duration_min: minutes,
      intensity: "avg " + Math.round(avgHr) + (maxHr ? " / max " + Math.round(maxHr) : "") + " bpm",
      items: [{ name, duration_min: minutes, kcal_burned: kcal, avg_hr: Math.round(avgHr), max_hr: Math.round(maxHr) }],
      provider,
      model,
      logged_at,
      tz_offset_min: tz,
      day,
    });
    return ok(c, { entry, method, kcal, note, totals: await dayTotals(store, day) });
  });

  // ---- GET /api/entries?day=YYYY-MM-DD — a local day's entries + intake totals.
  app.get("/api/entries", async (c) => {
    const uid = getUid(c);
    const store = platform.data.forUser(uid);
    const tz = Number(c.req.query("tz") || 0);
    const date = String(c.req.query("day") || c.req.query("date") || dayKey(new Date().toISOString(), tz));
    let items: Entry[] = [];
    try {
      ({ items } = await store.list<Entry>("entries", { where: [{ field: "day", op: "==", value: date }], limit: 500 }));
    } catch {
      items = [];
    }
    items.sort((a, b) => (a.logged_at < b.logged_at ? 1 : -1)); // newest first
    return ok(c, { date, entries: items, totals: await dayTotals(store, date) });
  });

  // ---- GET /api/feed — cursor-paginated infinite feed across all days.
  app.get("/api/feed", async (c) => {
    const uid = getUid(c);
    const store = platform.data.forUser(uid);
    const limit = Math.min(100, Math.max(10, parseInt(c.req.query("limit") || "", 10) || 40));
    const scope = String(c.req.query("scope") || "all");
    const before = String(c.req.query("before") || "");
    // Scope is filtered in app code, NOT in the store query: Firestore can't combine a `kind` filter
    // with the `logged_at` order/cursor without a composite index, and `kind != "activity"` is an
    // invalid Firestore query (an inequality filter must be the first orderBy). So we order by
    // logged_at only and filter by kind here. `wantActivity` null = All (no filter).
    const wantActivity = scope === "activity" ? true : scope === "nutrition" ? false : null;
    const matches = (r: Entry) => wantActivity === null || (r.kind === "activity") === wantActivity;
    const where: { field: string; op: "==" | "!=" | "<"; value: unknown }[] = [];
    if (before) where.push({ field: "logged_at", op: "<", value: before });
    // When filtering, scan a wider window per page so a page can be filled; capped for safety.
    const scan = wantActivity === null ? limit + 1 : Math.min(500, (limit + 1) * 5);
    let recs: Entry[] = [];
    try {
      ({ items: recs } = await store.list<Entry>("entries", {
        where,
        orderBy: [{ field: "logged_at", dir: "desc" }],
        limit: scan,
      }));
    } catch {
      recs = [];
    }
    const filtered = recs.filter(matches);
    const page = filtered.slice(0, limit);
    let next: string | null = null;
    if (filtered.length > limit) {
      // More matching rows within this scan → resume just after the last one we returned.
      next = page[page.length - 1]!.logged_at;
    } else if (recs.length >= scan) {
      // Scan hit its cap (older rows may still match) → resume past everything scanned.
      next = recs[recs.length - 1]!.logged_at;
    }
    return ok(c, { entries: page, next });
  });

  // ---- PATCH /api/entries/:id — scale | direct overrides | re_estimate | set_total | manual.
  app.patch("/api/entries/:id", async (c) => {
    const uid = getUid(c);
    const store = platform.data.forUser(uid);
    const id = c.req.param("id");
    const rec = await store.get<Entry>("entries", id);
    if (!rec) return err(c, "not found", 404);
    if (rec.user !== uid) return err(c, "forbidden", 403);
    const activity = rec.kind === "activity";
    const b = (await c.req.json().catch(() => ({}))) as Record<string, any>;

    // Working copy of the mutable nutrition/activity state.
    let kcal = num(rec.kcal);
    const macros: Macros = { protein: 0, carbs: 0, fat: 0, ...(rec.macros || {}) };
    let items: any[] = Array.isArray(rec.items) ? rec.items.map((it) => ({ ...(it as object) })) : [];
    let duration = num(rec.duration_min);
    let distance = num(rec.distance);
    let intensity = rec.intensity;
    let description = rec.description;
    let note = rec.note;
    let source = rec.source;
    let provider = rec.provider;
    let model = rec.model;
    const MACRO_KEYS: (keyof Macros)[] = ["protein", "carbs", "fat", "fiber", "sugar", "sodium", "sat_fat"];

    try {
      if (b.re_estimate && String(b.text || "").trim()) {
        const denied = await gateAI(c);
        if (denied) return denied;
        const text = String(b.text).trim();
        if (activity) {
          const profile = await ensureProfile(platform, uid, getEmail(c));
          const { est } = await estimateActivityText(platform, instance, store, profile, text);
          const t = est.total;
          description = text;
          items = est.items as any[];
          duration = num(t.duration_min);
          kcal = Math.round(t.kcal_burned);
          source = "activity_ai";
        } else {
          const { est } = await estimateFoodText(platform, instance, text);
          description = text;
          items = foodItemsOf(est.items) as any[];
          kcal = num(est.total.kcal);
          for (const k of MACRO_KEYS) macros[k] = num((est.total as any)[k]);
          source = "text";
        }
      } else if (b.set_total && typeof b.set_total === "object") {
        // Apply an explicit estimate the client already holds (e.g. an accepted second opinion).
        const t = b.set_total as Record<string, unknown>;
        items = Array.isArray(b.set_items) ? (b.set_items as any[]) : [];
        if (activity) {
          duration = num(t.duration_min);
          kcal = Math.round(num(t.kcal_burned));
          source = "activity_ai";
        } else {
          kcal = num(t.kcal);
          for (const k of MACRO_KEYS) macros[k] = num(t[k]);
          source = "text";
        }
        if (b.set_provider !== undefined) provider = String(b.set_provider);
        if (b.set_model !== undefined) model = String(b.set_model);
      } else if (num(b.scale) > 0 && num(b.scale) !== 1) {
        const sc = num(b.scale);
        kcal = +(kcal * sc).toFixed(2);
        for (const k of MACRO_KEYS) macros[k] = +(num(macros[k]) * sc).toFixed(2);
        if (activity) {
          duration = +(duration * sc).toFixed(1);
          if (distance) distance = +(distance * sc).toFixed(2);
        }
        const SCALE_KEYS = ["kcal", "protein", "carbs", "fat", "fiber", "sugar", "sodium", "sat_fat", "kcal_burned"];
        items = items.map((it) => {
          const o: any = { ...it };
          for (const k of SCALE_KEYS) if (typeof o[k] === "number") o[k] = +(o[k] * sc).toFixed(2);
          if (o.macros && typeof o.macros === "object") {
            const mm: any = { ...o.macros };
            for (const k of MACRO_KEYS) if (typeof mm[k] === "number") mm[k] = +(mm[k] * sc).toFixed(2);
            o.macros = mm;
          }
          return o;
        });
      }

      // Direct overrides (applied after scale/re-estimate).
      if (b.kcal !== undefined) kcal = num(b.kcal);
      for (const k of MACRO_KEYS) if (b[k] !== undefined) macros[k] = num(b[k]);
      if (b.duration_min !== undefined) duration = num(b.duration_min);
      if (b.distance !== undefined) distance = num(b.distance);
      if (b.intensity !== undefined) intensity = String(b.intensity);
      if (b.description !== undefined) description = String(b.description).slice(0, 2000);
      if (b.note !== undefined) note = String(b.note).slice(0, 2000);
      if (b.manual) source = "manual";

      const patch: Partial<Entry> = {
        kcal,
        items: items as Entry["items"],
        description,
        note,
        source,
        provider,
        model,
      };
      if (!activity) patch.macros = macros;
      if (activity) {
        patch.duration_min = duration;
        patch.distance = distance;
      }
      if (intensity !== undefined) patch.intensity = intensity;

      const updated = await store.update<Entry>("entries", id, patch);
      const day = dayOf(updated);
      return ok(c, { entry: updated, totals: await dayTotals(store, day) });
    } catch (e) {
      return err(c, msgOf(e), 502);
    }
  });

  // ---- DELETE /api/entries/:id — owner-guarded delete.
  app.delete("/api/entries/:id", async (c) => {
    const uid = getUid(c);
    const store = platform.data.forUser(uid);
    const id = c.req.param("id");
    const rec = await store.get<Entry>("entries", id);
    if (!rec) return err(c, "not found", 404);
    if (rec.user !== uid) return err(c, "forbidden", 403);
    await store.delete("entries", id);
    return ok(c, { deleted: id });
  });

  // ---- GET /api/activities/search?q= — compose-tab autocomplete + per-minute burn.
  app.get("/api/activities/search", async (c) => {
    const q = String(c.req.query("q") || "");
    const recs = await activitiesKb.searchByPrefix(instance, q, 12);
    const rate = activitiesKb.KCAL_PER_MIN_PER_MET;
    return ok(c, {
      activities: recs.map((r) => ({
        id: r.id,
        name: r.name,
        category: r.category,
        met: num(r.met),
        kcal_min: Math.round(num(r.met) * rate * 10) / 10,
      })),
    });
  });
}
