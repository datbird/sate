// Sate — barcode normalization. PURE FUNCTIONS ONLY (no I/O, no platform deps).
//
// SHARED MODULE — consumed by BOTH editions:
//   Hosted (PocketBase/goja):  require(`${__hooks}/shared/barcode.js`)
//   Cloud  (Node/TypeScript):  import { barcodeVariants } from "../shared/barcode.js"
//
// Authored as CommonJS in goja-safe ES2015 (goja has no ES modules; no `?.`, no `??`, no object
// spread). Types for TS consumers live in the sibling barcode.d.ts — keep the two in step.
//
// Was previously copy-pasted in three places (pb_hooks/api.js, core api/entries.ts, core
// api/admin.ts). A scanner's raw output and a product database's canonical key are often different
// encodings of the same GTIN, so this logic decides whether a lookup hits or misses.

// Strip leading zeros — the loose form used when comparing codes for equality.
function normUpc(s) {
  return String(s || "").replace(/^0+/, "");
}

// UPC-A check digit for an 11-digit body (mod-10, odd positions ×3).
function upcACheck(b11) {
  let sum = 0;
  for (let i = 0; i < 11; i++) sum += (i % 2 === 0 ? 3 : 1) * Number(b11[i] || 0);
  return String((10 - (sum % 10)) % 10);
}

// Expand a compressed UPC-E barcode to its 12-digit UPC-A form (null if not UPC-E-shaped). Small
// packages (bottles/cans) print UPC-E; product databases key on the expanded UPC-A, so a raw UPC-E
// lookup misses. Accepts 8 (NS+6+check), 7 (NS+6), or 6 (bare data) digit inputs.
function upcEtoA(e) {
  let s = String(e || ""), ns = "0";
  if (s.length === 8) { ns = s[0]; s = s.slice(1, 7); }
  else if (s.length === 7) { ns = s[0]; s = s.slice(1); }
  else if (s.length !== 6) return null;
  if (!/^\d{6}$/.test(s) || (ns !== "0" && ns !== "1")) return null;
  const d = s.split(""), last = d[5];
  let b;
  if (last === "0" || last === "1" || last === "2") b = ns + d[0] + d[1] + last + "0000" + d[2] + d[3] + d[4];
  else if (last === "3") b = ns + d[0] + d[1] + d[2] + "00000" + d[3] + d[4];
  else if (last === "4") b = ns + d[0] + d[1] + d[2] + d[3] + "00000" + d[4];
  else b = ns + d[0] + d[1] + d[2] + d[3] + d[4] + "0000" + last;
  return b + upcACheck(b);
}

// Ordered, deduped barcode forms to try against each source. A scanner may emit UPC-E, UPC-A (12),
// EAN-13 (13, leading 0), or GTIN-14; a product database stores one canonical form, so trying the
// common equivalents recovers matches a single-form lookup would miss.
function barcodeVariants(code) {
  const out = [];
  const push = (c) => { if (c && /^\d{6,14}$/.test(c) && out.indexOf(c) < 0) out.push(c); };
  push(code);
  const a = upcEtoA(code);
  if (a) { push(a); push("0" + a); }                               // UPC-E → UPC-A (+ EAN-13)
  if (code.length === 12) push("0" + code);                        // UPC-A → EAN-13
  if (code.length === 13 && code[0] === "0") push(code.slice(1));  // EAN-13 → UPC-A
  if (code.length === 14 && code.slice(0, 2) === "00") push(code.slice(2)); // GTIN-14 → UPC-A
  return out;
}

module.exports = {
  normUpc,
  upcACheck,
  upcEtoA,
  barcodeVariants,
};
