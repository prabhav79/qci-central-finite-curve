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
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session, selectinload

from .chunking import tokens
from .db import IS_POSTGRES
from .embeddings import cosine, embed_one, from_storage
from .models import CorpusChunk, CorpusDocument, CorpusEdge, User

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


_DATE_FORMATS = ("%Y-%m-%d", "%d-%m-%Y", "%d/%m/%Y", "%Y/%m/%d", "%d %B %Y", "%B %d, %Y", "%Y")


def _recency_boost(date_str: str | None) -> float:
    """Small bonus favoring more recent documents among otherwise-similar hits.

    CorpusDocument.date is free-text and only populated for some ingestion
    kinds (see ingest.py) — this is a soft tie-breaker, not a hard sort key,
    and degrades to 0 for anything missing/unparseable rather than erroring.
    Capped well below the keyword/section boosts (~0.6-1.2 each) so recency
    nudges between similarly-relevant hits without overriding real relevance.
    """
    if not date_str:
        return 0.0
    parsed = None
    for fmt in _DATE_FORMATS:
        try:
            parsed = datetime.strptime(date_str.strip(), fmt).date()
            break
        except ValueError:
            continue
    if not parsed:
        return 0.0
    days_old = (datetime.now(timezone.utc).date() - parsed).days
    if days_old < 0:
        return 0.0
    return max(0.0, 0.5 - (days_old / 3650) * 0.5)  # linear decay to 0 over ~10 years


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
        boost += _recency_boost(chunk.document.date)
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
        boost += _recency_boost(chunk.document.date)
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


# --------------------------------------------------------------------------- #
# Knowledge graph (item 7) — corpus_edges computation + lazy children query.
#
# Same dual-path convention as db_search_postgres/db_search_sqlite above:
# pgvector's `<=>` cosine-distance operator does the ranking on Postgres,
# a Python-side cosine fallback does the same job on SQLite. Document-to-
# document similarity is computed from each document's *centroid* — the
# mean of its own chunk embeddings — compared against every OTHER
# document's chunks (best/closest chunk match = that document's score).
# This is still "chunk-embedding cosine similarity," just aggregated to
# document level so a 40-page doc and a 2-page doc compare fairly.
# --------------------------------------------------------------------------- #

def _document_row_id(s: Session, doc_id: str) -> int | None:
    return s.execute(select(CorpusDocument.id).where(CorpusDocument.doc_id == doc_id)).scalar_one_or_none()


def _centroid_of(vectors: list[list[float]]) -> list[float] | None:
    if not vectors:
        return None
    dim = len(vectors[0])
    sums = [0.0] * dim
    n = 0
    for v in vectors:
        if len(v) != dim:
            continue
        for i, x in enumerate(v):
            sums[i] += x
        n += 1
    if n == 0:
        return None
    return [x / n for x in sums]


def _document_centroid(s: Session, document_row_id: int) -> list[float] | None:
    rows = s.execute(
        select(CorpusChunk.embedding).where(CorpusChunk.document_id == document_row_id)
    ).scalars().all()
    if IS_POSTGRES:
        vecs = [list(v) for v in rows if v is not None]
    else:
        vecs = [v for v in (from_storage(r, IS_POSTGRES) for r in rows) if v]
    return _centroid_of(vecs)


def _nearest_documents_postgres(
    s: Session, centroid: list[float], *, exclude_row_id: int, k: int
) -> list[tuple[int, float]]:
    """Best (max-similarity) chunk per OTHER document, top-k documents, via
    pgvector's `<=>` operator — same API as db_search_postgres above."""
    stmt = (
        select(CorpusChunk.document_id, func.min(CorpusChunk.embedding.cosine_distance(centroid)).label("distance"))
        .where(CorpusChunk.document_id != exclude_row_id)
        .group_by(CorpusChunk.document_id)
        .order_by("distance")
        .limit(k)
    )
    rows = s.execute(stmt).all()
    return [(doc_row_id, 1.0 - float(distance)) for doc_row_id, distance in rows]


