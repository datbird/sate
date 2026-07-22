// Sate v2 SPA — Upgrade / checkout (NEW screen). Owned by the upgrade agent.
//
// This is the HOSTED-edition monetization surface. It shows the paid plans and starts Stripe
// checkout, reflects the trial countdown from /api/me.entitlements.expiring[sate_hosted], and lets
// the user switch edition (hosted ⇄ self-host). It also self-mounts a subtle trial banner in the
// shell (top of #app) that reads the same entitlement state on every view change: a countdown while
// the trial is active/expiring, and a hard "trial ended — AI paused" prompt once the sate_hosted
// entitlement has lapsed.
//
// API:
//   POST /api/checkout { plan: 'hosted_monthly'|'hosted_yearly'|'selfhost' } → { url }  (Stripe → redirect)
//   POST /api/edition  { edition: 'hosted'|'selfhost' }                        (switch edition; starts its trial)
//   GET  /api/me       (read via me()/refreshMe(): edition, entitlements.skus, entitlements.expiring)
//
// Opened from the account menu's "Upgrade" (data-open="upgrade") and from the shell trial banner.
"use strict";

import {
  $, el, api, me, hasSku, hostedExpiry, permanentAccess, accessNote, refreshMe, toast, busy, safeUrl,
  confirmDialog, registerView, onViewChange, sheet,
} from "../lib.js";

// ============================================================ plan catalog
// Hosted subscription + the self-host BYOAI license. `plan` values are exactly what /api/checkout
// expects. Yearly leads (best value); self-host is the BYOAI escape hatch (its own edition/SKU).
const PLANS = [
  {
    plan: "hosted_yearly", name: "Yearly", price: "$39.99/yr", badge: "Best value",
    desc: "Cloud AI included — everything just works. Two months free vs monthly.",
  },
  {
    plan: "hosted_monthly", name: "Monthly", price: "$4.99/mo",
    desc: "Cloud AI included — everything just works. Cancel anytime.",
  },
  {
    plan: "selfhost", name: "Self-host license", price: "$9.99 once",
    desc: "Run your own Docker and bring your own AI keys (BYOAI). One-time license.",
  },
];
const DEFAULT_PLAN = "hosted_yearly";

// ============================================================ entitlement helpers
// Whole days from now until an ISO instant (min 0). Rounds up so "expires later today" reads "1".
function daysLeft(iso) {
  const ms = new Date(String(iso).replace(" ", "T")).getTime() - Date.now();
  if (!isFinite(ms)) return 0;
  return Math.max(0, Math.ceil(ms / 86400000));
}
const aiEntitled = () => hasSku("sate_hosted");

// ============================================================ actions
// Start Stripe checkout for a plan and hand off to the returned URL. safeUrl() keeps the redirect to
// http(s) only (a hostile/misconfigured URL collapses to "#" and we surface an error instead).
async function checkout(plan) {
  try {
    busy(plan === "selfhost" ? "Preparing your license…" : "Starting checkout…");
    const r = await api("/api/checkout", { method: "POST", json: { plan } });
    const url = safeUrl(r && r.url);
    if (url && url !== "#") { window.location.assign(url); return; }
    toast("Couldn't start checkout — please try again.");
  } catch (e) { toast(e.message); }
}

// Switch edition (hosted ⇄ selfhost). Server starts the new edition's trial if never trialed. After
// the switch we refresh /api/me so the banner + menu reflect the new state, then re-sync the banner.
async function switchEdition(edition, ctrl) {
  const toHosted = edition === "hosted";
  const okGo = await confirmDialog(
    toHosted
      ? "Switch to the Hosted edition? Cloud AI is included and just works."
      : "Switch to the Self-host edition? You'll run your own Docker and bring your own AI keys.",
    { title: toHosted ? "Switch to Hosted" : "Switch to Self-host", confirmLabel: "Switch" },
  );
  if (!okGo) return;
  try {
    await api("/api/edition", { method: "POST", json: { edition } });
    await refreshMe();
    toast(toHosted ? "Now on the Hosted edition" : "Now on the Self-host edition");
    if (ctrl) ctrl.close();
    ensureBanner();
  } catch (e) { toast(e.message); }
}

// ============================================================ the upgrade sheet
export function open() {
  const ctrl = sheet({ title: "Sate Plus", className: "addsheet" });
  ctrl.setBody((body) => build(body, ctrl));
  return ctrl;
}

