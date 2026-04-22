"""Institutional knowledge ingestion service.

Ported from legacy `src/runpulse_ingestion.py`.
Orchestrates: RunPulse (OCR/Layout) -> Chunking -> Embeddings -> Vector DB.
"""
from __future__ import annotations

import hashlib
import logging
import os
import time
from datetime import datetime
from pathlib import Path
from typing import BinaryIO
from uuid import UUID

from pulse import Pulse
from sqlalchemy.orm import Session

from backend.config import get_settings
from backend.db.models import (
    Document,
    DocumentChunk,
    DocumentStatus,
    IngestItemStatus,
    IngestJob,
    IngestJobItem,
)
from backend.llm.embeddings import embed_query
from backend.rag.chunking import chunk_text

log = logging.getLogger(__name__)

# Simplified schema based on legacy src/runpulse_ingestion.py
WORK_ORDER_SCHEMA = {
    "type": "object",
    "properties": {
        "ministry": {"type": "string"},
        "date": {"type": "string"},
        "value_inr": {"type": "number"},
        "project_subject": {"type": "string"},
        "deliverables": {"type": "string"},
        "full_text_summary": {"type": "string"},
    },
}

def get_sha256(file_obj: BinaryIO) -> str:
    """Read file in 64kb chunks to get sha256 hex digest."""
    sha256 = hashlib.sha256()
    file_obj.seek(0)
    while True:
        data = file_obj.read(65536)
        if not data:
            break
        sha256.update(data)
    file_obj.seek(0)
    return sha256.hexdigest()

def process_ingest_item(
    db: Session,
    job_id: UUID,
    item_id: UUID,
    file_path: str,
):
    """The background pipeline for a single file in a batch."""
    settings = get_settings()
    pulse_client = Pulse(api_key=settings.runpulse_api_key)
    
    item = db.query(IngestJobItem).get(item_id)
    if not item:
        return
    
    job = db.query(IngestJob).get(job_id)
    if not job:
        return

    item.status = IngestItemStatus.processing
    db.commit()

    doc_id = Path(file_path).stem
    
    try:
        # 1. Deduplication
        with open(file_path, "rb") as f:
            file_sha = get_sha256(f)
        
        existing = db.query(Document).filter(Document.sha256 == file_sha).first()
        if existing:
            item.status = IngestItemStatus.ready
            item.document_id = existing.id
            job.completed += 1
            db.commit()
            return

        # 2. Extract Document (RunPulse)
        log.info(f"Uploading {doc_id} to RunPulse...")
        with open(file_path, "rb") as f:
            resp = pulse_client.extract(file=f)
        
        extraction_id = resp.extraction_id
        
        # 3. Apply Schema (Structured Data)
        log.info(f"Applying QCI Schema to {extraction_id}...")
        schema_resp = pulse_client.schema(
            extraction_id=extraction_id,
            schema_config={"input_schema": WORK_ORDER_SCHEMA},
        )
        data = schema_resp.schema_output.values

        # 4. Create Document Record
        issued_on = None
        if data.get("date"):
            try:
                issued_on = datetime.fromisoformat(data["date"])
            except ValueError:
                pass

        doc = Document(
            doc_id=doc_id,
            sha256=file_sha,
            filename=item.source_filename,
            mime="application/pdf",
            size_bytes=os.path.getsize(file_path),
            ministry=data.get("ministry"),
            project=data.get("project_subject"),
            issued_on=issued_on,
            value_inr=float(data.get("value_inr") or 0.0),
            project_subject=data.get("project_subject"),
            deliverables=data.get("deliverables"),
            full_text=data.get("full_text_summary"),
            status=DocumentStatus.processing,
        )
        db.add(doc)
        db.flush() # Get doc.id

        # 5. Chunk and Embed
        text_content = data.get("full_text_summary") or ""
        if not text_content:
            # Fallback if summary is empty
            text_content = f"Project: {data.get('project_subject')}\nMinistry: {data.get('ministry')}"

        chunks = chunk_text(text_content)
        for chunk_data in chunks:
            embedding = embed_query(chunk_data.text)
            chunk = DocumentChunk(
                document_id=doc.id,
                chunk_index=chunk_data.index,
                text=chunk_data.text,
                embedding=embedding,
            )
            db.add(chunk)
        
        doc.status = DocumentStatus.ready
        item.status = IngestItemStatus.ready
        item.document_id = doc.id
        job.completed += 1
        db.commit()

    except Exception as e:
        log.exception(f"Ingestion failed for {doc_id}")
        item.status = IngestItemStatus.failed
        item.error = str(e)
        job.failed += 1
        db.commit()
    
    finally:
        # Check if job is done
        if job.completed + job.failed + job.flagged >= job.total_files:
            job.finished_at = datetime.now()
            db.commit()
