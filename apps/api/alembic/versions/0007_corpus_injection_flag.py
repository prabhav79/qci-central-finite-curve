"""Add corpus_documents.injection_flag (plan item 10).

Nullable float, 0..1 — Jev's "does this read like a prompt-injection
attempt rather than genuine institutional content" score, screened once
per document at ingest time (folded into the same batched Jev call
_jev_classify already makes for domain/ministry, per item 6a's existing
wiring) rather than per-query. NULL means unscreened (Jev unconfigured
or the call failed), never "confirmed safe" — existing rows backfill to
NULL and get a real score next time they're reclassified.

Revision ID: 0007_injection_flag
Revises: 0006_corpus_edges
Create Date: 2026-09-29
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0007_injection_flag"
down_revision = "0006_corpus_edges"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("corpus_documents", sa.Column("injection_flag", sa.Float(), nullable=True))


def downgrade() -> None:
    op.drop_column("corpus_documents", "injection_flag")
