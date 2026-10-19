"""
Jev re-ranking for corpus search: one batched /v1/systemone call judges each
candidate passage's relevance to the query (TypeSafe's documented rerank
pattern — the query in `state`, one `noul` question per passage with the
passage inside the question, because Jev's accuracy drops as unrelated text
in the shared state grows).

Fail-open: returns None if Jev is unconfigured, slow or failing, and the
caller keeps its own hybrid ordering. Scores are cached per (query, passage
text) for a few minutes, since intake turns and generator sections repeat
near-identical searches.
"""
from __future__ import annotations

import hashlib
import logging
import os
import threading
import time
from collections import OrderedDict

from . import jev_client

log = logging.getLogger("cfc.jev.rerank")

_TIMEOUT_SEC = float(os.environ.get("JEV_RERANK_TIMEOUT_SEC", "2.5"))
_CACHE_TTL_SEC = 600.0
_CACHE_MAX = 4000
_PASSAGE_CHARS = 900

_cache: OrderedDict[tuple[str, str], tuple[float, float]] = OrderedDict()
_cache_lock = threading.Lock()


def enabled() -> bool:
    return os.environ.get("CFC_JEV_RERANK", "1") != "0" and jev_client.is_configured()


def _cache_get(key: tuple[str, str]) -> float | None:
    with _cache_lock:
        hit = _cache.get(key)
        if not hit:
            return None
        score, at = hit
        if time.monotonic() - at > _CACHE_TTL_SEC:
            _cache.pop(key, None)
            return None
        _cache.move_to_end(key)
        return score


def _cache_put(key: tuple[str, str], score: float) -> None:
    with _cache_lock:
        _cache[key] = (score, time.monotonic())
        _cache.move_to_end(key)
        while len(_cache) > _CACHE_MAX:
            _cache.popitem(last=False)


def _question(title: str, section: str, text: str) -> str:
    where = f'"{title}"' + (f", {section.replace('_', ' ')} section" if section else "")
    return (
        "Is the passage below directly useful as a precedent for `query`, given `purpose`? "
        "Answer high only if it is about the same kind of work, scheme, sector or client situation, "
        "or gives concrete reusable content (scope, deliverables, timelines, payment terms, team) "
        "for it. Answer low for generic institutional boilerplate or an unrelated topic.\n"
        f"Passage from {where}:\n\"\"\"{text[:_PASSAGE_CHARS]}\"\"\""
    )


def rerank(query: str, purpose: str | None, passages: list[dict[str, str]]) -> dict[int, float] | None:
    """`passages`: [{title, section, text}]. Returns {index: relevance 0..1}
    for every passage, or None to signal "keep your own order"."""
    if not passages or not enabled():
        return None
    norm_query = " ".join(query.lower().split())
    norm_purpose = " ".join((purpose or "").lower().split())
    qkey = f"{norm_query}|{norm_purpose}"

    scores: dict[int, float] = {}
    questions: dict[str, dict[str, str]] = {}
    keys: dict[str, tuple[int, tuple[str, str]]] = {}
    for i, p in enumerate(passages):
        ckey = (qkey, hashlib.sha1((p.get("text") or "").encode("utf-8")).hexdigest())
        cached = _cache_get(ckey)
        if cached is not None:
            scores[i] = cached
            continue
        qid = f"p{i}"
        questions[qid] = {"type": "noul", "instructions": _question(p.get("title", ""), p.get("section", ""), p.get("text", ""))}
        keys[qid] = (i, ckey)

    if questions:
        state = {
            "query": query,
            "purpose": purpose or "Finding precedent passages in QCI's past work orders and proposals.",
        }
        answers = None
        for attempt in range(2):
            try:
                answers = jev_client.evaluate(state, questions, timeout=_TIMEOUT_SEC)
                break
            except Exception as e:  # noqa: BLE001
                retryable = any(code in str(e) for code in ("HTTP 429", "HTTP 529", "HTTP 503"))
                if attempt == 0 and retryable:
                    time.sleep(0.3)
                    continue
                log.warning("Jev rerank failed (%s) — keeping hybrid order", e)
                return None
        if answers is None:
            return None
        for qid, (i, ckey) in keys.items():
            val = (answers.get(qid) or {}).get("noul")
            if not isinstance(val, (int, float)):
                return None
            scores[i] = float(val)
            _cache_put(ckey, float(val))
    return scores
