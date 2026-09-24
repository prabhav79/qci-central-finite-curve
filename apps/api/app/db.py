"""
CFC database config.

Dev default: local SQLite under storage/dev/cfc.db — zero infra to run.
Prod: DATABASE_URL points at Postgres 16 (pgvector required from Sprint 3).

pgvector columns are declared conditionally so SQLite dev keeps working
until Sprint 3 turns embeddings on.
"""
from __future__ import annotations

import os
from pathlib import Path
from typing import Generator

from sqlalchemy import create_engine, event
from sqlalchemy.engine import Engine
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

ROOT = Path(__file__).resolve().parents[3]
DEFAULT_SQLITE = ROOT / "storage" / "dev" / "cfc.db"
DEFAULT_SQLITE.parent.mkdir(parents=True, exist_ok=True)

DATABASE_URL = os.environ.get(
    "DATABASE_URL",
    f"sqlite:///{DEFAULT_SQLITE.as_posix()}",
)


def _normalize_url(url: str) -> str:
    """Railway/Heroku hand out postgres:// — SQLAlchemy 2 wants postgresql+psycopg://."""
    if url.startswith("postgres://"):
        url = "postgresql+psycopg://" + url[len("postgres://") :]
    elif url.startswith("postgresql://") and "+" not in url.split("://", 1)[0]:
        url = "postgresql+psycopg://" + url[len("postgresql://") :]
    return url


DATABASE_URL = _normalize_url(DATABASE_URL)

IS_SQLITE = DATABASE_URL.startswith("sqlite")
IS_POSTGRES = DATABASE_URL.startswith("postgresql")

engine: Engine = create_engine(
    DATABASE_URL,
    future=True,
    echo=os.environ.get("CFC_SQL_ECHO") == "1",
    connect_args={"check_same_thread": False} if IS_SQLITE else {},
    pool_pre_ping=not IS_SQLITE,
)


@event.listens_for(engine, "connect")
def _sqlite_pragmas(dbapi_conn, _conn_record) -> None:  # noqa: ANN001
    if not IS_SQLITE:
        return
    cur = dbapi_conn.cursor()
    cur.execute("PRAGMA foreign_keys = ON")
    cur.execute("PRAGMA journal_mode = WAL")
    cur.close()


def ensure_pgvector() -> bool:
    """Create the pgvector extension when running against Postgres.

    Safe to call on every boot — CREATE EXTENSION IF NOT EXISTS is a no-op
    after the first success. On SQLite this is a no-op. Returns True when
    the extension was created or already present.
    """
    if not IS_POSTGRES:
        return False
    try:
        with engine.connect() as conn:
            conn.exec_driver_sql("CREATE EXTENSION IF NOT EXISTS vector")
            conn.commit()
        return True
    except Exception:  # noqa: BLE001
        # Some managed Postgres offerings restrict CREATE EXTENSION; if that
        # happens we surface it via logs and let the caller retry after
        # someone with elevated privileges enables it.
        import logging as _logging

        _logging.getLogger("cfc.db").exception("pgvector extension enable failed")
        return False


SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False, class_=Session, future=True)


class Base(DeclarativeBase):
    pass


def get_session() -> Generator[Session, None, None]:
    """FastAPI dependency."""
    s = SessionLocal()
    try:
        yield s
    finally:
        s.close()
