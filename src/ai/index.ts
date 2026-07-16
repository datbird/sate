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
