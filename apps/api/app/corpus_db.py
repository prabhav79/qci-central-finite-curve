"""
DB-backed corpus retrieval with ACL filter + section-label boost.

Postgres: pgvector cosine (<=>) as the primary rank, keyword contains as a
second-pass boost, section-label match as a third boost.

SQLite dev: fetch a filtered candidate pool with a LIKE prefilter then
score in Python (cosine on the JSON-serialized embeddings + keyword +
section-label). Same shape output as the in-memory corpus.

ACL rule (project-cfc-visibility-rule): non-apex, non-admin callers see
only chunks whose division_code == user.division_code.
"""
from __future__ import annotations

import re
from typing import Any

from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session, selectinload

from .chunking import tokens
from .db import IS_POSTGRES
from .embeddings import cosine, embed_one, from_storage
from .models import CorpusChunk, CorpusDocument, User

# Section keywords that pull a query toward a labeled section.
_SECTION_TRIGGERS: list[tuple[str, re.Pattern[str]]] = [
    ("payment_milestones", re.compile(r"payment|milestone|financial|fee|cost|invoice|budget", re.I)),
    ("deliverables", re.compile(r"deliverable|output|outcome", re.I)),
    ("duration", re.compile(r"duration|period|tenure|timeline|start|end|extension", re.I)),
    ("composition_manpower", re.compile(r"manpower|composition|team|resource\s+person|staff", re.I)),
    ("scope_of_work", re.compile(r"scope|terms?\s+of\s+reference|objective|task", re.I)),
    ("general_terms", re.compile(r"terms|conditions?|indemnity|confidentialit|terminat", re.I)),
]


def _section_hint(query: str) -> str | None:
    for label, pat in _SECTION_TRIGGERS:
        if pat.search(query):
            return label
    return None


def _apply_acl(stmt, user: User | None):
    if user is None:
        return stmt
    if user.cfc_role == "apex" or user.is_admin:
        return stmt
    return stmt.where(CorpusChunk.division_code == user.division_code)


def db_has_corpus(s: Session) -> bool:
    return bool(s.scalar(select(func.count(CorpusChunk.id))))


def db_stats(s: Session) -> dict[str, Any]:
    total_docs = int(s.scalar(select(func.count(CorpusDocument.id))) or 0)
    total_chunks = int(s.scalar(select(func.count(CorpusChunk.id))) or 0)
    by_kind_rows = s.execute(
        select(CorpusDocument.kind, func.count(CorpusDocument.id)).group_by(CorpusDocument.kind)
    ).all()
    ministries = [
        r[0]
        for r in s.execute(select(CorpusDocument.ministry).distinct().order_by(CorpusDocument.ministry)).all()
        if r[0]
    ]
    return {
        "documents": total_docs,
        "chunks": total_chunks,
        "by_kind": {str(k or "unknown"): int(n) for k, n in by_kind_rows},
        "ministries": ministries[:40],
        "ministry_count": len(ministries),
        "backend": "db",
    }


def db_list_documents(s: Session, limit: int = 300, user: User | None = None) -> list[dict[str, Any]]:
    stmt = select(CorpusDocument).order_by(CorpusDocument.updated_at.desc()).limit(limit)
    if user is not None and user.cfc_role != "apex" and not user.is_admin:
        stmt = stmt.where(CorpusDocument.division_code == user.division_code)
    docs = s.execute(stmt).scalars().all()
    return [
        {
            "doc_id": d.doc_id,
            "title": d.title,
            "ministry": d.ministry,
            "date": d.date,
            "domains": d.domains or [],
            "value_inr": d.value_inr,
            "path": d.source_path,
            "kind": d.kind,
            "division_code": d.division_code,
        }
        for d in docs
    ]


def db_get_document(s: Session, doc_id: str, user: User | None = None) -> dict[str, Any] | None:
    stmt = select(CorpusDocument).where(CorpusDocument.doc_id == doc_id)
    if user is not None and user.cfc_role != "apex" and not user.is_admin:
        stmt = stmt.where(CorpusDocument.division_code == user.division_code)
    d = s.execute(stmt).scalar_one_or_none()
    if not d:
        return None
    return {
        "doc_id": d.doc_id,
        "title": d.title,
        "ministry": d.ministry,
        "date": d.date,
        "domains": d.domains or [],
        "deliverables": d.deliverables or "",
        "full_text": d.full_text or "",
        "value_inr": d.value_inr,
        "path": d.source_path,
        "kind": d.kind,
        "division_code": d.division_code,
    }


def db_document_outline(s: Session, doc_id: str, user: User | None = None) -> list[tuple[str, str]] | None:
    """Distinct section labels present in a document's chunks, in first-appearance
    order — used when a user picks an EXISTING corpus document as their new
    draft's structural template. Only the document's section shape is reused
    (which of the standard labels it touches, and in what order); none of its
    actual paragraph text is copied — the new draft is generated fresh against
    this outline. Returns None if the document isn't found/visible or has no
    labeled chunks (caller falls back to a default outline)."""
    from .agent_presets import SECTION_TITLES  # local import: avoid a module-load cycle

    stmt = select(CorpusDocument).where(CorpusDocument.doc_id == doc_id)
    if user is not None and user.cfc_role != "apex" and not user.is_admin:
        stmt = stmt.where(CorpusDocument.division_code == user.division_code)
    doc = s.execute(stmt).scalar_one_or_none()
    if not doc:
        return None
    labels = s.execute(
        select(CorpusChunk.section_label)
        .where(CorpusChunk.document_id == doc.id)
        .order_by(CorpusChunk.chunk_index)
    ).scalars().all()
    seen: list[str] = []
    for label in labels:
        if label and label not in seen:
            seen.append(label)
    if not seen:
        return None
    return [(label, SECTION_TITLES.get(label, label.replace("_", " ").title())) for label in seen]


