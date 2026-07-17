// Sate core — food search + pick/manual/online-accept (the "What did you eat?" flow).
// Ported from pb_hooks/api.js (foodsSearch, foodsSearchOnline, foodsWebCandidate, foodsAccept,
// foodsManual + the USDA/Open Food Facts parsers). All routes run under /api/* after the auth
// middleware; per-user data is data.forUser(uid), the shared foods KB is data.instance(). v1's
// user_email maps to the Firebase uid.

import { getUid, ok, err, dayKey, foodGrounding, type App, type RouteDeps } from "./helpers";
import { resolveDefaultModel, estimateNutrition, webLookup } from "../ai/index";
import * as foodsKb from "../kb/foods";
import type { Entry, Food, FoodItem, Macros } from "../schema";
import type { Platform, DataStore } from "../ports";

const { norm, num } = foodsKb;

// The eight flat nutrition columns carried on every candidate/total. Order-preserving.
const NUT_KEYS = ["kcal", "protein", "carbs", "fat", "fiber", "sugar", "sodium", "sat_fat"] as const;
type NutKey = (typeof NUT_KEYS)[number];
type NutTotal = Record<NutKey, number>;

// Round to 1 decimal (v1 r1x — macros are noisy past a tenth of a gram).
const r1x = (x: unknown): number => Math.round((Number(x) || 0) * 10) / 10;

function emptyTotal(): NutTotal {
  return { kcal: 0, protein: 0, carbs: 0, fat: 0, fiber: 0, sugar: 0, sodium: 0, sat_fat: 0 };
}

// A NutTotal → the nested Macros shape the v2 Entry stores (kcal lives on the entry, not in macros).
function macrosOf(t: NutTotal): Macros {
  return {
    protein: t.protein,
    carbs: t.carbs,
    fat: t.fat,
    fiber: t.fiber,
    sugar: t.sugar,
    sodium: t.sodium,
    sat_fat: t.sat_fat,
  };
}

// ---- instance settings + curated sources -------------------------------
async function settingsMap(platform: Platform): Promise<Record<string, string>> {
  try {
    const { items } = await platform.data
      .instance()
      .list<{ key: string; value: string }>("settings", { limit: 500 });
    const m: Record<string, string> = {};
    for (const r of items) m[r.key] = r.value;
    return m;
  } catch {
    return {};
  }
}

// Build the "prefer these sources" hint from the enabled curated nutrition URLs for web lookups.
// Faithful to v1 sourcesHint; passed into webLookup (which owns the AI call).
async function sourcesHint(platform: Platform): Promise<string> {
  let recs: { title: string; url: string; domain: string; enabled: boolean }[] = [];
  try {
    const { items } = await platform.data
      .instance()
      .list<{ title: string; url: string; domain: string; enabled: boolean }>("sources", {
        where: [{ field: "enabled", op: "==", value: true }],
        limit: 50,
      });
    recs = items;
  } catch {
    recs = [];
  }
  if (!recs.length) return "";
  const lines = recs.map((r) => `- ${r.title}: ${r.domain || r.url}`);
  const domains = recs.map((r) => r.domain).filter(Boolean);
  const example = domains.length
    ? domains.slice(0, 3).map((d) => "site:" + d).join(" OR ")
    : "site:fdc.nal.usda.gov";
  return (
    "Preferred sources — search THESE FIRST with Google 'site:' operators before any general search " +
    '(e.g. query: "<food> nutrition facts ' + example + '"). Fall back to a broad search only if none ' +
    "of them cover the food:\n" + lines.join("\n")
  );
}

// ---- candidate shapes ---------------------------------------------------
interface Candidate {
  id?: string;
  source: string; // local | usda | off | web
  name: string;
  brand: string;
  serving_desc: string;
  serving_g?: number;
  kcal: number;
  protein: number;
  carbs: number;
  fat: number;
  fiber: number;
  sugar: number;
  sodium: number;
  sat_fat: number;
}

