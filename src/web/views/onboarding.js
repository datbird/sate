// Sate v2 SPA — First-run onboarding wizard. Shown by app.js (openView('onboarding')) when
// me.edition is set but me.onboarded is false. A full-screen, multi-step walkthrough that mirrors v1
// maybeOnboard():
//
//   welcome → stats → [source (native only)] → goals → method → review → [checkin] → plan
//
//   • stats  — name / weight (lb) / height (ft+in) / age / sex / activity level.
//   • source — native-only weight-source picker (Apple Health vs manual). Gated by isNative();
//              on web the step is skipped and weight_source defaults to "manual".
//   • goals  — up to 3 weight goals { target_lb, target_date } (or Skip to just track).
//   • method — the tracking mode (Calories/Carb/Protein/Fat/Balanced/Heart) → track_mode.
//   • review — POST /api/plan/compute previews kcal/macros + BMR/TDEE + any warnings from the
//              not-yet-saved stats (pure compute, no AI).
//   • checkin— proactive coach opt-in + frequency. Only appears when the instance has check-ins on
//              (me.checkins_enabled !== false).
//   • plan   — POST /api/nutritionist { mode:"plan" } for the AI plan narrative.
//
// Save (on leaving review): PATCH /api/goals (stats + goal_* macros + track_mode + onboarded:true)
//   + POST /api/weight/log (initial measurement) + POST /api/weight/goals (each entered goal), then
//   refreshMe() so Home renders against the fresh profile. Finish → showView('home').
//
// Owns exactly this file. Reuses lib.js helpers + the ported .onboard/.ob-* CSS classes (no new
// global CSS). Native bridges are gated behind isNative(); the web build never touches them.

"use strict";

import {
  $, $$, el, api, esc, toast, isNative, me, refreshMe, showView, registerView,
} from "../lib.js";

// ---- static option tables (ported verbatim from v1) -------------------------
const OB_ACT = [
  ["sedentary", "Sedentary"],
  ["light", "Light (1-3 d/wk)"],
  ["moderate", "Moderate (3-5 d/wk)"],
  ["active", "Active (6-7 d/wk)"],
  ["athlete", "Athlete"],
];
const OB_METHODS = [
  ["calories", "Calories (simple)"],
  ["carb", "Carb-focused (low-carb/keto)"],
  ["protein", "High-protein"],
  ["fat", "Low-fat"],
  ["balanced", "Balanced macros"],
  ["heart", "Heart-healthy"],
];
const OB_CHECKIN_FREQ = [
  ["often", "A few times a day"],
  ["daily", "Once a day"],
  ["sparse", "Every couple of days"],
];
const KG_PER_LB = 2.2046226;

// ---- view-local wizard state ------------------------------------------------
// `host` is the dynamically-created full-screen .onboard element (null when closed). We build/remove
// it ourselves rather than toggling a static node (there is none in index.html), which also sidesteps
// v1's "empty overlay stays on top" freeze bug.
let OB = null;
let host = null;

// ============================================================ entry point
// open() is invoked by app.js after /api/me loads for a not-yet-onboarded, editioned user. Idempotent:
// a second call while the wizard is up is a no-op.
export function open() {
  if (OB || host) return;
  const M = me() || {};
  OB = {
    i: 0,
    name: M.name || "",
    weight_lb: "",
    height_ft: "",
    height_in: "",
    age: M.body_age || "",
    sex: M.body_sex || "male",
    activity: M.activity_level || "moderate",
    source: isNative() ? "" : "manual",
    goals: [{ target_lb: "", target_date: "" }],
    method: M.track_mode || "calories",
    checkin_enabled: !!M.checkin_enabled,
    checkin_freq: M.checkin_freq || "daily",
    targets: null,
    bmr: 0,
    tdee: 0,
    warnings: [],
    _planned: false,
  };
  // The check-in step only appears when check-ins are enabled instance-wide; the Apple Health priming
  // step is native-only (web has no HealthKit bridge) and comes right after welcome — informing the
  // user before the OS permission prompt, straight after sign-in. Filter the nulls out.
  const checkinStep = M.checkins_enabled !== false ? "checkin" : null;
  const nativeSteps = isNative() ? ["health", "siri"] : [];
  OB.steps = ["welcome", ...nativeSteps, "stats", "goals", "method", "review", checkinStep, "plan"].filter(Boolean);

  host = el("div", { class: "onboard" },
    el("div", { class: "onboard-card" }, el("div", { class: "onboard-body", id: "onboardBody" })));
  ($("#overlay") || document.body).appendChild(host);
  obRender();
}