def _chunk_to_hit(chunk: CorpusChunk, score: float) -> dict[str, Any]:
    doc = chunk.document
    return {
        "chunk_id": f"{doc.doc_id}::c{chunk.chunk_index}",
        "doc_id": doc.doc_id,
        "title": doc.title,
        "ministry": doc.ministry,
        "date": doc.date,
        "domains": doc.domains or [],
        "value_inr": doc.value_inr,
        "text": chunk.text,
        "source": doc.source_path,
        "kind": doc.kind,
        "section_label": chunk.section_label,
        "division_code": chunk.division_code,
        "score": round(float(score), 4),
    }


def _keyword_boost(text: str, q_tokens: set[str], q_lower: str) -> float:
    if not text:
        return 0.0
    text_l = text.lower()
    score = 0.0
    for tok in q_tokens:
        if tok and tok in text_l:
            score += 0.6
    if q_lower and q_lower in text_l:
        score += 1.0
    return score


def db_search_postgres(
    s: Session,
    query: str,
    *,
    user: User | None,
    limit: int,
    ministry: str | None,
    domain: str | None,
    section_label: str | None,
) -> list[dict[str, Any]]:
    # pgvector cosine distance operator is `<=>`; use raw SQL through SQLAlchemy.
    qvec = embed_one(query)

    # Overfetch candidates so keyword + section boosts have room to rerank.
    pool_size = max(limit * 6, 30)
    stmt = (
        select(CorpusChunk, CorpusChunk.embedding.cosine_distance(qvec).label("distance"))
        .join(CorpusDocument, CorpusChunk.document_id == CorpusDocument.id)
        .options(selectinload(CorpusChunk.document))
        .order_by("distance")
        .limit(pool_size)
    )
    stmt = _apply_acl(stmt, user)
    if ministry:
        stmt = stmt.where(CorpusDocument.ministry.ilike(f"%{ministry}%"))
    # domain filter via JSON contains — Postgres jsonb `?|` array-contains.
    # For MVP just filter in Python from the pool.
    rows = s.execute(stmt).all()
    q_tokens = {t for t in tokens(query) if len(t) > 2}
    q_lower = query.lower()

    scored: list[tuple[float, CorpusChunk]] = []
    for chunk, distance in rows:
        base = 1.0 - float(distance)  # cosine distance → similarity
        boost = _keyword_boost(chunk.text, q_tokens, q_lower)
        if section_label and chunk.section_label == section_label:
            boost += 1.2
        if domain and not any(domain.lower() in (d or "").lower() for d in (chunk.document.domains or [])):
            continue
        scored.append((base + boost, chunk))

    scored.sort(key=lambda x: x[0], reverse=True)
    return [_chunk_to_hit(c, sc) for sc, c in scored[: max(1, min(limit, 25))]]


def db_search_sqlite(
    s: Session,
    query: str,
    *,
    user: User | None,
    limit: int,
    ministry: str | None,
    domain: str | None,
    section_label: str | None,
) -> list[dict[str, Any]]:
    # No pgvector — pull a keyword-filtered candidate pool then score in Python.
    q_tokens = {t for t in tokens(query) if len(t) > 2}
    q_lower = query.lower()

    likes = [CorpusChunk.text.ilike(f"%{tok}%") for tok in q_tokens][:8]
    if not likes:
        likes = [CorpusChunk.text.ilike(f"%{q_lower}%")]

    stmt = (
        select(CorpusChunk)
        .join(CorpusDocument, CorpusChunk.document_id == CorpusDocument.id)
        .options(selectinload(CorpusChunk.document))
        .where(or_(*likes))
        .limit(max(limit * 8, 60))
    )
    stmt = _apply_acl(stmt, user)
    if ministry:
        stmt = stmt.where(CorpusDocument.ministry.ilike(f"%{ministry}%"))
    candidates = s.execute(stmt).scalars().all()

    qvec = embed_one(query) if candidates else []
    scored: list[tuple[float, CorpusChunk]] = []
    for chunk in candidates:
        if domain and not any(domain.lower() in (d or "").lower() for d in (chunk.document.domains or [])):
            continue
        vec = from_storage(chunk.embedding, IS_POSTGRES)
        base = cosine(qvec, vec) if vec else 0.0
        boost = _keyword_boost(chunk.text, q_tokens, q_lower)
        if section_label and chunk.section_label == section_label:
            boost += 1.2
        scored.append((base + boost, chunk))

    scored.sort(key=lambda x: x[0], reverse=True)
    return [_chunk_to_hit(c, sc) for sc, c in scored[: max(1, min(limit, 25))]]


def db_search(
    s: Session,
    query: str,
    *,
    user: User | None = None,
    limit: int = 8,
    ministry: str | None = None,
    domain: str | None = None,
) -> list[dict[str, Any]]:
    q = (query or "").strip()
    if not q:
        return []
    section = _section_hint(q)
    if IS_POSTGRES:
        return db_search_postgres(
            s, q, user=user, limit=limit, ministry=ministry, domain=domain, section_label=section
        )
    return db_search_sqlite(
        s, q, user=user, limit=limit, ministry=ministry, domain=domain, section_label=section
    )
