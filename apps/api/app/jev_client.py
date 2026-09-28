"""
TypeSafe Jev client — fast, cheap, typed judgment calls (not text generation).

Wire protocol (confirmed against https://docs.typesafe.ai/api and the
@jkudish/jev-mcp README, 2026-09-28 — no TYPESAFE_API_KEY was available to
smoke-test against the live API, so this has NOT been exercised against a
real response; unit-test against a hand-built payload before trusting it):

  POST https://api.typesafe.ai/v1/systemone
  header: Authorization: Bearer <TYPESAFE_API_KEY>
  body:   {"model": ..., "state": <str|object>, "questions": {key: question}}
  noul question:   {"type": "noul", "instructions": str}
  choice question: {"type": "choice", "instructions": str, "criteria": {option: str|null, ...}}
  response:        {"model": ..., "answers": {key: answer}, "usage": {...}}
  noul answer:      {"type": "noul", "noul": <0..1>}
  choice answer:    {"type": "choice", "choice": <option>, "probabilities": {...}, "confidence": <0..1>}

Every possible answer is fixed in the request schema, so a bad call fails
loudly (HTTP/parse error) rather than returning something unparseable —
callers here treat ANY failure as "skip Jev, fall back to the existing
heuristic" (same posture as ocr_runpulse.py toward RunPulse), since this is
a quality enhancement, never a hard dependency for ingestion to succeed.
"""
from __future__ import annotations

import logging
import os

import httpx

log = logging.getLogger("cfc.jev")

TYPESAFE_URL = os.environ.get("TYPESAFE_URL", "https://api.typesafe.ai/v1/systemone")
JEV_MODEL = os.environ.get("JEV_MODEL", "jev-latest")
TIMEOUT_SEC = float(os.environ.get("TYPESAFE_TIMEOUT_SEC", "15"))


def is_configured() -> bool:
    return bool(os.environ.get("TYPESAFE_API_KEY"))


def _api_key() -> str:
    key = os.environ.get("TYPESAFE_API_KEY", "").strip()
    if not key:
        raise RuntimeError("TYPESAFE_API_KEY missing")
    return key


def evaluate(state: str, questions: dict[str, dict]) -> dict[str, dict]:
    """POST one batched /v1/systemone call and return the raw `answers` dict.

    Batch everything into ONE call — the whole point of Jev's pricing/speed
    is that N questions in one request cost roughly the same as one question
    (TypeSafe's own numbers: ~10-12x cheaper/faster batched vs N separate
    calls). Raises on any HTTP/parse failure; callers decide the fallback.
    """
    with httpx.Client(timeout=TIMEOUT_SEC) as client:
        resp = client.post(
            TYPESAFE_URL,
            headers={
                "Authorization": f"Bearer {_api_key()}",
                "Content-Type": "application/json",
            },
            json={"model": JEV_MODEL, "state": state, "questions": questions},
        )
    if resp.status_code >= 400:
        raise RuntimeError(f"TypeSafe HTTP {resp.status_code}: {resp.text[:400]}")
    try:
        payload = resp.json()
    except ValueError as e:
        raise RuntimeError(f"TypeSafe returned non-JSON: {resp.text[:400]}") from e
    answers = payload.get("answers")
    if not isinstance(answers, dict):
        raise RuntimeError(f"TypeSafe response missing 'answers': {payload!r}"[:400])
    return answers
