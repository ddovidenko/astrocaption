"""FastAPI application factory. ``uvicorn app.main:app`` serves the API, fonts and the SPA."""

from __future__ import annotations

import asyncio
import logging
import mimetypes
import os
from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager

import httpx
from fastapi import FastAPI, Request, status
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from uvicorn.middleware.proxy_headers import ProxyHeadersMiddleware

from . import __version__, catalog_backfill, spa
from .api import auth, config, docs, fonts, gallery, health, images, uploads
from .auth import (
    LoginLimiter,
    PasswordRefused,
    require_setup,
    set_owner_password,
    validate_new_password,
)
from .config import ConfigError, Settings, SettingsSource
from .db import Database
from .fonts import FontNotFoundError, layout_engine_available
from .models import validation_message
from .solver import Solver
from .solver.nova import NovaSolver
from .worker import SolveWorker

log = logging.getLogger(__name__)

# Every API router, in one place: ``create_app`` includes them, and ``tests/test_auth_api.py``
# walks the same tuple to prove each non-public route demands a session (#40).
API_ROUTERS = (
    health.router,
    auth.router,
    config.router,
    docs.router,
    fonts.router,
    gallery.router,
    images.router,
    uploads.router,
)

# python:*-slim images ship no /etc/mime.types; make sure fonts get a real content type.
mimetypes.add_type("font/ttf", ".ttf")


def create_app(
    settings: Settings | None = None,
    *,
    solver_factory: Callable[[], Solver | None] | None = None,
    poll_interval: float | None = None,
    solve_timeout: float | None = None,
    setup_password: str | None = None,
) -> FastAPI:
    """``poll_interval`` and ``solve_timeout`` in seconds; ``None`` takes the settings' values
    (the two environment knobs, see config.py). Tests pass them explicitly."""
    if not logging.getLogger().handlers:
        logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
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
        poll_interval=cfg.solve_poll_seconds if poll_interval is None else poll_interval,
        timeout=cfg.solve_timeout_seconds if solve_timeout is None else solve_timeout,
    )

    @asynccontextmanager
    async def lifespan(_: FastAPI) -> AsyncIterator[None]:
        nonlocal http_client
        cfg.ensure_dirs()
        uploads.clear_partial_uploads(cfg)
        _headless_setup(source, setup_password)
        db.init()
        # The stored object kinds follow this build's names table (#189): the editor's chips
        # and the kind filter read them, so a release with a new table re-checks them here.
        moved = await asyncio.to_thread(db.reclassify_objects)
        if moved:
            log.info("object kinds: %d row(s) reclassified against the bundled names table", moved)
        # Images solved before the local catalogue (or before its current version) gain its
        # objects now, before any request is served (#17): additive, never contacts nova.
        report = await asyncio.to_thread(catalog_backfill.run, db, cfg)
        if report.changed:
            log.info(
                "catalogue backfill changed %d image(s); their exports now read as out of date",
                report.changed,
            )
        http_client = httpx.AsyncClient(
            timeout=httpx.Timeout(30.0, read=300.0, write=300.0), follow_redirects=True
        )
        await worker.start()
        if not layout_engine_available():
            log.error(
                "Pillow's raqm layout engine is unavailable (libfribidi missing): "
                "exports will not match the editor preview"
            )
        log.info("astrocaption %s ready; data dir %s", __version__, cfg.data_dir)
        try:
            yield
        finally:
            await worker.stop()
            await http_client.aclose()

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
    # One config.json read-modify-write at a time, whoever writes: first-run setup (SPEC
    # § 5.1) and the config page share the file, so they share the lock.
    app.state.config_write_lock = asyncio.Lock()
    app.add_middleware(images.UploadGuard, settings_source=source)
    if cfg.trust_proxy:
        # Behind a reverse proxy: X-Forwarded-Proto sets request.url.scheme (the session
        # cookie's Secure follows it, api/auth.py) and X-Forwarded-For the client address
        # (logs only; the sign-in cooldown is global). Every upstream is trusted because the
        # only thing a forged header can change is the Secure flag on the forger's own cookie.
        app.add_middleware(ProxyHeadersMiddleware, trusted_hosts="*")

    app.add_exception_handler(RequestValidationError, plain_validation_error)  # type: ignore[arg-type]
    app.add_exception_handler(FontNotFoundError, font_not_found_error)  # type: ignore[arg-type]

    for router in API_ROUTERS:
        app.include_router(router)

    if cfg.fonts_dir.is_dir():
        app.mount("/fonts", StaticFiles(directory=cfg.fonts_dir), name="fonts")
    spa.mount(app, cfg.static_dir)
    return app


