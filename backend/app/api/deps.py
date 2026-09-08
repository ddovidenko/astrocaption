from __future__ import annotations

from typing import Annotated

from fastapi import Depends, HTTPException, Request, status

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


def require_owner(request: Request, settings: SettingsDep) -> None:
    """Router-level gate for every owner route (SPEC § 8). Plain 401, no hints."""
    if not is_authenticated(request, settings):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Sign in to continue.")
