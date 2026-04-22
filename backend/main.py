"""FastAPI entry point for the QCI Central Finite Curve backend (Phase 0).

This file is intentionally minimal right now. Routers for auth, ingest, search,
generate, and export are added in their respective Linear sub-issues (QCI-4..QCI-8).
"""
from contextlib import asynccontextmanager
from typing import Any

from fastapi import Depends, FastAPI
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import text
from sqlalchemy.orm import Session

from backend.api import auth as auth_api
from backend.api import generate as generate_api
from backend.api import search as search_api
from backend.api import ingest as ingest_api
from backend.config import get_settings
from backend.db.session import get_db


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Place startup/shutdown hooks here (warm LLM clients, etc.)
    yield


def create_app() -> FastAPI:
    settings = get_settings()

    app = FastAPI(
        title="QCI Central Finite Curve",
        version="2.0.0-phase0",
        description=(
            "Institutional knowledge platform for QCI's PPID division. "
            "Phase 0: RAG generation demo on Railway using the existing 24-document corpus."
        ),
        lifespan=lifespan,
    )

    app.add_middleware(
        CORSMiddleware,
        allow_origins=[settings.frontend_origin],
        allow_credentials=True,
        allow_methods=["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
        allow_headers=["Authorization", "Content-Type"],
    )

    # Routers
    app.include_router(auth_api.router)
    app.include_router(generate_api.router)
    app.include_router(search_api.router)
    app.include_router(ingest_api.router)

    @app.get("/health", tags=["meta"])
    def health(db: Session = Depends(get_db)) -> dict[str, Any]:
        """Liveness + DB roundtrip. Returns pgvector version if the extension is installed."""
        pg_version = db.execute(text("SELECT version()")).scalar()
        vector_version = db.execute(
            text("SELECT extversion FROM pg_extension WHERE extname = 'vector'")
        ).scalar()
        return {
            "ok": True,
            "app": "qci-central-finite-curve",
            "version": app.version,
            "env": settings.environment,
            "postgres": pg_version,
            "pgvector": vector_version,  # None until the migration has run
        }

    return app


app = create_app()
