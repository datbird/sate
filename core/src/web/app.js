// Sate v2 SPA — the shell. Owns Firebase auth, the /config bootstrap, the shared APP state
// (GET /api/me), the top bar + account menu (theme, sign out), the nav wiring (header tabs + bottom
// tab bar via the shared showView router), and the headless test hook. Everything else lives in
// lib.js (helpers/components/router/state/sheets) and the per-view modules under views/.
//
// Auth is Firebase exactly as the seed did: SDK loaded from the gstatic CDN as ESM, config from
// GET /config. The Firebase SDK is imported DYNAMICALLY so the headless test hook (which skips
// Firebase entirely) never needs the network and the module graph parses offline.

"use strict";

import {
  $, $$, api, getJSON, setToken, setUnauthorizedHandler, setMe, setRefreshMe, APP, me,
  showView, openView, view, toast, hasSku,
} from "./lib.js";

// Import every view for its registration side effect. Each module calls registerView(...) at import
// time, so the router + cross-view openView() can find them. Home is fully implemented; the rest are
// stubs the other agents fill in (they keep this exact registration shape).
import "./views/home.js";
import "./views/coach.js";
import "./views/history.js";
import "./views/compose.js";
import "./views/foodsearch.js";
import "./views/editentry.js";
import "./views/weight.js";
import "./views/goals.js";
import "./views/onboarding.js";
import "./views/register.js";
import "./views/upgrade.js";
import "./views/admin.js";

// ---------------------------------------------------------------- auth state
let auth = null;          // Firebase Auth instance (null in test mode)
let fbSignOut = null;     // bound Firebase signOut (null in test mode)

// ---------------------------------------------------------------- boot
async function main() {
  wireChrome();
  setUnauthorizedHandler(showSignIn); // api() 401 → back to sign-in

  // --- Headless test hook: window.__SATE_TEST__ = { uid, email, token } signs the user in with the
  // given bearer token, skipping Firebase entirely, so authenticated views render offline in verify.
  if (window.__SATE_TEST__ && window.__SATE_TEST__.token) {
    setToken(window.__SATE_TEST__.token);
    // Test-only bridge: lets the headless harness drive overlays that are otherwise reached through
    // menu items or cross-view calls (foodsearch/goals/upgrade). Never defined outside test mode.
    window.__SATE = { openView, showView, view, me };
    try { await enterApp(); } catch (e) { console.error("[test-hook] enterApp failed", e); }
    return;
  }

  // --- Real Firebase path.
  let cfg;
  try { cfg = await getJSON("/config"); }
  catch (e) { console.error("failed to load /config", e); showSignIn(); return; }
  if (cfg && cfg.app_name) setBrand(cfg.app_name);

  // Self-host proxy-auth: identity comes from the reverse-proxy (Cloudflare Access) email header, so
  // there is no in-app login and no Firebase. Go straight into the app; api() calls carry no bearer —
  // the proxy header authenticates them server-side (core's trustEmailHeader path).
  if (cfg && cfg.mode === "proxy") {
    try { await enterApp(); }
    catch (e) { console.error("proxy enterApp failed", e); showSignIn(e && e.message); }
    return;
  }

  const [{ initializeApp }, authMod] = await Promise.all([
    import("https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js"),
    import("https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js"),
  ]);
  const { getAuth, onAuthStateChanged, signInWithEmailAndPassword, signInWithPopup, signOut,
          OAuthProvider, GoogleAuthProvider } = authMod;
  auth = getAuth(initializeApp(cfg.firebase));
  fbSignOut = () => signOut(auth);

  wireSignIn({ signInWithEmailAndPassword, signInWithPopup, OAuthProvider, GoogleAuthProvider });

  onAuthStateChanged(auth, async (user) => {
    if (user) {
      try {
        setToken(await user.getIdToken());
        await enterApp();
      } catch (e) { console.error("sign-in → enterApp failed", e); showSignIn(e && e.message); }
    } else {
      setToken("");
      showSignIn();
    }
  });
}

// Load shared state (/api/me) and reveal the app shell. Shared by the Firebase and test paths.
async function enterApp() {
  await refreshMe();
  $("#signin").hidden = true;
  $("#topbar").hidden = false;
  $("#tabbar").hidden = false;
  $("#app").hidden = false;
  const m = me() || {};
  if (m.app_name) setBrand(m.app_name);
  paintAccount(m);
  // First-run routing: no edition chosen → registration; chosen but not onboarded → onboarding.
  // (Both are stubs today; openView() no-ops safely until those agents ship. Guarded so verify —
  // which mocks an onboarded, editioned user — lands straight on Home.)
  if (!m.edition) openView("register");
  else if (!m.onboarded) openView("onboarding");
  showView("home");
}

