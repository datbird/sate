// Sate v2 SPA — Plan-an-event overlay (the "Plan" button, spec §9). A bottom sheet that captures a
// future meal or activity: kind → date & time → repeat (none/daily/weekly/monthly) → content, then
// POSTs via the pure planner.buildPlanRequest to /api/plan/entry (one-off) or /api/plan/schedules
// (recurring). "None" makes a planned entry; a repeat makes a schedule the timeline projects.
//
// The recipe suggester (spec §7, Phase 5) is LIVE for meals: a target prefilled from the remaining
// daily budget → AI ideas (/api/recipes/suggest) → a full recipe (/api/recipes/expand) → either
// "Add to plan" (fills this form's F, the user still picks date/time/repeat, then the normal submit()
// below makes a PLANNED entry/schedule via buildPlanRequest) or "Log now" (creates a LOGGED entry via
// /api/plan/entry + /api/plan/accept — NOT /api/foods/manual, which would pollute the shared food KB
// with one-off AI recipes). The recipe (ingredients+steps) is stored in the entry's `note`. Allergies
// are applied SERVER-SIDE from the profile — the client never collects or sends them. All AI-generated
// text (idea names/blurbs, ingredients, steps) renders via textContent (`el({text:...})`), never
// innerHTML, so it can never execute as markup. Food search reuses the existing foodsearch view.
// Reuses lib's sheet()/api()/toast() and the compose manual-food field vocabulary; escapes all user
// text with esc(). After a successful create it refreshes Home so the item lands on the timeline.

"use strict";

import {
  $$, el, esc, api, toast, busy, sheet, openView, registerView, tzOffset, todayISO, view, me, fmt,
} from "../lib.js";
import { buildPlanRequest, remainingBudget } from "../planner.js";
import { render as renderHome } from "./home.js";

const WEEKDAYS = [["S", 0], ["M", 1], ["T", 2], ["W", 3], ["T", 4], ["F", 5], ["S", 6]];
const num = (x) => (x === "" || x == null || isNaN(+x) ? undefined : +x);

// View-local form state for the open sheet.
let F = null;
let planCtrl = null;
let saveBtn = null;
let editing = null; // schedule id when in edit mode; null when creating

export function open(args = {}) {
  const sched = args && args.mode === "edit" && args.schedule ? args.schedule : null;
  editing = sched ? sched.id : null;
  F = {
    kind: (sched ? sched.kind : (args && args.scope === "activity" ? "activity" : "food")),
    description: "", name: sched ? (sched.name || "") : "",
    kcal: "", macros: { protein: "", carbs: "", fat: "" }, duration_min: "", distance: "", intensity: "", note: "",
    date: todayISO(), time: sched ? (sched.time_of_day || "12:00") : "12:00",
    repeat: "none", interval: 1, by_weekday: [], day_of_month: undefined,
  };
  if (sched) prefillFromSchedule(sched);
  planCtrl = sheet({
    title: sched ? "Edit schedule" : "Plan an event",
    className: "plansheet",
    onClose: () => { planCtrl = null; editing = null; },
    body: (b) => renderForm(b),
  });
}

// Map an existing plan_schedule into the form state for edit mode. Recurrence unit → repeat;
// payload numbers → the content fields (top-level for the form, which contentOf re-nests on submit).
function prefillFromSchedule(s) {
  const r = s.recurrence || {};
  F.repeat = r.unit || "daily";
  F.interval = Math.max(1, Number(r.interval) || 1);
  F.by_weekday = Array.isArray(r.by_weekday) ? r.by_weekday.slice() : [];
  F.day_of_month = r.day_of_month;
  F.date = s.active_from || todayISO();
  const p = s.payload || {};
  F.kcal = p.kcal != null ? String(p.kcal) : "";
  F.note = p.note || "";
  if (F.kind === "activity") {
    F.duration_min = p.duration_min != null ? String(p.duration_min) : "";
    F.distance = p.distance != null ? String(p.distance) : "";
    F.intensity = p.intensity || "";
  } else {
    const m = p.macros || {};
    F.macros = { protein: m.protein != null ? String(m.protein) : "", carbs: m.carbs != null ? String(m.carbs) : "", fat: m.fat != null ? String(m.fat) : "" };
  }
}

