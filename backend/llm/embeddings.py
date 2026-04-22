"""Gemini embeddings wrapper.

Uses the new `google-genai` SDK (not the deprecated `google-generativeai`).
`text-embedding-004` returns 768-dim vectors — matches `document_chunks.embedding vector(768)`.

Retry strategy:
- 429 / 5xx / transient network errors: exponential backoff, max 6 attempts
- All other errors raise immediately (invalid API key, malformed input, etc.)

Batch size is bounded below Gemini's per-request cap so a seed run of many
chunks doesn't blow through the free-tier RPM limit in one go.
"""
from __future__ import annotations

import logging
from functools import lru_cache

from google import genai
from google.genai import types as genai_types
from tenacity import (
    retry,
    retry_if_exception,
    stop_after_attempt,
    wait_exponential,
)

from backend.config import get_settings

log = logging.getLogger(__name__)

# Gemini accepts up to 100 embedding inputs per request; keep a safety margin.
_MAX_BATCH = 50
EMBEDDING_DIM = 768


@lru_cache(maxsize=1)
def _client() -> genai.Client:
    return genai.Client(api_key=get_settings().gemini_api_key)


class EmbeddingError(RuntimeError):
    """Raised when Gemini returns an unusable response after all retries."""


def _is_retryable(exc: BaseException) -> bool:
    # google-genai raises errors.APIError for upstream failures; we retry on 429/5xx.
    name = type(exc).__name__
    if name in {"APIError", "ServerError", "ClientError"}:
        status = getattr(exc, "code", None) or getattr(exc, "status_code", None)
        if isinstance(status, int):
            return status == 429 or 500 <= status < 600
        # Some SDK versions encode the code in the message
        msg = str(exc).lower()
        return "429" in msg or "unavailable" in msg or "internal" in msg
    # Also retry on common network failures
    return name in {"TimeoutError", "ConnectionError", "ReadTimeoutError"}


@retry(
    retry=retry_if_exception(_is_retryable),
    stop=stop_after_attempt(6),
    wait=wait_exponential(multiplier=1, min=1, max=30),
    reraise=True,
)
def _embed_one_batch(texts: list[str]) -> list[list[float]]:
    settings = get_settings()
    resp = _client().models.embed_content(
        model=settings.gemini_embedding_model,
        contents=texts,
        config=genai_types.EmbedContentConfig(task_type="RETRIEVAL_DOCUMENT"),
    )

    if not resp.embeddings or len(resp.embeddings) != len(texts):
        raise EmbeddingError(
            f"Gemini returned {len(resp.embeddings or [])} embeddings for {len(texts)} inputs"
        )

    vectors: list[list[float]] = []
    for e in resp.embeddings:
        values = list(e.values)
        if len(values) != EMBEDDING_DIM:
            raise EmbeddingError(f"Expected {EMBEDDING_DIM}-dim vector, got {len(values)}")
        vectors.append(values)
    return vectors


def embed_texts(texts: list[str]) -> list[list[float]]:
    """Embed a list of strings; splits into safe-size batches automatically."""
    if not texts:
        return []
    out: list[list[float]] = []
    for i in range(0, len(texts), _MAX_BATCH):
        batch = texts[i : i + _MAX_BATCH]
        out.extend(_embed_one_batch(batch))
    return out


def embed_query(text: str) -> list[float]:
    """Embed a single user query. Uses RETRIEVAL_QUERY task type for asymmetric retrieval."""
    resp = _client().models.embed_content(
        model=get_settings().gemini_embedding_model,
        contents=text,
        config=genai_types.EmbedContentConfig(task_type="RETRIEVAL_QUERY"),
    )
    if not resp.embeddings:
        raise EmbeddingError("Gemini returned no embedding for the query")
    return list(resp.embeddings[0].values)
