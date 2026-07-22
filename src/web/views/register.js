// Sate v2 SPA — Edition registration (NEW screen). First-run edition pick, shown by app.js
// (openView('register')) when me.edition is empty — i.e. right after the very first sign-in.
//
// Two choices, presented as selectable .plan-cards inside the full-screen .onboard host:
//   • Hosted  (prominent, pre-selected, "Recommended" badge + 30-day free-trial banner) — the managed
//     cloud edition where AI "just works" when entitled (sate_hosted). This is the primary CTA.
//   • Self-Hosted (visible but visually de-emphasized, no badge) — BYOAI: run your own Docker + your
//     own AI keys. A clear .ob-warn spells out that this is NOT the managed experience, and choosing
//     it requires a deliberate confirmDialog before we commit.
//
// Selecting one → POST /api/register { edition } (records the edition + provisions that edition's
// 30-day trial via the shared entitlements plane; see api/account.ts). Then refreshMe() so APP.me
// reflects the new edition/entitlements, and proceed: onboarding wizard if not yet onboarded, else
// straight to Home.
//
// Owns exactly this file. Reuses lib.js helpers + the ported .onboard/.ob-*/.plan-card/.plan-badge/
// .trial-banner CSS (no new global CSS). Nothing native here; no isNative() bridges needed. The
// screen has no dismiss — picking an edition is a required first-run step.

"use strict";

import {
  $, $$, el, esc, api, toast, me, refreshMe, showView, openView,
  registerView, permanentAccess, accessNote,
} from "../lib.js";

// The dynamically-created full-screen .onboard element (null when closed), the current pick, and the
// stage ("pick" | "confirm"). Hosted is the default so the primary CTA is always live. We build/remove
// the host ourselves (there is no static node in index.html), mirroring the onboarding wizard.
// NOTE: the full-screen .onboard host sits above lib's dialog/sheet overlays (z-index), so the
// deliberate self-host confirmation is an inline second stage here rather than a confirmDialog.
let host = null;
let sel = "hosted";
let stage = "pick";

// ============================================================ entry point
// open() is invoked by app.js after /api/me loads for a user with no edition yet. Idempotent: a second
// call while the screen is up is a no-op.
export function open() {
  if (host) return;
  sel = "hosted";
  stage = "pick";
  host = el("div", { class: "onboard" },
    el("div", { class: "onboard-card" },
      el("div", { class: "onboard-body", id: "registerBody" })));
  ($("#overlay") || document.body).appendChild(host);
  draw();
}

function close() { if (host) { host.remove(); host = null; } }

// ============================================================ render + wire
// Trusted markup; the only interpolated dynamic value (app_name) is run through esc().
function draw() {
  const body = $("#registerBody");
  if (!body) return;
  if (host) host.scrollTop = 0;
  if (stage === "confirm") return drawConfirm(body);

  const app = (me() && me().app_name) || "Sate";
  const hostedOn = sel === "hosted";
  const selfOn = sel === "selfhost";
  // god / friends-and-family / paid-forever holders already have permanent access. Offering them a
  // "30-day free trial" is wrong and alarming — it reads as though their access is about to lapse.
  // Tell them what they have instead, and drop the trial pitch from the card and the CTA.
  const perm = permanentAccess();

  body.innerHTML =
    `<h2 style="text-align:center;margin-top:6px">Welcome to ${esc(app)}</h2>` +
    `<p class="ob-sub" style="text-align:center">Choose how you want to run ${esc(app)}. You can switch later in settings.</p>` +
    '<div class="plan-cards">' +
      `<button type="button" class="plan-card${hostedOn ? " on" : ""}" data-ed="hosted">` +
        `<span class="plan-name">${esc(app)} Hosted <span class="plan-badge">Recommended</span></span>` +
        (perm ? '' : '<span class="plan-price">Free for 30 days</span>') +
        '<span class="plan-desc">AI just works — nothing to set up. Fully managed in the cloud, with automatic updates and your coach ready out of the box.</span>' +
      '</button>' +
      `<button type="button" class="plan-card${selfOn ? " on" : ""}" data-ed="selfhost">` +
        '<span class="plan-name">Self-Hosted</span>' +
        '<span class="plan-desc">For tinkerers: run your own Docker instance and bring your own AI provider keys. Full control — but you operate and maintain it.</span>' +
      '</button>' +
    '</div>' +
    (hostedOn && perm ? `<div class="trial-banner">✨ ${accessNote()}</div>` : '') +
    (hostedOn && !perm
      ? '<div class="trial-banner">✨ Your 30-day free trial starts now — no card required. AI coaching, food search, and proactive check-ins all included.</div>'
      : '') +
    (selfOn
      ? '<div class="ob-warn"><b>Self-hosting is not the managed experience.</b> You’ll run the Sate Docker container yourself and supply your own AI provider keys (OpenAI, Gemini, etc.). There is no managed cloud, no automatic updates, and no built-in AI — it’s all on you.</div>'
      : '') +
    '<div class="ob-nav"><span></span>' +
      `<button type="button" class="primary" id="regNext">${
        selfOn ? "Continue with self-host" : perm ? "Get started" : "Start free trial"
      }</button>` +
    '</div>';

  $$(".plan-card[data-ed]").forEach((b) => (b.onclick = () => { sel = b.dataset.ed; draw(); }));
  const n = $("#regNext");
  if (n) n.onclick = () => (sel === "selfhost" ? gotoConfirm() : commit("hosted"));
}

// The deliberate self-host confirmation stage. Visible + explicit — the user must knowingly opt in.
function drawConfirm(body) {
  body.innerHTML =
    '<h2 style="margin-top:6px">Confirm self-host</h2>' +
    '<div class="ob-warn"><b>You’re choosing to run Sate yourself.</b><br>' +
    'That means you host the Sate Docker container on your own machine and supply your own AI provider keys (OpenAI, Gemini, etc.). ' +
    'There is no managed cloud, no automatic updates, and no built-in AI — it’s all on you. Hosted is the recommended, zero-setup option.</div>' +
    '<div class="ob-nav"><button type="button" class="link" id="regBack">Go back</button>' +
      '<button type="button" class="primary" id="regGo">Yes, I’ll self-host</button></div>';
  const back = $("#regBack"); if (back) back.onclick = () => { stage = "pick"; draw(); };
  const go = $("#regGo"); if (go) go.onclick = () => commit("selfhost");
}

function gotoConfirm() { stage = "confirm"; draw(); }

// ============================================================ commit
// POST /api/register { edition } → provisions that edition's 30-day trial → refresh shared state →
// proceed into onboarding (if needed) or Home.
async function commit(edition) {
  const btn = $("#regGo") || $("#regNext");
  if (btn) { btn.disabled = true; btn.textContent = "Setting up…"; }
  try {
    await api("/api/register", { method: "POST", json: { edition } });
    await refreshMe(); // pull the new edition + trial entitlements into APP.me
  } catch (e) {
    toast((e && e.message) || "Couldn’t register — try again.");
    draw(); // rebuild resets the button to its enabled state
    return;
  }

  close();
  // Editioned now; if the user still needs onboarding, drop straight into the wizard, else Home.
  const m = me() || {};
  if (!m.onboarded) openView("onboarding");
  else showView("home");
}

// Overlay-only view (no tab container); render() is required by the contract but unused. app.js drives
// it via openView('register') → open().
export function render() {}
registerView("register", { render, open });
