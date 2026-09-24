"""
RunPulse OCR client.

Endpoint contract (from https://docs.runpulse.com/api-reference/endpoint/extract):
  POST https://api.runpulse.com/extract
  header:  x-api-key: <RUNPULSE_API_KEY>
  body:    multipart/form-data with `file` (binary) OR `fileUrl` (URL)
  sync:    default (async=false); response has `markdown` (or legacy `content`)
  large:   >=5 MB → { is_url: true, url: <presigned> } — we fetch and parse
  limits:  100 MB upload cap → HTTP 413

Called by ingest.py whenever a PDF's text layer is empty (scanned image PDF).
Falls back to a placeholder if RUNPULSE_API_KEY is unset.

Implementation note: uses httpx for multipart. An earlier urllib version
lost the auth header intermittently on Windows and got 401s from the server
even though curl succeeded with the same key.
"""
from __future__ import annotations

import logging
import mimetypes
import os
from pathlib import Path

import httpx

log = logging.getLogger("cfc.ocr")

RUNPULSE_URL = os.environ.get("RUNPULSE_URL", "https://api.runpulse.com/extract").rstrip("/")
MAX_UPLOAD_BYTES = 100 * 1024 * 1024  # 100 MB, matches the RunPulse cap
TIMEOUT_SEC = float(os.environ.get("RUNPULSE_TIMEOUT_SEC", "300"))
MAX_MB_ENV = os.environ.get("RUNPULSE_MAX_MB")  # optional per-file cost guard


def is_configured() -> bool:
    return bool(os.environ.get("RUNPULSE_API_KEY"))


def _api_key() -> str:
    key = os.environ.get("RUNPULSE_API_KEY", "").strip()
    if not key:
        raise RuntimeError("RUNPULSE_API_KEY missing")
    return key


def _guard_size(path: Path) -> int:
    size = path.stat().st_size
    if size == 0:
        raise RuntimeError(f"empty file: {path}")
    if size > MAX_UPLOAD_BYTES:
        raise RuntimeError(
            f"{path.name} is {size / 1024 / 1024:.1f} MB — exceeds RunPulse 100 MB cap"
        )
    if MAX_MB_ENV:
        try:
            cap = float(MAX_MB_ENV)
            if size > cap * 1024 * 1024:
                raise RuntimeError(
                    f"{path.name} is {size / 1024 / 1024:.1f} MB — over local cost cap ({cap} MB)"
                )
        except ValueError:
            pass
    return size


def _post_extract(path: Path) -> dict:
    """POST the file to /extract and return the parsed JSON response."""
    _guard_size(path)
    mime = mimetypes.guess_type(path.name)[0] or "application/pdf"

    with path.open("rb") as fh, httpx.Client(timeout=TIMEOUT_SEC) as client:
        resp = client.post(
            RUNPULSE_URL,
            headers={"x-api-key": _api_key(), "Accept": "application/json"},
            files={"file": (path.name, fh, mime)},
        )
    if resp.status_code >= 400:
        raise RuntimeError(f"RunPulse HTTP {resp.status_code}: {resp.text[:400]}")
    try:
        return resp.json()
    except ValueError as e:
        raise RuntimeError(f"RunPulse returned non-JSON: {resp.text[:400]}") from e


def _resolve_url_result(payload: dict) -> dict:
    """When the response is {is_url: true, url: ...} fetch the JSON at that URL."""
    if not payload.get("is_url"):
        return payload
    url = payload.get("url")
    if not url:
        raise RuntimeError("RunPulse is_url response missing 'url'")
    with httpx.Client(timeout=TIMEOUT_SEC) as client:
        r = client.get(url)
    if r.status_code >= 400:
        raise RuntimeError(f"RunPulse presigned url HTTP {r.status_code}: {r.text[:200]}")
    try:
        return r.json()
    except ValueError as e:
        raise RuntimeError(f"RunPulse presigned url returned non-JSON: {r.text[:400]}") from e


def _pull_text(payload: dict) -> str:
    """Extract the primary text from a RunPulse response payload."""
    for key in ("markdown", "content", "text"):
        v = payload.get(key)
        if isinstance(v, str) and v.strip():
            return v
    for parent in ("result", "extraction", "data"):
        inner = payload.get(parent)
        if isinstance(inner, dict):
            got = _pull_text(inner)
            if got:
                return got
    return ""


def extract_text(path: Path) -> str:
    """Return extracted markdown/text for a scanned PDF using RunPulse."""
    log.info("runpulse: extracting %s", path.name)
    payload = _post_extract(path)
    if payload.get("is_url"):
        payload = _resolve_url_result(payload)
    text = _pull_text(payload)
    if not text.strip():
        raise RuntimeError(
            f"RunPulse returned no text for {path.name} (keys: {sorted(payload.keys())})"
        )
    return text
