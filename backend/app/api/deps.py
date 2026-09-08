from __future__ import annotations

from typing import Annotated

from fastapi import Depends, HTTPException, Request, status
from fastapi.responses import JSONResponse

from ..auth import COOKIE_NAME, session_is_valid
from ..config import Settings, SettingsSource
from ..db import Database
from ..worker import SolveWorker


def get_settings(request: Request) -> Settings:
    """Current settings: config.json values are re-read when the file changes."""
    source: SettingsSource = request.app.state.settings_source
    return source.current()


def get_db(request: Request) -> Database:
    db: Database = request.app.state.db
    return db


def get_worker(request: Request) -> SolveWorker:
    worker: SolveWorker = request.app.state.worker
    return worker


SettingsDep = Annotated[Settings, Depends(get_settings)]
DbDep = Annotated[Database, Depends(get_db)]
WorkerDep = Annotated[SolveWorker, Depends(get_worker)]


def is_authenticated(request: Request, settings: Settings) -> bool:
    if not settings.auth_ready:
        return False
    assert settings.session_secret and settings.password_hash  # auth_ready guarantees both
    return session_is_valid(
        request.cookies.get(COOKIE_NAME), settings.session_secret, settings.password_hash
    )


UNAUTHORIZED_DETAIL = "Sign in to continue."  # SPEC § 8: plain 401, no hints


def unauthorized_response() -> JSONResponse:
    """The 401 body as a response, for middleware that answers before routing."""
    return JSONResponse({"detail": UNAUTHORIZED_DETAIL}, status_code=status.HTTP_401_UNAUTHORIZED)


def require_owner(request: Request, settings: SettingsDep) -> None:
    """Router-level gate for every owner route (SPEC § 8)."""
    if not is_authenticated(request, settings):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, UNAUTHORIZED_DETAIL)
