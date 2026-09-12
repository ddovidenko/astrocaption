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
FROM python:3.14-slim AS runtime
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    ASTROCAPTION_DATA_DIR=/data \
    ASTROCAPTION_FONTS_DIR=/app/fonts \
    ASTROCAPTION_STATIC_DIR=/app/static

RUN useradd --uid 1000 --user-group --create-home app \
    && mkdir -p /data && chown app:app /data

# Pillow's wheel bundles raqm (kerning, complex shaping) but loads libfribidi at runtime;
# without it Pillow silently falls back to its basic layout engine and text widths differ
# from the render contract (tests/fixtures/render/vectors.json) and the editor's canvas.
RUN apt-get update \
    && apt-get install -y --no-install-recommends libfribidi0 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY backend/pyproject.toml /app/src/pyproject.toml
COPY backend/app /app/src/app
# pip is only needed to install; dropping it removes its vendored packages from the
# runtime image (and from vulnerability scans) and trims a few MB.
RUN pip install /app/src && pip uninstall -y pip && rm -rf /app/src /root/.cache

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
