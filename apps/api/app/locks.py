"""Per-draft write lock: every path that writes a new DraftVersion (agent
inserts, manual saves) takes it, so two writers can't both compute the same
next version number and overwrite each other's DOCX."""
from __future__ import annotations

import threading
from contextlib import contextmanager
from typing import Iterator

_guard = threading.Lock()
_locks: dict[str, threading.Lock] = {}


@contextmanager
def draft_write_lock(draft_id: str) -> Iterator[None]:
    with _guard:
        lock = _locks.setdefault(draft_id, threading.Lock())
    with lock:
        yield