function renderForm(host) {
  host.innerHTML = "";

  // 1) kind
  const kindSeg = el("div", { class: "seg scope", style: { marginBottom: "12px" } },
    kindBtn("food", "Meal"), kindBtn("activity", "Activity"));
  kindSeg.addEventListener("click", (ev) => {
    const btn = ev.target.closest("button[data-kind]"); if (!btn) return;
    F.kind = btn.dataset.kind;
    $$("button[data-kind]", kindSeg).forEach((x) => x.classList.toggle("on", x.dataset.kind === F.kind));
    renderFill(fillHost);
  });

  // 2) name/description
  const nameInput = el("input", { id: "planName", placeholder: F.kind === "activity" ? "e.g. Morning run" : "e.g. Overnight oats", value: F.name });
  nameInput.addEventListener("input", () => { F.name = nameInput.value; F.description = nameInput.value; });

  // 3) date & time
  const dateInput = el("input", { type: "date", value: F.date });
  dateInput.addEventListener("input", () => { F.date = dateInput.value; });
  const timeInput = el("input", { type: "time", value: F.time });
  timeInput.addEventListener("input", () => { F.time = timeInput.value || "12:00"; });
  const when = el("div", { class: "planrow" },
    el("label", { class: "field" }, "Date", dateInput),
    el("label", { class: "field" }, "Time", timeInput));

  // 4) repeat. A schedule edit is inherently "all"-scope (spec §6) — a schedule can never be turned
  // into a one-off via this form, so edit mode omits "Does not repeat" entirely.
  const REPEAT_OPTS = [["none", "Does not repeat"], ["daily", "Daily"], ["weekly", "Weekly"], ["monthly", "Monthly"]]
    .filter(([v]) => !(editing && v === "none"));
  const repeatSel = el("select", { id: "planRepeat" },
    ...REPEAT_OPTS.map(([v, l]) => el("option", { value: v, ...(v === F.repeat ? { selected: "" } : {}) }, l)));
  const repeatExtra = el("div", { id: "repeatExtra" });
  repeatSel.addEventListener("change", () => { F.repeat = repeatSel.value; renderRepeatExtra(repeatExtra); });

  // 5) fill (content)
  const fillHost = el("div", { id: "planFill" });

  saveBtn = el("button", { class: "primary", type: "button", text: "Add to plan", onClick: submit });

  host.append(
    kindSeg,
    el("label", { class: "field" }, F.kind === "activity" ? "Activity" : "Meal", nameInput),
    when,
    el("label", { class: "field" }, "Repeat", repeatSel),
    repeatExtra,
    fillHost,
    el("div", { class: "sheet-actions", style: { marginTop: "8px" } }, saveBtn),
  );
  renderRepeatExtra(repeatExtra);
  renderFill(fillHost);
}

function kindBtn(key, label) {
  const b = el("button", { type: "button", dataset: { kind: key }, text: label });
  if (key === F.kind) b.classList.add("on");
  return b;
}

// Weekly → weekday chips; monthly → a day-of-month note (defaults to the chosen date's DOM server-side).
function renderRepeatExtra(host) {
  host.innerHTML = "";
  if (F.repeat === "weekly") {
    const row = el("div", { class: "weekdays" });
    WEEKDAYS.forEach(([label, dow]) => {
      const chip = el("button", { type: "button", class: "wchip" + (F.by_weekday.includes(dow) ? " on" : ""), text: label });
      chip.addEventListener("click", () => {
        F.by_weekday = F.by_weekday.includes(dow) ? F.by_weekday.filter((d) => d !== dow) : [...F.by_weekday, dow].sort();
        chip.classList.toggle("on");
      });
      row.appendChild(chip);
    });
    host.append(el("div", { class: "field-lbl", text: "On" }), row);
  } else if (F.repeat === "monthly") {
    host.append(el("div", { class: "hint", text: "Repeats monthly on day " + Number(F.date.slice(8, 10)) + " (clamped to shorter months)." }));
  }
}

