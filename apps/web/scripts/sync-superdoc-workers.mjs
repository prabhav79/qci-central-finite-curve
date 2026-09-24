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

console.log(`[sync-superdoc-workers] done -> ${outDir}`);
