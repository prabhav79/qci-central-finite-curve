"""
Reader: the original file behind each corpus document, as a PDF.

The corpus keeps extracted text for search and drafting; the Reader shows
the document itself. Originals are never modified:

- PDFs are served as they are.
- The 19 DARPG work orders are indexed from summary JSON, but their PDFs
  sit in `Work Orders/` under the same name, so the reader shows those.
- Word files get a PDF copy made by LibreOffice (in our own container,
  nothing sent anywhere) and cached in the bucket under derived/. Without
  LibreOffice (e.g. a Windows dev machine) they report "not available".
"""
from __future__ import annotations

import hashlib
import logging
import re
import shutil
import subprocess
import tempfile
import threading
from pathlib import Path

from .models import CorpusDocument
from .storage import default_bucket

log = logging.getLogger("cfc.reader")

REPO_ROOT = Path(__file__).resolve().parents[3]
WORK_ORDERS = REPO_ROOT / "Work Orders"
_CONVERT_TIMEOUT_SEC = 120
_locks: dict[str, threading.Lock] = {}
_locks_guard = threading.Lock()


class NotAvailable(Exception):
    """No viewable PDF for this document (missing file, or no converter)."""


def _lock_for(key: str) -> threading.Lock:
    with _locks_guard:
        return _locks.setdefault(key, threading.Lock())


def _norm_stem(stem: str) -> str:
    return re.sub(r"[\s_]+", " ", stem).strip().lower()


def _work_order_pdf(doc_id: str) -> Path | None:
    """The PDF in Work Orders/ whose name matches a summary-JSON document."""
    exact = WORK_ORDERS / f"{doc_id}.pdf"
    if exact.is_file():
        return exact
    want = _norm_stem(doc_id)
    for p in WORK_ORDERS.rglob("*.pdf"):
        if _norm_stem(p.stem) == want:
            return p
    return None


def _original(doc: CorpusDocument) -> Path:
    if doc.storage_key:
        path = default_bucket().get_path(doc.storage_key)
    elif doc.kind == "processed_json":
        path = _work_order_pdf(doc.doc_id)
        if path is None:
            raise NotAvailable("The original PDF for this work order isn't in the library.")
    else:
        path = REPO_ROOT / doc.source_path
    if not path or not Path(path).is_file():
        raise NotAvailable("The original file for this document isn't available.")
    return Path(path)


def _soffice() -> str | None:
    return shutil.which("soffice") or shutil.which("libreoffice")


def _converted_pdf(doc: CorpusDocument, original: Path) -> Path:
    """Cached PDF copy of a Word file, keyed on the original's content."""
    digest = hashlib.sha256(original.read_bytes()).hexdigest()[:16]
    safe = re.sub(r"[^A-Za-z0-9_.-]+", "_", doc.doc_id)[:120]
    key = f"derived/{safe}-{digest}.pdf"
    bucket = default_bucket()
    if bucket.exists(key):
        return bucket.get_path(key)
    soffice = _soffice()
    if not soffice:
        raise NotAvailable("A PDF view of this Word document isn't available on this server yet.")
    with _lock_for(key):
        if bucket.exists(key):
            return bucket.get_path(key)
        with tempfile.TemporaryDirectory(prefix="cfc-convert-") as tmp:
            src = Path(tmp) / f"source{original.suffix.lower()}"
            shutil.copyfile(original, src)
            try:
                subprocess.run(
                    [soffice, "--headless", "--norestore", f"-env:UserInstallation=file:///{Path(tmp).as_posix()}/lo",
                     "--convert-to", "pdf", "--outdir", tmp, str(src)],
                    check=True, capture_output=True, timeout=_CONVERT_TIMEOUT_SEC,
                )
            except (subprocess.CalledProcessError, subprocess.TimeoutExpired) as e:
                log.warning("PDF conversion failed for %s: %s", doc.doc_id, e)
                raise NotAvailable("This Word document couldn't be converted for viewing.") from e
            out = Path(tmp) / "source.pdf"
            if not out.is_file():
                raise NotAvailable("This Word document couldn't be converted for viewing.")
            bucket.put_file(key, out)
    return bucket.get_path(key)


def viewable_pdf(doc: CorpusDocument) -> Path:
    """A PDF the Reader can show for this document (the original if it is one)."""
    original = _original(doc)
    suffix = original.suffix.lower()
    if suffix == ".pdf":
        return original
    if suffix in {".docx", ".doc", ".odt", ".rtf"}:
        return _converted_pdf(doc, original)
    raise NotAvailable("This file type can't be shown in the Reader.")
