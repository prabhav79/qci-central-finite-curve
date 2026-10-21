"""
CFC API — Postgres-shaped (SQLite dev fallback) draft governance.

Sprint 1 port: file-based meta.json + storage/dev/drafts/{id}/vN.docx becomes
SQLAlchemy 2 rows in `drafts`/`draft_versions`/`draft_approvals` + a
`Bucket` blob store. Response shapes are preserved byte-for-byte so
the Next.js Studio and scripts/smoke-cfc.mjs pass unchanged.

Division-tagged ACL:
- `list_drafts` and `approvals_inbox` filter to caller's division_code
  (SG apex and admins see everything). See project-cfc-visibility-rule.
- `_session_for` short-circuits cross-division non-apex callers to viewer.
"""
from __future__ import annotations

import hashlib
import json
import logging
import os
import queue
import re
import threading
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator, Literal
from urllib import request as urlrequest
from urllib.error import HTTPError, URLError

from dotenv import load_dotenv
from fastapi import BackgroundTasks, Cookie, Depends, FastAPI, File, Form, Header, HTTPException, Query, Request, Response, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from pydantic import BaseModel, Field
from slowapi import Limiter, _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded
from slowapi.util import get_remote_address
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session, selectinload

from .access import reads_all_boards
from .locks import draft_write_lock
from .agent_llm import LLMConfig, classify_error, error_frame, run_agent_with_fallback
from .ai_guard import AI_OFF_MESSAGE, CONFIDENTIAL_MESSAGE, ai_enabled
from . import auth as auth_mod
from . import jev_faithfulness
from . import jev_intake
from .agent_presets import (
    GENERATION_SECTIONS,
    MAX_INTAKE_TURNS,
    TEMPLATE_CATALOG,
    draft_generator_system,
    draft_generator_user,
    draft_intake_system,
    draft_intake_user,
    redline_extender_system,
    redline_extender_user,
)
from .agent_tools import (
    INTAKE_TOOL_SCHEMAS,
    REVIEWER_TOOL_SCHEMAS,
    TOOL_SCHEMAS,
    AgentContext,
    ToolError,
    _dispatch_mutate as agent_mutate,
    dispatch as agent_dispatch,
)
from . import corpus_meta, reader
from .corpus import corpus_stats as inmem_stats, get_document as inmem_get, list_documents as inmem_list, reload_corpus, search_corpus as inmem_search
from .corpus_db import (
    db_document_outline,
    db_get_document,
    db_has_corpus,
    db_list_documents,
    db_search,
    db_search_documents,
    db_stats,
    graph_children,
    recompute_all_edges,
)
from .db import ROOT, SessionLocal, ensure_pgvector, get_session
from .models import AuditLog, CorpusDocument, Division, Draft, DraftApproval, DraftVersion, ReaderHighlight, Thread, User
from .rag import answer_query
from .seed import seed_divisions_and_users
from .storage import Bucket, default_bucket

log = logging.getLogger("cfc.api")

# Nothing else configures the app's own loggers, so without this every
# info line (model usage per call, search re-rank timing, faithfulness
# misses) is dropped and only warnings reach the platform logs.
_cfc_log = logging.getLogger("cfc")
if not _cfc_log.handlers:
    _cfc_handler = logging.StreamHandler()
    _cfc_handler.setFormatter(logging.Formatter("%(levelname)s %(name)s: %(message)s"))
    _cfc_log.addHandler(_cfc_handler)
    _cfc_log.setLevel(os.environ.get("CFC_LOG_LEVEL", "INFO").upper())
    _cfc_log.propagate = False

TEMPLATES_DIR = ROOT / "packages" / "doc-fixtures" / "templates"
# Every new draft seeds from this — a genuinely empty document. Structure
# (which sections exist, in what order) comes entirely from the chosen
# template's `generation_outline`, not from pre-written file content. This
# replaced WO_EXTENSION.docx as the default seed: that file is a real prior
# QCI proposal (SVANidhi Se Samriddhi), left on disk untouched and still
# searchable in the corpus, but it should never again be silently copied into
# every new draft regardless of what the user asked for.
TEMPLATE = TEMPLATES_DIR / "BLANK.docx"
DOC_WORKER_URL = os.environ.get("DOC_WORKER_URL", "http://127.0.0.1:8100").rstrip("/")


def _resolve_template_path(template_code: str | None) -> Path:
    """Map a template_code to its seed .docx.

    Catalog codes (agent_presets.TEMPLATE_CATALOG) and corpus_doc-derived
    drafts always seed from the blank file — their *content* comes entirely
    from draft_generator, never a pre-written file. An admin-uploaded custom
    template (POST /corpus/templates, named {CODE}.docx) still wins when one
    exists and the code isn't a catalog entry, for the legitimate case of
    starting from a real letterhead/boilerplate file on purpose.
    """
    code = (template_code or "").strip().upper()
    if code and code not in TEMPLATE_CATALOG:
        candidate = TEMPLATES_DIR / f"{code}.docx"
        if candidate.exists():
            return candidate
    return TEMPLATE

load_dotenv(ROOT / ".env", override=True)
load_dotenv(override=True)

if auth_mod.auth_mode() == "magic-link" and auth_mod.using_default_secret():
    # The default secret is public in this repo; anyone could mint a session.
    raise RuntimeError("CFC_JWT_SECRET must be set when CFC_AUTH_MODE=magic-link")

app = FastAPI(title="CFC API", version="0.3.0")


def _limit_key(request: Request) -> str:
    if auth_mod.auth_mode() == "magic-link":
        claims = auth_mod.decode_jwt(request.cookies.get("cfc_session") or "")
        if claims and claims.get("sub"):
            return f"user:{claims['sub']}"
        return f"ip:{get_remote_address(request)}"
    user = request.headers.get("X-CFC-User")
    if user:
        return f"user:{user}"
    return f"ip:{get_remote_address(request)}"


limiter = Limiter(
    key_func=_limit_key,
    default_limits=[os.environ.get("CFC_RATE_DEFAULT", "300/minute")],
    storage_uri=os.environ.get("CFC_RATE_STORAGE", "memory://"),
)
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)

RATE_AGENT_CHAT = os.environ.get("CFC_RATE_AGENT_CHAT", "10/minute")
RATE_RAG_QUERY = os.environ.get("CFC_RATE_RAG_QUERY", "30/minute")
RATE_CORPUS_SEARCH = os.environ.get("CFC_RATE_CORPUS_SEARCH", "60/minute")
RATE_CORPUS_REINDEX = os.environ.get("CFC_RATE_CORPUS_REINDEX", "3/hour")
RATE_AUTH_MAGIC_LINK = os.environ.get("CFC_RATE_AUTH_MAGIC_LINK", "5/hour")

app.add_middleware(
    CORSMiddleware,
    allow_origins=os.environ.get("CFC_WEB_ORIGIN", "http://localhost:3000,http://127.0.0.1:3000").split(","),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
    # PDF.js reads these to load a large PDF a page range at a time.
    expose_headers=["Accept-Ranges", "Content-Range", "Content-Length"],
)


@app.middleware("http")
async def _no_dev_routes_outside_dev(request: Request, call_next):
    """The /dev/* routes exist for local persona testing only. With real
    sign-in they are switched off entirely (CERT-In CIAD-2026-0049: retire
    test and dormant APIs)."""
    if request.url.path.startswith("/dev/") and auth_mod.auth_mode() == "magic-link":
        return JSONResponse(status_code=404, content={"detail": "Not found"})
    return await call_next(request)


DraftStatus = Literal[
    "DRAFT",
    "PENDING_L1_REVIEW",
    "APPROVED_L1_PENDING_L2",
    "FINAL_APPROVED",
    "REJECTED",
    "CHANGES_REQUESTED",
]


# --------------------------------------------------------------------------- #
# Bootstrap
# --------------------------------------------------------------------------- #

@app.on_event("startup")
def _startup() -> None:
    """On every boot: ensure pgvector extension exists (Postgres only) and
    idempotently seed demo divisions + users. Both are no-ops after first success."""
    try:
        if ensure_pgvector():
            log.info("cfc: pgvector extension ready")
    except Exception:  # noqa: BLE001
        log.exception("cfc pgvector ensure failed")
    try:
        counts = seed_divisions_and_users()
        log.info("cfc seed: %s", counts)
    except Exception:  # noqa: BLE001
        log.exception("cfc seed failed")
    try:
        with SessionLocal() as meta_s:
            log.info("cfc library metadata: %s field(s) updated", corpus_meta.backfill(meta_s))
    except Exception:  # noqa: BLE001
        log.exception("cfc library metadata backfill failed")

    def _warm_embeddings() -> None:
        try:
            from .embeddings import embed_one  # noqa: PLC0415

            embed_one("warm up")
            log.info("cfc: embedding model warm")
        except Exception:  # noqa: BLE001
            log.exception("cfc embedding warm-up failed")

    threading.Thread(target=_warm_embeddings, daemon=True).start()
    try:
        from .ingest import reset_stale_jobs  # noqa: PLC0415

        with SessionLocal() as s:
            n = reset_stale_jobs(s)
        if n:
            log.info("cfc ingest: recovered %d stale ingestion job(s) stuck 'running'", n)
    except Exception:  # noqa: BLE001
        log.exception("cfc ingest stale-job recovery failed")


def _bucket() -> Bucket:
    return default_bucket()


# --------------------------------------------------------------------------- #
# Request models
# --------------------------------------------------------------------------- #

class CreateDraftBody(BaseModel):
    title: str = "Work Order Extension Draft"
    template_code: str = "BLANK"
    # "catalog" (default): template_code names an entry in TEMPLATE_CATALOG
    # (or a legacy/admin-uploaded file code). "corpus_doc": ignore
    # template_code's outline and derive the section structure from an
    # existing corpus document instead (corpus_doc_id required) — its
    # section *shape* is reused, never its actual paragraph content.
    template_source: Literal["catalog", "corpus_doc"] = "catalog"
    corpus_doc_id: str | None = None
    # None (the default) means "the caller" — resolved from the authenticated
    # session, not a hardcoded persona. Only an explicit value here overrides it
    # (e.g. an admin creating on behalf of someone else).
    maker_employee_id: str | None = None
    # Confidential: no AI help, nothing sent to outside services (ai_guard).
    ai_restricted: bool = False
    # Reader highlights (the caller's own) this draft starts from: their
    # documents become pinned precedents, their text reference excerpts.
    reference_highlight_ids: list[int] = []


class DecideBody(BaseModel):
    level: Literal[1, 2]
    decision: Literal["approve", "reject", "changes_requested"]
    comments: str = ""
    anchor: dict[str, Any] | None = None  # optional SuperDoc range/bookmark payload


class ThreadCreateBody(BaseModel):
    id: str | None = None  # SuperDoc thread id if known; else server generates
    kind: Literal["comment", "tracked_change", "review_reason"] = "comment"
    anchor: dict[str, Any] | None = None
    body: str = ""
    raw: dict[str, Any] | None = None


class ThreadPatchBody(BaseModel):
    resolved: bool | None = None
    body: str | None = None
    anchor: dict[str, Any] | None = None
    raw: dict[str, Any] | None = None


class ThreadsSyncItem(BaseModel):
    id: str
    kind: Literal["comment", "tracked_change", "review_reason"] = "comment"
    anchor: dict[str, Any] | None = None
    body: str = ""
    resolved: bool = False
    raw: dict[str, Any] | None = None
    author_employee_id: str | None = None


class ThreadsSyncBody(BaseModel):
    threads: list[ThreadsSyncItem]


class CreateFromWorkerBody(BaseModel):
    title: str = "CPGRAMS PMU Extension — Worker Seeded"
    find: str = "Quality Council of India"
    replace: str = "Quality Council of India (CFC Generated Draft)"
    tracked: bool = True
    maker_employee_id: str | None = None


class AgentChatBody(BaseModel):
    prompt: str
    provider: str = "mock"  # gemini | openai | mock
    api_key: str | None = None
    model: str | None = None
    preset: str | None = None  # e.g. "precedent_weaver"
    preset_args: dict[str, Any] | None = None


class SearchBody(BaseModel):
    query: str
    limit: int = 8
    ministry: str | None = None
    domain: str | None = None


class RagBody(BaseModel):
    query: str
    limit: int = 6
    ministry: str | None = None
    provider: str | None = None
    api_key: str | None = None
    model: str | None = None
    # The document the question is asked from, if any: a confidential one
    # gets matching passages only, with nothing sent to an AI service.
    draft_id: str | None = None


# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #

def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _iso(dt: datetime | None) -> str | None:
    return dt.astimezone(timezone.utc).isoformat() if dt else None


def _sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def _resolve_user(
    s: Session,
    x_cfc_user: str | None,
    cfc_session: str | None = None,
) -> User:
    """Auth resolution.

    - CFC_AUTH_MODE=personas (default, demo mode): X-CFC-User header identifies
      the user by employee_id, email, or name substring. Default Arpit 6281.
    - CFC_AUTH_MODE=magic-link (post-approval): only the cfc_session JWT cookie
      counts; X-CFC-User is ignored so a curious user can't spoof another
      persona in prod. If no valid cookie, 401.
    """
    mode = auth_mod.auth_mode()

    if mode == "magic-link":
        if not cfc_session:
            raise HTTPException(status_code=401, detail="Not signed in")
        claims = auth_mod.decode_jwt(cfc_session)
        if not claims:
            raise HTTPException(status_code=401, detail="Session expired or invalid")
        email = claims.get("sub")
        if not email:
            raise HTTPException(status_code=401, detail="Malformed session")
        user = s.execute(select(User).where(func.lower(User.email) == email.lower())).scalar_one_or_none()
        if not user:
            raise HTTPException(status_code=403, detail=f"No CFC user for {email}. Ask an admin to seed you.")
        return user

    # personas / demo mode
    key = (x_cfc_user or "6281").strip() or "6281"
    lower = key.lower()

    user = s.get(User, key)
    if user:
        return user

    user = s.execute(select(User).where(func.lower(User.email) == lower)).scalar_one_or_none()
    if user:
        return user

    user = s.execute(
        select(User).where(
            or_(
                func.lower(User.full_name).like(f"%{lower}%"),
                func.lower(User.email).like(f"%{lower}%"),
            )
        )
    ).scalars().first()
    if user:
        return user

    raise HTTPException(status_code=401, detail=f"Unknown user: {x_cfc_user}")


def _manager_of(s: Session, employee_id: str | None) -> User | None:
    if not employee_id:
        return None
    u = s.get(User, employee_id)
    if not u or not u.manager_employee_id:
        return None
    return s.get(User, u.manager_employee_id)


