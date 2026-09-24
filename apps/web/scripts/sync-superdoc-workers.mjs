import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(__dirname, "..");
const repoRoot = path.resolve(webRoot, "../..");
const assetsDir = path.join(
  repoRoot,
  "node_modules",
  "@superdoc",
  "docx-engine",
  "dist",
  "assets",
);
const outDir = path.join(webRoot, "public", "superdoc-workers");

// SuperDoc's real compiled CSS. public/superdoc-style.css previously held a
// verbatim copy of @superdoc-dev/react's own style.css, which is itself just
// a bundler re-export stub (`@import 'superdoc/style.css';`). That specifier
// only resolves inside a bundler via the `superdoc` package's own
// package.json "exports" map (`"./style.css": "./dist/style.css"`) — a
// browser fetching it as a literal static file 404s, so SuperDoc's theme
// never applied (unstyled toolbar text, oversized unconstrained icon SVGs,
// black canvas).
//
// The correct source is the unscoped `superdoc` package (the actual runtime
// UI/editor library — confirmed by its console version log matching, and by
// its Vue scoped-style `data-v-*` hashes matching the live-rendered DOM).
// NOT `@superdoc/docx-engine` (a separate, differently-versioned internal
// dependency that also happens to ship a style.css with plausible-looking
// but non-matching scope hashes — copying from there was tried first and
// silently applied zero rules to the live component tree).
const cssSrc = path.join(repoRoot, "node_modules", "superdoc", "dist", "style.css");
const cssOut = path.join(webRoot, "public", "superdoc-style.css");

const mapping = [
  ["browser-worker-entry-CsWhwFNb.js", "document-worker.js"],
  ["collaboration-worker-entry-BFoMg_Zo.js", "collaboration-worker.js"],
  ["review-index-worker-entry-B-MDAFnP.js", "review-index-worker.js"],
];

if (!fs.existsSync(assetsDir)) {
  console.error(`[sync-superdoc-workers] Missing assets at ${assetsDir}`);
  console.error("Run npm install from the monorepo root first.");
  process.exit(1);
}

fs.mkdirSync(outDir, { recursive: true });

// Hashed asset names can change across SuperDoc versions — prefer exact map,
// then fall back to prefix match.
const available = fs.readdirSync(assetsDir);
for (const [exactName, outName] of mapping) {
  let srcName = exactName;
  if (!available.includes(exactName)) {
    const prefix = exactName.replace(/-[A-Za-z0-9_]+\.js$/, "");
    const match = available.find(
      (n) => n.startsWith(prefix) && n.endsWith(".js") && !n.endsWith(".map"),
    );
    if (!match) {
      console.error(`[sync-superdoc-workers] No asset for ${exactName}`);
      process.exit(1);
    }
    srcName = match;
    console.warn(`[sync-superdoc-workers] ${exactName} missing; using ${srcName}`);
  }
  fs.copyFileSync(path.join(assetsDir, srcName), path.join(outDir, outName));
  console.log(`[sync-superdoc-workers] ${srcName} -> ${outName}`);
}

if (!fs.existsSync(cssSrc)) {
  console.error(`[sync-superdoc-workers] Missing CSS at ${cssSrc}`);
  process.exit(1);
}
fs.copyFileSync(cssSrc, cssOut);
console.log(`[sync-superdoc-workers] style.css -> ${path.relative(webRoot, cssOut)}`);

console.log(`[sync-superdoc-workers] done -> ${outDir}`);
