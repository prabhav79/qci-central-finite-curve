"""
CFC-flavored tools the doc-grounded agent can call.

Tools:
- cfc_search_corpus(query, limit=5)          — ACL-scoped DB retrieval, matches /corpus/search
- cfc_get_document(doc_id)                   — full text of a corpus doc (ACL-checked)
- cfc_read_current_draft()                    — text of the current draft version (python-docx)
- cfc_propose_insert(text, position="end")    — dispatch to doc-worker; snapshots new draft_version
- cfc_propose_replace(find, replace)          — dispatch to doc-worker; snapshots new draft_version

Version-before-mutate is intrinsic: every mutation writes a NEW draft_version
rather than overwriting the current one, so the pre-mutation state is always
recoverable via the versions list.

Approver sessions (SuperDoc suggester role) force tracked change mode via
`session.agent_change_mode == "tracked"`.
"""
from __future__ import annotations

import hashlib
import json
import logging
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable
from urllib import request as urlrequest
from urllib.error import HTTPError, URLError

from sqlalchemy.orm import Session

from .corpus_db import db_get_document, db_has_corpus, db_search
from .db import ROOT
import uuid as _uuid

from .models import AuditLog, CorpusDocument, Draft, DraftVersion, Thread, User
from .storage import default_bucket

log = logging.getLogger("cfc.agent.tools")

DOC_WORKER_URL = os.environ.get("DOC_WORKER_URL", "http://127.0.0.1:8100").rstrip("/")


@dataclass
class AgentContext:
    """Everything a tool needs to run: session + DB handle + draft + user."""

    session: Session
    user: User
    draft: Draft
    session_flags: dict[str, Any]  # from _session_for


# --------------------------------------------------------------------------- #
# Tool schema (OpenAI-style; adapted for Gemini in agent_llm)
# --------------------------------------------------------------------------- #

TOOL_SCHEMAS: list[dict[str, Any]] = [
    {
        "name": "cfc_search_corpus",
        "description": (
            "Search the QCI institutional corpus (past Work Orders, proposals, deliverables) "
            "for passages relevant to the query. Results are filtered by the caller's division."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "Natural-language search query."},
                "limit": {"type": "integer", "description": "Max hits (1-10).", "default": 5},
                "ministry": {"type": "string", "description": "Optional ministry filter."},
            },
            "required": ["query"],
        },
    },
    {
        "name": "cfc_get_document",
        "description": "Fetch the full text of one corpus document by its doc_id.",
        "parameters": {
            "type": "object",
            "properties": {"doc_id": {"type": "string"}},
            "required": ["doc_id"],
        },
    },
    {
        "name": "cfc_read_current_draft",
        "description": "Return the plain text of the current version of the draft being edited.",
        "parameters": {"type": "object", "properties": {}, "required": []},
    },
    {
        "name": "cfc_propose_insert",
        "description": (
            "Insert text into the draft. When position='end' it appends to the document. "
            "When position='after_match' the 'anchor' string is located and text is inserted "
            "after it. Creates a new draft version; the pre-mutation version stays intact."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "text": {"type": "string"},
                "position": {
                    "type": "string",
                    "enum": ["end", "after_match"],
                    "default": "end",
                },
                "anchor": {"type": "string", "description": "Required when position='after_match'."},
                "citation": {
                    "type": "string",
                    "description": "Optional citation label appended after the inserted text.",
                },
            },
            "required": ["text"],
        },
    },
    {
        "name": "cfc_propose_redline",
        "description": (
            "Propose a tracked-change-style redline as a review thread on this draft. "
            "Use this instead of cfc_propose_replace when the caller is an approver "
            "(L1/L2 reviewer) or when you want to leave a suggestion for the maker "
            "to accept rather than mutating the DOCX yourself. Threads show up in the "
            "ThreadsPanel and in the approver's inbox preview."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "passage": {
                    "type": "string",
                    "description": "Short verbatim excerpt from the draft that the suggestion targets.",
                },
                "suggestion": {
                    "type": "string",
                    "description": "The proposed replacement text OR the redline instruction.",
                },
                "rationale": {
                    "type": "string",
                    "description": "One-sentence 'why' (references corpus doc_id if applicable).",
                },
            },
            "required": ["passage", "suggestion"],
        },
    },
    {
        "name": "cfc_propose_replace",
        "description": (
            "Replace the first occurrence of 'find' with 'replace' in the current draft. "
            "Approver sessions record this as a tracked change."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "find": {"type": "string"},
                "replace": {"type": "string"},
            },
            "required": ["find", "replace"],
        },
    },
]


