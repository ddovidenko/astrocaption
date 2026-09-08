from __future__ import annotations

import asyncio
import errno
import os
import re
import uuid
from pathlib import Path
from typing import Annotated, BinaryIO, Literal
from urllib.parse import quote

from fastapi import APIRouter, Depends, Form, HTTPException, UploadFile, status
from fastapi.responses import FileResponse, JSONResponse
from starlette.types import ASGIApp, Receive, Scope, Send

from ..config import Settings, SettingsSource
from ..db import Database
from ..models import (
    Annotations,
    ExportOut,
    ExportRequest,
    ImageOut,
    ImageRecord,
    NamePreference,
    ObjectOut,
    SolveHints,
    SolveObject,
    SolveStatus,
    utcnow_iso,
)
from ..render import render_annotated
from ..solver.nova import job_log_url, status_url
from ..storage import (
    UnsupportedImageError,
    delete_image_files,
    format_of,
    image_dir,
    make_derivatives,
    normalised_extension,
    probe_image,
    render_dir,
)
from .deps import DbDep, SettingsDep, WorkerDep, require_owner

router = APIRouter(prefix="/api/images", tags=["images"], dependencies=[Depends(require_owner)])

COPY_CHUNK = 1024 * 1024
# Room for the multipart framing and the title field on top of the file itself.
UPLOAD_ENVELOPE_BYTES = 64 * 1024
FileKind = Literal["original", "preview", "thumb", "annotated-preview"]


class UploadTooLargeError(ValueError):
    pass


def _too_large_detail(settings: Settings) -> str:
    return f"File is larger than the {settings.max_upload_mb} MB upload limit."


class UploadSizeGuard:
    """Refuse an oversized upload from its Content-Length, before the body is spooled.

    FastAPI parses the multipart form before the route or its dependencies run, so a
    multi-gigabyte POST would otherwise fill temp space before ``upload_image`` could say
    no. Requests without a usable Content-Length (chunked) fall through to the streaming
    cap in ``_copy_limited``, which stays the backstop for everything.
    """

    def __init__(self, app: ASGIApp, settings_source: SettingsSource) -> None:
        self._app = app
        self._source = settings_source

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] == "http" and scope["method"] == "POST" and scope["path"] == router.prefix:
            declared = _declared_length(scope)
            settings = self._source.current()
            if declared is not None and declared > (
                settings.max_upload_mb * 1024 * 1024 + UPLOAD_ENVELOPE_BYTES
            ):
                response = JSONResponse(
                    {"detail": _too_large_detail(settings)},
                    status_code=status.HTTP_413_CONTENT_TOO_LARGE,
                )
                await response(scope, receive, send)
                return
        await self._app(scope, receive, send)


def _declared_length(scope: Scope) -> int | None:
    for name, value in scope["headers"]:
        if name == b"content-length":
            return int(value) if value.isdigit() else None
    return None


def _copy_limited(src: BinaryIO, dest: Path, limit: int) -> int:
    total = 0
    with dest.open("wb") as out:
        while chunk := src.read(COPY_CHUNK):
            total += len(chunk)
            if total > limit:
                raise UploadTooLargeError(total)
            out.write(chunk)
    return total


def _slug(text: str) -> str:
    return re.sub(r"[^A-Za-z0-9._-]+", "-", text).strip("-.") or "image"


def image_out(rec: ImageRecord, settings: Settings, object_count: int) -> ImageOut:
    base = f"/api/images/{rec.id}"
    exported = quote(rec.exported_at) if rec.exported_at else None
    return ImageOut(
        id=rec.id,
        title=rec.title,
        original_name=rec.original_name,
        created_at=rec.created_at,
        updated_at=rec.updated_at,
        width=rec.width,
        height=rec.height,
        solve_status=rec.solve_status,
        solve_error=rec.solve_error,
        nova_submission_id=rec.nova_submission_id,
        nova_job_id=rec.nova_job_id,
        nova_status_url=(
            status_url(settings.nova_base_url, rec.nova_submission_id)
            if rec.nova_submission_id is not None
            else None
        ),
        nova_job_log_url=(
            job_log_url(settings.nova_base_url, rec.nova_job_id)
            if rec.nova_job_id is not None
            else None
        ),
        calibration=rec.calibration,
        published=rec.published,
        object_count=object_count,
        exported_at=rec.exported_at,
        original_format=(fmt.name if (fmt := format_of(Path(rec.original_path))) else "image"),
        preview_url=f"{base}/files/preview",
        thumb_url=f"{base}/files/thumb",
        original_url=f"{base}/files/original",
        annotated_preview_url=f"{base}/files/annotated-preview?v={exported}" if exported else None,
        export_url=f"{base}/export?v={exported}" if exported else None,
    )