def _can_view_division(user: User, division_code: str) -> bool:
    """Cross-division visibility gate — see project-cfc-visibility-rule."""
    return reads_all_boards(user) or user.division_code == division_code


def _draft_to_dict(draft: Draft) -> dict[str, Any]:
    """Shape-compatible with the pre-DB meta.json payload."""
    approvals_by_level: dict[int, DraftApproval] = {}
    for ap in sorted(draft.approvals, key=lambda a: a.at):
        approvals_by_level[ap.level] = ap  # keep latest

    out: dict[str, Any] = {
        "id": draft.id,
        "title": draft.title,
        "template_code": draft.template_code,
        "maker_employee_id": draft.maker_employee_id,
        "division_code": draft.division_code,
        "status": draft.status,
        "ai_restricted": bool(draft.ai_restricted),
        "current_version": draft.current_version,
        "submitted_version": draft.submitted_version,
        "versions": [
            {
                "version": v.version,
                "trigger": v.trigger,
                "sha256": v.sha256,
                "created_at": _iso(v.created_at),
                "actor_employee_id": v.actor_employee_id,
            }
            for v in sorted(draft.versions, key=lambda x: x.version)
        ],
        "created_at": _iso(draft.created_at),
        "updated_at": _iso(draft.updated_at),
    }
    if draft.worker_meta:
        out["worker"] = draft.worker_meta
    if draft.final_storage_key:
        out["final_path"] = draft.final_storage_key
    if draft.final_sha256:
        out["final_sha256"] = draft.final_sha256
    if 1 in approvals_by_level:
        ap = approvals_by_level[1]
        out["l1_decision"] = {
            "decision": ap.decision,
            "comments": ap.comments,
            "at": _iso(ap.at),
            "by": ap.actor_employee_id,
            "version": ap.decided_on_version,
        }
    if 2 in approvals_by_level:
        ap = approvals_by_level[2]
        out["l2_decision"] = {
            "decision": ap.decision,
            "comments": ap.comments,
            "at": _iso(ap.at),
            "by": ap.actor_employee_id,
            "version": ap.decided_on_version,
        }
    return out


def _session_for(s: Session, user: User, draft: Draft) -> dict[str, Any]:
    """Compute per-persona SuperDoc session token from status + hierarchy."""
    maker = s.get(User, draft.maker_employee_id)
    l1 = _manager_of(s, draft.maker_employee_id)
    l2 = _manager_of(s, l1.employee_id) if l1 else None

    uid = user.employee_id
    is_maker = uid == draft.maker_employee_id
    is_l1 = bool(l1 and uid == l1.employee_id)
    is_l2 = bool(l2 and uid == l2.employee_id)
    is_admin = bool(user.is_admin)
    is_apex = user.cfc_role == "apex"
    cross_division = not _can_view_division(user, draft.division_code)

    role: str = "viewer"
    mode: str = "viewing"
    can_save = False
    can_submit = False
    can_decide_l1 = False
    can_decide_l2 = False
    can_run_agent_mutate = False
    agent_change_mode = "tracked"

    status = draft.status
    if cross_division:
        # Non-apex, non-admin caller in a different silo — hard read-block.
        # Return viewer/viewing and no capabilities.
        role, mode = "viewer", "viewing"
    elif status == "DRAFT":
        if is_maker or is_admin:
            role, mode = "editor", "editing"
            can_save = True
            can_submit = is_maker or is_admin
            can_run_agent_mutate = True
            agent_change_mode = "direct"
    elif status == "PENDING_L1_REVIEW":
        if is_l1 or is_admin:
            role, mode = "suggester", "suggesting"
            can_save = True
            can_decide_l1 = is_l1 or is_admin
            can_run_agent_mutate = True
    elif status == "APPROVED_L1_PENDING_L2":
        if is_l2 or is_admin:
            role, mode = "suggester", "suggesting"
            can_save = True
            can_decide_l2 = is_l2 or is_admin
            can_run_agent_mutate = True
    elif status in ("REJECTED", "CHANGES_REQUESTED"):
        if is_maker or is_admin:
            role, mode = "editor", "editing"
            can_save = True
            can_submit = True
            can_run_agent_mutate = True
            agent_change_mode = "direct"
    elif status == "FINAL_APPROVED":
        role, mode = "viewer", "viewing"

    return {
        "draft_id": draft.id,
        "user": {
            "id": user.employee_id,
            "name": user.full_name,
            "email": user.email,
            "designation": user.designation,
            "cfc_role": user.cfc_role,
            "division_code": user.division_code,
        },
        "superdoc_role": role,
        "document_mode": mode,
        "can_save": can_save,
        "can_submit": can_submit,
        "can_decide_l1": can_decide_l1,
        "can_decide_l2": can_decide_l2,
        "can_run_agent_mutate": can_run_agent_mutate,
        "agent_change_mode": agent_change_mode,
        "status": status,
        "version": draft.current_version,
        "title": draft.title,
        "division_code": draft.division_code,
        "cross_division_view": cross_division,
        "l1_employee_id": l1.employee_id if l1 else None,
        "l2_employee_id": l2.employee_id if l2 else None,
        "maker_employee_id": maker.employee_id if maker else draft.maker_employee_id,
    }


def _load_draft(s: Session, draft_id: str) -> Draft:
    draft = s.execute(
        select(Draft)
        .where(Draft.id == draft_id)
        .options(selectinload(Draft.versions), selectinload(Draft.approvals))
    ).scalar_one_or_none()
    if not draft:
        raise HTTPException(status_code=404, detail=f"Draft not found: {draft_id}")
    return draft


def _log_audit(
    s: Session,
    *,
    actor: User | None,
    action: str,
    target_kind: str,
    target_id: str,
    division_code: str | None,
    details: dict[str, Any] | None = None,
) -> None:
    s.add(
        AuditLog(
            actor_employee_id=actor.employee_id if actor else None,
            action=action,
            target_kind=target_kind,
            target_id=target_id,
            division_code=division_code,
            details=details,
        )
    )


def _audited_ai(
    frames: Iterator[dict[str, Any]],
    *,
    purpose: str,
    actor_id: str,
    draft_id: str,
    division_code: str | None,
) -> Iterator[dict[str, Any]]:
    """Passes one AI conversation's frames through, minus the internal usage
    frames, and records the call in the audit log: who, which document, the
    model, tokens, the tools it used and the outcome. CERT-In asks for a
    tamper-resistant log of what AI agents do; nothing in the app edits or
    deletes audit rows."""
    started = time.monotonic()
    usage = {"calls": 0, "input_tokens": 0, "output_tokens": 0, "cache_read_tokens": 0, "cache_write_tokens": 0}
    models: set[str] = set()
    tools: list[str] = []
    outcome = "ok"
    try:
        for frame in frames:
            kind = frame.get("type")
            if kind == "usage":
                usage["calls"] += 1
                for key in ("input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens"):
                    usage[key] += int(frame.get(key) or 0)
                if frame.get("model"):
                    models.add(str(frame["model"]))
                continue
            if kind == "tool_call":
                tools.append(str(frame.get("name")))
            elif kind == "error":
                outcome = str(frame.get("code") or "error")
            yield frame
    finally:
        details = {
            "purpose": purpose,
            "models": sorted(models),
            **usage,
            "tools": tools,
            "outcome": outcome,
            "seconds": round(time.monotonic() - started, 1),
        }
        log.info("ai call %s draft=%s %s", purpose, draft_id, details)
        try:
            with SessionLocal() as audit_s:
                audit_s.add(
                    AuditLog(
                        actor_employee_id=actor_id,
                        action="ai.call",
                        target_kind="draft",
                        target_id=draft_id,
                        division_code=division_code,
                        details=details,
                    )
                )
                audit_s.commit()
        except Exception:  # noqa: BLE001
            log.exception("could not record an AI call in the audit log")


def _version_key(draft_id: str, version: int) -> str:
    return f"drafts/{draft_id}/v{version}.docx"


def _final_key(draft_id: str) -> str:
    return f"final/{draft_id}.docx"


# --------------------------------------------------------------------------- #
# Health / hierarchy
# --------------------------------------------------------------------------- #

@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok", "service": "cfc-api"}


@app.get("/me")
def me(
    x_cfc_user: str | None = Header(default=None, alias="X-CFC-User"),
    cfc_session: str | None = Cookie(default=None, alias="cfc_session"),
    s: Session = Depends(get_session),
) -> dict[str, Any]:
    u = _resolve_user(s, x_cfc_user, cfc_session)
    return {
        "id": u.employee_id,
        "name": u.full_name,
        "email": u.email,
        "designation": u.designation,
        "cfc_role": u.cfc_role,
        "is_admin": u.is_admin,
        "manager_employee_id": u.manager_employee_id,
        "division_code": u.division_code,
        "auth_mode": auth_mod.auth_mode(),
        "cross_division_read": reads_all_boards(u),
        "server_llm": _server_llm(),
    }


_MODEL_LABELS = {
    "claude-sonnet-5-5": "Claude Sonnet 5.5",
    "claude-opus-5-5": "Claude Opus 5.5",
    "claude-haiku-5-5": "Claude Haiku 5.5",
}


def _server_llm() -> dict[str, str] | None:
    if not os.environ.get("ANTHROPIC_API_KEY"):
        return None
    model = os.environ.get("ANTHROPIC_MODEL") or "claude-sonnet-5-5"
    return {"provider": "anthropic", "model": model, "label": _MODEL_LABELS.get(model, model)}


@app.get("/auth/config")
def auth_config() -> dict[str, Any]:
    return {
        "auth_mode": auth_mod.auth_mode(),
        "access_code_required": auth_mod.access_code_required(),
        "email_delivery": auth_mod.email_delivery(),
    }


# --------------------------------------------------------------------------- #
# Auth (magic-link) — active only when CFC_AUTH_MODE=magic-link.
# Personas dropdown continues to work in demo mode.
# --------------------------------------------------------------------------- #

class MagicLinkBody(BaseModel):
    email: str
    access_code: str | None = None


@app.post("/auth/magic-link")
@limiter.limit(RATE_AUTH_MAGIC_LINK)
def auth_magic_link(request: Request, body: MagicLinkBody) -> dict[str, Any]:
    email = (body.email or "").strip().lower()
    if not email or "@" not in email:
        raise HTTPException(status_code=400, detail="Provide a valid email address")
    if not auth_mod.email_domain_ok(email):
        raise HTTPException(
            status_code=403,
            detail=f"Only @{auth_mod.ALLOWED_EMAIL_DOMAIN} addresses can sign in",
        )
    if not auth_mod.access_code_ok(body.access_code):
        raise HTTPException(status_code=403, detail="That access code isn't right.")
    link = auth_mod.build_magic_link(email)
    delivery = auth_mod.send_magic_link(email, link)
    # Never leak the link in the response when Resend delivered it.
    if delivery.get("delivery") == "resend":
        return {"ok": True, "delivery": "email"}
    # Dev/no-key path: return the link so the tester can click through.
    return {"ok": True, "delivery": delivery.get("delivery"), "link": delivery.get("link")}


@app.get("/auth/verify")
def auth_verify(token: str, response: Response) -> dict[str, Any]:
    email = auth_mod.verify_magic_token(token)
    if not email:
        raise HTTPException(status_code=401, detail="Invalid or expired magic link")

    # Look up (or fail cleanly) the CFC user for this email.
    with SessionLocal() as s:
        u = s.execute(select(User).where(func.lower(User.email) == email)).scalar_one_or_none()
        if not u:
            raise HTTPException(
                status_code=403,
                detail=f"No CFC user seeded for {email}. Ask an admin to add you to the hierarchy.",
            )
        jwt_token = auth_mod.issue_jwt(email, employee_id=u.employee_id)

    # Web and API live on separate Railway subdomains (cross-site, not just
    # cross-origin) — SameSite=Lax cookies are never sent on cross-site
    # fetch()/XHR, only on top-level navigation. SameSite=None is required
    # for the session cookie to actually reach the API, and browsers require
    # Secure whenever SameSite=None is set.
    cookie_secure = os.environ.get("CFC_COOKIE_SECURE", "false").lower() == "true"
    response.set_cookie(
        key="cfc_session",
        value=jwt_token,
        max_age=auth_mod.JWT_TTL_HOURS * 3600,
        httponly=True,
        secure=cookie_secure,
        samesite="none" if cookie_secure else "lax",
        path="/",
    )
    return {"ok": True, "email": email, "ttl_hours": auth_mod.JWT_TTL_HOURS}


@app.post("/auth/logout")
def auth_logout(response: Response) -> dict[str, Any]:
    # Must match the attributes the cookie was set with (see /auth/verify) —
    # a deleting Set-Cookie that doesn't specify SameSite=None; Secure is
    # silently dropped by browsers when it arrives via a cross-site fetch
    # response (web and API are separate Railway subdomains), so logout
    # would appear to succeed but leave the session cookie intact.
    cookie_secure = os.environ.get("CFC_COOKIE_SECURE", "false").lower() == "true"
    response.delete_cookie(
        "cfc_session",
        path="/",
        secure=cookie_secure,
        samesite="none" if cookie_secure else "lax",
    )
    return {"ok": True}


@app.get("/hierarchy/tree")
def hierarchy_tree(
    x_cfc_user: str | None = Header(default=None, alias="X-CFC-User"),
    cfc_session: str | None = Cookie(default=None, alias="cfc_session"),
    s: Session = Depends(get_session),
) -> dict[str, Any]:
    _resolve_user(s, x_cfc_user, cfc_session)
    users = s.execute(select(User).order_by(User.cfc_role, User.employee_id)).scalars().all()
    return {
        "version": 2,
        "source": "cfc db (seeded from packages/qci-seed/hierarchy.seed.json)",
        "users": [
            {
                "employee_id": u.employee_id,
                "full_name": u.full_name,
                "email": u.email,
                "designation": u.designation,
                "cfc_role": u.cfc_role,
                "division_or_board": u.division_code,
                "manager_employee_id": u.manager_employee_id,
                "is_admin": u.is_admin,
            }
            for u in users
        ],
    }


# --------------------------------------------------------------------------- #
# Drafts CRUD
# --------------------------------------------------------------------------- #

