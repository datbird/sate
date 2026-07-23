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

// ---- "Scheduled" section: the recurring plan manager (spec §8.2).
async function loadSchedules() {
  const list = UI.schedList;
  list.innerHTML = '<div class="loadrow"><span class="spinner"></span><span>Loading…</span></div>';
  let schedules = [];
  try {
    schedules = (await api("/api/plan/schedules")).schedules || [];
  } catch (e) {
    list.innerHTML = '<div class="hint">Couldn’t load schedules — ' + esc(e.message) + "</div>";
    return;
  }
  list.innerHTML = "";
  if (!schedules.length) {
    list.appendChild(el("div", { class: "hint" }, "No recurring plans yet. Tap ", el("b", {}, "Plan"), " above and pick a repeat to create one."));
    return;
  }
  // Soonest-next first; schedules with no upcoming occurrence sink to the bottom.
  const today = todayISO();
  schedules
    .map((s) => ({ s, next: nextOccurrence(s, today) }))
    .sort((a, b) => (a.next || "9999").localeCompare(b.next || "9999"))
    .forEach(({ s, next }) => list.appendChild(scheduleRow(s, next)));
}

const KIND_ICON = {
  food: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3v7a2 2 0 0 0 4 0V3"/><path d="M10 12v9"/><ellipse cx="16" cy="6.4" rx="2.2" ry="3.4"/><path d="M16 9.8V21"/></svg>',
  activity: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="13" cy="4" r="1"/><path d="M4 17l5 1 .75-1.5"/><path d="M15 21v-4l-4-3 1-6"/><path d="M7 12V9l5-1 3 3 3 1"/></svg>',
};

function scheduleRow(s, next) {
  const icon = el("span", { class: "sched-ico " + (s.kind === "activity" ? "a" : "n"),
    html: KIND_ICON[s.kind === "activity" ? "activity" : "food"] });
  const nextLabel = next ? "Next: " + prettyDate(next) : "No upcoming occurrence";
  const text = el("div", { class: "sched-text" },
    el("span", { class: "sched-name" }, esc(s.name || "(unnamed)")),
    el("span", { class: "sched-sub" }, esc(recurrenceSummary(s)) + " · " + esc(nextLabel)));
  const del = el("button", { class: "sched-del", type: "button", "aria-label": "Delete", title: "Delete",
    html: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M9 7V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2M6 7l1 13a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-13"/></svg>' });
  del.addEventListener("click", (ev) => { ev.stopPropagation(); deleteSchedule(s); });
  const row = el("div", { class: "sched-row", role: "button", tabindex: "0" }, icon, text, del);
  row.addEventListener("click", () => openView("planevent", { schedule: s, mode: "edit" }));
  return row;
}

// A short absolute date label ("Mon, Jul 27") from a YYYY-MM-DD, parsed as a UTC anchor so it never
// tz-shifts a day. (The pure helper returns the label-free date; formatting stays in the DOM layer.)
function prettyDate(ymd) {
  const d = new Date(ymd + "T00:00:00Z");
  return d.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
}

async function deleteSchedule(s) {
  const ok = await confirmDialog("Delete “" + (s.name || "this plan") + "” and all its future occurrences?",
    { title: "Delete schedule", confirmLabel: "Delete", danger: true });
  if (!ok) return;
  try {
    await api("/api/plan/schedules/" + s.id, { method: "DELETE" });
    toast("Schedule deleted");
    loadSchedules();
  } catch (e) { toast(e.message); }
}

function renderLogPlan() {}

registerView("plan", { container: "#view-plan", render });
export { render };
