"""Add drafts.generation_outline (nullable JSON).

Stores the ordered [[section_label, section_title], ...] structure a draft
was generated against — either a catalog template's fixed outline or one
derived from an existing corpus document's chunk section_labels (see
agent_presets.TEMPLATE_CATALOG / corpus_db.db_document_outline). Null on
existing rows: draft_generator falls back to the default GENERATION_SECTIONS.

Revision ID: 0003_gen_outline
Revises: 0002_pgvector
Create Date: 2026-09-25
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0003_gen_outline"
down_revision = "0002_pgvector"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("drafts", sa.Column("generation_outline", sa.JSON(), nullable=True))


def downgrade() -> None:
    op.drop_column("drafts", "generation_outline")
