"""
Jev-based generation faithfulness check (plan item 9) — a soft QA signal
surfaced to the human reviewer, never an auto-block or auto-edit.

2a's fix for the "Special Campaign 2.0 & 3.0" hallucination was a prompt
instruction ("only state a fact if it appeared in a retrieved result").
2c's lesson, applied to a completely different failure mode (the
reviewer-mutation bypass), was that a prompt instruction alone is not
enforcement — the model can silently ignore it. This module is the
deterministic check for the SAME class of failure 2a targeted: after a
draft_generator section completes, does it read like it's making claims
(numbers, dates, proper nouns) that never appeared in what was actually
retrieved for that section?

Sentence-level, not word-level: extracting individual "facts" reliably
without an LLM call is unreliable, so this treats whole sentences that
LOOK fact-bearing (contain a digit, or a multi-word capitalized phrase)
as the unit to check — coarser than a real claim-extraction pass, but
deterministic, cheap (one batched Jev call per section), and directly
targets the observed failure shape.

Degrades to an empty list (never raises) if TYPESAFE_API_KEY is unset,
there's no evidence to check against, or the call fails — same posture
as jev_client/ingest.py's _jev_classify elsewhere in this codebase. An
empty list here means "nothing flagged", which includes "Jev didn't run"
— this is a soft QA signal, not a safety gate, so fail-open is correct.
"""
from __future__ import annotations

import logging
import re

from . import jev_client

log = logging.getLogger("cfc.jev.faithfulness")

_SENTENCE_SPLIT_RE = re.compile(r"(?<=[.!?])\s+")
_HAS_DIGIT_RE = re.compile(r"\d")
_PROPER_NOUN_RE = re.compile(r"\b[A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)+\b")

_MAX_CLAIMS_PER_SECTION = 8
_UNSUPPORTED_THRESHOLD = 0.4
_EVIDENCE_CHAR_LIMIT = 8000


def _candidate_claims(section_text: str) -> list[str]:
    """Sentences worth checking: contain a digit (a number/date/amount) or
    a multi-word capitalized phrase (a likely proper noun) — the exact
    failure shape 2a's fix targets ("Special Campaign 2.0 & 3.0")."""
    sentences = [s.strip() for s in _SENTENCE_SPLIT_RE.split(section_text) if s.strip()]
    claims = [s for s in sentences if _HAS_DIGIT_RE.search(s) or _PROPER_NOUN_RE.search(s)]
    return claims[:_MAX_CLAIMS_PER_SECTION]


def check_section(section_text: str, evidence: str) -> list[dict[str, object]]:
    """Returns only the claims that scored BELOW the support threshold —
    i.e. the flags actually worth surfacing, never the full claim list.
    Each item: {"claim": str, "score": float}."""
    if not evidence.strip() or not jev_client.is_configured():
        return []
    claims = _candidate_claims(section_text)
    if not claims:
        return []

    questions = {
        f"claim::{i}": {
            "type": "noul",
            "instructions": (
                "Does the reference material given as state support or contain "
                f'evidence for this specific claim: "{claim}"? Answer low if the '
                "claim's specific numbers, dates, or proper nouns are not present "
                "in the reference material, even if the general topic matches."
            ),
        }
        for i, claim in enumerate(claims)
    }
    try:
        answers = jev_client.evaluate(evidence[:_EVIDENCE_CHAR_LIMIT], questions)
    except Exception as e:  # noqa: BLE001
        log.warning("Jev faithfulness check failed: %s — skipping (fail-open)", e)
        return []

    flags: list[dict[str, object]] = []
    for i, claim in enumerate(claims):
        score = answers.get(f"claim::{i}", {}).get("noul")
        if isinstance(score, (int, float)) and score < _UNSUPPORTED_THRESHOLD:
            flags.append({"claim": claim, "score": round(float(score), 2)})
    return flags