# --------------------------------------------------------------------------- #
# Tool implementations
# --------------------------------------------------------------------------- #

def _sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def _current_version_path(ctx: AgentContext) -> Path:
    v = next((x for x in ctx.draft.versions if x.version == ctx.draft.current_version), None)
    if not v:
        raise ToolError("current draft version missing")
    return default_bucket().get_path(v.storage_key)


def _read_draft_text(path: Path) -> str:
    try:
        import docx  # type: ignore
    except ImportError:
        return ""
    try:
        d = docx.Document(str(path))
        parts = [p.text.strip() for p in d.paragraphs if p.text and p.text.strip()]
        for table in d.tables:
            for row in table.rows:
                cells = [c.text.strip() for c in row.cells if c.text and c.text.strip()]
                if cells:
                    parts.append(" | ".join(cells))
        return "\n\n".join(parts)
    except Exception as e:  # noqa: BLE001
        raise ToolError(f"failed to read draft: {e}")


class ToolError(Exception):
    """Recoverable tool failure — surfaced to the LLM so it can adjust."""


def _python_docx_append(src: Path, dst: Path, blocks: list[str]) -> None:
    """Reliable insert-at-end path: copy source, then append paragraphs via python-docx.

    Used only when the SuperDoc SDK rejects the mutate op — keeps the agent
    demo unblocked without needing tracked-change support in the SDK path.
    """
    import shutil as _shutil

    import docx  # type: ignore

    _shutil.copy2(src, dst)
    d = docx.Document(str(dst))
    for block in blocks:
        for line in (block or "").split("\n"):
            d.add_paragraph(line)
    d.save(str(dst))


