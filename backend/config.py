"""Application configuration, sourced from environment variables.

All Phase 0 env vars flow through this single module. Railway injects DATABASE_URL
and REDIS_URL automatically when the backend service is linked to the Postgres and
Redis services; everything else is set explicitly in Railway's service variables.
"""
from functools import lru_cache
from typing import Literal

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
        case_sensitive=False,
    )

    # --- Runtime ---
    environment: Literal["local", "railway"] = "local"
    log_level: str = "INFO"

    # --- Database ---
    database_url: str = Field(
        ...,
        description="Postgres connection string. Railway injects this automatically when "
        "the backend service is linked to the Postgres service.",
    )
    # Railway gives us postgres:// but SQLAlchemy 2.x wants postgresql+psycopg2://
    # We normalise it in __init__.

    # --- Redis (Celery broker + result backend) ---
    redis_url: str = Field(..., description="Redis connection URL")

    # --- LLM ---
    gemini_api_key: str = Field(..., description="Google AI Studio API key (Gemini Flash free tier)")
    # AI Studio v1beta supports gemini-embedding-001 (3072-dim by default).
    # We request output_dimensionality=768 via Matryoshka Representation Learning
    # so the vectors fit the document_chunks.embedding vector(768) column.
    gemini_embedding_model: str = "gemini-embedding-001"
    gemini_embedding_dim: int = 768
    gemini_generation_model: str = "gemini-1.5-flash"

    # --- OCR ---
    runpulse_api_key: str = Field(..., description="RunPulse API key for OCR / schema extraction")

    # --- Demo auth (Phase 0 single-password gate; replaced by SSO in Phase 3) ---
    demo_password: str = Field(..., description="Shared-password gate for Phase 0 demo access")
    jwt_secret: str = Field(..., description="HMAC secret for signing demo-session JWTs")
    jwt_ttl_minutes: int = 60

    # --- Frontend origin (CORS) ---
    frontend_origin: str = Field(
        "http://localhost:3000",
        description="CORS allowed origin for the Next.js frontend",
    )

    # --- Blob storage (Phase 0: Railway volume; Phase 3: S3-compatible) ---
    blob_base_path: str = Field(
        "/data/blobs",
        description="Local directory mount for Phase 0 file storage on Railway volume",
    )

    # --- RAG knobs ---
    chunk_size_tokens: int = 500
    chunk_overlap_tokens: int = 50
    retrieval_top_k: int = 8

    def sqlalchemy_url(self) -> str:
        """Normalise the Railway-provided postgres:// URL into a psycopg2-compatible form."""
        url = self.database_url
        if url.startswith("postgres://"):
            url = "postgresql+psycopg2://" + url[len("postgres://") :]
        elif url.startswith("postgresql://"):
            url = "postgresql+psycopg2://" + url[len("postgresql://") :]
        return url


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    """Cached accessor. Safe to call from anywhere in the app."""
    return Settings()  # type: ignore[call-arg]