@app.post("/dev/drafts")
@app.post("/drafts")
def create_draft(
    body: CreateDraftBody,
    x_cfc_user: str | None = Header(default=None, alias="X-CFC-User"),
    cfc_session: str | None = Cookie(default=None, alias="cfc_session"),
    s: Session = Depends(get_session),
) -> dict[str, Any]:
    user = _resolve_user(s, x_cfc_user, cfc_session)
    maker_id = body.maker_employee_id or user.employee_id
    maker = s.get(User, maker_id) or user
    template_path = _resolve_template_path(body.template_code)
    if not template_path.exists():
        raise HTTPException(status_code=500, detail=f"Template missing: {template_path}")

    if body.template_source == "corpus_doc":
        if not body.corpus_doc_id:
            raise HTTPException(status_code=400, detail="corpus_doc_id is required when template_source=corpus_doc")
        outline = db_document_outline(s, body.corpus_doc_id, user=user)
        if outline is None:
            raise HTTPException(
                status_code=404,
                detail=f"Document not found, not visible to your division, or has no labeled sections: {body.corpus_doc_id}",
            )
    else:
        catalog_entry = TEMPLATE_CATALOG.get(body.template_code.strip().upper())
        outline = catalog_entry["outline"] if catalog_entry else None

    draft_id = uuid.uuid4().hex[:12]
    key = _version_key(draft_id, 1)
    bucket = _bucket()
    bucket.put_file(key, template_path)
    dest = bucket.get_path(key)
    sha = _sha256_file(dest)

    draft = Draft(
        id=draft_id,
        title=body.title,
        template_code=body.template_code,
        maker_employee_id=maker.employee_id,
        division_code=maker.division_code or "QCI",
        status="DRAFT",
        current_version=1,
        generation_outline=[list(pair) for pair in outline] if outline else None,
        ai_restricted=body.ai_restricted,
    )
    if body.reference_highlight_ids:
        draft.reference_excerpts = _reference_excerpts(s, user, body.reference_highlight_ids)
        draft.key_doc_ids = list(dict.fromkeys(e["doc_id"] for e in draft.reference_excerpts)) or None
    s.add(draft)
    s.add(
        DraftVersion(
            draft_id=draft_id,
            version=1,
            trigger="create",
            sha256=sha,
            storage_key=key,
            actor_employee_id=user.employee_id,
        )
    )
    _log_audit(
        s,
        actor=user,
        action="draft.create",
        target_kind="draft",
        target_id=draft_id,
        division_code=draft.division_code,
        details={"template_code": body.template_code, "title": body.title, "ai_restricted": body.ai_restricted},
    )
    s.commit()

    draft = _load_draft(s, draft_id)
    return {"draft": _draft_to_dict(draft), "session": _session_for(s, user, draft)}


@app.get("/dev/drafts/{draft_id}")
@app.get("/drafts/{draft_id}")
def get_draft(
    draft_id: str,
    x_cfc_user: str | None = Header(default=None, alias="X-CFC-User"),
    cfc_session: str | None = Cookie(default=None, alias="cfc_session"),
    s: Session = Depends(get_session),
) -> dict[str, Any]:
    user = _resolve_user(s, x_cfc_user, cfc_session)
    draft = _load_draft(s, draft_id)
    return {"draft": _draft_to_dict(draft), "session": _session_for(s, user, draft)}


@app.get("/dev/drafts/{draft_id}/session")
@app.get("/drafts/{draft_id}/session")
def get_session_endpoint(
    draft_id: str,
    x_cfc_user: str | None = Header(default=None, alias="X-CFC-User"),
    cfc_session: str | None = Cookie(default=None, alias="cfc_session"),
    s: Session = Depends(get_session),
) -> dict[str, Any]:
    user = _resolve_user(s, x_cfc_user, cfc_session)
    draft = _load_draft(s, draft_id)
    return _session_for(s, user, draft)


def _load_visible_draft(s: Session, draft_id: str, x_cfc_user: str | None, cfc_session: str | None) -> Draft:
    user = _resolve_user(s, x_cfc_user, cfc_session)
    draft = _load_draft(s, draft_id)
    if not _can_view_division(user, draft.division_code):
        raise HTTPException(status_code=404, detail=f"Draft not found: {draft_id}")
    return draft


@app.get("/dev/drafts/{draft_id}/file")
@app.get("/drafts/{draft_id}/file")
def get_file(
    draft_id: str,
    x_cfc_user: str | None = Header(default=None, alias="X-CFC-User"),
    cfc_session: str | None = Cookie(default=None, alias="cfc_session"),
    s: Session = Depends(get_session),
) -> FileResponse:
    draft = _load_visible_draft(s, draft_id, x_cfc_user, cfc_session)
    version_row = next((v for v in draft.versions if v.version == draft.current_version), None)
    if not version_row:
        raise HTTPException(status_code=500, detail="Current version row missing")
    path = _bucket().get_path(version_row.storage_key)
    if not path.exists():
        raise HTTPException(status_code=404, detail="DOCX missing in storage")
    return FileResponse(
        path,
        media_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        filename=f"{draft_id}-v{draft.current_version}.docx",
    )


@app.put("/dev/drafts/{draft_id}/file")
@app.put("/drafts/{draft_id}/file")
async def put_file(
    draft_id: str,
    file: UploadFile = File(...),
    x_cfc_user: str | None = Header(default=None, alias="X-CFC-User"),
    x_cfc_save_trigger: str | None = Header(default="manual", alias="X-CFC-Save-Trigger"),
    cfc_session: str | None = Cookie(default=None, alias="cfc_session"),
    s: Session = Depends(get_session),
) -> dict[str, Any]:
    user = _resolve_user(s, x_cfc_user, cfc_session)
    draft = _load_draft(s, draft_id)
    session = _session_for(s, user, draft)
    if not session["can_save"]:
        raise HTTPException(
            status_code=403,
            detail=f"Save not allowed for {user.full_name} when status={draft.status}",
        )

    data = await file.read()
    if not data:
        raise HTTPException(status_code=400, detail="Empty upload")

    with draft_write_lock(draft_id):
        s.refresh(draft)
        next_v = int(draft.current_version) + 1
        key = _version_key(draft_id, next_v)
        _bucket().put(key, data)

        s.add(
            DraftVersion(
                draft_id=draft_id,
                version=next_v,
                trigger=x_cfc_save_trigger or "manual",
                sha256=_sha256_bytes(data),
                storage_key=key,
                actor_employee_id=user.employee_id,
            )
        )
        draft.current_version = next_v
        draft.updated_at = _utc_now()
        _log_audit(
            s,
            actor=user,
            action="draft.save",
            target_kind="draft",
            target_id=draft_id,
            division_code=draft.division_code,
            details={"version": next_v, "trigger": x_cfc_save_trigger, "bytes": len(data)},
        )
        s.commit()

    draft = _load_draft(s, draft_id)
    v_entry = next(v for v in draft.versions if v.version == next_v)
    return {
        "ok": True,
        "version": next_v,
        "entry": {
            "version": v_entry.version,
            "trigger": v_entry.trigger,
            "sha256": v_entry.sha256,
            "created_at": _iso(v_entry.created_at),
            "actor_employee_id": v_entry.actor_employee_id,
        },
        "session": _session_for(s, user, draft),
    }


@app.get("/drafts/{draft_id}/diff")
def draft_diff(
    draft_id: str,
    from_version: int,
    to_version: int,
    x_cfc_user: str | None = Header(default=None, alias="X-CFC-User"),
    cfc_session: str | None = Cookie(default=None, alias="cfc_session"),
    s: Session = Depends(get_session),
) -> dict[str, Any]:
    """Unified diff of extracted paragraph text between two draft versions.

    Query params `from_version` / `to_version` are the version numbers to compare.
    Response includes the raw diff blocks so the client can render add/remove/context.
    """
    import difflib

    user = _resolve_user(s, x_cfc_user, cfc_session)
    draft = _load_draft(s, draft_id)
    if not _can_view_division(user, draft.division_code):
        raise HTTPException(status_code=403, detail="Cross-division access denied")

    versions = {v.version: v for v in draft.versions}
    va, vb = versions.get(from_version), versions.get(to_version)
    if not va or not vb:
        raise HTTPException(status_code=404, detail=f"Unknown version(s): from={from_version}, to={to_version}")

    def _paragraphs(storage_key: str) -> list[str]:
        try:
            import docx  # type: ignore
        except ImportError:
            return []
        path = _bucket().get_path(storage_key)
        if not path.exists():
            return []
        try:
            d = docx.Document(str(path))
            return [p.text for p in d.paragraphs if p.text and p.text.strip()]
        except Exception:  # noqa: BLE001
            return []

    a_lines = _paragraphs(va.storage_key)
    b_lines = _paragraphs(vb.storage_key)
    matcher = difflib.SequenceMatcher(None, a_lines, b_lines, autojunk=False)
    blocks: list[dict[str, Any]] = []
    for tag, i1, i2, j1, j2 in matcher.get_opcodes():
        blocks.append(
            {
                "tag": tag,  # equal | replace | delete | insert
                "a_range": [i1, i2],
                "b_range": [j1, j2],
                "a_lines": a_lines[i1:i2],
                "b_lines": b_lines[j1:j2],
            }
        )
    stats = {t: 0 for t in ("equal", "replace", "delete", "insert")}
    for b in blocks:
        stats[b["tag"]] = stats.get(b["tag"], 0) + max(len(b["a_lines"]), len(b["b_lines"]))
    return {
        "draft_id": draft_id,
        "from_version": from_version,
        "to_version": to_version,
        "a_line_count": len(a_lines),
        "b_line_count": len(b_lines),
        "blocks": blocks,
        "stats": stats,
    }


@app.get("/dev/drafts/{draft_id}/versions")
@app.get("/drafts/{draft_id}/versions")
def list_versions(
    draft_id: str,
    x_cfc_user: str | None = Header(default=None, alias="X-CFC-User"),
    cfc_session: str | None = Cookie(default=None, alias="cfc_session"),
    s: Session = Depends(get_session),
) -> dict[str, Any]:
    draft = _load_visible_draft(s, draft_id, x_cfc_user, cfc_session)
    return {
        "draft_id": draft.id,
        "current_version": draft.current_version,
        "versions": [
            {
                "version": v.version,
                "trigger": v.trigger,
                "sha256": v.sha256,
                "created_at": _iso(v.created_at),
                "actor_employee_id": v.actor_employee_id,
            }
            for v in sorted(draft.versions, key=lambda x: x.version)
        ],
    }


@app.get("/drafts")
def list_drafts(
    x_cfc_user: str | None = Header(default=None, alias="X-CFC-User"),
    cfc_session: str | None = Cookie(default=None, alias="cfc_session"),
    s: Session = Depends(get_session),
) -> dict[str, Any]:
    """List drafts visible to caller (own division, or apex/admin sees all)."""
    user = _resolve_user(s, x_cfc_user, cfc_session)
    stmt = select(Draft).options(selectinload(Draft.versions), selectinload(Draft.approvals))
    if not reads_all_boards(user):
        stmt = stmt.where(Draft.division_code == user.division_code)
    drafts = s.execute(stmt.order_by(Draft.updated_at.desc())).scalars().all()
    return {
        "items": [
            {"draft": _draft_to_dict(d), "session": _session_for(s, user, d)}
            for d in drafts
        ]
    }


# --------------------------------------------------------------------------- #
# Workflow
# --------------------------------------------------------------------------- #

@app.post("/drafts/{draft_id}/submit")
def submit_draft(
    draft_id: str,
    x_cfc_user: str | None = Header(default=None, alias="X-CFC-User"),
    cfc_session: str | None = Cookie(default=None, alias="cfc_session"),
    s: Session = Depends(get_session),
) -> dict[str, Any]:
    user = _resolve_user(s, x_cfc_user, cfc_session)
    draft = _load_draft(s, draft_id)
    session = _session_for(s, user, draft)
    if not session["can_submit"]:
        raise HTTPException(status_code=403, detail="Submit not allowed")
    if draft.status not in ("DRAFT", "REJECTED", "CHANGES_REQUESTED"):
        raise HTTPException(status_code=400, detail=f"Cannot submit from {draft.status}")

    draft.status = "PENDING_L1_REVIEW"
    draft.submitted_version = draft.current_version
    draft.updated_at = _utc_now()
    _log_audit(
        s,
        actor=user,
        action="draft.submit",
        target_kind="draft",
        target_id=draft_id,
        division_code=draft.division_code,
        details={"version": draft.current_version},
    )
    s.commit()

    draft = _load_draft(s, draft_id)
    return {"draft": _draft_to_dict(draft), "session": _session_for(s, user, draft)}


@app.post("/drafts/{draft_id}/decide")
def decide_draft(
    draft_id: str,
    body: DecideBody,
    x_cfc_user: str | None = Header(default=None, alias="X-CFC-User"),
    cfc_session: str | None = Cookie(default=None, alias="cfc_session"),
    s: Session = Depends(get_session),
) -> dict[str, Any]:
    user = _resolve_user(s, x_cfc_user, cfc_session)
    draft = _load_draft(s, draft_id)
    session = _session_for(s, user, draft)

    if body.decision in ("reject", "changes_requested") and not body.comments.strip():
        raise HTTPException(
            status_code=400,
            detail=f"A comment is required to {body.decision.replace('_', ' ')} a draft",
        )

    if body.level == 1:
        if not session["can_decide_l1"]:
            raise HTTPException(status_code=403, detail="Not L1 for this draft")
        if draft.status != "PENDING_L1_REVIEW":
            raise HTTPException(status_code=400, detail="Not awaiting L1")
        if body.decision == "approve":
            draft.status = "APPROVED_L1_PENDING_L2"
        elif body.decision == "reject":
            draft.status = "REJECTED"
        else:
            draft.status = "CHANGES_REQUESTED"
    else:
        if not session["can_decide_l2"]:
            raise HTTPException(status_code=403, detail="Not L2 for this draft")
        if draft.status != "APPROVED_L1_PENDING_L2":
            raise HTTPException(status_code=400, detail="Not awaiting L2")
        if body.decision == "approve":
            draft.status = "FINAL_APPROVED"
            # Seal final: copy current version bytes to final/{id}.docx in bucket.
            bucket = _bucket()
            current = next(v for v in draft.versions if v.version == draft.current_version)
            src = bucket.get_path(current.storage_key)
            final_key = _final_key(draft_id)
            bucket.put_file(final_key, src)
            draft.final_storage_key = final_key
            draft.final_sha256 = _sha256_file(bucket.get_path(final_key))
        elif body.decision == "reject":
            draft.status = "REJECTED"
        else:
            draft.status = "CHANGES_REQUESTED"

    s.add(
        DraftApproval(
            draft_id=draft_id,
            level=body.level,
            decision=body.decision,
            comments=body.comments,
            actor_employee_id=user.employee_id,
            decided_on_version=draft.current_version,
        )
    )
    # Rejection / changes-requested with a comment auto-materializes a review-reason
    # thread so the maker sees it in the ThreadsPanel without having to open the audit log.
    if body.decision in ("reject", "changes_requested"):
        s.add(
            Thread(
                id=f"review-{uuid.uuid4().hex[:12]}",
                draft_id=draft_id,
                division_code=draft.division_code,
                anchor=body.anchor,
                body_snippet=body.comments.strip()[:2000],
                author_employee_id=user.employee_id,
                kind="review_reason",
                resolved=False,
                raw={"decision": body.decision, "level": body.level, "version": draft.current_version},
            )
        )
    draft.updated_at = _utc_now()
    _log_audit(
        s,
        actor=user,
        action=f"draft.decide.l{body.level}",
        target_kind="draft",
        target_id=draft_id,
        division_code=draft.division_code,
        details={"decision": body.decision, "version": draft.current_version},
    )
    s.commit()

    draft = _load_draft(s, draft_id)
    return {"draft": _draft_to_dict(draft), "session": _session_for(s, user, draft)}


