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
      max_tokens: MAX_TOKENS,
      system: req.system || undefined,
      messages: messages,
    }),
    timeout: TIMEOUT,
  });
  if (res.statusCode >= 300) fail("anthropic", res);

  const parts = (res.json.content || []).filter((c) => c.type === "text").map((c) => c.text);
  return parts.join("\n").trim();
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

  return (res.json.choices[0].message.content || "").trim();
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
  if (req.jsonMode) generationConfig.responseMimeType = "application/json";

  const base = req.baseUrl || "https://generativelanguage.googleapis.com";
  const res = $http.send({
    url: `${base}/v1beta/models/${req.model}:generateContent?key=${encodeURIComponent(req.apiKey)}`,
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      systemInstruction: req.system ? { parts: [{ text: req.system }] } : undefined,
      contents: contents,
      generationConfig: generationConfig,
    }),
    timeout: TIMEOUT,
  });
  if (res.statusCode >= 300) fail("google", res);

  const cand = (res.json.candidates || [])[0];
  const parts = cand && cand.content && cand.content.parts ? cand.content.parts : [];
  return parts.map((p) => p.text || "").join("").trim();
}

function runProvider(req) {
  switch (req.provider) {
    case "anthropic":
      return runAnthropic(req);
    case "openai":
      return runOpenAI(req);
    case "google":
      return runGoogle(req);
    default:
      throw new Error("unknown provider: " + req.provider);
  }
}

module.exports = { runProvider };