def _nearest_documents_sqlite(
    s: Session, centroid: list[float], *, exclude_row_id: int, k: int
) -> list[tuple[int, float]]:
    """Python-side cosine fallback — same shape as db_search_sqlite above.
    Bounded by the current corpus size (all non-source chunks fetched once)."""
    rows = s.execute(
        select(CorpusChunk.document_id, CorpusChunk.embedding).where(CorpusChunk.document_id != exclude_row_id)
    ).all()
    best: dict[int, float] = {}
    for document_id, raw_embedding in rows:
        vec = from_storage(raw_embedding, IS_POSTGRES)
        if not vec:
            continue
        sim = cosine(centroid, vec)
        if sim > best.get(document_id, -1.0):
            best[document_id] = sim
    ranked = sorted(best.items(), key=lambda kv: kv[1], reverse=True)
    return ranked[:k]


def _upsert_edge(s: Session, doc_id_x: str, doc_id_y: str, weight: float) -> None:
    """Unordered-pair upsert: doc_id_a < doc_id_b is enforced here (not a DB
    CHECK) so this works unchanged on SQLite and Postgres."""
    if doc_id_x == doc_id_y:
        return
    doc_id_a, doc_id_b = (doc_id_x, doc_id_y) if doc_id_x < doc_id_y else (doc_id_y, doc_id_x)
    existing = s.execute(
        select(CorpusEdge).where(CorpusEdge.doc_id_a == doc_id_a, CorpusEdge.doc_id_b == doc_id_b)
    ).scalar_one_or_none()
    now = datetime.now(timezone.utc)
    if existing:
        existing.weight = float(weight)
        existing.updated_at = now
    else:
        s.add(CorpusEdge(doc_id_a=doc_id_a, doc_id_b=doc_id_b, weight=float(weight), updated_at=now))


def compute_edges_for_document(s: Session, doc_id: str, k: int = 8) -> int:
    """Top-k nearest OTHER documents by chunk-embedding cosine similarity,
    upserted into corpus_edges. Returns the number of edges upserted (0 if
    the document has no chunks yet, or no other document to compare against).

    Caller commits — this only mutates the session (it does call flush(),
    same as _upsert_doc's need for row.id below), matching ingest.py's
    _upsert_doc/_build_chunks convention. The flush matters here because
    SessionLocal is autoflush=False: without it, a full recompute processing
    document B right after document A would not see the (A, B) edge A's own
    pass already added, and would try to insert a duplicate pair."""
    row_id = _document_row_id(s, doc_id)
    if row_id is None:
        return 0
    centroid = _document_centroid(s, row_id)
    if not centroid:
        return 0

    if IS_POSTGRES:
        neighbors = _nearest_documents_postgres(s, centroid, exclude_row_id=row_id, k=k)
    else:
        neighbors = _nearest_documents_sqlite(s, centroid, exclude_row_id=row_id, k=k)
    if not neighbors:
        return 0

    other_ids = [n[0] for n in neighbors]
    id_to_doc_id = dict(
        s.execute(select(CorpusDocument.id, CorpusDocument.doc_id).where(CorpusDocument.id.in_(other_ids))).all()
    )
    n = 0
    for other_row_id, sim in neighbors:
        other_doc_id = id_to_doc_id.get(other_row_id)
        if not other_doc_id:
            continue
        _upsert_edge(s, doc_id, other_doc_id, sim)
        n += 1
    s.flush()
    return n


def recompute_all_edges(s: Session, k: int = 8) -> dict[str, int]:
    """Full drift-correction recompute — every document vs. every other,
    top-k each. Bounded/reasonable at the current ~49-doc corpus size (see
    plan item 7); becomes an admin-triggered background job if the corpus
    grows large enough for this to matter. Caller commits."""
    doc_ids = s.execute(select(CorpusDocument.doc_id).order_by(CorpusDocument.doc_id)).scalars().all()
    total_edges = 0
    for doc_id in doc_ids:
        total_edges += compute_edges_for_document(s, doc_id, k=k)
    return {"documents": len(doc_ids), "edges_upserted": total_edges}


# --------------------------------------------------------------------------- #
# Knowledge graph — lazy GET /corpus/graph/children levels.
#
# Node id scheme (frozen contract): "ministry:<ministry>",
# "domain:<ministry>::<domain>", "doc:<doc_id>". ACL reuses the exact
# division-scoping predicate db_list_documents/db_get_document already use
# above (apex + admin see every division; everyone else sees only their own).
# --------------------------------------------------------------------------- #

def _acl_documents_stmt(user: User | None):
    stmt = select(CorpusDocument)
    if user is not None and user.cfc_role != "apex" and not user.is_admin:
        stmt = stmt.where(CorpusDocument.division_code == user.division_code)
    return stmt


