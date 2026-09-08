from __future__ import annotations

from typing import Annotated

from fastapi import Depends, Request

from ..config import Settings
from ..db import Database
from ..worker import SolveWorker


def get_settings(request: Request) -> Settings:
    settings: Settings = request.app.state.settings
    return settings


def get_db(request: Request) -> Database:
    db: Database = request.app.state.db
    return db


def get_worker(request: Request) -> SolveWorker:
    worker: SolveWorker = request.app.state.worker
    return worker


SettingsDep = Annotated[Settings, Depends(get_settings)]
DbDep = Annotated[Database, Depends(get_db)]
WorkerDep = Annotated[SolveWorker, Depends(get_worker)]
