"""
Jev-based intake gap detection — makes draft_intake's own clarifying
questions more systematic by flagging which of a fixed set of important
dimensions the brief/title/conversation-so-far has NOT yet addressed.

Jev only ever answers fixed noul (0..1) / choice questions — it cannot write
open-ended question text. This module does not try to make it: the actual
natural-language question is, and must remain, authored by the LLM running
draft_intake (agent_presets.draft_intake_system/_user). What this adds is a
cheap, deterministic coverage check run before each turn, so the model's own
question-asking has an explicit "what's still missing" signal to work from
instead of guessing — directly aimed at feedback like "the brief didn't ask
about budget" rather than trusting the model to always think of it.

Degrades to an empty list (no gaps surfaced, zero behavior change) if
TYPESAFE_API_KEY is unset or the call fails — same fail-open posture as
jev_faithfulness.py and ingest.py's _jev_classify elsewhere in this codebase.

Scope is deliberately limited to "enrichment" axes only (budget, timeline,
location, concrete scope) — NOT engagement-type (new vs. extension) or
precedent-selection, which agent_presets.draft_intake_system's rule 3(a)
requires asking about unconditionally. Gap-gating those would let a vague
brief get scored as "already known" and skip a question the prompt's own
rules say must always be considered — this list only ever adds candidate
things to ask about, never anything intake is required to cover regardless.

This call sits directly in front of the next question streaming to the
user, unlike jev_faithfulness's post-hoc check — use a tight timeout
(JEV_INTAKE_TIMEOUT_SEC) rather than jev_client's 15s ingestion-tier
default, so a slow/hanging Jev call can't stall the conversation.
"""
from __future__ import annotations

import logging
import os

from . import jev_client

log = logging.getLogger("cfc.jev.intake")

_TIMEOUT_SEC = float(os.environ.get("JEV_INTAKE_TIMEOUT_SEC", "4"))

_DIMENSIONS: dict[str, str] = {
    "client_location": "a specific client, state, city, or ministry/department",
    "budget": "a specific budget figure, cost range, or financial scale",
    "timeline": "a specific duration, deadline, or timeline",
    "scope_specifics": "specific deliverables or activities, not just a general topic",
}


def detect_gaps(title: str, brief: str, transcript: list[dict[str, str]] | None = None) -> list[str]:
    """Returns the subset of _DIMENSIONS keys the cumulative text does NOT
    yet clearly address, in dimension order. Empty list means either nothing
    looks missing, or Jev isn't configured/failed — both are safe defaults
    for a soft guidance signal, never a hard gate."""
    if not jev_client.is_configured():
        return []

    parts = [f"Title: {title}".strip(), f"Brief: {brief}".strip()]
    for turn in transcript or []:
        text = turn.get("text", "")
        if text:
            parts.append(text)
    state = "\n".join(p for p in parts if p)
    if not state.strip():
        return []

    questions = {
        key: {
            "type": "noul",
            "instructions": f"Does this text already clearly specify {desc}?",
        }
        for key, desc in _DIMENSIONS.items()
    }
    try:
        answers = jev_client.evaluate(state[:6000], questions, timeout=_TIMEOUT_SEC)
    except Exception as e:  # noqa: BLE001
        log.warning("Jev intake gap-detection failed: %s — skipping (fail-open)", e)
        return []

    return [key for key in _DIMENSIONS if answers.get(key, {}).get("noul", 1.0) < 0.5]
