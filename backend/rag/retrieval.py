"""Retrieval layer.

Given a user prompt, produce the top-k most relevant document chunks (plus
metadata for citation) using pgvector cosine similarity.

Used by:
- `backend/llm/generation.py` — RAG generation (QCI-7 / 0.6)
- `backend/api/search.py` — interactive search (QCI-6 / 0.5)
"""
from __future__ import annotations

from dataclasses import dataclass
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from backend.config import get_settings
from backend.llm.embeddings import embed_query


@dataclass(slots=True)
class RetrievedChunk:
    document_id: UUID
    doc_id: str
    chunk_index: int
    text: str
    similarity: float  # cosine similarity in [0, 1]; higher = more relevant
    ministry: str | None
    project: str | None
    issued_on: str | None  # ISO date
    blob_key: str | None


def retrieve_chunks(
    db: Session,
    query: str,
    *,
    top_k: int | None = None,
    max_unique_docs: int = 5,
) -> list[RetrievedChunk]:
    """Top-k nearest chunks, then dedupe so no single doc dominates the context.

    pgvector's cosine distance operator is `<=>`; distance is in [0, 2] and
    cosine similarity is `1 - (distance / 2)`. We return similarity because
    users expect "higher is better".
    """
    k = top_k or get_settings().retrieval_top_k

    query_vec = embed_query(query)

    # Fetch a few more than top_k so we still have something after per-doc dedup.
    sql = text(
        """
        SELECT c.document_id,
               d.doc_id,
               c.chunk_index,
               c.text,
               (c.embedding <=> cast(:qv as vector)) AS distance,
               d.ministry,
               d.project,
               d.issued_on,
               d.blob_key
        FROM document_chunks c
        JOIN documents d ON d.id = c.document_id
        WHERE c.embedding IS NOT NULL
          AND d.status = 'ready'
        ORDER BY c.embedding <=> cast(:qv as vector)
        LIMIT :limit
        """
    )
    rows = db.execute(sql, {"qv": str(query_vec), "limit": k * 3}).fetchall()

    out: list[RetrievedChunk] = []
    per_doc_count: dict[UUID, int] = {}
    for r in rows:
        # Greedy per-doc cap so the prompt shows variety across sources.
        # Each doc contributes at most 2 chunks; stop entirely once we have
        # max_unique_docs distinct sources.
        seen_docs = len(per_doc_count)
        count_for_this_doc = per_doc_count.get(r.document_id, 0)
        if r.document_id not in per_doc_count and seen_docs >= max_unique_docs:
            continue
        if count_for_this_doc >= 2:
            continue

        similarity = max(0.0, 1.0 - float(r.distance) / 2.0)
        out.append(
            RetrievedChunk(
                document_id=r.document_id,
                doc_id=r.doc_id,
                chunk_index=r.chunk_index,
                text=r.text,
                similarity=similarity,
                ministry=r.ministry,
                project=r.project,
                issued_on=r.issued_on.isoformat() if r.issued_on else None,
                blob_key=r.blob_key,
            )
        )
        per_doc_count[r.document_id] = count_for_this_doc + 1
        if len(out) >= k:
            break

    return out
