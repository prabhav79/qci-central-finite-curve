"""SQLAlchemy models for the Phase 0 schema.

Tables (per the approved implementation plan, section 0.2):
- documents            : one row per unique source document (dedup via sha256)
- document_chunks      : chunk-level embeddings (pgvector 768-dim)
- ingest_jobs          : one row per folder-drop / batch
- ingest_job_items     : one row per file inside a job
- generations          : every LLM-produced draft with prompt + sources
- audit_log            : append-only event log (made INSERT-only in Phase 3)

Forward-compat notes:
- users.role/managed_by are added in Phase 2. We leave uploaded_by / user_id
  columns *nullable* on documents/generations/audit_log so the demo account can
  write Phase 0 rows with NULL and Phase 2 backfills the FK.
- IVFFlat index on document_chunks.embedding is intentionally NOT created in the
  initial migration: pgvector recommends building the index after seeding
  (the index's cluster centres are chosen from existing data).
"""
from __future__ import annotations

import enum
import uuid
from datetime import datetime

from pgvector.sqlalchemy import Vector
from sqlalchemy import (
    BigInteger,
    Boolean,
    DateTime,
    Enum,
    ForeignKey,
    Integer,
    Numeric,
    String,
    Text,
    UniqueConstraint,
    func,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from backend.db.base import Base


# ---------------------------------------------------------------------------
# Enums
# ---------------------------------------------------------------------------


class DocumentStatus(str, enum.Enum):
    queued = "queued"
    processing = "processing"
    ready = "ready"
    flagged = "flagged"
    failed = "failed"


class IngestItemStatus(str, enum.Enum):
    queued = "queued"
    processing = "processing"
    ready = "ready"
    flagged = "flagged"
    failed = "failed"


# ---------------------------------------------------------------------------
# documents
# ---------------------------------------------------------------------------


class Document(Base):
    __tablename__ = "documents"
    __table_args__ = (UniqueConstraint("sha256", name="uq_documents_sha256"),)

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    doc_id: Mapped[str] = mapped_column(String(512), unique=True, index=True)
    sha256: Mapped[str] = mapped_column(String(64), index=True)

    filename: Mapped[str] = mapped_column(String(1024))
    mime: Mapped[str | None] = mapped_column(String(128), nullable=True)
    size_bytes: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    blob_key: Mapped[str | None] = mapped_column(String(1024), nullable=True)

    # Classification (filled by RunPulse schema or rule-based classifier)
    ministry: Mapped[str | None] = mapped_column(String(512), nullable=True, index=True)
    project: Mapped[str | None] = mapped_column(String(512), nullable=True, index=True)
    division: Mapped[str | None] = mapped_column(String(256), nullable=True)
    issued_on: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    value_inr: Mapped[float | None] = mapped_column(Numeric(18, 2), nullable=True)

    project_subject: Mapped[str | None] = mapped_column(Text, nullable=True)
    deliverables: Mapped[str | None] = mapped_column(Text, nullable=True)
    full_text: Mapped[str | None] = mapped_column(Text, nullable=True)

    status: Mapped[DocumentStatus] = mapped_column(
        Enum(DocumentStatus, name="document_status"),
        default=DocumentStatus.queued,
        nullable=False,
        index=True,
    )
    flag_reason: Mapped[str | None] = mapped_column(String(256), nullable=True)

    # Version-lineage: v2 supersedes v1, etc.
    version: Mapped[int] = mapped_column(Integer, default=1, nullable=False)
    supersedes_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("documents.id", ondelete="SET NULL"), nullable=True
    )

    # Nullable until Phase 2 when users table lands; backfilled to the demo user.
    uploaded_by_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False
    )

    chunks: Mapped[list["DocumentChunk"]] = relationship(
        back_populates="document", cascade="all, delete-orphan"
    )


# ---------------------------------------------------------------------------
# document_chunks (vector(768))
# ---------------------------------------------------------------------------


class DocumentChunk(Base):
    __tablename__ = "document_chunks"
    __table_args__ = (
        UniqueConstraint("document_id", "chunk_index", name="uq_document_chunks_document_id_chunk_index"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    document_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("documents.id", ondelete="CASCADE"), nullable=False, index=True
    )
    chunk_index: Mapped[int] = mapped_column(Integer, nullable=False)

    text: Mapped[str] = mapped_column(Text, nullable=False)
    embedding: Mapped[list[float] | None] = mapped_column(Vector(768), nullable=True)
    tokens: Mapped[int | None] = mapped_column(Integer, nullable=True)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    document: Mapped[Document] = relationship(back_populates="chunks")


# ---------------------------------------------------------------------------
# ingest_jobs + ingest_job_items
# ---------------------------------------------------------------------------


class IngestJob(Base):
    __tablename__ = "ingest_jobs"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    started_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    total_files: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    completed: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    failed: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    flagged: Mapped[int] = mapped_column(Integer, default=0, nullable=False)

    # Nullable until Phase 2
    user_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True)

    items: Mapped[list["IngestJobItem"]] = relationship(
        back_populates="job", cascade="all, delete-orphan"
    )


class IngestJobItem(Base):
    __tablename__ = "ingest_job_items"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    job_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("ingest_jobs.id", ondelete="CASCADE"), nullable=False, index=True
    )
    source_filename: Mapped[str] = mapped_column(String(1024), nullable=False)
    status: Mapped[IngestItemStatus] = mapped_column(
        Enum(IngestItemStatus, name="ingest_item_status"),
        default=IngestItemStatus.queued,
        nullable=False,
    )
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    document_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("documents.id", ondelete="SET NULL"), nullable=True
    )

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False
    )

    job: Mapped[IngestJob] = relationship(back_populates="items")


# ---------------------------------------------------------------------------
# generations (every LLM draft)
# ---------------------------------------------------------------------------


class Generation(Base):
    __tablename__ = "generations"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    doc_type: Mapped[str] = mapped_column(String(32), nullable=False)  # 'work_order' | 'proposal'
    prompt: Mapped[str] = mapped_column(Text, nullable=False)
    draft_md: Mapped[str] = mapped_column(Text, nullable=False)
    sources_json: Mapped[dict | None] = mapped_column(JSONB, nullable=True)

    exported_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    # Nullable until Phase 2
    user_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )


# ---------------------------------------------------------------------------
# audit_log (append-only; INSERT-only DB role added in Phase 3)
# ---------------------------------------------------------------------------


class AuditLog(Base):
    __tablename__ = "audit_log"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    action: Mapped[str] = mapped_column(String(128), nullable=False, index=True)
    resource_type: Mapped[str | None] = mapped_column(String(128), nullable=True, index=True)
    resource_id: Mapped[str | None] = mapped_column(String(128), nullable=True)
    ip: Mapped[str | None] = mapped_column(String(64), nullable=True)
    user_agent: Mapped[str | None] = mapped_column(Text, nullable=True)
    extra: Mapped[dict | None] = mapped_column(JSONB, nullable=True)

    # Nullable until Phase 2
    user_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False, index=True
    )