def _get_or_404(db: Database, image_id: str) -> ImageRecord:
    rec = db.get_image(image_id)
    if rec is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Image not found.")
    return rec


@router.post("", status_code=status.HTTP_201_CREATED)
async def upload_image(
    file: UploadFile,
    settings: SettingsDep,
    db: DbDep,
    worker: WorkerDep,
    title: Annotated[str | None, Form()] = None,
) -> ImageOut:
    filename = file.filename or ""
    if normalised_extension(filename) is None:
        raise HTTPException(
            status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
            "Unsupported file type. Upload a JPG, PNG or TIFF.",
        )
    limit = settings.max_upload_mb * 1024 * 1024
    image_id = str(uuid.uuid4())
    directory = image_dir(settings, image_id)
    directory.mkdir(parents=True, exist_ok=False)
    upload_path = directory / "original.upload"
    try:
        await asyncio.to_thread(_copy_limited, file.file, upload_path, limit)
        # The stored extension follows the detected format, not the upload's file name.
        width, height, ext = await asyncio.to_thread(probe_image, upload_path)
        original = upload_path.with_name(f"original.{ext}")
        upload_path.rename(original)
        preview, thumb = await asyncio.to_thread(make_derivatives, original, directory)
        now = utcnow_iso()
        rec = ImageRecord(
            id=image_id,
            created_at=now,
            updated_at=now,
            title=(title or "").strip() or Path(filename).stem or "Untitled",
            original_name=Path(filename).name,
            original_path=original.relative_to(settings.data_dir).as_posix(),
            preview_path=preview.relative_to(settings.data_dir).as_posix(),
            thumb_path=thumb.relative_to(settings.data_dir).as_posix(),
            width=width,
            height=height,
        )
        db.insert_image(rec)
        worker.enqueue(image_id)
    except UploadTooLargeError:
        delete_image_files(settings, image_id)
        raise HTTPException(
            status.HTTP_413_CONTENT_TOO_LARGE, _too_large_detail(settings)
        ) from None
    except UnsupportedImageError as exc:
        delete_image_files(settings, image_id)
        raise HTTPException(
            status.HTTP_415_UNSUPPORTED_MEDIA_TYPE, f"Not a usable image: {exc}"
        ) from None
    except OSError as exc:
        delete_image_files(settings, image_id)
        if exc.errno == errno.ENOSPC:
            raise HTTPException(
                status.HTTP_507_INSUFFICIENT_STORAGE, "The server is out of disk space."
            ) from None
        raise
    except Exception:  # any failure before the row exists leaves nothing behind on disk
        delete_image_files(settings, image_id)
        raise
    return image_out(rec, settings, 0)


@router.get("")
async def list_images(settings: SettingsDep, db: DbDep) -> list[ImageOut]:
    counts = db.object_counts()
    return [image_out(rec, settings, counts.get(rec.id, 0)) for rec in db.list_images()]


@router.get("/{image_id}")
async def get_image(image_id: str, settings: SettingsDep, db: DbDep) -> ImageOut:
    rec = _get_or_404(db, image_id)
    return image_out(rec, settings, db.count_objects(image_id))


