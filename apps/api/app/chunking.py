"""
Section-labeled chunker tuned for QCI Work Orders + Proposals.

Sliding-window over raw text alone makes a query for "payment schedule"
score the payment section the same as the cover boilerplate — chunks
labeled by section fix that: retrieval reranks by section-label match.

Labels are recognized from QCI's real heading patterns. See
project-cfc-sequencing-plan for the design constraint.
"""
from __future__ import annotations

import re
from dataclasses import dataclass

CHUNK_SIZE = 700
CHUNK_OVERLAP = 120

# Ordered so more-specific labels win the first regex match.
_SECTION_PATTERNS: list[tuple[str, re.Pattern[str]]] = [
    (
        "payment_milestones",
        re.compile(
            r"(payment\s+(?:milestone|schedule|terms?)|financial\s+terms?|milestone\s+payment|fee\s+schedule)",
            re.I,
        ),
    ),
    (
        "deliverables",
        re.compile(r"(deliverables?|outputs?|expected\s+outcomes?|key\s+deliverables?)", re.I),
    ),
    (
        "duration",
        re.compile(
            r"(duration|period\s+of\s+(?:contract|engagement|work)|contract\s+period|proposed\s+duration|tenure|timeline)",
            re.I,
        ),
    ),
    (
        "composition_manpower",
        re.compile(
            r"(composition[,\s]*manpower|manpower(?:\s+and\s+financials?)?|team\s+composition|resource\s+persons?|resources?\s+required|deployment)",
            re.I,
        ),
    ),
    (
        "scope_of_work",
        re.compile(
            r"(scope\s+of\s+work|terms\s+of\s+reference|objectives?|project\s+scope|nature\s+of\s+work)",
            re.I,
        ),
    ),
    (
        "general_terms",
        re.compile(
            r"(general\s+(?:terms|conditions)|other\s+conditions|miscellaneous|indemnity|confidentiality|termination)",
            re.I,
        ),
    ),
    (
        "background",
        re.compile(r"(background|introduction|context|preamble|whereas)", re.I),
    ),
]


@dataclass
class Chunk:
    text: str
    section_label: str | None
    chunk_index: int


def _normalize(text: str) -> str:
    text = (text or "").replace("\r\n", "\n").replace("\r", "\n")
    # Collapse >2 blank lines to exactly one blank line, preserve paragraph structure.
    text = re.sub(r"\n{3,}", "\n\n", text)
    text = re.sub(r"[ \t]+\n", "\n", text)
    text = re.sub(r"[ \t]{2,}", " ", text)
    return text.strip()


def _looks_like_heading_line(line: str) -> bool:
    """Heading = short, no trailing period, mostly Title-Case or all-caps, or ends in colon."""
    s = line.strip().rstrip(":")
    if not s or len(s) > 120 or s.endswith("."):
        return False
    if line.strip().endswith(":") or s.isupper():
        return True
    tokens = [t for t in re.split(r"\s+", s) if t]
    if not tokens:
        return False
    title = sum(1 for t in tokens if t[:1].isupper() and not t.isupper())
    return title / len(tokens) >= 0.6


def _match_label(line: str) -> str | None:
    for label, pat in _SECTION_PATTERNS:
        if pat.search(line):
            return label
    return None


def _detect_section(paragraph: str) -> tuple[str | None, str]:
    """Detect a section for this paragraph.

    Returns (label, body). The heading line (if any) is stripped off the
    returned body so it isn't chunked twice.
    """
    lines = paragraph.split("\n", 1)
    first = lines[0]
    rest = lines[1] if len(lines) > 1 else ""

    # Whole paragraph is heading-shape (short, no body).
    if not rest.strip() and _looks_like_heading_line(first):
        label = _match_label(first)
        return label, ""

    # First line is heading, rest is body — the common QCI Work Order pattern.
    if _looks_like_heading_line(first) and _match_label(first):
        return _match_label(first), rest.strip()

    # Otherwise infer from body content itself (e.g. explicit "Payment Milestones:" mid-para).
    return _match_label(paragraph[:200]), paragraph


def _paragraphs(text: str) -> list[str]:
    return [p.strip() for p in text.split("\n\n") if p.strip()]


def _pack(paragraphs: list[tuple[str, str | None]]) -> list[Chunk]:
    """Greedy pack (paragraph, current_section) into ~CHUNK_SIZE windows.

    Section label sticks to whatever section the paragraph is in when it
    starts a chunk; a chunk that spans two sections keeps the earlier
    (more specific) label.
    """
    chunks: list[Chunk] = []
    buf: list[str] = []
    buf_size = 0
    buf_section: str | None = None
    chunk_idx = 0

    def flush(carry: str = "") -> None:
        nonlocal buf, buf_size, buf_section, chunk_idx
        if not buf:
            return
        chunks.append(
            Chunk(
                text=carry + "\n\n".join(buf).strip(),
                section_label=buf_section,
                chunk_index=chunk_idx,
            )
        )
        chunk_idx += 1
        # keep tail as overlap for next chunk
        tail = "\n\n".join(buf)
        overlap = tail[-CHUNK_OVERLAP:] if CHUNK_OVERLAP and len(tail) > CHUNK_OVERLAP else ""
        buf = []
        buf_size = 0
        buf_section = None
        if overlap:
            buf.append(overlap)
            buf_size = len(overlap)

    for para, section in paragraphs:
        para_len = len(para)
        # Section boundary starts a new chunk (unless buffer is basically empty).
        if section and buf_section and section != buf_section and buf_size > 200:
            flush()
        if buf_section is None and section:
            buf_section = section

        if para_len > CHUNK_SIZE:
            # Very long paragraph — hard-split into windows.
            if buf:
                flush()
            i = 0
            while i < para_len:
                slice_ = para[i : i + CHUNK_SIZE]
                chunks.append(
                    Chunk(text=slice_, section_label=section or buf_section, chunk_index=chunk_idx)
                )
                chunk_idx += 1
                i += max(CHUNK_SIZE - CHUNK_OVERLAP, 1)
            continue

        if buf_size + para_len > CHUNK_SIZE and buf:
            flush()
            if buf_section is None and section:
                buf_section = section

        buf.append(para)
        buf_size += para_len + 2

    flush()
    return chunks


def chunk_text(text: str, title: str | None = None) -> list[Chunk]:
    """Split text into section-labeled chunks."""
    normalized = _normalize(text or "")
    if not normalized:
        return []

    # If we have a title, prepend it as its own paragraph so the first chunk
    # always carries retrievable identity for BM25-style hits.
    paragraphs = _paragraphs(normalized)
    if title:
        paragraphs = [title.strip(), *paragraphs]

    labeled: list[tuple[str, str | None]] = []
    current: str | None = None
    for para in paragraphs:
        label, body = _detect_section(para)
        if label:
            current = label
        if body:
            labeled.append((body, current))

    return _pack(labeled)


def tokens(text: str) -> list[str]:
    """Simple tokenizer for keyword fallback / BM25-lite scoring."""
    return [t.lower() for t in re.findall(r"[a-z0-9][a-z0-9\-/&]{1,}", text or "", re.I)]