@app.get("/approvals/inbox")
def approvals_inbox(
    x_cfc_user: str | None = Header(default=None, alias="X-CFC-User"),
    cfc_session: str | None = Cookie(default=None, alias="cfc_session"),
    s: Session = Depends(get_session),
) -> dict[str, Any]:
    user = _resolve_user(s, x_cfc_user, cfc_session)
    stmt = (
        select(Draft)
        .options(
            selectinload(Draft.versions),
            selectinload(Draft.approvals),
            selectinload(Draft.threads),
        )
    )
    if not reads_all_boards(user):
        stmt = stmt.where(Draft.division_code == user.division_code)
    drafts = s.execute(stmt.order_by(Draft.updated_at.desc())).scalars().all()

    # Small preloaded maker/author lookup for name display
    ids: set[str] = set()
    for d in drafts:
        ids.add(d.maker_employee_id)
        for t in d.threads:
            if t.author_employee_id:
                ids.add(t.author_employee_id)
    name_map: dict[str, str] = {}
    if ids:
        for u in s.execute(select(User).where(User.employee_id.in_(ids))).scalars():
            name_map[u.employee_id] = u.full_name

    items = []
    for d in drafts:
        session = _session_for(s, user, d)
        if not (session["can_decide_l1"] or session["can_decide_l2"]):
            continue
        latest_review = None
        for t in sorted(d.threads, key=lambda x: x.created_at, reverse=True):
            if t.kind == "review_reason":
                latest_review = {
                    "id": t.id,
                    "body": t.body_snippet,
                    "author_employee_id": t.author_employee_id,
                    "author_name": name_map.get(t.author_employee_id or ""),
                    "created_at": _iso(t.created_at),
                    "resolved": t.resolved,
                }
                break
        items.append(
            {
                "draft": _draft_to_dict(d),
                "session": session,
                "maker_name": name_map.get(d.maker_employee_id),
                "latest_review_reason": latest_review,
                "open_threads": sum(1 for t in d.threads if not t.resolved),
            }
        )
    return {"items": items}


# --------------------------------------------------------------------------- #
# Threads (SuperDoc comment/tracked-change mirror + review reasons)
# --------------------------------------------------------------------------- #

def _thread_to_dict(t: Thread, name_map: dict[str, str] | None = None) -> dict[str, Any]:
    return {
        "id": t.id,
        "draft_id": t.draft_id,
        "division_code": t.division_code,
        "kind": t.kind,
        "anchor": t.anchor,
        "body": t.body_snippet,
        "author_employee_id": t.author_employee_id,
        "author_name": (name_map or {}).get(t.author_employee_id or "") if t.author_employee_id else None,
        "resolved": t.resolved,
        "created_at": _iso(t.created_at),
        "updated_at": _iso(t.updated_at),
        "raw": t.raw,
    }


def _check_visibility(user: User, draft: Draft) -> None:
    if not _can_view_division(user, draft.division_code):
        raise HTTPException(status_code=403, detail="Cross-division access denied")


@app.get("/drafts/{draft_id}/threads")
def list_threads(
    draft_id: str,
    x_cfc_user: str | None = Header(default=None, alias="X-CFC-User"),
    cfc_session: str | None = Cookie(default=None, alias="cfc_session"),
    s: Session = Depends(get_session),
) -> dict[str, Any]:
    user = _resolve_user(s, x_cfc_user, cfc_session)
    draft = _load_draft(s, draft_id)
    _check_visibility(user, draft)
    threads = (
        s.execute(
            select(Thread)
            .where(Thread.draft_id == draft_id)
            .order_by(Thread.created_at.desc())
        )
        .scalars()
        .all()
    )
    ids = {t.author_employee_id for t in threads if t.author_employee_id}
    name_map = {
        u.employee_id: u.full_name
        for u in s.execute(select(User).where(User.employee_id.in_(ids))).scalars()
    } if ids else {}
    return {
        "draft_id": draft_id,
        "count": len(threads),
        "open": sum(1 for t in threads if not t.resolved),
        "threads": [_thread_to_dict(t, name_map) for t in threads],
    }


@app.post("/drafts/{draft_id}/threads")
def create_thread(
    draft_id: str,
    body: ThreadCreateBody,
    x_cfc_user: str | None = Header(default=None, alias="X-CFC-User"),
    cfc_session: str | None = Cookie(default=None, alias="cfc_session"),
    s: Session = Depends(get_session),
) -> dict[str, Any]:
    user = _resolve_user(s, x_cfc_user, cfc_session)
    draft = _load_draft(s, draft_id)
    _check_visibility(user, draft)
    if not body.body.strip():
        raise HTTPException(status_code=400, detail="Thread body cannot be empty")

    thread_id = body.id or f"{body.kind[:3]}-{uuid.uuid4().hex[:12]}"
    if s.get(Thread, thread_id):
        raise HTTPException(status_code=409, detail=f"Thread already exists: {thread_id}")

    t = Thread(
        id=thread_id,
        draft_id=draft_id,
        division_code=draft.division_code,
        kind=body.kind,
        anchor=body.anchor,
        body_snippet=body.body.strip()[:2000],
        author_employee_id=user.employee_id,
        resolved=False,
        raw=body.raw,
    )
    s.add(t)
    _log_audit(
        s,
        actor=user,
        action="thread.create",
        target_kind="thread",
        target_id=thread_id,
        division_code=draft.division_code,
        details={"draft_id": draft_id, "kind": body.kind},
    )
    s.commit()
    return _thread_to_dict(s.get(Thread, thread_id), {user.employee_id: user.full_name})


@app.patch("/drafts/{draft_id}/threads/{thread_id}")
def patch_thread(
    draft_id: str,
    thread_id: str,
    body: ThreadPatchBody,
    x_cfc_user: str | None = Header(default=None, alias="X-CFC-User"),
    cfc_session: str | None = Cookie(default=None, alias="cfc_session"),
    s: Session = Depends(get_session),
) -> dict[str, Any]:
    user = _resolve_user(s, x_cfc_user, cfc_session)
    draft = _load_draft(s, draft_id)
    _check_visibility(user, draft)
    t = s.get(Thread, thread_id)
    if not t or t.draft_id != draft_id:
        raise HTTPException(status_code=404, detail="Thread not found")

    changed: dict[str, Any] = {}
    if body.resolved is not None and body.resolved != t.resolved:
        t.resolved = body.resolved
        changed["resolved"] = body.resolved
    if body.body is not None:
        t.body_snippet = body.body.strip()[:2000]
        changed["body"] = True
    if body.anchor is not None:
        t.anchor = body.anchor
        changed["anchor"] = True
    if body.raw is not None:
        t.raw = body.raw
        changed["raw"] = True
    if changed:
        t.updated_at = _utc_now()
        _log_audit(
            s,
            actor=user,
            action="thread.patch",
            target_kind="thread",
            target_id=thread_id,
            division_code=draft.division_code,
            details={"draft_id": draft_id, **changed},
        )
        s.commit()
    return _thread_to_dict(t, {user.employee_id: user.full_name})


@app.post("/drafts/{draft_id}/threads/sync")
def sync_threads(
    draft_id: str,
    body: ThreadsSyncBody,
    x_cfc_user: str | None = Header(default=None, alias="X-CFC-User"),
    cfc_session: str | None = Cookie(default=None, alias="cfc_session"),
    s: Session = Depends(get_session),
) -> dict[str, Any]:
    """Batch mirror from SuperDoc: upsert each incoming thread by id.

    Best-effort — SuperDoc's comments API surface varies. The frontend calls this
    on save with whatever it can extract; missing anchors are fine.
    """
    user = _resolve_user(s, x_cfc_user, cfc_session)
    draft = _load_draft(s, draft_id)
    _check_visibility(user, draft)

    inserted = 0
    updated = 0
    for item in body.threads:
        existing = s.get(Thread, item.id)
        if existing:
            if existing.draft_id != draft_id:
                continue  # cross-draft id collision — ignore
            existing.kind = item.kind
            existing.anchor = item.anchor
            existing.body_snippet = (item.body or "").strip()[:2000]
            existing.resolved = item.resolved
            existing.raw = item.raw
            existing.updated_at = _utc_now()
            if item.author_employee_id and not existing.author_employee_id:
                existing.author_employee_id = item.author_employee_id
            updated += 1
        else:
            s.add(
                Thread(
                    id=item.id,
                    draft_id=draft_id,
                    division_code=draft.division_code,
                    kind=item.kind,
                    anchor=item.anchor,
                    body_snippet=(item.body or "").strip()[:2000],
                    author_employee_id=item.author_employee_id or user.employee_id,
                    resolved=item.resolved,
                    raw=item.raw,
                )
            )
            inserted += 1
    if inserted or updated:
        _log_audit(
            s,
            actor=user,
            action="thread.sync",
            target_kind="draft",
            target_id=draft_id,
            division_code=draft.division_code,
            details={"inserted": inserted, "updated": updated},
        )
    s.commit()
    return {"inserted": inserted, "updated": updated, "total_incoming": len(body.threads)}


# --------------------------------------------------------------------------- #
# Doc-worker seed
# --------------------------------------------------------------------------- #

