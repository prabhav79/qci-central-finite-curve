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
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Literal
from urllib import request as urlrequest
from urllib.error import HTTPError, URLError

from dotenv import load_dotenv
from fastapi import BackgroundTasks, Cookie, Depends, FastAPI, File, Form, Header, HTTPException, Request, Response, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel
from slowapi import Limiter, _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded
from slowapi.util import get_remote_address
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session, selectinload

from .agent_llm import LLMConfig, run_agent_with_fallback
from . import auth as auth_mod
from .agent_presets import (
    precedent_weaver_system,
    precedent_weaver_user,
    redline_extender_system,
    redline_extender_user,
)
from .agent_tools import TOOL_SCHEMAS, AgentContext, dispatch as agent_dispatch
from .corpus import corpus_stats as inmem_stats, get_document as inmem_get, list_documents as inmem_list, reload_corpus, search_corpus as inmem_search
from .corpus_db import db_get_document, db_has_corpus, db_list_documents, db_search, db_stats
from .db import ROOT, SessionLocal, ensure_pgvector, get_session
from .models import AuditLog, CorpusDocument, Division, Draft, DraftApproval, DraftVersion, Thread, User
from .rag import answer_query
from .seed import seed_divisions_and_users
from .storage import Bucket, default_bucket

log = logging.getLogger("cfc.api")

TEMPLATE = ROOT / "packages" / "doc-fixtures" / "templates" / "WO_EXTENSION.docx"
DOC_WORKER_URL = os.environ.get("DOC_WORKER_URL", "http://127.0.0.1:8100").rstrip("/")

load_dotenv(ROOT / ".env", override=True)
load_dotenv(override=True)

app = FastAPI(title="CFC API", version="0.3.0")

# Rate limits: keyed by X-CFC-User when present (personas mode), else IP.
def _limit_key(request: Request) -> str:
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
)


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


def _bucket() -> Bucket:
    return default_bucket()


# --------------------------------------------------------------------------- #
# Request models
# --------------------------------------------------------------------------- #

class CreateDraftBody(BaseModel):
    title: str = "Work Order Extension Draft"
    template_code: str = "WO_EXTENSION"
    # None (the default) means "the caller" — resolved from the authenticated
    # session, not a hardcoded persona. Only an explicit value here overrides it
    # (e.g. an admin creating on behalf of someone else).
    maker_employee_id: str | None = None


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
    if user.cfc_role == "apex":
        return True
    if user.is_admin:
        return True
    return user.division_code == division_code


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
    }


# --------------------------------------------------------------------------- #
# Auth (magic-link) — active only when CFC_AUTH_MODE=magic-link.
# Personas dropdown continues to work in demo mode.
# --------------------------------------------------------------------------- #

class MagicLinkBody(BaseModel):
    email: str


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
def hierarchy_tree(s: Session = Depends(get_session)) -> dict[str, Any]:
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
    if not TEMPLATE.exists():
        raise HTTPException(status_code=500, detail=f"Template missing: {TEMPLATE}")

    draft_id = uuid.uuid4().hex[:12]
    key = _version_key(draft_id, 1)
    bucket = _bucket()
    bucket.put_file(key, TEMPLATE)
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
    )
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
        details={"template_code": body.template_code, "title": body.title},
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