function obClose() {
  if (host) { host.remove(); host = null; }
  OB = null;
}

// ============================================================ step markup
// Each returns the innerHTML for one step (trusted markup; all user/AI text run through esc()).
const obNavBar = (back, nextLabel, canNext, skip) =>
  '<div class="ob-nav">' +
  (back ? '<button type="button" class="link" id="obBack">Back</button>' : "<span></span>") +
  '<span class="ob-navr">' + (skip ? '<button type="button" class="link" id="obSkip">Skip</button>' : "") +
  `<button type="button" class="primary" id="obNext"${canNext === false ? " disabled" : ""}>${esc(nextLabel || "Next")}</button></span></div>`;

const obGoalRow = (g, i) =>
  '<div class="ob-goalrow">' +
  `<label class="ob-gf"><span>Target weight (lb)</span><input type="number" placeholder="e.g. 185" inputmode="decimal" data-gi="${i}" data-gk="target_lb" value="${esc(g.target_lb)}"></label>` +
  `<label class="ob-gf"><span>By date</span><input type="date" data-gi="${i}" data-gk="target_date" value="${esc(g.target_date)}"></label>` +
  (OB.goals.length > 1 ? `<button type="button" class="link ob-grm" data-grm="${i}">×</button>` : "") +
  "</div>";

