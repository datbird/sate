import type { CapacitorConfig } from '@capacitor/cli';

// Sate's auth is a trusted email header injected by a reverse proxy (Cloudflare Access),
// and its API is same-origin. Bundling the SPA into the app would make every /api/sate call
// cross-origin, which the proxy answers with a login redirect rather than data. So the shell
// loads the live instance in the webview instead: same origin, the proxy's login flow runs
// as a normal in-app browser login, and no server changes are needed. Capacitor still injects
// its native bridge into the remote page, so native plugins remain available to it.
//
// SATE_URL is read from the environment and never committed — this repo is public, and the
// instance URL is deployment-specific. Set it when syncing:
//   SATE_URL=https://sate.example.com npm run sync
//
// With SATE_URL unset, the app falls back to the offline placeholder in `www/`.
const url = process.env.SATE_URL;

// Capacitor's webview only navigates within SATE_URL's host; every other host is handed to the
// system browser. An auth proxy redirects to its own domain to log you in (Cloudflare Access ->
// <team>.cloudflareaccess.com), so without listing that host here the login opens in Safari, the
// session cookie lands in Safari's cookie jar, and the app is never authenticated.
//
//   SATE_AUTH_HOSTS=myteam.cloudflareaccess.com SATE_URL=... npm run sync
//
// Comma-separated; wildcards like *.cloudflareaccess.com are accepted.
const authHosts = (process.env.SATE_AUTH_HOSTS || "")
  .split(",")
  .map((h) => h.trim())
  .filter(Boolean);

const config: CapacitorConfig = {
  appId: 'com.beamflash.sate',
  appName: 'Sate',
  webDir: 'www',
  ios: {
    // Sate is a dark/light-aware SPA; let it paint its own background rather than flashing white.
    backgroundColor: '#ffffff',
    contentInset: 'always',
  },
  ...(url
    ? {
        server: {
          url,
          cleartext: false,
          ...(authHosts.length ? { allowNavigation: authHosts } : {}),
        },
      }
    : {}),
  plugins: {
    SplashScreen: {
      launchShowDuration: 0,
    },
  },
};

export default config;
