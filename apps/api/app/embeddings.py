"""
Local, key-free embeddings via fastembed (ONNX, no torch).

Model: BAAI/bge-small-en-v1.5 — 384 dims, MiniLM-scale quality, ~30 MB.
Loaded once per process; first embed pays a one-time cold cost.

pgvector stores real Vector(384) columns on Postgres; on SQLite dev we
serialize as JSON-encoded floats in a LargeBinary column so the same
ingestion code path works in both worlds.
"""
from __future__ import annotations

import json
import logging
import os
from functools import lru_cache
from typing import Iterable, Sequence

log = logging.getLogger("cfc.embed")

EMBED_MODEL = os.environ.get("CFC_EMBED_MODEL", "BAAI/bge-small-en-v1.5")
EMBED_DIM = 384


@lru_cache(maxsize=1)
def _model():
    from fastembed import TextEmbedding  # noqa: PLC0415 — deferred import; heavy

    log.info("cfc embeddings: loading %s (first call is slow)", EMBED_MODEL)
    return TextEmbedding(EMBED_MODEL)


def embed_batch(texts: Sequence[str]) -> list[list[float]]:
    """Return a 384-dim embedding per input string. Empty strings -> zero vec."""
    if not texts:
        return []
    # Preserve empty inputs but skip them in the actual call to save time.
    idx_to_text: list[tuple[int, str]] = []
    out: list[list[float] | None] = [None] * len(texts)
    for i, t in enumerate(texts):
        if not t or not t.strip():
            out[i] = [0.0] * EMBED_DIM
        else:
            idx_to_text.append((i, t))
    if idx_to_text:
        vecs = list(_model().embed([t for _, t in idx_to_text]))
        for (i, _), v in zip(idx_to_text, vecs, strict=True):
            out[i] = [float(x) for x in v]
    return [v or [0.0] * EMBED_DIM for v in out]


def embed_one(text: str) -> list[float]:
    return embed_batch([text])[0]


# ---- storage adapters ---- #

def to_storage(vec: Iterable[float] | None, is_postgres: bool) -> object:
    """Convert a vector into what the ORM expects for the current backend."""
    if vec is None:
        return None
    if is_postgres:
        # pgvector.sqlalchemy.Vector accepts list[float]
        return list(vec)
    # SQLite: JSON in a bytes column
    return json.dumps(list(vec)).encode("utf-8")


def from_storage(raw: object, is_postgres: bool) -> list[float] | None:
    if raw is None:
        return None
    if is_postgres:
        # already list[float]-like
        return [float(x) for x in raw]  # type: ignore[arg-type]
    if isinstance(raw, (bytes, bytearray)):
        try:
            return [float(x) for x in json.loads(bytes(raw).decode("utf-8"))]
        except Exception:
            return None
    if isinstance(raw, str):
        try:
            return [float(x) for x in json.loads(raw)]
        except Exception:
            return None
    return None


def cosine(a: Sequence[float], b: Sequence[float]) -> float:
    """Cosine similarity for the SQLite fallback path (Postgres uses pgvector's <->)."""
    if not a or not b or len(a) != len(b):
        return 0.0
    dot = 0.0
    na = 0.0
    nb = 0.0
    for x, y in zip(a, b, strict=True):
        dot += x * y
        na += x * x
        nb += y * y
    if na == 0 or nb == 0:
        return 0.0
    return dot / ((na ** 0.5) * (nb ** 0.5))