const OB_STEP = {
  welcome: () => {
    const app = (me() && me().app_name) || "Sate";
    return '<h2 style="text-align:center;margin-top:6px">Welcome to ' + esc(app) + "</h2>" +
      '<p class="ob-sub" style="text-align:center">Log meals by photo or text — ' + esc(app) + '’s AI counts the calories and macros for you. Let’s connect Apple Health and set your goals, then build a plan. Takes about a minute.</p>' +
      '<div class="ob-nav"><button type="button" class="link" id="obDismiss">Skip setup</button>' +
      '<button type="button" class="primary" id="obNext">Get started</button></div>';
  },
  // Apple Health priming (native only): explain what access buys BEFORE triggering the OS permission
  // sheet, so the user grants it deliberately rather than dismissing a cold system prompt.
  health: () =>
    "<h2>Connect Apple Health</h2>" +
    '<p class="ob-sub">With your permission, Sate reads your <b>workouts</b> and <b>weight</b> from Apple Health — so exercise adds to your daily calorie budget and your weight trend fills in on its own. Sate only reads; it never writes to Health. You can change this anytime in Settings.</p>' +
    '<p class="ob-msg" id="obHkMsg" hidden></p>' +
    '<div class="ob-nav"><button type="button" class="link" id="obHkSkip">Not now</button>' +
    '<button type="button" class="primary" id="obHkConnect">Connect Apple Health</button></div>',
  // Siri priming (native only). Voice logging ("Hey Siri, log a coffee in Sate") is coming soon — we
  // request the Siri permission now so it's ready when the feature ships. Requesting authorization
  // shows the OS prompt even with no intents wired yet.
  siri: () =>
    "<h2>Enable Siri <span class=\"ob-soon\">Coming soon</span></h2>" +
    '<p class="ob-sub">Soon you’ll be able to log meals hands-free — “Hey Siri, log a coffee in Sate.” Turn on Siri now and it’ll be ready the moment voice logging arrives. You can change this anytime in Settings.</p>' +
    '<p class="ob-msg" id="obSiriMsg" hidden></p>' +
    '<div class="ob-nav"><button type="button" class="link" id="obSiriSkip">Not now</button>' +
    '<button type="button" class="primary" id="obSiriEnable">Enable Siri</button></div>',
  stats: () =>
    '<h2>About you</h2><p class="ob-sub">Used to personalize your coach and calculate your calorie needs.</p>' +
    `<label class="ob-full" style="margin-bottom:10px">Your name<input type="text" id="obName" placeholder="first name" value="${esc(OB.name)}"></label>` +
    '<div class="ob-grid">' +
    `<label>Weight (lb)<input type="number" id="obW" inputmode="decimal" value="${esc(OB.weight_lb)}"></label>` +
    `<label>Height<div class="ob-ht"><input type="number" id="obHf" placeholder="ft" value="${esc(OB.height_ft)}"><input type="number" id="obHi" placeholder="in" value="${esc(OB.height_in)}"></div></label>` +
    `<label>Age<input type="number" id="obA" value="${esc(OB.age)}"></label>` +
    `<label>Sex<select id="obS"><option value="male"${OB.sex === "male" ? " selected" : ""}>Male</option><option value="female"${OB.sex === "female" ? " selected" : ""}>Female</option></select></label>` +
    "</div>" +
    `<label class="ob-full">Activity level<select id="obAct">${OB_ACT.map(([v, l]) => `<option value="${v}"${OB.activity === v ? " selected" : ""}>${esc(l)}</option>`).join("")}</select></label>` +
    obNavBar(true, "Next"),
  source: () =>
    '<h2>Weight tracking</h2><p class="ob-sub">How do you want to manage your weight history?</p>' +
    '<div class="ob-choices">' +
    `<button type="button" class="ob-choice${OB.source === "health" ? " on" : ""}" data-src="health">Apple Health<small>Import automatically</small></button>` +
    `<button type="button" class="ob-choice${OB.source === "manual" ? " on" : ""}" data-src="manual">Manually<small>Enter it yourself</small></button>` +
    "</div>" + obNavBar(true, "Next", !!OB.source),
  goals: () =>
    '<h2>Your goal</h2><p class="ob-sub">Set up to 3 weight goals — or skip to just track.</p>' +
    `<div id="obGoals">${OB.goals.map((g, i) => obGoalRow(g, i)).join("")}</div>` +
    (OB.goals.length < 3 ? '<button type="button" class="link" id="obAddGoal">+ Add another goal</button>' : "") +
    obNavBar(true, "Next", true, true),
  method: () =>
    '<h2>Tracking method</h2><p class="ob-sub">How do you want to hit your goal?</p>' +
    `<div class="ob-methods">${OB_METHODS.map(([v, l]) => `<button type="button" class="ob-method${OB.method === v ? " on" : ""}" data-m="${v}">${esc(l)}</button>`).join("")}</div>` +
    obNavBar(true, "Calculate my plan"),
  review: () =>
    "<h2>Your targets</h2>" +
    (OB.targets
      ? '<div class="ob-targets">' +
        `<div><b>${esc(OB.targets.kcal)}</b><span>kcal/day</span></div><div><b>${esc(OB.targets.protein)}g</b><span>protein</span></div>` +
        `<div><b>${esc(OB.targets.carbs)}g</b><span>carbs</span></div><div><b>${esc(OB.targets.fat)}g</b><span>fat</span></div></div>` +
        `<p class="ob-sub">BMR ${esc(OB.bmr)} · maintenance ${esc(OB.tdee)} kcal/day.</p>`
      : '<p class="ob-sub">Calculating…</p>') +
    (OB.warnings.length ? `<div class="ob-warn">⚠ ${OB.warnings.map(esc).join("<br>")}</div>` : "") +
    obNavBar(true, "See my plan"),
  checkin: () =>
    "<h2>Coach check-ins</h2>" +
    '<p class="ob-sub">Want Sate to review your logs and reach out with a helpful, personal nudge when it spots something useful? You can change this anytime in settings.</p>' +
    '<div class="ob-choices">' +
    `<button type="button" class="ob-choice${OB.checkin_enabled ? " on" : ""}" data-ci="1">Yes, check in with me<small>Proactive coaching nudges</small></button>` +
    `<button type="button" class="ob-choice${!OB.checkin_enabled ? " on" : ""}" data-ci="0">No thanks<small>I’ll open the coach myself</small></button>` +
    "</div>" +
    (OB.checkin_enabled
      ? '<label class="ob-full" style="margin-top:12px">How often, at most?' +
        `<select id="obCiFreq">${OB_CHECKIN_FREQ.map(([v, l]) => `<option value="${v}"${OB.checkin_freq === v ? " selected" : ""}>${esc(l)}</option>`).join("")}</select></label>`
      : "") +
    obNavBar(true, "Next"),
  plan: () =>
    '<h2>Your plan</h2><div class="ob-plan" id="obPlan">Generating your plan…</div>' +
    '<div class="ob-nav"><button type="button" class="link" id="obBack">Back</button>' +
    '<button type="button" class="primary" id="obNext">Finish</button></div>',
};

