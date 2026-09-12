from __future__ import annotations

import asyncio
import logging
import os
import re
import uuid
from collections import Counter
from pathlib import Path
from typing import Annotated, BinaryIO, Literal
from urllib.parse import quote

from fastapi import APIRouter, Depends, Form, HTTPException, UploadFile, status
from fastapi.responses import FileResponse, JSONResponse
from starlette.requests import Request
from starlette.types import ASGIApp, Receive, Scope, Send

from ..config import Settings, SettingsSource
from ..db import Database
from ..fonts import list_fonts, resolved_style
from ..layout import autoplace
from ..models import (
    Annotations,
    AnnotationsUpdate,
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
from .deps import (
    DbDep,
    SettingsDep,
    WorkerDep,
    is_authenticated,
    require_owner,
    unauthorized_response,
)
from .errors import DISK_FULL_ERRNOS

log = logging.getLogger(__name__)

router = APIRouter(prefix="/api/images", tags=["images"], dependencies=[Depends(require_owner)])

COPY_CHUNK = 1024 * 1024
# Room for the multipart framing and the title field on top of the file itself.
UPLOAD_ENVELOPE_BYTES = 64 * 1024
FileKind = Literal["original", "preview", "thumb", "annotated-preview"]


class UploadTooLargeError(ValueError):
    pass


def _too_large_detail(settings: Settings) -> str:
    return f"File is larger than the {settings.max_upload_mb} MB upload limit."


class UploadGuard:
    """Turn an upload away before its body is parsed: not signed in, or too large.

    FastAPI parses the multipart form before the route or its dependencies run, so a
    multi-gigabyte POST would otherwise fill temp space before ``upload_image`` could say
    no -- and an anonymous caller would have their body spooled, then learn the site's
    upload limit from a 413, before ``require_owner`` ever ran. The sign-in check therefore
    comes first. Requests without a usable
    Content-Length (chunked) fall through to the streaming cap in ``_copy_limited``, which
    stays the backstop for everything.
    """

    def __init__(self, app: ASGIApp, settings_source: SettingsSource) -> None:
        self._app = app
        self._source = settings_source

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] == "http" and scope["method"] == "POST" and scope["path"] == router.prefix:
            settings = self._source.current()
            if not is_authenticated(Request(scope), settings):
                await unauthorized_response()(scope, receive, send)
                return
            declared = _declared_length(scope)
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
        if exc.errno in DISK_FULL_ERRNOS:
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
async def get_annotations(image_id: str, settings: SettingsDep, db: DbDep) -> Annotations:
    _get_or_404(db, image_id)
    ann = db.get_annotations(image_id)
    if ann is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, NOT_SOLVED_MESSAGE)
    return ann.model_copy(update={"style": resolved_style(settings.fonts_dir, ann.style)})


SOLVING_MESSAGE = "The image is still being solved; try again when it is done."
CONFLICT_MESSAGE = "This image was changed elsewhere. Reload to continue editing."
NOT_SOLVED_MESSAGE = "Image has not been solved yet."
OBJECTS_DUPLICATE_MESSAGE = "labels: each of this image's objects may appear only once."
OBJECTS_UNKNOWN_MESSAGE = "labels: every label must name one of this image's objects."
OBJECTS_MISSING_MESSAGE = "labels: the document must list every one of this image's objects."
FONT_MESSAGE = "style.font_file is not a bundled font."


def _check_version(doc: AnnotationsUpdate, stored: Annotations, image_id: str) -> None:
    """409 when the editor's document is not the stored version. Checked BEFORE
    ``_validate_document``: a stale document may name objects that no longer exist after a
    re-solve, and "reload" must win over a labels error (the compare-and-swap in the PUT
    still guards the write under a race)."""
    if doc.version != stored.version:
        log.info(
            "annotations for %s: stale version %d, stored %d", image_id, doc.version, stored.version
        )
        raise HTTPException(status.HTTP_409_CONFLICT, CONFLICT_MESSAGE)


def _annotations_target(db: Database, image_id: str) -> tuple[ImageRecord, Annotations]:
    """The image and its stored layout, or the 404/409 the editor shows."""
    rec = _get_or_404(db, image_id)
    if rec.solve_status in (SolveStatus.PENDING, SolveStatus.SOLVING):
        raise HTTPException(status.HTTP_409_CONFLICT, SOLVING_MESSAGE)
    ann = db.get_annotations(image_id)
    if ann is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, NOT_SOLVED_MESSAGE)
    return rec, ann


def _validate_document(
    doc: AnnotationsUpdate, objects: list[SolveObject], settings: Settings, image_id: str
) -> None:
    """Plain 422s for what the models cannot check: object ids and the font bundle. Messages
    never repeat the submitted value (CLAUDE.md); the offending ids are logged server-side only.
    The document must list every one of the image's objects exactly once (the server always
    emits one label per object; a shorter list would silently delete labels on a full-replace
    PUT), so duplicate, unknown and missing ids are each their own cause and their own sentence.
    """
    ids = [lab.object_id for lab in doc.labels]
    known = {o.id for o in objects}
    duplicates = sorted(i for i, n in Counter(ids).items() if n > 1)
    if duplicates:
        log.info("annotations for %s rejected: duplicate object ids %s", image_id, duplicates)
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, OBJECTS_DUPLICATE_MESSAGE)
    unknown = sorted(set(ids) - known)
    if unknown:
        log.info("annotations for %s rejected: unknown object ids %s", image_id, unknown)
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, OBJECTS_UNKNOWN_MESSAGE)
    missing = sorted(known - set(ids))
    if missing:
        log.info("annotations for %s rejected: missing object ids %s", image_id, missing)
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, OBJECTS_MISSING_MESSAGE)
    if doc.style.font_file not in {f.file for f in list_fonts(settings.fonts_dir)}:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, FONT_MESSAGE)


@router.put("/{image_id}/annotations")
async def put_annotations(
    image_id: str, doc: AnnotationsUpdate, settings: SettingsDep, db: DbDep
) -> Annotations:
    """The editor's autosave (design § 4): stored as version + 1 when ``doc.version`` is still
    the stored one, else 409 and nothing written."""
    _, stored = _annotations_target(db, image_id)
    _check_version(doc, stored, image_id)
    _validate_document(doc, db.get_objects(image_id), settings, image_id)
    ann = Annotations(
        image_id=image_id, style=doc.style, labels=doc.labels, version=doc.version + 1
    )
    if not db.update_annotations_if_version(ann, expected_version=doc.version):
        if db.get_annotations(image_id) is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Image not found.")
        log.info("annotations for %s: compare-and-swap lost", image_id)
        raise HTTPException(status.HTTP_409_CONFLICT, CONFLICT_MESSAGE)  # lost the race
    return ann


@router.post("/{image_id}/autoarrange")
async def autoarrange(
    image_id: str, doc: AnnotationsUpdate, settings: SettingsDep, db: DbDep
) -> Annotations:
    """Run the placer on every enabled label of the submitted document (no fixed labels) and
    return the result without storing it; the editor applies it and autosaves (design § 4)."""
    rec, stored = _annotations_target(db, image_id)
    _check_version(doc, stored, image_id)
    objects = db.get_objects(image_id)
    _validate_document(doc, objects, settings, image_id)
    labels = await asyncio.to_thread(
        autoplace, rec.width, rec.height, doc.style, doc.labels, objects, settings.fonts_dir
    )
    return Annotations(
        image_id=image_id,
        style=doc.style,
        labels=labels,
        version=doc.version,
        updated_at=stored.updated_at,
    )


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
