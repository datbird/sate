// Sate core — provider adapters. Map a normalized request onto each vendor's REST API via `fetch`
// (no SDKs). Ported from PocketBase pb_hooks/providers.js ($http.send → fetch). Every runX returns
// { text, input, output } — input/output are token counts for usage/limits.

export type ProviderName = "anthropic" | "openai" | "google" | "openrouter";

export interface AIMessage {
  role: "user" | "assistant";
  text: string;
}
export interface AIImage {
  mimeType: string;
  data: string; // base64
}
export interface AIRequest {
  provider: ProviderName;
  apiKey: string;
  baseUrl?: string;
  model: string;
  system?: string;
  messages: AIMessage[];
  image?: AIImage;
  jsonMode?: boolean;
  webSearch?: boolean;
}
export interface AIResult {
  text: string;
  input: number;
  output: number;
}
export interface ModelInfo {
  id: string;
  label: string;
  vision: boolean;
}

const TIMEOUT = 120;
const WEB_TIMEOUT = 180;
const MAX_TOKENS = 2048;

function lastUserIndex(messages: AIMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i]!.role === "user") return i;
  return -1;
}

interface HttpResult {
  status: number;
  json: any;
  text: string;
}
async function http(url: string, init: RequestInit, timeoutSec: number): Promise<HttpResult> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutSec * 1000) });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* non-JSON body left as null */
  }
  return { status: res.status, json, text };
}

function fail(provider: string, r: HttpResult): never {
  const detail = r.text || JSON.stringify(r.json);
  throw new Error(`${provider} API error ${r.status}: ${String(detail).slice(0, 500)}`);
}

