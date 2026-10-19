"""
What may reach an outside AI service, and whether AI runs at all.

Aligned with the Department of Expenditure note of 29 Jan 2025 (keep
government data out of external AI tools) and CERT-In's guidance on
generative AI (CIAD-2025-0013: anonymise inputs, use only approved tools;
AI Blueprint, May 2026: classify sensitive data, keep an override and an
emergency shutdown):

- `redact()` strips personal contact details and ID numbers from anything
  sent to the AI model or the Jev checking service. Corpus text is already
  cleaned at ingest; this also covers briefs, answers and draft text.
- `ai_enabled()` is the server-wide kill switch (CFC_AI_ENABLED=0 turns
  every AI call off; drafting, review and approval keep working).
- A draft marked confidential (`Draft.ai_restricted`) never reaches an
  outside AI service; see main.py's agent and research endpoints.
"""
from __future__ import annotations

import os
import re
from typing import Any

from .corpus_clean import _EMAIL_RE, _PHONE_RE

_AADHAAR_RE = re.compile(r"(?<![\d/.-])\d{4}[ -]\d{4}[ -]\d{4}(?![\d/-]|\.\d)")
_PAN_RE = re.compile(r"\b[A-Z]{5}\d{4}[A-Z]\b")

AI_OFF_MESSAGE = "AI help is switched off by the administrator. You can still write, review and approve documents."
CONFIDENTIAL_MESSAGE = (
    "This document is marked confidential, so AI help is off for it. Nothing in it is sent to outside services."
)


def ai_enabled() -> bool:
    return os.environ.get("CFC_AI_ENABLED", "1").strip() != "0"


def redact(text: str) -> str:
    if not text:
        return text
    text = _EMAIL_RE.sub("[email removed]", text)
    text = _PHONE_RE.sub("[phone removed]", text)
    text = _AADHAAR_RE.sub("[ID number removed]", text)
    return _PAN_RE.sub("[ID number removed]", text)


def redact_any(value: Any) -> Any:
    """`redact` applied to every string inside a JSON-like structure."""
    if isinstance(value, str):
        return redact(value)
    if isinstance(value, dict):
        return {k: redact_any(v) for k, v in value.items()}
    if isinstance(value, list):
        return [redact_any(v) for v in value]
    return value
