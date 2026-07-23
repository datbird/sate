// Sate core — AI orchestration. callAI is the single funnel every AI request goes through, so key
// resolution (Secrets port), limit enforcement, and usage accounting are uniform on every platform.

import type { Platform } from "../ports";
import { runProvider, type AIResult, type ProviderName, type AIMessage, type AIImage } from "./providers";
import {
  PROMPTS,
  parseJSON,
  normalizeNutrition,
  normalizeActivity,
  type AIFunction,
  type NutritionResult,
  type ActivityResult,
} from "./prompts";
import { checkLimit, recordUsage } from "./usage";

export * from "./providers";
export * from "./prompts";
export { recordUsage, checkLimit, monthIO } from "./usage";

export interface CallOptions {
  provider: ProviderName;
  model: string;
  /** Omit to resolve from the Secrets port as "<provider>-api-key". */
  apiKey?: string;
  system?: string;
  messages: AIMessage[];
  image?: AIImage;
  jsonMode?: boolean;
  webSearch?: boolean;
  /** Default true — set false to skip per-provider cap enforcement for this call. */
  enforceLimits?: boolean;
}

export async function callAI(platform: Platform, opts: CallOptions): Promise<AIResult> {
  const apiKey = opts.apiKey || (await platform.secrets.get(`${opts.provider}-api-key`));
  if (!apiKey) throw new Error(`no API key for provider "${opts.provider}" (set secret ${opts.provider}-api-key)`);
  const store = platform.data.instance();
  if (opts.enforceLimits !== false) await checkLimit(store, opts.provider, opts.model);
  const result = await runProvider({
    provider: opts.provider,
    apiKey,
    model: opts.model,
    system: opts.system,
    messages: opts.messages,
    image: opts.image,
    jsonMode: opts.jsonMode,
    webSearch: opts.webSearch,
  });
  await recordUsage(store, opts.provider, opts.model, result.input, result.output);
  return result;
}

export interface EstimateInput {
  provider: ProviderName;
  model: string;
  apiKey?: string;
  text?: string;
  image?: AIImage;
  /** Optional "Known foods from the database" grounding block. */
  known?: string;
}

// text_parse (text) / vision_estimate (photo) → normalized nutrition.
export async function estimateNutrition(platform: Platform, inp: EstimateInput): Promise<NutritionResult> {
  const fn: AIFunction = inp.image ? "vision_estimate" : "text_parse";
  const p = PROMPTS[fn];
  const text = (inp.text || "") + (inp.known ? `\n\nKnown foods from the database:\n${inp.known}` : "");
  const res = await callAI(platform, {
    provider: inp.provider,
    model: inp.model,
    apiKey: inp.apiKey,
    system: p.system,
    jsonMode: p.jsonMode,
    messages: [{ role: "user", text: text || "(no description)" }],
    image: inp.image,
  });
  return normalizeNutrition(parseJSON(res.text));
}

// activity_estimate → normalized activity burn.
export async function estimateActivity(platform: Platform, inp: EstimateInput): Promise<ActivityResult> {
  const p = PROMPTS.activity_estimate;
  const res = await callAI(platform, {
    provider: inp.provider,
    model: inp.model,
    apiKey: inp.apiKey,
    system: p.system,
    jsonMode: p.jsonMode,
    messages: [{ role: "user", text: inp.text || "(no description)" }],
  });
  return normalizeActivity(parseJSON(res.text));
}

// ---- default provider/model resolution (Phase 1) ------------------------
// v1 resolved provider+model per function+user+role (fn_overrides → function_config → global default)
// AND decrypted per-provider keys from the DB. Phase 1 uses ONE instance-wide default (from the
// `settings` key/value collection, falling back to Google) and the Secrets port for the key (callAI
// resolves `<provider>-api-key`). TODO(phase2): restore per-function pickModel + second-opinion role.
const DEFAULT_PROVIDER: ProviderName = "google";
// Standard model = "Latest Flash": Google's rolling alias that always points at the newest 2.x Flash,
// so the app tracks model upgrades without a redeploy. The "second opinion" deliberately runs a
// STRONGER, different model — "Latest Pro" — otherwise a second opinion just re-runs the same model
// and tells you nothing. Both are settable per-instance (default_*_model in the settings collection);
// on Cloud, which exposes no AI admin, these built-in defaults are the effective config.
const DEFAULT_MODEL = "gemini-flash-latest";
const DEFAULT_SECOND_MODEL = "gemini-pro-latest";

