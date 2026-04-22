"""POST /generate — the headline Phase 0 demo endpoint.

Flow:
1. User posts {prompt, doc_type}
2. Retrieve top-k chunks via pgvector
3. Call Gemini with the structured skeleton prompt
4. Persist the draft + sources in `generations`
5. Return {id, draft_md, sources, model_used, retrieval_count, retry_count}
"""
from __future__ import annotations

import logging
from typing import Any, Literal
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from backend.db.models import Generation
from backend.db.session import get_db
from backend.llm.generation import generate_draft
from backend.rag.retrieval import retrieve_chunks

log = logging.getLogger(__name__)

router = APIRouter(prefix="/generate", tags=["generate"])


DocType = Literal["work_order", "proposal"]


class GenerateRequest(BaseModel):
    prompt: str = Field(..., min_length=10, max_length=4000)
    doc_type: DocType = "work_order"
    top_k: int | None = Field(default=None, ge=1, le=20)


class SourceRef(BaseModel):
    doc_id: str
    document_id: str
    chunk_index: int
    similarity: float
    ministry: str | None = None
    project: str | None = None
    issued_on: str | None = None
    blob_key: str | None = None


class GenerateResponse(BaseModel):
    id: str
    doc_type: DocType
    draft_md: str
    sources: list[SourceRef]
    model_used: str
    retrieval_count: int
    retry_count: int


@router.post("", response_model=GenerateResponse)
def post_generate(
    body: GenerateRequest,
    db: Session = Depends(get_db),
) -> GenerateResponse:
    chunks = retrieve_chunks(db, body.prompt, top_k=body.top_k)
    if not chunks:
        raise HTTPException(
            status_code=404,
            detail="No documents retrieved for this prompt. Try a more specific query.",
        )

    result = generate_draft(
        query=body.prompt,
        doc_type=body.doc_type,
        chunks=chunks,
    )

    row = Generation(
        doc_type=body.doc_type,
        prompt=body.prompt,
        draft_md=result.draft_md,
        sources_json={
            "model_used": result.model_used,
            "retry_count": result.retry_count,
            "retrieval_count": len(chunks),
            "sources": result.sources,
        },
    )
    db.add(row)
    db.commit()
    db.refresh(row)

    return GenerateResponse(
        id=str(row.id),
        doc_type=body.doc_type,
        draft_md=result.draft_md,
        sources=[SourceRef(**s) for s in result.sources],
        model_used=result.model_used,
        retrieval_count=len(chunks),
        retry_count=result.retry_count,
    )


@router.get("/{generation_id}", response_model=GenerateResponse)
def get_generation(
    generation_id: UUID,
    db: Session = Depends(get_db),
) -> GenerateResponse:
    row = db.get(Generation, generation_id)
    if row is None:
        raise HTTPException(status_code=404, detail="generation not found")

    meta: dict[str, Any] = row.sources_json or {}
    return GenerateResponse(
        id=str(row.id),
        doc_type=row.doc_type,  # type: ignore[arg-type]
        draft_md=row.draft_md,
        sources=[SourceRef(**s) for s in meta.get("sources", [])],
        model_used=meta.get("model_used", "unknown"),
        retrieval_count=meta.get("retrieval_count", 0),
        retry_count=meta.get("retry_count", 0),
    )