def _ministry_key(ministry: str | None) -> str:
    return (ministry or "").strip() or "Unknown"


def _doc_domains(doc: CorpusDocument) -> list[str]:
    doms = [d for d in (doc.domains or []) if d and d.strip()]
    return doms or ["Unclassified"]


def graph_children_root(s: Session, *, user: User | None) -> list[dict[str, Any]]:
    docs = s.execute(_acl_documents_stmt(user)).scalars().all()
    buckets: dict[str, int] = {}
    for d in docs:
        key = _ministry_key(d.ministry)
        buckets[key] = buckets.get(key, 0) + 1
    return [
        {"id": f"ministry:{name}", "label": name, "type": "ministry", "count": cnt, "doc_id": None, "kind": None, "weight": None}
        for name, cnt in sorted(buckets.items(), key=lambda kv: kv[0].lower())
    ]


def graph_children_domains(s: Session, ministry_name: str, *, user: User | None) -> list[dict[str, Any]]:
    docs = s.execute(_acl_documents_stmt(user)).scalars().all()
    buckets: dict[str, int] = {}
    for d in docs:
        if _ministry_key(d.ministry) != ministry_name:
            continue
        for dm in _doc_domains(d):
            buckets[dm] = buckets.get(dm, 0) + 1
    return [
        {
            "id": f"domain:{ministry_name}::{name}",
            "label": name,
            "type": "domain",
            "count": cnt,
            "doc_id": None,
            "kind": None,
            "weight": None,
        }
        for name, cnt in sorted(buckets.items(), key=lambda kv: kv[0].lower())
    ]


def graph_children_documents(s: Session, ministry_name: str, domain_name: str, *, user: User | None) -> list[dict[str, Any]]:
    docs = s.execute(_acl_documents_stmt(user)).scalars().all()
    matches = [
        d for d in docs
        if _ministry_key(d.ministry) == ministry_name and domain_name in _doc_domains(d)
    ]
    matches.sort(key=lambda d: (d.title or "").lower())
    return [
        {"id": f"doc:{d.doc_id}", "label": d.title, "type": "document", "count": None, "doc_id": d.doc_id, "kind": d.kind, "weight": None}
        for d in matches
    ]


def graph_children_related(s: Session, doc_id: str, *, user: User | None) -> list[dict[str, Any]]:
    # Source document must itself be ACL-visible; otherwise reveal nothing.
    source = s.execute(_acl_documents_stmt(user).where(CorpusDocument.doc_id == doc_id)).scalar_one_or_none()
    if source is None:
        return []
    edges = s.execute(
        select(CorpusEdge).where(or_(CorpusEdge.doc_id_a == doc_id, CorpusEdge.doc_id_b == doc_id))
    ).scalars().all()
    if not edges:
        return []
    other_ids = [(e.doc_id_b if e.doc_id_a == doc_id else e.doc_id_a) for e in edges]
    weight_by_other = {(e.doc_id_b if e.doc_id_a == doc_id else e.doc_id_a): e.weight for e in edges}
    other_docs = s.execute(_acl_documents_stmt(user).where(CorpusDocument.doc_id.in_(other_ids))).scalars().all()
    nodes = [
        {
            "id": f"doc:{d.doc_id}",
            "label": d.title,
            "type": "document",
            "count": None,
            "doc_id": d.doc_id,
            "kind": d.kind,
            "weight": round(float(weight_by_other[d.doc_id]), 4),
        }
        for d in other_docs
        if d.doc_id in weight_by_other
    ]
    nodes.sort(key=lambda n: n["weight"], reverse=True)
    return nodes


def graph_children(s: Session, parent: str | None, *, user: User | None) -> list[dict[str, Any]]:
    """Dispatch one level of the lazy children tree per the frozen node-id
    scheme. Unrecognized/malformed parent ids resolve to an empty list
    rather than erroring, so a stale frontend node never 500s the API."""
    p = (parent or "").strip()
    if not p:
        return graph_children_root(s, user=user)
    if p.startswith("ministry:"):
        return graph_children_domains(s, p[len("ministry:") :], user=user)
    if p.startswith("domain:"):
        rest = p[len("domain:") :]
        ministry_name, sep, domain_name = rest.partition("::")
        if not sep:
            return []
        return graph_children_documents(s, ministry_name, domain_name, user=user)
    if p.startswith("doc:"):
        return graph_children_related(s, p[len("doc:") :], user=user)
    return []
