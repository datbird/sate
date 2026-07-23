// Sate v2 SPA — Goals & tracking sheet. Opened from the account menu / "Set goals" (both are
// [data-open="goals"] → openView('goals')). Faithful port of v1's goalsDialog (app.js openGoals /
// goalsForm submit / loadGoalWeightGoals / recomputeTargets):
//
//   • tracking-mode <select> (calories/carb/protein/fat/balanced/heart) with a live hint;
//   • the five daily goal fields (kcal/protein/carbs/fat/sodium);
//   • net-exercise toggle (add workout burn to the day's budget);
//   • activity level + a weight-goals editor (add/remove, capped at 3) backed by /api/weight/goals;
//   • "Recompute targets" → POST /api/plan/compute (deterministic BMR/TDEE), fills the goal fields;
//   • coach check-in opt-in + frequency (shown only when the instance enables check-ins);
//   • Apple-Health sync + heart-rate calorie method — NATIVE ONLY, gated behind isNative() so the
//     web build never renders them (no HealthKit bridge on web).
//
// Save → PATCH /api/goals, then refreshMe() + re-render Home so the ring picks up new goals/mode.

"use strict";

import {
  $, $$, el, api, me, registerView, sheet, toast, refreshMe, view,
} from "../lib.js";
import { render as renderHome } from "./home.js";

// ------------------------------------------------------------------ constants
const MODE_OPTS = [
  ["calories", "Calories (simple)"],
  ["carb", "Carb-focused (low-carb / keto / diabetic)"],
  ["protein", "High-protein"],
  ["fat", "Low-fat"],
  ["balanced", "Balanced macros"],
  ["heart", "Heart-healthy"],
];
// Per-mode explainer under the tracking-mode picker (v1 MODES[*].hint — lib.MODES omits these).
const MODE_HINTS = {
  calories: "The ring counts calories. Only a daily calorie goal is needed.",
  carb: "The ring counts net carbs (carbs − fiber) toward your carb goal. Covers low-carb, keto, and diabetic carb-counting.",
  protein: "The ring counts protein toward your protein goal.",
  fat: "The ring counts fat toward your fat goal.",
  balanced: "The ring counts calories; protein, carbs, and fat each show progress toward their goals.",
  heart: "The ring counts sodium toward a daily limit; saturated fat and fiber are shown too.",
};
const ACT_OPTS = [
  ["sedentary", "Sedentary"],
  ["light", "Light (1-3 d/wk)"],
  ["moderate", "Moderate (3-5 d/wk)"],
  ["active", "Active (6-7 d/wk)"],
  ["athlete", "Athlete"],
];
const todayISO = () => new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);

// ------------------------------------------------------------------ builders
function optionEls(opts, selected) {
  return opts.map(([v, l]) => el("option", { value: v, selected: String(v) === String(selected) || undefined }, l));
}
// A stacked label+number-input goal field (styled by the .field class).
function goalField(labelText, name, value) {
  return el("label", { class: "field" }, labelText,
    el("input", { type: "number", name, min: "0", inputmode: "numeric", value: value ? String(value) : "" }));
}