@app.post("/drafts/from-worker")
def create_draft_from_worker(
    body: CreateFromWorkerBody,
    x_cfc_user: str | None = Header(default=None, alias="X-CFC-User"),
    cfc_session: str | None = Cookie(default=None, alias="cfc_session"),
    s: Session = Depends(get_session),
) -> dict[str, Any]:
    user = _resolve_user(s, x_cfc_user, cfc_session)
    maker = (s.get(User, body.maker_employee_id) if body.maker_employee_id else None) or user

    payload = json.dumps(
        {
            "find": body.find,
            "replace": body.replace,
            "tracked": body.tracked,
            "titleHint": body.title,
        }
    ).encode("utf-8")
    req = urlrequest.Request(
        f"{DOC_WORKER_URL}/internal/docx/seed",
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urlrequest.urlopen(req, timeout=180) as resp:
            worker = json.loads(resp.read().decode("utf-8"))
    except HTTPError as e:
        detail = e.read().decode("utf-8", errors="ignore")
        raise HTTPException(status_code=502, detail=f"doc-worker HTTP {e.code}: {detail}") from e
    except URLError as e:
        raise HTTPException(
            status_code=503,
            detail=(
                f"doc-worker unreachable at {DOC_WORKER_URL}: {e.reason}. "
                "Start it with npm run dev:doc-worker"
            ),
        ) from e

    if not worker.get("ok"):
        raise HTTPException(status_code=502, detail=f"doc-worker failed: {worker}")

    # doc-worker and cfc-api are separate containers in prod (Railway) with no
    # shared filesystem — `absolute`/`output` only resolve on doc-worker's own
    # disk. Prefer the base64 bytes it returns; fall back to a local path read
    # only for same-machine local dev where the old shape still works.
    draft_id = uuid.uuid4().hex[:12]
    key = _version_key(draft_id, 1)
    bucket = _bucket()
    data_b64 = worker.get("dataBase64")
    if data_b64:
        import base64 as _b64

        bucket.put(key, _b64.b64decode(data_b64))
    else:
        abs_path = Path(worker.get("absolute") or (ROOT / worker["output"]))
        if not abs_path.exists():
            raise HTTPException(status_code=500, detail=f"worker output missing: {abs_path}")
        bucket.put_file(key, abs_path)
    sha = _sha256_file(bucket.get_path(key))

    draft = Draft(
        id=draft_id,
        title=body.title,
        template_code="WO_EXTENSION_WORKER",
        maker_employee_id=maker.employee_id,
        division_code=maker.division_code or "QCI",
        status="DRAFT",
        current_version=1,
        worker_meta={
            "replaced": worker.get("replaced"),
            "fallback": worker.get("fallback"),
            "warning": worker.get("warning"),
            "output": worker.get("output"),
            "find": worker.get("findText"),
            "replace": worker.get("replaceText"),
        },
    )
    s.add(draft)
    s.add(
        DraftVersion(
            draft_id=draft_id,
            version=1,
            trigger="worker_seed",
            sha256=sha,
            storage_key=key,
            actor_employee_id=user.employee_id,
        )
    )
    _log_audit(
        s,
        actor=user,
        action="draft.create.worker",
        target_kind="draft",
        target_id=draft_id,
        division_code=draft.division_code,
        details={"worker": worker.get("output"), "title": body.title},
    )
    s.commit()

    draft = _load_draft(s, draft_id)
    return {"draft": _draft_to_dict(draft), "session": _session_for(s, user, draft), "worker": worker}


# --------------------------------------------------------------------------- #
# Corpus + RAG (unchanged; Sprint 3 will migrate corpus to DB)
# --------------------------------------------------------------------------- #

@app.get("/corpus/stats")
def get_corpus_stats(s: Session = Depends(get_session)) -> dict[str, Any]:
    return db_stats(s) if db_has_corpus(s) else {**inmem_stats(), "backend": "inmemory"}


@app.get("/corpus/documents")
def corpus_documents(
    limit: int = 100,
    x_cfc_user: str | None = Header(default=None, alias="X-CFC-User"),
    cfc_session: str | None = Cookie(default=None, alias="cfc_session"),
    s: Session = Depends(get_session),
) -> dict[str, Any]:
    user = _resolve_user(s, x_cfc_user, cfc_session)
    if db_has_corpus(s):
        return {"items": db_list_documents(s, limit=limit, user=user)}
    return {"items": inmem_list(limit=limit)}


@app.get("/corpus/documents/{doc_id}")
def corpus_document(
    doc_id: str,
    x_cfc_user: str | None = Header(default=None, alias="X-CFC-User"),
    cfc_session: str | None = Cookie(default=None, alias="cfc_session"),
    s: Session = Depends(get_session),
) -> dict[str, Any]:
    user = _resolve_user(s, x_cfc_user, cfc_session)
    doc = db_get_document(s, doc_id, user=user) if db_has_corpus(s) else inmem_get(doc_id)
    if not doc:
        raise HTTPException(status_code=404, detail="document not found")
    return doc


@app.post("/corpus/search")
@limiter.limit(RATE_CORPUS_SEARCH)
def corpus_search(
    request: Request,
    body: SearchBody,
    x_cfc_user: str | None = Header(default=None, alias="X-CFC-User"),
    cfc_session: str | None = Cookie(default=None, alias="cfc_session"),
    s: Session = Depends(get_session),
) -> dict[str, Any]:
    user = _resolve_user(s, x_cfc_user, cfc_session)
    if db_has_corpus(s):
        hits = db_search(
            s, body.query, user=user, limit=body.limit, ministry=body.ministry, domain=body.domain
        )
    else:
        hits = inmem_search(body.query, limit=body.limit, ministry=body.ministry, domain=body.domain)
    return {"query": body.query, "count": len(hits), "hits": hits, "backend": "db" if db_has_corpus(s) else "inmemory"}


@app.post("/rag/query")
@limiter.limit(RATE_RAG_QUERY)
def rag_query(
    request: Request,
    body: RagBody,
    x_cfc_user: str | None = Header(default=None, alias="X-CFC-User"),
    cfc_session: str | None = Cookie(default=None, alias="cfc_session"),
    s: Session = Depends(get_session),
) -> dict[str, Any]:
    user = _resolve_user(s, x_cfc_user, cfc_session)
    if db_has_corpus(s):
        hits = db_search(
            s, body.query, user=user, limit=body.limit, ministry=body.ministry, domain=None
        )
    else:
        hits = inmem_search(body.query, limit=body.limit, ministry=body.ministry)
    draft = s.get(Draft, body.draft_id) if body.draft_id else None
    allow_ai = ai_enabled() and not (draft and draft.ai_restricted)
    result = answer_query(
        body.query,
        limit=body.limit,
        ministry=body.ministry,
        provider=body.provider,
        api_key=body.api_key,
        model=body.model,
        prefetched_hits=hits,
        allow_ai=allow_ai,
    )
    if result.get("provider") not in {"extractive", "extractive_fallback"}:
        _log_audit(
            s,
            actor=user,
            action="ai.research",
            target_kind="draft" if draft else "corpus",
            target_id=draft.id if draft else "-",
            division_code=draft.division_code if draft else user.division_code,
            details={"provider": result.get("provider"), "sources": len(hits)},
        )
        s.commit()
    if not allow_ai:
        result["notice"] = AI_OFF_MESSAGE if not ai_enabled() else CONFIDENTIAL_MESSAGE
    return result


@app.post("/corpus/reload")
def corpus_reload() -> dict[str, Any]:
    return reload_corpus()


# --------------------------------------------------------------------------- #
# Corpus uploads + reindex (Sprint 3)
# --------------------------------------------------------------------------- #

_UPLOAD_EXTS = {".docx", ".pdf"}
_TEMPLATE_EXTS = {".docx"}


def _slugify_name(name: str) -> str:
    import re as _re

    stem = Path(name).stem
    ext = Path(name).suffix.lower()
    slug = _re.sub(r"[^A-Za-z0-9._-]+", "_", stem).strip("_.") or "upload"
    return f"{slug}{ext}"


@app.post("/corpus/uploads")
async def corpus_upload(
    file: UploadFile = File(...),
    title: str | None = Form(default=None),
    ministry: str | None = Form(default=None),
    domain: str | None = Form(default=None),
    x_cfc_user: str | None = Header(default=None, alias="X-CFC-User"),
    cfc_session: str | None = Cookie(default=None, alias="cfc_session"),
    s: Session = Depends(get_session),
) -> dict[str, Any]:
    """Maker (or higher) uploads a Work Order into their division's ingest bucket."""
    from .ingest import _extract_upload, ingest_one  # noqa: PLC0415 deferred (fastembed cold)

    user = _resolve_user(s, x_cfc_user, cfc_session)
    if user.cfc_role not in ("maker", "l1_approver", "l2_approver", "apex") and not user.is_admin:
        raise HTTPException(status_code=403, detail="Not permitted to upload to corpus")
    ext = Path(file.filename or "").suffix.lower()
    if ext not in _UPLOAD_EXTS:
        raise HTTPException(status_code=415, detail=f"Unsupported extension: {ext}")

    division = user.division_code or "QCI"
    data = await file.read()
    if not data:
        raise HTTPException(status_code=400, detail="Empty upload")
    bucket = _bucket()
    key = f"uploads/{division}/{_slugify_name(file.filename or 'upload' + ext)}"
    bucket.put(key, data)
    abs_path = bucket.get_path(key)

    ed = _extract_upload(abs_path, division)
    if title:
        ed.title = title
    if ministry:
        ed.ministry = ministry
    if domain:
        ed.domains = [*(ed.domains or []), domain]
    res = ingest_one(s, ed, division_code=division)
    _log_audit(
        s,
        actor=user,
        action="corpus.upload",
        target_kind="corpus_document",
        target_id=str(res.get("doc_id")),
        division_code=division,
        details={"filename": file.filename, "kind": ed.kind, "bytes": len(data), "chunks": res.get("chunks")},
    )
    s.commit()
    return {
        "ok": True,
        "storage_key": key,
        "doc_id": res.get("doc_id"),
        "chunks": res.get("chunks"),
        "division_code": division,
        "changed": res.get("changed"),
    }


@app.get("/corpus/templates")
def list_templates(
    x_cfc_user: str | None = Header(default=None, alias="X-CFC-User"),
    cfc_session: str | None = Cookie(default=None, alias="cfc_session"),
    s: Session = Depends(get_session),
) -> dict[str, Any]:
    """List DOCX templates under packages/doc-fixtures/templates/. Any authed persona can list."""
    _resolve_user(s, x_cfc_user, cfc_session)  # auth gate
    templates_dir = ROOT / "packages" / "doc-fixtures" / "templates"
    items: list[dict[str, Any]] = []
    if templates_dir.exists():
        for p in sorted(templates_dir.glob("*.docx")):
            stat = p.stat()
            items.append(
                {
                    "template_code": p.stem,
                    "filename": p.name,
                    "path": str(p.relative_to(ROOT)).replace("\\", "/"),
                    "bytes": stat.st_size,
                    "modified_at": datetime.fromtimestamp(stat.st_mtime, tz=timezone.utc).isoformat(),
                }
            )
    return {"count": len(items), "items": items}


@app.get("/generation/templates")
def list_generation_templates(
    x_cfc_user: str | None = Header(default=None, alias="X-CFC-User"),
    cfc_session: str | None = Cookie(default=None, alias="cfc_session"),
    s: Session = Depends(get_session),
) -> dict[str, Any]:
    """Selectable document structures for the "New draft" generation flow.

    Each entry is a fixed (label, title) outline, not a pre-written file —
    every one of these seeds from the same blank document; only the section
    structure differs. Separate from GET /corpus/templates, which lists
    physical uploaded .docx files for the (unrelated) manual-edit path.
    """
    _resolve_user(s, x_cfc_user, cfc_session)  # auth gate
    items = [
        {
            "template_code": code,
            "label": entry["label"],
            "description": entry.get("description", ""),
            "outline": entry["outline"],
        }
        for code, entry in TEMPLATE_CATALOG.items()
    ]
    return {"items": items}


@app.post("/corpus/templates")
async def corpus_template_upload(
    file: UploadFile = File(...),
    template_code: str = Form(default=""),
    x_cfc_user: str | None = Header(default=None, alias="X-CFC-User"),
    cfc_session: str | None = Cookie(default=None, alias="cfc_session"),
    s: Session = Depends(get_session),
) -> dict[str, Any]:
    """Admin uploads a .docx template into packages/doc-fixtures/templates."""
    user = _resolve_user(s, x_cfc_user, cfc_session)
    if not user.is_admin:
        raise HTTPException(status_code=403, detail="Admin only")
    ext = Path(file.filename or "").suffix.lower()
    if ext not in _TEMPLATE_EXTS:
        raise HTTPException(status_code=415, detail=f"Templates must be .docx (got {ext})")
    if not template_code.strip():
        raise HTTPException(status_code=400, detail="template_code is required")

    data = await file.read()
    if not data:
        raise HTTPException(status_code=400, detail="Empty upload")
    templates_dir = ROOT / "packages" / "doc-fixtures" / "templates"
    templates_dir.mkdir(parents=True, exist_ok=True)
    dest = templates_dir / f"{template_code.upper()}.docx"
    dest.write_bytes(data)
    _log_audit(
        s,
        actor=user,
        action="corpus.template_upload",
        target_kind="template",
        target_id=template_code.upper(),
        division_code=user.division_code,
        details={"filename": file.filename, "bytes": len(data)},
    )
    s.commit()
    return {"ok": True, "template_code": template_code.upper(), "path": str(dest.relative_to(ROOT)).replace("\\", "/")}


# --------------------------------------------------------------------------- #
# Agent chat (SSE)
# --------------------------------------------------------------------------- #

DEFAULT_AGENT_SYSTEM = (
    "You are CFC, an assistant embedded inside a SuperDoc DOCX editor at "
    "Quality Council of India. You can search the institutional corpus, "
    "read the current draft, and propose insertions or replacements. "
    "Before you write anything, search the corpus for relevant prior QCI "
    "work — lean on real precedent rather than writing from scratch. "
    "ADAPT, DON'T COPY: a retrieved precedent belongs to a different "
    "client/engagement than the current draft — replace its counterparty "
    "name, ministry/department, dates, and other client-specific "
    "identifiers with the current draft's actual client/context before "
    "inserting; never leave a prior client's institutional identity in "
    "the output. Never invent citations, numbers, or dates — cite the "
    "doc_id returned by cfc_search_corpus, and state a specific fact only "
    "if it actually appeared in a tool result this conversation; if "
    "you're unsure whether something is real or recalled general "
    "knowledge, omit it. Keep insertions focused and short. When the "
    "user's session is a suggester (approver review), your mutations are "
    "automatically tracked."
)


def _sse(frame: dict[str, Any]) -> str:
    return f"data: {json.dumps(frame, default=str)}\n\n"


def _resolve_agent_configs(body_provider: str, body_api_key: str | None, body_model: str | None) -> list[LLMConfig]:
    """Build the fallback chain of LLM configs.

    - Frontend explicitly names a provider AND provides a BYOK key: single config, no fallback.
    - Frontend passes provider='auto' (or omits provider) with no key: server-side chain
      from CFC_AGENT_FALLBACK env (default: gemini,groq) using .env keys.
    - Mock is always a single, key-free config.
    """
    prov = (body_provider or "").lower().strip()
    if prov == "mock":
        return [LLMConfig(provider="mock", api_key=None, model=body_model or "")]

    # Retired defaults that older browser bundles still send — never let them
    # override the server's model choice.
    if body_model in _STALE_CLIENT_MODELS:
        body_model = None

    if prov and body_api_key:
        return [LLMConfig(provider=prov, api_key=body_api_key, model=body_model or "")]

    # auto or partial — build server-side chain
    order_env = os.environ.get("CFC_AGENT_FALLBACK", "anthropic,gemini,groq")
    order = [p.strip().lower() for p in order_env.split(",") if p.strip()]
    if prov and prov != "auto":
        # named provider without a key — still try that provider first from env, then fall back
        order = [prov, *[p for p in order if p != prov]]

    configs: list[LLMConfig] = []
    env_key = {
        "anthropic": os.environ.get("ANTHROPIC_API_KEY"),
        "claude": os.environ.get("ANTHROPIC_API_KEY"),
        "gemini": os.environ.get("GEMINI_API_KEY"),
        "google": os.environ.get("GEMINI_API_KEY"),
        "openai": os.environ.get("OPENAI_API_KEY"),
        "groq": os.environ.get("GROQ_API_KEY"),
    }
    env_model = {
        "anthropic": os.environ.get("ANTHROPIC_MODEL"),
        "claude": os.environ.get("ANTHROPIC_MODEL"),
        "gemini": os.environ.get("GEMINI_MODEL"),
        "google": os.environ.get("GEMINI_MODEL"),
        "openai": os.environ.get("OPENAI_MODEL"),
        "groq": os.environ.get("GROQ_MODEL"),
    }
    for p in order:
        key = env_key.get(p)
        if not key:
            continue
        configs.append(LLMConfig(provider=p, api_key=key, model=(body_model if p == prov else None) or env_model.get(p) or ""))
    if not configs and os.environ.get("CFC_ALLOW_MOCK_FALLBACK") == "1":
        configs = [LLMConfig(provider="mock", api_key=None, model="")]
    return configs


_STALE_CLIENT_MODELS = {"claude-haiku-4-5", "gemini-2.0-flash", "llama-3.3-70b-versatile"}


_FATAL_AGENT_ERRORS = {"auth", "quota", "config"}
_HEARTBEAT_SECS = 10.0


def _with_heartbeat(gen: Iterator[str]) -> Iterator[str]:
    """Run the blocking SSE generator on a worker thread and emit an SSE
    comment whenever it goes quiet, so proxies and the browser don't treat a
    long model call or document write as a dead connection."""
    items: queue.Queue = queue.Queue()
    finished = object()
    stop = threading.Event()

    def pump() -> None:
        try:
            for item in gen:
                if stop.is_set():
                    break
                items.put(item)
        except Exception:  # noqa: BLE001
            log.exception("agent stream pump failed")
        finally:
            gen.close()
            items.put(finished)

    threading.Thread(target=pump, daemon=True).start()
    try:
        while True:
            try:
                item = items.get(timeout=_HEARTBEAT_SECS)
            except queue.Empty:
                yield ": ping\n\n"
                continue
            if item is finished:
                return
            yield item
    finally:
        stop.set()


@app.post("/drafts/{draft_id}/agent/chat")
@limiter.limit(RATE_AGENT_CHAT)
def agent_chat(
    request: Request,
    draft_id: str,
    body: AgentChatBody,
    x_cfc_user: str | None = Header(default=None, alias="X-CFC-User"),
    cfc_session: str | None = Cookie(default=None, alias="cfc_session"),
) -> StreamingResponse:
    """Server-Sent Events stream driving one agent conversation to completion.

    BYOK: pass `provider` + `api_key` in the body. Use `provider='mock'` for
    smoke tests without a real key.
    """
    def event_stream():
        # Own session for the whole conversation so tool mutations commit cleanly.
        s = SessionLocal()
        try:
            user = _resolve_user(s, x_cfc_user, cfc_session)
            draft = _load_draft(s, draft_id)
            session_flags = _session_for(s, user, draft)

            if not _can_view_division(user, draft.division_code):
                yield _sse(error_frame("auth", "You don't have access to this document."))
                return
            if not ai_enabled():
                yield _sse(error_frame("ai_off", AI_OFF_MESSAGE))
                return
            if draft.ai_restricted:
                yield _sse(error_frame("confidential", CONFIDENTIAL_MESSAGE))
                return

            configs = _resolve_agent_configs(body.provider or "mock", body.api_key, body.model)
            preset = (body.preset or "").lower().strip()
            preset_args = body.preset_args or {}
            # Reviewer sessions are ALWAYS forced into the tool-restricted redline
            # path, regardless of what preset the client requested — this used to
            # be a client-selectable preset (redline_extender) with no server-side
            # enforcement, which meant an L1/L2 session could reach cfc_propose_
            # insert/replace simply by not selecting it. See agent_tools.py's
            # dispatch() for the matching defense-in-depth check.
            is_reviewer = session_flags.get("superdoc_role") == "suggester"

            ctx = AgentContext(session=s, user=user, draft=draft, session_flags=session_flags)

            def dispatch(name: str, args: dict[str, Any]) -> dict[str, Any]:
                # Reload draft so version bumps from prior tool calls are visible.
                ctx.draft = _load_draft(s, draft_id)
                ctx.session_flags = _session_for(s, user, ctx.draft)
                return agent_dispatch(ctx, name, args)

            _log_audit(
                s,
                actor=user,
                action="draft.agent.chat.start",
                target_kind="draft",
                target_id=draft_id,
                division_code=draft.division_code,
                details={
                    "providers": [c.provider for c in configs],
                    "preset": preset or None,
                },
            )
            s.commit()

            start_frame = {
                "type": "start",
                "draft_id": draft_id,
                "version": draft.current_version,
                "providers": [c.provider for c in configs],
                "tracked": session_flags.get("agent_change_mode") == "tracked",
                "can_run_agent_mutate": session_flags.get("can_run_agent_mutate"),
            }

            if is_reviewer:
                # Forced regardless of `preset` — see the comment above. Tool
                # schema is REVIEWER_TOOL_SCHEMAS (no insert/replace at all),
                # not just a prompt instruction.
                yield _sse({"type": "preset", "name": "redline_extender"})
                yield _sse(start_frame)
                for frame in _audited_ai(
                    run_agent_with_fallback(
                        configs=configs,
                        system_prompt=redline_extender_system(),
                        user_prompt=redline_extender_user(
                            task=body.prompt,
                            focus_areas=str(preset_args.get("focus_areas", "")),
                            hints=str(preset_args.get("hints", "")),
                        ),
                        tool_schemas=REVIEWER_TOOL_SCHEMAS,
                        tool_dispatch=dispatch,
                    ),
                    purpose="review",
                    actor_id=user.employee_id,
                    draft_id=draft_id,
                    division_code=draft.division_code,
                ):
                    yield _sse(frame)
                return

            if preset in {"draft_generator", "draft-generator"}:
                # A full document needs more tool-call rounds than one bounded
                # run_agent conversation allows (agent_llm.MAX_STEPS) — each
                # section runs as its OWN short conversation instead, appended
                # in order. A section failing doesn't abort the rest: a
                # 6/7-section draft still saves the maker real time, and
                # DraftVersion history already makes every section a
                # recoverable checkpoint.
                template_code = str(preset_args.get("template_code") or draft.template_code or "")
                # The outline set at draft creation (catalog pick, or derived from
                # an existing corpus document) drives which sections get generated
                # — GENERATION_SECTIONS is only a fallback for older drafts/codes
                # with no stored outline.
                outline = [(row[0], row[1]) for row in (draft.generation_outline or GENERATION_SECTIONS)]
                yield _sse(
                    {
                        "type": "preset",
                        "name": "draft_generator",
                        "sections": [{"label": label, "title": title} for label, title in outline],
                    }
                )
                yield _sse(start_frame)
                if draft.current_version == 1 and (draft.title or "").strip():
                    title_result = dispatch(
                        "cfc_propose_insert", {"text": f"# {draft.title.strip()}", "position": "end"}
                    )
                    if not title_result.get("error"):
                        yield _sse(
                            {
                                "type": "draft_updated",
                                "version": title_result.get("version"),
                                "sha256": title_result.get("sha256"),
                                "tracked": title_result.get("tracked"),
                            }
                        )
                # Deliberately-chosen precedent from draft_intake (if the user went
                # through clarification) — re-resolved fresh each run rather than
                # trusting stored titles, in case ACL/visibility changed since intake.
                key_docs: list[dict[str, str]] | None = None
                if draft.key_doc_ids:
                    key_docs = []
                    for doc_id in draft.key_doc_ids:
                        doc = db_get_document(s, doc_id, user=user)
                        if doc:
                            key_docs.append({"doc_id": doc_id, "title": doc.get("title", doc_id)})
                generated: list[str] = []
                failed: list[str] = []
                end_after = (
                    frozenset({"cfc_propose_insert"})
                    if os.environ.get("CFC_GEN_END_AFTER_INSERT", "1") != "0"
                    else frozenset()
                )
                fatal_error: dict[str, Any] | None = None
                for section_label, section_title in outline:
                    if fatal_error is not None:
                        failed.append(section_label)
                        yield _sse({"type": "section_result", "section": section_label, "ok": False, "error": fatal_error["message"]})
                        continue
                    yield _sse({"type": "section_start", "section": section_label, "title": section_title})
                    section_error: str | None = None
                    section_written = False
                    # Captured purely to feed the post-section faithfulness
                    # check (item 9) below — never used to alter what gets
                    # written to the draft itself.
                    section_generated_text = ""
                    section_evidence_parts: list[str] = []
                    section_sources: list[dict[str, str]] = []
                    for frame in _audited_ai(
                        run_agent_with_fallback(
                            configs=configs,
                            system_prompt=draft_generator_system(section_title, section_label),
                            user_prompt=draft_generator_user(
                                body.prompt + _reference_block(draft), section_label, section_title, template_code, key_docs
                            ),
                            tool_schemas=TOOL_SCHEMAS,
                            tool_dispatch=dispatch,
                            end_after_tools=end_after,
                        ),
                        purpose="generate_section",
                        actor_id=user.employee_id,
                        draft_id=draft_id,
                        division_code=draft.division_code,
                    ):
                        if frame["type"] == "done":
                            continue  # per-section "done" is noise; only the overall loop emits one
                        if frame["type"] == "error":
                            section_error = frame.get("message")
                            if frame.get("code") in _FATAL_AGENT_ERRORS:
                                fatal_error = frame
                        if frame["type"] == "draft_updated":
                            section_written = True
                        if frame["type"] == "tool_call" and frame.get("name") == "cfc_propose_insert":
                            section_generated_text = str(frame.get("args", {}).get("text") or "")
                        if frame["type"] == "tool_result":
                            result = frame.get("result") or {}
                            if frame.get("name") == "cfc_search_corpus":
                                for hit in result.get("hits") or []:
                                    if hit.get("text"):
                                        section_evidence_parts.append(f"{hit.get('title', '')}: {hit['text']}")
                                        if hit.get("doc_id"):
                                            section_sources.append(
                                                {"doc_id": hit["doc_id"], "title": hit.get("title", ""), "text": hit["text"]}
                                            )
                            elif frame.get("name") == "cfc_get_document":
                                if result.get("full_text"):
                                    section_evidence_parts.append(
                                        f"{result.get('title', '')}: {str(result['full_text'])[:4000]}"
                                    )
                                    if result.get("doc_id"):
                                        section_sources.append(
                                            {
                                                "doc_id": result["doc_id"],
                                                "title": result.get("title", ""),
                                                "text": str(result["full_text"])[:4000],
                                            }
                                        )
                        yield _sse(frame)
                    if not section_error and not section_written:
                        section_error = "This section couldn't be written. Try generating again."
                    if section_error:
                        failed.append(section_label)
                    else:
                        generated.append(section_label)
                        if section_generated_text and section_evidence_parts:
                            # The user's own brief and clarification answers are ground
                            # truth too — without them every client fact gets flagged.
                            precedent_titles = "; ".join(d["title"] for d in key_docs or [])
                            section_titles = "; ".join(t for _, t in outline)
                            evidence = "\n\n".join(
                                [
                                    "Brief and answers from the user (treat as true):\n"
                                    f"{draft.title}\n{body.prompt}\nChosen precedents: {precedent_titles}\n"
                                    f"Sections of this document: {section_titles}",
                                    *section_evidence_parts,
                                ]
                            )
                            flags = jev_faithfulness.check_section(section_generated_text, evidence)
                            if flags:
                                for f in flags:
                                    f["source"] = jev_faithfulness.closest_source(str(f.get("claim", "")), section_sources)
                                yield _sse(
                                    {"type": "faithfulness_flag", "section": section_label, "flags": flags}
                                )
                    yield _sse({"type": "section_result", "section": section_label, "ok": not section_error, "error": section_error})
                yield _sse(
                    {
                        "type": "done",
                        "reason": "generation_complete",
                        "sections_generated": generated,
                        "sections_failed": failed,
                    }
                )
                return

            if preset in {"draft_intake", "draft-intake"}:
                # Clarifying-questions phase that precedes draft_generator — see
                # agent_presets.draft_intake_system for why the first tool call
                # must be a corpus search (questions grounded in what QCI has
                # actually done, not generic proposal-writing boilerplate).
                yield _sse({"type": "preset", "name": "draft_intake", "max_turns": MAX_INTAKE_TURNS})
                yield _sse(start_frame)
                brief = str(preset_args.get("brief") or body.prompt or "")
                transcript = preset_args.get("transcript") or []
                turn_count = int(preset_args.get("turn_count") or 1)
                # Server-side stop, not just the prompt's own "{max_turns}" text —
                # turn_count is client-supplied and nothing previously checked it
                # at all (see agent_presets.draft_intake_system's force_final doc).
                force_final = turn_count >= MAX_INTAKE_TURNS
                gaps = [] if force_final else jev_intake.detect_gaps(draft.title or "", brief, transcript)
                for frame in _audited_ai(
                    run_agent_with_fallback(
                        configs=configs,
                        system_prompt=draft_intake_system(force_final=force_final),
                        user_prompt=draft_intake_user(
                        brief + _reference_block(draft), transcript, turn_count, title=draft.title or "", gaps=gaps
                    ),
                        tool_schemas=INTAKE_TOOL_SCHEMAS,
                        tool_dispatch=dispatch,
                    ),
                    purpose="intake",
                    actor_id=user.employee_id,
                    draft_id=draft_id,
                    division_code=draft.division_code,
                ):
                    if frame["type"] == "ready_to_generate":
                        # Persist so the (separate) draft_generator request can
                        # read it without the frontend resending it 7 times.
                        fresh = _load_draft(s, draft_id)
                        chosen = [d["doc_id"] for d in (frame.get("key_docs") or [])]
                        pinned = [e["doc_id"] for e in (fresh.reference_excerpts or [])]
                        fresh.key_doc_ids = list(dict.fromkeys(pinned + chosen))
                        fresh.intake_transcript = transcript
                        s.commit()
                    yield _sse(frame)
                return

            # Default: merged conversational assistant (precedent-weaving folded
            # into DEFAULT_AGENT_SYSTEM — it was never a distinct capability, just
            # a canned instruction sequence the default prompt now always follows).
            yield _sse(start_frame)
            for frame in _audited_ai(
                run_agent_with_fallback(
                    configs=configs,
                    system_prompt=DEFAULT_AGENT_SYSTEM,
                    user_prompt=body.prompt,
                    tool_schemas=TOOL_SCHEMAS,
                    tool_dispatch=dispatch,
                ),
                purpose="chat",
                actor_id=user.employee_id,
                draft_id=draft_id,
                division_code=draft.division_code,
            ):
                yield _sse(frame)
        except HTTPException as e:
            yield _sse(error_frame("auth" if e.status_code in (401, 403) else "unknown", str(e.detail)))
        except Exception as e:  # noqa: BLE001
            log.exception("agent stream failed")
            code, message = classify_error(e)
            yield _sse(error_frame(code, message))
        finally:
            s.close()

    return StreamingResponse(
        _with_heartbeat(event_stream()),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "X-Accel-Buffering": "no",
        },
    )


