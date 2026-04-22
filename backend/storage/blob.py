"""Blob storage abstraction.

Phase 0  : LocalFSBlobStore reads from the container's filesystem. The PDFs
           baked into the Docker image live under /app/Work Orders and
           /app/static/pdfs. `blob_key` on a Document row is the repo-relative
           path (e.g. 'Work Orders/1st Work Order_CPGRAMS_14072022.pdf').
Phase 1+ : S3BlobStore (or Azure Blob) implementing the same interface.
           Swap is a config change, not a code change.

The interface intentionally models the minimal set of operations we need:
- exists: for dedup / idempotent seed
- get:    read bytes
- put:    write bytes (Phase 1 ingestion pipeline)
- url_for: produce a URL the browser can GET (presigned in Phase 3)
"""
from __future__ import annotations

import os
from pathlib import Path
from typing import Protocol

from backend.config import get_settings


class BlobStore(Protocol):
    def exists(self, key: str) -> bool: ...
    def get(self, key: str) -> bytes: ...
    def put(self, key: str, content: bytes) -> None: ...
    def url_for(self, key: str, ttl_seconds: int = 600) -> str: ...


class LocalFSBlobStore:
    """Reads and writes blobs under a local base path."""

    def __init__(self, base_path: str | os.PathLike[str]) -> None:
        self.base = Path(base_path).resolve()
        self.base.mkdir(parents=True, exist_ok=True)

    def _resolve(self, key: str) -> Path:
        # Prevent directory traversal via '..' or absolute paths.
        p = (self.base / key).resolve()
        if self.base not in p.parents and p != self.base:
            raise ValueError(f"blob key {key!r} escapes base path {self.base}")
        return p

    def exists(self, key: str) -> bool:
        return self._resolve(key).is_file()

    def get(self, key: str) -> bytes:
        return self._resolve(key).read_bytes()

    def put(self, key: str, content: bytes) -> None:
        p = self._resolve(key)
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(content)

    def url_for(self, key: str, ttl_seconds: int = 600) -> str:
        # Phase 0: return a relative URL the backend serves through a FileResponse route.
        # Phase 3 will return a presigned S3 URL with a real TTL.
        return f"/files/{key}"


def default_blob_store() -> BlobStore:
    """Phase 0 factory. Returns a LocalFSBlobStore rooted at the repo root."""
    # In the deployed container the working dir is /app; locally it's the repo root.
    # Both resolve `Work Orders/...` to the correct location.
    return LocalFSBlobStore(base_path=Path(os.getcwd()))