// app.js owns the /api/me fetch; lib.refreshMe() calls back here so any view can refresh state.
async function refreshMe() {
  const m = await api("/api/me");
  setMe(m);
  return m;
}
setRefreshMe(refreshMe);

// ---------------------------------------------------------------- sign-in view
function showSignIn(errMsg) {
  $("#topbar").hidden = true;
  $("#tabbar").hidden = true;
  $("#app").hidden = true;
  $("#signin").hidden = false;
  if (errMsg) $("#authErr").textContent = errMsg;
}
const showAuthErr = (e) => ($("#authErr").textContent = (e && e.message) || String(e));

function wireSignIn(fb) {
  $("#appleBtn").addEventListener("click", () =>
    fb.signInWithPopup(auth, new fb.OAuthProvider("apple.com")).catch(showAuthErr));
  $("#googleBtn").addEventListener("click", () =>
    fb.signInWithPopup(auth, new fb.GoogleAuthProvider()).catch(showAuthErr));
  $("#signinForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    $("#authErr").textContent = "";
    try { await fb.signInWithEmailAndPassword(auth, $("#email").value, $("#password").value); }
    catch (err) { showAuthErr(err); }
  });
}

// ---------------------------------------------------------------- chrome: nav, menu, theme
function wireChrome() {
  // Nav: header tabs + bottom tab bar share [data-view] → one showView drives both.
  $$("[data-view]").forEach((b) => b.addEventListener("click", () => showView(b.dataset.view)));
  // Any [data-open="name"] control opens that feature view (Goals, Upgrade, "Set goals", …).
  $$("[data-open]").forEach((b) => b.addEventListener("click", (e) => { e.stopPropagation(); closeMenu(); openView(b.dataset.open); }));
  wireAccountMenu();
  wireTheme();
  $("#signoutBtn").addEventListener("click", () => { closeMenu(); doSignOut(); });
}

function doSignOut() {
  if (fbSignOut) { try { fbSignOut(); } catch (_) {} }
  else { setToken(""); showSignIn(); } // test mode
}

function setBrand(name) {
  $("#brandName").textContent = name;
  const sb = $("#signinBrand"); if (sb) sb.textContent = name;
}

function paintAccount(m) {
  const email = m.email || "";
  $("#who").textContent = email;
  $("#menuEmail").textContent = email;
  $("#avatar").textContent = (email[0] || "?").toUpperCase();
  // Hosted edition "just works" — show Upgrade only when the user is not on a paid hosted SKU.
  const up = $("#menuUpgrade");
  if (up) up.hidden = hasSku("sate_hosted");
  // Admin console (operator only) — env-admin or profile role==admin, per /api/me.
  const ad = $("#menuAdmin");
  if (ad) ad.hidden = !(m.isAdmin || m.role === "admin");
}

function wireAccountMenu() {
  const btn = $("#userBtn"), menu = $("#userMenu");
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    const open = menu.hidden;
    menu.hidden = !open;
    btn.setAttribute("aria-expanded", String(open));
  });
  document.addEventListener("click", closeMenu);
  menu.addEventListener("click", (e) => e.stopPropagation());
}
function closeMenu() {
  const menu = $("#userMenu"), btn = $("#userBtn");
  if (menu) menu.hidden = true;
  if (btn) btn.setAttribute("aria-expanded", "false");
}

// Theme: System / Light / Dark, persisted to localStorage; applied before paint by the inline head
// script and re-applied here so the segmented control reflects the saved choice.
function wireTheme() {
  const apply = (t) => {
    if (t === "system") delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = t;
    try { localStorage.setItem("sate-theme", t); } catch (_) {}
    $$('#themeSeg [data-theme-choice]').forEach((b) => b.classList.toggle("active", b.dataset.themeChoice === t));
  };
  let saved = "system";
  try { saved = localStorage.getItem("sate-theme") || "system"; } catch (_) {}
  apply(saved);
  $$('#themeSeg [data-theme-choice]').forEach((b) => b.addEventListener("click", () => apply(b.dataset.themeChoice)));
}

main();
