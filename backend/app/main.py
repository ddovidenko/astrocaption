"""FastAPI application factory. ``uvicorn app.main:app`` serves the API, fonts and the SPA."""

from __future__ import annotations

import asyncio
import logging
import mimetypes
import os
from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager
from pathlib import Path

import httpx
from fastapi import FastAPI, HTTPException, Request, status
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from . import __version__
from .api import auth, config, docs, fonts, health, images
from .auth import MIN_PASSWORD_LENGTH, LoginLimiter, perform_setup
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
    setup_password: str | None = None,
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
        _headless_setup(source, setup_password)
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
        docs_url=None,
        openapi_url=None,
        redoc_url=None,
    )
    app.state.settings_source = source
    app.state.db = db
    app.state.worker = worker
    app.state.login_limiter = LoginLimiter()
    app.state.setup_lock = asyncio.Lock()  # one first-run setup at a time (SPEC § 5.1)
    app.state.config_lock = asyncio.Lock()  # one config.json read-modify-write at a time
    app.add_middleware(images.UploadGuard, settings_source=source)

    app.add_exception_handler(RequestValidationError, plain_validation_error)  # type: ignore[arg-type]

    app.include_router(health.router)
    app.include_router(auth.router)
    app.include_router(config.router)
    app.include_router(docs.router)
    app.include_router(fonts.router)
    app.include_router(images.router)

    if cfg.fonts_dir.is_dir():
        app.mount("/fonts", StaticFiles(directory=cfg.fonts_dir), name="fonts")
    _mount_spa(app, cfg.static_dir)
    return app


MAX_LABEL_CHARS = 60


def _safe_label(parts: list[str]) -> str:
    """A field path fit to echo: the client chooses these names, so it could send a control
    character to forge a log line, or a very long one to bury the message."""
    cleaned = (
        "".join(c if c.isascii() and c.isprintable() else "?" for c in part) for part in parts
    )
    return ".".join(cleaned)[:MAX_LABEL_CHARS] or "request"


async def plain_validation_error(_: Request, exc: RequestValidationError) -> JSONResponse:
    """Plain-language 422s: the default FastAPI body echoes the submitted value (a
    password, here) in ``input`` and returns a list. Neither belongs in a response."""
    labels: list[str] = []
    messages: list[str] = []
    for error in exc.errors():
        # loc holds ints too (a byte offset for a bad body, an index in a list), and
        # its first element is the source; neither names anything a user would type.
        named = [
            part
            for part in error.get("loc", ())
            if isinstance(part, str) and part not in {"body", "query", "path"}
        ]
        label = _safe_label(named)
        labels.append(label)
        msg = (
            "the body is not valid JSON"
            if error.get("type") == "json_invalid"
            else str(error.get("msg", "is not valid"))
        )
        messages.append(f"{label}: {msg}")
    log.info("request validation failed: %s", ", ".join(labels) or "request")
    detail = "; ".join(messages) or "Invalid request."
    return JSONResponse({"detail": detail}, status_code=status.HTTP_422_UNPROCESSABLE_CONTENT)


def _headless_setup(source: SettingsSource, password: str | None) -> None:
    """``ASTROCAPTION_PASSWORD``: complete first-run setup without the browser (SPEC § 11).

    Unset and empty mean the same thing: nothing to do.
    """
    if not password:
        return
    current = source.current()
    if current.config_error is not None:
        log.error(
            "ASTROCAPTION_PASSWORD ignored: %s cannot be read (%s); fix or remove it and "
            "restart to run setup",
            current.config_path.name,
            current.config_error,
        )
        return
    if not current.setup_required:
        log.info(
            "ASTROCAPTION_PASSWORD ignored: an owner password is already set; remove the "
            "variable, see docs/INSTALL.md to reset the password"
        )
        return
    if len(password) < MIN_PASSWORD_LENGTH:
        log.error(
            "ASTROCAPTION_PASSWORD ignored: shorter than %d characters; open /setup instead",
            MIN_PASSWORD_LENGTH,
        )
        return
    perform_setup(current, password)
    log.info("owner password set from ASTROCAPTION_PASSWORD")


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


app = create_app(setup_password=os.environ.get("ASTROCAPTION_PASSWORD"))
