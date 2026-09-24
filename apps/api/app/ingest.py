"""
CFC ingestion pipeline: extract → chunk → embed → upsert into corpus tables.

Sources (in priority order):
  1. data/processed/*.json  (authoritative RunPulse extracts — 19 today)
  2. Work Orders/**/*.docx  (python-docx)
  3. Work Orders/**/*.pdf   (pypdf; empty text layer -> RunPulse OCR when key present)
  4. storage/dev/uploads/**/*.docx|pdf  (uploads from Makers, division from folder)
  5. storage/dev/templates/**            (Admin templates — not chunked)

Idempotent: content_sha256 keys dedupe/replace. Chunks are re-embedded on
content change; unchanged files are skipped.

CLI:
  python -m app.ingest                    # ingest everything under repo root
  python -m app.ingest --division PPID    # override default division
  python -m app.ingest --source path      # ingest one file
"""
from __future__ import annotations

import argparse
import hashlib
import json
import logging
import os
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Iterator

from dotenv import load_dotenv
from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from .chunking import chunk_text
from .db import IS_POSTGRES, ROOT, SessionLocal
from .embeddings import embed_batch, to_storage
from .models import CorpusChunk, CorpusDocument

log = logging.getLogger("cfc.ingest")

# Load .env so RUNPULSE_API_KEY / GEMINI_API_KEY are visible when running as CLI.
# override=True: .env values win over any stale shell env vars from prior sessions
# (Windows persists user-scoped env vars that could otherwise mask a rotated key).
load_dotenv(ROOT / ".env", override=True)
load_dotenv(override=True)

PROCESSED_DIR = ROOT / "data" / "processed"
WORK_ORDERS_DIR = ROOT / "Work Orders"
UPLOADS_DIR = ROOT / "storage" / "dev" / "uploads"
DEFAULT_DIVISION = "PPID"

DOMAIN_HINTS: list[tuple[str, str]] = [
    ("cpgrams", "CPGRAMS"),
    ("nesda", "NeSDA"),
    ("scdpm", "SCDPM"),
    ("sanitation", "Sanitation"),
    ("impact", "Impact Assessment"),
    ("dpiit", "DPIIT"),
    ("doppw", "DoPPW"),
    ("media", "Media"),
    ("iedm", "IEDM"),
    ("darpg", "DARPG"),
    ("pmu", "PMU"),
    ("anubhav", "Anubhav"),
]


@dataclass
class ExtractedDoc:
    doc_id: str
    title: str
    ministry: str
    date: str | None
    domains: list[str]
    deliverables: str
    full_text: str
    value_inr: float
    source_path: str
    kind: str  # processed_json | work_order_docx | work_order_pdf | upload_docx | upload_pdf


# --------------------------------------------------------------------------- #
# Extractors
# --------------------------------------------------------------------------- #

def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _rel(path: Path) -> str:
    try:
        return str(path.relative_to(ROOT)).replace("\\", "/")
    except ValueError:
        return str(path).replace("\\", "/")


def _title_from_name(name: str) -> str:
    return re.sub(r"[_\-]+", " ", Path(name).stem).strip()


def _guess_domains(name: str, text: str) -> list[str]:
    blob = f"{name} {text}".lower()
    tags = [label for key, label in DOMAIN_HINTS if key in blob]
    return tags or ["General"]


def _guess_ministry(name: str) -> str:
    up = name.upper()
    if "DARPG" in up:
        return "DARPG / MoPPG related"
    if "DPIIT" in up:
        return "DPIIT"
    if "DOPPW" in up:
        return "DoPPW"
    return "Unknown"


def _extract_docx(path: Path) -> str:
    try:
        import docx  # type: ignore
    except ImportError:
        log.warning("python-docx not installed; skipping %s", path)
        return ""
    try:
        d = docx.Document(str(path))
        parts = [p.text.strip() for p in d.paragraphs if p.text and p.text.strip()]
        for table in d.tables:
            for row in table.rows:
                cells = [c.text.strip() for c in row.cells if c.text and c.text.strip()]
                if cells:
                    parts.append(" | ".join(cells))
        return "\n\n".join(parts)
    except Exception as e:  # noqa: BLE001
        log.warning("docx extract failed for %s: %s", path, e)
        return ""


def _extract_pdf(path: Path, max_pages: int = 60) -> str:
    try:
        from pypdf import PdfReader  # type: ignore
    except ImportError:
        log.warning("pypdf not installed; skipping %s", path)
        return ""
    try:
        reader = PdfReader(str(path))
        parts: list[str] = []
        for page in reader.pages[:max_pages]:
            try:
                t = (page.extract_text() or "").strip()
            except Exception:
                t = ""
            if t:
                parts.append(t)
        return "\n\n".join(parts)
    except Exception as e:  # noqa: BLE001
        log.warning("pypdf extract failed for %s: %s", path, e)
        return ""


