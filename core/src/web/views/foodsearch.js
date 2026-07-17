// Sate v2 SPA — Internet food search overlay. The "search the web for this food" flow: an fssheet
// (pinned search header + scrolling results) that shows the fast structured sources first, then
// streams an AI/web-grounded best guess in as an "asking AI…" row. Tapping a result opens a detail
// view with the full nutrition facts and an "Accept & log this" action.
//
//   • GET  /api/foods/search-online?q=  → { results:[ {source,name,brand,serving_desc,kcal,…} ] }
//                                          (local DB + USDA + Open Food Facts, structured, instant)
//   • POST /api/foods/web-candidate {q} → { result: {source:"web",…} | null }  (AI, streamed in after)
//   • POST /api/foods/accept {candidate} → { entry, totals }  (AI-normalize + save to KB + log)
//
// Exposed as an overlay view: openView('foodsearch', query) — compose calls this from its "search
// online" action. `query` may be a plain string, or { q, onLogged? } (onLogged lets the caller —
// e.g. compose — close its own sheet after a successful log). Mirrors v1 openFoodSearch/openFsDetail.
"use strict";

import { $$, el, esc, fmt, api, busy, toast, sheet, registerView, refreshMe } from "../lib.js";

// Source labels + display order (structured sources first, AI/web last). Ported from v1 FS_SOURCE/FS_ORDER.
const FS_SOURCE = { local: "In your database", usda: "USDA FoodData Central", off: "Open Food Facts", web: "From the web (AI)" };
const FS_ORDER = ["local", "usda", "off", "web"];

// One decimal for macros (matches v1 n1 / the server's r1x rounding); kcal/sodium are whole numbers.
const n1 = (x) => Math.round((Number(x) || 0) * 10) / 10;
const whole = (x) => Math.round(Number(x) || 0);

const SEARCH_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">' +
  '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4-4" stroke-linecap="round"/></svg>';

// Overlay views must export render() per the contract; unused here (all UI is built in open()).
export function render() {}

