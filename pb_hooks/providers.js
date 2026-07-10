/// <reference path="../pb_data/types.d.ts" />

// Provider adapters. Each maps a normalized request onto a vendor REST API via $http.send
// and returns the model's text output as a string. No vendor SDKs — keeps the PocketBase
// binary self-contained.
//
// Normalized request:
//   {
//     provider: "anthropic" | "openai" | "google",
//     apiKey:   "<decrypted key>",
//     baseUrl:  "<optional override>",
//     model:    "<model id>",
//     system:   "<system prompt>",
//     messages: [ { role: "user"|"assistant", text: "..." }, ... ],
//     image:    { mimeType, data }   // optional base64 image, attached to the last user turn
//     jsonMode: true|false           // ask the model for strict JSON
//   }

const TIMEOUT = 120;
const WEB_TIMEOUT = 180; // web search adds round-trips
const MAX_TOKENS = 2048;

function lastUserIndex(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") return i;
  }
  return -1;
}

function fail(provider, res) {
  let detail = "";
  try {
    detail = typeof res.body === "string" ? res.body : JSON.stringify(res.json);
  } catch (_) {}
  throw new Error(`${provider} API error ${res.statusCode}: ${String(detail).slice(0, 500)}`);
}

// ---------------------------------------------------------------- Anthropic
function runAnthropic(req) {
  const imgIdx = req.image ? lastUserIndex(req.messages) : -1;
  const messages = req.messages.map((m, i) => {
    const content = [{ type: "text", text: m.text }];
    if (i === imgIdx) {
      content.unshift({
        type: "image",
        source: { type: "base64", media_type: req.image.mimeType, data: req.image.data },
      });
    }
    return { role: m.role, content: content };
  });

  const res = $http.send({
    url: (req.baseUrl || "https://api.anthropic.com") + "/v1/messages",
    method: "POST",
    headers: {
      "x-api-key": req.apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: req.model,
      max_tokens: req.webSearch ? 4096 : MAX_TOKENS,
      system: req.system || undefined,
      messages: messages,
      // Web search server tool (basic variant — widely supported across Claude models).
      tools: req.webSearch ? [{ type: "web_search_20250305", name: "web_search", max_uses: 5 }] : undefined,
    }),
    timeout: req.webSearch ? WEB_TIMEOUT : TIMEOUT,
  });
  if (res.statusCode >= 300) fail("anthropic", res);

  const parts = (res.json.content || []).filter((c) => c.type === "text").map((c) => c.text);
  const u = res.json.usage || {};
  return { text: parts.join("\n").trim(), input: u.input_tokens || 0, output: u.output_tokens || 0 };
}

// ------------------------------------------------------------------- OpenAI
function runOpenAI(req) {
  const imgIdx = req.image ? lastUserIndex(req.messages) : -1;
  const messages = [];
  if (req.system) messages.push({ role: "system", content: req.system });
  req.messages.forEach((m, i) => {
    if (i === imgIdx) {
      messages.push({
        role: "user",
        content: [
          { type: "text", text: m.text },
          {
            type: "image_url",
            image_url: { url: `data:${req.image.mimeType};base64,${req.image.data}` },
          },
        ],
      });
    } else {
      messages.push({ role: m.role, content: m.text });
    }
  });

  if (req.webSearch) {
    throw new Error(
      "web search isn't supported for the OpenAI provider in this build — " +
        "assign the Web lookup function to Google or Anthropic."
    );
  }

  const body = { model: req.model, messages: messages };
  if (req.jsonMode) body.response_format = { type: "json_object" };

  const res = $http.send({
    url: (req.baseUrl || "https://api.openai.com/v1") + "/chat/completions",
    method: "POST",
    headers: {
      Authorization: "Bearer " + req.apiKey,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
    timeout: TIMEOUT,
  });
  if (res.statusCode >= 300) fail("openai", res);

  const u = res.json.usage || {};
  return {
    text: (res.json.choices[0].message.content || "").trim(),
    input: u.prompt_tokens || 0,
    output: u.completion_tokens || 0,
  };
}

// ------------------------------------------------------------------- Google
function runGoogle(req) {
  const imgIdx = req.image ? lastUserIndex(req.messages) : -1;
  const contents = req.messages.map((m, i) => {
    const parts = [{ text: m.text }];
    if (i === imgIdx) {
      parts.push({ inlineData: { mimeType: req.image.mimeType, data: req.image.data } });
    }
    return { role: m.role === "assistant" ? "model" : "user", parts: parts };
  });

  const generationConfig = {};
  // JSON response mime can't be combined with the search-grounding tool.
  if (req.jsonMode && !req.webSearch) generationConfig.responseMimeType = "application/json";

  const base = req.baseUrl || "https://generativelanguage.googleapis.com";
  const res = $http.send({
    url: `${base}/v1beta/models/${req.model}:generateContent?key=${encodeURIComponent(req.apiKey)}`,
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      systemInstruction: req.system ? { parts: [{ text: req.system }] } : undefined,
      contents: contents,
      generationConfig: generationConfig,
      tools: req.webSearch ? [{ google_search: {} }] : undefined,
    }),
    timeout: req.webSearch ? WEB_TIMEOUT : TIMEOUT,
  });
  if (res.statusCode >= 300) fail("google", res);

  const cand = (res.json.candidates || [])[0];
  const parts = cand && cand.content && cand.content.parts ? cand.content.parts : [];
  const u = res.json.usageMetadata || {};
  return {
    text: parts.map((p) => p.text || "").join("").trim(),
    input: u.promptTokenCount || 0,
    output: u.candidatesTokenCount || 0,
  };
}

