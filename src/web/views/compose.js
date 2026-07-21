// Sate v2 SPA — Compose overlay ("+ Add to log"). Owned by the compose agent.
//
// The bottom sheet with Nutrition / Activity tabs, faithful to v1 (openAdd/renderAddBody/logMeal/
// pickFood/logActivity*) over the v2 API:
//   Nutrition — live food autocomplete (GET /api/foods/search) → log a known food (POST /api/log/food)
//     · two pinned actions: "add manually" (manual-food sheet → POST /api/foods/manual) and
//       "search the internet" (→ openView('foodsearch', q))
//     · Barcode method (html5-qrcode camera on web, loaded from CDN on demand → POST /api/log/barcode)
//     · Photo AI method (file/camera → POST /api/log/photo)
//     · "Log with AI estimate" (free text → POST /api/log/text)
//   Activity — activity autocomplete (GET /api/activities/search) preset logging + duration
//     (POST /api/log/activity {activity_id,duration_min}) · "Estimate with AI" (POST /api/log/activity
//     {text}) · native-only "From heart rate" (gated behind isNative()).
//
// Exposes open({scope}) for Home's "+ Add". Reuses lib's sheet()/api()/toast()/busy() + the ported v1
// CSS classes (addsheet/search/reslist/res/methods/method/aibtn/dur/mfield/manualgrid). After any
// successful log it refreshes Home.

"use strict";

import {
  $$, el, esc, api, toast, busy, sheet, isNative, openView, registerView,
} from "../lib.js";
import { render as renderHome } from "./home.js";

// The one open compose sheet (so a successful log / a method sub-flow can close it).
let composeCtrl = null;
let composeTab = "nutrition";
let mealTimer = null;
let actTimer = null;
let mealFoods = [];

const n1 = (x) => Math.round((+x || 0) * 10) / 10;
const r0 = (x) => Math.round(+x || 0);

// After a log lands: close the compose sheet (and any child sheet closes itself) and refresh Home.
function afterLog() {
  if (composeCtrl) composeCtrl.close();
  composeCtrl = null;
  try { renderHome(); } catch (_) {}
}

// ============================================================ open()
// Home calls openView('compose', { scope:'nutrition'|'activity' }). Build the addsheet: pinned scope
// tabs + a body that swaps between the Nutrition and Activity panels.
export function open(args = {}) {
  composeTab = args && args.scope === "activity" ? "activity" : "nutrition";
  composeCtrl = sheet({
    className: "addsheet",
    onClose: () => { composeCtrl = null; },
    body: (bodyEl) => {
      // Make the sheet-body the flex column the .addsheet layout expects (pinned tabs + input, scrolling
      // results) — the sheet() wrapper nests our content one level deeper than v1's markup did.
      Object.assign(bodyEl.style, { display: "flex", flexDirection: "column", flex: "1 1 auto", minHeight: "0", overflow: "hidden" });

      const seg = el("div", { class: "seg scope", style: { flex: "none", marginBottom: "12px" } },
        tabBtn("nutrition", "Food"),
        tabBtn("activity", "Activity"),
      );
      const addBody = el("div", { id: "addBody" });
      bodyEl.append(seg, addBody);

      seg.addEventListener("click", (ev) => {
        const b = ev.target.closest("button[data-add]");
        if (!b) return;
        composeTab = b.dataset.add;
        $$("button[data-add]", seg).forEach((x) => x.classList.toggle("on", x.dataset.add === composeTab));
        renderTab(addBody);
      });
      renderTab(addBody);
    },
  });
}

function tabBtn(key, label) {
  const b = el("button", { type: "button", dataset: { add: key }, text: label });
  if (key === composeTab) b.classList.add("on");
  return b;
}

function renderTab(host) {
  if (composeTab === "activity") renderActivityTab(host);
  else renderNutritionTab(host);
}

// ============================================================ Nutrition tab
function renderNutritionTab(host) {
  host.innerHTML = "";
  const input = el("input", { id: "mealInput", placeholder: "What did you eat? e.g. two eggs and toast", autocomplete: "off" });
  const search = el("div", { class: "search" }, iconList(), input);

  const results = el("div", { class: "reslist" });
  const methods = el("div", { class: "methods" },
    methodBtn(ICON_BARCODE, "Barcode", "scan a package", () => openScanner()),
    methodBtn(ICON_CAMERA, "Photo AI", "snap your plate", () => pickPhoto()),
    methodBtn(ICON_IMAGE, "From library", "photo or barcode", () => logFromLibraryImage()),
  );
  const aiBtn = el("button", {
    class: "aibtn",
    style: { background: "var(--brand)", color: "var(--brand-ink, #fff)", borderStyle: "solid", borderColor: "var(--brand)" },
    text: "Log with AI estimate",
    onClick: () => logMeal(input.value),
  });
  const scroll = el("div", { class: "addscroll" }, results, methods, aiBtn);
  host.append(search, scroll);

  input.addEventListener("keydown", (e) => { if (e.key === "Enter") logMeal(input.value); });
  input.addEventListener("input", () => { clearTimeout(mealTimer); mealTimer = setTimeout(() => runMealSearch(input, results), 180); });
  setTimeout(() => input.focus(), 60);
}

