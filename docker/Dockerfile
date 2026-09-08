# syntax=docker/dockerfile:1
# Build context is the repo root:  docker build -f docker/Dockerfile -t astrocaption:local .

# ---- stage 1: frontend -------------------------------------------------------------
FROM node:24-alpine AS frontend
WORKDIR /src/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY frontend/ ./
# vite.config.ts writes the bundle to ../backend/static
RUN npm run build

# ---- stage 2: runtime --------------------------------------------------------------
FROM python:3.13-slim AS runtime
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    ASTROCAPTION_DATA_DIR=/data \
    ASTROCAPTION_FONTS_DIR=/app/fonts \
    ASTROCAPTION_STATIC_DIR=/app/static

RUN useradd --uid 1000 --user-group --create-home app \
    && mkdir -p /data && chown app:app /data

WORKDIR /app
COPY backend/pyproject.toml /app/src/pyproject.toml
COPY backend/app /app/src/app
RUN pip install /app/src && rm -rf /app/src /root/.cache

COPY fonts /app/fonts
COPY --from=frontend /src/backend/static /app/static
COPY docker/entrypoint.sh /app/entrypoint.sh
RUN chmod 0755 /app/entrypoint.sh

USER app
EXPOSE 8000
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD python -c "import sys, urllib.request; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/api/health', timeout=4).status == 200 else 1)"
ENTRYPOINT ["/app/entrypoint.sh"]
