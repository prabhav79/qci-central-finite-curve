FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

# System deps for python-docx + pypdf (libmagic occasionally needed)
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential curl \
 && rm -rf /var/lib/apt/lists/*

COPY apps/api/requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r /app/requirements.txt

# Copy the whole monorepo the API touches: app code, alembic, seed, WOs, fixtures.
# Railway's build context is the repo root (see railway.toml).
COPY apps/api /app/apps/api
COPY packages/qci-seed /app/packages/qci-seed
COPY packages/doc-fixtures /app/packages/doc-fixtures
COPY data /app/data
# Paths with spaces require JSON-array COPY (shell-form splits on whitespace)
COPY ["Work Orders", "/app/Work Orders"]

# Alembic upgrade on start; then uvicorn.
ENV PYTHONPATH=/app
EXPOSE 8000
CMD ["sh", "-c", "cd /app/apps/api && python -m alembic upgrade head && cd /app && python -m uvicorn apps.api.app.main:app --host 0.0.0.0 --port ${PORT:-8000}"]