def _run_reindex_background(user_id: str, division: str, force: bool) -> None:
    """Runs inside a FastAPI BackgroundTask AFTER the response is sent.

    Enqueues discovered/changed files into ingestion_jobs, then drains the
    queue with a worker pool. Progress lives in ingestion_jobs/ingestion_quota
    (DB-backed), not an in-process dict — so /corpus/reindex/status stays
    accurate even if the API redeploys mid-run; reset_stale_jobs() on startup
    recovers anything left 'running' by a process that died mid-job.
    """
    from sqlalchemy import delete as _delete  # noqa: PLC0415

    from .ingest import enqueue_jobs, run_worker_pool  # noqa: PLC0415
    from .models import CorpusChunk as _Chunk, CorpusDocument as _Doc, IngestionJob as _Job  # noqa: PLC0415

    try:
        if force:
            with SessionLocal() as s:
                s.execute(_delete(_Chunk))
                s.execute(_delete(_Doc))
                s.execute(_delete(_Job))
                s.commit()
        with SessionLocal() as s:
            enq = enqueue_jobs(s, division_code=division or "PPID")
        processed = run_worker_pool()
        with SessionLocal() as s:
            u = s.get(User, user_id)
            s.add(
                AuditLog(
                    actor_employee_id=user_id,
                    action="corpus.reindex",
                    target_kind="corpus",
                    target_id="all",
                    division_code=(u.division_code if u else division),
                    details={"force": force, "enqueued": enq, "processed": processed},
                )
            )
            s.commit()
    except Exception:  # noqa: BLE001
        log.exception("background reindex failed")


@app.post("/corpus/reindex")
@limiter.limit(RATE_CORPUS_REINDEX)
def corpus_reindex(
    request: Request,
    background_tasks: BackgroundTasks,
    force: bool = False,
    x_cfc_user: str | None = Header(default=None, alias="X-CFC-User"),
    cfc_session: str | None = Cookie(default=None, alias="cfc_session"),
    s: Session = Depends(get_session),
) -> dict[str, Any]:
    """Admin: enqueue any new/changed corpus files and drain the ingestion
    queue in the background so the HTTP connection isn't killed by Railway's
    5-minute edge timeout.

    `?force=true` truncates corpus_documents + corpus_chunks + ingestion_jobs
    first (needed after a schema migration that invalidated old chunk data).

    Poll `GET /corpus/reindex/status` for progress.
    """
    from .models import IngestionJob as _Job  # noqa: PLC0415

    user = _resolve_user(s, x_cfc_user, cfc_session)
    if not user.is_admin:
        raise HTTPException(status_code=403, detail="Admin only")
    already_running = s.execute(
        select(_Job).where(_Job.status == "running").limit(1)
    ).scalar_one_or_none()
    if already_running is not None and not force:
        return {"accepted": False, "reason": "already running", "poll": "/corpus/reindex/status"}
    background_tasks.add_task(
        _run_reindex_background,
        user.employee_id,
        user.division_code or "PPID",
        force,
    )
    return {"accepted": True, "poll": "/corpus/reindex/status"}