@app.get("/dev/drafts/{draft_id}/file")
@app.get("/drafts/{draft_id}/file")
def get_file(
    draft_id: str,
    s: Session = Depends(get_session),
) -> FileResponse:
    draft = _load_draft(s, draft_id)
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
    s: Session = Depends(get_session),
) -> dict[str, Any]:
    draft = _load_draft(s, draft_id)
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
    if user.cfc_role != "apex" and not user.is_admin:
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
    if user.cfc_role != "apex" and not user.is_admin:
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
    return answer_query(
        body.query,
        limit=body.limit,
        ministry=body.ministry,
        provider=body.provider,
        api_key=body.api_key,
        model=body.model,
        prefetched_hits=hits,
    )


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
    "read the current draft, and propose insertions or replacements. Never "
    "invent citations — cite the doc_id returned by cfc_search_corpus. Keep "
    "insertions focused and short. When the user's session is a suggester "
    "(approver review), your mutations are automatically tracked."
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

    if prov and body_api_key:
        return [LLMConfig(provider=prov, api_key=body_api_key, model=body_model or "")]

    # auto or partial — build server-side chain
    order_env = os.environ.get("CFC_AGENT_FALLBACK", "gemini,groq")
    order = [p.strip().lower() for p in order_env.split(",") if p.strip()]
    if prov and prov != "auto":
        # named provider without a key — still try that provider first from env, then fall back
        order = [prov, *[p for p in order if p != prov]]

    configs: list[LLMConfig] = []
    env_key = {
        "gemini": os.environ.get("GEMINI_API_KEY"),
        "google": os.environ.get("GEMINI_API_KEY"),
        "openai": os.environ.get("OPENAI_API_KEY"),
        "groq": os.environ.get("GROQ_API_KEY"),
    }
    env_model = {
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
    if not configs:
        # nothing configured — surface as mock so the user isn't blocked
        configs = [LLMConfig(provider="mock", api_key=None, model="")]
    return configs


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
                yield _sse({"type": "error", "message": "Cross-division access denied"})
                return

            configs = _resolve_agent_configs(body.provider or "mock", body.api_key, body.model)
            preset = (body.preset or "").lower().strip()
            preset_args = body.preset_args or {}

            if preset in {"precedent_weaver", "precedent-weaver"}:
                system_prompt = precedent_weaver_system()
                user_prompt = precedent_weaver_user(
                    task=body.prompt,
                    hints=str(preset_args.get("hints", "")),
                    focus_areas=str(preset_args.get("focus_areas", "")),
                )
                yield _sse({"type": "preset", "name": "precedent_weaver"})
            elif preset in {"redline_extender", "redline-extender"}:
                system_prompt = redline_extender_system()
                user_prompt = redline_extender_user(
                    task=body.prompt,
                    focus_areas=str(preset_args.get("focus_areas", "")),
                    hints=str(preset_args.get("hints", "")),
                )
                yield _sse({"type": "preset", "name": "redline_extender"})
            else:
                system_prompt = DEFAULT_AGENT_SYSTEM
                user_prompt = body.prompt

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

            yield _sse(
                {
                    "type": "start",
                    "draft_id": draft_id,
                    "version": draft.current_version,
                    "providers": [c.provider for c in configs],
                    "tracked": session_flags.get("agent_change_mode") == "tracked",
                    "can_run_agent_mutate": session_flags.get("can_run_agent_mutate"),
                }
            )
            for frame in run_agent_with_fallback(
                configs=configs,
                system_prompt=system_prompt,
                user_prompt=user_prompt,
                tool_schemas=TOOL_SCHEMAS,
                tool_dispatch=dispatch,
            ):
                yield _sse(frame)
        except HTTPException as e:
            yield _sse({"type": "error", "message": f"http {e.status_code}: {e.detail}"})
        except Exception as e:  # noqa: BLE001
            log.exception("agent stream failed")
            yield _sse({"type": "error", "message": f"{type(e).__name__}: {e}"})
        finally:
            s.close()

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "X-Accel-Buffering": "no",
        },
    )


# Reindex progress tracked in-process. Cleared on restart.
_reindex_state: dict[str, Any] = {"status": "idle", "started_at": None, "finished_at": None, "result": None, "error": None}


def _run_reindex_background(user_id: str, division: str, force: bool) -> None:
    """Runs inside a FastAPI BackgroundTask AFTER the response is sent.

    Own session; own error handling; writes progress into module-level state
    that /corpus/reindex/status reads.
    """
    from sqlalchemy import delete as _delete  # noqa: PLC0415

    from .ingest import ingest_all  # noqa: PLC0415
    from .models import CorpusChunk as _Chunk, CorpusDocument as _Doc  # noqa: PLC0415

    _reindex_state.update({"status": "running", "started_at": _iso(_utc_now()), "finished_at": None, "result": None, "error": None})
    try:
        if force:
            with SessionLocal() as s:
                s.execute(_delete(_Chunk))
                s.execute(_delete(_Doc))
                s.commit()
        res = ingest_all(division_code=division or "PPID")
        with SessionLocal() as s:
            u = s.get(User, user_id)
            s.add(
                AuditLog(
                    actor_employee_id=user_id,
                    action="corpus.reindex",
                    target_kind="corpus",
                    target_id="all",
                    division_code=(u.division_code if u else division),
                    details={"force": force, **(res.get("stats") or {})},
                )
            )
            s.commit()
        _reindex_state.update({"status": "done", "finished_at": _iso(_utc_now()), "result": res})
    except Exception as e:  # noqa: BLE001
        log.exception("background reindex failed")
        _reindex_state.update({"status": "error", "finished_at": _iso(_utc_now()), "error": f"{type(e).__name__}: {e}"})


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
    """Admin: rebuild the corpus index. Runs in the background so the HTTP
    connection isn't killed by Railway's 5-minute edge timeout.

    `?force=true` truncates corpus_documents + corpus_chunks first (needed
    after a schema migration that invalidated old chunk data).

    Poll `GET /corpus/reindex/status` for progress.
    """
    user = _resolve_user(s, x_cfc_user, cfc_session)
    if not user.is_admin:
        raise HTTPException(status_code=403, detail="Admin only")
    if _reindex_state.get("status") == "running":
        return {"accepted": False, "reason": "already running", "state": _reindex_state}
    background_tasks.add_task(
        _run_reindex_background,
        user.employee_id,
        user.division_code or "PPID",
        force,
    )
    return {"accepted": True, "state": _reindex_state, "poll": "/corpus/reindex/status"}


@app.get("/corpus/reindex/status")
def corpus_reindex_status() -> dict[str, Any]:
    return _reindex_state


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