function build(body, ctrl) {
  body.innerHTML = "";
  const m = me() || {};
  const entitled = aiEntitled();
  const exp = hostedExpiry(m);

  // ---- status line: full-access note, trial countdown, gated prompt, or active-plan note
  // Permanent holders (god / friends-and-family / paid-forever) get an explicit acknowledgement of
  // what they have — and nothing to buy. Rendering plan cards and a "Continue to checkout" button at
  // someone whose access never expires is just confusing, so we stop here and keep only the
  // switch-edition affordance below.
  if (permanentAccess(m)) {
    body.appendChild(el("div", {
      class: "trial-banner", style: { margin: "0 0 14px" },
      html: "✨ " + accessNote(m),
    }));
    appendEditionFooter(body, m, ctrl);
    return;
  }
  if (!entitled) {
    body.appendChild(el("div", {
      class: "trial-banner", style: { borderColor: "var(--danger)", margin: "0 0 14px" },
      html: "<b>Your trial has ended.</b> AI features are paused until you upgrade — pick a plan below to turn them back on.",
    }));
  } else if (exp) {
    const d = daysLeft(exp);
    body.appendChild(el("div", {
      class: "trial-banner", style: { margin: "0 0 14px" },
      html: `<b>${d} day${d === 1 ? "" : "s"} left</b> in your Sate trial. Upgrade any time to keep cloud AI running — no interruption.`,
    }));
  } else {
    body.appendChild(el("p", {
      class: "hint", style: { margin: "0 0 12px" },
      text: "You're on an active plan. Switch or renew below.",
    }));
  }

  // ---- selectable plan cards (single-select; DEFAULT_PLAN preselected)
  let selected = DEFAULT_PLAN;
  const cards = el("div", { class: "plan-cards" });
  const cont = el("button", { class: "primary", type: "button" });
  const paintCta = () => {
    cont.textContent = selected === "selfhost" ? "Get self-host license" : "Continue to checkout";
  };
  PLANS.forEach((p) => {
    const card = el("button", {
      class: "plan-card" + (p.plan === selected ? " on" : ""), type: "button",
      dataset: { plan: p.plan },
      onClick: () => {
        selected = p.plan;
        cards.querySelectorAll(".plan-card").forEach((c) =>
          c.classList.toggle("on", c.dataset.plan === selected));
        paintCta();
      },
    },
      el("span", { class: "plan-name" }, p.name, p.badge ? el("span", { class: "plan-badge", text: p.badge }) : null),
      el("span", { class: "plan-price", text: p.price }),
      el("span", { class: "plan-desc", text: p.desc }),
    );
    cards.appendChild(card);
  });
  body.appendChild(cards);

  // ---- primary CTA → checkout
  paintCta();
  cont.addEventListener("click", () => checkout(selected));
  body.appendChild(cont);

  appendEditionFooter(body, m, ctrl);
}

// The switch-edition affordance (POST /api/edition) — offers the OTHER edition. Shared by the
// buy-a-plan path and the permanent-access path, which shows it without any plan cards.
function appendEditionFooter(body, m, ctrl) {
  const otherEdition = (m.edition === "selfhost") ? "hosted" : "selfhost";
  const footer = el("div", { style: { marginTop: "16px", textAlign: "center" } },
    el("button", {
      class: "link", type: "button",
      text: otherEdition === "selfhost"
        ? "Prefer to self-host? Switch to the Self-host edition"
        : "Back to the Hosted edition",
      onClick: () => switchEdition(otherEdition, ctrl),
    }),
    permanentAccess(m) ? null : el("p", {
      class: "hint", style: { margin: "8px 0 0" },
      text: "Plans renew automatically. Manage or cancel any time from your billing portal.",
    }),
  );
  body.appendChild(footer);
}

// ============================================================ shell trial banner
// Self-mounted at the top of #app so the whole app shows trial state without app.js changes. Kept in
// sync on every view change (onViewChange) and after any edition/checkout mutation here. Hidden when
// there's nothing to say (paid + no expiry, or not on the hosted edition). Reads only shared state —
// never the network — so it's cheap to run on each navigation.
function bannerState() {
  const m = me();
  if (!m) return null;
  // This is the hosted SPA: only surface trial/gated state for the hosted edition. edition==="" is
  // handled by the register flow; self-host manages its own licensing.
  if (m.edition !== "hosted") return null;
  if (permanentAccess(m)) return null; // god / family / paid-forever — no trial or upgrade nag
  const exp = hostedExpiry(m);
  const entitled = aiEntitled();
  if (entitled && exp) {
    const d = daysLeft(exp);
    return d > 0 ? { kind: "trial", days: d } : null;
  }
  if (!entitled) return { kind: "gated" };
  return null; // paid + entitled, nothing to prompt
}

let _gatedPrompted = false;
function ensureBanner() {
  const app = $("#app");
  if (!app) return;
  let b = $("#trialBanner");
  const st = bannerState();
  if (!st) { if (b) b.hidden = true; return; }
  if (!b) {
    b = el("div", {
      id: "trialBanner", class: "trial-banner", role: "button", tabindex: "0",
      style: { cursor: "pointer" },
      onClick: () => open(),
    });
    b.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); }
    });
    app.insertBefore(b, app.firstChild);
  }
  b.hidden = false;
  if (st.kind === "trial") {
    b.style.borderColor = "";
    b.innerHTML =
      `<b>${st.days} day${st.days === 1 ? "" : "s"} left</b> in your Sate trial · ` +
      `<span style="color:var(--brand);font-weight:700">Upgrade →</span>`;
  } else {
    b.style.borderColor = "var(--danger)";
    b.innerHTML =
      `<b>Your trial has ended.</b> AI features are paused — ` +
      `<span style="color:var(--brand);font-weight:700">Upgrade to continue →</span>`;
    // Hard prompt: pop the upgrade sheet once per session when AI is gated.
    if (!_gatedPrompted) { _gatedPrompted = true; setTimeout(open, 400); }
  }
}
onViewChange(ensureBanner);

// ============================================================ register with the router
// render() is required by the contract (unused for overlays). open() drives the sheet.
export function render() {}
registerView("upgrade", { render, open });
