"""
BYOK LLM adapter with tool-calling.

Providers:
- gemini   — Google Generative Language API v1beta streamGenerateContent
- openai   — OpenAI chat.completions with tools + stream
- mock     — scripted response for smoke tests (no key required)

BYOK per request: the key comes from the frontend on each /agent/chat call.
There is no server-side key.

Emits a stream of dict frames:
  {type: "token", text: "..."}
  {type: "tool_call", id, name, args}
  {type: "tool_result", id, name, result}
  {type: "draft_updated", version, sha256, tracked}    (emitted by run_agent when a mutation lands)
  {type: "done", reason}
  {type: "error", message}
"""
from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass, field
from typing import Any, Callable, Iterator

import httpx

log = logging.getLogger("cfc.agent.llm")

MUTATION_TOOLS = {"cfc_propose_insert", "cfc_propose_replace"}
# Ends the conversation immediately on a successful call — used by draft_intake
# to hand off to draft_generator (see agent_tools.CFC_READY_TO_GENERATE_SCHEMA).
TERMINAL_TOOLS = {"cfc_ready_to_generate"}


@dataclass
class Turn:
    """Provider-agnostic conversation turn."""

    role: str  # system | user | assistant | tool
    content: str = ""
    tool_calls: list[dict[str, Any]] = field(default_factory=list)  # [{id, name, args}]
    tool_call_id: str | None = None  # when role=tool
    name: str | None = None  # tool name for role=tool


@dataclass
class LLMConfig:
    provider: str  # gemini | openai | mock
    api_key: str | None
    model: str


# --------------------------------------------------------------------------- #
# Provider implementations
# --------------------------------------------------------------------------- #

