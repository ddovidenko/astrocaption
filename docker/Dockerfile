# syntax=docker/dockerfile:1
# Build context is the repo root:  docker build -f docker/Dockerfile -t astrocaption:local .

# ---- stage 1: frontend -------------------------------------------------------------
# The bundle is platform-independent, so under a multi-arch build (release.yml) this stage
# runs once on the runner's own architecture instead of once per target under QEMU.
FROM --platform=$BUILDPLATFORM node:26-alpine AS frontend
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
COPY backend/pyproject.toml backend/requirements.txt /app/src/
COPY backend/app /app/src/app
# Dependencies come from the pinned, hashed lockfile (`make lock`, #250): the image ships the
# versions Dependabot and `make audit` looked at, not whatever PyPI serves on build day. The app
# itself installs without re-resolving. pip is only needed to install; dropping it removes its
# vendored packages from the runtime image (and from vulnerability scans) and trims a few MB.
RUN pip install --require-hashes -r /app/src/requirements.txt \
    && pip install --no-deps /app/src \
    && pip uninstall -y pip && rm -rf /app/src /root/.cache

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