// open(query) — mount the search sheet and kick off the first search.
export function open(args) {
  const query = typeof args === "string" ? args : (args && (args.q || args.query)) || "";
  const onLogged = args && typeof args === "object" && typeof args.onLogged === "function" ? args.onLogged : null;

  // Per-open UI state. `seq` guards against out-of-order responses when the user searches again
  // before the previous request (or the streamed AI candidate) lands.
  const FS = { results: [], seq: 0, aiPending: false, onLogged };

  const input = el("input", { id: "fsInput", value: query, placeholder: "Search foods…", autocomplete: "off" });
  const searchWrap = el("div", { class: "search" }, [el("span", { html: SEARCH_SVG }), input]);
  searchWrap.style.flex = "none";
  const resultsBox = el("div", { class: "fsresults" });

  const s = sheet({
    title: "Search the web for a food",
    className: "fssheet",
    body: (bodyEl) => {
      // Establish the flex chain the fssheet layout needs WITHOUT depending on v1's old #fsBody id:
      // the header stays pinned and only .fsresults scrolls.
      Object.assign(bodyEl.style, { display: "flex", flexDirection: "column", flex: "1 1 auto", minHeight: "0", gap: "6px" });
      bodyEl.appendChild(searchWrap);
      bodyEl.appendChild(resultsBox);
    },
  });

  input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); runSearch(input.value.trim()); } });
  setTimeout(() => { try { input.focus(); } catch (_) {} }, 60);

  // -------------------------------------------------- search
  async function runSearch(q) {
    q = (q || "").trim();
    if (!q) { resultsBox.innerHTML = `<div class="grouplbl">Type something to search.</div>`; FS.results = []; return; }
    const seq = ++FS.seq;
    FS.results = [];
    FS.aiPending = true;
    resultsBox.innerHTML =
      `<div class="loadrow center"><span class="spinner big"></span>` +
      `<span>Searching your database, USDA &amp; Open Food Facts…</span></div>`;
    busy("Searching…");
    try {
      const r = await api("/api/foods/search-online?q=" + encodeURIComponent(q));
      if (seq !== FS.seq) return;
      FS.results = r.results || [];
    } catch (e) {
      if (seq === FS.seq) resultsBox.innerHTML = `<div class="loadrow center"><span>${esc(e.message || "Search failed")}</span></div>`;
      return;
    }
    renderResults();
    // The AI/web-grounded candidate is a separate (slower) call so it never blocks the structured
    // results. A live "asking AI…" row shows until it lands, then it slots into the "From the web"
    // group. Best-effort: a failure just drops the pending row.
    api("/api/foods/web-candidate", { method: "POST", json: { q } })
      .then((r) => { if (seq !== FS.seq) return; FS.aiPending = false; if (r && r.result) FS.results.push(r.result); renderResults(); })
      .catch(() => { if (seq === FS.seq) { FS.aiPending = false; renderResults(); } });
  }

  // -------------------------------------------------- results list (grouped by source)
  function renderResults() {
    const groups = {};
    FS.results.forEach((r, i) => { (groups[r.source] = groups[r.source] || []).push(i); });
    let html = "";
    FS_ORDER.forEach((src) => {
      if (!groups[src]) return;
      html += `<div class="grouplbl">${esc(FS_SOURCE[src] || src)}</div>`;
      html += groups[src].map((i) => {
        const f = FS.results[i];
        const brand = f.brand ? " · " + esc(f.brand) : "";
        const macro = `${whole(f.kcal)} kcal · ${whole(f.protein)}P ${whole(f.carbs)}C ${whole(f.fat)}F`;
        return `<button class="res" type="button" data-i="${i}">` +
          `<div class="rt"><b>${esc(f.name)}</b>` +
          `<span>${esc(f.serving_desc || "1 serving")}${brand} · ${macro}</span></div>` +
          `<span class="add">›</span></button>`;
      }).join("");
    });
    // Live spinner row while the AI web search is still running.
    if (FS.aiPending) {
      html += `<div class="grouplbl">${esc(FS_SOURCE.web)}</div>` +
        `<div class="loadrow"><span class="spinner"></span><span>Asking AI to search the web…</span></div>`;
    }
    if (!html) html = `<div class="loadrow center"><span>No matches — try adding it manually.</span></div>`;
    resultsBox.innerHTML = html;
    $$(".res", resultsBox).forEach((btn) => btn.addEventListener("click", () => openDetail(+btn.dataset.i)));
  }

  // -------------------------------------------------- detail + accept
  function openDetail(i) {
    const f = FS.results[i];
    if (!f) return;
    const rows = [
      ["Serving", esc(f.serving_desc || "1 serving")],
      ["Calories", whole(f.kcal) + " kcal"],
      ["Protein", n1(f.protein) + " g"],
      ["Carbs", n1(f.carbs) + " g"],
      ["Fat", n1(f.fat) + " g"],
      ["Fiber", n1(f.fiber) + " g"],
      ["Sugar", n1(f.sugar) + " g"],
      ["Sodium", whole(f.sodium) + " mg"],
      ["Sat. fat", n1(f.sat_fat) + " g"],
    ];
    resultsBox.innerHTML =
      `<button class="link" type="button" id="fsBack">‹ Back to results</button>` +
      `<div class="fsdetail"><h4>${esc(f.name)}${f.brand ? ` <span class="muted">${esc(f.brand)}</span>` : ""}</h4>` +
      `<div class="muted" style="font-size:12px;margin-bottom:8px">${esc(FS_SOURCE[f.source] || f.source)}</div>` +
      `<div class="kvs">${rows.map(([k, v]) => `<div class="kv"><span>${esc(k)}</span><b>${v}</b></div>`).join("")}</div>` +
      `<div class="sheet-actions"><button class="primary" type="button" id="fsAccept" style="flex:1">Accept &amp; log this</button></div>` +
      `<div class="subline" style="text-align:left;margin-top:8px">We'll ask AI to tidy the numbers, fill any gaps, and save it to your database.</div></div>`;
    $$("#fsBack", resultsBox).forEach((b) => b.addEventListener("click", renderResults));
    $$("#fsAccept", resultsBox).forEach((b) => b.addEventListener("click", () => acceptFood(f, b)));
  }

  async function acceptFood(f, btn) {
    if (btn) btn.disabled = true;
    busy("Normalizing with AI…");
    try {
      const r = await api("/api/foods/accept", { method: "POST", json: { candidate: f } });
      s.close();
      toast(`Logged ${fmt(r && r.entry ? r.entry.kcal : 0)} kcal.`);
      // Let the caller (compose) close its own sheet; then refresh shared state + Home so the new
      // entry and updated totals show without a manual tab switch.
      if (FS.onLogged) { try { FS.onLogged(r && r.entry); } catch (_) {} }
      refreshHome();
    } catch (e) {
      if (btn) btn.disabled = false;
      toast(e.message);
    }
  }

  runSearch(query);
  return s;
}

// Re-render Home after a successful log (dynamic import avoids a load-order dependency; app.js has
// already imported home.js for its module-level wiring, so this hits the cached module).
function refreshHome() {
  refreshMe()
    .catch(() => {})
    .then(() => import("./home.js"))
    .then((m) => { if (m && typeof m.render === "function") m.render(); })
    .catch(() => {});
}

registerView("foodsearch", { render, open });