// ---------------------------------------------------------------- Anthropic
async function runAnthropic(req: AIRequest): Promise<AIResult> {
  const imgIdx = req.image ? lastUserIndex(req.messages) : -1;
  const messages = req.messages.map((m, i) => {
    const content: any[] = [{ type: "text", text: m.text }];
    if (i === imgIdx && req.image) {
      content.unshift({ type: "image", source: { type: "base64", media_type: req.image.mimeType, data: req.image.data } });
    }
    return { role: m.role, content };
  });
  const r = await http(
    (req.baseUrl || "https://api.anthropic.com") + "/v1/messages",
    {
      method: "POST",
      headers: { "x-api-key": req.apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({
        model: req.model,
        max_tokens: req.webSearch ? 4096 : MAX_TOKENS,
        system: req.system || undefined,
        messages,
        tools: req.webSearch ? [{ type: "web_search_20250305", name: "web_search", max_uses: 5 }] : undefined,
      }),
    },
    req.webSearch ? WEB_TIMEOUT : TIMEOUT,
  );
  if (r.status >= 300) fail("anthropic", r);
  const parts = ((r.json.content as any[]) || []).filter((c) => c.type === "text").map((c) => c.text);
  const u = r.json.usage || {};
  return { text: parts.join("\n").trim(), input: u.input_tokens || 0, output: u.output_tokens || 0 };
}

// ------------------------------------------------------------------- OpenAI
async function runOpenAI(req: AIRequest): Promise<AIResult> {
  const imgIdx = req.image ? lastUserIndex(req.messages) : -1;
  const messages: any[] = [];
  if (req.system) messages.push({ role: "system", content: req.system });
  req.messages.forEach((m, i) => {
    if (i === imgIdx && req.image) {
      messages.push({
        role: "user",
        content: [
          { type: "text", text: m.text },
          { type: "image_url", image_url: { url: `data:${req.image.mimeType};base64,${req.image.data}` } },
        ],
      });
    } else {
      messages.push({ role: m.role, content: m.text });
    }
  });
  if (req.webSearch) {
    throw new Error("web search isn't supported for the OpenAI provider — assign Web lookup to Google or Anthropic.");
  }
  const body: any = { model: req.model, messages };
  if (req.jsonMode) body.response_format = { type: "json_object" };
  const r = await http(
    (req.baseUrl || "https://api.openai.com/v1") + "/chat/completions",
    { method: "POST", headers: { Authorization: "Bearer " + req.apiKey, "content-type": "application/json" }, body: JSON.stringify(body) },
    TIMEOUT,
  );
  if (r.status >= 300) fail("openai", r);
  const u = r.json.usage || {};
  return { text: (r.json.choices?.[0]?.message?.content || "").trim(), input: u.prompt_tokens || 0, output: u.completion_tokens || 0 };
}

// ------------------------------------------------------------------- Google
async function runGoogle(req: AIRequest): Promise<AIResult> {
  const imgIdx = req.image ? lastUserIndex(req.messages) : -1;
  const contents = req.messages.map((m, i) => {
    const parts: any[] = [{ text: m.text }];
    if (i === imgIdx && req.image) parts.push({ inlineData: { mimeType: req.image.mimeType, data: req.image.data } });
    return { role: m.role === "assistant" ? "model" : "user", parts };
  });
  const generationConfig: any = {};
  if (req.jsonMode && !req.webSearch) generationConfig.responseMimeType = "application/json";
  const base = req.baseUrl || "https://generativelanguage.googleapis.com";
  const r = await http(
    `${base}/v1beta/models/${req.model}:generateContent`,
    {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": req.apiKey },
      body: JSON.stringify({
        systemInstruction: req.system ? { parts: [{ text: req.system }] } : undefined,
        contents,
        generationConfig,
        tools: req.webSearch ? [{ google_search: {} }] : undefined,
      }),
    },
    req.webSearch ? WEB_TIMEOUT : TIMEOUT,
  );
  if (r.status >= 300) fail("google", r);
  const cand = (r.json.candidates || [])[0];
  const parts = cand?.content?.parts ?? [];
  const u = r.json.usageMetadata || {};
  return {
    text: parts.map((p: any) => p.text || "").join("").trim(),
    input: u.promptTokenCount || 0,
    output: u.candidatesTokenCount || 0,
  };
}

export async function runProvider(req: AIRequest): Promise<AIResult> {
  switch (req.provider) {
    case "anthropic":
      return runAnthropic(req);
    case "openai":
      return runOpenAI(req);
    case "google":
      return runGoogle(req);
    case "openrouter":
      return runOpenAI({ ...req, baseUrl: req.baseUrl || "https://openrouter.ai/api/v1" });
    default:
      throw new Error("unknown provider: " + (req as AIRequest).provider);
  }
}

// -------------------------------------------------------- live model listing
export async function listModels(req: { provider: ProviderName; apiKey: string; baseUrl?: string }): Promise<ModelInfo[]> {
  if (req.provider === "anthropic") {
    const r = await http((req.baseUrl || "https://api.anthropic.com") + "/v1/models?limit=1000", { method: "GET", headers: { "x-api-key": req.apiKey, "anthropic-version": "2023-06-01" } }, 30);
    if (r.status >= 300) fail("anthropic", r);
    return ((r.json.data as any[]) || []).map((m) => ({ id: m.id, label: m.display_name || m.id, vision: true }));
  }
  if (req.provider === "openai" || req.provider === "openrouter") {
    const base = req.baseUrl || (req.provider === "openrouter" ? "https://openrouter.ai/api/v1" : "https://api.openai.com/v1");
    const r = await http(base + "/models", { method: "GET", headers: req.apiKey ? { Authorization: "Bearer " + req.apiKey } : {} }, 30);
    if (r.status >= 300) fail(req.provider, r);
    if (req.provider === "openrouter") {
      return ((r.json.data as any[]) || [])
        .map((m) => {
          const arch = m.architecture || {};
          const mods: string[] = arch.input_modalities || (arch.modality ? String(arch.modality).split("+") : []);
          return { id: m.id, label: m.name || m.id, vision: mods.indexOf("image") !== -1 };
        })
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    }
    const skip = /audio|realtime|transcribe|tts|image|dall-e|embedding|moderation|whisper|search/;
    const chat = /^(gpt-|o1|o3|o4|chatgpt)/;
    return ((r.json.data as any[]) || [])
      .map((m) => m.id as string)
      .filter((id) => chat.test(id) && !skip.test(id))
      .sort()
      .map((id) => ({ id, label: id, vision: /gpt-4o|gpt-4\.1|gpt-5|o1|o3|o4|chatgpt/.test(id) }));
  }
  if (req.provider === "google") {
    const base = req.baseUrl || "https://generativelanguage.googleapis.com";
    const r = await http(base + "/v1beta/models?pageSize=1000", { method: "GET", headers: { "x-goog-api-key": req.apiKey } }, 30);
    if (r.status >= 300) fail("google", r);
    const skip = /embedding|aqa|tts|image-generation|image|robotics|lyria|deep-research|computer-use|omni/;
    return ((r.json.models as any[]) || [])
      .filter((m) => (m.supportedGenerationMethods || []).indexOf("generateContent") !== -1)
      .map((m) => (m.name as string).replace("models/", ""))
      .filter((n) => !skip.test(n))
      .map((id) => ({ id, label: id, vision: true }));
  }
  throw new Error("unknown provider: " + req.provider);
}
