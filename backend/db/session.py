"""Database engine, session factory, and FastAPI dependency.

Separation of concerns:
- engine: one per process (created on first access via get_engine)
- SessionLocal: a sessionmaker factory
- get_db: the FastAPI dependency; yields a session and guarantees close
"""
from collections.abc import Generator
from functools import lru_cache

from sqlalchemy import create_engine
from sqlalchemy.engine import Engine
from sqlalchemy.orm import Session, sessionmaker

from backend.config import get_settings


@lru_cache(maxsize=1)
def get_engine() -> Engine:
    settings = get_settings()
    return create_engine(
        settings.sqlalchemy_url(),
        pool_pre_ping=True,  # drop dead connections before handing them out
        pool_size=5,
        max_overflow=10,
        future=True,
    )


@lru_cache(maxsize=1)
def _session_factory() -> sessionmaker[Session]:
    return sessionmaker(bind=get_engine(), autoflush=False, autocommit=False, future=True)


def get_db() -> Generator[Session, None, None]:
    """FastAPI dependency: yields a session and closes it on request teardown."""
    session = _session_factory()()
    try:
        yield session
    finally:
        session.close()