def _extract_pdf_with_ocr_fallback(path: Path) -> tuple[str, bool]:
    """Return (text, used_ocr_fallback). If text layer is empty and RunPulse
    is configured, call it; otherwise return a placeholder."""
    text = _extract_pdf(path)
    if text.strip():
        return text, False

    try:
        from . import ocr_runpulse  # noqa: PLC0415  optional
    except ImportError:
        ocr_runpulse = None  # type: ignore[assignment]

    if ocr_runpulse and ocr_runpulse.is_configured():
        try:
            return ocr_runpulse.extract_text(path), True
        except Exception as e:  # noqa: BLE001
            log.warning("RunPulse OCR failed for %s: %s — using placeholder", path, e)

    placeholder = (
        f"PDF work order file: {_title_from_name(path.name)}. "
        "Text layer empty or scanned; RunPulse OCR not yet run for this file."
    )
    return placeholder, False


def _extract_processed_json(path: Path) -> ExtractedDoc:
    raw = json.loads(path.read_text(encoding="utf-8"))
    meta = raw.get("meta") or {}
    content = raw.get("content") or {}
    doc_id = str(raw.get("doc_id") or meta.get("doc_id") or path.stem)
    try:
        value_inr = float(meta.get("value_inr") or 0)
    except (TypeError, ValueError):
        value_inr = 0.0
    return ExtractedDoc(
        doc_id=doc_id,
        title=str(meta.get("project_subject") or doc_id),
        ministry=str(meta.get("ministry") or "Unknown"),
        date=meta.get("date"),
        domains=list(meta.get("domains") or []),
        deliverables=str(meta.get("deliverables") or ""),
        full_text=str(content.get("full_text") or ""),
        value_inr=value_inr,
        source_path=_rel(path),
        kind="processed_json",
    )


def _extract_work_order(path: Path) -> ExtractedDoc:
    ext = path.suffix.lower()
    title = _title_from_name(path.name)
    if ext == ".docx":
        text = _extract_docx(path)
        kind = "work_order_docx"
    elif ext == ".pdf":
        text, _ocr = _extract_pdf_with_ocr_fallback(path)
        kind = "work_order_pdf"
    else:
        text = ""
        kind = "unknown"
    return ExtractedDoc(
        doc_id=path.stem,
        title=title,
        ministry=_guess_ministry(path.name),
        date=None,
        domains=_guess_domains(path.name, text),
        deliverables="",
        full_text=text[:60000],
        value_inr=0.0,
        source_path=_rel(path),
        kind=kind,
    )


def _extract_upload(path: Path, division_hint: str) -> ExtractedDoc:
    ed = _extract_work_order(path)
    ed.kind = "upload_docx" if path.suffix.lower() == ".docx" else "upload_pdf"
    return ed


# --------------------------------------------------------------------------- #
# Discovery
# --------------------------------------------------------------------------- #

def _discover_processed() -> Iterator[Path]:
    if not PROCESSED_DIR.exists():
        return iter(())
    return iter(sorted(PROCESSED_DIR.glob("*.json")))


def _discover_work_orders() -> Iterator[Path]:
    if not WORK_ORDERS_DIR.exists():
        return iter(())
    return (
        p for p in sorted(WORK_ORDERS_DIR.rglob("*"))
        if p.is_file() and p.suffix.lower() in {".docx", ".pdf"} and not p.name.startswith("~$")
    )


def _discover_uploads() -> Iterator[tuple[Path, str]]:
    if not UPLOADS_DIR.exists():
        return iter(())
    out: list[tuple[Path, str]] = []
    for div_dir in sorted(UPLOADS_DIR.iterdir()):
        if not div_dir.is_dir():
            continue
        for p in sorted(div_dir.rglob("*")):
            if p.is_file() and p.suffix.lower() in {".docx", ".pdf"}:
                out.append((p, div_dir.name.upper()))
    return iter(out)


# --------------------------------------------------------------------------- #
# Upsert
# --------------------------------------------------------------------------- #

def _upsert_doc(
    s: Session,
    ed: ExtractedDoc,
    *,
    division_code: str,
    visibility: str = "division_only",
) -> tuple[CorpusDocument, bool]:
    """Return (row, was_reingested)."""
    raw_bytes = ed.full_text.encode("utf-8")
    content_sha = _sha256(raw_bytes)

    existing = s.execute(
        select(CorpusDocument).where(CorpusDocument.doc_id == ed.doc_id)
    ).scalar_one_or_none()

    if existing and existing.content_sha256 == content_sha:
        return existing, False

    # Priority: processed_json > work_order_docx > work_order_pdf/upload.
    # Once we have a JSON extract for a doc_id, don't overwrite it with the
    # raw file's poorer text.
    _priority = {"processed_json": 3, "work_order_docx": 2, "upload_docx": 2, "work_order_pdf": 1, "upload_pdf": 1}
    if existing and _priority.get(existing.kind, 0) > _priority.get(ed.kind, 0):
        return existing, False

    if existing:
        # Reingest: nuke old chunks and rebuild.
        s.execute(delete(CorpusChunk).where(CorpusChunk.document_id == existing.id))
        existing.title = ed.title
        existing.ministry = ed.ministry
        existing.date = ed.date
        existing.domains = ed.domains
        existing.deliverables = ed.deliverables
        existing.value_inr = ed.value_inr
        existing.source_path = ed.source_path
        existing.kind = ed.kind
        existing.content_sha256 = content_sha
        existing.division_code = division_code
        existing.visibility = visibility
        existing.full_text = ed.full_text
        row = existing
    else:
        row = CorpusDocument(
            doc_id=ed.doc_id,
            title=ed.title,
            ministry=ed.ministry,
            date=ed.date,
            domains=ed.domains,
            deliverables=ed.deliverables,
            value_inr=ed.value_inr,
            source_path=ed.source_path,
            kind=ed.kind,
            content_sha256=content_sha,
            division_code=division_code,
            visibility=visibility,
            full_text=ed.full_text,
        )
        s.add(row)
        s.flush()  # need row.id
    return row, True


