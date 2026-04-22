# syntax=docker/dockerfile:1.7
# QCI Central Finite Curve v2.0 — backend (FastAPI) image.
# The Celery worker service reuses this image with a different CMD.

FROM python:3.11-slim AS base

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /app

# Install OS deps only if a wheel is missing for the current platform.
# psycopg2-binary ships manylinux wheels so we don't need libpq-dev / gcc here.

COPY requirements.txt ./
RUN pip install --upgrade pip \
 && pip install -r requirements.txt

COPY . .

# Railway injects $PORT dynamically; default to 8000 for local runs.
EXPOSE 8000

# Single-process Uvicorn. Scale horizontally via Railway replicas rather than workers.
CMD ["sh", "-c", "uvicorn backend.main:app --host 0.0.0.0 --port ${PORT:-8000} --proxy-headers --forwarded-allow-ips='*'"]
