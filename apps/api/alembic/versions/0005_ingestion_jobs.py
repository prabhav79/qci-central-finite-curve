"""Add ingestion_jobs / ingestion_quota tables and corpus_documents.outcome.

Queue-based ingestion (item 6): a cheap discovery walk upserts pending rows
into ingestion_jobs, a small worker pool claims and processes them, and
progress survives a Railway redeploy mid-run since it's DB-backed instead of
the old in-process `_reindex_state` dict. ingestion_quota is a single-row
(id=1) cumulative RunPulse OCR page counter, seeded here. outcome is
schema-only for now — backfilled to "successful" for every existing document.

Revision ID: 0005_ingestion_jobs
Revises: 0004_intake_fields
Create Date: 2026-09-26
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0005_ingestion_jobs"
down_revision = "0004_intake_fields"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("corpus_documents", sa.Column("outcome", sa.String(length=16), nullable=True))
    op.execute("UPDATE corpus_documents SET outcome = 'successful' WHERE outcome IS NULL")

    op.create_table(
        "ingestion_jobs",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("source_path", sa.String(length=500), nullable=False, unique=True),
        sa.Column("source_kind", sa.String(length=32), nullable=False),
        sa.Column("division_code", sa.String(length=32), nullable=False),
        sa.Column("status", sa.String(length=16), nullable=False, server_default="pending"),
        sa.Column("attempts", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("max_attempts", sa.Integer(), nullable=False, server_default="3"),
        sa.Column("last_error", sa.Text(), nullable=True),
        sa.Column("content_sha256", sa.String(length=64), nullable=True),
        sa.Column("runpulse_pages_used", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("claimed_by", sa.String(length=64), nullable=True),
        sa.Column("claimed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("finished_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index("ix_ingestion_jobs_status", "ingestion_jobs", ["status", "created_at"])

    op.create_table(
        "ingestion_quota",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("runpulse_pages_used_total", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("runpulse_page_cap", sa.Integer(), nullable=False, server_default="10000"),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.execute(
        "INSERT INTO ingestion_quota (id, runpulse_pages_used_total, runpulse_page_cap, updated_at) "
        "VALUES (1, 0, 10000, CURRENT_TIMESTAMP)"
    )


def downgrade() -> None:
    op.drop_table("ingestion_quota")
    op.drop_index("ix_ingestion_jobs_status", table_name="ingestion_jobs")
    op.drop_table("ingestion_jobs")
    op.drop_column("corpus_documents", "outcome")