// Live dropdown: two pinned actions (manual / internet), then matching foods from the DB.
async function runMealSearch(input, box) {
  const q = input.value.trim();
  if (!q) { box.innerHTML = ""; mealFoods = []; return; }
  try { mealFoods = (await api("/api/foods/search?q=" + encodeURIComponent(q))).foods || []; }
  catch (_) { mealFoods = []; }
  if (input.value.trim() !== q) return; // a newer keystroke won
  const e = esc(q);
  let html =
    `<button class="res act" data-mact="manual"><div class="rt"><b>➕ Add “${e}” manually</b>` +
    `<span>enter the nutrition facts yourself</span></div><span class="add">›</span></button>` +
    `<button class="res act" data-mact="web"><div class="rt"><b>🔎 Search the internet for “${e}”</b>` +
    `<span>your database, USDA, Open Food Facts &amp; the web</span></div><span class="add">›</span></button>`;
  if (mealFoods.length) html += `<div class="grouplbl">In your database</div>` + mealFoods.map((f, i) => foodResRow(f, i)).join("");
  box.innerHTML = html;
  box.querySelector("[data-mact='manual']").addEventListener("click", () => openManualFood(q));
  box.querySelector("[data-mact='web']").addEventListener("click", () => openView("foodsearch", q));
  $$(".res.food", box).forEach((row) => row.addEventListener("click", () => pickFood(mealFoods[+row.dataset.i])));
}

function foodResRow(f, i) {
  const brand = f.brand ? " · " + esc(f.brand) : "";
  return `<button class="res food" data-i="${i}"><div class="rt"><b>${esc(f.name)}</b>` +
    `<span>${esc(f.serving_desc || "1 serving")}${brand} · ${r0(f.kcal)} kcal · ${r0(f.protein)}P ${r0(f.carbs)}C ${r0(f.fat)}F</span></div>` +
    `<span class="add">+</span></button>`;
}

// Log a known food by id (no AI).
async function pickFood(f) {
  if (!f || !f.id) return;
  busy("Logging…");
  try {
    const r = await api("/api/log/food", { method: "POST", json: { food_id: f.id } });
    toast(`Logged ${r0(r.entry.kcal)} kcal.`);
    afterLog();
  } catch (e) { toast(e.message); }
}

// Free-text meal → AI estimate.
async function logMeal(text) {
  if (!text || !text.trim()) return;
  busy("Estimating…");
  try {
    const r = await api("/api/log/text", { method: "POST", json: { text: text.trim() } });
    toast(r.note || `Logged ${r0(r.entry.kcal)} kcal.`);
    afterLog();
  } catch (e) { toast(e.message); }
}

// ============================================================ manual-food sheet
const MANUAL_FIELDS = [
  ["kcal", "Calories", "kcal"], ["protein", "Protein", "g"], ["carbs", "Carbs", "g"], ["fat", "Fat", "g"],
  ["fiber", "Fiber", "g"], ["sugar", "Sugar", "g"], ["sodium", "Sodium", "mg"], ["sat_fat", "Sat. fat", "g"],
];

// "Add manually" — a food editor prefilled with the typed name; saves to the DB and logs it.
function openManualFood(name) {
  const grid = MANUAL_FIELDS.map(([k, label, u]) =>
    `<label class="mfield"><span>${label}${u ? ` <em>(${u})</em>` : ""}</span>` +
    `<input type="number" step="any" inputmode="decimal" data-mf="${k}"></label>`).join("");
  const mf = sheet({
    title: "Add food",
    body: (b) => {
      b.innerHTML =
        `<label class="mfield"><span>Name</span><input id="mfName" maxlength="200" value="${esc(name || "")}" placeholder="e.g. Grandma's chili"></label>` +
        `<label class="mfield"><span>Serving <em>(optional)</em></span><input id="mfServing" maxlength="40" placeholder="e.g. 1 cup"></label>` +
        `<label class="mfield"><span>Note <em>(optional)</em></span><input id="mfNote" maxlength="2000" placeholder="Add a note…"></label>` +
        `<div class="manualgrid">${grid}</div>` +
        `<div class="sheet-actions"><button class="primary" id="mfSave">Add &amp; log</button></div>`;
      b.querySelector("#mfSave").addEventListener("click", () => saveManualFood(b, mf));
    },
  });
  setTimeout(() => { const n = mf.body.querySelector("#mfName"); if (n) n.focus(); }, 60);
}

