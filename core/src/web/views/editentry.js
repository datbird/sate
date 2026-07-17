// Sate v2 SPA — Edit-entry sheet. Owned by the editentry agent.
//
// Opened from any feed/history row via openView('editentry', entry). It presents one bottom sheet
// with the four v1 edit affordances, all backed by PATCH /api/entries/:id:
//   • quick-scale chips (½ ¾ 1¼ 1½ 2×)        → PATCH { scale }
//   • re-describe the meal/workout            → PATCH { re_estimate:true, text }
//   • second opinion (AI re-estimate)         → POST  /api/second-opinion { entry_id }, then adopt
//                                               via PATCH { set_total, set_items, set_provider, set_model }
//   • manual detail grid (name/note + numbers)→ PATCH { manual:true, description, note, kcal, … }
//   • delete                                  → DELETE /api/entries/:id
// After any mutation it refreshes shared state (totals) and re-renders the active tab (History if
// open, else Home) — the v1 afterEntryChange() behavior.
//
// Mirrors views/home.js conventions: named lib imports, esc() on all user/AI text, sheet() overlay,
// no framework, no new global CSS (every class used here already ships in style.css).

"use strict";

import {
  $, $$, api, me, esc, fmt, toast, refreshMe,
  registerView, view, sheet,
} from "../lib.js";

// Editable numeric fields per entry kind for the manual detail grid. Food macros live under
// entry.macros in the v2 shape; kcal/duration/distance are top-level — valOf() bridges both.
const MANUAL_FIELDS = {
  food: [
    ["kcal", "Calories", "kcal"], ["protein", "Protein", "g"], ["carbs", "Carbs", "g"], ["fat", "Fat", "g"],
    ["fiber", "Fiber", "g"], ["sugar", "Sugar", "g"], ["sodium", "Sodium", "mg"], ["sat_fat", "Sat. fat", "g"],
  ],
  activity: [["kcal", "Calories burned", "cal"], ["duration_min", "Duration", "min"], ["distance", "Distance", "mi"]],
};
const TOP_LEVEL = new Set(["kcal", "duration_min", "distance"]);
const MACRO_KEYS = ["protein", "carbs", "fat", "fiber", "sugar", "sodium", "sat_fat"];

// Read a numeric field off the entry (top-level or nested macro), rounded for display; "" when unset.
function valOf(en, k) {
  let v = TOP_LEVEL.has(k) ? en[k] : (en.macros ? en.macros[k] : undefined);
  if (v === undefined || v === null) v = en[k];
  return v === undefined || v === null ? "" : Math.round(Number(v) * 100) / 100;
}