MAX_LABEL_CHARS = 60
MAX_REPORTED_ERRORS = 5  # a body with hundreds of bad keys must not flood the log or the page


def _safe_label(parts: list[str | int]) -> str:
    """A field path fit to echo: the client chooses these names, so it could send a control
    character to forge a log line, or a very long one to bury the message."""
    cleaned = (
        "".join(c if c.isascii() and c.isprintable() else "?" for c in str(part)) for part in parts
    )
    return ".".join(cleaned)[:MAX_LABEL_CHARS] or "request"


async def plain_validation_error(_: Request, exc: RequestValidationError) -> JSONResponse:
    """Plain-language 422s: the default FastAPI body echoes the submitted value (a
    password, here) in ``input`` and returns a list. Neither belongs in a response."""
    labels: list[str] = []
    messages: list[str] = []
    for error in exc.errors():
        # loc holds ints too: a list index (user-meaningful, e.g. "labels.17.color") or the
        # byte offset of a bad body (meaningless, and always leading). Keep an int only when
        # the previous kept part was a string, so a leading offset is dropped but a list
        # index that follows a field name survives; the source ("body"/"query"/"path") is
        # never kept either way.
        named: list[str | int] = []
        for part in error.get("loc", ()):
            is_named_field = isinstance(part, str) and part not in {"body", "query", "path"}
            follows_a_field = isinstance(part, int) and named and isinstance(named[-1], str)
            if is_named_field or follows_a_field:
                named.append(part)
        label = _safe_label(named)
        labels.append(label)
        messages.append(f"{label}: {validation_message(error)}")
    extra = len(messages) - MAX_REPORTED_ERRORS
    if extra > 0:
        labels, messages = labels[:MAX_REPORTED_ERRORS], messages[:MAX_REPORTED_ERRORS]
        messages.append(f"and {extra} more problems")
    log.info("request validation failed: %s", ", ".join(labels) or "request")
    detail = "; ".join(messages) or "Invalid request."
    return JSONResponse({"detail": detail}, status_code=status.HTTP_422_UNPROCESSABLE_CONTENT)


async def font_not_found_error(_: Request, exc: FontNotFoundError) -> JSONResponse:
    """The bundled default font itself is missing from the fonts directory (fonts.py logs
    the same fact when it happens during resolution); ``load_font`` then raises this out of
    ``export_image`` and Starlette would otherwise answer a bare 500. ``exc.args[0]`` is a
    bare file name, never a path (``font_path`` raises with the name it was given)."""
    file = exc.args[0]
    log.error("font bundle is incomplete: %s is missing from the fonts directory", file)
    detail = (
        f"The server's font bundle is incomplete: {file} is missing from the fonts "
        "directory. Restore the bundled fonts and restart."
    )
    return JSONResponse({"detail": detail}, status_code=status.HTTP_500_INTERNAL_SERVER_ERROR)


def _headless_setup(source: SettingsSource, password: str | None) -> None:
    """``ASTROCAPTION_PASSWORD``: complete first-run setup without the browser (SPEC § 11).

    Unset and empty mean the same thing: nothing to do. The decision (is setup still
    required?) is taken under the config lock, inside ``set_owner_password`` (#49).
    """
    if not password:
        return
    refusal = validate_new_password(password)
    if refusal is not None:  # the same bound the login endpoint enforces; never the value
        log.error("ASTROCAPTION_PASSWORD ignored: %s Open /setup instead.", refusal)
        return
    try:
        set_owner_password(source, password, precondition=require_setup)
    except ConfigError as exc:
        log.error(
            "ASTROCAPTION_PASSWORD ignored: %s cannot be read (%s); fix or remove it and "
            "restart to run setup",
            source.current().config_path.name,
            exc.public,
        )
        return
    except PasswordRefused:
        log.info(
            "ASTROCAPTION_PASSWORD ignored: an owner password is already set; remove the "
            "variable, see docs/INSTALL.md to reset the password"
        )
        return
    log.info("owner password set from ASTROCAPTION_PASSWORD")


def build_app_from_env() -> FastAPI:
    """The process entry point's app: every knob a self-hoster can set comes from the environment."""
    return create_app(setup_password=os.environ.get("ASTROCAPTION_PASSWORD"))


app = build_app_from_env()