// ============================================================ render + wire
function obRender() {
  const body = $("#onboardBody");
  if (!body) return;
  const s = OB.steps[OB.i];
  const dots = '<div class="ob-progress">' + OB.steps.map((_, i) => `<i class="${i === OB.i ? "on" : ""}"></i>`).join("") + "</div>";
  body.innerHTML = dots + OB_STEP[s]();
  if (host) host.scrollTop = 0;
  obWire(s);
}

function obWire(s) {
  const back = $("#obBack"); if (back) back.onclick = () => { OB.i = Math.max(0, OB.i - 1); obRender(); };
  const next = $("#obNext"); if (next) next.onclick = () => obNext(s);
  const skip = $("#obSkip"); if (skip) skip.onclick = () => { OB.goals = []; obGo(); };
  const dis = $("#obDismiss"); if (dis) dis.onclick = obDismiss;

  if (s === "health") {
    const skip = $("#obHkSkip"); if (skip) skip.onclick = () => { OB.source = "manual"; obGo(); };
    const conn = $("#obHkConnect"); if (conn) conn.onclick = () => obPermission({
      btn: conn, msg: $("#obHkMsg"), plugin: "HealthKit",
      ok: "✓ Apple Health connected.", after: () => { OB.source = "health"; },
    });
  }
  if (s === "siri") {
    const skip = $("#obSiriSkip"); if (skip) skip.onclick = () => obGo();
    const en = $("#obSiriEnable"); if (en) en.onclick = () => obPermission({
      btn: en, msg: $("#obSiriMsg"), plugin: "Siri", ok: "✓ Siri enabled.",
    });
  }
  if (s === "method") $$(".ob-method").forEach((b) => (b.onclick = () => { OB.method = b.dataset.m; obRender(); }));
  if (s === "checkin") {
    $$(".ob-choice[data-ci]").forEach((b) => (b.onclick = () => { OB.checkin_enabled = b.dataset.ci === "1"; obRender(); }));
    const f = $("#obCiFreq"); if (f) f.onchange = () => { OB.checkin_freq = f.value; };
  }
  if (s === "goals") {
    const add = $("#obAddGoal");
    if (add) add.onclick = () => { obCaptureGoals(); OB.goals.push({ target_lb: "", target_date: "" }); obRender(); };
    $$("#obGoals [data-gk]").forEach((elm) => (elm.onchange = () => { const i = +elm.dataset.gi; if (OB.goals[i]) OB.goals[i][elm.dataset.gk] = elm.value; }));
    $$("#obGoals [data-grm]").forEach((elm) => (elm.onclick = () => { obCaptureGoals(); OB.goals.splice(+elm.dataset.grm, 1); obRender(); }));
  }
  if (s === "plan") obPlan();
}

