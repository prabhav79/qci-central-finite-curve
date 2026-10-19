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
MIN_CHUNK_CHARS = 80

# Ordered so more-specific labels win the first regex match.
_SECTION_PATTERNS: list[tuple[str, re.Pattern[str]]] = [
    (
        "payment_milestones",
        re.compile(
            r"(payment\s+(?:milestones?|schedule|terms?|structure|break\s*-?\s*ups?)|terms\s+of\s+payment"
            r"|financial\s+terms?|milestone\s+payment|fee\s+schedule|mobili[sz]ation\s+advance)",
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


def _is_strong_heading(line: str) -> bool:
    # ALL-CAPS only: numbered lines are too often list items inside a section.
    s = line.strip().rstrip(":")
    if not s or len(s) > 70:
        return False
    letters = [c for c in s if c.isalpha()]
    return len(letters) >= 4 and all(c.isupper() for c in letters)


def _match_label(line: str) -> str | None:
    for label, pat in _SECTION_PATTERNS:
        if pat.search(line):
            return label
    return None


# "30% on submission of the inception report", "Mobilisation advance (50%)"
_PAYMENT_SCHEDULE_RE = re.compile(
    r"\d{1,3}\s*%[^.\n]{0,60}\b(on|upon|after|against)\s+(the\s+)?(submission|completion|approval|acceptance|signing)"
    r"|mobili[sz]ation\s+advance|\binstal+ments?\b|\btranches?\b",
    re.I,
)


def _detect_section(paragraph: str) -> tuple[str | None, str, bool]:
    """Detect a section for this paragraph.

    Returns (label, body, from_heading). The heading line (if any) is stripped
    off the returned body so it isn't chunked twice. Only headings move the
    running section; a label inferred from body text applies to that
    paragraph alone, otherwise one passing mention ("outputs", "deployment")
    relabels everything that follows it.
    """
    lines = paragraph.split("\n", 1)
    first = lines[0]
    rest = lines[1] if len(lines) > 1 else ""

    # Whole paragraph is heading-shape (short, no body). A strong heading
    # (numbered or ALL CAPS) that matches no section ends the previous one,
    # so e.g. "14. Taxes" doesn't stay labelled as payment.
    if not rest.strip() and _looks_like_heading_line(first):
        label = _match_label(first)
        return label, "", label is not None or _is_strong_heading(first)

    # First line is heading, rest is body — the common QCI Work Order pattern.
    if _looks_like_heading_line(first) and _match_label(first):
        return _match_label(first), rest.strip(), True
    if _is_strong_heading(first) and rest.strip():
        return None, paragraph, True

    # Inline "Payment Milestones: ..." style labels.
    lead = paragraph[:80]
    if ":" in lead and _match_label(lead):
        return _match_label(lead), paragraph, False
    if _PAYMENT_SCHEDULE_RE.search(paragraph):
        return "payment_milestones", paragraph, False
    return None, paragraph, False


_LIST_MARKER_RE = re.compile(r"^\s*(\(?\d{1,2}(\.\d{1,2})*[.)]|\(?[a-z][.)]|\(?[ivx]{1,4}[.)]|[•▪●◦\-–])\s+", re.I)


def _paragraphs(text: str) -> list[str]:
    """Blank-line separated blocks, with PDF page blocks (one block per page,
    hard-wrapped lines) rebuilt into real paragraphs: a new paragraph starts
    at a heading-shaped line or a list item; wrapped lines are re-joined."""
    out: list[str] = []
    for block in text.split("\n\n"):
        lines = [ln.strip() for ln in block.split("\n") if ln.strip()]
        if not lines:
            continue
        if len(lines) == 1:
            out.append(lines[0])
            continue
        current: list[str] = []
        for ln in lines:
            starts_new = _LIST_MARKER_RE.match(ln) or (_looks_like_heading_line(ln) and len(ln) < 90)
            if current and starts_new:
                out.append(_join_wrapped(current))
                current = []
            current.append(ln)
            if _looks_like_heading_line(ln) and len(ln) < 90 and len(current) == 1:
                out.append(ln)
                current = []
        if current:
            out.append(_join_wrapped(current))
    return [p for p in out if p.strip()]


def _join_wrapped(lines: list[str]) -> str:
    text = ""
    for ln in lines:
        if not text:
            text = ln
        elif text.endswith("-") and not text.endswith(" -"):
            text = text[:-1] + ln
        else:
            text = f"{text} {ln}"
    return text


def _word_tail(text: str, size: int) -> str:
    """Last ~size chars of text, starting at a word boundary."""
    tail = text[-size:]
    cut = tail.find(" ")
    return tail[cut + 1 :] if 0 <= cut < len(tail) - 1 else tail


def _word_windows(text: str, size: int, overlap: int) -> list[str]:
    """Split a long paragraph into ~size windows that start and end on word boundaries."""
    windows: list[str] = []
    start = 0
    n = len(text)
    while start < n:
        end = min(start + size, n)
        if end < n:
            space = text.rfind(" ", start + size // 2, end)
            if space != -1:
                end = space
        windows.append(text[start:end].strip())
        if end >= n:
            break
        nxt = max(end - overlap, start + 1)
        space = text.find(" ", nxt, end)
        start = space + 1 if space != -1 else nxt
    return [w for w in windows if w]


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
        overlap = _word_tail(tail, CHUNK_OVERLAP) if CHUNK_OVERLAP and len(tail) > CHUNK_OVERLAP else ""
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
            for slice_ in _word_windows(para, CHUNK_SIZE, CHUNK_OVERLAP):
                chunks.append(
                    Chunk(text=slice_, section_label=section or buf_section, chunk_index=chunk_idx)
                )
                chunk_idx += 1
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
        label, body, from_heading = _detect_section(para)
        if from_heading:
            current = label
        if body:
            labeled.append((body, label or current))

    chunks = _pack(labeled)
    kept = [c for c in chunks if len(c.text) >= MIN_CHUNK_CHARS] or chunks[:1]
    for i, c in enumerate(kept):
        c.chunk_index = i
    return kept


def tokens(text: str) -> list[str]:
    """Simple tokenizer for keyword fallback / BM25-lite scoring."""
    return [t.lower() for t in re.findall(r"[a-z0-9][a-z0-9\-/&]{1,}", text or "", re.I)]
