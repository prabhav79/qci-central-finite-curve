"""initial schema: pgvector + all Phase 0 tables

Revision ID: 0001_initial
Revises:
Create Date: 2026-04-22
"""
from __future__ import annotations

from typing import Sequence, Union

import pgvector.sqlalchemy  # noqa: F401  (registers the vector type)
import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0001_initial"
down_revision: Union[str, None] = None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # ------------------------------------------------------------------
    # 1. pgvector extension
    # ------------------------------------------------------------------
    op.execute("CREATE EXTENSION IF NOT EXISTS vector")
    # pg_trgm powers the lexical fallback search in 0.5.
    op.execute("CREATE EXTENSION IF NOT EXISTS pg_trgm")

    # ------------------------------------------------------------------
    # 2. Enums
    # ------------------------------------------------------------------
    document_status = postgresql.ENUM(
        "queued", "processing", "ready", "flagged", "failed",
        name="document_status",
        create_type=True,
    )
    document_status.create(op.get_bind(), checkfirst=True)

    ingest_item_status = postgresql.ENUM(
        "queued", "processing", "ready", "flagged", "failed",
        name="ingest_item_status",
        create_type=True,
    )
    ingest_item_status.create(op.get_bind(), checkfirst=True)

    # ------------------------------------------------------------------
    # 3. documents
    # ------------------------------------------------------------------
    op.create_table(
        "documents",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("doc_id", sa.String(512), nullable=False),
        sa.Column("sha256", sa.String(64), nullable=False),
        sa.Column("filename", sa.String(1024), nullable=False),
        sa.Column("mime", sa.String(128), nullable=True),
        sa.Column("size_bytes", sa.BigInteger, nullable=True),
        sa.Column("blob_key", sa.String(1024), nullable=True),
        sa.Column("ministry", sa.String(512), nullable=True),
        sa.Column("project", sa.String(512), nullable=True),
        sa.Column("division", sa.String(256), nullable=True),
        sa.Column("issued_on", sa.DateTime(timezone=True), nullable=True),
        sa.Column("value_inr", sa.Numeric(18, 2), nullable=True),
        sa.Column("project_subject", sa.Text, nullable=True),
        sa.Column("deliverables", sa.Text, nullable=True),
        sa.Column("full_text", sa.Text, nullable=True),
        sa.Column(
            "status",
            postgresql.ENUM(name="document_status", create_type=False),
            nullable=False,
            server_default="queued",
        ),
        sa.Column("flag_reason", sa.String(256), nullable=True),
        sa.Column("version", sa.Integer, nullable=False, server_default="1"),
        sa.Column(
            "supersedes_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("documents.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("uploaded_by_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.UniqueConstraint("sha256", name="uq_documents_sha256"),
        sa.UniqueConstraint("doc_id", name="uq_documents_doc_id"),
    )
    op.create_index("ix_documents_doc_id", "documents", ["doc_id"])
    op.create_index("ix_documents_sha256", "documents", ["sha256"])
    op.create_index("ix_documents_ministry", "documents", ["ministry"])
    op.create_index("ix_documents_project", "documents", ["project"])
    op.create_index("ix_documents_status", "documents", ["status"])

    # Trigram index on full_text for lexical fallback search
    op.execute(
        "CREATE INDEX ix_documents_full_text_trgm "
        "ON documents USING gin (full_text gin_trgm_ops)"
    )

    # ------------------------------------------------------------------
    # 4. document_chunks (pgvector)
    # ------------------------------------------------------------------
    op.create_table(
        "document_chunks",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "document_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("documents.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("chunk_index", sa.Integer, nullable=False),
        sa.Column("text", sa.Text, nullable=False),
        sa.Column("embedding", pgvector.sqlalchemy.Vector(768), nullable=True),
        sa.Column("tokens", sa.Integer, nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.UniqueConstraint(
            "document_id", "chunk_index",
            name="uq_document_chunks_document_id_chunk_index",
        ),
    )
    op.create_index("ix_document_chunks_document_id", "document_chunks", ["document_id"])
    # NOTE: IVFFlat index on `embedding` is deliberately NOT created here.
    # pgvector docs recommend building it *after* seed data lands so the index's
    # cluster centroids reflect real embeddings. See migration 0002 (post-seed).

    # ------------------------------------------------------------------
    # 5. ingest_jobs + ingest_job_items
    # ------------------------------------------------------------------
    op.create_table(
        "ingest_jobs",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("finished_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("total_files", sa.Integer, nullable=False, server_default="0"),
        sa.Column("completed", sa.Integer, nullable=False, server_default="0"),
        sa.Column("failed", sa.Integer, nullable=False, server_default="0"),
        sa.Column("flagged", sa.Integer, nullable=False, server_default="0"),
        sa.Column("user_id", postgresql.UUID(as_uuid=True), nullable=True),
    )

    op.create_table(
        "ingest_job_items",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "job_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("ingest_jobs.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("source_filename", sa.String(1024), nullable=False),
        sa.Column(
            "status",
            postgresql.ENUM(name="ingest_item_status", create_type=False),
            nullable=False,
            server_default="queued",
        ),
        sa.Column("error", sa.Text, nullable=True),
        sa.Column(
            "document_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("documents.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )
    op.create_index("ix_ingest_job_items_job_id", "ingest_job_items", ["job_id"])

    # ------------------------------------------------------------------
    # 6. generations
    # ------------------------------------------------------------------
    op.create_table(
        "generations",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("doc_type", sa.String(32), nullable=False),
        sa.Column("prompt", sa.Text, nullable=False),
        sa.Column("draft_md", sa.Text, nullable=False),
        sa.Column("sources_json", postgresql.JSONB, nullable=True),
        sa.Column("exported_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("user_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )

    # ------------------------------------------------------------------
    # 7. audit_log (append-only; INSERT-only role promoted in Phase 3)
    # ------------------------------------------------------------------
    op.create_table(
        "audit_log",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("action", sa.String(128), nullable=False),
        sa.Column("resource_type", sa.String(128), nullable=True),
        sa.Column("resource_id", sa.String(128), nullable=True),
        sa.Column("ip", sa.String(64), nullable=True),
        sa.Column("user_agent", sa.Text, nullable=True),
        sa.Column("extra", postgresql.JSONB, nullable=True),
        sa.Column("user_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )
    op.create_index("ix_audit_log_action", "audit_log", ["action"])
    op.create_index("ix_audit_log_resource_type", "audit_log", ["resource_type"])
    op.create_index("ix_audit_log_created_at", "audit_log", ["created_at"])


def downgrade() -> None:
    op.drop_index("ix_audit_log_created_at", table_name="audit_log")
    op.drop_index("ix_audit_log_resource_type", table_name="audit_log")
    op.drop_index("ix_audit_log_action", table_name="audit_log")
    op.drop_table("audit_log")

    op.drop_table("generations")

    op.drop_index("ix_ingest_job_items_job_id", table_name="ingest_job_items")
    op.drop_table("ingest_job_items")
    op.drop_table("ingest_jobs")

    op.drop_index("ix_document_chunks_document_id", table_name="document_chunks")
    op.drop_table("document_chunks")

    op.execute("DROP INDEX IF EXISTS ix_documents_full_text_trgm")
    op.drop_index("ix_documents_status", table_name="documents")
    op.drop_index("ix_documents_project", table_name="documents")
    op.drop_index("ix_documents_ministry", table_name="documents")
    op.drop_index("ix_documents_sha256", table_name="documents")
    op.drop_index("ix_documents_doc_id", table_name="documents")
    op.drop_table("documents")

    op.execute("DROP TYPE IF EXISTS ingest_item_status")
    op.execute("DROP TYPE IF EXISTS document_status")
    # Deliberately do NOT drop the vector / pg_trgm extensions on downgrade;
    # they may be used by other schemas in the same database.
