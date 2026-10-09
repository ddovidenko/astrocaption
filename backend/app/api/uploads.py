"""Chunked uploads (#166): a file larger than one chunk arrives in several requests.

A reverse proxy caps a request body (Cloudflare's free plan at 100 MB) while the app's own limit
goes to 1 GB. Splitting the file keeps every request under the cap. The session lives on disk,
not in the database: ``data/uploads/.partial/<id>/`` holds ``meta.json`` (what ``POST`` declared)
and one ``<n>.part`` per chunk; ``finish`` concatenates them into a fresh image directory and
hands the bytes to the same ingest as the single-shot upload, so the two cannot drift.

Every refusal is plain language; the browser shows ``detail`` as it is. A session that is never
finished is swept after a day, and all of them at startup (nothing resumes across a restart).
"""

from __future__ import annotations

import asyncio
import json
import logging
import math
import shutil
import time
import uuid
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Response, status
from starlette.requests import Request

from ..config import Settings
from ..models import ImageOut, UploadSessionOut, UploadSessionRequest
from ..storage import delete_image_files, normalised_extension
from .deps import DbDep, SettingsDep, WorkerDep, require_owner
from .errors import DISK_FULL_ERRNOS
from .images import (
    UNSUPPORTED_TYPE_MESSAGE,
    ingest_upload,
    start_image_dir,
    too_large_detail,
)

log = logging.getLogger(__name__)

router = APIRouter(prefix="/api/uploads", tags=["uploads"], dependencies=[Depends(require_owner)])

SESSION_TTL_SECONDS = 24 * 3600
COPY_CHUNK = 1024 * 1024
SESSION_GONE = "That upload is no longer open; start it again."
CHUNK_TOO_LARGE = "The upload sent a larger chunk than it declared; start it again."
INCOMPLETE = "The upload is incomplete; start it again."
DISK_FULL = "The server is out of disk space."


def clear_partial_uploads(settings: Settings) -> None:
    """Startup: nothing resumes across a restart, so every unfinished session goes."""
    shutil.rmtree(settings.partial_uploads_dir, ignore_errors=True)


def _sweep_stale(settings: Settings) -> None:
    root = settings.partial_uploads_dir
    if not root.is_dir():
        return
    deadline = time.time() - SESSION_TTL_SECONDS
    for session in root.iterdir():
        try:
            if session.is_dir() and session.stat().st_mtime < deadline:
                shutil.rmtree(session, ignore_errors=True)
                log.info("removed abandoned upload session %s", session.name)
        except OSError:  # pragma: no cover - a session vanishing under us is fine
            pass


class _Session:
    def __init__(self, directory: Path, meta: dict[str, object]) -> None:
        self.directory = directory
        self.name = str(meta["name"])
        self.size = int(str(meta["size"]))
        self.title = meta.get("title")
        self.chunk_bytes = int(str(meta["chunk_bytes"]))

    @property
    def chunks(self) -> int:
        return math.ceil(self.size / self.chunk_bytes)

    def part(self, n: int) -> Path:
        return self.directory / f"{n:06d}.part"


def _session_dir(settings: Settings, session_id: str) -> Path:
    try:
        uuid.UUID(session_id)
    except ValueError:
        raise HTTPException(status.HTTP_404_NOT_FOUND, SESSION_GONE) from None
    return settings.partial_uploads_dir / session_id


