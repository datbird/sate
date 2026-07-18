// Fingerprint the shared SPA for the self-host edition — same approach as the cloud host
// (sate-cloud/scripts/build-web.mjs): esbuild-bundle app.js to app.<hash>.js, content-hash style.css,
// rewrite index.html, so deploys behind Cloudflare need no cache purge / hard-refresh. Reads the
// shared core/src/web; writes ./web (copied into the image + served by main.ts).
import * as esbuild from "esbuild";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, rmSync, cpSync, existsSync } from "node:fs";
import { join } from "node:path";

const SRC = "../core/src/web";
const OUT = "web";

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const result = await esbuild.build({
  entryPoints: [join(SRC, "app.js")],
  bundle: true,
  format: "esm",
  target: "es2020",
  charset: "utf8",
  minify: false,
  entryNames: "[name].[hash]",
  outdir: OUT,
  metafile: true,
  external: ["https://*", "http://*"], // Firebase (gstatic) stays external; unused in proxy mode
});
const appName = Object.keys(result.metafile.outputs)
  .find((f) => f.endsWith(".js"))
  .slice(OUT.length + 1);

const css = readFileSync(join(SRC, "style.css"));
const cssName = `style.${createHash("sha256").update(css).digest("hex").slice(0, 8)}.css`;
writeFileSync(join(OUT, cssName), css);

if (existsSync(join(SRC, "icons"))) cpSync(join(SRC, "icons"), join(OUT, "icons"), { recursive: true });
for (const f of ["manifest.webmanifest", "favicon.ico"]) {
  if (existsSync(join(SRC, f))) cpSync(join(SRC, f), join(OUT, f));
}

let html = readFileSync(join(SRC, "index.html"), "utf8");
if (!html.includes("/app.js") || !html.includes("/style.css")) throw new Error("index.html asset refs changed — update build-web");
html = html.replace("/app.js", "/" + appName).replace("/style.css", "/" + cssName);
writeFileSync(join(OUT, "index.html"), html);

console.log(`build-web → ${OUT}/: ${appName}, ${cssName}`);
