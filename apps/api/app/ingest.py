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
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Iterator

from dotenv import load_dotenv
from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from . import jev_client
from .chunking import chunk_text
from .db import IS_POSTGRES, ROOT, SessionLocal
from .embeddings import embed_batch, to_storage
from .models import CorpusChunk, CorpusDocument, IngestionJob, IngestionQuota

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
    runpulse_pages: int = 0  # >0 only when this extraction used RunPulse OCR


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


_MINISTRY_OPTIONS = {
    "DARPG / MoPPG related": "Mentions DARPG, MoPPG, or Department of Administrative Reforms and Public Grievances",
    "DPIIT": "Mentions DPIIT or Department for Promotion of Industry and Internal Trade",
    "DoPPW": "Mentions DoPPW or Department of Pension and Pensioners' Welfare",
    "Unknown": "None of the above ministries are clearly indicated",
}


def _jev_classify(name: str, text: str) -> tuple[list[str] | None, str | None]:
    """Batched domain (one noul per DOMAIN_HINTS entry) + ministry (one
    choice) classification via Jev, replacing the filename/keyword guess
    with an actual read of the document when TYPESAFE_API_KEY is set.

    Sends document text (title + first ~4000 chars) to api.typesafe.ai —
    only runs with Aashna's explicit sign-off (2026-09-28) that this is
    acceptable given the division/board visibility silo elsewhere in this
    project; see the plan's item 6a for the reasoning.

    Returns (None, None) — never partial — if Jev isn't configured or the
    call fails for any reason, so the caller falls straight back to
    _guess_domains/_guess_ministry with zero behavior change. This is a
    quality enhancement, not a dependency ingestion can fail on.
    """
    if not text.strip() or not jev_client.is_configured():
        return None, None

    state = f"Filename: {name}\n\n{text[:4000]}"
    questions: dict[str, dict] = {
        f"domain::{key}": {
            "type": "noul",
            "instructions": f"Does this government work-order document relate to {label}?",
        }
        for key, label in DOMAIN_HINTS
    }
    questions["ministry"] = {
        "type": "choice",
        "instructions": "Which ministry/department does this work order relate to?",
        "criteria": dict(_MINISTRY_OPTIONS),
    }

    try:
        answers = jev_client.evaluate(state, questions)
        domains = [
            label
            for key, label in DOMAIN_HINTS
            if answers.get(f"domain::{key}", {}).get("noul", 0) >= 0.5
        ]
        ministry_answer = answers.get("ministry", {}).get("choice")
        ministry = ministry_answer if ministry_answer in _MINISTRY_OPTIONS else None
        return (domains or None), ministry
    except Exception as e:  # noqa: BLE001
        log.warning("Jev classify failed for %s: %s — falling back to keyword heuristic", name, e)
        return None, None


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


def _pdf_page_count(path: Path) -> int:
    try:
        from pypdf import PdfReader  # type: ignore

        return len(PdfReader(str(path)).pages)
    except Exception:  # noqa: BLE001
        return 0


