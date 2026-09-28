"""Add corpus_edges table (item 7 — knowledge graph).

Stores precomputed nearest-neighbor document-similarity edges: one row per
unordered {doc_id_a, doc_id_b} pair, weight = cosine similarity of the two
documents' chunk-embedding centroids (see corpus_db.compute_edges_for_document).

doc_id_a < doc_id_b is enforced in application code (corpus_db._upsert_edge),
not a DB-level CHECK constraint, so the same migration works unchanged on
both SQLite (dev) and Postgres (prod) — see db.IS_POSTGRES / project
convention of app-code-enforced invariants for cross-backend compatibility.

Revision ID: 0006_corpus_edges
Revises: 0005_ingestion_jobs
Create Date: 2026-09-28
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0006_corpus_edges"
down_revision = "0005_ingestion_jobs"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "corpus_edges",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("doc_id_a", sa.String(length=200), nullable=False),
        sa.Column("doc_id_b", sa.String(length=200), nullable=False),
        sa.Column("weight", sa.Float(), nullable=False, server_default="0"),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint("doc_id_a", "doc_id_b", name="uq_corpus_edges_pair"),
    )
    op.create_index("ix_corpus_edges_doc_id_a", "corpus_edges", ["doc_id_a"])
    op.create_index("ix_corpus_edges_doc_id_b", "corpus_edges", ["doc_id_b"])


def downgrade() -> None:
    op.drop_index("ix_corpus_edges_doc_id_b", table_name="corpus_edges")
    op.drop_index("ix_corpus_edges_doc_id_a", table_name="corpus_edges")
    op.drop_table("corpus_edges")
