"""
RAG answer generation over corpus search hits.
Uses OpenAI-compatible or Gemini HTTP APIs when keys are present; otherwise extractive fallback.
"""
from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
from typing import Any

from .corpus import search_corpus


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
        return (
            "No matching institutional documents were found in the current corpus "
            f"for: {query!r}. Ingest more files or broaden the query."
        )
    lines = [
        f"Found {len(hits)} relevant passage(s) for your query.",
        "Top sources:",
    ]
    for i, h in enumerate(hits[:5], 1):
        snippet = (h.get("text") or "")[:240].replace("\n", " ")
        lines.append(f"{i}. {h.get('title')} ({h.get('ministry')}) ? {snippet}?")
    lines.append(
        "Connect OPENAI_API_KEY or GEMINI_API_KEY for a synthesized grounded answer."
    )
    return "\n".join(lines)


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
    if not prov:
        if key or _env("OPENAI_API_KEY"):
            prov = "openai"
        elif _env("GEMINI_API_KEY", "GOOGLE_API_KEY"):
            prov = "gemini"

    try:
        if prov == "openai":
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
                    model or os.environ.get("GEMINI_MODEL", "gemini-2.0-flash"),
                    f"{system}\n\n{user_prompt}",
                )
                used_provider = "gemini"
    except Exception as e:  # noqa: BLE001
        error = str(e)
        answer = extractive_answer(query, hits) + f"\n\n(LLM error: {error})"
        used_provider = "extractive_fallback"

    return {
        "query": query,
        "answer": answer,
        "provider": used_provider,
        "citations": hits,
        "error": error,
    }
