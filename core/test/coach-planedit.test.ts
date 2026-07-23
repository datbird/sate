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