// Content fill: manual numbers now; food search seam; recipe seam (Phase 5, disabled).
function renderFill(host) {
  host.innerHTML = "";
  const grid = F.kind === "activity"
    ? [["kcal", "Calories burned", "cal"], ["duration_min", "Duration", "min"], ["distance", "Distance", "mi"]]
    : [["kcal", "Calories", "kcal"], ["protein", "Protein", "g"], ["carbs", "Carbs", "g"], ["fat", "Fat", "g"]];
  const cells = grid.map(([k, label, u]) => {
    const inp = el("input", { type: "number", step: "any", inputmode: "decimal", dataset: { pf: k },
      value: F.kind === "activity" ? (F[k] ?? "") : (k === "kcal" ? F.kcal : (F.macros[k] ?? "")) });
    inp.addEventListener("input", () => {
      if (F.kind === "activity") F[k] = inp.value;
      else if (k === "kcal") F.kcal = inp.value; else F.macros[k] = inp.value;
    });
    return el("label", { class: "mfield" }, el("span", { html: esc(label) + (u ? " <em>(" + esc(u) + ")</em>" : "") }), inp);
  });
  const manual = el("div", { class: "manualgrid" }, ...cells);

  const seams = el("div", { class: "planseams" },
    el("button", { class: "link", type: "button", text: F.kind === "activity" ? "Search activities…" : "Search food…",
      onClick: () => openView("foodsearch", "") }),
    ...(F.kind === "activity" ? [] : [
      el("button", { class: "link", type: "button", text: "✨ Suggest a recipe", onClick: () => openRecipePanel() }),
    ]),
  );

  host.append(el("div", { class: "field-lbl", text: "Details" }), manual, seams);
}

async function submit() {
  if (!F.name.trim() && !F.description.trim()) { toast(F.kind === "activity" ? "Name the activity" : "Name the meal"); return; }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(F.date)) { toast("Pick a date"); return; }
  if (!Number.isInteger(Number(F.interval)) || Number(F.interval) < 1) { toast("Repeat interval must be a whole number ≥ 1"); return; }
  // Normalize numeric strings the pure builder expects (numbers/undefined, not "").
  const form = {
    kind: F.kind, name: F.name, description: F.description || F.name, note: F.note || undefined,
    kcal: num(F.kcal),
    macros: { protein: num(F.macros.protein), carbs: num(F.macros.carbs), fat: num(F.macros.fat) },
    duration_min: num(F.duration_min), distance: num(F.distance), intensity: F.intensity || undefined,
    date: F.date, time: F.time || "12:00",
    repeat: F.repeat, interval: F.interval,
    by_weekday: F.repeat === "weekly" ? F.by_weekday : undefined,
    day_of_month: F.repeat === "monthly" ? Number(F.date.slice(8, 10)) : undefined,
  };
  const req = buildPlanRequest(form, tzOffset());
  busy("Saving plan…");
  if (saveBtn) saveBtn.disabled = true;
  try {
    if (editing) {
      // Editing a schedule directly is inherently "all" (spec §6). Edit mode's repeat <select> omits
      // "none", so buildPlanRequest always returns the schedule POST body here — reuse it as the PATCH
      // body (ScheduleCreate.partial()).
      await api("/api/plan/schedules/" + editing, { method: "PATCH", json: req.body });
      toast("Schedule updated");
    } else {
      await api(req.path, { method: req.method, json: req.body });
      toast(F.repeat === "none" ? "Added to your plan." : "Recurring plan created.");
    }
    if (planCtrl) planCtrl.close();
    planCtrl = null; editing = null;
    try { renderHome(); } catch (_) {}
    try { const p = view("plan"); if (p && p.render) p.render(); } catch (_) {}
  } catch (e) { toast(e.message); if (saveBtn) saveBtn.disabled = false; }
}

// ---- recipe suggester (spec §7): prefilled editable target → ideas → full recipe → plan | log ----
let R = null; // { target, prefs, ideas, chosen, recipe }
let recipeCtrl = null;
let recipeBusy = false; // guards every AI/API call in this panel against a double-fire

// The prefilled target = the remaining daily budget (goal − today's logged totals), editable.
function initRecipeState() {
  const m = me() || {};
  const t = remainingBudget(m.goals, m.totals);
  // If the meal already has numbers typed, prefer those; else use the remaining budget.
  R = {
    target: {
      kcal: num(F.kcal) || t.kcal,
      protein: num(F.macros.protein) || t.protein,
      carbs: num(F.macros.carbs) || t.carbs,
      fat: num(F.macros.fat) || t.fat,
    },
    prefs: "",
    ideas: null,
    chosen: null,
    recipe: null,
  };
}

function openRecipePanel() {
  initRecipeState();
  recipeBusy = false;
  recipeCtrl = sheet({
    title: "Suggest a recipe",
    className: "recipesheet",
    onClose: () => { recipeCtrl = null; },
    body: (b) => renderRecipe(b),
  });
}

