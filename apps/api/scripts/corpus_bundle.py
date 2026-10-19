"""
Export / import the corpus (documents, chunks with embeddings, graph edges)
as one gzip-compressed JSON bundle, so a corpus built and checked locally can
be swapped into staging/production in a single transaction — no re-extraction,
re-OCR or re-classification on the server, and the previous corpus can be
restored the same way.

Run from apps/api against whatever DATABASE_URL points at:
    python scripts/corpus_bundle.py export ../../data/corpus_bundle.json.gz
    python scripts/corpus_bundle.py import ../../data/corpus_bundle.json.gz --dry-run
    python scripts/corpus_bundle.py import ../../data/corpus_bundle.json.gz
Drafts, users and audit logs are never touched.
"""
from __future__ import annotations

import argparse
import gzip
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from sqlalchemy import delete, func, select  # noqa: E402

from app.db import IS_POSTGRES, SessionLocal  # noqa: E402
from app.embeddings import from_storage, to_storage  # noqa: E402
from app.models import CorpusChunk, CorpusDocument, CorpusEdge  # noqa: E402

DOC_FIELDS = [
    "doc_id", "title", "ministry", "date", "domains", "deliverables", "value_inr", "storage_key",
    "source_path", "kind", "content_sha256", "division_code", "visibility", "full_text", "outcome",
    "injection_flag",
]


def export_bundle(path: Path) -> None:
    with SessionLocal() as s:
        docs = []
        for d in s.execute(select(CorpusDocument).order_by(CorpusDocument.doc_id)).scalars():
            chunks = sorted(d.chunks, key=lambda c: c.chunk_index)
            docs.append(
                {
                    **{f: getattr(d, f) for f in DOC_FIELDS},
                    "chunks": [
                        {
                            "chunk_index": c.chunk_index,
                            "section_label": c.section_label,
                            "text": c.text,
                            "division_code": c.division_code,
                            "embedding": [round(float(x), 6) for x in (from_storage(c.embedding, IS_POSTGRES) or [])],
                        }
                        for c in chunks
                    ],
                }
            )
        edges = [
            {"doc_id_a": e.doc_id_a, "doc_id_b": e.doc_id_b, "weight": e.weight}
            for e in s.execute(select(CorpusEdge).order_by(CorpusEdge.doc_id_a, CorpusEdge.doc_id_b)).scalars()
        ]
    bundle = {"version": 1, "documents": docs, "edges": edges}
    path.parent.mkdir(parents=True, exist_ok=True)
    with gzip.open(path, "wt", encoding="utf-8") as fh:
        json.dump(bundle, fh, ensure_ascii=False, default=str)
    n_chunks = sum(len(d["chunks"]) for d in docs)
    print(f"exported {len(docs)} documents, {n_chunks} chunks, {len(edges)} edges -> {path} ({path.stat().st_size // 1024} KB)")


def import_bundle(path: Path, dry_run: bool) -> None:
    with gzip.open(path, "rt", encoding="utf-8") as fh:
        bundle = json.load(fh)
    docs = bundle["documents"]
    edges = bundle["edges"]
    expected_chunks = sum(len(d["chunks"]) for d in docs)
    with SessionLocal() as s:
        before = (
            s.scalar(select(func.count(CorpusDocument.id))),
            s.scalar(select(func.count(CorpusChunk.id))),
            s.scalar(select(func.count(CorpusEdge.id))),
        )
        s.execute(delete(CorpusChunk))
        s.execute(delete(CorpusDocument))
        s.execute(delete(CorpusEdge))
        for d in docs:
            row = CorpusDocument(**{f: d.get(f) for f in DOC_FIELDS})
            s.add(row)
            s.flush()
            for c in d["chunks"]:
                s.add(
                    CorpusChunk(
                        document_id=row.id,
                        chunk_index=c["chunk_index"],
                        section_label=c["section_label"],
                        text=c["text"],
                        division_code=c["division_code"],
                        embedding=to_storage(c["embedding"], IS_POSTGRES) if c["embedding"] else None,
                    )
                )
        for e in edges:
            s.add(CorpusEdge(**e))
        s.flush()
        after = (
            s.scalar(select(func.count(CorpusDocument.id))),
            s.scalar(select(func.count(CorpusChunk.id))),
            s.scalar(select(func.count(CorpusEdge.id))),
        )
        if after != (len(docs), expected_chunks, len(edges)):
            s.rollback()
            sys.exit(f"count mismatch after import {after} vs bundle {(len(docs), expected_chunks, len(edges))}; rolled back")
        if dry_run:
            s.rollback()
            print(f"dry run OK: would replace {before} with {after} (documents, chunks, edges)")
        else:
            s.commit()
            print(f"imported: replaced {before} with {after} (documents, chunks, edges)")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("action", choices=["export", "import"])
    ap.add_argument("path")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()
    path = Path(args.path).resolve()
    if args.action == "export":
        export_bundle(path)
    else:
        import_bundle(path, args.dry_run)


if __name__ == "__main__":
    main()