// ============================================================ capture helpers
function obCaptureStats() {
  if ($("#obName")) OB.name = $("#obName").value;
  if ($("#obW")) OB.weight_lb = $("#obW").value;
  if ($("#obHf")) OB.height_ft = $("#obHf").value;
  if ($("#obHi")) OB.height_in = $("#obHi").value;
  if ($("#obA")) OB.age = $("#obA").value;
  if ($("#obS")) OB.sex = $("#obS").value;
  if ($("#obAct")) OB.activity = $("#obAct").value;
}
function obCaptureGoals() {
  $$("#obGoals [data-gk]").forEach((elm) => { const i = +elm.dataset.gi; if (OB.goals[i]) OB.goals[i][elm.dataset.gk] = elm.value; });
}
const obHeightCm = () => Math.round((+OB.height_ft * 12 + (+OB.height_in || 0)) * 2.54);
function obGo() { OB.i = Math.min(OB.steps.length - 1, OB.i + 1); obRender(); }

// Shared native-permission runner for the Health/Siri steps. Calls the plugin's requestAuthorization,
// then shows the outcome IN-SCREEN (toasts sit behind the z-index:70 onboarding overlay, so a silent
// native failure looked like "nothing happened") and turns the button into Continue so the user reads
// it before advancing. The OS permission sheet, if the native call reaches it, appears above all this.
async function obPermission({ btn, msg, plugin, ok, after }) {
  btn.disabled = true; btn.textContent = "Requesting…";
  let text;
  try {
    // The remotely-loaded SPA doesn't bundle @capacitor/core, so window.Capacitor.registerPlugin is
    // NOT injected here — but the native bridge DOES expose registered plugins via Capacitor.Plugins
    // (the launcher reaches Preferences the same way). Prefer Plugins; fall back to registerPlugin if
    // a future build does inject it.
    const cap = window.Capacitor;
    const P = (cap && cap.Plugins && cap.Plugins[plugin]) ||
              (cap && typeof cap.registerPlugin === "function" ? cap.registerPlugin(plugin) : null);
    if (!P || typeof P.requestAuthorization !== "function") {
      text = "Native " + plugin + " plugin not reachable on this build.";
    } else {
      const r = await P.requestAuthorization();
      // Siri exposes its status; a denial gets a gentle note. HealthKit hides read grants, so any
      // non-error return is treated as connected.
      text = (r && r.status === "denied")
        ? (plugin === "Siri" ? "No problem — you can turn Siri on later in Settings." : "You can enable this later in Settings.")
        : ok;
    }
  } catch (e) { text = plugin + " bridge error: " + (e && e.message ? e.message : String(e)); }
  if (typeof after === "function") { try { after(); } catch (_) {} }
  if (msg) { msg.textContent = text; msg.hidden = false; }
  btn.disabled = false; btn.textContent = "Continue"; btn.onclick = () => obGo();
}

// ============================================================ step advance
async function obNext(s) {
  if (s === "stats") { obCaptureStats(); return obGo(); }
  if (s === "goals") { obCaptureGoals(); return obGo(); }
  if (s === "method") return obComputeThenReview();
  if (s === "review") return obSaveThenPlan();
  if (s === "checkin") {
    const f = $("#obCiFreq"); if (f) OB.checkin_freq = f.value;
    try {
      await api("/api/goals", { method: "PATCH", json: { checkin_enabled: !!OB.checkin_enabled, checkin_freq: OB.checkin_freq } });
    } catch (_) { /* non-fatal — a preference, not a gate */ }
    return obGo();
  }
  if (s === "plan") return obFinish();
  obGo();
}