// Every runX returns { text, input, output } — input/output are token counts for usage/limits.
function runProvider(req) {
  switch (req.provider) {
    case "anthropic":
      return runAnthropic(req);
    case "openai":
      return runOpenAI(req);
    case "google":
      return runGoogle(req);
    case "openrouter":
      // OpenRouter is OpenAI-compatible; just point the base at their gateway.
      if (!req.baseUrl) req.baseUrl = "https://openrouter.ai/api/v1";
      return runOpenAI(req);
    default:
      throw new Error("unknown provider: " + req.provider);
  }
}

// -------------------------------------------------------- live model listing
// Returns [{ id, label, vision }] for the admin model pickers. req = {provider, apiKey, baseUrl}.

function listModels(req) {
  if (req.provider === "anthropic") {
    const res = $http.send({
      url: (req.baseUrl || "https://api.anthropic.com") + "/v1/models?limit=1000",
      method: "GET",
      headers: { "x-api-key": req.apiKey, "anthropic-version": "2023-06-01" },
      timeout: 30,
    });
    if (res.statusCode >= 300) fail("anthropic", res);
    // All current Claude models are multimodal.
    return (res.json.data || []).map((m) => ({ id: m.id, label: m.display_name || m.id, vision: true }));
  }

  if (req.provider === "openai") {
    const res = $http.send({
      url: (req.baseUrl || "https://api.openai.com/v1") + "/models",
      method: "GET",
      headers: { Authorization: "Bearer " + req.apiKey },
      timeout: 30,
    });
    if (res.statusCode >= 300) fail("openai", res);
    const skip = /audio|realtime|transcribe|tts|image|dall-e|embedding|moderation|whisper|search/;
    const chat = /^(gpt-|o1|o3|o4|chatgpt)/;
    return (res.json.data || [])
      .map((m) => m.id)
      .filter((id) => chat.test(id) && !skip.test(id))
      .sort()
      .map((id) => ({ id: id, label: id, vision: /gpt-4o|gpt-4\.1|gpt-5|o1|o3|o4|chatgpt/.test(id) }));
  }

  if (req.provider === "google") {
    const base = req.baseUrl || "https://generativelanguage.googleapis.com";
    const res = $http.send({
      url: base + "/v1beta/models?key=" + encodeURIComponent(req.apiKey) + "&pageSize=1000",
      method: "GET",
      headers: {},
      timeout: 30,
    });
    if (res.statusCode >= 300) fail("google", res);
    const skip = /embedding|aqa|tts|image-generation|image|robotics|lyria|deep-research|computer-use|omni/;
    return (res.json.models || [])
      .filter((m) => (m.supportedGenerationMethods || []).indexOf("generateContent") !== -1)
      .map((m) => m.name.replace("models/", ""))
      .filter((n) => !skip.test(n))
      .map((id) => ({ id: id, label: id, vision: true }));
  }

  if (req.provider === "openrouter") {
    const res = $http.send({
      url: (req.baseUrl || "https://openrouter.ai/api/v1") + "/models",
      method: "GET",
      headers: req.apiKey ? { Authorization: "Bearer " + req.apiKey } : {},
      timeout: 30,
    });
    if (res.statusCode >= 300) fail("openrouter", res);
    return (res.json.data || [])
      .map((m) => {
        const arch = m.architecture || {};
        const mods = arch.input_modalities || (arch.modality ? String(arch.modality).split("+") : []);
        return { id: m.id, label: m.name || m.id, vision: (mods || []).indexOf("image") !== -1 };
      })
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  throw new Error("unknown provider: " + req.provider);
}

module.exports = { runProvider, listModels };
