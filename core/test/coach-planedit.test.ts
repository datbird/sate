import { test } from "node:test";
import assert from "node:assert/strict";
import { client, TEST_EMAIL } from "./mem.ts";

// Give callAI a key + stub fetch so the "model" returns a canned reply (optionally with a trailer).
// Only answer the AI provider key lookup — leaving entitlements-plane secrets (entitlements-api-url,
// entitlements-read-key) unset keeps checkFeature's self-host-open path (no plane configured), which
// is what every other route test relies on. A blanket stub would make requireAI think a plane IS
// configured and then fail closed (403) against this same stubbed fetch (see recipes.test.ts).
function stubGemini(platform: any, replyText: string) {
  const orig = platform.secrets.get;
  platform.secrets.get = async (name?: string) =>
    name === "google-api-key" ? "test-key" : orig(name);
  (globalThis as any).fetch = async () =>
    new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ text: replyText }] } }],
      usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 7 },
    }), { status: 200, headers: { "content-type": "application/json" } });
}

test("POST /api/nutritionist strips the trailer from reply and returns a validated plan_change", async () => {
  const orig = (globalThis as any).fetch;
  try {
    const { req, platform } = client();
    stubGemini(platform,
      "Sure — I'll move you to 1,800 kcal with more protein.\n" +
      '<<PLAN_CHANGE>>{"goal_kcal":1800,"method":"protein"}');
    const res = await req("/api/nutritionist", { method: "POST", body: JSON.stringify({ mode: "chat", message: "bump me to 1800 with more protein" }) });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.reply, "Sure — I'll move you to 1,800 kcal with more protein.");
    assert.doesNotMatch(body.reply, /<<PLAN_CHANGE>>/);
    assert.doesNotMatch(body.reply, /goal_kcal/); // no raw JSON leaks to the client
    assert.deepEqual(body.plan_change, { goal_kcal: 1800, method: "protein" });
  } finally { (globalThis as any).fetch = orig; }
});

test("POST /api/nutritionist drops invalid fields; an all-invalid trailer → plan_change null", async () => {
  const orig = (globalThis as any).fetch;
  try {
    const { req, platform } = client();
    stubGemini(platform, 'Ok.\n<<PLAN_CHANGE>>{"method":"bogus","activity_level":"lazy"}');
    const res = await req("/api/nutritionist", { method: "POST", body: JSON.stringify({ mode: "chat", message: "x" }) });
    const body = await res.json();
    assert.equal(body.reply, "Ok.");
    assert.equal(body.plan_change, null); // nothing valid remained
  } finally { (globalThis as any).fetch = orig; }
});

test("POST /api/nutritionist keeps valid fields and drops invalid ones in a MIXED trailer", async () => {
  const orig = (globalThis as any).fetch;
  try {
    const { req, platform } = client();
    // One valid (goal_kcal), one invalid (method:"bogus"), one valid (activity_level:"active").
    stubGemini(platform, 'Ok.\n<<PLAN_CHANGE>>{"goal_kcal":1900,"method":"bogus","activity_level":"active"}');
    const res = await req("/api/nutritionist", { method: "POST", body: JSON.stringify({ mode: "chat", message: "x" }) });
    const body = await res.json();
    assert.equal(body.reply, "Ok.");
    // The bad method is dropped; the two valid fields survive — a partial, sanitized change.
    assert.deepEqual(body.plan_change, { goal_kcal: 1900, activity_level: "active" });
  } finally { (globalThis as any).fetch = orig; }
});

test("POST /api/nutritionist with no trailer returns plan_change null and a clean reply", async () => {
  const orig = (globalThis as any).fetch;
  try {
    const { req, platform } = client();
    stubGemini(platform, "Here is some general advice.");
    const res = await req("/api/nutritionist", { method: "POST", body: JSON.stringify({ mode: "chat", message: "hi" }) });
    const body = await res.json();
    assert.equal(body.reply, "Here is some general advice.");
    assert.equal(body.plan_change, null);
  } finally { (globalThis as any).fetch = orig; }
});

