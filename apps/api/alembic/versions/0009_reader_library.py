"""Reader highlights, Library metadata columns, draft reference excerpts.

- reader_highlights: one person's private highlights in the Reader.
- corpus_documents.client/state/sector/work_type/engagement/doc_type: Library facets,
  backfilled from data/corpus_metadata.csv at startup (corpus_meta).
- drafts.reference_excerpts: the excerpts a draft was started from.

Revision ID: 0009_reader_library
Revises: 0008_draft_ai_restricted
Create Date: 2026-10-21
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0009_reader_library"
down_revision = "0008_draft_ai_restricted"
branch_labels = None
depends_on = None

_DOC_COLUMNS = [
    ("client", sa.String(300)),
    ("state", sa.String(64)),
    ("sector", sa.String(120)),
    ("work_type", sa.String(120)),
    ("engagement", sa.String(200)),
    ("doc_type", sa.String(32)),
]


def upgrade() -> None:
    op.create_table(
        "reader_highlights",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column(
            "employee_id", sa.String(16), sa.ForeignKey("users.employee_id", ondelete="CASCADE"), nullable=False
        ),
        sa.Column("doc_id", sa.String(200), nullable=False),
        sa.Column("page", sa.Integer(), nullable=False),
        sa.Column("rects", sa.JSON(), nullable=False),
        sa.Column("quote", sa.Text(), nullable=False),
        sa.Column("note", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index("ix_reader_highlight_owner_doc", "reader_highlights", ["employee_id", "doc_id"])
    for name, type_ in _DOC_COLUMNS:
        op.add_column("corpus_documents", sa.Column(name, type_, nullable=True))
    op.add_column("drafts", sa.Column("reference_excerpts", sa.JSON(), nullable=True))


def downgrade() -> None:
    op.drop_column("drafts", "reference_excerpts")
    for name, _ in reversed(_DOC_COLUMNS):
        op.drop_column("corpus_documents", name)
    op.drop_index("ix_reader_highlight_owner_doc", table_name="reader_highlights")
    op.drop_table("reader_highlights")