async function saveManualFood(b, mf) {
  const name = b.querySelector("#mfName").value.trim();
  if (!name) { toast("Name is required"); return; }
  const payload = {
    name,
    serving_desc: b.querySelector("#mfServing").value.trim(),
    note: b.querySelector("#mfNote").value.trim(),
  };
  $$("[data-mf]", b).forEach((inp) => {
    const raw = inp.value.trim();
    if (raw !== "" && !isNaN(+raw)) payload[inp.dataset.mf] = +raw;
  });
  busy("Adding…");
  try {
    const r = await api("/api/foods/manual", { method: "POST", json: payload });
    toast(`Logged ${r0(r.entry.kcal)} kcal.`);
    mf.close();
    afterLog();
  } catch (e) { toast(e.message); }
}

// ============================================================ Activity tab
function renderActivityTab(host) {
  host.innerHTML = "";
  const input = el("input", { id: "actInput", placeholder: "Search activities… e.g. running", autocomplete: "off" });
  const search = el("div", { class: "search" }, iconSearch(), input);
  const dur = el("input", { id: "actDur", type: "number", min: "1", value: "30" });
  const durRow = el("div", { class: "dur" }, el("label", { text: "Duration" }), dur, el("label", { text: "min" }));

  const results = el("div", { class: "reslist" });
  const actColor = { borderColor: "color-mix(in srgb,var(--activity) 45%,var(--line))", color: "var(--activity)" };
  const aiBtn = el("button", { class: "aibtn", style: actColor, onClick: () => logActivityText(input.value) },
    iconSpark(), "Estimate with AI — describe the workout");
  const scroll = el("div", { class: "addscroll" }, results, aiBtn);
  // Heart-rate import is a native (HealthKit) flow — gate it behind isNative() so the web build never
  // shows it (isNative() is always false on web).
  if (isNative()) {
    scroll.appendChild(el("button", { class: "aibtn", style: actColor, onClick: openHrPicker },
      iconPulse(), "From heart rate — pick a window from your watch"));
  }
  host.append(search, durRow, scroll);

  const run = () => runActivitySearch(input, dur, results);
  input.addEventListener("input", () => { clearTimeout(actTimer); actTimer = setTimeout(run, 180); });
  dur.addEventListener("input", () => { clearTimeout(actTimer); actTimer = setTimeout(run, 180); });
  run();
  setTimeout(() => input.focus(), 60);
}

async function runActivitySearch(input, durEl, box) {
  let acts = [];
  try { acts = (await api("/api/activities/search?q=" + encodeURIComponent(input.value))).activities || []; }
  catch (_) { acts = []; }
  const dur = Math.max(1, +durEl.value || 30);
  box.innerHTML = acts.length
    ? acts.map((a) =>
      `<button class="res act-preset" data-id="${esc(a.id)}"><div class="rt"><b>${esc(a.name)}</b>` +
      `<span>${n1(a.kcal_min)} cal/min · ~${r0(a.kcal_min * dur)} cal for ${dur} min</span></div><span class="add">+</span></button>`).join("")
    : `<div class="grouplbl">No matches — try the AI estimate below</div>`;
  $$(".act-preset", box).forEach((row) =>
    row.addEventListener("click", () => logActivityPreset(row.dataset.id, Math.max(1, +durEl.value || 30))));
}

// Preset activity → deterministic MET burn (no AI).
async function logActivityPreset(id, minutes) {
  busy("Logging…");
  try {
    const r = await api("/api/log/activity", { method: "POST", json: { activity_id: id, duration_min: minutes } });
    toast(`Logged ${esc(r.entry.description)} — ${r0(r.entry.kcal)} cal burned.`);
    afterLog();
  } catch (e) { toast(e.message); }
}

// Free-text workout → AI estimate.
async function logActivityText(text) {
  if (!text || !text.trim()) return;
  busy("Estimating…");
  try {
    const r = await api("/api/log/activity", { method: "POST", json: { text: text.trim() } });
    toast(r.note || `Logged ${r0(r.entry.kcal)} cal burned.`);
    afterLog();
  } catch (e) { toast(e.message); }
}