// ============================================================ open the sheet
export function open(entry) {
  if (!entry || !entry.id) return;
  const en = entry;
  const activity = en.kind === "activity";
  const unit = activity ? "cal burned" : "kcal";
  const fields = MANUAL_FIELDS[activity ? "activity" : "food"];
  const M = me() || {};
  const canSecond = !!en.description && en.description !== "(photo)" && M.second_opinion_enabled !== false;

  const scales = [["½", 0.5], ["¾", 0.75], ["1¼", 1.25], ["1½", 1.5], ["2×", 2]];
  const scaleBtns = scales.map(([l, v]) => `<button type="button" data-scale="${v}">${l}</button>`).join("");
  const manualCells = fields.map(([k, label, u]) =>
    `<label class="mfield"><span>${esc(label)}${u ? ` <em>(${esc(u)})</em>` : ""}</span>` +
    `<input type="number" step="any" inputmode="decimal" data-mnum="${k}" value="${valOf(en, k)}"></label>`).join("");

  const s = sheet({ title: en.description || "Edit entry", className: "addsheet" });

  s.setBody((body) => {
    body.innerHTML =
      `<div class="subline" style="text-align:left;margin:0 0 10px">Currently ` +
      `<b style="color:var(--ink)">${fmt(en.kcal)} ${esc(unit)}</b>` +
      `${activity && en.duration_min ? " · " + Math.round(en.duration_min) + " min" : ""}</div>` +

      `<div class="menu-label" style="padding-left:0">Adjust the amount</div>` +
      `<div class="quickscale">${scaleBtns}</div>` +

      `<div class="menu-label" style="padding-left:0">${activity ? "Or re-describe the workout" : "Or re-describe the meal"}</div>` +
      `<div class="editrow"><input id="ee-text" maxlength="2000" ` +
      `placeholder="${activity ? "e.g. a 5 mile run" : "e.g. half a cup of rice"}" ` +
      `value="${esc(en.description || "")}"></div>` +
      `<div class="sheet-actions">` +
      `<button class="primary" id="ee-reest" style="flex:1">Re-estimate</button>` +
      `<button class="danger-btn" id="ee-delete" type="button">Delete</button></div>` +

      (canSecond
        ? `<div class="row" style="margin-top:8px"><button class="link" id="ee-second" type="button">🔀 Get a second opinion</button></div><div id="ee-second-panel"></div>`
        : "") +

      `<div class="menu-label" style="padding-left:0;margin-top:14px">Or edit the details manually</div>` +
      `<label class="mfield"><span>Name</span><input id="ee-name" maxlength="2000" ` +
      `value="${esc(en.description || "")}" placeholder="${activity ? "e.g. Morning run" : "e.g. Chicken and rice"}"></label>` +
      `<label class="mfield"><span>Description <em>(optional)</em></span><input id="ee-note" maxlength="2000" ` +
      `value="${esc(en.note || "")}" placeholder="Add a note…"></label>` +
      `<div class="manualgrid">${manualCells}</div>` +
      `<div class="sheet-actions"><button class="primary" id="ee-save" style="flex:1">Save changes</button></div>`;

    // Quick-scale chips.
    $$("[data-scale]", body).forEach((b) =>
      b.addEventListener("click", () => applyEdit({ scale: +b.dataset.scale })));

    // Re-describe → AI re-estimate.
    $("#ee-reest", body).addEventListener("click", () => {
      const text = $("#ee-text", body).value.trim();
      if (!text) { toast("Type a description first"); return; }
      applyEdit({ re_estimate: true, text });
    });

    // Delete (mirrors v1's in-sheet Delete — direct, no extra confirm).
    $("#ee-delete", body).addEventListener("click", deleteEntry);

    // Manual detail grid.
    $("#ee-save", body).addEventListener("click", saveManualEdit);

    // Second opinion.
    const secondBtn = $("#ee-second", body);
    if (secondBtn) secondBtn.addEventListener("click", () => requestSecondOpinion(secondBtn));
  });

  // -------------------------------------------------- mutations (closure over en + sheet)
  // Apply the hand-typed name / note / numbers. Blank number fields are left unchanged; a typed
  // value (including 0) overrides. Tags the entry source as user-provided (manual:true).
  function saveManualEdit() {
    const payload = {
      manual: true,
      description: $("#ee-name", s.body).value.trim(),
      note: $("#ee-note", s.body).value.trim(),
    };
    $$("[data-mnum]", s.body).forEach((inp) => {
      const raw = inp.value.trim();
      if (raw === "") return;
      const n = Number(raw);
      if (!isNaN(n)) payload[inp.dataset.mnum] = n;
    });
    applyEdit(payload);
  }

  async function applyEdit(payload) {
    s.close();
    toast("Updating…");
    try {
      const r = await api("/api/entries/" + en.id, { method: "PATCH", json: payload });
      const e = (r && r.entry) || {};
      toast(`Updated to ${fmt(e.kcal)} ${e.kind === "activity" ? "cal" : "kcal"}.`);
      afterEntryChange();
    } catch (err) { toast(err.message); }
  }

  async function deleteEntry() {
    s.close();
    toast("Deleting…");
    try {
      await api("/api/entries/" + en.id, { method: "DELETE" });
      toast("Deleted");
      afterEntryChange();
    } catch (err) { toast(err.message); }
  }

  // Ask the second-opinion model to independently re-estimate this entry (never mutates the diary);
  // show it alongside the current numbers with a one-tap "Use this estimate" to adopt it.
  async function requestSecondOpinion(btn) {
    const panel = $("#ee-second-panel", s.body);
    if (!panel) return;
    btn.disabled = true;
    panel.innerHTML =
      '<div class="second-card loadrow"><span class="spinner"></span><span class="muted">Getting a second opinion…</span></div>';
    try {
      const r = await api("/api/second-opinion", { method: "POST", json: { entry_id: en.id } });
      const t = r.total || {};
      const alt = activity ? Math.round(t.kcal_burned || 0) : Math.round(t.kcal || 0);
      const cur = Math.round(en.kcal || 0);
      const u = activity ? "cal" : "kcal";
      const macros = activity ? "" :
        `<span class="second-macros">${Math.round(t.protein || 0)}P · ${Math.round(t.carbs || 0)}C · ${Math.round(t.fat || 0)}F</span>`;
      panel.innerHTML =
        `<div class="second-card">` +
        `<div class="second-tag">Second opinion${r.model ? " · " + esc(r.model) : ""}</div>` +
        `<div class="second-cmp"><b>${alt} ${u}</b> ${macros} <span class="muted">(was ${cur} ${u})</span></div>` +
        (r.note ? `<div class="second-note muted">${esc(r.note)}</div>` : "") +
        `<button class="primary small" type="button" id="ee-second-use">Use this estimate</button>` +
        `</div>`;
      $("#ee-second-use", panel).addEventListener("click", () =>
        applyEdit({ set_total: r.total, set_items: r.items || [], set_provider: r.provider, set_model: r.model }));
    } catch (err) {
      panel.innerHTML =
        `<div class="second-card"><span class="muted">${esc((err && err.message) || "Second opinion unavailable")}</span></div>`;
      btn.disabled = false;
    }
  }
}

// ============================================================ post-mutation refresh
// v1 afterEntryChange(): re-render the visible diary surface (History if open, else Home) and refresh
// shared state so the day totals in APP.me follow the edit.
function afterEntryChange() {
  refreshMe().catch(() => {});
  const h = $("#view-history");
  if (h && !h.hidden) {
    const hv = view("history");
    if (hv && typeof hv.render === "function") { try { hv.render(h); } catch (_) {} return; }
  }
  const home = view("home");
  if (home && typeof home.render === "function") { try { home.render($("#view-home")); } catch (_) {} }
}

// Required by the contract; this is an overlay view, so render() is unused.
export function render() {}

registerView("editentry", { render, open });
