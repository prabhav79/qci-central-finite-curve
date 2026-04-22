"""GET /search — Interactive semantic search.

Supports filtering by ministry, value range, and date range.
"""
from __future__ import annotations

from typing import Any
from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel, Field
from sqlalchemy import text, select, func
from sqlalchemy.orm import Session

from backend.api.auth import get_current_session
from backend.db.session import get_db
from backend.db.models import Document
from backend.rag.retrieval import retrieve_chunks, RetrievedChunk

router = APIRouter(prefix="/search", tags=["search"])

class SearchResponse(BaseModel):
    results: list[RetrievedChunk]
    count: int

@router.get("", response_model=SearchResponse)
def get_search(
    q: str = Query(..., min_length=2),
    ministry: list[str] | None = Query(None),
    min_value: float | None = Query(None),
    max_value: float | None = Query(None),
    start_date: str | None = Query(None),
    end_date: str | None = Query(None),
    db: Session = Depends(get_db),
    _session: dict = Depends(get_current_session),
) -> SearchResponse:
    """Perform a semantic search with optional metadata filters."""
    results = retrieve_chunks(
        db,
        q,
        ministries=ministry,
        min_value=min_value,
        max_value=max_value,
        start_date=start_date,
        end_date=end_date,
    )
    return SearchResponse(results=results, count=len(results))

@router.get("/filters", tags=["meta"])
def get_search_filters(
    db: Session = Depends(get_db),
    _session: dict = Depends(get_current_session),
) -> dict[str, Any]:
    """Return unique values for populating UI filters (Ministries, Value Range)."""
    # Unique Ministries
    ministries = db.execute(
        select(Document.ministry)
        .where(Document.ministry.isnot(None))
        .distinct()
        .order_by(Document.ministry)
    ).scalars().all()

    # Value Stats
    stats = db.execute(
        text("SELECT MIN(value_inr), MAX(value_inr) FROM documents WHERE value_inr IS NOT NULL")
    ).fetchone()

    return {
        "ministries": list(ministries),
        "value_range": {
            "min": float(stats[0] or 0),
            "max": float(stats[1] or 0)
        }
    }
