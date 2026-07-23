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
  renderYourPlan();
  loadSchedules(); // Task 6
  renderLogPlan(); // Task 7
}

// ---- "Your Plan" card: server-authoritative targets + edit + full-plan narrative.
//
// DEVIATION FROM BRIEF: the brief's Step 1 renders the targets as a tripleRingCard (protein/carbs/fat
// rings at 100%, value===goal). Per the controller's ruling for this task, targets render as plain
// VALUE CHIPS instead ("1,850 kcal · 150g protein · 180g carbs · 60g fat") — this card shows the
// PLAN's targets, not eaten-vs-goal progress, so a 100%-filled ring is misleading UI. Everything else
// (edit-via-Goals, Show-full-plan modal, weight-goal line, onboarding persist) follows the brief as
// written.
async function renderYourPlan() {
  const card = UI.planCard;
  const m = me() || {};
  const g = m.goals || {};
  const method = m.track_mode || "calories";
  const activity = m.activity_level || "";

  const kcalLine = el("div", { class: "plan-kcal" },
    el("strong", {}, fmt(g.kcal || 0)), el("small", {}, " kcal/day target"));

  // Macro targets as plain value chips (server truth — g.* comes straight from me().goals).
  const chips = el("div", { class: "plan-chips" },
    macroChip("Protein", g.protein, "g"),
    macroChip("Carbs", g.carbs, "g"),
    macroChip("Fat", g.fat, "g"),
  );

  const metaLine = el("div", { class: "plan-meta" },
    "Method: " + esc(labelForMethod(method)) + (activity ? " · Activity: " + esc(labelForActivity(activity)) : ""));

  const editBtn = el("button", { class: "link", type: "button", text: "Edit plan",
    onClick: () => openView("goals") });
  const fullBtn = el("button", { class: "link", type: "button", text: "Show full plan", onClick: showFullPlan });
  if (!(m.plan_summary || "").trim()) fullBtn.disabled = true;
  const actions = el("div", { class: "plan-actions" }, editBtn, fullBtn);

  card.innerHTML = "";
  card.className = "statcard yourplan";
  card.append(el("h3", { class: "section", style: { marginTop: "0" } }, "Your Plan"),
    kcalLine, chips, metaLine, weightGoalsLine(), actions);
}

// One "150g protein"-style chip. Omitted (not "0g") when the target isn't set.
function macroChip(label, value, unit) {
  return el("span", { class: "plan-chip" },
    value ? fmt(value) + unit + " " + label : "— " + label);
}

// Human labels (kept local + tiny; the Goals dialog owns the authoritative option lists).
function labelForMethod(m) {
  return ({ calories: "Calories", carb: "Carb-focused", protein: "High-protein", fat: "Low-fat", balanced: "Balanced", heart: "Heart-healthy" })[m] || m;
}
function labelForActivity(a) {
  return ({ sedentary: "Sedentary", light: "Light", moderate: "Moderate", active: "Active", athlete: "Athlete" })[a] || a;
}

// A one-line weight-goal readout (server truth via /api/weight/goals). Empty → "Maintenance".
function weightGoalsLine() {
  const line = el("div", { class: "plan-meta plan-weightgoals" }, "Weight goal: …");
  api("/api/weight/goals").then((r) => {
    const goals = (r && r.goals) || [];
    line.textContent = goals.length
      ? "Weight goal: " + goals.map((wg) => Math.round(wg.target_lb) + " lb by " + wg.target_date).join(" · ")
      : "Weight goal: Maintenance";
  }).catch(() => { line.textContent = "Weight goal: Maintenance"; });
  return line;
}

// "Show full plan" → a modal rendering the persisted Coach narrative (profiles.plan_summary).
function showFullPlan() {
  const summary = (me() || {}).plan_summary || "";
  const body = summary
    ? el("div", { class: "fullplan-text" }, ...summary.split(/\n{2,}/).map((p) => el("p", {}, p)))
    : el("div", { class: "hint" }, "No saved plan narrative yet. Your Coach writes this at setup — finish onboarding or ask the Coach to build your plan.");
  // esc: paragraphs are added as text nodes (el's string children are textContent), so no HTML injection.
  dialog({ title: "Your full plan", body });
}

// Task 6/7 stubs — replaced when those tasks land.
function loadSchedules() {}
function renderLogPlan() {}

registerView("plan", { container: "#view-plan", render });
export { render };