// ---- review: preview targets from not-yet-saved stats (POST /api/plan/compute) ----
async function obCompute() {
  const goals = OB.goals
    .filter((g) => +g.target_lb > 0 && g.target_date)
    .map((g) => ({ target_lb: +g.target_lb, target_date: g.target_date }));
  const r = await api("/api/plan/compute", {
    method: "POST",
    json: { weight_lb: +OB.weight_lb, height_cm: obHeightCm(), age: +OB.age, sex: OB.sex, activity: OB.activity, method: OB.method, goals },
  });
  OB.targets = r.targets;
  OB.bmr = r.bmr;
  OB.tdee = r.tdee;
  OB.warnings = r.warnings || [];
}
async function obComputeThenReview() {
  const n = $("#obNext"); if (n) { n.disabled = true; n.textContent = "Calculating…"; }
  try { await obCompute(); }
  catch (e) { toast(e.message); if (n) { n.disabled = false; n.textContent = "Calculate my plan"; } return; }
  obGo();
}

// ---- save: persist everything, mark onboarded, refresh shared state ----
async function obSaveAll() {
  const cm = obHeightCm();
  const payload = {
    name: (OB.name || "").trim(),
    body_age: +OB.age || 0,
    body_sex: OB.sex,
    height_cm: cm,
    activity_level: OB.activity,
    track_mode: OB.method,
    weight_source: OB.source || "manual",
    onboarded: true,
  };
  if (OB.targets) {
    payload.goal_kcal = OB.targets.kcal;
    payload.goal_protein = OB.targets.protein;
    payload.goal_carbs = OB.targets.carbs;
    payload.goal_fat = OB.targets.fat;
    payload.goal_sodium = OB.targets.sodium;
  }
  await api("/api/goals", { method: "PATCH", json: payload });
  if (+OB.weight_lb > 0) {
    await api("/api/weight/log", { method: "POST", json: { weight_kg: +OB.weight_lb / KG_PER_LB, height_cm: cm } });
  }
  for (const g of OB.goals) {
    if (+g.target_lb > 0 && g.target_date) {
      try { await api("/api/weight/goals", { method: "POST", json: { target_lb: +g.target_lb, target_date: g.target_date } }); }
      catch (_) { /* one bad goal shouldn't abort onboarding */ }
    }
  }
  await refreshMe();
}
async function obSaveThenPlan() {
  const n = $("#obNext"); if (n) { n.disabled = true; n.textContent = "Saving…"; }
  try { await obSaveAll(); }
  catch (e) { toast(e.message); if (n) { n.disabled = false; n.textContent = "See my plan"; } return; }
  obGo();
}

// ---- plan: AI narrative (POST /api/nutritionist mode:plan). Hosted AI "just works" when entitled;
// if it's unavailable the error surfaces inline rather than blocking Finish. ----
async function obPlan() {
  if (OB._planned) return;
  OB._planned = true;
  const box = $("#obPlan");
  try {
    const r = await api("/api/nutritionist", { method: "POST", json: { mode: "plan" } });
    if (box) box.textContent = r.reply || "(no plan)";
    // Persist the setup narrative so the Plan tab's "Show full plan" can render it (spec §2.4). Best-
    // effort: a failed save must not break onboarding. refreshMe() is already called on finish.
    if (r.reply) { try { await api("/api/goals", { method: "PATCH", json: { plan_summary: r.reply } }); } catch (_) {} }
  } catch (e) {
    if (box) box.textContent = (e && e.message) || "Couldn’t generate a plan right now.";
  }
}

// ---- finish / dismiss ----
async function obDismiss() {
  // "Skip setup" from the welcome step still marks onboarded so the wizard doesn't reappear.
  try { await api("/api/goals", { method: "PATCH", json: { onboarded: true } }); await refreshMe(); }
  catch (_) {}
  obClose();
  showView("home");
}
function obFinish() {
  const M = me();
  if (M && M.app_name) { const b = $("#brandName"); if (b) b.textContent = M.app_name; }
  obClose();
  showView("home");
}

// The onboarding view is overlay-only (no tab container); render() is required by the contract but
// unused. app.js drives it via openView('onboarding') → open().
export function render() {}
registerView("onboarding", { render, open });
