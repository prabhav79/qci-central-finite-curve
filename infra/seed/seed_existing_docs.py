"""Phase 0 seed: push the existing 24 processed JSONs into Postgres + embed their chunks.

Usage (from repo root, with all env vars set — DATABASE_URL etc.):

    python -m infra.seed.seed_existing_docs

Idempotent: keyed on SHA-256 of the source PDF bytes. Running twice is a no-op.

After this runs, `documents` contains 24 rows (status=ready) and `document_chunks`
holds the 768-dim Gemini embeddings ready for the search + generation endpoints.
"""
from __future__ import annotations

import hashlib
import json
import sys
from datetime import date, datetime
from pathlib import Path

from sqlalchemy import select
from sqlalchemy.orm import Session

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from backend.db.models import Document, DocumentChunk, DocumentStatus  # noqa: E402
from backend.db.session import get_engine  # noqa: E402
from backend.llm.embeddings import embed_texts  # noqa: E402
from backend.rag.chunking import chunk_text  # noqa: E402

PROCESSED_DIR = REPO_ROOT / "data" / "processed"
PDF_DIRS = [REPO_ROOT / "Work Orders", REPO_ROOT / "static" / "pdfs"]


def _find_pdf(doc_id: str) -> Path | None:
    for d in PDF_DIRS:
        p = d / f"{doc_id}.pdf"
        if p.exists():
            return p
    return None


def _sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def _parse_date(raw: str | None) -> datetime | None:
    if not raw:
        return None
    raw = raw.strip()
    # The existing JSONs use ISO yyyy-mm-dd.
    for fmt in ("%Y-%m-%d", "%Y/%m/%d", "%d-%m-%Y", "%d/%m/%Y"):
        try:
            return datetime.strptime(raw, fmt)
        except ValueError:
            continue
    return None


def _blob_key(pdf: Path) -> str:
    return str(pdf.relative_to(REPO_ROOT)).replace("\\", "/")


def seed(db: Session) -> dict[str, int]:
    counters = {"total": 0, "skipped_missing_pdf": 0, "skipped_already_ingested": 0, "inserted": 0, "chunks_inserted": 0}

    json_files = sorted(PROCESSED_DIR.glob("*.json"))
    counters["total"] = len(json_files)
    print(f"Found {len(json_files)} processed JSONs under {PROCESSED_DIR}")

    for jpath in json_files:
        with open(jpath, "r", encoding="utf-8") as f:
            doc = json.load(f)

        doc_id = doc["doc_id"]
        pdf = _find_pdf(doc_id)
        if pdf is None:
            print(f"  SKIP (no PDF found): {doc_id}")
            counters["skipped_missing_pdf"] += 1
            continue

        sha = _sha256_file(pdf)
        existing = db.execute(select(Document).where(Document.sha256 == sha)).scalar_one_or_none()
        if existing is not None:
            print(f"  SKIP (sha already in DB): {doc_id}")
            counters["skipped_already_ingested"] += 1
            continue

        meta = doc.get("meta", {}) or {}
        content = doc.get("content", {}) or {}
        full_text = content.get("full_text") or ""

        record = Document(
            doc_id=doc_id,
            sha256=sha,
            filename=pdf.name,
            mime="application/pdf",
            size_bytes=pdf.stat().st_size,
            blob_key=_blob_key(pdf),
            ministry=meta.get("ministry"),
            project=meta.get("project_subject") or None,
            issued_on=_parse_date(meta.get("date")),
            value_inr=float(meta.get("value_inr") or 0) or None,
            project_subject=meta.get("project_subject") or None,
            deliverables=meta.get("deliverables") or None,
            full_text=full_text or None,
            status=DocumentStatus.processing,
            version=1,
        )
        db.add(record)
        db.flush()  # get record.id assigned

        # Chunk + embed if we have text
        if full_text.strip():
            chunks = chunk_text(full_text)
            if chunks:
                texts = [c.text for c in chunks]
                vectors = embed_texts(texts)
                for c, v in zip(chunks, vectors, strict=True):
                    db.add(
                        DocumentChunk(
                            document_id=record.id,
                            chunk_index=c.index,
                            text=c.text,
                            embedding=v,
                            tokens=c.approx_tokens,
                        )
                    )
                counters["chunks_inserted"] += len(chunks)

        record.status = DocumentStatus.ready
        db.commit()
        counters["inserted"] += 1
        print(f"  OK: {doc_id}  ({len(full_text)} chars, {counters['chunks_inserted']} total chunks)")

    return counters


def main() -> int:
    engine = get_engine()
    with Session(engine) as db:
        counters = seed(db)

    print()
    print("=== Seed summary ===")
    for k, v in counters.items():
        print(f"  {k:30s} {v}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
