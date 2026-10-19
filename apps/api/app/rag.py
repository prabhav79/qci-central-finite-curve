"""
RAG answer generation over corpus search hits.
Uses OpenAI-compatible or Gemini HTTP APIs when keys are present; otherwise extractive fallback.
"""
from __future__ import annotations

import json
import logging
import os
import urllib.error
import urllib.request
from typing import Any

from .corpus import search_corpus

log = logging.getLogger("cfc.rag")


def _env(*names: str) -> str | None:
    for n in names:
        v = os.environ.get(n)
        if v and v.strip():
            return v.strip()
    return None


def build_context(hits: list[dict[str, Any]], max_chars: int = 6000) -> str:
    parts: list[str] = []
    used = 0
    for i, h in enumerate(hits, 1):
        block = (
            f"[{i}] doc_id={h.get('doc_id')} | {h.get('title')} | {h.get('ministry')}\n"
            f"{h.get('text', '')}\n"
        )
        if used + len(block) > max_chars:
            break
        parts.append(block)
        used += len(block)
    return "\n".join(parts)


def extractive_answer(query: str, hits: list[dict[str, Any]]) -> str:
    if not hits:
        return "No matching documents were found in QCI's knowledge base. Try different words."
    lines = [f"Here are the {min(len(hits), 5)} closest passages from QCI's documents:"]
    for i, h in enumerate(hits[:5], 1):
        snippet = (h.get("text") or "")[:240].replace("\n", " ")
        lines.append(f"{i}. {h.get('title')} ({h.get('ministry')}) — {snippet}…")
    return "\n".join(lines)


def _anthropic_answer(api_key: str, model: str, system: str, user: str) -> str:
    from .agent_llm import _ADAPTIVE_THINKING_MODEL_RE, _anthropic_client

    kwargs: dict[str, Any] = {
        "model": model,
        "max_tokens": 4000,
        "system": system,
        "messages": [{"role": "user", "content": user}],
    }
    if _ADAPTIVE_THINKING_MODEL_RE.match(model):
        kwargs["thinking"] = {"type": "adaptive"}
        kwargs["output_config"] = {"effort": "low"}
    msg = _anthropic_client(api_key).messages.create(**kwargs)
    return "".join(b.text for b in msg.content if b.type == "text")


def _openai_chat(api_key: str, model: str, system: str, user: str) -> str:
    body = json.dumps(
        {
            "model": model,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
            "temperature": 0.2,
        }
    ).encode("utf-8")
    req = urllib.request.Request(
        "https://api.openai.com/v1/chat/completions",
        data=body,
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {api_key}",
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=90) as resp:
        data = json.loads(resp.read().decode("utf-8"))
    return data["choices"][0]["message"]["content"]


def _gemini_generate(api_key: str, model: str, prompt: str) -> str:
    url = (
        f"https://generativelanguage.googleapis.com/v1beta/models/"
        f"{model}:generateContent?key={api_key}"
    )
    body = json.dumps(
        {
            "contents": [{"parts": [{"text": prompt}]}],
            "generationConfig": {"temperature": 0.2},
        }
    ).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=90) as resp:
        data = json.loads(resp.read().decode("utf-8"))
    parts = data["candidates"][0]["content"]["parts"]
    return "".join(p.get("text", "") for p in parts)


def answer_query(
    query: str,
    *,
    limit: int = 6,
    ministry: str | None = None,
    provider: str | None = None,
    api_key: str | None = None,
    model: str | None = None,
    prefetched_hits: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    hits = prefetched_hits if prefetched_hits is not None else search_corpus(
        query, limit=limit, ministry=ministry
    )
    context = build_context(hits)

    system = (
        "You are CFC, an assistant for Quality Council of India institutional drafting. "
        "Answer ONLY using the provided context passages. Cite sources as [n]. "
        "If context is insufficient, say what is missing. Be concise and operational."
    )
    user_prompt = f"Question:\n{query}\n\nContext passages:\n{context}\n\nAnswer with citations."

    used_provider = "extractive"
    answer = extractive_answer(query, hits)
    error = None

    # Resolve provider/key
    prov = (provider or "").lower().strip()
    key = api_key
    if not prov or prov == "auto":
        if _env("ANTHROPIC_API_KEY"):
            prov = "anthropic"
        elif key or _env("OPENAI_API_KEY"):
            prov = "openai"
        elif _env("GEMINI_API_KEY", "GOOGLE_API_KEY"):
            prov = "gemini"

    try:
        if prov in {"anthropic", "claude"}:
            key = key or _env("ANTHROPIC_API_KEY")
            if key:
                answer = _anthropic_answer(
                    key,
                    model or os.environ.get("ANTHROPIC_MODEL") or "claude-sonnet-5-5",
                    system,
                    user_prompt,
                )
                used_provider = "anthropic"
        elif prov == "openai":
            key = key or _env("OPENAI_API_KEY")
            if key:
                answer = _openai_chat(
                    key,
                    model or os.environ.get("OPENAI_MODEL", "gpt-4o-mini"),
                    system,
                    user_prompt,
                )
                used_provider = "openai"
        elif prov in {"gemini", "google"}:
            key = key or _env("GEMINI_API_KEY", "GOOGLE_API_KEY")
            if key:
                answer = _gemini_generate(
                    key,
                    model or os.environ.get("GEMINI_MODEL", "gemini-flash-latest"),
                    f"{system}\n\n{user_prompt}",
                )
                used_provider = "gemini"
    except Exception as e:  # noqa: BLE001
        log.warning("RAG answer via %s failed: %s", prov, e)
        error = str(e)
        answer = extractive_answer(query, hits)
        used_provider = "extractive_fallback"

    return {
        "query": query,
        "answer": answer,
        "provider": used_provider,
        "citations": hits,
        "error": error,
    }
