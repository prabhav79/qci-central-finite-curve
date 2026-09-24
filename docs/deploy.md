# Deploying CFC to Railway

Sprint 6 cutover walkthrough. Four services (web, api, doc-worker, collab)
sharing one Postgres + one S3-compatible bucket, all in the same Railway
project so the private network hostnames work.

## Prerequisites

- Railway account with billing set (Hobby tier is enough for staging)
- Railway CLI installed on your dev machine: `npm i -g @railway/cli`
- The QCI GitHub repo pushed with the `feat/cfc-v4-superdoc` branch
- Nothing about SuperDoc licensing — we ship under AGPL (see [`licensing-superdoc.md`](licensing-superdoc.md)).

## Key sharing note (for Aashna)

You do NOT need to paste Railway tokens into chat. On your machine:

```bash
railway login          # opens browser, authenticates the CLI to your account
cd "C:/Work/QCI/Central Finite Curve"
railway init           # attaches this repo to a Railway project
```

The CLI stores the token in `~/.railway/config.json` on your machine. Every
`railway ...` command I run from here uses that local auth. No credentials
touch the chat.

## 1. Create the project

```bash
cd "C:/Work/QCI/Central Finite Curve"
railway init            # pick a project name, e.g. cfc-staging
railway link            # link the local repo to it
```

## 2. Provision Postgres (with pgvector)

Railway → project → **+ New** → **Database** → **PostgreSQL**. Then in the
Postgres service **Data** tab, run once:

```sql
CREATE EXTENSION IF NOT EXISTS vector;
```

Grab `DATABASE_URL` from the Postgres service **Variables** and note it —
Railway lets other services reference it as `${{Postgres.DATABASE_URL}}`.

## 3. Provision object storage

**For the prototype demo: use Railway Volumes** — attach a persistent volume
to `cfc-api` at `/app/storage` and set `CFC_STORAGE_NAMESPACE=prod`. Zero
extra services, drafts survive redeploys, one dashboard for everything.

Once QCI's IT confirms an S3-compatible bucket vendor (Backblaze B2 /
Cloudflare R2 / AWS S3), the `Bucket` protocol in `apps/api/app/storage.py`
accepts a swap-in — set:
- `CFC_STORAGE_BACKEND=s3`
- `AWS_S3_ENDPOINT_URL=...`
- `AWS_ACCESS_KEY_ID=...`
- `AWS_SECRET_ACCESS_KEY=...`
- `CFC_STORAGE_BUCKET=cfc-prod`

Not needed for the demo. Do it when leadership approves prod scale.

## 4. Add the four services from Dockerfiles

For each of `apps/api`, `apps/web`, `apps/doc-worker`, `apps/collab`:

```bash
railway up --service cfc-api        # picks apps/api/Dockerfile via railway.toml
railway up --service cfc-web
railway up --service cfc-doc-worker
railway up --service cfc-collab
```

Or use the dashboard → **+ New** → **GitHub Repo** → pick the branch and
set the Dockerfile path for each service.

## 5. Wire env vars per service

### cfc-api
| Var | Value |
|---|---|
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` |
| `DOC_WORKER_URL` | `http://${{cfc-doc-worker.RAILWAY_PRIVATE_DOMAIN}}:8100` |
| `CFC_STORAGE_NAMESPACE` | `prod` |
| `CFC_AUTH_MODE` | `personas` (demo) or `magic-link` (real users, post-leadership-approval) |
| `CFC_JWT_SECRET` | `openssl rand -hex 32` (only used when `CFC_AUTH_MODE=magic-link`) |
| `CFC_ALLOWED_EMAIL_DOMAIN` | `qcin.org` |
| `CFC_WEB_URL` | Web service public URL — used in magic-link email links |
| `CFC_WEB_ORIGIN` | Comma-separated allowed CORS origins (usually just the web public URL) |
| `RESEND_API_KEY` | Optional; enables real email delivery for magic links. Skip for demo (link prints to logs). |
| `RUNPULSE_API_KEY` | (from `.env`) |
| `GEMINI_API_KEY` / `GEMINI_MODEL` | optional (server-side LLM chain) |
| `GROQ_API_KEY` / `GROQ_MODEL` | optional (server-side LLM chain) |
| `CFC_AGENT_FALLBACK` | `gemini,groq` |
| `CFC_RATE_AGENT_CHAT` | default `10/minute` — bump when Groq tier upgrades |
| `CFC_RATE_RAG_QUERY` | default `30/minute` |
| `CFC_RATE_CORPUS_REINDEX` | default `3/hour` |

### cfc-web
| Var | Value |
|---|---|
| `NEXT_PUBLIC_CFC_API_BASE` | `https://${{cfc-api.RAILWAY_PUBLIC_DOMAIN}}` |
| `NEXT_PUBLIC_CFC_DOC_WORKER_BASE` | (usually not needed publicly — leave unset if all worker calls flow through the API) |

### cfc-doc-worker
| Var | Value |
|---|---|
| `DOC_WORKER_PORT` | `8100` |

### cfc-collab
| Var | Value |
|---|---|
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` |
| `COLLAB_PORT` | `8200` |
| `COLLAB_TOKEN` | generate a shared secret; put the same value in `cfc-web` and `cfc-api` env so the frontend can request a signed session token |

## 6. Expose only what needs to be public

- `cfc-web`: public HTTPS domain
- `cfc-api`: public HTTPS domain (CORS trimmed to the web origin)
- `cfc-doc-worker`: internal only (no public domain)
- `cfc-collab`: public domain **only when** collab client wiring lands in
  Sprint 5.5. For now, leave it internal.

Verify CORS: `apps/api/app/main.py` currently hard-codes localhost:3000.
Before the first public push, swap to reading `CFC_WEB_ORIGIN` env and
list the Railway web domain there.

## 7. First deploy smoke

```bash
# Get public URLs
railway domain --service cfc-api
railway domain --service cfc-web

# Health check
curl https://<cfc-api-domain>/health
curl https://<cfc-api-domain>/integrations/health

# Studio should load and the demo personas dropdown should populate
open https://<cfc-web-domain>/studio
```

## 8. First corpus ingest on prod

```bash
railway run --service cfc-api python -m apps.api.app.ingest
```

## 9. Rollback

Railway keeps every deploy — one click reverts to the last known-good.
For DB rollback, use Railway's Postgres backups (Hobby: daily snapshots,
retained 7 days).

## Known gaps to close before wider sharing

- SSO / JWT (Sprint 6.5) — kill `X-CFC-User` dev header in prod
- SuperDoc commercial license key wired via env
- S3-compatible bucket backend (currently local volume)
- Playwright + smoke on CI (GitHub Action against every push)
- Rate limits on public endpoints