// Native-only placeholder: the real HealthKit heart-rate picker lives in the native shell. Never
// reached on web (the button is isNative()-gated).
function openHrPicker() {
  toast("Open the Sate app on your watch-paired phone to import a heart-rate window.");
}

// ============================================================ Photo AI (web file / native camera)
function pickPhoto() {
  const inp = el("input", { type: "file", accept: "image/*", capture: "environment", style: { display: "none" } });
  document.body.appendChild(inp);
  inp.addEventListener("change", () => {
    const file = inp.files && inp.files[0];
    inp.remove();
    if (file) logPhoto(file);
  });
  inp.click();
}

// "From library": pick a saved image and figure out what to do with it — try to decode a product
// barcode first (→ barcode lookup); if there's no barcode, treat it as a plate/label for the vision
// estimate. One button covers both the photo and barcode paths from an existing photo.
async function logFromLibraryImage() {
  const inp = el("input", { type: "file", accept: "image/*", style: { display: "none" } });
  document.body.appendChild(inp);
  inp.addEventListener("change", async () => {
    const file = inp.files && inp.files[0];
    inp.remove();
    if (!file) return;
    let gtin = null;
    if (await ensureQrLib()) {
      busy("Reading barcode…");
      const holder = el("div", { id: "bcfile-reader", style: { display: "none" } });
      document.body.appendChild(holder);
      try {
        const decoded = await new window.Html5Qrcode("bcfile-reader", { verbose: false }).scanFile(file, false);
        gtin = gtinFromScan(String(decoded || "").trim());
      } catch (_) { gtin = null; }
      holder.remove();
    }
    if (gtin) {
      try {
        const r = await api("/api/log/barcode", { method: "POST", json: { barcode: gtin } });
        toast(`Logged ${esc(r.name)} — ${r0(r.entry.kcal)} kcal (via ${esc(r.found_via)}).`);
        afterLog();
        return;
      } catch (_) { /* no match in the barcode DB → fall through to the vision estimate */ }
    }
    await logPhoto(file);
  });
  inp.click();
}

async function logPhoto(file) {
  let dataUrl;
  try {
    dataUrl = await new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(fr.result);
      fr.onerror = reject;
      fr.readAsDataURL(file);
    });
  } catch (_) { toast("Could not read that image."); return; }
  await logPhotoDataUrl(dataUrl, "Analyzing photo…");
}

// POST a data-URL image to the vision estimator and log it. Shared by the photo picker and the
// barcode scanner's nutrition-label fallback — the vision prompt reads a Nutrition Facts panel's
// per-serving values, so it works for any product no barcode database can find.
async function logPhotoDataUrl(dataUrl, label) {
  busy(label || "Analyzing photo…");
  try {
    const r = await api("/api/log/photo", { method: "POST", json: { image: dataUrl } });
    toast(r.note || `Logged ${r0(r.entry.kcal)} kcal from photo.`);
    afterLog();
    return true;
  } catch (e) { toast(e.message); return false; }
}

// ============================================================ Barcode scanner (web, html5-qrcode via CDN)
const QR_CDN = "https://unpkg.com/html5-qrcode@2.3.8/html5-qrcode.min.js";
let scanner = null;
let scanBusy = false;

// Load html5-qrcode on demand (web camera). Native shells could ship a Capacitor barcode plugin; on
// web this CDN lib is the only path. Returns true once window.Html5Qrcode is available.
function ensureQrLib() {
  if (window.Html5Qrcode) return Promise.resolve(true);
  return new Promise((resolve) => {
    const s = document.createElement("script");
    s.src = QR_CDN;
    s.onload = () => resolve(!!window.Html5Qrcode);
    s.onerror = () => resolve(false);
    document.head.appendChild(s);
  });
}

// Pull a GTIN out of a scan: a plain UPC/EAN, or the GTIN embedded in a GS1 Digital Link QR.
function gtinFromScan(raw) {
  if (/^\d{8,14}$/.test(raw)) return raw;
  const m = raw.match(/(?:^|\/)01\/(\d{8,14})(?:\/|$)/);
  return m ? m[1] : null;
}