def _extract_pdf_with_ocr_fallback(path: Path) -> tuple[str, bool, int]:
    """Return (text, used_ocr_fallback, pages_billed). If text layer is empty
    and RunPulse is configured, call it; otherwise return a placeholder."""
    text = _extract_pdf(path)
    if text.strip():
        return text, False, 0

    try:
        from . import ocr_runpulse  # noqa: PLC0415  optional
    except ImportError:
        ocr_runpulse = None  # type: ignore[assignment]

    if ocr_runpulse and ocr_runpulse.is_configured():
        try:
            return ocr_runpulse.extract_text(path), True, _pdf_page_count(path)
        except Exception as e:  # noqa: BLE001
            log.warning("RunPulse OCR failed for %s: %s — using placeholder", path, e)

    placeholder = (
        f"PDF work order file: {_title_from_name(path.name)}. "
        "Text layer empty or scanned; RunPulse OCR not yet run for this file."
    )
    return placeholder, False, 0


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
    pages = 0
    if ext == ".docx":
        text = _extract_docx(path)
        kind = "work_order_docx"
    elif ext == ".pdf":
        text, _ocr, pages = _extract_pdf_with_ocr_fallback(path)
        kind = "work_order_pdf"
    else:
        text = ""
        kind = "unknown"
    jev_domains, jev_ministry = _jev_classify(path.name, text)
    return ExtractedDoc(
        doc_id=path.stem,
        title=title,
        ministry=jev_ministry or _guess_ministry(path.name),
        date=None,
        domains=jev_domains or _guess_domains(path.name, text),
        deliverables="",
        full_text=text[:60000],
        value_inr=0.0,
        source_path=_rel(path),
        kind=kind,
        runpulse_pages=pages,
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


# --------------------------------------------------------------------------- #
# Job queue (survives a redeploy mid-run — see plan item 6)
# --------------------------------------------------------------------------- #

_STALE_RUNNING_AFTER = timedelta(minutes=30)


def _hash_file(path: Path) -> str:
    """Raw-bytes hash — no parsing/OCR — so the discovery walk stays cheap."""
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for block in iter(lambda: fh.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def enqueue_jobs(session: Session, *, division_code: str = DEFAULT_DIVISION) -> dict[str, int]:
    """Cheap discovery walk: stat+hash each source file and upsert a pending
    ingestion_jobs row when new or changed. Never extracts/OCRs — that's the
    worker's job. Safe to call repeatedly (e.g. on every /corpus/reindex);
    an unchanged, already-claimed, or already-done file is left alone so
    re-enqueuing never resets a job's attempts/status by itself."""
    counts = {"enqueued": 0, "requeued": 0, "unchanged": 0, "skipped": 0}

    def _upsert(path: Path, source_kind: str, div: str) -> None:
        rel = _rel(path)
        try:
            file_hash = _hash_file(path)
        except OSError as e:
            log.warning("enqueue: cannot read %s: %s", path, e)
            counts["skipped"] += 1
            return
        existing = session.execute(
            select(IngestionJob).where(IngestionJob.source_path == rel)
        ).scalar_one_or_none()
        if existing is None:
            session.add(
                IngestionJob(
                    source_path=rel,
                    source_kind=source_kind,
                    division_code=div,
                    status="pending",
                    content_sha256=file_hash,
                )
            )
            counts["enqueued"] += 1
        elif existing.content_sha256 != file_hash:
            existing.content_sha256 = file_hash
            existing.status = "pending"
            existing.attempts = 0
            existing.last_error = None
            existing.division_code = div
            existing.source_kind = source_kind
            counts["requeued"] += 1
        else:
            counts["unchanged"] += 1

    for jp in _discover_processed():
        _upsert(jp, "processed_json", division_code)
    for wp in _discover_work_orders():
        _upsert(wp, "work_order", division_code)
    for up, div_hint in _discover_uploads():
        _upsert(up, "upload", div_hint or division_code)

    session.commit()
    return counts


def reset_stale_jobs(session: Session) -> int:
    """Crash recovery: a job stuck 'running' past a staleness threshold (the
    API got redeployed mid-job) goes back to 'pending'. Call on API startup."""
    cutoff = datetime.now(timezone.utc) - _STALE_RUNNING_AFTER
    stale = session.execute(
        select(IngestionJob).where(IngestionJob.status == "running", IngestionJob.claimed_at < cutoff)
    ).scalars().all()
    for job in stale:
        job.status = "pending"
        job.claimed_by = None
        job.claimed_at = None
    if stale:
        session.commit()
    return len(stale)


def claim_next_job(session: Session, worker_id: str) -> IngestionJob | None:
    """Claim one pending job. Postgres uses FOR UPDATE SKIP LOCKED so
    concurrent workers never double-claim; SQLite (single-process dev) just
    claims directly — SKIP LOCKED isn't valid SQLite syntax."""
    q = select(IngestionJob).where(IngestionJob.status == "pending").order_by(IngestionJob.created_at).limit(1)
    if IS_POSTGRES:
        q = q.with_for_update(skip_locked=True)
    row = session.execute(q).scalar_one_or_none()
    if row is None:
        return None
    now = datetime.now(timezone.utc)
    row.status = "running"
    row.claimed_by = worker_id
    row.claimed_at = now
    row.started_at = now
    session.commit()
    return row


def _extracted_doc_for_job(job: IngestionJob) -> ExtractedDoc:
    path = ROOT / job.source_path
    if job.source_kind == "processed_json":
        return _extract_processed_json(path)
    if job.source_kind == "upload":
        return _extract_upload(path, job.division_code)
    return _extract_work_order(path)


def process_job(session: Session, job: IngestionJob) -> None:
    """Extract → OCR-fallback → chunk → embed → upsert for one claimed job.
    Failure increments attempts and requeues (pending) until max_attempts,
    then parks the job as 'error' rather than retrying forever."""
    try:
        ed = _extracted_doc_for_job(job)
        ingest_one(session, ed, division_code=job.division_code)
        if ed.runpulse_pages:
            quota = session.get(IngestionQuota, 1)
            if quota:
                quota.runpulse_pages_used_total += ed.runpulse_pages
            job.runpulse_pages_used = ed.runpulse_pages
        job.status = "done"
        job.last_error = None
        job.finished_at = datetime.now(timezone.utc)
        session.commit()
    except Exception as e:  # noqa: BLE001
        session.rollback()
        job.attempts += 1
        job.last_error = f"{type(e).__name__}: {e}"[:2000]
        job.finished_at = datetime.now(timezone.utc)
        job.status = "pending" if job.attempts < job.max_attempts else "error"
        session.commit()


def run_worker_pool(*, n_workers: int | None = None, max_jobs: int | None = None) -> dict[str, int]:
    """Drains the ingestion_jobs queue using a small pool of threads, each
    with its own DB session — I/O-bound work (embeddings + RunPulse HTTP
    calls), so real threads help despite the GIL. No new infra (no
    Redis/Celery) needed at this scale."""
    import threading

    n = n_workers or int(os.environ.get("CFC_INGEST_WORKERS", "3"))
    totals = {"done": 0, "error": 0, "retrying": 0}
    lock = threading.Lock()

    def _worker(worker_id: str) -> None:
        session = SessionLocal()
        try:
            while True:
                with lock:
                    if max_jobs is not None and sum(totals.values()) >= max_jobs:
                        return
                job = claim_next_job(session, worker_id)
                if job is None:
                    return
                process_job(session, job)
                bucket = job.status if job.status == "done" else ("error" if job.status == "error" else "retrying")
                with lock:
                    totals[bucket] += 1
        finally:
            session.close()

    threads = [threading.Thread(target=_worker, args=(f"worker-{i}",), daemon=True) for i in range(n)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    return totals


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
