/// <reference path="../pb_data/types.d.ts" />

// Function registry, prompts, key encryption, and config resolution.
//
// The function registry, system prompts, and response normalization are SHARED with the Cloud
// edition and live in core/src/shared/prompts.js (copied into the image at /pb/pb_hooks/shared/ by
// the Dockerfile) — so a prompt change lands in both editions at once. What stays here is the part
// that is genuinely PocketBase-specific: AES key encryption via $security, and the provider lookup
// against the `providers` collection.

const S = require(`${__hooks}/shared/prompts.js`);

// ---- encryption of provider API keys (AES-256-GCM via $security) ----

// Env access inside PocketBase hooks is via $os.getenv (process.env is not available in the
// isolated handler VM).
function env(name) {
  try {
    if (typeof $os !== "undefined" && $os.getenv) return $os.getenv(name) || "";
  } catch (_) {}
  try {
    if (typeof process !== "undefined" && process.env) return process.env[name] || "";
  } catch (_) {}
  return "";
}

function encKey() {
  const k = env("APP_ENCRYPTION_KEY") || "";
  if (k.length !== 32) {
    throw new Error(
      "APP_ENCRYPTION_KEY must be exactly 32 characters (AES-256). " +
        "Generate one with `openssl rand -hex 16`."
    );
  }
  return k;
}

function encryptKey(plaintext) {
  if (!plaintext) return "";
  return $security.encrypt(plaintext, encKey());
}

function bytesToStr(b) {
  if (b == null) return "";
  if (typeof b === "string") return b;
  let s = "";
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return s;
}

function decryptKey(cipher) {
  if (!cipher) return "";
  return bytesToStr($security.decrypt(cipher, encKey()));
}

function redact(plaintext) {
  if (!plaintext) return "";
  const s = String(plaintext);
  return s.length <= 4 ? "••••" : "••••" + s.slice(-4);
}

// ---- resolve which provider+model+key handles a function ----

// Resolve a concrete (provider, model) to a callable config: the provider record must exist, be
// enabled, and have a key. Throws a clear error otherwise. (The routing hierarchy that CHOOSES the
// provider/model lives in api.js resolveFor; this is just the provider/key lookup tail.)
function resolveProviderKey(app, provider, model) {
  const prov = app.findFirstRecordByFilter("providers", "name = {:n}", { n: provider });
  if (!prov) throw new Error("unknown provider: " + provider);
  if (!prov.getBool("enabled")) throw new Error("provider not enabled: " + provider);
  const enc = prov.getString("api_key_enc");
  if (!enc) throw new Error("no API key configured for provider: " + provider);
  return { provider: provider, model: model, apiKey: decryptKey(enc), baseUrl: prov.getString("base_url") || "" };
}

module.exports = {
  // shared with the Cloud edition — see core/src/shared/prompts.js
  FUNCTIONS: S.FUNCTIONS,
  PROMPTS: S.PROMPTS,
  parseJSON: S.parseJSON,
  normalizeNutrition: S.normalizeNutrition,
  normalizeActivity: S.normalizeActivity,
  // PocketBase-specific
  encryptKey,
  decryptKey,
  redact,
  resolveProviderKey,
};