def _load(settings: Settings, session_id: str) -> _Session:
    directory = _session_dir(settings, session_id)
    try:
        meta = json.loads((directory / "meta.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        raise HTTPException(status.HTTP_404_NOT_FOUND, SESSION_GONE) from None
    return _Session(directory, meta)


def _disk_full(exc: OSError) -> HTTPException | None:
    if exc.errno in DISK_FULL_ERRNOS:
        return HTTPException(status.HTTP_507_INSUFFICIENT_STORAGE, DISK_FULL)
    return None


@router.post("", status_code=status.HTTP_201_CREATED)
async def open_session(body: UploadSessionRequest, settings: SettingsDep) -> UploadSessionOut:
    if normalised_extension(body.name) is None:
        raise HTTPException(status.HTTP_415_UNSUPPORTED_MEDIA_TYPE, UNSUPPORTED_TYPE_MESSAGE)
    if body.size > settings.max_upload_mb * 1024 * 1024:
        raise HTTPException(status.HTTP_413_CONTENT_TOO_LARGE, too_large_detail(settings))
    chunk_bytes = settings.upload_chunk_mb * 1024 * 1024
    session_id = str(uuid.uuid4())
    directory = settings.partial_uploads_dir / session_id
    meta = {
        "name": Path(body.name).name,
        "size": body.size,
        "title": body.title,
        "chunk_bytes": chunk_bytes,
    }

    def create() -> None:
        _sweep_stale(settings)
        directory.mkdir(parents=True, exist_ok=False)
        (directory / "meta.json").write_text(json.dumps(meta), encoding="utf-8")

    try:
        await asyncio.to_thread(create)
    except OSError as exc:
        shutil.rmtree(directory, ignore_errors=True)
        if full := _disk_full(exc):
            raise full from None
        raise
    return UploadSessionOut(
        id=session_id, chunk_bytes=chunk_bytes, chunks=math.ceil(body.size / chunk_bytes)
    )


def _expected_chunk_size(session: _Session, n: int) -> int:
    if n == session.chunks - 1:
        return session.size - n * session.chunk_bytes
    return session.chunk_bytes


@router.put("/{session_id}/{n}", status_code=status.HTTP_204_NO_CONTENT)
async def put_chunk(session_id: str, n: int, request: Request, settings: SettingsDep) -> Response:
    """Chunk ``n`` of the session, raw bytes. Sending the same chunk again replaces it, which is
    what makes a retry safe. Refused before the body is read when its declared length is not the
    one the session expects, and cut off at that size while streaming otherwise."""
    session = _load(settings, session_id)
    if not 0 <= n < session.chunks:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, INCOMPLETE)
    expected = _expected_chunk_size(session, n)
    declared = request.headers.get("content-length")
    if declared is not None and declared.isdigit() and int(declared) > expected:
        raise HTTPException(status.HTTP_413_CONTENT_TOO_LARGE, CHUNK_TOO_LARGE)
    target = session.part(n)
    incoming = target.with_suffix(".tmp")
    total = 0
    try:
        with incoming.open("wb") as out:
            async for piece in request.stream():
                total += len(piece)
                if total > expected:
                    raise HTTPException(status.HTTP_413_CONTENT_TOO_LARGE, CHUNK_TOO_LARGE)
                await asyncio.to_thread(out.write, piece)
        if total != expected:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, INCOMPLETE)
        incoming.replace(target)
    except HTTPException:
        incoming.unlink(missing_ok=True)
        raise
    except OSError as exc:
        incoming.unlink(missing_ok=True)
        if full := _disk_full(exc):
            raise full from None
        raise
    return Response(status_code=status.HTTP_204_NO_CONTENT)


def _assemble(session: _Session, upload_path: Path) -> None:
    with upload_path.open("wb") as out:
        for n in range(session.chunks):
            with session.part(n).open("rb") as part:
                shutil.copyfileobj(part, out, COPY_CHUNK)


@router.post("/{session_id}/finish", status_code=status.HTTP_201_CREATED)
async def finish_session(
    session_id: str, settings: SettingsDep, db: DbDep, worker: WorkerDep
) -> ImageOut:
    session = _load(settings, session_id)
    sizes = [
        session.part(n).stat().st_size if session.part(n).is_file() else -1
        for n in range(session.chunks)
    ]
    if any(size != _expected_chunk_size(session, n) for n, size in enumerate(sizes)):
        raise HTTPException(status.HTTP_409_CONFLICT, INCOMPLETE)
    image_id = str(uuid.uuid4())
    upload_path = start_image_dir(settings, image_id)
    try:
        await asyncio.to_thread(_assemble, session, upload_path)
    except OSError as exc:
        delete_image_files(settings, image_id)
        if full := _disk_full(exc):
            raise full from None
        raise
    except Exception:
        delete_image_files(settings, image_id)
        raise
    shutil.rmtree(session.directory, ignore_errors=True)
    title = session.title if isinstance(session.title, str) else None
    return await ingest_upload(settings, db, worker, image_id, upload_path, session.name, title)


@router.delete("/{session_id}", status_code=status.HTTP_204_NO_CONTENT)
async def abandon_session(session_id: str, settings: SettingsDep) -> Response:
    """Cancel: the partial files go now rather than at the sweep. Idempotent."""
    shutil.rmtree(_session_dir(settings, session_id), ignore_errors=True)
    return Response(status_code=status.HTTP_204_NO_CONTENT)
