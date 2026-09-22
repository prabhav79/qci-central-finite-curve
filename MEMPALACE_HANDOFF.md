# CFC MemPalace Handoff Brief
**Project:** QCI Central Finite Curve (CFC)
**Path:** C:\Work\QCI\Central Finite Curve
**Branch:** feat/cfc-v4-superdoc
**Palace wing:** `central_finite_curve`
**Indexed:** `mempalace init .` + `mempalace mine . --wing central_finite_curve` (~430 drawers)

## Load context in another AI
```bash
mempalace wake-up
mempalace search "SuperDoc Document Studio RBAC" --wing central_finite_curve
mempalace search "implementation plan v4" --wing central_finite_curve
mempalace search "corpus RAG doc-worker" --wing central_finite_curve
```
Or connect MemPalace MCP and call `mempalace_search` / `mempalace_wake_up`.

## Product thesis (immutable)
CFC = Institutional RAG + Org RBAC + SuperDoc Document OS.
Official drafts are real DOCX (not markdown). Approvals use redlines/comments/versions.
Streamlit under `src/` is FROZEN legacy demo.

## Authoritative plan
- `implementation plan v4` (FINAL)
- Also: `implementation plan v3`, `SUPERDOC_KICKOFF.md`, `README.md`

## Stack
| Piece | Location |
|---|---|
| Web | `apps/web` Next.js 15, **webpack only** (no turbopack), SuperDoc `@superdoc-dev/react` |
| API | `apps/api` FastAPI, file drafts in `storage/dev/drafts` |
| Doc worker | `apps/doc-worker` Node + `@superdoc-dev/sdk` |
| Shared | `packages/shared-types`, `qci-seed`, `doc-fixtures` |
| Corpus | `data/processed/*.json` (19 docs, 59 keyword chunks) |

## SuperDoc critical facts
1. Never SSR SuperDoc — dynamic import with `ssr: false`
2. Turbopack breaks SuperDoc (`classprivatemethodget.call is not a function`) — use webpack `next dev --port 3000`
3. Workers must use explicit same-origin URLs under `/superdoc-workers/*.js` via `npm run sync:superdoc-workers`
4. Save path = SuperDoc `export({ triggerDownload: false })` Blob then API PUT
5. Modes/roles from server session; dev auth header `X-CFC-User: <employee_id>`

## RBAC demo spine
- SG 613 Chakravarthy T. Kannan
- L2 1052 Subroto Ghosh
- L1 1820 Aashna Arora
- Maker 6281 Arpit Mathur
- Admin 8599 Prabhav Kumar Singh (`is_admin`)

States: DRAFT -> PENDING_L1_REVIEW -> APPROVED_L1_PENDING_L2 -> FINAL_APPROVED | REJECTED | CHANGES_REQUESTED

## Run (3 terminals)
```powershell
npm run dev:api
npm run dev:web
npm run dev:doc-worker
```
- Studio: http://localhost:3000/studio
- Spike (fixture only): http://localhost:3000/dev/superdoc-spike
- API: http://127.0.0.1:8000/docs
- Smoke: `node scripts/smoke-cfc.mjs`

If ports busy (WinError 10013 / EADDRINUSE): kill PIDs listening on 8000/8100 then restart.

## APIs already built
- Drafts: list/create/file GET-PUT/session/submit/decide/from-worker
- Corpus: `/corpus/stats`, `/corpus/search`, `/rag/query`, `/corpus/reload`
- Health: `/integrations/health`

## Done
Monorepo on feat/cfc-v4-superdoc; SuperDoc workerUrls fix; versioned drafts; two-tier approval; doc-worker SDK seed; keyword RAG panel; smoke tests.

## Next
1. Postgres + JWT auth (replace X-CFC-User)
2. Ingest remaining Work Order PDFs into corpus
3. Agent that edits open SuperDoc from RAG
4. Hocuspocus collab
5. Railway deploy + SuperDoc commercial license

## Read first
`implementation plan v4`, `README.md`, `MEMPALACE_HANDOFF.md`, `DocumentStudio.tsx`, `SuperDocClient.tsx`, `superdocWorkers.ts`, `apps/api/app/main.py`, `corpus.py`, `rag.py`, `doc-worker/src/index.ts`, `packages/qci-seed/hierarchy.seed.json`, `mempalace.yaml`

## Palace location
Default: `~/.mempalace/palace` (see `~/.mempalace/config.json`)
Project config: `mempalace.yaml`
Wing: `central_finite_curve`
