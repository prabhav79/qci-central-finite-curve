/**
 * SuperDoc v2 runs document work in browser module workers.
 * Next/webpack often breaks default import.meta.url worker resolution,
 * so we serve the official worker entry bundles from /public and pass
 * explicit same-origin workerUrls.
 *
 * Source packages:
 *   node_modules/@superdoc/docx-engine/dist/assets/*
 * Copied to:
 *   apps/web/public/superdoc-workers/*
 *
 * Re-run: npm run sync:superdoc-workers
 */
export const SUPERDOC_WORKER_URLS = {
  document: "/superdoc-workers/document-worker.js",
  collaboration: "/superdoc-workers/collaboration-worker.js",
  reviewIndex: "/superdoc-workers/review-index-worker.js",
} as const;

/** Default props every SuperDoc mount should receive in CFC. */
export const SUPERDOC_DEFAULT_PROPS = {
  workerUrls: SUPERDOC_WORKER_URLS,
  // Cold webpack/dev cache can make the ~8MB worker slow to evaluate.
  workerStartupTimeoutMs: 60_000,
  telemetry: { enabled: false },
} as const;
