import type { CapacitorConfig } from '@capacitor/cli';

// Sate is a GENERIC CLIENT: the app ships the local launcher in `www/` (index.html), which asks the
// user for their instance address on first run, stores it (Preferences, shared across origins), then
// navigates the webview to it. There is no baked `server.url` — every install connects to whatever
// host the user enters, and can switch or reconnect if that host is unreachable.
//
// `allowNavigation: ['*']` keeps every navigation inside the webview (so the auth proxy's login
// redirect — e.g. Cloudflare Access -> <team>.cloudflareaccess.com — and the instance itself both
// stay in-app) AND lets Capacitor inject its native bridge into the remote page, so native plugins
// (HealthKit, LocalNotifications, Preferences) remain available to the loaded instance.
//
// A known deployment can prefill the launcher's address field by writing `www/instance-default.js`
// (gitignored) at build time from SATE_URL — it never lands in this public repo. See
// sate-testflight-upload. The user still confirms the address on first launch.

const config: CapacitorConfig = {
  appId: 'com.beamflash.sate',
  appName: 'Sate',
  webDir: 'www',
  // No `ios` block on purpose. `contentInset: 'always'` insets the webview off the notch and home
  // indicator, exposing the native view behind it, and `backgroundColor` paints that view a single
  // static colour that can't follow the light/dark theme. The page already handles the safe areas
  // itself with env(safe-area-inset-*) under `viewport-fit=cover`, so let it draw edge to edge.
  server: {
    // Load the local launcher first (no url), and let it navigate to the user's chosen host in-app.
    allowNavigation: ['*'],
  },
  plugins: {
    SplashScreen: {
      launchShowDuration: 0,
    },
  },
};

export default config;
