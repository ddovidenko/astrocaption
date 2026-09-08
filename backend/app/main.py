"""FastAPI application factory. ``uvicorn app.main:app`` serves the API, fonts and the SPA."""

from __future__ import annotations

import logging
import mimetypes
from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager
from pathlib import Path

import httpx
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from . import __version__
from .api import fonts, health, images
from .config import Settings, SettingsSource
from .db import Database
from .solver import Solver
from .solver.nova import NovaSolver
from .worker import SolveWorker

log = logging.getLogger(__name__)

# python:*-slim images ship no /etc/mime.types; make sure fonts get a real content type.
mimetypes.add_type("font/ttf", ".ttf")


def create_app(
    settings: Settings | None = None,
    *,
    solver_factory: Callable[[], Solver | None] | None = None,
    poll_interval: float = 5.0,
    solve_timeout: float = 15 * 60,
) -> FastAPI:
    source = SettingsSource(settings)  # config.json values stay live; paths are fixed
    cfg = source.current()
    db = Database(cfg.db_path)
    http_client: httpx.AsyncClient | None = None

    def default_solver_factory() -> Solver | None:
        if http_client is None:  # only possible outside the lifespan
            raise RuntimeError("HTTP client is not started")
        current = source.current()
        if not current.nova_api_key:
            return None
        return NovaSolver(current.nova_api_key, http_client, current.nova_base_url)

    worker = SolveWorker(
        db,
        source,
        solver_factory or default_solver_factory,
        poll_interval=poll_interval,
        timeout=solve_timeout,
    )

    @asynccontextmanager
    async def lifespan(_: FastAPI) -> AsyncIterator[None]:
        nonlocal http_client
        cfg.ensure_dirs()
        db.init()
        http_client = httpx.AsyncClient(
            timeout=httpx.Timeout(30.0, read=300.0, write=300.0), follow_redirects=True
        )
        await worker.start()
        log.info("astrocaption %s ready; data dir %s", __version__, cfg.data_dir)
        try:
            yield
        finally:
            await worker.stop()
            await http_client.aclose()

    if not logging.getLogger().handlers:
        logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")

    app = FastAPI(
        title="AstroCaption",
        version=__version__,
        lifespan=lifespan,
        docs_url="/api/docs",
        openapi_url="/api/openapi.json",
        redoc_url=None,
    )
    app.state.settings_source = source
    app.state.db = db
    app.state.worker = worker

    app.include_router(health.router)
    app.include_router(fonts.router)
    app.include_router(images.router)

    if cfg.fonts_dir.is_dir():
        app.mount("/fonts", StaticFiles(directory=cfg.fonts_dir), name="fonts")
    _mount_spa(app, cfg.static_dir)
    return app


def _mount_spa(app: FastAPI, static_dir: Path) -> None:
    """Serve the built frontend (if present) with an index.html fallback for client routes."""
    index = static_dir / "index.html"
    if not index.is_file():
        return
    root = static_dir.resolve()

    @app.get("/{path:path}", include_in_schema=False)
    async def spa(path: str, request: Request) -> FileResponse:
        if path.startswith("api/"):
            raise HTTPException(404)
        candidate = (root / path).resolve() if path else index
        if path and candidate.is_file() and candidate.is_relative_to(root):
            return FileResponse(candidate)
        return FileResponse(index)


app = create_app()
