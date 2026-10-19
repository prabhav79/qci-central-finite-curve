"""Add drafts.ai_restricted: a draft marked confidential gets no AI help.

Set by the maker when creating the document; nothing from such a draft is
sent to an outside AI service (Department of Expenditure note, 29 Jan 2025;
CERT-In CIAD-2025-0013). Existing drafts backfill to false.

Revision ID: 0008_draft_ai_restricted
Revises: 0007_injection_flag
Create Date: 2026-10-20
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0008_draft_ai_restricted"
down_revision = "0007_injection_flag"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "drafts",
        sa.Column("ai_restricted", sa.Boolean(), nullable=False, server_default=sa.false()),
    )


def downgrade() -> None:
    op.drop_column("drafts", "ai_restricted")
