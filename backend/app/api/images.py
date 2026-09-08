from __future__ import annotations

import asyncio
import os
import re
import uuid
from pathlib import Path
from typing import Annotated, BinaryIO, Literal
from urllib.parse import quote

from fastapi import APIRouter, Form, HTTPException, UploadFile, status
from fastapi.responses import FileResponse

from ..config import Settings
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
    image_dir,
    make_annotated_preview,
    make_derivatives,
    normalised_extension,
    probe_image,
    render_dir,
)
from .deps import DbDep, SettingsDep, WorkerDep

router = APIRouter(prefix="/api/images", tags=["images"])

COPY_CHUNK = 1024 * 1024
MEDIA_TYPES = {"jpg": "image/jpeg", "png": "image/png", "tif": "image/tiff"}
FORMAT_NAMES = {"jpg": "JPEG", "png": "PNG", "tif": "TIFF"}
FileKind = Literal["original", "preview", "thumb", "annotated-preview"]


class UploadTooLargeError(ValueError):
    pass


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
        original_format=FORMAT_NAMES.get(
            Path(rec.original_path).suffix.lstrip(".").lower(), "image"
        ),
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
    ext = normalised_extension(filename)
    if ext is None:
        raise HTTPException(
            status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
            "Unsupported file type. Upload a JPG, PNG or TIFF.",
        )
    limit = settings.max_upload_mb * 1024 * 1024
    image_id = str(uuid.uuid4())
    directory = image_dir(settings, image_id)
    directory.mkdir(parents=True, exist_ok=False)
    original = directory / f"original.{ext}"
    try:
        await asyncio.to_thread(_copy_limited, file.file, original, limit)
        width, height = await asyncio.to_thread(probe_image, original)
        preview, thumb = await asyncio.to_thread(make_derivatives, original, directory)
    except UploadTooLargeError:
        delete_image_files(settings, image_id)
        raise HTTPException(
            status.HTTP_413_CONTENT_TOO_LARGE,
            f"File is larger than the {settings.max_upload_mb} MB upload limit.",
        ) from None
    except UnsupportedImageError as exc:
        delete_image_files(settings, image_id)
        raise HTTPException(
            status.HTTP_415_UNSUPPORTED_MEDIA_TYPE, f"Not a usable image: {exc}"
        ) from None
    except Exception:
        delete_image_files(settings, image_id)
        raise

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
    db.update_image(image_id, {"solve_status": SolveStatus.PENDING, "solve_error": None})
    worker.enqueue(image_id, hints)
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
    tmp = out_dir / f".annotated-{uuid.uuid4().hex}.jpg"
    try:
        result = render_annotated(
            settings.data_dir / rec.original_path,
            objects,
            ann,
            settings.fonts_dir,
            tmp,
            quality=quality,
            scale=scale,
        )
        os.replace(tmp, final)
    finally:
        tmp.unlink(missing_ok=True)
    make_annotated_preview(final, out_dir / "annotated_preview.jpg")
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
        media = MEDIA_TYPES.get(path.suffix.lstrip(".").lower(), "application/octet-stream")
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