@app.get("/corpus/reindex/status")
def corpus_reindex_status(s: Session = Depends(get_session)) -> dict[str, Any]:
    from .models import IngestionJob as _Job, IngestionQuota as _Quota  # noqa: PLC0415

    counts: dict[str, int] = {row[0]: row[1] for row in s.execute(select(_Job.status, func.count()).group_by(_Job.status)).all()}
    quota = s.get(_Quota, 1)
    return {
        "jobs": counts,
        "total": sum(counts.values()),
        "runpulse_pages_used_total": quota.runpulse_pages_used_total if quota else 0,
        "runpulse_page_cap": quota.runpulse_page_cap if quota else None,
    }


@app.post("/corpus/graph/recompute")
def corpus_graph_recompute(
    k: int = 8,
    x_cfc_user: str | None = Header(default=None, alias="X-CFC-User"),
    cfc_session: str | None = Cookie(default=None, alias="cfc_session"),
    s: Session = Depends(get_session),
) -> dict[str, Any]:
    """Admin: full corpus_edges recompute for drift correction (item 7).

    Reuses the same admin-check pattern as /corpus/reindex above. Runs
    synchronously — see corpus_db.recompute_all_edges: bounded/reasonable
    at the current ~49-doc corpus size, unlike /corpus/reindex's OCR-bound
    background-task treatment.
    """
    user = _resolve_user(s, x_cfc_user, cfc_session)
    if not user.is_admin:
        raise HTTPException(status_code=403, detail="Admin only")
    result = recompute_all_edges(s, k=k)
    s.commit()
    _log_audit(
        s,
        actor=user,
        action="corpus.graph_recompute",
        target_kind="corpus",
        target_id="all",
        division_code=user.division_code,
        details=result,
    )
    s.commit()
    return {"ok": True, **result}


@app.post("/corpus/reclassify")
def corpus_reclassify(
    x_cfc_user: str | None = Header(default=None, alias="X-CFC-User"),
    cfc_session: str | None = Cookie(default=None, alias="cfc_session"),
    s: Session = Depends(get_session),
) -> dict[str, Any]:
    """Admin: re-run domain/ministry classification against every already-
    ingested document's STORED text (item 6a) — no re-extraction, no OCR, no
    re-embedding, so this is cheap and safe to run synchronously.

    Needed because ingestion's change detection is raw-file-hash based: a
    document ingested before TYPESAFE_API_KEY existed, or before
    processed_json documents were included in classification at all, never
    gets reclassified on its own just because the code changed underneath
    it — the file on disk hasn't changed, so it never gets re-queued.
    """
    from .ingest import reclassify_all  # noqa: PLC0415

    user = _resolve_user(s, x_cfc_user, cfc_session)
    if not user.is_admin:
        raise HTTPException(status_code=403, detail="Admin only")
    result = reclassify_all(s)
    s.commit()
    _log_audit(
        s,
        actor=user,
        action="corpus.reclassify",
        target_kind="corpus",
        target_id="all",
        division_code=user.division_code,
        details=result,
    )
    s.commit()
    return {"ok": True, **result}


_INJECTION_FLAG_THRESHOLD = 0.5


@app.get("/corpus/flagged")
def corpus_flagged(
    x_cfc_user: str | None = Header(default=None, alias="X-CFC-User"),
    cfc_session: str | None = Cookie(default=None, alias="cfc_session"),
    s: Session = Depends(get_session),
) -> dict[str, Any]:
    """Admin: documents Jev's injection screen (item 10) scored at or above
    threshold — surfaced for a human to review, never silently excluded
    from retrieval. A flagged document staying in cfc_search_corpus/
    cfc_get_document results is a deliberate choice: a false positive
    should never make a legitimate document invisible.
    """
    user = _resolve_user(s, x_cfc_user, cfc_session)
    if not user.is_admin:
        raise HTTPException(status_code=403, detail="Admin only")
    rows = s.execute(
        select(CorpusDocument)
        .where(CorpusDocument.injection_flag.is_not(None))
        .where(CorpusDocument.injection_flag >= _INJECTION_FLAG_THRESHOLD)
        .order_by(CorpusDocument.injection_flag.desc())
    ).scalars().all()
    return {
        "threshold": _INJECTION_FLAG_THRESHOLD,
        "items": [
            {
                "doc_id": d.doc_id,
                "title": d.title,
                "ministry": d.ministry,
                "division_code": d.division_code,
                "kind": d.kind,
                "source_path": d.source_path,
                "injection_flag": d.injection_flag,
            }
            for d in rows
        ],
    }


# --------------------------------------------------------------------------- #
# Reader: original documents, private highlights, excerpts into drafts
# --------------------------------------------------------------------------- #

_OUTCOME_LABELS = {"successful": "Won", "unsuccessful": "Not won", "pending": "Pending"}


def _visible_document(s: Session, user: User, doc_id: str) -> CorpusDocument:
    stmt = select(CorpusDocument).where(CorpusDocument.doc_id == doc_id)
    if not reads_all_boards(user):
        stmt = stmt.where(CorpusDocument.division_code == user.division_code)
    doc = s.execute(stmt).scalar_one_or_none()
    if doc is None:
        raise HTTPException(status_code=404, detail="Document not found")
    return doc


def _doc_summary(d: CorpusDocument) -> dict[str, Any]:
    return {
        "doc_id": d.doc_id,
        "title": d.title,
        "client": d.client or d.ministry,
        "ministry": d.ministry,
        "state": d.state,
        "sector": d.sector,
        "work_type": d.work_type,
        "engagement": d.engagement,
        "doc_type": d.doc_type,
        "date": d.date,
        "value_inr": d.value_inr or None,
        "outcome": d.outcome or "unknown",
        "outcome_label": _OUTCOME_LABELS.get(d.outcome or ""),
    }


def _highlight_dict(h: ReaderHighlight, title: str | None = None) -> dict[str, Any]:
    return {
        "id": h.id,
        "doc_id": h.doc_id,
        "doc_title": title,
        "page": h.page,
        "rects": h.rects,
        "quote": h.quote,
        "note": h.note,
        "created_at": _iso(h.created_at),
    }


def _reference_excerpts(s: Session, user: User, highlight_ids: list[int]) -> list[dict[str, Any]]:
    """The caller's own highlights, in the order given, as draft reference excerpts."""
    rows = s.execute(
        select(ReaderHighlight).where(
            ReaderHighlight.id.in_(highlight_ids[:50]), ReaderHighlight.employee_id == user.employee_id
        )
    ).scalars().all()
    by_id = {h.id: h for h in rows}
    titles = {
        d.doc_id: d.title
        for d in s.execute(
            select(CorpusDocument).where(CorpusDocument.doc_id.in_({h.doc_id for h in rows}))
        ).scalars().all()
    }
    return [
        {"doc_id": h.doc_id, "title": titles.get(h.doc_id, h.doc_id), "page": h.page, "quote": h.quote[:2000]}
        for h in (by_id.get(i) for i in highlight_ids)
        if h is not None
    ]


def _reference_block(draft: Draft) -> str:
    """Excerpts the maker chose in the Reader, appended to the model's brief."""
    excerpts = draft.reference_excerpts or []
    if not excerpts:
        return ""
    lines = [
        "",
        "",
        "Reference excerpts the author highlighted in past QCI documents (treat as accurate; "
        "cite them as (Source: title, p. N) where you use them):",
    ]
    for e in excerpts:
        quote = " ".join(str(e.get("quote", "")).split())
        lines.append(f"- “{quote}” ({e.get('title')}, p. {e.get('page')})")
    return "\n".join(lines)


class HighlightRectBody(BaseModel):
    page: int
    x: float
    y: float
    w: float
    h: float


class HighlightBody(BaseModel):
    doc_id: str
    page: int
    rects: list[HighlightRectBody]
    quote: str
    note: str | None = None


class HighlightNoteBody(BaseModel):
    note: str | None = None


class ExcerptBody(BaseModel):
    highlight_id: int | None = None
    highlight_ids: list[int] = Field(default_factory=list, max_length=20)


@app.get("/reader/documents/{doc_id}")
def reader_document(
    doc_id: str,
    x_cfc_user: str | None = Header(default=None, alias="X-CFC-User"),
    cfc_session: str | None = Cookie(default=None, alias="cfc_session"),
    s: Session = Depends(get_session),
) -> dict[str, Any]:
    """A document's details for the Reader: what it is, the rest of its
    engagement series (by date), and the documents most similar to it."""
    user = _resolve_user(s, x_cfc_user, cfc_session)
    doc = _visible_document(s, user, doc_id)
    series: list[dict[str, Any]] = []
    if doc.engagement:
        stmt = select(CorpusDocument).where(CorpusDocument.engagement == doc.engagement)
        if not reads_all_boards(user):
            stmt = stmt.where(CorpusDocument.division_code == user.division_code)
        series = sorted((_doc_summary(d) for d in s.execute(stmt).scalars().all()), key=lambda d: d["date"] or "")
    in_series = {d["doc_id"] for d in series}
    similar_ids = [n["doc_id"] for n in graph_children(s, f"doc:{doc_id}", user=user) if n.get("doc_id")]
    similar_ids = [i for i in similar_ids if i not in in_series][:6]
    similar_docs = {
        d.doc_id: d
        for d in s.execute(select(CorpusDocument).where(CorpusDocument.doc_id.in_(similar_ids))).scalars().all()
    }
    return {
        "document": _doc_summary(doc),
        "file_url": f"/reader/documents/{doc_id}/file",
        "series": series if len(series) > 1 else [],
        "similar": [_doc_summary(similar_docs[i]) for i in similar_ids if i in similar_docs],
    }


@app.get("/reader/documents/{doc_id}/file")
def reader_document_file(
    doc_id: str,
    x_cfc_user: str | None = Header(default=None, alias="X-CFC-User"),
    cfc_session: str | None = Cookie(default=None, alias="cfc_session"),
    s: Session = Depends(get_session),
) -> FileResponse:
    """The document as a PDF (the original, or a PDF copy of a Word file).
    Range requests are honoured, so large PDFs open a page at a time."""
    user = _resolve_user(s, x_cfc_user, cfc_session)
    doc = _visible_document(s, user, doc_id)
    try:
        path = reader.viewable_pdf(doc)
    except reader.NotAvailable as e:
        raise HTTPException(status_code=404, detail=str(e)) from e
    safe_title = re.sub(r'[\\/:*?"<>|]+', " ", doc.title or doc_id).strip()[:150] or "document"
    return FileResponse(
        path,
        media_type="application/pdf",
        filename=f"{safe_title}.pdf",
        content_disposition_type="inline",
        headers={"Cache-Control": "private, max-age=3600"},
    )


@app.get("/reader/highlights")
def reader_highlights(
    doc_id: str | None = None,
    x_cfc_user: str | None = Header(default=None, alias="X-CFC-User"),
    cfc_session: str | None = Cookie(default=None, alias="cfc_session"),
    s: Session = Depends(get_session),
) -> dict[str, Any]:
    """The caller's own highlights: for one document, or all of them (newest first)."""
    user = _resolve_user(s, x_cfc_user, cfc_session)
    stmt = select(ReaderHighlight).where(ReaderHighlight.employee_id == user.employee_id)
    if doc_id:
        _visible_document(s, user, doc_id)
        stmt = stmt.where(ReaderHighlight.doc_id == doc_id).order_by(ReaderHighlight.page, ReaderHighlight.id)
    else:
        stmt = stmt.order_by(ReaderHighlight.created_at.desc()).limit(200)
    rows = s.execute(stmt).scalars().all()
    titles = {
        d.doc_id: d.title
        for d in s.execute(
            select(CorpusDocument).where(CorpusDocument.doc_id.in_({h.doc_id for h in rows}))
        ).scalars().all()
    }
    return {"items": [_highlight_dict(h, titles.get(h.doc_id)) for h in rows]}


@app.post("/reader/highlights")
def reader_add_highlight(
    body: HighlightBody,
    x_cfc_user: str | None = Header(default=None, alias="X-CFC-User"),
    cfc_session: str | None = Cookie(default=None, alias="cfc_session"),
    s: Session = Depends(get_session),
) -> dict[str, Any]:
    user = _resolve_user(s, x_cfc_user, cfc_session)
    doc = _visible_document(s, user, body.doc_id)
    quote = " ".join(body.quote.split())
    if not quote or not body.rects:
        raise HTTPException(status_code=400, detail="Select some text to highlight.")
    if len(quote) > 8000 or len(body.rects) > 500:
        raise HTTPException(status_code=400, detail="That selection is too long to save as one highlight.")
    rects = []
    for r in body.rects:
        # Intersect with the page (0..1 on both axes); drop what falls outside it.
        x0, y0 = max(r.x, 0.0), max(r.y, 0.0)
        x1, y1 = min(r.x + r.w, 1.0), min(r.y + r.h, 1.0)
        if x1 > x0 and y1 > y0 and r.page >= 1:
            rects.append({"page": int(r.page), **{k: round(v, 5) for k, v in zip("xywh", (x0, y0, x1 - x0, y1 - y0))}})
    if not rects:
        raise HTTPException(status_code=400, detail="Select some text to highlight.")
    h = ReaderHighlight(
        employee_id=user.employee_id,
        doc_id=doc.doc_id,
        page=body.page,
        rects=rects,
        quote=quote,
        note=(body.note or "").strip() or None,
    )
    s.add(h)
    s.commit()
    s.refresh(h)
    return _highlight_dict(h, doc.title)


def _own_highlight(s: Session, user: User, highlight_id: int) -> ReaderHighlight:
    h = s.get(ReaderHighlight, highlight_id)
    if h is None or h.employee_id != user.employee_id:
        raise HTTPException(status_code=404, detail="Highlight not found")
    return h


