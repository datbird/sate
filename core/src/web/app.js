// Sate minimal web client. Firebase sign-in (Apple/Google/email) → ID token → the core API.
// The rich SPA views migrate here incrementally as more routes land. Offline-first direct-Firestore
// (the "local cache" refinement) comes later; for now data flows through the authenticated API.
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import {
  getAuth,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signInWithPopup,
  signOut,
  OAuthProvider,
  GoogleAuthProvider,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";

const $ = (s) => document.querySelector(s);
let auth = null;
let token = "";

async function main() {
  const cfg = await (await fetch("/config")).json();
  auth = getAuth(initializeApp(cfg.firebase));
  onAuthStateChanged(auth, async (user) => {
    if (user) {
      token = await user.getIdToken();
      $("#signin").hidden = true;
      $("#app").hidden = false;
      $("#who").textContent = user.email || "";
      refresh();
    } else {
      $("#signin").hidden = false;
      $("#app").hidden = true;
      $("#who").textContent = "";
    }
  });
  wireUi();
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { ...(opts.headers || {}), Authorization: "Bearer " + token, "content-type": "application/json" },
  });
  if (!res.ok) throw new Error("HTTP " + res.status);
  return res.json();
}

const showErr = (e) => ($("#authErr").textContent = (e && e.message) || String(e));

function wireUi() {
  $("#appleBtn").addEventListener("click", () =>
    signInWithPopup(auth, new OAuthProvider("apple.com")).catch(showErr),
  );
  $("#googleBtn").addEventListener("click", () =>
    signInWithPopup(auth, new GoogleAuthProvider()).catch(showErr),
  );
  $("#signinForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      await signInWithEmailAndPassword(auth, $("#email").value, $("#password").value);
    } catch (err) {
      showErr(err);
    }
  });
  $("#logoutBtn").addEventListener("click", () => signOut(auth));
  $("#logForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const text = $("#food").value.trim();
    if (!text) return;
    $("#food").value = "";
    $("#logStatus").textContent = "Estimating…";
    try {
      await api("/api/entries/food", {
        method: "POST",
        body: JSON.stringify({ text, tz_offset_min: new Date().getTimezoneOffset() }),
      });
      $("#logStatus").textContent = "";
      refresh();
    } catch (err) {
      $("#logStatus").textContent = "Couldn't log that — " + err.message;
    }
  });
}

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
}

async function refresh() {
  const tz = new Date().getTimezoneOffset();
  const [stats, list] = await Promise.all([api(`/api/stats?tz=${tz}`), api(`/api/entries`)]);
  $("#stats").innerHTML =
    `<b>${stats.intake.kcal}</b> kcal eaten · <b>${stats.burn}</b> burned · ` +
    `<b>${stats.net}</b> net · ${stats.intake.protein}g protein`;
  $("#entries").innerHTML = (list.entries || [])
    .map(
      (e) =>
        `<li class="${e.kind}"><span>${e.kind === "activity" ? "🏃" : "🍽️"} ${esc(e.description)}</span>` +
        `<span class="k">${e.kcal} kcal <button class="del" data-id="${e.id}" aria-label="delete">✕</button></span></li>`,
    )
    .join("");
  document.querySelectorAll(".del").forEach((b) => {
    b.onclick = async () => {
      await api("/api/entries/" + b.dataset.id, { method: "DELETE" });
      refresh();
    };
  });
}

main();