def _build_chunks(
    s: Session,
    doc_row: CorpusDocument,
    ed: ExtractedDoc,
) -> int:
    combined = "\n\n".join(x for x in [ed.deliverables, ed.full_text] if x and x.strip())
    chunks = chunk_text(combined, title=ed.title)
    if not chunks:
        return 0

    vectors = embed_batch([c.text for c in chunks])
    for c, vec in zip(chunks, vectors, strict=True):
        s.add(
            CorpusChunk(
                document_id=doc_row.id,
                chunk_index=c.chunk_index,
                section_label=c.section_label,
                text=c.text,
                token_set=None,  # BM25-lite computed at query time
                division_code=doc_row.division_code,
                embedding=to_storage(vec, IS_POSTGRES),
            )
        )
    return len(chunks)


def ingest_one(
    session: Session,
    ed: ExtractedDoc,
    *,
    division_code: str = DEFAULT_DIVISION,
    visibility: str = "division_only",
) -> dict[str, object]:
    row, changed = _upsert_doc(session, ed, division_code=division_code, visibility=visibility)
    n_chunks = _build_chunks(session, row, ed) if changed else 0
    return {
        "doc_id": row.doc_id,
        "changed": changed,
        "chunks": n_chunks,
        "kind": row.kind,
    }


# --------------------------------------------------------------------------- #
# Orchestrator
# --------------------------------------------------------------------------- #

def ingest_all(
    *,
    division_code: str = DEFAULT_DIVISION,
    only_source: str | None = None,
) -> dict[str, object]:
    """Bootstrap the whole corpus. Idempotent.

    only_source: repo-relative or absolute path to a single file to ingest.
    """
    session = SessionLocal()
    stats: dict[str, int] = {
        "processed_json": 0,
        "work_order_docx": 0,
        "work_order_pdf": 0,
        "upload_docx": 0,
        "upload_pdf": 0,
        "unchanged": 0,
        "chunks_added": 0,
    }
    errors: list[str] = []

    try:
        targets: list[tuple[ExtractedDoc, str]] = []
        if only_source:
            path = Path(only_source)
            if not path.is_absolute():
                path = ROOT / only_source
            if not path.exists():
                raise FileNotFoundError(only_source)
            if path.suffix.lower() == ".json":
                targets.append((_extract_processed_json(path), division_code))
            elif path.suffix.lower() in {".docx", ".pdf"}:
                targets.append((_extract_work_order(path), division_code))
        else:
            for jp in _discover_processed():
                targets.append((_extract_processed_json(jp), division_code))
            for wp in _discover_work_orders():
                targets.append((_extract_work_order(wp), division_code))
            for up, div_hint in _discover_uploads():
                targets.append((_extract_upload(up, div_hint), div_hint or division_code))

        for ed, div in targets:
            try:
                res = ingest_one(session, ed, division_code=div)
                if res["changed"]:
                    stats[str(res["kind"])] = stats.get(str(res["kind"]), 0) + 1
                    stats["chunks_added"] += int(res["chunks"])
                else:
                    stats["unchanged"] += 1
            except Exception as e:  # noqa: BLE001
                errors.append(f"{ed.source_path}: {e}")
                session.rollback()
        session.commit()
    finally:
        session.close()

    return {"stats": stats, "errors": errors}


def _cli() -> None:
    parser = argparse.ArgumentParser(description="CFC corpus ingestion")
    parser.add_argument("--division", default=DEFAULT_DIVISION, help="Division code for the default bulk ingest")
    parser.add_argument("--source", default=None, help="Single file to ingest (relative to repo root)")
    parser.add_argument("--verbose", action="store_true")
    args = parser.parse_args()

    logging.basicConfig(
        level=logging.INFO if args.verbose else logging.WARNING,
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )
    res = ingest_all(division_code=args.division, only_source=args.source)
    print(json.dumps(res, indent=2, default=str))


if __name__ == "__main__":
    _cli()
