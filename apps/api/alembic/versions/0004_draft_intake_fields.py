"""Add drafts.key_doc_ids and drafts.intake_transcript (nullable JSON).

Supports the draft_intake clarifying-questions flow: key_doc_ids is the
validated precedent set the model chose (via cfc_ready_to_generate) after
asking the user grounding questions; intake_transcript is the compact Q&A
record kept for audit. Both null on rows created via the one-shot path with
no clarification step.

Revision ID: 0004_intake_fields
Revises: 0003_gen_outline
Create Date: 2026-09-25
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0004_intake_fields"
down_revision = "0003_gen_outline"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("drafts", sa.Column("key_doc_ids", sa.JSON(), nullable=True))
    op.add_column("drafts", sa.Column("intake_transcript", sa.JSON(), nullable=True))


def downgrade() -> None:
    op.drop_column("drafts", "intake_transcript")
    op.drop_column("drafts", "key_doc_ids")