// A stored Food → the shape the composer autocomplete + search overlay expect (v1 foodPickJSON).
function foodPickJSON(f: Food): Candidate {
  return {
    id: f.id,
    source: "local",
    name: f.name,
    brand: f.brand,
    serving_desc: f.serving_desc || "1 serving",
    kcal: f.kcal,
    protein: f.protein,
    carbs: f.carbs,
    fat: f.fat,
    fiber: f.fiber,
    sugar: f.sugar,
    sodium: f.sodium,
    sat_fat: f.sat_fat,
  };
}

// ---- local KB search ----------------------------------------------------
// Substring autocomplete over the shared foods KB. The DataStore has no LIKE op, so we scan a bounded
// page and match in memory, ranked verified-first then most-used — the same pattern kb/activities uses
// for its searchByPrefix (kb/foods exposes no prefix search, so this lives here). Faithful to v1's
// `findRecordsByFilter("foods", "search ~ {:t}", "-verified,-usage_count,name", …)`.
async function localFoodSearch(store: DataStore, q: string, limit: number): Promise<Food[]> {
  const term = norm(q);
  let rows: Food[] = [];
  try {
    rows = (await store.list<Food>("foods", { limit: 2000 })).items;
  } catch {
    return [];
  }
  const matched = term ? rows.filter((r) => (r.search || norm(r.name)).indexOf(term) !== -1) : rows;
  matched.sort(
    (a, b) =>
      (b.verified ? 1 : 0) - (a.verified ? 1 : 0) ||
      num(b.usage_count) - num(a.usage_count) ||
      String(a.name).localeCompare(String(b.name)),
  );
  return matched.slice(0, limit);
}

