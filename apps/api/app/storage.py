"""
CFC blob storage abstraction.

LocalBucket writes to storage/dev/ on disk — Sprint 1 default so dev keeps
working with no infra. S3Bucket lands in Sprint 6 (Railway prod cutover);
kept as a stub here so callers already speak the Bucket protocol.
"""
from __future__ import annotations

import os
import shutil
from pathlib import Path
from typing import Protocol

from .db import IS_POSTGRES  # noqa: F401  (import kept so callers can branch on env later)


class Bucket(Protocol):
    def put(self, key: str, data: bytes) -> str: ...
    def put_file(self, key: str, src_path: str | os.PathLike[str]) -> str: ...
    def get_path(self, key: str) -> Path: ...  # local resolvable path (temp download on prod)
    def exists(self, key: str) -> bool: ...
    def delete(self, key: str) -> None: ...


class LocalBucket:
    """Filesystem-backed bucket rooted at storage/<namespace>."""

    def __init__(self, root: Path, namespace: str = "dev") -> None:
        self.base = (root / "storage" / namespace).resolve()
        self.base.mkdir(parents=True, exist_ok=True)

    def _abs(self, key: str) -> Path:
        # forbid escapes; keys are always forward-slash relative
        key = key.replace("\\", "/").lstrip("/")
        if ".." in Path(key).parts:
            raise ValueError(f"illegal key: {key}")
        p = (self.base / key).resolve()
        if not str(p).startswith(str(self.base)):
            raise ValueError(f"key escapes bucket root: {key}")
        return p

    def put(self, key: str, data: bytes) -> str:
        p = self._abs(key)
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(data)
        return key

    def put_file(self, key: str, src_path: str | os.PathLike[str]) -> str:
        p = self._abs(key)
        p.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(os.fspath(src_path), p)
        return key

    def get_path(self, key: str) -> Path:
        return self._abs(key)

    def exists(self, key: str) -> bool:
        return self._abs(key).exists()

    def delete(self, key: str) -> None:
        p = self._abs(key)
        if p.exists():
            p.unlink()


# Repo root = parents[3] from apps/api/app/storage.py
_REPO_ROOT = Path(__file__).resolve().parents[3]


def default_bucket() -> Bucket:
    """Return the process-wide bucket. Later swap to S3Bucket when env is set."""
    # Sprint 6 will read CFC_STORAGE_BACKEND=s3 + AWS_* / Railway bucket creds here.
    namespace = os.environ.get("CFC_STORAGE_NAMESPACE", "dev")
    return LocalBucket(_REPO_ROOT, namespace=namespace)
