// Sate v2 SPA — Settings sheet (the gear on the stat card). Preferences that AREN'T goals: how the
// app behaves. Opened via [data-open="settings"] → openView('settings'). Sibling to the Goals sheet
// (views/goals.js), which owns the actual targets. Both persist via PATCH /api/goals.
//
//   • net-exercise (add workout burn to the day's budget);
//   • show weigh-ins in the All feed (opt-in);
//   • coach check-in opt-in + frequency (only when the instance enables check-ins);
//   • Apple-Health sync + heart-rate calorie method — NATIVE ONLY (gated behind isNative()).

"use strict";

import { el, api, me, registerView, sheet, toast, refreshMe, isNative } from "../lib.js";
import { render as renderHome } from "./home.js";

const CHECKIN_FREQ_OPTS = [
  ["often", "A few times a day"],
  ["daily", "Once a day"],
  ["sparse", "Every couple of days"],
];
const HEALTH_INTERVALS = [
  [0, "Manual only"],
  [60, "Hourly"],
  [360, "Every 6 hours"],
  [720, "Every 12 hours"],
  [1440, "Daily"],
];

function optionEls(opts, selected) {
  return opts.map(([v, l]) => el("option", { value: v, selected: String(v) === String(selected) || undefined }, l));
}

export function open() {
  const M = me() || {};

  // ---- net-exercise
  const netChk = el("input", { type: "checkbox", checked: M.net_exercise !== false || undefined });
  const netRow = el("label", { class: "checkrow" }, netChk,
    el("span", {}, "Add exercise calories to my budget",
      el("small", {}, "When you log a workout, its burn is added to that day's calorie goal.")));

  // ---- show weigh-ins in the All feed
  const showWeightChk = el("input", { type: "checkbox", checked: M.show_weight_in_feed ? true : undefined });
  const showWeightRow = el("label", { class: "checkrow" }, showWeightChk,
    el("span", {}, "Show weigh-ins in the All feed",
      el("small", {}, "Off by default — weigh-ins live on the Weight tab. Turn on to mix them into All.")));

  // ---- NATIVE-ONLY: heart-rate calorie method
  let hrSel = null, hrRow = null;
  if (isNative()) {
    hrSel = el("select", {}, optionEls([["formula", "Formula (from heart rate)"], ["ai", "AI estimate"]], M.hr_estimate_method === "ai" ? "ai" : "formula"));
    hrRow = el("label", { class: "healthintlbl", style: { marginBottom: "14px" } }, "Heart-rate calorie estimate", hrSel);
  }

  // ---- NATIVE-ONLY: Apple Health sync
  let healthChk = null, healthIntSel = null, healthWriteChk = null, healthSection = null;
  if (isNative()) {
    healthChk = el("input", { type: "checkbox", checked: !!M.health_sync || undefined });
    healthIntSel = el("select", {}, optionEls(HEALTH_INTERVALS, Number(M.health_sync_interval) || 0));
    const intLabel = el("label", { class: "healthintlbl", style: { marginTop: "10px" } }, "Sync frequency", healthIntSel);
    intLabel.hidden = !M.health_sync;
    healthChk.addEventListener("change", () => { intLabel.hidden = !healthChk.checked; });
    // Two-way: write manual weigh-ins back to Apple Health (opt-in, default off). Loop-safe — samples
    // Sate writes are tagged and skipped on import.
    healthWriteChk = el("input", { type: "checkbox", checked: !!M.health_write || undefined });
    healthSection = el("div", { class: "wgsection" },
      el("div", { class: "wglabel" }, "Apple Health"),
      el("label", { class: "checkrow", style: { marginBottom: "0" } }, healthChk,
        el("span", {}, "Sync weight & workouts from Apple Health",
          el("small", {}, "Sate reads measurements and activity so you don't have to log them by hand."))),
      intLabel,
      el("label", { class: "checkrow", style: { marginBottom: "0", marginTop: "10px" } }, healthWriteChk,
        el("span", {}, "Write my weigh-ins to Apple Health",
          el("small", {}, "When you log a weight in Sate, also save it to Apple Health so it stays in sync with your other apps."))));
  }

  // ---- check-ins (only when the instance enables them)
  let ciChk = null, ciFreqSel = null, checkinSection = null;
  if (M.checkins_enabled !== false) {
    ciChk = el("input", { type: "checkbox", checked: !!M.checkin_enabled || undefined });
    ciFreqSel = el("select", {}, optionEls(CHECKIN_FREQ_OPTS, M.checkin_freq || "daily"));
    const freqRow = el("label", { class: "healthintlbl", style: { marginTop: "10px" } }, "How often, at most?", ciFreqSel);
    freqRow.hidden = !M.checkin_enabled;
    ciChk.addEventListener("change", () => { freqRow.hidden = !ciChk.checked; });
    checkinSection = el("div", { class: "wgsection" },
      el("div", { class: "wglabel" }, "Coach check-ins"),
      el("label", { class: "checkrow", style: { marginBottom: "0" } }, ciChk,
        el("span", {}, "Let Sate check in with me",
          el("small", {}, "Sate reviews your logs and reaches out with a personal nudge when it's useful."))),
      freqRow);
  }

  const saveBtn = el("button", { type: "button", class: "primary" }, "Save");
  const form = el("form", { id: "settingsForm" },
    netRow, showWeightRow,
    hrRow || null,
    healthSection || null,
    checkinSection || null);
  form.addEventListener("submit", (e) => e.preventDefault());

  // ---- your data: export + account deletion.
  // Health data must not be a one-way door — a user can take their record with them, and erase it.
  const exportBtn = el("button", { type: "button", class: "primary small" }, "Download my data");
  const deleteBtn = el("button", { type: "button", class: "danger-btn" }, "Delete my account data");
  const dataSection = el("div", { class: "wgsection" },
    el("div", { class: "wglabel" }, "Your data"),
    el("label", { class: "checkrow", style: { marginBottom: "0" } },
      el("span", {}, "Download or delete everything",
        el("small", {}, "Deleting is permanent — it removes your meals, activity, weigh-ins, goals and " +
          "plans. It does not delete your sign-in; signing in again starts a fresh, empty account."))),
    el("div", { class: "healthactions", style: { marginTop: "10px" } }, exportBtn, deleteBtn),
    el("div", { style: { marginTop: "10px", fontSize: "12.5px" } },
      el("a", { href: "/privacy.html", target: "_blank", rel: "noopener" }, "Privacy — what Sate stores and what it sends")));

  exportBtn.addEventListener("click", async () => {
    exportBtn.disabled = true;
    try {
      const data = await api("/api/account/export");
      // Build the file client-side from the API response; no new endpoint, no server-side temp file.
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = el("a", { href: url, download: `sate-export-${(data.exported_at || "").slice(0, 10)}.json` });
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      toast("Export downloaded");
    } catch (er) { toast(er.message); }
    exportBtn.disabled = false;
  });

  deleteBtn.addEventListener("click", async () => {
    // Two-step, and the second step requires typing — this is unrecoverable.
    if (!window.confirm("Delete all of your Sate data? This cannot be undone.")) return;
    const typed = window.prompt('Type DELETE to confirm erasing every meal, weigh-in, goal and plan:');
    if (typed !== "DELETE") { toast("Not deleted"); return; }
    deleteBtn.disabled = true;
    try {
      await api("/api/account", { method: "DELETE", json: { confirm: "DELETE" } });
      toast("Your data has been deleted");
      location.reload();
    } catch (er) { toast(er.message); deleteBtn.disabled = false; }
  });

  form.appendChild(dataSection);

  // Save is a PINNED footer — always visible while the body scrolls.
  const s = sheet({ title: "Settings", body: form, footer: saveBtn });

  saveBtn.addEventListener("click", async () => {
    const payload = {
      net_exercise: netChk.checked,
      show_weight_in_feed: showWeightChk.checked,
    };
    if (isNative() && hrSel) payload.hr_estimate_method = hrSel.value;
    if (isNative() && healthChk) {
      payload.health_sync = healthChk.checked;
      if (healthIntSel) payload.health_sync_interval = Number(healthIntSel.value);
      if (healthWriteChk) payload.health_write = healthWriteChk.checked;
    }
    if (ciChk) {
      payload.checkin_enabled = ciChk.checked;
      payload.checkin_freq = ciFreqSel.value;
    }
    try {
      await api("/api/goals", { method: "PATCH", json: payload });
      await refreshMe();
      toast("Settings saved");
      s.close();
      try { renderHome(); } catch (_) {}
    } catch (er) { toast(er.message); }
  });
}

export function render() {}
registerView("settings", { render, open });
