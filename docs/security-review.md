# CFC v4 security review checklist

Living checklist for what needs to be true before the CFC URL is shared
outside the engineering group. Each row lists current status, owner, and
what actually needs to happen.

## Legend
- ✅ done · 🟡 partial · 🔴 not done · ⚪ n/a

## Authentication & session

| Item | Status | Notes |
|---|---|---|
| `X-CFC-User` dev header replaced with real SSO / JWT | 🟡 | Magic-link auth on `@qcin.org` implemented in `apps/api/app/auth.py`. Personas mode stays default (`CFC_AUTH_MODE=personas`) for the leadership demo. Flip to `CFC_AUTH_MODE=magic-link` for real users. |
| Session tokens signed and rotated | 🟡 | HS256 JWT with `CFC_JWT_SECRET`, 12h TTL. Rotation strategy = re-login. |
| Email domain enforcement | ✅ | `@qcin.org` only; configurable via `CFC_ALLOWED_EMAIL_DOMAIN`. |
| SuperDoc mode/role derived server-side (client can't self-upgrade) | ✅ | See `_session_for` in `apps/api/app/main.py`. |
| Password reset / recovery flow | ⚪ | N/A — magic-link is stateless, no passwords. |

## Authorization (RBAC + division silo)

| Item | Status | Notes |
|---|---|---|
| Cross-division reads blocked for non-apex, non-admin | ✅ | Enforced in `_session_for`, `list_drafts`, `approvals_inbox`, `list_threads`, `db_search`, `db_list_documents`. |
| Apex (SG) has global read | ✅ | `_can_view_division` short-circuits on `cfc_role == "apex"`. |
| Admin cannot silently promote self to final approver | ✅ | Admin is allowed to save/decide but every action is logged with actor_employee_id. |
| Server rejects invalid state transitions (e.g. approve without L1 first) | ✅ | `decide_draft` gates on `draft.status`. |
| Reject / changes-requested requires a non-empty comment | ✅ | 400 otherwise. |

## Data integrity

| Item | Status | Notes |
|---|---|---|
| Every version writes a new row (no overwrites) | ✅ | `DraftVersion` is append-only; agent mutations create fresh rows via `_dispatch_mutate`. |
| Final export SHA-256 stored | ✅ | `draft.final_sha256`. |
| Audit log on every mutation | ✅ | `AuditLog` entries: draft.create, save, submit, decide, agent.chat, corpus.upload, thread.*, corpus.reindex. |
| Object storage keys don't allow path traversal | ✅ | `LocalBucket._abs` rejects `..`; validates escape out of the bucket root. |

## Secrets

| Item | Status | Notes |
|---|---|---|
| `.env` in `.gitignore` | ✅ | Verified. |
| Grep for accidental key commits | 🟡 | Manual pass at each release. Add pre-commit hook (gitleaks) in Sprint 6.5. |
| Keys loaded with `override=True` so rotated keys always win | ✅ | Prevents shadowing by stale user-level env vars (Windows). |
| Secrets never appear in audit log payloads | ✅ | Reviewed — only IDs, sizes, decisions logged. |
| Secrets never returned in HTTP responses | ✅ | `_obfuscate_db_url` masks the password in `/integrations/health`. |

## LLM & agent surface

| Item | Status | Notes |
|---|---|---|
| BYOK for user chat + agent generation | ✅ | Server-side key only used when frontend sends `provider='auto'` (opt-in server chain). |
| Agent cannot escape ACL via corpus tool | ✅ | `cfc_search_corpus` calls `db_search` with the caller's `user`; division filter mandatory. |
| Agent mutations rate-limited or version-capped | ✅ | `MAX_STEPS=6` in agent loop + `CFC_RATE_AGENT_CHAT=10/minute` per user via slowapi. |
| Agent audit trail | ✅ | `draft.agent.chat.start`, `draft.agent.agent_insert`, `draft.agent.agent_replace`, `draft.agent.redline`. |
| SSE endpoint doesn't leak API keys back to client | ✅ | Only frame `provider` name emitted, never key value. |
| Prompt injection surface (corpus text + user prompt) | 🟡 | Corpus is trusted (uploaded by staff). Consider a stricter system prompt when we open uploads to lower-tier users. |

## Transport & network

| Item | Status | Notes |
|---|---|---|
| CORS scoped to expected origins | ✅ | `CFC_WEB_ORIGIN` env var (comma-separated) drives the allowed origins list; default is `localhost:3000` for dev. |
| HTTPS enforced in prod | 🔴 | Handled by Railway edge; verify `Strict-Transport-Security` header at cutover. |
| Rate limits on public endpoints | ✅ | slowapi wired: agent/chat 10/min, rag/query 30/min, corpus/search 60/min, corpus/reindex 3/hr, auth/magic-link 5/hr. All tunable per env. |

## Third-party tools

| Item | Status | Notes |
|---|---|---|
| SuperDoc AGPL → commercial license | ⚪ | Aashna approved AGPL for internal demo (2026-09-23). Commercial license revisited only if leadership approves external distribution. |
| RunPulse OCR — data classification confirmed OK | 🟡 | QCI Work Orders are internal but not classified. Recheck with legal before demoing to any external body. |
| Gemini / Groq / OpenAI outbound calls flagged for IT | 🟡 | BYOK model means keys stay with staff; server-side keys only if the user opts in. Document for IT anyway. |

## Playwright / regression coverage

| Item | Status | Notes |
|---|---|---|
| DOCX round-trip suite exists | ✅ | `apps/web/tests/playwright/docx-round-trip.spec.ts` — runs against `packages/doc-fixtures/samples/`. |
| Runs in CI | 🔴 | Sprint 6 Railway cutover: add a GitHub Action gate. |
| Real WO/proposal fixtures loaded | 🟡 | 3 samples currently. Copy 5–10 more from `Work Orders/shortlisted_project/` before shipping public URL. |

## Pre-cutover manual pass

Before the first shared URL:

1. `grep -R -n -E '(gsk_|AKIA|AQ\\.|sk-|ghp_)' .` outside `.env` returns nothing.
2. `git log -p -- .env` shows no history of the file being tracked.
3. `curl` an approval endpoint with a maker's `X-CFC-User` id → 403.
4. Open a PPID draft as Virendra (QCI L2) → cross-division block observed.
5. Playwright: `npm run test:e2e` all green.
6. Kill switch: `CFC_ALLOW_DEV_AUTH=false` verified to make `X-CFC-User` header ignored (Sprint 6.5).