@router.delete("/{image_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_image(image_id: str, settings: SettingsDep, db: DbDep) -> None:
    if not db.delete_image(image_id):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Image not found.")
    await asyncio.to_thread(delete_image_files, settings, image_id)


@router.post("/{image_id}/solve")
async def solve_image(
    image_id: str,
    settings: SettingsDep,
    db: DbDep,
    worker: WorkerDep,
    hints: SolveHints | None = None,
) -> ImageOut:
    rec = _get_or_404(db, image_id)
    if rec.solve_status in (SolveStatus.PENDING, SolveStatus.SOLVING):
        raise HTTPException(status.HTTP_409_CONFLICT, "A solve is already in progress.")
    db.update_image(
        image_id,
        {"solve_status": SolveStatus.PENDING, "solve_error": None, "solve_hints": hints},
    )
    worker.enqueue(image_id)
    return image_out(_get_or_404(db, image_id), settings, db.count_objects(image_id))


@router.get("/{image_id}/objects")
async def list_objects(image_id: str, db: DbDep) -> list[ObjectOut]:
    _get_or_404(db, image_id)
    ann = db.get_annotations(image_id)
    preference: NamePreference = ann.style.name_preference if ann else "popular"
    return [_object_out(o, preference) for o in db.get_objects(image_id)]


def _object_out(o: SolveObject, preference: NamePreference) -> ObjectOut:
    return ObjectOut(
        id=o.id,
        catalog_names=o.catalog_names,
        primary_name=o.primary_name_for(preference),
        type=o.type,
        x=o.x,
        y=o.y,
        radius=o.radius,
    )


@router.get("/{image_id}/annotations")
async def get_annotations(image_id: str, db: DbDep) -> Annotations:
    _get_or_404(db, image_id)
    ann = db.get_annotations(image_id)
    if ann is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Image has not been solved yet.")
    return ann


def _render_export(
    settings: Settings,
    rec: ImageRecord,
    objects: list[SolveObject],
    ann: Annotations,
    quality: int | None,
    scale: float,
) -> tuple[int, int, int, str]:
    out_dir = render_dir(settings, rec.id)
    out_dir.mkdir(parents=True, exist_ok=True)
    final = out_dir / "annotated.jpg"
    preview = out_dir / "annotated_preview.jpg"
    token = uuid.uuid4().hex
    tmp = out_dir / f".annotated-{token}.jpg"
    tmp_preview = out_dir / f".preview-{token}.jpg"
    try:
        result = render_annotated(
            settings.data_dir / rec.original_path,
            objects,
            ann,
            settings.fonts_dir,
            tmp,
            quality=quality,
            scale=scale,
            preview_path=tmp_preview,
        )
        # Both files swap in only after the full render succeeded, so they always match.
        os.replace(tmp, final)
        os.replace(tmp_preview, preview)
    finally:
        tmp.unlink(missing_ok=True)
        tmp_preview.unlink(missing_ok=True)
    return result.width, result.height, final.stat().st_size, result.encoding


@router.post("/{image_id}/export")
async def export_image(
    image_id: str,
    settings: SettingsDep,
    db: DbDep,
    body: ExportRequest | None = None,
) -> ExportOut:
    rec = _get_or_404(db, image_id)
    ann = db.get_annotations(image_id)
    if rec.solve_status != SolveStatus.SOLVED or ann is None:
        raise HTTPException(status.HTTP_409_CONFLICT, "Image is not solved yet.")
    req = body or ExportRequest()
    objects = db.get_objects(image_id)
    width, height, size, encoding = await asyncio.to_thread(
        _render_export, settings, rec, objects, ann, req.quality, req.scale
    )
    exported_at = utcnow_iso()
    db.update_image(image_id, {"exported_at": exported_at})
    out = image_out(_get_or_404(db, image_id), settings, len(objects))
    assert out.export_url and out.annotated_preview_url
    return ExportOut(
        export_url=out.export_url,
        annotated_preview_url=out.annotated_preview_url,
        width=width,
        height=height,
        bytes=size,
        exported_at=exported_at,
        encoding=encoding,
    )


@router.get("/{image_id}/export")
async def download_export(image_id: str, settings: SettingsDep, db: DbDep) -> FileResponse:
    rec = _get_or_404(db, image_id)
    path = render_dir(settings, image_id) / "annotated.jpg"
    if not path.is_file():
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No export yet. Run an export first.")
    return FileResponse(
        path,
        media_type="image/jpeg",
        filename=f"{_slug(rec.title)}-annotated.jpg",
        headers={"Cache-Control": "private, no-cache"},
    )


@router.get("/{image_id}/files/{kind}")
async def image_file(
    image_id: str, kind: FileKind, settings: SettingsDep, db: DbDep
) -> FileResponse:
    rec = _get_or_404(db, image_id)
    if kind == "original":
        path = settings.data_dir / rec.original_path
        fmt = format_of(path)
        media = fmt.media_type if fmt else "application/octet-stream"
    elif kind == "preview":
        path, media = settings.data_dir / rec.preview_path, "image/jpeg"
    elif kind == "thumb":
        path, media = settings.data_dir / rec.thumb_path, "image/jpeg"
    else:
        path, media = render_dir(settings, image_id) / "annotated_preview.jpg", "image/jpeg"
    if not path.is_file():
        raise HTTPException(status.HTTP_404_NOT_FOUND, "File not found.")
    cache = "private, no-cache" if kind == "annotated-preview" else "private, max-age=86400"
    return FileResponse(path, media_type=media, headers={"Cache-Control": cache})
