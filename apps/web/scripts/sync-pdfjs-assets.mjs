// Copies PDF.js's worker and the data files it loads at runtime into
// public/pdfjs/, so the Reader serves them from our own origin (no CDN).
//   pdf.worker.min.mjs  the parsing/rendering worker
//   cmaps/              character maps for CJK and other encoded fonts
//   standard_fonts/     the 14 standard PDF fonts, for files that don't embed them
//   wasm/, iccs/        image decoders (JPEG 2000, JBIG2) and colour profiles
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(__dirname, "..");
const require = createRequire(import.meta.url);
const pkgDir = path.dirname(require.resolve("pdfjs-dist/package.json"));
const outDir = path.join(webRoot, "public", "pdfjs");

fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });
fs.copyFileSync(path.join(pkgDir, "build", "pdf.worker.min.mjs"), path.join(outDir, "pdf.worker.min.mjs"));
for (const dir of ["cmaps", "standard_fonts", "wasm", "iccs"]) {
  const src = path.join(pkgDir, dir);
  if (fs.existsSync(src)) fs.cpSync(src, path.join(outDir, dir), { recursive: true });
}
const version = JSON.parse(fs.readFileSync(path.join(pkgDir, "package.json"), "utf8")).version;
console.log(`[sync-pdfjs-assets] pdfjs-dist ${version} -> ${outDir}`);