// ---- USDA FoodData Central (free-text, public domain) -------------------
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function fetchJson(url: string, headers?: Record<string, string>): Promise<any | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  try {
    const res = await fetch(url, { headers, signal: ctrl.signal });
    if (!res.ok) return null; // incl. 429 OVER_RATE_LIMIT → skip gracefully
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Parse one USDA hit (Branded label values, else per-100g foodNutrients) into a candidate. v1 parseUsdaFood.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parseUsdaFood(hit: any): Candidate | null {
  const ln = hit.labelNutrients || {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const lv = (o: any): number => (o && isFinite(o.value) ? Number(o.value) : 0);
  let kcal: number, protein: number, carbs: number, fat: number;
  let fiber: number, sugar: number, sodium: number, sat_fat: number;
  let servingDesc: string, servingG: number;
  if (String(hit.dataType || "") === "Branded" && lv(ln.calories) > 0) {
    kcal = lv(ln.calories);
    protein = lv(ln.protein);
    carbs = lv(ln.carbohydrates);
    fat = lv(ln.fat);
    fiber = lv(ln.fiber);
    sugar = lv(ln.sugars);
    sodium = lv(ln.sodium);
    sat_fat = lv(ln.saturatedFat);
    const sg = Number(hit.servingSize) || 0;
    servingDesc = sg ? hit.householdServingFullText || sg + " " + (hit.servingSizeUnit || "g") : "1 serving";
    servingG = sg || 0;
  } else {
    const per: Record<string, number> = {};
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
    if (!(num(per.kcal) > 0)) return null;
    const sg = Number(hit.servingSize) || 0;
    const f = sg ? sg / 100 : 1;
    kcal = num(per.kcal) * f;
    protein = num(per.protein) * f;
    carbs = num(per.carbs) * f;
    fat = num(per.fat) * f;
    fiber = num(per.fiber) * f;
    sugar = num(per.sugar) * f;
    sodium = num(per.sodium) * f;
    sat_fat = num(per.sat_fat) * f;
    servingDesc = sg ? hit.householdServingFullText || sg + " g" : "100 g";
    servingG = sg || 100;
  }
  if (!(kcal > 0)) return null;
  return {
    source: "usda",
    name: String(hit.description || "").trim().slice(0, 70),
    brand: String(hit.brandName || hit.brandOwner || "").trim().slice(0, 40),
    serving_desc: String(servingDesc).slice(0, 40),
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

async function searchUsdaText(query: string, apiKey?: string): Promise<Candidate[]> {
  const key = apiKey || "DEMO_KEY";
  const url =
    "https://api.nal.usda.gov/fdc/v1/foods/search?api_key=" +
    encodeURIComponent(key) +
    "&pageSize=8&dataType=Foundation,SR%20Legacy,Branded&query=" +
    encodeURIComponent(query);
  const json = await fetchJson(url);
  if (!json) return [];
  const out: Candidate[] = [];
  for (const hit of json.foods || []) {
    const p = parseUsdaFood(hit);
    if (p) out.push(p);
  }
  return out;
}

// ---- Open Food Facts (free-text, runtime API) ---------------------------
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parseOffProduct(p: any): Candidate | null {
  const nut = p.nutriments || {};
  const name = String(p.product_name || "").trim();
  if (!name) return null;
  const sq = Number(p.serving_quantity) || 0;
  let kcal: number, protein: number, carbs: number, fat: number;
  let fiber: number, sugar: number, sodium: number, sat_fat: number;
  let servingDesc: string, servingG: number;
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
    source: "off",
    name: name.slice(0, 70),
    brand: String(p.brands || "").split(",")[0]!.trim().slice(0, 40),
    serving_desc: String(servingDesc).slice(0, 40),
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

async function searchOffText(query: string): Promise<Candidate[]> {
  const url =
    "https://world.openfoodfacts.org/cgi/search.pl?search_terms=" +
    encodeURIComponent(query) +
    "&search_simple=1&action=process&json=1&page_size=8" +
    "&fields=product_name,brands,serving_size,serving_quantity,nutriments";
  const json = await fetchJson(url, { "User-Agent": "Sate/1.0 (self-hosted calorie app)" });
  if (!json) return [];
  const out: Candidate[] = [];
  for (const p of json.products || []) {
    const c = parseOffProduct(p);
    if (c) out.push(c);
  }
  return out;
}

// ---- entry write + day totals ------------------------------------------
// Persist a food entry (intake) for the user and return it. Mirrors buildApi's own Entry.create shape:
// flat kcal on the entry, nested macros, day = tz-aware bucket. `items` carry v1's flat per-item macros.
async function logFoodEntry(
  store: DataStore,
  uid: string,
  o: {
    description: string;
    note?: string;
    source: string;
    total: NutTotal;
    items: FoodItem[];
    provider?: string;
    model?: string;
    logged_at?: string;
    tz_offset_min?: number;
  },
): Promise<Entry> {
  const logged_at = o.logged_at || new Date().toISOString();
  const tz = o.tz_offset_min ?? 0;
  return store.create<Entry>("entries", {
    user: uid,
    kind: "food",
    description: o.description,
    note: o.note ? String(o.note) : undefined,
    kcal: o.total.kcal,
    macros: macrosOf(o.total),
    items: o.items,
    source: o.source,
    provider: o.provider || "",
    model: o.model || "",
    logged_at,
    tz_offset_min: tz,
    day: dayKey(logged_at, tz),
  });
}

// Intake totals for the given local day (activity entries carry burn, never intake → skipped).
// Faithful to v1 sumTotals over dayEntries.
async function dayTotals(store: DataStore, day: string): Promise<NutTotal & { count: number }> {
  const t = { ...emptyTotal(), count: 0 };
  let items: Entry[] = [];
  try {
    items = (
      await store.list<Entry>("entries", { where: [{ field: "day", op: "==", value: day }], limit: 500 })
    ).items;
  } catch {
    items = [];
  }
  for (const e of items) {
    if (e.kind === "activity") continue;
    const m = e.macros || ({} as Macros);
    t.count += 1;
    t.kcal += num(e.kcal);
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

// The single food-item line stored on a food entry (v1 shape: {name, qty, kcal, protein, carbs, fat}).
function foodLineItem(name: string, qty: string, total: NutTotal): FoodItem {
  return { name, qty, kcal: total.kcal, protein: total.protein, carbs: total.carbs, fat: total.fat };
}

// ============================================================================

export async function registerFoods(app: App, deps: RouteDeps): Promise<void> {
  const { platform, requireAI } = deps;
  const instance = () => platform.data.instance();

  // GET /api/foods/search?q= — local DB matches for the composer autocomplete dropdown.
  app.get("/api/foods/search", async (c) => {
    const q = String(c.req.query("q") || "");
    const recs = await localFoodSearch(instance(), q, 12);
    return ok(c, { foods: recs.map(foodPickJSON) });
  });

  // GET /api/foods/search-online?q= — aggregate the fast, free structured sources (local DB + USDA +
  // Open Food Facts). The AI/web candidate is a separate call so the overlay shows these instantly.
  app.get("/api/foods/search-online", async (c) => {
    const q = String(c.req.query("q") || "").trim();
    if (!q) return ok(c, { results: [] });
    const out: Candidate[] = [];
    for (const r of await localFoodSearch(instance(), q, 8)) out.push(foodPickJSON(r));
    const s = await settingsMap(platform);
    try {
      for (const cand of await searchUsdaText(q, (s.usda_api_key || "").trim())) out.push(cand);
    } catch {
      /* best-effort — a down source shouldn't sink the whole overlay */
    }
    try {
      for (const cand of await searchOffText(q)) out.push(cand);
    } catch {
      /* best-effort */
    }
    return ok(c, { results: out });
  });

  // POST /api/foods/web-candidate { q } — one AI/web-grounded best guess (Google grounding).
  // Best-effort: returns { result: null } rather than erroring so the overlay just skips it.
  app.post("/api/foods/web-candidate", requireAI, async (c) => {
    const b = (await c.req.json().catch(() => ({}))) as { q?: string };
    const q = String(b.q || "").trim();
    if (!q) return err(c, "query required", 400);
    try {
      const hint = await sourcesHint(platform);
      const parsed = await webLookup(platform, q, hint);
      // Self-growth: a web lookup is authoritative — upsert its items (upgrades stale unverified rows).
      try {
        await foodsKb.upsertItems(instance(), parsed.items, "web");
      } catch {
        /* best-effort */
      }
      const t = parsed.total;
      const first = parsed.items[0];
      if (!(num(t.kcal) > 0)) return ok(c, { result: null });
      const result: Candidate = {
        source: "web",
        name: String((first && first.name) || q).slice(0, 70),
        brand: "",
        serving_desc: String((first && first.qty) || "1 serving").slice(0, 40),
        kcal: Math.round(num(t.kcal)),
        protein: r1x(t.protein),
        carbs: r1x(t.carbs),
        fat: r1x(t.fat),
        fiber: r1x(t.fiber),
        sugar: r1x(t.sugar),
        sodium: Math.round(num(t.sodium)),
        sat_fat: r1x(t.sat_fat),
      };
      return ok(c, { result });
    } catch (e) {
      return ok(c, { result: null, error: String((e as Error)?.message || e) });
    }
  });

  // POST /api/foods/accept { candidate } — the user picked a search result and accepted it. Feed it to
  // AI to normalize / fill gaps (keeping the source's own non-zero values), save it to the foods KB for
  // reuse, then log it. AI is skipped for local DB picks (already-normalized values).
  app.post("/api/foods/accept", requireAI, async (c) => {
    const uid = getUid(c);
    const body = (await c.req.json().catch(() => ({}))) as {
      candidate?: Partial<Candidate>;
      logged_at?: string;
      tz_offset_min?: number;
    };
    const cand = body.candidate || {};
    const name = String(cand.name || "").trim();
    if (!name) return err(c, "candidate name required", 400);
    const brand = String(cand.brand || "").trim();
    const serving = String(cand.serving_desc || "1 serving");

    const base = emptyTotal();
    for (const k of NUT_KEYS) base[k] = num((cand as Record<string, unknown>)[k]);

    // AI pass: complete the profile, merging conservatively — keep every non-zero source value, fill
    // only the blanks from the model. Skipped for local DB picks. (v1 estimate("text_parse", …).)
    let ai: NutTotal | null = null;
    let provider = "";
    let model = "";
    if (cand.source !== "local") {
      try {
        const resolved = await resolveDefaultModel(platform, "ai");
        provider = resolved.provider;
        model = resolved.model;
        const desc =
          "1 serving (" + serving + ") of " + name + (brand ? " by " + brand : "") +
          ". Known per-serving values: " + JSON.stringify(base) +
          ". Give the complete per-serving nutrition for this exact item.";
        const g = await foodGrounding(platform, desc);
        const est = await estimateNutrition(platform, {
          provider: resolved.provider,
          model: resolved.model,
          text: desc,
          known: g.reference || undefined,
        });
        ai = { ...emptyTotal() };
        for (const k of NUT_KEYS) ai[k] = num((est.total as Record<string, unknown>)[k]);
      } catch {
        ai = null;
      }
    }

    const total = emptyTotal();
    for (const k of NUT_KEYS) total[k] = base[k] > 0 ? base[k] : ai ? num(ai[k]) : 0;
    if (!(total.kcal > 0)) return err(c, "could not determine calories for this item", 400);

    // Save to the shared foods KB (web-authoritative; never overwrites seed/verified rows). Brand-aware
    // (v1 upsertFoodRecord): keys on normKey(name, brand) and stores the brand, so a branded accept gets
    // its own row instead of colliding with / overwriting a generic same-name row.
    try {
      await foodsKb.upsertFoodRecord(instance(), name, brand, serving, total, "web");
    } catch {
      /* best-effort */
    }

    const display = name + (brand ? " (" + brand + ")" : "");
    const items = [foodLineItem(name, serving, total)];
    const entry = await logFoodEntry(platform.data.forUser(uid), uid, {
      description: display,
      source: "web",
      total,
      items,
      provider,
      model,
      logged_at: body.logged_at,
      tz_offset_min: body.tz_offset_min,
    });
    const totals = await dayTotals(platform.data.forUser(uid), entry.day || dayKey(entry.logged_at, body.tz_offset_min ?? 0));
    return ok(c, { entry, totals });
  });

  // POST /api/foods/manual { name, serving_desc, note, kcal, protein, … } — the "Add manually" action:
  // save a user-entered food to the KB (reusable) and log it now. No AI.
  app.post("/api/foods/manual", async (c) => {
    const uid = getUid(c);
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown> & {
      logged_at?: string;
      tz_offset_min?: number;
    };
    const name = String(b.name || "").trim();
    if (!name) return err(c, "name is required", 400);
    const total = emptyTotal();
    for (const k of NUT_KEYS) total[k] = num(b[k]);
    const serving = String(b.serving_desc || "").trim() || "1 serving";

    try {
      await foodsKb.upsertItems(instance(), [{ name, qty: serving, ...total }], "manual");
    } catch {
      /* best-effort */
    }

    const items = [foodLineItem(name, serving, total)];
    const entry = await logFoodEntry(platform.data.forUser(uid), uid, {
      description: name,
      note: b.note !== undefined ? String(b.note || "") : undefined,
      source: "manual",
      total,
      items,
      logged_at: b.logged_at,
      tz_offset_min: b.tz_offset_min,
    });
    const totals = await dayTotals(platform.data.forUser(uid), entry.day || dayKey(entry.logged_at, b.tz_offset_min ?? 0));
    return ok(c, { entry, totals });
  });
}
