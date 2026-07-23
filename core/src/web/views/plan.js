// Sate v2 SPA — Plan tab (spec §8, §9). The management surface (distinct from Home's timeline):
//   • "Your Plan" card — the tracked targets (server-authoritative), editable via the Goals dialog,
//     with "Show full plan" → the persisted Coach narrative (profiles.plan_summary).  [Task 5]
//   • Log · Plan buttons — the same pair as Home.                                       [Task 7]
//   • "Scheduled" section — plan_schedules with a recurrence summary + next occurrence,
//     tap-to-edit (all-scope) + delete-with-confirm.                                    [Task 6]
//
// Registers as a TAB view (container #view-plan) exporting render(container), like home.js/history.js.
// HONESTY: every number on this tab comes from the server (me()/GET /api/plan/compute) — the client
// never re-sums or re-derives targets. Escapes all user/AI text (plan_summary, allergies, schedule
// names) with esc().

"use strict";

import {
  $, el, esc, api, toast, me, refreshMe, openView, registerView, confirmDialog, dialog,
  ringEl, tripleRingCard, fmt, todayISO,
} from "../lib.js";
import { recurrenceSummary, nextOccurrence } from "../planner.js";

// Cached DOM (built once by ensureUI, reused on every show).
let UI = null;

function ensureUI(container) {
  if (UI && container.contains(UI.root)) return UI;
  container.innerHTML = "";
  const planCard = el("div", { id: "yourPlanCard" });
  const logplan = el("div", { class: "logplan", id: "planLogplan" }); // Task 7 fills this
  const schedHead = el("h3", { class: "section" }, "Scheduled");
  const schedList = el("div", { id: "schedList", class: "sched-list" });
  const root = el("div", null, planCard, logplan, schedHead, schedList);
  container.appendChild(root);
  UI = { root, planCard, logplan, schedHead, schedList };
  return UI;
}

// Called by showView('plan') on every show.
function render(container) {
  const host = container || $("#view-plan");
  if (!host) return;
  ensureUI(host);
  // Task 5 fills renderYourPlan(); Task 6 fills loadSchedules(); Task 7 fills renderLogPlan().
  UI.planCard.innerHTML = '<div class="hint">Your plan loads here.</div>';
  UI.schedList.innerHTML = "";
}

registerView("plan", { container: "#view-plan", render });
export { render };
