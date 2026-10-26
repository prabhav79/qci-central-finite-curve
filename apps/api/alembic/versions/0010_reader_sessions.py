"""Reader sessions: when each person's current reading session began.

Revision ID: 0010_reader_sessions
Revises: 0009_reader_library
Create Date: 2026-10-26
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0010_reader_sessions"
down_revision = "0009_reader_library"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "reader_sessions",
        sa.Column(
            "employee_id",
            sa.String(16),
            sa.ForeignKey("users.employee_id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=False),
    )


def downgrade() -> None:
    op.drop_table("reader_sessions")
