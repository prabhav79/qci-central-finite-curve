"""Sanity check after seed: counts, embedding dim, and a live pgvector query.

Run via:  railway ssh -s backend -- python -m infra.seed._verify_seed
Delete after use.
"""
from sqlalchemy import text
from sqlalchemy.orm import Session

from backend.db.session import get_engine
from backend.llm.embeddings import embed_query


def main() -> None:
    engine = get_engine()
    with Session(engine) as db:
        n_docs = db.execute(text("SELECT COUNT(*) FROM documents")).scalar()
        n_chunks = db.execute(text("SELECT COUNT(*) FROM document_chunks")).scalar()
        n_no_embed = db.execute(
            text("SELECT COUNT(*) FROM document_chunks WHERE embedding IS NULL")
        ).scalar()
        dim = db.execute(
            text(
                "SELECT vector_dims(embedding) FROM document_chunks "
                "WHERE embedding IS NOT NULL LIMIT 1"
            )
        ).scalar()

        print(f"documents rows:       {n_docs}")
        print(f"document_chunks rows: {n_chunks}")
        print(f"chunks without embed: {n_no_embed}")
        print(f"embedding dim:        {dim}")

        # Live semantic query
        query = "capacity building program for grievance redressal"
        vec = embed_query(query)
        print(f"query embed dim:      {len(vec)}")

        sql = text(
            """
            SELECT d.doc_id, d.ministry,
                   (c.embedding <=> cast(:qv as vector)) AS distance
            FROM document_chunks c
            JOIN documents d ON d.id = c.document_id
            WHERE c.embedding IS NOT NULL
            ORDER BY c.embedding <=> cast(:qv as vector)
            LIMIT 5
            """
        )
        rows = db.execute(sql, {"qv": str(vec)}).fetchall()
        print()
        print(f"Top-5 matches for query: {query!r}")
        for r in rows:
            print(f"  dist={float(r.distance):.3f}  {r.doc_id}")


if __name__ == "__main__":
    main()