export async function resolveDefaultModel(
  platform: Platform,
  category: "ai" | "vision" | "second" = "ai",
): Promise<{ provider: ProviderName; model: string }> {
  let provider: ProviderName = DEFAULT_PROVIDER;
  let model = category === "second" ? DEFAULT_SECOND_MODEL : DEFAULT_MODEL;
  try {
    const { items } = await platform.data
      .instance()
      .list<{ id: string; key: string; value: string }>("settings", { limit: 500 });
    const s: Record<string, string> = {};
    for (const r of items) s[r.key] = r.value;
    const p =
      category === "vision" ? s.default_vision_provider
      : category === "second" ? s.default_second_provider
      : s.default_ai_provider;
    const m =
      category === "vision" ? s.default_vision_model
      : category === "second" ? s.default_second_model
      : s.default_ai_model;
    if (p) provider = p as ProviderName;
    if (m) model = m;
  } catch {
    /* no settings collection ⇒ built-in defaults */
  }
  return { provider, model };
}

// ---- daily_summary → a short friendly recap of a day's food entries -----
// `ctx` is the caller-built grounding string (the day's entries + the user's goals/method).
export async function dailySummary(platform: Platform, ctx: string): Promise<string> {
  const { provider, model } = await resolveDefaultModel(platform, "ai");
  const p = PROMPTS.daily_summary;
  const res = await callAI(platform, {
    provider,
    model,
    system: p.system,
    jsonMode: p.jsonMode,
    messages: [{ role: "user", text: ctx || "(no entries)" }],
  });
  return res.text;
}

// ---- web_lookup → web-grounded nutrition for a food not in the local DB --
// `sources` is the optional "Preferred sources" hint block. Web search + forced-JSON can't be
// combined, so jsonMode is off and the reply is parsed defensively.
export async function webLookup(
  platform: Platform,
  query: string,
  sources?: string,
  category: "ai" | "second" = "ai",
): Promise<NutritionResult> {
  const { provider, model } = await resolveDefaultModel(platform, category);
  const p = PROMPTS.web_lookup;
  const userMsg = (sources ? sources + "\n\n" : "") + "Food/meal to research and estimate:\n" + query;
  const res = await callAI(platform, {
    provider,
    model,
    system: p.system,
    jsonMode: false,
    webSearch: true,
    messages: [{ role: "user", text: userMsg }],
  });
  return normalizeNutrition(parseJSON(res.text));
}

// ---- nutritionist → the AI coach (plan | chat, optional photo) -----------
export interface NutritionistInput {
  mode: "plan" | "chat";
  /** The deterministic-plan grounding block (nutrition.contextText). */
  context: string;
  /** Current user message (chat mode). Ignored in plan mode. */
  message?: string;
  /** Prior conversation turns (most-recent-last); the last 20 are replayed. */
  history?: AIMessage[];
  /** A menu/plate/product photo to discuss (NOT logged). */
  image?: AIImage;
  /** TODO(phase2): "second" selects the second-opinion model; Phase 1 always uses the default. */
  role?: "primary" | "second";
}

export async function nutritionist(platform: Platform, inp: NutritionistInput): Promise<string> {
  const { provider, model } = await resolveDefaultModel(platform, inp.image ? "vision" : "ai");
  const p = PROMPTS.nutritionist;
  const userMsg =
    inp.mode === "chat"
      ? (inp.message || "").trim() ||
        (inp.image ? "What can you tell me about this?" : "How am I doing toward my goals?")
      : "Give me my starting plan: the weekly rate and specific daily calorie + macro targets to reach " +
        "my goal(s), flag anything unrealistic with a concrete realistic alternative, and 2-3 first steps.";
  const messages: AIMessage[] = [
    { role: "user", text: "CONTEXT (my current stats, goals, and recent intake):\n" + inp.context },
    { role: "assistant", text: "Got it — I have your stats, goals, and recent intake in mind." },
  ];
  for (const h of (inp.history || []).slice(-20)) {
    if (h && (h.role === "user" || h.role === "assistant") && typeof h.text === "string" && h.text.trim()) {
      messages.push({ role: h.role, text: h.text });
    }
  }
  messages.push({ role: "user", text: userMsg });
  const res = await callAI(platform, {
    provider,
    model,
    system: p.system,
    jsonMode: false,
    messages,
    image: inp.image,
  });
  return res.text;
}

// ---- checkin → decide whether a proactive check-in is worthwhile ---------
export interface CheckinDecision {
  worthwhile: boolean;
  topic: string;
  message: string;
}

export async function checkinDecide(platform: Platform, ctx: string): Promise<CheckinDecision> {
  const { provider, model } = await resolveDefaultModel(platform, "ai");
  const p = PROMPTS.checkin;
  const res = await callAI(platform, {
    provider,
    model,
    system: p.system,
    jsonMode: p.jsonMode,
    messages: [{ role: "user", text: "CONTEXT:\n" + ctx }],
  });
  const obj = parseJSON(res.text) as Partial<CheckinDecision>;
  return {
    worthwhile: !!obj.worthwhile,
    topic: String(obj.topic || ""),
    message: String(obj.message || ""),
  };
}
