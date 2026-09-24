# QCI Central Finite Curve (v4 monorepo)

SuperDoc-native institutional drafting + governance platform.

**Branch:** `feat/cfc-v4-superdoc`  
**Plan:** `implementation plan v4` (FINAL)  
**Kickoff checklist:** `SUPERDOC_KICKOFF.md`

## Apps

| Path | Role | Port |
|---|---|---|
| `apps/web` | Next.js 15 + SuperDoc Document Studio | 3000 |
| `apps/api` | FastAPI drafts, session RBAC, workflow | 8000 |
| `apps/doc-worker` | SuperDoc headless SDK worker | 8100 |

Legacy Streamlit app under `src/` is **frozen**.

## Setup

```bash
# from repo root
npm install
python -m pip install -r apps/api/requirements.txt

# One-time DB bootstrap (SQLite dev by default at storage/dev/cfc.db;
# set DATABASE_URL to a Postgres URL for prod / Sprint 3 pgvector work).
cd apps/api && python -m alembic upgrade head && cd ../..

# One-time corpus ingest (extracts + chunks + embeds ~48 Work Orders; ~1 min cold).
# For scanned PDFs (empty text layer), set RUNPULSE_API_KEY in .env to enable OCR.
# Optional per-file guard: RUNPULSE_MAX_MB=20 skips PDFs above that size.
python -m apps.api.app.ingest
```

Optional local Postgres for pgvector-shaped retrieval:

```bash
docker compose up -d postgres
export DATABASE_URL='postgresql+psycopg://cfc:cfc@127.0.0.1:5433/cfc'
cd apps/api && python -m alembic upgrade head && cd ../..
python -m apps.api.app.ingest
```

Expand users beyond the 7-person demo spine (uses your own Gemini key):

```bash
pip install google-genai
export GEMINI_API_KEY=...
python scripts/ocr_hierarchy.py            # dry run — emits _expanded.json
python scripts/ocr_hierarchy.py --merge    # confirms each row before adding
```

## Run (three terminals)

```bash
npm run dev:api
npm run dev:web
npm run dev:doc-worker   # optional until agent path
```

The API seeds divisions + demo users from `packages/qci-seed/hierarchy.seed.json` on every boot (idempotent).

**Note:** `dev:web` uses **webpack** (not Turbopack). SuperDoc's docx-engine breaks under Turbopack with `classprivatemethodget ... call is not a function`. Do not re-add `--turbopack` until that is fixed upstream.

**SuperDoc workers:** v2 needs browser module workers (~8MB). Next breaks default `import.meta.url` worker resolution, so workers are copied to `apps/web/public/superdoc-workers/` and passed via `workerUrls`. Sync with `npm run sync:superdoc-workers` (also runs on `predev` / `prebuild`).

If you see *browser worker failed to start*: hard-refresh, confirm `/superdoc-workers/document-worker.js` returns 200, and restart `npm run dev:web`.

`/dev/superdoc-spike` is a **technical fixture test only**, not final product UI. Product surface is `/studio` (early shell).

Open:
- http://localhost:3000/studio
- http://localhost:3000/dev/superdoc-spike
- http://127.0.0.1:8000/docs

## Smoke test

`ash
# API (+ optional doc-worker) must be running
node scripts/smoke-cfc.mjs
`

## Dev auth

Pass persona via header `X-CFC-User` (employee id):

| Persona | Id |
|---|---|
| Arpit (Maker) | 6281 |
| Aashna (L1) | 1820 |
| Subroto (L2) | 1052 |
| SG | 613 |
| Admin | 8599 |

Studio UI persona dropdown sets this automatically.

## Notes

- SuperDoc is client-only (`ssr: false`).
- DOCX versions land in `storage/dev/drafts/` (gitignored).
- SuperDoc commercial license required before public production — see `docs/licensing-superdoc.md`.