// ------------------------------------------------------------------ open
export function open() {
  const M = me() || {};
  const g = M.goals || {};

  // ---- tracking mode + hint
  const modeSel = el("select", { id: "goalMode", name: "track_mode" }, optionEls(MODE_OPTS, M.track_mode || "calories"));
  const modeHint = el("p", { class: "hint", id: "goalModeHint" });
  const setHint = () => { modeHint.textContent = MODE_HINTS[modeSel.value] || MODE_HINTS.calories; };
  modeSel.addEventListener("change", setHint);
  setHint();
  const modeLabel = el("label", {}, "What are you tracking?", modeSel);

  // ---- five goal fields (v1 goalgrid)
  const grid = el("div", { style: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: "8px 12px", marginBottom: "14px" } },
    goalField("Calories", "goal_kcal", g.kcal),
    goalField("Protein (g)", "goal_protein", g.protein),
    goalField("Carbs (g)", "goal_carbs", g.carbs),
    goalField("Fat (g)", "goal_fat", g.fat),
    goalField("Sodium (mg)", "goal_sodium", g.sodium),
  );

  // ---- daily activity calorie-burn goal (drives the Activity ring + the All "out" target)
  const burnField = el("label", { class: "field", style: { marginBottom: "14px" } },
    "Daily calorie burn (activity)",
    el("input", { type: "number", name: "goal_burn", min: "0", inputmode: "numeric", value: g.burn ? String(g.burn) : "" }));

  // (net-exercise, show-weight-in-All, Apple Health sync, heart-rate method, and check-ins now live
  // in the Settings sheet — this sheet is just the targets.)

  // ---- activity level (universal)
  const actSel = el("select", { id: "goalActivity" },
    el("option", { value: "" }, "— set —"), ...optionEls(ACT_OPTS, M.activity_level || ""));

  // ---- weight-goals editor (list + inline add form)
  const wgList = el("div", { id: "goalWeightGoals" });
  const wgAddForm = el("div"); // inline add form host (toggled)
  wgAddForm.hidden = true;
  const addBtn = el("button", { type: "button", class: "link" }, "+ Add weight goal");
  const recomputeBtn = el("button", { type: "button", class: "link" }, "Recompute targets");
  const wgActions = el("div", { class: "row", style: { gap: "10px", marginTop: "6px" } }, addBtn, recomputeBtn);

  const weightSection = el("div", { class: "wgsection" },
    el("div", { class: "wglabel" }, "Weight & goals"),
    el("label", { class: "healthintlbl" }, "Activity level", actSel),
    wgList, wgAddForm, wgActions);

  // ---- save (pinned footer — always visible while the body scrolls)
  const saveBtn = el("button", { type: "button", class: "primary" }, "Save");

  // ---- assemble the form (targets only)
  const form = el("form", { id: "goalsForm" }, modeLabel, modeHint, grid, burnField, weightSection);
  form.addEventListener("submit", (e) => e.preventDefault());

  const s = sheet({ title: "Goals", body: form, footer: saveBtn });

  // ---- weight-goals list (GET/POST/DELETE /api/weight/goals), capped at 3
  async function loadWeightGoals() {
    let goals = [];
    try { goals = (await api("/api/weight/goals")).goals || []; } catch (_) {}
    wgList.innerHTML = "";
    if (!goals.length) {
      wgList.appendChild(el("div", { class: "hint", style: { fontSize: "12px", margin: "6px 0" } }, "No weight goals yet."));
    } else {
      goals.forEach((wg) => {
        const del = el("button", { type: "button", class: "link danger" }, "remove");
        del.addEventListener("click", async () => {
          try { await api("/api/weight/goals/" + wg.id, { method: "DELETE" }); loadWeightGoals(); }
          catch (er) { toast(er.message); }
        });
        wgList.appendChild(el("div", { class: "wgrow" },
          el("span", {}, Math.round(wg.target_lb) + " lb by " + wg.target_date), del));
      });
    }
    // The add button is hidden once the user hits the 3-goal cap (server enforces too).
    addBtn.hidden = goals.length >= 3;
  }

  // Inline add-goal form (v1 used prompt()×2; the sheet keeps it in-page so scroll-lock isn't broken).
  addBtn.addEventListener("click", () => {
    if (!wgAddForm.hidden) { wgAddForm.hidden = true; wgAddForm.innerHTML = ""; return; }
    const lbInput = el("input", { type: "number", min: "0", step: "0.1", inputmode: "decimal", placeholder: "Target weight" });
    const dateInput = el("input", { type: "date", value: todayISO() });
    const save = el("button", { type: "button", class: "primary small" }, "Add");
    const cancel = el("button", { type: "button", class: "link" }, "Cancel");
    save.addEventListener("click", async () => {
      const lb = parseFloat(lbInput.value);
      const date = (dateInput.value || "").trim();
      if (!(lb > 0)) { toast("Enter a target weight"); return; }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { toast("Enter a date as YYYY-MM-DD"); return; }
      try {
        await api("/api/weight/goals", { method: "POST", json: { target_lb: lb, target_date: date } });
        wgAddForm.hidden = true; wgAddForm.innerHTML = "";
        loadWeightGoals();
      } catch (er) { toast(er.message); }
    });
    cancel.addEventListener("click", () => { wgAddForm.hidden = true; wgAddForm.innerHTML = ""; });
    wgAddForm.innerHTML = "";
    wgAddForm.appendChild(el("div", { class: "field" }, "Target weight (lb)", lbInput));
    wgAddForm.appendChild(el("div", { class: "field" }, "Target date", dateInput));
    wgAddForm.appendChild(el("div", { class: "row end" }, cancel, save));
    wgAddForm.hidden = false;
  });

  // Recompute calorie/macro targets from saved stats + the chosen mode/activity (POST /api/plan/compute).
  recomputeBtn.addEventListener("click", async () => {
    try {
      const r = await api("/api/plan/compute", { method: "POST", json: { method: modeSel.value, activity: actSel.value || undefined } });
      const t = r.targets || {};
      form.goal_kcal.value = t.kcal ?? "";
      form.goal_protein.value = t.protein ?? "";
      form.goal_carbs.value = t.carbs ?? "";
      form.goal_fat.value = t.fat ?? "";
      form.goal_sodium.value = t.sodium ?? "";
      toast(r.warnings && r.warnings.length ? r.warnings[0] : "Targets recomputed — Save to keep them");
    } catch (er) { toast(er.message); }
  });

  // Save everything the sheet owns → PATCH /api/goals, then refresh state + Home.
  saveBtn.addEventListener("click", async () => {
    const payload = {
      track_mode: modeSel.value,
      goal_kcal: form.goal_kcal.value,
      goal_protein: form.goal_protein.value,
      goal_carbs: form.goal_carbs.value,
      goal_fat: form.goal_fat.value,
      goal_sodium: form.goal_sodium.value,
      goal_burn: form.goal_burn.value,
    };
    if (actSel.value) payload.activity_level = actSel.value;
    try {
      await api("/api/goals", { method: "PATCH", json: payload });
      await refreshMe();
      toast("Goals saved");
      s.close();
      try { renderHome(); } catch (_) {}
      // Plan tab isn't necessarily mounted/on-screen — re-render it in place (best-effort) so its
      // "Your Plan" card doesn't show stale targets if the user tabs back without a full reload.
      try { const p = view("plan"); if (p && p.render) { const c = document.querySelector("#view-plan"); if (c) p.render(c); } } catch (_) {}
    } catch (er) { toast(er.message); }
  });

  loadWeightGoals();
}

// Contract-required render (unused for overlay views).
export function render() {}

registerView("goals", { render, open });