def _openai_tools(schemas: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [{"type": "function", "function": s} for s in schemas]


def _gemini_tools(schemas: list[dict[str, Any]]) -> list[dict[str, Any]]:
    # Gemini expects raw JSON schema in `parameters`; drop `additionalProperties`, etc.
    return [{"functionDeclarations": schemas}]


DEFAULT_MODELS: dict[str, str] = {
    "openai": "gpt-4o-mini",
    "gemini": "gemini-flash-latest",
    "google": "gemini-flash-latest",
    "groq": "llama-3.3-70b-versatile",
    # Haiku, not Opus/Sonnet: this provider is meant for BYOK demo keys on a
    # small prepaid budget (draft_generator's per-section calls are short —
    # one retrieval + one ~300-word section — so the cheapest current model
    # comfortably covers many runs without a quality cliff for this task).
    "anthropic": "claude-haiku-4-5",
    "claude": "claude-haiku-4-5",
    "mock": "",
}

_OPENAI_COMPAT_BASE: dict[str, str] = {
    "openai": "https://api.openai.com/v1",
    "groq": "https://api.groq.com/openai/v1",
}


def _openai_compatible_stream(
    cfg: LLMConfig,
    turns: list[Turn],
    tools: list[dict[str, Any]],
    *,
    base_url: str,
) -> Iterator[dict[str, Any]]:
    messages: list[dict[str, Any]] = []
    for t in turns:
        if t.role == "system":
            messages.append({"role": "system", "content": t.content})
        elif t.role == "user":
            messages.append({"role": "user", "content": t.content})
        elif t.role == "assistant":
            msg: dict[str, Any] = {"role": "assistant", "content": t.content or None}
            if t.tool_calls:
                msg["tool_calls"] = [
                    {
                        "id": tc["id"],
                        "type": "function",
                        "function": {"name": tc["name"], "arguments": json.dumps(tc.get("args") or {})},
                    }
                    for tc in t.tool_calls
                ]
            messages.append(msg)
        elif t.role == "tool":
            messages.append({"role": "tool", "tool_call_id": t.tool_call_id, "content": t.content})

    body = {
        "model": cfg.model or DEFAULT_MODELS.get(cfg.provider, "gpt-4o-mini"),
        "messages": messages,
        "tools": _openai_tools(tools) if tools else None,
        "tool_choice": "auto" if tools else "none",
        "temperature": 0.2,
        "stream": True,
    }
    body = {k: v for k, v in body.items() if v is not None}
    headers = {
        "Authorization": f"Bearer {cfg.api_key}",
        "Content-Type": "application/json",
        "Accept": "text/event-stream",
    }
    tool_buf: dict[int, dict[str, Any]] = {}
    finish_reason = "stop"
    url = f"{base_url.rstrip('/')}/chat/completions"
    with httpx.Client(timeout=180.0) as client:
        with client.stream("POST", url, json=body, headers=headers) as resp:
            if resp.status_code >= 400:
                raise RuntimeError(f"{cfg.provider} HTTP {resp.status_code}: {resp.read().decode('utf-8', 'replace')[:300]}")
            for raw in resp.iter_lines():
                if not raw:
                    continue
                if raw.startswith("data:"):
                    data = raw[len("data:") :].strip()
                    if data == "[DONE]":
                        break
                    try:
                        chunk = json.loads(data)
                    except json.JSONDecodeError:
                        continue
                    choice = (chunk.get("choices") or [{}])[0]
                    delta = choice.get("delta") or {}
                    finish_reason = choice.get("finish_reason") or finish_reason
                    if delta.get("content"):
                        yield {"kind": "text", "text": delta["content"]}
                    for tc_delta in delta.get("tool_calls") or []:
                        idx = int(tc_delta.get("index", 0))
                        slot = tool_buf.setdefault(idx, {"id": "", "name": "", "arguments": ""})
                        if tc_delta.get("id"):
                            slot["id"] = tc_delta["id"]
                        fn = tc_delta.get("function") or {}
                        if fn.get("name"):
                            slot["name"] += fn["name"]
                        if fn.get("arguments"):
                            slot["arguments"] += fn["arguments"]

    tool_calls: list[dict[str, Any]] = []
    for idx in sorted(tool_buf.keys()):
        raw = tool_buf[idx]
        try:
            args = json.loads(raw["arguments"] or "{}")
        except json.JSONDecodeError:
            args = {"_raw_arguments": raw["arguments"]}
        tool_calls.append({"id": raw["id"] or f"call_{idx}", "name": raw["name"], "args": args})
    yield {"kind": "final", "tool_calls": tool_calls, "finish_reason": "tool_calls" if tool_calls else finish_reason}


def _stream_gemini(cfg: LLMConfig, turns: list[Turn], tools: list[dict[str, Any]]) -> Iterator[dict[str, Any]]:
    contents: list[dict[str, Any]] = []
    system_text: str | None = None
    for t in turns:
        if t.role == "system":
            system_text = (system_text + "\n\n" if system_text else "") + t.content
            continue
        if t.role == "user":
            contents.append({"role": "user", "parts": [{"text": t.content}]})
        elif t.role == "assistant":
            parts: list[dict[str, Any]] = []
            if t.content:
                parts.append({"text": t.content})
            for tc in t.tool_calls:
                parts.append({"functionCall": {"name": tc["name"], "args": tc.get("args") or {}}})
            contents.append({"role": "model", "parts": parts})
        elif t.role == "tool":
            # Gemini: functionResponse under role=user
            try:
                response_obj = json.loads(t.content) if t.content else {}
            except json.JSONDecodeError:
                response_obj = {"text": t.content}
            contents.append(
                {
                    "role": "user",
                    "parts": [{"functionResponse": {"name": t.name or "unknown", "response": response_obj}}],
                }
            )

    body: dict[str, Any] = {
        "contents": contents,
        "generationConfig": {"temperature": 0.2},
    }
    if tools:
        body["tools"] = _gemini_tools(tools)
        body["toolConfig"] = {"functionCallingConfig": {"mode": "AUTO"}}
    if system_text:
        body["systemInstruction"] = {"parts": [{"text": system_text}]}

    model = cfg.model or DEFAULT_MODELS["gemini"]
    url = (
        f"https://generativelanguage.googleapis.com/v1beta/models/{model}:streamGenerateContent?alt=sse"
    )
    headers = {
        "Content-Type": "application/json",
        # Newer Gemini keys (AQ.*) authenticate via header, not query param.
        "X-goog-api-key": cfg.api_key or "",
    }
    tool_calls: list[dict[str, Any]] = []
    finish_reason = "stop"
    with httpx.Client(timeout=180.0) as client:
        with client.stream("POST", url, json=body, headers=headers) as resp:
            if resp.status_code >= 400:
                raise RuntimeError(f"gemini HTTP {resp.status_code}: {resp.read().decode('utf-8', 'replace')[:300]}")
            for raw in resp.iter_lines():
                if not raw:
                    continue
                if raw.startswith("data:"):
                    data = raw[len("data:") :].strip()
                    if not data:
                        continue
                    try:
                        chunk = json.loads(data)
                    except json.JSONDecodeError:
                        continue
                    for cand in chunk.get("candidates") or []:
                        finish_reason = cand.get("finishReason") or finish_reason
                        for part in ((cand.get("content") or {}).get("parts")) or []:
                            if isinstance(part.get("text"), str) and part["text"]:
                                yield {"kind": "text", "text": part["text"]}
                            fc = part.get("functionCall")
                            if fc:
                                tool_calls.append(
                                    {
                                        "id": f"call_{len(tool_calls)}",
                                        "name": fc.get("name") or "",
                                        "args": fc.get("args") or {},
                                    }
                                )
    kind = "tool_calls" if tool_calls else (finish_reason or "stop").lower()
    yield {"kind": "final", "tool_calls": tool_calls, "finish_reason": kind}


# Short, bounded generations (one retrieval + one section insert per call) —
# capped well below the SDK's non-streaming timeout threshold on purpose, not
# a lowballed default; this keeps a small BYOK budget from disappearing into
# one runaway response.
_ANTHROPIC_MAX_TOKENS = 1536


def _anthropic_tools(schemas: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [
        {
            "name": s["name"],
            "description": s.get("description", ""),
            "input_schema": s.get("parameters") or {"type": "object", "properties": {}},
        }
        for s in schemas
    ]


def _stream_anthropic(cfg: LLMConfig, turns: list[Turn], tools: list[dict[str, Any]]) -> Iterator[dict[str, Any]]:
    import anthropic as _anthropic_sdk

    system_parts = [t.content for t in turns if t.role == "system" and t.content]
    messages: list[dict[str, Any]] = []
    for t in turns:
        if t.role == "system":
            continue
        if t.role == "user":
            messages.append({"role": "user", "content": t.content})
        elif t.role == "assistant":
            content: list[dict[str, Any]] = []
            if t.content:
                content.append({"type": "text", "text": t.content})
            for tc in t.tool_calls:
                content.append({"type": "tool_use", "id": tc["id"], "name": tc["name"], "input": tc.get("args") or {}})
            messages.append({"role": "assistant", "content": content})
        elif t.role == "tool":
            messages.append(
                {
                    "role": "user",
                    "content": [
                        {"type": "tool_result", "tool_use_id": t.tool_call_id, "content": t.content or ""}
                    ],
                }
            )

    client = _anthropic_sdk.Anthropic(api_key=cfg.api_key)
    kwargs: dict[str, Any] = {
        "model": cfg.model or DEFAULT_MODELS.get(cfg.provider, "claude-haiku-4-5"),
        "max_tokens": _ANTHROPIC_MAX_TOKENS,
        "messages": messages,
    }
    if system_parts:
        kwargs["system"] = "\n\n".join(system_parts)
    if tools:
        kwargs["tools"] = _anthropic_tools(tools)

    with client.messages.stream(**kwargs) as stream:
        for text in stream.text_stream:
            yield {"kind": "text", "text": text}
        final = stream.get_final_message()

    tool_calls = [
        {"id": b.id, "name": b.name, "args": b.input}
        for b in final.content
        if b.type == "tool_use"
    ]
    finish_reason = "tool_calls" if tool_calls else (final.stop_reason or "stop")
    yield {"kind": "final", "tool_calls": tool_calls, "finish_reason": finish_reason}


def _stream_mock(cfg: LLMConfig, turns: list[Turn], tools: list[dict[str, Any]]) -> Iterator[dict[str, Any]]:
    """Deterministic script for smoke tests.

    Turn 1 (user prompt seen, no prior tool result):
       - stream a short reasoning sentence
       - emit one tool_call: cfc_search_corpus{"query": <user text>[:80]}
    Turn 2+ (tool result present in the last turn):
       - stream a short 'inserting citation' sentence
       - emit one tool_call: cfc_propose_insert{"text":"[CFC Mock insertion]\\n...","position":"end"}
    Turn 3+ (post-insert):
       - stream a wrap-up sentence and finish (no tool_call)
    """
    last_tool_result = next((t for t in reversed(turns) if t.role == "tool"), None)
    last_assistant = next((t for t in reversed(turns) if t.role == "assistant"), None)
    step = sum(1 for t in turns if t.role == "assistant")

    if any(t.get("name") == "cfc_ready_to_generate" for t in tools):
        # draft_intake mock script: search once, then immediately signal
        # readiness. Mock can't simulate a real grounded clarifying question —
        # that needs a real provider — but this exercises the mechanical
        # ready_to_generate -> persist -> draft_generator handoff end to end.
        first_user = next((t for t in turns if t.role == "user"), None)
        brief = (first_user.content if first_user else "") or "user prompt"
        if step == 0:
            for tok in ["Searching ", "corpus ", "for ", "context…"]:
                yield {"kind": "text", "text": tok}
            yield {
                "kind": "final",
                "tool_calls": [
                    {"id": "mock_intake_search", "name": "cfc_search_corpus", "args": {"query": brief[:80], "limit": 3}}
                ],
                "finish_reason": "tool_calls",
            }
            return
        doc_ids: list[str] = []
        if last_tool_result:
            try:
                hits = json.loads(last_tool_result.content or "{}").get("hits") or []
                doc_ids = [h["doc_id"] for h in hits[:2] if h.get("doc_id")]
            except Exception:  # noqa: BLE001
                doc_ids = []
        for tok in ["Ready ", "to ", "draft."]:
            yield {"kind": "text", "text": tok}
        yield {
            "kind": "final",
            "tool_calls": [
                {
                    "id": "mock_ready",
                    "name": "cfc_ready_to_generate",
                    "args": {
                        "enriched_brief": f"(mock enriched) {brief[:200]}",
                        "key_doc_ids": doc_ids,
                        "rationale": "mock smoke test",
                    },
                }
            ],
            "finish_reason": "tool_calls",
        }
        return

    if step == 0:
        first_user = next((t for t in turns if t.role == "user"), None)
        prompt = (first_user.content if first_user else "") or "user prompt"
        for tok in ["Searching ", "corpus ", "for ", "relevant ", "precedent…"]:
            yield {"kind": "text", "text": tok}
        yield {
            "kind": "final",
            "tool_calls": [
                {"id": "mock_search", "name": "cfc_search_corpus", "args": {"query": prompt[:80], "limit": 3}}
            ],
            "finish_reason": "tool_calls",
        }
        return

    if last_tool_result and last_assistant and any(tc["name"] == "cfc_search_corpus" for tc in last_assistant.tool_calls):
        for tok in ["Found ", "precedent. ", "Inserting ", "a ", "cited ", "note ", "at ", "the ", "end."]:
            yield {"kind": "text", "text": tok}
        # draft_generator's user prompt names the section being drafted — echo it
        # into the mock insert so a mock-provider generation run produces a
        # visibly section-differentiated draft, not 7 identical paragraphs.
        first_user = next((t for t in turns if t.role == "user"), None)
        section_match = re.search(r"Section to draft now:\s*(.+?)\s*\(", (first_user.content if first_user else "") or "")
        text = (
            f"[CFC Mock] {section_match.group(1)} section drafted by the smoke-test agent."
            if section_match
            else "[CFC Mock] This paragraph was inserted by the smoke-test agent."
        )
        yield {
            "kind": "final",
            "tool_calls": [
                {
                    "id": "mock_insert",
                    "name": "cfc_propose_insert",
                    "args": {
                        "text": text,
                        "position": "end",
                        "citation": "smoke-test",
                    },
                }
            ],
            "finish_reason": "tool_calls",
        }
        return

    for tok in ["Done. ", "New ", "draft ", "version ", "created."]:
        yield {"kind": "text", "text": tok}
    yield {"kind": "final", "tool_calls": [], "finish_reason": "stop"}


def _stream_openai(cfg: LLMConfig, turns: list[Turn], tools: list[dict[str, Any]]) -> Iterator[dict[str, Any]]:
    yield from _openai_compatible_stream(cfg, turns, tools, base_url=_OPENAI_COMPAT_BASE["openai"])


def _stream_groq(cfg: LLMConfig, turns: list[Turn], tools: list[dict[str, Any]]) -> Iterator[dict[str, Any]]:
    yield from _openai_compatible_stream(cfg, turns, tools, base_url=_OPENAI_COMPAT_BASE["groq"])


_PROVIDER_STREAMS: dict[str, Callable[[LLMConfig, list[Turn], list[dict[str, Any]]], Iterator[dict[str, Any]]]] = {
    "openai": _stream_openai,
    "gemini": _stream_gemini,
    "google": _stream_gemini,
    "groq": _stream_groq,
    "anthropic": _stream_anthropic,
    "claude": _stream_anthropic,
    "mock": _stream_mock,
}


# --------------------------------------------------------------------------- #
# Orchestrator
# --------------------------------------------------------------------------- #

MAX_STEPS = 6


def run_agent(
    cfg: LLMConfig,
    system_prompt: str,
    user_prompt: str,
    tool_schemas: list[dict[str, Any]],
    tool_dispatch: Callable[[str, dict[str, Any]], dict[str, Any]],
) -> Iterator[dict[str, Any]]:
    """Yield SSE-shaped frames driving one agent conversation to completion."""
    provider = (cfg.provider or "").lower().strip() or "mock"
    stream_fn = _PROVIDER_STREAMS.get(provider)
    if not stream_fn:
        yield {"type": "error", "message": f"unknown provider: {provider}"}
        return
    if provider != "mock" and not cfg.api_key:
        yield {"type": "error", "message": f"BYOK: api_key is required for provider={provider}"}
        return

    turns: list[Turn] = [
        Turn(role="system", content=system_prompt),
        Turn(role="user", content=user_prompt),
    ]

    for step in range(MAX_STEPS):
        text_buf: list[str] = []
        tool_calls: list[dict[str, Any]] = []
        finish_reason = "stop"
        try:
            for frame in stream_fn(cfg, turns, tool_schemas):
                if frame["kind"] == "text":
                    text_buf.append(frame["text"])
                    yield {"type": "token", "text": frame["text"]}
                elif frame["kind"] == "final":
                    tool_calls = frame.get("tool_calls") or []
                    finish_reason = frame.get("finish_reason") or "stop"
        except Exception as e:  # noqa: BLE001
            log.exception("provider stream failed")
            yield {"type": "error", "message": f"{type(e).__name__}: {e}"}
            return

        assistant_turn = Turn(role="assistant", content="".join(text_buf), tool_calls=tool_calls)
        turns.append(assistant_turn)

        if not tool_calls:
            yield {"type": "done", "reason": finish_reason}
            return

        for tc in tool_calls:
            yield {"type": "tool_call", "id": tc["id"], "name": tc["name"], "args": tc["args"]}
            result = tool_dispatch(tc["name"], tc["args"] or {})
            yield {"type": "tool_result", "id": tc["id"], "name": tc["name"], "result": result}
            if tc["name"] in MUTATION_TOOLS and isinstance(result, dict) and not result.get("error"):
                yield {
                    "type": "draft_updated",
                    "version": result.get("version"),
                    "sha256": result.get("sha256"),
                    "tracked": result.get("tracked"),
                }
            if tc["name"] in TERMINAL_TOOLS and isinstance(result, dict) and not result.get("error"):
                yield {
                    "type": "ready_to_generate",
                    "enriched_brief": result.get("enriched_brief"),
                    "key_docs": result.get("key_docs") or [],
                    "rationale": result.get("rationale"),
                }
                return
            turns.append(
                Turn(
                    role="tool",
                    tool_call_id=tc["id"],
                    name=tc["name"],
                    content=json.dumps(result, default=str),
                )
            )

    yield {"type": "done", "reason": "max_steps"}


def run_agent_with_fallback(
    configs: list[LLMConfig],
    system_prompt: str,
    user_prompt: str,
    tool_schemas: list[dict[str, Any]],
    tool_dispatch: Callable[[str, dict[str, Any]], dict[str, Any]],
) -> Iterator[dict[str, Any]]:
    """Try each config in order. If a config errors BEFORE producing any successful
    step (tool_call or token), retry the next one and emit a `provider_fallback`
    frame so the client knows. Once we're past the first step, errors propagate.
    """
    if not configs:
        yield {"type": "error", "message": "no LLM configs available"}
        return

    last_error: str | None = None
    for idx, cfg in enumerate(configs):
        buffered: list[dict[str, Any]] = []
        produced_something = False
        errored_early = False
        for frame in run_agent(cfg, system_prompt, user_prompt, tool_schemas, tool_dispatch):
            if produced_something:
                yield frame
                continue
            if frame["type"] in ("token", "tool_call", "tool_result", "draft_updated", "ready_to_generate", "done"):
                produced_something = True
                if idx > 0:
                    yield {
                        "type": "provider_fallback",
                        "provider": cfg.provider,
                        "from_error": last_error,
                    }
                for f in buffered:
                    yield f
                buffered = []
                yield frame
                continue
            if frame["type"] == "error":
                last_error = frame.get("message")
                errored_early = True
                break
            buffered.append(frame)  # start/preset held until we know this config works
        if produced_something:
            return
        if not errored_early and buffered:
            # No error, no progress — degenerate; flush and stop.
            for f in buffered:
                yield f
            yield {"type": "done", "reason": "empty_stream"}
            return
        # else: try the next config
    yield {"type": "error", "message": f"all providers failed: {last_error or 'unknown'}"}