def _post_worker(path: str, payload: dict[str, Any]) -> dict[str, Any]:
    body = json.dumps(payload).encode("utf-8")
    req = urlrequest.Request(
        f"{DOC_WORKER_URL}{path}",
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urlrequest.urlopen(req, timeout=180) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except HTTPError as e:
        detail = e.read().decode("utf-8", errors="replace") if hasattr(e, "read") else ""
        raise ToolError(f"doc-worker HTTP {e.code}: {detail[:400]}") from e
    except URLError as e:
        raise ToolError(
            f"doc-worker unreachable at {DOC_WORKER_URL}: {e.reason}. "
            "Start with `npm run dev:doc-worker`."
        ) from e


def _new_version_path(ctx: AgentContext, next_version: int) -> tuple[str, Path]:
    key = f"drafts/{ctx.draft.id}/v{next_version}.docx"
    return key, default_bucket().get_path(key)


def _dispatch_mutate(
    ctx: AgentContext,
    ops: list[dict[str, Any]],
    trigger: str,
) -> dict[str, Any]:
    """Call doc-worker /internal/docx/mutate, save output as new draft_version."""
    if not ctx.session_flags.get("can_run_agent_mutate"):
        raise ToolError("this persona cannot mutate the draft in the current state")

    current_path = _current_version_path(ctx)
    next_v = ctx.draft.current_version + 1
    new_key, new_abs = _new_version_path(ctx, next_v)
    new_abs.parent.mkdir(parents=True, exist_ok=True)

    tracked = ctx.session_flags.get("agent_change_mode") == "tracked"
    payload = {
        "sourcePath": str(current_path),
        "outputPath": str(new_abs),
        "tracked": tracked,
        "ops": ops,
        "actorName": ctx.user.full_name,
        "actorEmail": ctx.user.email,
    }
    worker = _post_worker("/internal/docx/mutate", payload)
    if not worker.get("ok"):
        raise ToolError(f"doc-worker failed: {worker.get('error') or worker}")

    applied = worker.get("applied") or []
    ok_count = sum(1 for a in applied if a.get("ok"))
    fallback_notes: list[str] = []
    if applied and ok_count == 0:
        # Doc-worker (SuperDoc SDK) rejected everything. For insert_end we can
        # do a reliable python-docx append; for replace/insert-after we need the
        # SDK, so surface the failure so the agent can adjust.
        insert_end_ops = [
            a["op"] for a in applied
            if isinstance(a.get("op"), dict) and a["op"].get("kind") == "insert_end"
        ]
        if insert_end_ops and len(insert_end_ops) == len(applied):
            _python_docx_append(current_path, new_abs, [op["text"] for op in insert_end_ops])
            fallback_notes.append("insert_end via python-docx (SuperDoc SDK rejected)")
            worker["fallback_method"] = "python_docx_append"
            worker["applied"] = [{**a, "ok": True, "note": "python-docx fallback"} for a in applied]
        else:
            notes = "; ".join(a.get("note", "unknown") for a in applied)
            raise ToolError(f"all mutation ops failed at doc-worker: {notes}")

    if not new_abs.exists():
        raise ToolError(f"worker produced no output at {new_abs}")

    sha = _sha256_file(new_abs)
    ctx.session.add(
        DraftVersion(
            draft_id=ctx.draft.id,
            version=next_v,
            trigger=trigger,
            sha256=sha,
            storage_key=new_key,
            actor_employee_id=ctx.user.employee_id,
        )
    )
    ctx.draft.current_version = next_v
    ctx.session.add(
        AuditLog(
            actor_employee_id=ctx.user.employee_id,
            action=f"draft.agent.{trigger}",
            target_kind="draft",
            target_id=ctx.draft.id,
            division_code=ctx.draft.division_code,
            details={"version": next_v, "ops": ops, "tracked": tracked, "worker": worker.get("applied")},
        )
    )
    ctx.session.commit()
    return {
        "version": next_v,
        "tracked": tracked,
        "sha256": sha,
        "applied": worker.get("applied"),
        "fallback_saved": worker.get("fallbackSaved", False),
    }


# ------- callable tools -------

def cfc_search_corpus(ctx: AgentContext, query: str, limit: int = 5, ministry: str | None = None) -> dict[str, Any]:
    if not db_has_corpus(ctx.session):
        return {"hits": [], "note": "corpus empty; run `python -m app.ingest` first"}
    hits = db_search(
        ctx.session,
        query,
        user=ctx.user,
        limit=max(1, min(int(limit or 5), 10)),
        ministry=ministry,
    )
    return {"count": len(hits), "hits": hits}


def cfc_get_document(ctx: AgentContext, doc_id: str) -> dict[str, Any]:
    doc = db_get_document(ctx.session, doc_id, user=ctx.user)
    if not doc:
        raise ToolError(f"document not found (or not visible to your division): {doc_id}")
    return doc


def cfc_read_current_draft(ctx: AgentContext) -> dict[str, Any]:
    path = _current_version_path(ctx)
    text = _read_draft_text(path)
    return {"draft_id": ctx.draft.id, "version": ctx.draft.current_version, "text": text[:20000]}


def cfc_propose_insert(
    ctx: AgentContext,
    text: str,
    position: str = "end",
    anchor: str | None = None,
    citation: str | None = None,
) -> dict[str, Any]:
    if not text or not text.strip():
        raise ToolError("insert text is empty")
    payload_text = text if not citation else f"{text}\n\n[Source: {citation}]"
    if position == "after_match":
        if not anchor or not anchor.strip():
            raise ToolError("position=after_match requires an 'anchor' string")
        op = {"kind": "insert_after_match", "find": anchor, "text": payload_text}
    else:
        op = {"kind": "insert_end", "text": payload_text}
    result = _dispatch_mutate(ctx, [op], trigger="agent_insert")
    return {"ok": True, "position": position, **result}


def cfc_propose_redline(
    ctx: AgentContext,
    passage: str,
    suggestion: str,
    rationale: str = "",
) -> dict[str, Any]:
    """Create a tracked-change-style thread as a suggestion (no DOCX mutation)."""
    passage = (passage or "").strip()
    suggestion = (suggestion or "").strip()
    if not passage or not suggestion:
        raise ToolError("both 'passage' and 'suggestion' are required")

    body = (
        f"Suggested change:\n{suggestion}\n\n"
        f"Anchoring passage:\n{passage[:600]}"
        + (f"\n\nRationale: {rationale.strip()}" if rationale and rationale.strip() else "")
    )
    thread_id = f"redline-{_uuid.uuid4().hex[:12]}"
    thread = Thread(
        id=thread_id,
        draft_id=ctx.draft.id,
        division_code=ctx.draft.division_code,
        anchor={"passage": passage[:400]},
        body_snippet=body[:2000],
        author_employee_id=ctx.user.employee_id,
        kind="tracked_change",
        resolved=False,
        raw={"source": "agent.redline_extender", "rationale": rationale},
    )
    ctx.session.add(thread)
    ctx.session.add(
        AuditLog(
            actor_employee_id=ctx.user.employee_id,
            action="draft.agent.redline",
            target_kind="thread",
            target_id=thread_id,
            division_code=ctx.draft.division_code,
            details={"draft_id": ctx.draft.id, "passage_len": len(passage), "suggestion_len": len(suggestion)},
        )
    )
    ctx.session.commit()
    return {
        "ok": True,
        "thread_id": thread_id,
        "kind": "tracked_change",
        "passage_preview": passage[:120],
        "suggestion_preview": suggestion[:120],
    }


def cfc_propose_replace(ctx: AgentContext, find: str, replace: str) -> dict[str, Any]:
    if not find:
        raise ToolError("find is empty")
    op = {"kind": "replace_first", "find": find, "replace": replace}
    result = _dispatch_mutate(ctx, [op], trigger="agent_replace")
    return {"ok": True, **result}


# ------- dispatcher -------

_DISPATCH = {
    "cfc_search_corpus": cfc_search_corpus,
    "cfc_get_document": cfc_get_document,
    "cfc_read_current_draft": cfc_read_current_draft,
    "cfc_propose_insert": cfc_propose_insert,
    "cfc_propose_replace": cfc_propose_replace,
    "cfc_propose_redline": cfc_propose_redline,
}


import inspect as _inspect


def _filter_kwargs(fn: Callable, args: dict[str, Any]) -> tuple[dict[str, Any], list[str]]:
    sig = _inspect.signature(fn)
    accepted = {p.name for p in sig.parameters.values() if p.name != "ctx"}
    clean: dict[str, Any] = {}
    dropped: list[str] = []
    for k, v in (args or {}).items():
        if v is None:
            continue
        if k in accepted:
            clean[k] = v
        else:
            dropped.append(k)
    return clean, dropped


def dispatch(ctx: AgentContext, name: str, args: dict[str, Any]) -> dict[str, Any]:
    """Route a tool call to its impl. Never raises — returns {error: ...} on failure.

    Extra kwargs from the model are dropped with a warning so a mildly wrong
    tool call doesn't blow up the run.
    """
    fn = _DISPATCH.get(name)
    if not fn:
        return {"error": f"unknown tool: {name}", "hint": f"available: {sorted(_DISPATCH)}"}
    try:
        clean, dropped = _filter_kwargs(fn, args)
        out = fn(ctx, **clean)  # type: ignore[arg-type]
        if dropped and isinstance(out, dict):
            out.setdefault("_warnings", []).append(f"dropped unknown args: {dropped}")
        return out
    except ToolError as e:
        return {"error": str(e)}
    except TypeError as e:
        return {"error": f"bad arguments: {e}"}
    except Exception as e:  # noqa: BLE001
        log.exception("agent tool %s failed", name)
        return {"error": f"{type(e).__name__}: {e}"}
