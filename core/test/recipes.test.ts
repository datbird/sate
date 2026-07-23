import { test } from "node:test";
import assert from "node:assert/strict";
import { client, TEST_EMAIL } from "./mem.ts";

// Install a fake Google provider: give callAI a key + stub fetch to return a canned generateContent
// reply, capturing the outgoing request body so we can inspect the prompt the route actually sent.
function stubGemini(platform: any, replyObj: unknown) {
  const captured: { body: any } = { body: null };
  // Only answer the AI provider key lookup — leaving entitlements-plane secrets (entitlements-api-url,
  // entitlements-read-key) unset keeps checkFeature's self-host-open path (no plane configured), which
  // is what every other route test relies on. A blanket stub would make requireAI think a plane IS
  // configured and then fail closed (403) against this same stubbed fetch.
  platform.secrets.get = async (name?: string) => (name === "google-api-key" ? "test-key" : undefined);
  (globalThis as any).fetch = async (_url: string, init: any) => {
    captured.body = JSON.parse(init.body);
    const text = typeof replyObj === "string" ? replyObj : JSON.stringify(replyObj);
    return new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ text }] } }],
      usageMetadata: { promptTokenCount: 11, candidatesTokenCount: 22 },
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  return captured;
}
// The prompt text sent to Google lives in systemInstruction + contents[].parts[].text.
function sentText(body: any): string {
  const sys = body?.systemInstruction?.parts?.map((p: any) => p.text).join("\n") || "";
  const msgs = (body?.contents || []).flatMap((c: any) => (c.parts || []).map((p: any) => p.text)).join("\n");
  return sys + "\n" + msgs;
}

test("POST /api/recipes/suggest 400s a missing/invalid target BEFORE any AI call", async () => {
  const orig = (globalThis as any).fetch;
  let called = false;
  (globalThis as any).fetch = async () => { called = true; return new Response("{}"); };
  try {
    const { req } = client();
    const res = await req("/api/recipes/suggest", { method: "POST", body: JSON.stringify({ method: "balanced" }) });
    assert.equal(res.status, 400);
    assert.equal(called, false, "no AI call on a validation failure");
  } finally { (globalThis as any).fetch = orig; }
});

