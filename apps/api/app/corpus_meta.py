"""
Library metadata on corpus_documents, kept in step with data/corpus_metadata.csv.

Runs at every API start (cheap: one pass over the corpus) so a corpus
imported from a bundle, or a CSV edited and redeployed, needs no extra step.

- client / state / sector / work_type / doc_type come straight from the CSV.
- engagement is the series a document belongs to, taken from its title:
  "CPGRAMS PMU – 3rd Work Order (Feb 2024)" -> "CPGRAMS PMU".
- outcome: every work order is awarded work, so "successful". A proposal
  is "successful" when its series has a work order dated on or after it,
  or when the CSV's optional `outcome` column says so; otherwise
  "unknown" — never guessed as "unsuccessful".
"""
from __future__ import annotations

import logging
import re

from sqlalchemy import select
from sqlalchemy.orm import Session

from .corpus_clean import metadata_for
from .models import CorpusDocument

log = logging.getLogger("cfc.corpus.meta")

_TRAILING_KIND_RE = re.compile(r"\s*\((?:[^()]*\b(?:Proposal|Work Order)\b[^()]*)\)\s*$", re.I)
_OUTCOME_WORDS = {
    "won": "successful", "successful": "successful", "awarded": "successful", "approved": "successful",
    "lost": "unsuccessful", "not won": "unsuccessful", "unsuccessful": "unsuccessful", "rejected": "unsuccessful",
    "pending": "pending",
}


def engagement_series(title: str) -> str:
    head = title.split(" – ")[0] if " – " in title else title
    return _TRAILING_KIND_RE.sub("", head).strip() or title.strip()


def _clean(value: object) -> str | None:
    text = str(value or "").strip()
    return text or None


def backfill(s: Session) -> int:
    """Brings every document's Library fields in line with the CSV. Returns
    the number of documents changed."""
    docs = s.execute(select(CorpusDocument)).scalars().all()
    changed = 0
    for d in docs:
        meta = metadata_for(d.doc_id) or {}
        want = {
            "client": _clean(meta.get("client")) or d.client or _clean(d.ministry),
            "state": _clean(meta.get("state")) or d.state,
            "sector": _clean(meta.get("sector")) or d.sector,
            "work_type": _clean(meta.get("engagement")) or d.work_type,
            "doc_type": _clean(meta.get("doc_type")) or d.doc_type,
            "engagement": engagement_series(d.title or d.doc_id),
        }
        for field, value in want.items():
            if getattr(d, field) != value:
                setattr(d, field, value)
                changed += 1
    # Outcomes need the whole series, so a second pass.
    series_work_orders: dict[str, list[str]] = {}
    for d in docs:
        if (d.doc_type or "").lower() == "work order":
            series_work_orders.setdefault(d.engagement or "", []).append(d.date or "")
    for d in docs:
        stated = _OUTCOME_WORDS.get(str((metadata_for(d.doc_id) or {}).get("outcome") or "").strip().lower())
        if (d.doc_type or "").lower() == "work order":
            outcome = "successful"
        elif stated:
            outcome = stated
        elif any(wo and d.date and wo >= d.date for wo in series_work_orders.get(d.engagement or "", [])):
            outcome = "successful"
        else:
            outcome = "unknown"
        if d.outcome != outcome:
            d.outcome = outcome
            changed += 1
    if changed:
        s.commit()
    return changed
