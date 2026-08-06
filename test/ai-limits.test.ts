import { test } from "node:test";
import assert from "node:assert/strict";
import { checkLimit } from "../src/ai/usage.ts";
import { MemStore } from "./mem.ts";

// AI spend caps are the guardrail that has to hold when everything else is wrong, so the interesting
// cases are the ones where the cap LOOKS enforced but isn't. A dollar budget is computed from
// `ai_prices`; usage on a model with no price row used to contribute $0, so the budget sat at
// "$0.00 spent" forever while the calls billed. That reads as protection and is the opposite.

const month = () => new Date().toISOString().slice(0, 7); // usage rows are keyed by UTC day
const day = (n = 1) => `${month()}-${String(n).padStart(2, "0")}`;

function store(opts: {
  limit?: Record<string, unknown>;
  usage?: { model: string; input: number; output: number }[];
  prices?: { model: string; in_usd: number; out_usd: number }[];
}) {
  const s = new MemStore();
  if (opts.limit) s.create("ai_limits", { provider: "google", ...opts.limit });
  for (const [i, u] of (opts.usage ?? []).entries())
    s.create("ai_usage", { provider: "google", model: u.model, day: day(i + 1), calls: 1,
      input_tokens: u.input, output_tokens: u.output });
  for (const p of opts.prices ?? []) s.create("ai_prices", { provider: "google", ...p });
  return s as never;
}
const rejects = async (s: unknown, re: RegExp) =>
  assert.rejects(() => checkLimit(s as never, "google", "gemini-2.5-flash"), re);

// ---------------------------------------------------------------- token caps (the reliable ones)

test("no limit row at all ⇒ nothing to enforce, the call proceeds", async () => {
  await checkLimit(store({ usage: [{ model: "m", input: 9e9, output: 9e9 }] }), "google", "m");
});

test("monthly token cap throws once met", async () => {
  const s = store({ limit: { monthly_tokens: 1000 }, usage: [{ model: "m", input: 600, output: 400 }] });
  await rejects(s, /monthly token limit reached \(1000\/1000\)/);
});

test("monthly token cap allows the call while under", async () => {
  const s = store({ limit: { monthly_tokens: 1000 }, usage: [{ model: "m", input: 600, output: 399 }] });
  await checkLimit(s, "google", "m");
});

// ---------------------------------------------------------------- the $ budget must fail CLOSED

test("a $ budget with NO price row for the used model refuses instead of billing free", async () => {
  const s = store({
    limit: { usd_budget: 10 },
    usage: [{ model: "gemini-2.5-flash", input: 5_000_000, output: 5_000_000 }],
    prices: [], // the trap: empty ai_prices while a budget is set
  });
  await rejects(s, /no price for gemini-2\.5-flash/);
});

test("the refusal names EVERY unpriced model, so one fix round clears it", async () => {
  const s = store({
    limit: { usd_budget: 10 },
    usage: [{ model: "gemini-2.5-flash", input: 1000, output: 1000 },
            { model: "gemini-2.5-pro", input: 1000, output: 1000 }],
    prices: [{ model: "gemini-2.5-flash", in_usd: 0.3, out_usd: 2.5 }],
  });
  await rejects(s, /no price for gemini-2\.5-pro/);
});

test("zero-token rows for an unpriced model do not trip it (nothing was billed)", async () => {
  const s = store({
    limit: { usd_budget: 10 },
    usage: [{ model: "never-called", input: 0, output: 0 },
            { model: "gemini-2.5-flash", input: 1000, output: 1000 }],
    prices: [{ model: "gemini-2.5-flash", in_usd: 0.3, out_usd: 2.5 }],
  });
  await checkLimit(s, "google", "gemini-2.5-flash");
});

test("fully priced usage under budget proceeds; over budget throws with the real figure", async () => {
  const priced = { model: "gemini-2.5-flash", in_usd: 1, out_usd: 1 }; // $1 per 1M tokens each way
  const under = store({ limit: { usd_budget: 10 }, prices: [priced],
    usage: [{ model: "gemini-2.5-flash", input: 1_000_000, output: 1_000_000 }] }); // $2.00
  await checkLimit(under, "google", "gemini-2.5-flash");

  const over = store({ limit: { usd_budget: 10 }, prices: [priced],
    usage: [{ model: "gemini-2.5-flash", input: 6_000_000, output: 6_000_000 }] }); // $12.00
  await rejects(over, /monthly budget reached \(\$12\.00\/\$10\.00\)/);
});

test("NO $ budget ⇒ missing prices are irrelevant and never block a call", async () => {
  // The token cap is the everyday guard; unpriced models must not break it.
  const s = store({ limit: { monthly_tokens: 3_000_000 },
    usage: [{ model: "brand-new-model", input: 10, output: 10 }], prices: [] });
  await checkLimit(s, "google", "brand-new-model");
});
