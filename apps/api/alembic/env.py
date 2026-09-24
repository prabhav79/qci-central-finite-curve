"""
CFC Alembic env.

Uses apps.api.app.db.engine so migrations run against the same DATABASE_URL
resolution as the FastAPI app (SQLite dev default; Postgres via env).
"""
from __future__ import annotations

import sys
from logging.config import fileConfig
from pathlib import Path

from alembic import context

# Make `apps.api.app` importable when alembic runs from apps/api/.
ALEMBIC_DIR = Path(__file__).resolve().parent
APPS_API_DIR = ALEMBIC_DIR.parent
REPO_ROOT = APPS_API_DIR.parent.parent
for p in (REPO_ROOT, APPS_API_DIR):
    if str(p) not in sys.path:
        sys.path.insert(0, str(p))

from apps.api.app.db import DATABASE_URL, IS_POSTGRES, engine  # noqa: E402
from apps.api.app import models  # noqa: F401,E402  ensure metadata is populated
from apps.api.app.db import Base  # noqa: E402

config = context.config
config.set_main_option("sqlalchemy.url", DATABASE_URL)

if config.config_file_name is not None:
    fileConfig(config.config_file_name)

target_metadata = Base.metadata


def _include_object(obj, name, type_, reflected, compare_to):  # noqa: ANN001
    return True


def run_migrations_offline() -> None:
    context.configure(
        url=DATABASE_URL,
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
        include_object=_include_object,
    )
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    with engine.connect() as connection:
        if IS_POSTGRES:
            connection.exec_driver_sql("CREATE EXTENSION IF NOT EXISTS vector")
            connection.commit()
        context.configure(
            connection=connection,
            target_metadata=target_metadata,
            include_object=_include_object,
            render_as_batch=not IS_POSTGRES,  # SQLite ALTER support
        )
        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
