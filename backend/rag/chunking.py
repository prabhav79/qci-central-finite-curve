"""Text chunking for RAG.

Approach: paragraph-aware greedy packing. We avoid pulling in a real tokenizer
(tiktoken or the Gemini tokenizer) to keep the dependency footprint small and
avoid per-chunk API round-trips. English text averages ~4 chars/token, so:
- 500 tokens   ≈ 2000 chars
- 50  tokens   ≈  200 chars

Chunks are produced in reading order; overlap is taken from the tail of the
previous chunk so retrieval windows near chunk boundaries don't lose context.
"""
from __future__ import annotations

from dataclasses import dataclass

from backend.config import get_settings

CHARS_PER_TOKEN = 4


@dataclass(slots=True)
class Chunk:
    index: int
    text: str
    approx_tokens: int


def _paragraphs(text: str) -> list[str]:
    # Split on blank lines, then on single newlines if a paragraph is too long.
    paras: list[str] = []
    for block in text.split("\n\n"):
        block = block.strip()
        if not block:
            continue
        paras.append(block)
    return paras


def chunk_text(
    text: str,
    *,
    chunk_size_tokens: int | None = None,
    chunk_overlap_tokens: int | None = None,
) -> list[Chunk]:
    settings = get_settings()
    size_tokens = chunk_size_tokens or settings.chunk_size_tokens
    overlap_tokens = chunk_overlap_tokens or settings.chunk_overlap_tokens

    max_chars = size_tokens * CHARS_PER_TOKEN
    overlap_chars = overlap_tokens * CHARS_PER_TOKEN

    if not text or not text.strip():
        return []

    paras = _paragraphs(text)
    if not paras:
        return []

    chunks: list[Chunk] = []
    current = ""

    def flush():
        nonlocal current
        if not current.strip():
            return
        idx = len(chunks)
        chunks.append(
            Chunk(
                index=idx,
                text=current.strip(),
                approx_tokens=max(1, len(current) // CHARS_PER_TOKEN),
            )
        )
        # Seed the next chunk with the overlap tail for context continuity.
        tail = current[-overlap_chars:] if overlap_chars > 0 else ""
        current = tail

    for p in paras:
        # Very long paragraphs (scanned OCR blobs) get hard-split to stay under max_chars.
        if len(p) > max_chars:
            start = 0
            while start < len(p):
                slice_ = p[start : start + max_chars]
                if len(current) + len(slice_) + 1 > max_chars:
                    flush()
                current = (current + "\n\n" + slice_).strip() if current else slice_
                if len(current) >= max_chars:
                    flush()
                start += max_chars
            continue

        if len(current) + len(p) + 2 > max_chars:
            flush()
        current = (current + "\n\n" + p) if current else p

    flush()
    return chunks
