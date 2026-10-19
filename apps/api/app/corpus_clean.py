"""
Corpus text hygiene and curated metadata, applied at ingest before hashing and
chunking so the stored text, the Jev input and the change-detection hash are
all clean.

- clean_text: strips table-of-contents dot leaders, page furniture, HTML
  table tags from RunPulse output, private-use glyphs and stray CJK OCR
  noise; fixes known OCR misreads; redacts personal emails/phone numbers.
- is_boilerplate / strip_boilerplate: QCI's standard "About QCI" passage,
  which appears in most proposals and otherwise dominates retrieval and
  misleads ministry classification (it mentions DPIIT).
- metadata_for: rows from data/corpus_metadata.csv (human-reviewed titles,
  client/ministry, dates, sectors), keyed by doc_id.
"""
from __future__ import annotations

import csv
import re
import unicodedata
from functools import lru_cache
from typing import Any

from .db import ROOT

METADATA_CSV = ROOT / "data" / "corpus_metadata.csv"

_DOT_LEADER_RE = re.compile(r"(?:\.\s?){5,}|…{2,}|_{5,}|(?:-\s?){6,}")
_TRAILING_PAGE_NO_RE = re.compile(r"\d{1,3}\s*$")
_PAGE_LINE_RE = re.compile(r"^\s*(?:page\s*\d+(?:\s*(?:of|/)\s*\d+)?|\d+\s*(?:of|/)\s*\d+|-\s*\d+\s*-)\s*$", re.I)
_BLANK_PAGE_RE = re.compile(r"(?:this\s+page\s+(?:is\s+)?)?intentionally\s+(?:been\s+)?left\s+blank", re.I)
_HTML_CELL_RE = re.compile(r"</t[dh]>\s*<t[dh][^>]*>", re.I)
_HTML_BREAK_RE = re.compile(r"<br\s*/?>|</tr>|</p>|</li>|</h\d>", re.I)
_HTML_TAG_RE = re.compile(r"</?[a-z][a-z0-9]*(?:\s[^<>]*)?/?>", re.I)
_PRIVATE_USE_RE = re.compile("[-]")
_CJK_RE = re.compile("[぀-ヿ㐀-鿿가-힯]")
_EMAIL_RE = re.compile(r"\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b")
_PHONE_RE = re.compile(r"(?<![\d/.-])(?:\+91[\s-]?)?(?:[6-9]\d{4}[\s-]?\d{5}|0\d{2,4}[\s-]\d{6,8})(?![\d/.-])")
_OCR_FIXES = [
    ("ǪCI", "QCI"),
    ("ǫCI", "QCI"),
    ("Government of lndia", "Government of India"),
    (" lndia", " India"),
    ("Το ", "To "),  # Greek "Το" read in place of Latin "To"
]


def _is_toc_line(line: str) -> bool:
    if _DOT_LEADER_RE.search(line) and _TRAILING_PAGE_NO_RE.search(line):
        return True
    stripped = line.strip()
    return len(stripped) > 10 and stripped.count(".") / len(stripped) > 0.3


def clean_text(text: str) -> str:
    if not text:
        return ""
    text = unicodedata.normalize("NFKC", text)
    text = _HTML_CELL_RE.sub(" | ", text)
    text = _HTML_BREAK_RE.sub("\n", text)
    text = _HTML_TAG_RE.sub("", text)
    text = _PRIVATE_USE_RE.sub("", text)
    text = _CJK_RE.sub("", text)
    for bad, good in _OCR_FIXES:
        text = text.replace(bad, good)
    text = _EMAIL_RE.sub("[contact removed]", text)
    text = _PHONE_RE.sub("[contact removed]", text)
    kept: list[str] = []
    for line in text.replace("\r\n", "\n").replace("\r", "\n").split("\n"):
        if _is_toc_line(line) or _PAGE_LINE_RE.match(line) or _BLANK_PAGE_RE.search(line):
            continue
        kept.append(line.rstrip())
    text = "\n".join(kept)
    text = re.sub(r"[ \t]{2,}", " ", text)
    return re.sub(r"\n{3,}", "\n\n", text).strip()


_BOILERPLATE_RES = [
    re.compile(p, re.I | re.S)
    for p in (
        r"quality council of india\s*\(qci\)\s*(?:was|is)\s*(?:set up|established|an autonomous|a non-profit)",
        r"set up(?: in 1997)? jointly by the government of india and the indian industry",
        r"(?:dpiit|department (?:of|for) promotion of industry and internal trade).{0,120}nodal",
        r"qci (?:is|functions as) (?:a|an) (?:non-profit|autonomous|apex)",
        r"(?:nabcb|nabl|nabh|nbqp|nabet)[^.]{0,80}(?:nabcb|nabl|nabh|nbqp|nabet)[^.]{0,80}(?:nabcb|nabl|nabh|nbqp|nabet)",
    )
]


def is_boilerplate(text: str) -> bool:
    return any(p.search(text or "") for p in _BOILERPLATE_RES)


def strip_boilerplate(text: str) -> str:
    return "\n\n".join(p for p in (text or "").split("\n\n") if not is_boilerplate(p))


@lru_cache(maxsize=1)
def _metadata() -> dict[str, dict[str, Any]]:
    if not METADATA_CSV.exists():
        return {}
    with METADATA_CSV.open(encoding="utf-8-sig", newline="") as fh:
        return {row["doc_id"].strip(): row for row in csv.DictReader(fh) if row.get("doc_id", "").strip()}


def metadata_for(doc_id: str) -> dict[str, Any] | None:
    return _metadata().get(doc_id)


def excluded(doc_id: str) -> bool:
    row = metadata_for(doc_id)
    return bool(row and (row.get("exclude") or "").strip().lower() in {"1", "yes", "true", "y"})


def ministry_options() -> list[str]:
    """Canonical client/ministry labels from the reviewed metadata, used to
    constrain Jev's ministry pick for documents not yet in the CSV."""
    return sorted({(r.get("ministry") or "").strip() for r in _metadata().values() if (r.get("ministry") or "").strip()})