test("POST /api/recipes/suggest injects PROFILE allergies, ignores body allergies, and returns ideas", async () => {
  const orig = (globalThis as any).fetch;
  try {
    const { req, platform, inst } = client();
    // Seed the profile's allergies (Phase-4 field) directly on the user store.
    const store = platform.data.forUser(TEST_EMAIL);
    await store.create("profiles", { user: TEST_EMAIL, email: TEST_EMAIL, allergies: "peanuts, shellfish" }, TEST_EMAIL);
    const cap = stubGemini(platform, { ideas: [
      { name: "Chicken rice bowl", kcal: 650, protein: 45, carbs: 60, fat: 20, blurb: "Fast and lean." },
    ]});
    const res = await req("/api/recipes/suggest", {
      method: "POST",
      body: JSON.stringify({
        target: { kcal: 650, protein: 45, carbs: 60, fat: 20 },
        method: "high-protein", prefs: "quick",
        allergies: "IGNORE-ME-CLIENT", // must NOT reach the model
      }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ideas.length, 1);
    assert.equal(body.ideas[0].name, "Chicken rice bowl");
    assert.equal(body.ideas[0].kcal, 650);
    // Server-side allergies invariant:
    const prompt = sentText(cap.body);
    assert.match(prompt, /peanuts, shellfish/, "profile allergies reached the model");
    assert.doesNotMatch(prompt, /IGNORE-ME-CLIENT/, "client body allergies MUST NOT reach the model");
    // Usage accounting (recordUsage wrote to the instance ai_usage collection):
    const usage = inst.colls.get("ai_usage");
    assert.ok(usage && usage.size >= 1, "usage recorded");
  } finally { (globalThis as any).fetch = orig; }
});

test("POST /api/recipes/expand returns the full recipe shape and carries profile allergies", async () => {
  const orig = (globalThis as any).fetch;
  try {
    const { req, platform } = client();
    const store = platform.data.forUser(TEST_EMAIL);
    await store.create("profiles", { user: TEST_EMAIL, email: TEST_EMAIL, allergies: "dairy" }, TEST_EMAIL);
    const cap = stubGemini(platform, {
      name: "Chicken rice bowl", servings: 1,
      ingredients: [{ item: "Chicken breast", amount: "150 g" }, { item: "Rice", amount: "1 cup" }],
      steps: ["Cook rice.", "Grill chicken.", "Combine."],
      kcal: 650, macros: { protein: 45, carbs: 60, fat: 20 },
    });
    const res = await req("/api/recipes/expand", {
      method: "POST",
      body: JSON.stringify({ idea: "Chicken rice bowl", target: { kcal: 650, protein: 45, carbs: 60, fat: 20 } }),
    });
    assert.equal(res.status, 200);
    const r = await res.json();
    assert.equal(r.name, "Chicken rice bowl");
    assert.equal(r.ingredients.length, 2);
    assert.equal(r.steps.length, 3);
    assert.equal(r.macros.protein, 45);
    assert.match(sentText(cap.body), /dairy/);
  } finally { (globalThis as any).fetch = orig; }
});

test("POST /api/recipes/expand 400s a missing idea", async () => {
  const { req } = client();
  const res = await req("/api/recipes/expand", { method: "POST", body: JSON.stringify({ target: { kcal: 500 } }) });
  assert.equal(res.status, 400);
});

// Error-path mapping: callAI throws a plain Error (missing key / limit exceeded / provider failure) —
// the route must turn that into a clean JSON 502, never an unhandled 500.
test("POST /api/recipes/suggest maps a callAI failure (no provider key configured) to a clean 502 JSON error", async () => {
  const orig = (globalThis as any).fetch;
  try {
    const { req } = client();
    // No secrets.get override → the default mem platform's secrets.get resolves undefined for every
    // key, so callAI's "no API key for provider" throw is exercised without ever hitting fetch.
    (globalThis as any).fetch = async () => { throw new Error("must not be called"); };
    const res = await req("/api/recipes/suggest", {
      method: "POST",
      body: JSON.stringify({ target: { kcal: 650, protein: 45, carbs: 60, fat: 20 } }),
    });
    assert.equal(res.status, 502);
    const body = await res.json();
    assert.equal(typeof body.error, "string");
    assert.match(body.error, /api key/i);
  } finally { (globalThis as any).fetch = orig; }
});

// requireAI (entitlements gate) applies to both recipe routes exactly like other AI routes — a denied
// feature check must 403 before any AI call, never reach suggestRecipes/expandRecipe.
test("POST /api/recipes/suggest 403s when the AI feature is not entitled (requireAI gate)", async () => {
  const { req, platform } = client();
  // Simulate a configured-but-denying entitlements plane: any secret lookup during checkFeature
  // resolves truthy config, and the stubbed fetch below always denies (404 → no flag → deny).
  platform.secrets.get = async (name?: string) => {
    if (name === "entitlements-api-url") return "https://entitlements.example.test";
    if (name === "entitlements-read-key") return "read-key";
    return undefined;
  };
  const orig = (globalThis as any).fetch;
  let aiCalled = false;
  (globalThis as any).fetch = async (url: string) => {
    if (String(url).includes("entitlements")) return new Response("not found", { status: 404 });
    aiCalled = true;
    return new Response("{}");
  };
  try {
    const res = await req("/api/recipes/suggest", {
      method: "POST",
      body: JSON.stringify({ target: { kcal: 650, protein: 45, carbs: 60, fat: 20 } }),
    });
    assert.equal(res.status, 403);
    assert.equal(aiCalled, false, "requireAI must reject before any AI call");
  } finally { (globalThis as any).fetch = orig; }
});
