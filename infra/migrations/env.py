"""Alembic environment.

Resolves the DB URL from backend.config so local/Railway share one resolution path.
Imports models.py so `alembic revision --autogenerate` sees every table.
"""
from __future__ import annotations

from logging.config import fileConfig

from alembic import context
from sqlalchemy import engine_from_config, pool

# Import the SQLAlchemy metadata — this line is what makes autogenerate work.
from backend.config import get_settings  # noqa: E402
from backend.db.base import Base  # noqa: E402
from backend.db import models  # noqa: F401, E402  (side-effect: registers tables)

config = context.config

# Override the URL from our settings module (env-driven, same as the app).
settings = get_settings()
config.set_main_option("sqlalchemy.url", settings.sqlalchemy_url())

if config.config_file_name is not None:
    fileConfig(config.config_file_name)

target_metadata = Base.metadata


def run_migrations_offline() -> None:
    """Emit SQL to stdout (useful for 'alembic upgrade head --sql')."""
    context.configure(
        url=config.get_main_option("sqlalchemy.url"),
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
        compare_type=True,
    )
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    connectable = engine_from_config(
        config.get_section(config.config_ini_section, {}),
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,
    )
    with connectable.connect() as connection:
        context.configure(
            connection=connection,
            target_metadata=target_metadata,
            compare_type=True,
        )
        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