function renderRecipe(host) {
  host.innerHTML = "";
  // 1) editable target
  const tgt = el("div", { class: "rtarget" });
  [["kcal", "Calories"], ["protein", "Protein (g)"], ["carbs", "Carbs (g)"], ["fat", "Fat (g)"]].forEach(([k, label]) => {
    const inp = el("input", { type: "number", step: "any", inputmode: "decimal", value: String(R.target[k] || 0) });
    inp.addEventListener("input", () => { R.target[k] = num(inp.value); });
    tgt.append(el("label", { class: "mfield" }, el("span", { text: label }), inp));
  });
  // 2) prefs (free text only — allergies are NEVER collected here; the server applies them from the
  // saved profile, so a client-side field would be redundant at best and spoofable at worst).
  const prefs = el("input", { type: "text", placeholder: "Preferences (optional) — e.g. quick, vegetarian, no oven", value: R.prefs });
  prefs.addEventListener("input", () => { R.prefs = prefs.value; });
  // 3) actions + results
  const results = el("div", { class: "rresults" });
  const go = el("button", { class: "primary", type: "button", text: R.ideas ? "Re-roll" : "Get ideas",
    onClick: () => loadIdeas(results, go) });

  host.append(
    el("div", { class: "field-lbl", text: "Target (prefilled from your remaining budget — edit freely)" }),
    tgt,
    el("label", { class: "field" }, "Preferences", prefs),
    el("div", { class: "sheet-actions", style: { marginTop: "8px" } }, go),
    results,
  );
  if (R.recipe) renderFullRecipe(results);
  else if (R.ideas) renderIdeas(results);
}

async function loadIdeas(results, goBtn) {
  if (recipeBusy) return;
  recipeBusy = true;
  goBtn.disabled = true;
  R.recipe = null; R.chosen = null;
  busy("Finding recipes…");
  try {
    const r = await api("/api/recipes/suggest", { method: "POST",
      json: { target: R.target, method: (me() || {}).track_mode || "", prefs: R.prefs } });
    R.ideas = (r && r.ideas) || [];
    goBtn.textContent = "Re-roll";
    renderIdeas(results);
  } catch (e) { toast(e.message); } finally { recipeBusy = false; goBtn.disabled = false; }
}

// Every idea/blurb/ingredient/step below is untrusted AI output — rendered exclusively via the `text`
// prop (Node.textContent), never `html`, so it can never execute as markup.
function renderIdeas(host) {
  host.innerHTML = "";
  if (!R.ideas.length) { host.append(el("div", { class: "hint", text: "No ideas fit that target — adjust it and try again." })); return; }
  const list = el("div", { class: "idealist" });
  R.ideas.forEach((idea) => {
    const macro = fmt(idea.kcal) + " kcal · " + fmt(idea.protein) + "P / " + fmt(idea.carbs) + "C / " + fmt(idea.fat) + "F";
    const card = el("button", { class: "ideacard", type: "button" },
      el("div", { class: "iname", text: idea.name }),          // text node → esc-safe
      el("div", { class: "imacro", text: macro }),
      el("div", { class: "iblurb", text: idea.blurb || "" }),
    );
    card.addEventListener("click", () => expandIdea(idea, host, list));
    list.append(card);
  });
  host.append(list);
}

async function expandIdea(idea, host, list) {
  if (recipeBusy) return;
  recipeBusy = true;
  if (list) $$("button", list).forEach((b) => { b.disabled = true; });
  R.chosen = idea;
  busy("Building the recipe…");
  try {
    const r = await api("/api/recipes/expand", { method: "POST",
      json: { idea: idea.name, target: R.target, prefs: R.prefs } });
    R.recipe = r;
    renderFullRecipe(host);
  } catch (e) {
    toast(e.message);
    if (list) $$("button", list).forEach((b) => { b.disabled = false; });
  } finally { recipeBusy = false; }
}

