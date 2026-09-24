"""The public gallery (SPEC § 5.5, § 8): published, solved, exported images for visitors.

This router carries no owner dependency, so it is the one file whose every handler must gate
itself. The rules are: the whole gallery is 404 when ``public_gallery_enabled`` is off (a
router-level dependency answers 404 for every route then); an image is served only when it
is published, solved and its export files exist; every miss is the same ``Image not found.``,
so a visitor cannot tell "off" from "unpublished" from "unknown". Nothing here reads the
original, the objects or the annotations.
"""

from __future__ import annotations

import logging
from urllib.parse import quote

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.responses import FileResponse

from ..config import Settings
from ..db import Database
from ..models import GalleryItem, ImageRecord
from ..storage import export_exists, render_dir, slug_of
from .deps import DbDep, SettingsDep

log = logging.getLogger(__name__)

NOT_FOUND = "Image not found."
CACHE = "public, no-cache"  # revalidate every use: an unpublished image must not live on in a cache (FileResponse's ETag makes that a 304)

PUBLIC_FILE_KINDS = ("thumb", "preview", "annotated-preview", "export")


def _not_found() -> HTTPException:
    return HTTPException(status.HTTP_404_NOT_FOUND, NOT_FOUND)


def require_gallery_open(settings: SettingsDep) -> None:
    """Router-level gate: every route in this router answers 404 when the gallery is off."""
    if not settings.public_gallery_enabled:
        raise _not_found()


router = APIRouter(
    prefix="/api/gallery", tags=["gallery"], dependencies=[Depends(require_gallery_open)]
)


def gallery_item(rec: ImageRecord) -> GalleryItem:
    assert rec.exported_at  # export_exists() checked it
    base = f"/api/gallery/{rec.id}/files"
    v = quote(rec.exported_at)
    return GalleryItem(
        id=rec.id,
        title=rec.title,
        width=rec.width,
        height=rec.height,
        exported_at=rec.exported_at,
        thumb_url=f"{base}/thumb",
        preview_url=f"{base}/preview",
        annotated_preview_url=f"{base}/annotated-preview?v={v}",
        export_url=f"{base}/export?v={v}",
    )


def _visible(settings: Settings, db: Database, image_id: str) -> ImageRecord:
    """The record a visitor may see, or the one 404."""
    rec = db.get_image(image_id)
    if rec is None or not rec.published or not export_exists(settings, rec):
        raise _not_found()
    return rec


@router.get("")
async def list_gallery(settings: SettingsDep, db: DbDep) -> list[GalleryItem]:
    items: list[GalleryItem] = []
    for rec in db.list_published_images():
        if not export_exists(settings, rec):
            # Published, then the render dir was emptied by hand: not the visitor's problem.
            log.warning(
                "gallery: skipping published image %s: its export files are missing", rec.id
            )
            continue
        items.append(gallery_item(rec))
    return items


@router.get("/{image_id}")
async def get_gallery_item(image_id: str, settings: SettingsDep, db: DbDep) -> GalleryItem:
    return gallery_item(_visible(settings, db, image_id))


@router.get("/{image_id}/files/{kind}")
async def gallery_file(image_id: str, kind: str, settings: SettingsDep, db: DbDep) -> FileResponse:
    rec = _visible(settings, db, image_id)
    if kind not in PUBLIC_FILE_KINDS:
        raise _not_found()
    out = render_dir(settings, image_id)
    if kind == "thumb":
        path = settings.data_dir / rec.thumb_path
    elif kind == "preview":
        path = settings.data_dir / rec.preview_path
    elif kind == "annotated-preview":
        path = out / "annotated_preview.jpg"
    else:
        path = out / "annotated.jpg"
    if not path.is_file():
        raise _not_found()
    filename = f"{slug_of(rec.title)}-annotated.jpg" if kind == "export" else None
    return FileResponse(
        path, media_type="image/jpeg", filename=filename, headers={"Cache-Control": CACHE}
    )
