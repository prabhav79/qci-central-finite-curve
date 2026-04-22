"""RAG generation via Gemini Flash.

Flow:
1. Format retrieved chunks as a quoted context block with per-chunk [source:]
   anchors.
2. Build a two-part prompt: structural skeleton (see prompts.py) + context.
3. Call Gemini (temperature=0.2, model from settings — default
   `gemini-flash-latest` alias to avoid version drift).
4. Validate all required section headings appear. If not, one retry with an
   appended 'please include every required section' reminder.
5. Return (draft_md, sources[]) ready to persist in the `generations` table.
"""
from __future__ import annotations

import logging
import re
from dataclasses import dataclass
from typing import Any

from google import genai
from google.genai import types as genai_types
from tenacity import (
    retry,
    retry_if_exception,
    stop_after_attempt,
    wait_exponential,
)

from backend.config import get_settings
from backend.llm.embeddings import _client as _embeddings_client  # share Client instance
from backend.llm.prompts import DocType, build_system_prompt, build_user_prompt
from backend.rag.retrieval import RetrievedChunk

log = logging.getLogger(__name__)


@dataclass(slots=True)
class GenerationResult:
    draft_md: str
    sources: list[dict[str, Any]]  # serialisable for JSONB column
    model_used: str
    retry_count: int


def _is_retryable_gen(exc: BaseException) -> bool:
    name = type(exc).__name__
    if name in {"APIError", "ServerError", "ClientError"}:
        code = getattr(exc, "code", None) or getattr(exc, "status_code", None)
        if isinstance(code, int):
            return code == 429 or 500 <= code < 600
        msg = str(exc).lower()
        return "429" in msg or "unavailable" in msg or "internal" in msg
    return name in {"TimeoutError", "ConnectionError", "ReadTimeoutError"}


def _gemini_client() -> genai.Client:
    # Reuse the same cached Client instance used for embeddings.
    return _embeddings_client()


@retry(
    retry=retry_if_exception(_is_retryable_gen),
    stop=stop_after_attempt(4),
    wait=wait_exponential(multiplier=1, min=1, max=30),
    reraise=True,
)
def _call_gemini(system_prompt: str, user_prompt: str, model: str) -> str:
    resp = _gemini_client().models.generate_content(
        model=model,
        contents=user_prompt,
        config=genai_types.GenerateContentConfig(
            system_instruction=system_prompt,
            temperature=0.2,
            max_output_tokens=4096,
            response_mime_type="text/plain",
        ),
    )
    return (resp.text or "").strip()


# Required headings per doc_type — must be present in the output for it to validate.
_REQUIRED_HEADINGS: dict[DocType, list[str]] = {
    "work_order": [
        "## 1. Background",
        "## 2. Scope of Work",
        "## 3. Deliverables",
        "## 4. Timeline",
        "## 5. Payment Terms",
        "## 6. Conditions",
    ],
    "proposal": [
        "## 1. Executive Summary",
        "## 2. Problem Statement",
        "## 3. Proposed Approach",
        "## 4. Scope & Deliverables",
        "## 5. Timeline",
        "## 6. Commercials",
        "## 7. Why QCI",
    ],
}


def _missing_headings(draft: str, doc_type: DocType) -> list[str]:
    return [h for h in _REQUIRED_HEADINGS[doc_type] if h not in draft]


def _format_context(chunks: list[RetrievedChunk]) -> str:
    """One block per chunk: quoted, with [source: doc_id] anchor the model can cite."""
    if not chunks:
        return "(no relevant prior Work Orders or Proposals were retrieved)"
    parts: list[str] = []
    for c in chunks:
        header = f"[source: {c.doc_id}]"
        bits = []
        if c.ministry:
            bits.append(f"ministry={c.ministry}")
        if c.issued_on:
            bits.append(f"date={c.issued_on[:10]}")
        bits.append(f"similarity={c.similarity:.2f}")
        header = f"{header} ({', '.join(bits)})"
        parts.append(f"{header}\n> {c.text.strip()}")
    return "\n\n".join(parts)


def generate_draft(
    *,
    query: str,
    doc_type: DocType,
    chunks: list[RetrievedChunk],
    model: str | None = None,
) -> GenerationResult:
    settings = get_settings()
    model_name = model or settings.gemini_generation_model

    context_block = _format_context(chunks)
    system_prompt = build_system_prompt(doc_type)
    user_prompt = build_user_prompt(query, context_block)

    draft = _call_gemini(system_prompt, user_prompt, model_name)
    retry_count = 0

    missing = _missing_headings(draft, doc_type)
    if missing:
        retry_count = 1
        log.warning("Gemini omitted headings %s; retrying with stricter reminder", missing)
        stricter_system = system_prompt + (
            "\nREMINDER: Your previous draft OMITTED these sections: "
            + ", ".join(missing)
            + ". This time include EVERY section in the exact order shown in the skeleton."
        )
        draft = _call_gemini(stricter_system, user_prompt, model_name)

    # Normalise trailing whitespace, strip any stray ```markdown fences the model emits.
    draft = re.sub(r"^\s*```(?:markdown)?\s*\n", "", draft)
    draft = re.sub(r"\n\s*```\s*$", "", draft)
    draft = draft.strip()

    sources = [
        {
            "doc_id": c.doc_id,
            "document_id": str(c.document_id),
            "chunk_index": c.chunk_index,
            "similarity": round(c.similarity, 4),
            "ministry": c.ministry,
            "project": c.project,
            "issued_on": c.issued_on,
            "blob_key": c.blob_key,
        }
        for c in chunks
    ]

    return GenerationResult(
        draft_md=draft,
        sources=sources,
        model_used=model_name,
        retry_count=retry_count,
    )