async function openScanner() {
  const ok = await ensureQrLib();
  if (!ok) { toast("Scanner failed to load"); return; }
  scanBusy = false;
  const reader = el("div", { id: "reader", style: { width: "100%", borderRadius: "12px", overflow: "hidden" } });
  const status = el("div", { class: "subline", style: { textAlign: "center", marginTop: "10px" }, text: "Starting camera…" });
  // Always-available escape hatch: many products aren't in any barcode database, so let the user
  // read the Nutrition Facts label directly (AI vision) — the camera's already on it.
  const labelBtn = el("button", {
    class: "link", type: "button", text: "Can't scan? Read the nutrition label →",
    style: { display: "block", margin: "12px auto 0", fontWeight: "600" },
    onClick: () => labelFallback(sc),
  });
  const sc = sheet({
    title: "Scan a barcode",
    onClose: () => { void stopScanner(); },
    body: (b) => { b.append(reader, status, labelBtn); },
  });
  try {
    scanner = new window.Html5Qrcode("reader", { verbose: false });
    await scanner.start(
      { facingMode: "environment" },
      { fps: 10, qrbox: { width: 250, height: 160 } },
      (decoded) => onScan(decoded, status, sc),
      () => {},
    );
    status.textContent = "Point your camera at a barcode.";
  } catch (err) {
    status.textContent = "Camera error: " + (err && err.message ? err.message : String(err));
  }
}

async function stopScanner() {
  try { if (scanner) { await scanner.stop(); scanner.clear(); } } catch (_) {}
  scanner = null;
}

// Grab the current camera frame from the live scanner <video> (for the nutrition-label fallback).
function captureReaderFrame() {
  const v = document.querySelector("#reader video");
  if (!v || !v.videoWidth) return null;
  const cv = document.createElement("canvas");
  cv.width = v.videoWidth;
  cv.height = v.videoHeight;
  try {
    cv.getContext("2d").drawImage(v, 0, 0, cv.width, cv.height);
    return cv.toDataURL("image/jpeg", 0.9);
  } catch (_) { return null; }
}

// Barcode not in any database? Read the Nutrition Facts label the camera is already pointed at.
async function labelFallback(sc) {
  const frame = captureReaderFrame();
  await stopScanner();
  sc.close();
  if (frame) await logPhotoDataUrl(frame, "Reading nutrition label…");
  else pickPhoto(); // no live frame (e.g. native shell) → open the camera/file picker instead
}

async function onScan(decodedText, status, sc) {
  if (scanBusy) return;
  const raw = String(decodedText).trim();
  const gtin = gtinFromScan(raw);
  if (gtin) {
    scanBusy = true;
    status.textContent = "Looking up " + gtin + "…";
    try {
      const r = await api("/api/log/barcode", { method: "POST", json: { barcode: gtin } });
      await stopScanner();
      sc.close();
      toast(`Logged ${esc(r.name)} — ${r0(r.entry.kcal)} kcal (via ${esc(r.found_via)}).`);
      afterLog();
    } catch (e) {
      status.textContent = e.message + " Point the camera at the nutrition label and tap below.";
      scanBusy = false;
    }
  } else if (/^https?:\/\//i.test(raw)) {
    status.textContent = "That QR code is a link, not a product barcode.";
  } else {
    scanBusy = true;
    await stopScanner();
    sc.close();
    logMeal(raw); // any other text (e.g. a meal typed into a QR) → treat as a meal description
  }
}

// ============================================================ inline icons (match v1's compose markup)
const ICON_BARCODE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 5v14M7 5v14M11 5v14M14 5v14M18 5v14M21 5v14"/></svg>';
const ICON_CAMERA = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="7" width="18" height="13" rx="3"/><circle cx="12" cy="13.5" r="3.5"/><path d="M9 7l1.5-2h3L15 7"/></svg>';
const ICON_IMAGE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="4" width="18" height="16" rx="3"/><circle cx="8.5" cy="9.5" r="1.5"/><path d="M4 17l5-5 4 4 2-2 5 5"/></svg>';
const iconList = () => el("span", { html: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 6h16M4 12h10M4 18h7" stroke-linecap="round"/></svg>' }).firstElementChild;
const iconSearch = () => el("span", { html: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4-4" stroke-linecap="round"/></svg>' }).firstElementChild;
const iconSpark = () => el("span", { html: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l1.8 4.2L18 9l-4.2 1.8L12 15l-1.8-4.2L6 9l4.2-1.8z"/></svg>' }).firstElementChild;
const iconPulse = () => el("span", { html: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12h4l2.5 6 4-14 2.5 8H22"/></svg>' }).firstElementChild;

function methodBtn(iconHtml, title, sub, onClick) {
  return el("button", { class: "method", type: "button", html: `${iconHtml}<b>${esc(title)}</b><span>${esc(sub)}</span>`, onClick });
}

// ============================================================ register
export function render() {} // required by the contract; compose is overlay-only.
registerView("compose", { render, open });