// Seed a profile with real stats so computePlan produces meaningful numbers (no AI needed here).
async function seedProfile(platform: any, extra: Record<string, unknown> = {}) {
  const store = platform.data.forUser(TEST_EMAIL);
  await store.create("profiles", {
    user: TEST_EMAIL, email: TEST_EMAIL,
    body_weight_kg: 90, height_cm: 180, age: 40, sex: "male",
    activity_level: "sedentary", method: "calories",
    ...extra,
  }, TEST_EMAIL);
}

test("POST /api/plan/apply re-runs the engine for an explicit goal_kcal (macros derived, NOT echoed)", async () => {
  const { req, platform } = client();
  await seedProfile(platform);
  // Smuggle bogus macro fields in the request to PROVE the engine is authoritative: the route must
  // IGNORE these and derive every macro from macroTargets(1800,"protein",90) — never echo the request.
  const res = await req("/api/plan/apply", { method: "POST", body: JSON.stringify({ goal_kcal: 1800, method: "protein", protein: 999, carbs: 999, fat: 999, sodium: 9999 }) });
  assert.equal(res.status, 200);
  const body = await res.json();
  // The engine honored the explicit kcal and DERIVED the EXACT macros — macroTargets(1800,"protein",90)
  // = {protein:180, carbs:149, fat:54, sodium:2300} — not the request's 999s.
  assert.deepEqual(body.goals, { kcal: 1800, protein: 180, carbs: 149, fat: 54, sodium: 2300 });
  assert.equal(body.plan.targets.kcal, 1800);
  assert.ok(body.plan_summary && /1,?800/.test(body.plan_summary));
  // Persisted: GET /api/me reflects the ENGINE'S goals (protein 180, not 999) + method + plan_summary.
  const me = await (await req("/api/me?tz=0")).json();
  assert.equal(me.goals.kcal, 1800);
  assert.equal(me.goals.protein, 180);
  assert.equal(me.track_mode, "protein");
  assert.equal(me.plan_summary, body.plan_summary);
});

test("POST /api/plan/apply with a weight_goal recomputes the deficit AND persists the goal", async () => {
  const { req, platform } = client();
  await seedProfile(platform);
  // Maintenance kcal (a no-op valid change, no weight goal) as the comparison baseline.
  const maint = (await (await req("/api/plan/apply", { method: "POST", body: JSON.stringify({ activity_level: "sedentary" }) })).json()).goals.kcal;
  const res = await req("/api/plan/apply", {
    method: "POST",
    body: JSON.stringify({ weight_goal: { target_lb: 180, target_date: "2027-01-01" } }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  // 198→180 lb loss by the deadline ⇒ a real deficit ⇒ target must be BELOW maintenance, not just >0.
  assert.ok(body.goals.kcal > 0 && body.goals.kcal < maint, `deficit target ${body.goals.kcal} should be < maintenance ${maint}`);
  // The weight goal landed in the same collection POST /api/weight/goals writes.
  const wg = await (await req("/api/weight/goals")).json();
  assert.equal(wg.goals.length, 1);
  assert.equal(Math.round(wg.goals[0].target_lb), 180);
});

test("POST /api/plan/apply changes activity_level and re-derives calories", async () => {
  const { req, platform } = client();
  await seedProfile(platform);
  const before = (await (await req("/api/plan/apply", { method: "POST", body: JSON.stringify({ activity_level: "sedentary" }) })).json()).goals.kcal;
  const after = (await (await req("/api/plan/apply", { method: "POST", body: JSON.stringify({ activity_level: "athlete" }) })).json()).goals.kcal;
  assert.ok(after > before, "a higher activity level raises maintenance calories");
  const me = await (await req("/api/me?tz=0")).json();
  assert.equal(me.activity_level, "athlete");
});

test("POST /api/plan/apply 400s an empty/all-invalid change", async () => {
  const { req, platform } = client();
  await seedProfile(platform);
  assert.equal((await req("/api/plan/apply", { method: "POST", body: JSON.stringify({}) })).status, 400);
  assert.equal((await req("/api/plan/apply", { method: "POST", body: JSON.stringify({ method: "bogus" }) })).status, 400);
});

test("POST /api/plan/apply clamps a dangerous goal_kcal to the safety floor", async () => {
  const { req, platform } = client();
  await seedProfile(platform); // male → floor 1500
  const body = await (await req("/api/plan/apply", { method: "POST", body: JSON.stringify({ goal_kcal: 200 }) })).json();
  assert.equal(body.goals.kcal, 1500);
});
