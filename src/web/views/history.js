// Sate v2 SPA — History tab. Pick a calendar day, see that day's entries (reused feed rows,
// editable/deletable), and ask the AI for a recap of the day vs the user's goal.
//
//   • registers as a tab view (container #view-history) exporting render();
//   • builds a date picker + "AI recap" button once, caches the DOM, and re-renders on each show;
//   • GET /api/entries?day=YYYY-MM-DD → { date, entries, totals } → a day-total line + lib.feedRow list
//     (row tap/edit → openView('editentry', entry); delete → DELETE /api/entries/:id then reload);
//   • GET /api/day/summary?date=YYYY-MM-DD → { summary, totals } → the AI recap box.
//
// Mirrors v1's loadHistory()/summaryBtn. No native bridges here, so nothing to gate behind isNative().

"use strict";

import {
  $, el, api, toast, feedRow, openView, registerView,
  todayISO, fmt, esc,
} from "../lib.js";

// View-local state: which calendar day the picker is on (persists across tab re-shows).
const HIST = { date: null };

// Cached DOM handles (built once by ensureUI, reused on every render).
let UI = null;

// ============================================================ one-time UI construction
// Build the picker + recap header, the summary box, and the entries list into #view-history. The
// router calls render() on every show; we build the DOM the first time and just reload data after.
function ensureUI(container) {
  if (UI && container.contains(UI.root)) return UI;
  container.innerHTML = "";

  const dateInput = el("input", { type: "date", id: "histDate", "aria-label": "History date" });
  const recapBtn = el("button", { class: "primary", type: "button" }, "AI recap");
  const header = el("div", { class: "row between" },
    el("div", { class: "field", style: { marginBottom: "0", flex: "1" } }, dateInput),
    recapBtn,
  );

  const total = el("div", { class: "subline" });
  const summary = el("div", { class: "summary", hidden: true });
  const list = el("div", { class: "entries" });

  const root = el("div", null, header, total, summary, list);
  container.appendChild(root);

  dateInput.addEventListener("change", () => { HIST.date = dateInput.value || todayISO(); loadDay(); });
  recapBtn.addEventListener("click", loadRecap);

  UI = { root, dateInput, recapBtn, total, summary, list };
  return UI;
}

// ============================================================ render entry point
// Called by showView('history') on every show. Syncs the picker to the persisted day and reloads.
function render(container) {
  const host = container || $("#view-history");
  if (!host) return;
  const ui = ensureUI(host);
  if (!HIST.date) HIST.date = todayISO();
  ui.dateInput.value = HIST.date;
  loadDay();
}

// ============================================================ a day's entries + totals
async function loadDay() {
  const ui = UI;
  if (!ui) return;
  ui.summary.hidden = true;
  ui.summary.textContent = "";
  const day = HIST.date || todayISO();
  ui.list.innerHTML = '<div class="loadrow"><span class="spinner"></span><span>Loading…</span></div>';
  ui.total.textContent = "";
  let data;
  try {
    data = await api("/api/entries?day=" + encodeURIComponent(day));
  } catch (e) {
    toast(e.message);
    ui.list.innerHTML = '<div class="hint">Couldn’t load this day — ' + esc(e.message) + "</div>";
    return;
  }
  if (HIST.date !== day) return; // the user changed the date while this was in flight
  const entries = data.entries || [];
  ui.total.textContent = daySummaryLine(data.totals, entries);
  renderEntries(entries);
}

// One-line "N entries · X kcal · P/C/F" recap of the loaded day (from the server-authoritative totals).
function daySummaryLine(totals, entries) {
  const n = entries.length;
  if (!n) return "";
  const t = totals || {};
  const parts = [n + (n === 1 ? " entry" : " entries")];
  if (t.kcal) parts.push(fmt(t.kcal) + " kcal");
  const macros = [t.protein && fmt(t.protein) + "g P", t.carbs && fmt(t.carbs) + "g C", t.fat && fmt(t.fat) + "g F"].filter(Boolean);
  if (macros.length) parts.push(macros.join(" · "));
  return parts.join(" · ");
}

function renderEntries(entries) {
  const ui = UI;
  ui.list.innerHTML = "";
  if (!entries.length) {
    ui.list.innerHTML = '<div class="hint">No entries for this day.</div>';
    return;
  }
  entries.forEach((en) => ui.list.appendChild(feedRow(en, {
    onEdit: (e) => openView("editentry", e),
    onDelete: (e) => deleteEntry(e.id),
    // onClick defaults to onEdit inside feedRow.
  })));
}

async function deleteEntry(id) {
  try { await api("/api/entries/" + id, { method: "DELETE" }); toast("Deleted"); loadDay(); }
  catch (e) { toast(e.message); }
}

// ============================================================ AI recap (GET /api/day/summary)
async function loadRecap() {
  const ui = UI;
  if (!ui) return;
  const day = HIST.date || todayISO();
  ui.summary.hidden = false;
  ui.summary.innerHTML = '<div class="loadrow"><span class="spinner"></span><span>Thinking…</span></div>';
  try {
    const r = await api("/api/day/summary?date=" + encodeURIComponent(day));
    if (HIST.date !== day) return;
    ui.summary.textContent = r.summary || "No recap available for this day.";
  } catch (e) {
    ui.summary.textContent = e.message;
  }
}

// ============================================================ register with the router
registerView("history", { container: "#view-history", render });

// Exposed so other views (e.g. editentry after a save) can refresh the History day when it's the
// active tab, matching v1's refreshLogViews().
export { render };