function renderFullRecipe(host) {
  host.innerHTML = "";
  const r = R.recipe;
  const ing = el("ul", { class: "ringlist" });
  (r.ingredients || []).forEach((g) => ing.append(el("li", { text: (g.amount ? g.amount + " " : "") + g.item })));
  const steps = el("ol", { class: "rsteps" });
  (r.steps || []).forEach((s) => steps.append(el("li", { text: s })));
  const macro = fmt(r.kcal) + " kcal · " + fmt(r.macros.protein) + "P / " + fmt(r.macros.carbs) + "C / " + fmt(r.macros.fat) + "F  (per serving)";
  const back = el("button", { class: "link", type: "button", text: "← Back to ideas", onClick: () => { R.recipe = null; renderIdeas(host); } });
  const addPlan = el("button", { class: "primary", type: "button", text: "Add to plan", onClick: () => addRecipeToPlan() });
  const logNow = el("button", { class: "ghost", type: "button", text: "Log now", onClick: () => logRecipeNow(addPlan, logNow) });
  host.append(
    el("div", { class: "rtitle", text: r.name + (r.servings ? " · serves " + r.servings : "") }),
    el("div", { class: "imacro", text: macro }),
    el("div", { class: "field-lbl", text: "Ingredients" }), ing,
    el("div", { class: "field-lbl", text: "Steps" }), steps,
    el("div", { class: "rrow" }, addPlan, logNow),
    back,
  );
}

// A recipe → a note string stored on the resulting entry/schedule for reference (spec §7.2, ruling #5).
function recipeNote(r) {
  const ing = (r.ingredients || []).map((g) => "- " + (g.amount ? g.amount + " " : "") + g.item).join("\n");
  const steps = (r.steps || []).map((s, i) => (i + 1) + ". " + s).join("\n");
  return "Ingredients:\n" + ing + "\n\nSteps:\n" + steps;
}

// "Add to plan" → hand off to the plan-an-event flow: fill F with the recipe's content, close the
// recipe sheet, and re-render the fill step. The user's already-chosen date/time/repeat still apply;
// the existing "Add to plan" submit runs buildPlanRequest → a PLANNED entry (or schedule) — nothing is
// counted until the user accepts it later (honesty). The recipe itself rides along in F.note.
function addRecipeToPlan() {
  const r = R.recipe;
  F.name = r.name; F.description = r.name;
  F.kcal = String(Math.round(num(r.kcal) || 0));
  F.macros = {
    protein: String(Math.round(num(r.macros.protein) || 0)),
    carbs: String(Math.round(num(r.macros.carbs) || 0)),
    fat: String(Math.round(num(r.macros.fat) || 0)),
  };
  F.note = recipeNote(r);
  if (recipeCtrl) recipeCtrl.close();
  recipeCtrl = null;
  toast("Recipe added — set the date/time and tap Add to plan.");
  // Re-render the whole plan sheet body so the filled numbers show (lib.sheet's controller exposes
  // its body element as `.body`; see lib.js's documented sheet() contract).
  if (planCtrl && planCtrl.body) renderForm(planCtrl.body);
}

// "Log now" → a LOGGED entry immediately (honesty: this one counts toward today's totals right away).
// Deliberately NOT /api/foods/manual — that route upserts into the shared, reusable food KB, and a
// one-off AI recipe has no business polluting it. Instead: create a planned entry (/api/plan/entry)
// then immediately accept it (/api/plan/accept) — the same "planned→logged" primitive the rest of the
// planner already uses — so the entry ends up status:"logged" with no KB side effect.
async function logRecipeNow(addPlanBtn, logBtn) {
  if (recipeBusy) return;
  recipeBusy = true;
  if (addPlanBtn) addPlanBtn.disabled = true;
  if (logBtn) logBtn.disabled = true;
  const r = R.recipe;
  busy("Logging…");
  try {
    const created = await api("/api/plan/entry", { method: "POST", json: {
      kind: "food",
      description: r.name,
      note: recipeNote(r),
      kcal: num(r.kcal),
      macros: {
        protein: num(r.macros.protein), carbs: num(r.macros.carbs), fat: num(r.macros.fat),
        fiber: num(r.macros.fiber), sugar: num(r.macros.sugar), sodium: num(r.macros.sodium), sat_fat: num(r.macros.sat_fat),
      },
      tz_offset_min: tzOffset(),
    } });
    const entry = created && created.entry;
    if (!entry || !entry.id) throw new Error("Could not create the entry");
    await api("/api/plan/accept", { method: "POST", json: { entry_id: entry.id } });
    toast("Logged.");
    if (recipeCtrl) recipeCtrl.close();
    recipeCtrl = null;
    if (planCtrl) planCtrl.close();
    planCtrl = null; editing = null;
    try { renderHome(); } catch (_) {}
  } catch (e) {
    toast(e.message);
    if (addPlanBtn) addPlanBtn.disabled = false;
    if (logBtn) logBtn.disabled = false;
  } finally { recipeBusy = false; }
}

export function render() {} // overlay-only; required by the view contract.
registerView("planevent", { render, open });
