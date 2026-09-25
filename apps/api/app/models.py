"""
CFC ORM models — division-tagged throughout.

Every user-visible table (drafts, documents, chunks, threads, audit_logs)
carries division_code so retrieval, listing, and approvals can filter by
the caller's board/division. See project-cfc-visibility-rule.

Sprint 1 uses SQLite in dev; Sprint 3 flips the default to Postgres so
the pgvector embedding column becomes queryable. On SQLite the embedding
column stores raw bytes as a placeholder (not queryable).
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Optional

from sqlalchemy import (
    JSON,
    Boolean,
    DateTime,
    Float,
    ForeignKey,
    Index,
    Integer,
    LargeBinary,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .db import Base, IS_POSTGRES

# Embedding column type — real Vector on Postgres, blob placeholder on SQLite dev.
if IS_POSTGRES:
    from pgvector.sqlalchemy import Vector  # type: ignore[import-not-found]

    EmbeddingType = Vector(384)  # all-MiniLM-L6-v2
else:
    EmbeddingType = LargeBinary  # type: ignore[assignment]


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


class Division(Base):
    """QCI boards/divisions. Every content row is scoped to one."""

    __tablename__ = "divisions"

    code: Mapped[str] = mapped_column(String(32), primary_key=True)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    kind: Mapped[str] = mapped_column(String(32), default="division", nullable=False)  # division|board|corporate
    is_apex_scope: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow, nullable=False)


class User(Base):
    __tablename__ = "users"

    employee_id: Mapped[str] = mapped_column(String(16), primary_key=True)
    full_name: Mapped[str] = mapped_column(String(200), nullable=False)
    email: Mapped[str] = mapped_column(String(200), unique=True, nullable=False)
    designation: Mapped[Optional[str]] = mapped_column(String(200))
    cfc_role: Mapped[str] = mapped_column(String(32), nullable=False)  # apex|admin|l2_approver|l1_approver|maker|reader
    division_code: Mapped[Optional[str]] = mapped_column(
        String(32), ForeignKey("divisions.code", ondelete="SET NULL")
    )
    manager_employee_id: Mapped[Optional[str]] = mapped_column(
        String(16), ForeignKey("users.employee_id", ondelete="SET NULL")
    )
    is_admin: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow, nullable=False)

    manager: Mapped[Optional["User"]] = relationship("User", remote_side="User.employee_id", foreign_keys=[manager_employee_id])
    division: Mapped[Optional[Division]] = relationship(Division)


class Draft(Base):
    __tablename__ = "drafts"

    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    title: Mapped[str] = mapped_column(String(400), nullable=False)
    template_code: Mapped[str] = mapped_column(String(64), nullable=False)
    maker_employee_id: Mapped[str] = mapped_column(
        String(16), ForeignKey("users.employee_id", ondelete="RESTRICT"), nullable=False
    )
    division_code: Mapped[str] = mapped_column(
        String(32), ForeignKey("divisions.code", ondelete="RESTRICT"), nullable=False
    )
    status: Mapped[str] = mapped_column(String(32), default="DRAFT", nullable=False)
    current_version: Mapped[int] = mapped_column(Integer, default=1, nullable=False)
    submitted_version: Mapped[Optional[int]] = mapped_column(Integer)
    final_storage_key: Mapped[Optional[str]] = mapped_column(String(400))
    final_sha256: Mapped[Optional[str]] = mapped_column(String(64))
    worker_meta: Mapped[Optional[dict[str, Any]]] = mapped_column(JSON)
    # Ordered [[section_label, section_title], ...] driving draft_generator —
    # set at creation from the chosen template's catalog outline, or derived
    # from an existing corpus document's chunk section_labels. Null means
    # "use the default GENERATION_SECTIONS" (older drafts, or a custom
    # admin-uploaded template with no catalog entry).
    generation_outline: Mapped[Optional[list[list[str]]]] = mapped_column(JSON)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_utcnow, onupdate=_utcnow, nullable=False
    )

    maker: Mapped[User] = relationship(User, foreign_keys=[maker_employee_id])
    versions: Mapped[list["DraftVersion"]] = relationship(
        "DraftVersion", back_populates="draft", cascade="all, delete-orphan", order_by="DraftVersion.version"
    )
    approvals: Mapped[list["DraftApproval"]] = relationship(
        "DraftApproval", back_populates="draft", cascade="all, delete-orphan", order_by="DraftApproval.at"
    )
    threads: Mapped[list["Thread"]] = relationship(
        "Thread", back_populates="draft", cascade="all, delete-orphan"
    )


class DraftVersion(Base):
    __tablename__ = "draft_versions"
    __table_args__ = (UniqueConstraint("draft_id", "version", name="uq_draft_version"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    draft_id: Mapped[str] = mapped_column(String(32), ForeignKey("drafts.id", ondelete="CASCADE"), nullable=False)
    version: Mapped[int] = mapped_column(Integer, nullable=False)
    trigger: Mapped[str] = mapped_column(String(32), default="manual", nullable=False)
    sha256: Mapped[str] = mapped_column(String(64), nullable=False)
    storage_key: Mapped[str] = mapped_column(String(400), nullable=False)
    actor_employee_id: Mapped[str] = mapped_column(
        String(16), ForeignKey("users.employee_id", ondelete="RESTRICT"), nullable=False
    )
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow, nullable=False)

    draft: Mapped[Draft] = relationship(Draft, back_populates="versions")


class DraftApproval(Base):
    __tablename__ = "draft_approvals"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    draft_id: Mapped[str] = mapped_column(String(32), ForeignKey("drafts.id", ondelete="CASCADE"), nullable=False)
    level: Mapped[int] = mapped_column(Integer, nullable=False)  # 1 or 2
    decision: Mapped[str] = mapped_column(String(32), nullable=False)  # approve|reject|changes_requested
    comments: Mapped[str] = mapped_column(Text, default="", nullable=False)
    actor_employee_id: Mapped[str] = mapped_column(
        String(16), ForeignKey("users.employee_id", ondelete="RESTRICT"), nullable=False
    )
    decided_on_version: Mapped[int] = mapped_column(Integer, nullable=False)
    at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow, nullable=False)

    draft: Mapped[Draft] = relationship(Draft, back_populates="approvals")


class Thread(Base):
    """SuperDoc comment/tracked-change thread mirrored server-side on save."""

    __tablename__ = "threads"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)  # SuperDoc thread id
    draft_id: Mapped[str] = mapped_column(String(32), ForeignKey("drafts.id", ondelete="CASCADE"), nullable=False)
    division_code: Mapped[str] = mapped_column(
        String(32), ForeignKey("divisions.code", ondelete="RESTRICT"), nullable=False
    )
    anchor: Mapped[Optional[dict[str, Any]]] = mapped_column(JSON)  # SuperDoc bookmark/range payload
    body_snippet: Mapped[str] = mapped_column(Text, default="", nullable=False)
    author_employee_id: Mapped[Optional[str]] = mapped_column(
        String(16), ForeignKey("users.employee_id", ondelete="SET NULL")
    )
    kind: Mapped[str] = mapped_column(String(32), default="comment", nullable=False)  # comment|tracked_change
    resolved: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_utcnow, onupdate=_utcnow, nullable=False
    )
    raw: Mapped[Optional[dict[str, Any]]] = mapped_column(JSON)

    draft: Mapped[Draft] = relationship(Draft, back_populates="threads")


class CorpusDocument(Base):
    """Published/precedent institutional document (RAG source)."""

    __tablename__ = "corpus_documents"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    doc_id: Mapped[str] = mapped_column(String(200), unique=True, nullable=False)
    title: Mapped[str] = mapped_column(String(500), nullable=False)
    ministry: Mapped[Optional[str]] = mapped_column(String(300))
    date: Mapped[Optional[str]] = mapped_column(String(32))
    domains: Mapped[Optional[list[str]]] = mapped_column(JSON)
    deliverables: Mapped[Optional[str]] = mapped_column(Text)
    value_inr: Mapped[float] = mapped_column(Float, default=0.0, nullable=False)
    storage_key: Mapped[Optional[str]] = mapped_column(String(400))  # bucket key OR relative filesystem path
    source_path: Mapped[str] = mapped_column(String(400), nullable=False)
    kind: Mapped[str] = mapped_column(String(32), nullable=False)  # processed_json|work_order_docx|work_order_pdf|upload
    content_sha256: Mapped[Optional[str]] = mapped_column(String(64))
    division_code: Mapped[str] = mapped_column(
        String(32), ForeignKey("divisions.code", ondelete="RESTRICT"), nullable=False
    )
    visibility: Mapped[str] = mapped_column(String(32), default="division_only", nullable=False)
    full_text: Mapped[Optional[str]] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_utcnow, onupdate=_utcnow, nullable=False
    )

    chunks: Mapped[list["CorpusChunk"]] = relationship(
        "CorpusChunk", back_populates="document", cascade="all, delete-orphan", order_by="CorpusChunk.chunk_index"
    )


class CorpusChunk(Base):
    __tablename__ = "corpus_chunks"
    __table_args__ = (
        UniqueConstraint("document_id", "chunk_index", name="uq_chunk_index"),
        Index("ix_corpus_chunks_division", "division_code"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    document_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("corpus_documents.id", ondelete="CASCADE"), nullable=False
    )
    chunk_index: Mapped[int] = mapped_column(Integer, nullable=False)
    section_label: Mapped[Optional[str]] = mapped_column(String(64))
    text: Mapped[str] = mapped_column(Text, nullable=False)
    token_set: Mapped[Optional[list[str]]] = mapped_column(JSON)
    division_code: Mapped[str] = mapped_column(
        String(32), ForeignKey("divisions.code", ondelete="RESTRICT"), nullable=False
    )
    embedding = mapped_column(EmbeddingType, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow, nullable=False)

    document: Mapped[CorpusDocument] = relationship(CorpusDocument, back_populates="chunks")


class AuditLog(Base):
    __tablename__ = "audit_logs"
    __table_args__ = (Index("ix_audit_actor_at", "actor_employee_id", "at"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow, nullable=False)
    actor_employee_id: Mapped[Optional[str]] = mapped_column(
        String(16), ForeignKey("users.employee_id", ondelete="SET NULL")
    )
    action: Mapped[str] = mapped_column(String(64), nullable=False)  # draft.create, draft.save, draft.submit, ...
    target_kind: Mapped[str] = mapped_column(String(32), nullable=False)
    target_id: Mapped[str] = mapped_column(String(64), nullable=False)
    division_code: Mapped[Optional[str]] = mapped_column(
        String(32), ForeignKey("divisions.code", ondelete="SET NULL")
    )
    details: Mapped[Optional[dict[str, Any]]] = mapped_column(JSON)