@app.patch("/reader/highlights/{highlight_id}")
def reader_note_highlight(
    highlight_id: int,
    body: HighlightNoteBody,
    x_cfc_user: str | None = Header(default=None, alias="X-CFC-User"),
    cfc_session: str | None = Cookie(default=None, alias="cfc_session"),
    s: Session = Depends(get_session),
) -> dict[str, Any]:
    user = _resolve_user(s, x_cfc_user, cfc_session)
    h = _own_highlight(s, user, highlight_id)
    h.note = (body.note or "").strip()[:2000] or None
    s.commit()
    return _highlight_dict(h)


@app.delete("/reader/highlights/{highlight_id}")
def reader_delete_highlight(
    highlight_id: int,
    x_cfc_user: str | None = Header(default=None, alias="X-CFC-User"),
    cfc_session: str | None = Cookie(default=None, alias="cfc_session"),
    s: Session = Depends(get_session),
) -> dict[str, Any]:
    user = _resolve_user(s, x_cfc_user, cfc_session)
    s.delete(_own_highlight(s, user, highlight_id))
    s.commit()
    return {"ok": True}


@app.get("/reader/my-drafts")
def reader_my_drafts(
    x_cfc_user: str | None = Header(default=None, alias="X-CFC-User"),
    cfc_session: str | None = Cookie(default=None, alias="cfc_session"),
    s: Session = Depends(get_session),
) -> dict[str, Any]:
    """The caller's drafts that an excerpt can be added to right now."""
    user = _resolve_user(s, x_cfc_user, cfc_session)
    drafts = s.execute(
        select(Draft).where(Draft.maker_employee_id == user.employee_id).order_by(Draft.updated_at.desc()).limit(50)
    ).scalars().all()
    return {
        "items": [
            {"id": d.id, "title": d.title, "status": d.status, "updated_at": _iso(d.updated_at)}
            for d in drafts
            if _session_for(s, user, d).get("can_run_agent_mutate")
        ]
    }


@app.post("/drafts/{draft_id}/excerpts")
def draft_add_excerpt(
    draft_id: str,
    body: ExcerptBody,
    x_cfc_user: str | None = Header(default=None, alias="X-CFC-User"),
    cfc_session: str | None = Cookie(default=None, alias="cfc_session"),
    s: Session = Depends(get_session),
) -> dict[str, Any]:
    """Adds the caller's highlights to the end of a draft, each quoted with its
    source and page, in one new version. No AI involved, so confidential
    drafts accept it too."""
    user = _resolve_user(s, x_cfc_user, cfc_session)
    draft = _load_draft(s, draft_id)
    flags = _session_for(s, user, draft)
    if not _can_view_division(user, draft.division_code) or not flags.get("can_run_agent_mutate"):
        raise HTTPException(status_code=403, detail="You can't add to this document right now.")
    ids = list(dict.fromkeys(([body.highlight_id] if body.highlight_id else []) + body.highlight_ids))
    if not ids:
        raise HTTPException(status_code=422, detail="Choose a highlight to add.")
    ops: list[dict[str, Any]] = []
    sources: list[dict[str, Any]] = []
    for hid in ids:
        h = _own_highlight(s, user, hid)
        doc = _visible_document(s, user, h.doc_id)
        ops.append({"kind": "insert_end", "text": f"“{h.quote}” *(Source: {doc.title}, p. {h.page})*"})
        sources.append({"doc_id": doc.doc_id, "page": h.page})
    try:
        result = agent_mutate(
            AgentContext(session=s, user=user, draft=draft, session_flags=flags),
            ops,
            trigger="reader_excerpt",
        )
    except ToolError as e:
        raise HTTPException(status_code=502, detail="The excerpt couldn't be added. Please try again.") from e
    _log_audit(
        s,
        actor=user,
        action="draft.insert_excerpt",
        target_kind="draft",
        target_id=draft.id,
        division_code=draft.division_code,
        details={"excerpts": sources},
    )
    s.commit()
    return {"ok": True, "version": result.get("version"), "draft": {"id": draft.id, "title": draft.title}}


# --------------------------------------------------------------------------- #
# Library: browse and search the corpus as documents, won work first
# --------------------------------------------------------------------------- #

_LIBRARY_FIELDS = ("client", "sector", "work_type", "doc_type", "state", "year", "outcome")
_OUTCOME_FACET_LABELS = {**_OUTCOME_LABELS, "unknown": "Not recorded"}
_GRID_ROWS = 14
_GRID_COLS = 8


def _library_value(d: CorpusDocument, field: str) -> str | None:
    if field == "client":
        return d.client or d.ministry
    if field == "year":
        m = re.match(r"(\d{4})", d.date or "")
        return m.group(1) if m else None
    if field == "outcome":
        return d.outcome or "unknown"
    return getattr(d, field)


def _title_matches(q: str, docs: list[CorpusDocument]) -> set[str]:
    """Documents whose title, client or engagement contains every query word."""
    words = [w for w in re.findall(r"\w+", q.lower()) if len(w) > 2]
    if not words:
        return set()
    out = set()
    for d in docs:
        hay = " ".join(filter(None, [d.title, d.client, d.ministry, d.engagement])).lower()
        if all(w in hay for w in words):
            out.add(d.doc_id)
    return out


def _snippet(text: str, q: str, width: int = 260) -> str:
    """A short window of the passage around the first query word it contains."""
    flat = " ".join((text or "").split())
    words = [w for w in re.findall(r"\w+", q.lower()) if len(w) > 2]
    lower = flat.lower()
    at = min((i for i in (lower.find(w) for w in words) if i >= 0), default=0)
    start = max(0, at - width // 3)
    if start:
        space = flat.find(" ", start)
        start = space + 1 if 0 <= space < at else start
    cut = flat[start : start + width]
    if start + width < len(flat):
        cut = cut[: cut.rfind(" ")] if " " in cut else cut
        cut += "…"
    return ("…" if start else "") + cut


@app.get("/library/documents")
def library_documents(
    q: str = "",
    client: list[str] = Query(default=[]),
    sector: list[str] = Query(default=[]),
    work_type: list[str] = Query(default=[]),
    doc_type: list[str] = Query(default=[]),
    state: list[str] = Query(default=[]),
    year: list[str] = Query(default=[]),
    outcome: list[str] = Query(default=[]),
    sort: str = "best",
    won_first: bool = True,
    x_cfc_user: str | None = Header(default=None, alias="X-CFC-User"),
    cfc_session: str | None = Cookie(default=None, alias="cfc_session"),
    s: Session = Depends(get_session),
) -> dict[str, Any]:
    """The documents the caller may read, searched and filtered, with counts
    for every filter, a sector x type-of-work coverage grid and the
    engagements (series of documents for one piece of work) among them."""
    user = _resolve_user(s, x_cfc_user, cfc_session)
    stmt = select(CorpusDocument)
    if not reads_all_boards(user):
        stmt = stmt.where(CorpusDocument.division_code == user.division_code)
    docs = list(s.execute(stmt).scalars().all())

    q = q.strip()[:300]
    matches: dict[str, dict[str, Any]] | None = None
    if q:
        matches = db_search_documents(s, q, user=user) if db_has_corpus(s) else {}
        for doc_id in _title_matches(q, docs):
            hit = matches.setdefault(doc_id, {"score": 0.0, "snippet": "", "section": None})
            hit["score"] = max(hit["score"], 0.9)
        docs = [d for d in docs if d.doc_id in matches]

    chosen = {
        "client": set(client), "sector": set(sector), "work_type": set(work_type), "doc_type": set(doc_type),
        "state": set(state), "year": set(year), "outcome": set(outcome),
    }

    def passes(d: CorpusDocument, skip: str | None = None) -> bool:
        return all(
            not values or _library_value(d, field) in values
            for field, values in chosen.items()
            if field != skip
        )

    items = [d for d in docs if passes(d)]

    def score(d: CorpusDocument) -> float:
        return (matches or {}).get(d.doc_id, {}).get("score", 0.0)

    def newest(d: CorpusDocument) -> str:
        return d.date or ""

    if sort == "newest" or (sort == "best" and not q):
        items.sort(key=newest, reverse=True)
    elif sort == "value":
        items.sort(key=lambda d: d.value_inr or 0.0, reverse=True)
    else:
        items.sort(key=score, reverse=True)
    if won_first:
        items.sort(key=lambda d: 0 if d.outcome == "successful" else 1)  # stable: keeps the order within each group

    facets: dict[str, list[dict[str, Any]]] = {}
    for field in _LIBRARY_FIELDS:
        counts: dict[str, int] = {}
        for d in docs:
            if passes(d, skip=field):
                v = _library_value(d, field)
                if v:
                    counts[v] = counts.get(v, 0) + 1
        for v in chosen[field]:
            counts.setdefault(v, 0)  # keep a chosen value visible even when nothing matches
        if field == "year":
            ordered = sorted(counts.items(), key=lambda kv: kv[0], reverse=True)
        else:
            ordered = sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))
        facets[field] = [
            {"value": v, "label": _OUTCOME_FACET_LABELS.get(v, v) if field == "outcome" else v, "count": n}
            for v, n in ordered
        ]

    row_counts: dict[str, int] = {}
    col_counts: dict[str, int] = {}
    for d in items:
        row_counts[d.sector or "Other"] = row_counts.get(d.sector or "Other", 0) + 1
        col_counts[d.work_type or "Other"] = col_counts.get(d.work_type or "Other", 0) + 1
    rows = [r for r, _ in sorted(row_counts.items(), key=lambda kv: (-kv[1], kv[0]))[:_GRID_ROWS]]
    cols = [c for c, _ in sorted(col_counts.items(), key=lambda kv: (-kv[1], kv[0]))[:_GRID_COLS]]
    cells: dict[str, dict[str, dict[str, int]]] = {}
    for d in items:
        r, c = d.sector or "Other", d.work_type or "Other"
        if r in rows and c in cols:
            cell = cells.setdefault(r, {}).setdefault(c, {"count": 0, "won": 0})
            cell["count"] += 1
            cell["won"] += 1 if d.outcome == "successful" else 0

    series: dict[str, list[CorpusDocument]] = {}
    for d in items:
        if d.engagement:
            series.setdefault(d.engagement, []).append(d)
    engagements = [
        {
            "engagement": name,
            "client": members[0].client or members[0].ministry,
            "documents": [_doc_summary(m) for m in sorted(members, key=newest)],
        }
        for name, members in series.items()
        if len(members) > 1
    ]
    engagements.sort(key=lambda e: (-len(e["documents"]), e["engagement"]))

    def result(d: CorpusDocument) -> dict[str, Any]:
        out = _doc_summary(d)
        hit = (matches or {}).get(d.doc_id)
        if hit and hit.get("snippet"):
            out["snippet"] = _snippet(hit["snippet"], q)
            out["section"] = hit.get("section")
        return out

    return {
        "query": q,
        "total": len(items),
        "items": [result(d) for d in items[:200]],
        "facets": facets,
        "grid": {"rows": rows, "cols": cols, "cells": cells},
        "engagements": engagements[:30],
    }


@app.get("/corpus/graph/children")
def corpus_graph_children(
    parent: str | None = None,
    x_cfc_user: str | None = Header(default=None, alias="X-CFC-User"),
    cfc_session: str | None = Cookie(default=None, alias="cfc_session"),
    s: Session = Depends(get_session),
) -> dict[str, Any]:
    """Lazy one-level-at-a-time knowledge-graph explorer (item 7). See
    corpus_db.graph_children for the node-id scheme and ACL scoping
    (division-based, reusing the same predicate as db_list_documents)."""
    user = _resolve_user(s, x_cfc_user, cfc_session)
    nodes = graph_children(s, parent, user=user)
    return {"parent": parent or "root", "nodes": nodes}


@app.get("/corpus/graph/preview/{doc_id}")
def corpus_graph_preview(
    doc_id: str,
    x_cfc_user: str | None = Header(default=None, alias="X-CFC-User"),
    cfc_session: str | None = Cookie(default=None, alias="cfc_session"),
    s: Session = Depends(get_session),
) -> dict[str, Any]:
    """Leaf-node preview for a knowledge-graph document (item 7).

    Only the corpus_document branch is implemented: there is no confirmed
    link anywhere in the current schema between CorpusDocument and Draft
    (no shared id/foreign key — see the item-7 report), so the {"kind":
    "draft", ...} alternative described in the frontend contract does not
    apply yet and is intentionally not emitted here.
    """
    user = _resolve_user(s, x_cfc_user, cfc_session)
    stmt = select(CorpusDocument).where(CorpusDocument.doc_id == doc_id)
    if not reads_all_boards(user):
        stmt = stmt.where(CorpusDocument.division_code == user.division_code)
    doc = s.execute(stmt).scalar_one_or_none()
    if not doc:
        raise HTTPException(status_code=404, detail="document not found")
    return {
        "kind": "corpus_document",
        "doc_id": doc.doc_id,
        "title": doc.title,
        "ministry": doc.ministry or "Unknown",
        "domains": doc.domains or [],
        "date": doc.date,
        "text": (doc.full_text or "")[:8000],
        "source_kind": doc.kind,
    }


@app.get("/integrations/health")
def integrations_health() -> dict[str, Any]:
    worker_status: dict[str, Any] = {"ok": False}
    try:
        with urlrequest.urlopen(f"{DOC_WORKER_URL}/health", timeout=3) as resp:
            worker_status = json.loads(resp.read().decode("utf-8"))
            worker_status["ok"] = True
    except Exception as e:  # noqa: BLE001
        worker_status = {"ok": False, "error": str(e)}

    with SessionLocal() as s:
        counts = {
            "users": int(s.scalar(select(func.count(User.employee_id))) or 0),
            "divisions": int(s.scalar(select(func.count(Division.code))) or 0),
            "drafts": int(s.scalar(select(func.count(Draft.id))) or 0),
        }

    return {
        "api": "ok",
        "database": {"url": _obfuscate_db_url(), **counts},
        "template_exists": TEMPLATE.exists(),
        "doc_worker": worker_status,
        # Legacy field for backwards compatibility with existing frontend banner.
        "storage": str((ROOT / "storage" / "dev" / "drafts").resolve()),
    }


def _obfuscate_db_url() -> str:
    from .db import DATABASE_URL

    if DATABASE_URL.startswith("sqlite"):
        return "sqlite (dev)"
    # postgresql+psycopg://user:pass@host:port/db → postgresql+psycopg://user:***@host/db
    try:
        head, tail = DATABASE_URL.split("://", 1)
        cred, host = tail.split("@", 1) if "@" in tail else ("", tail)
        if ":" in cred:
            user, _ = cred.split(":", 1)
            cred = f"{user}:***"
        return f"{head}://{cred}@{host}" if cred else f"{head}://{host}"
    except Exception:  # noqa: BLE001
        return "postgresql"
