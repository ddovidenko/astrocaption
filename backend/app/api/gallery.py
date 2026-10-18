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
from xml.sax.saxutils import escape as xml_escape

from fastapi import APIRouter, Depends, HTTPException, Request, status
from fastapi.responses import FileResponse, PlainTextResponse, Response

from ..config import Settings
from ..db import PAGE_LIMIT, Database, ListFilter, UnknownCursor
from ..models import GalleryItem, ImageRecord, Page
from ..seo import base_url
from ..storage import export_exists, render_dir, slug_of
from .deps import DbDep, SettingsDep
from .images import PAGE_GONE, BeforeParam, DateParam, KindParam, LimitParam, QParam

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
        created_at=rec.created_at,
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
async def list_gallery(
    settings: SettingsDep,
    db: DbDep,
    limit: LimitParam = PAGE_LIMIT,
    before: BeforeParam = None,
    q: QParam = "",
    kind: KindParam = None,
    since: DateParam = None,
    until: DateParam = None,
) -> Page[GalleryItem]:
    try:
        page = db.list_published_images(
            limit, before, ListFilter(q=q, kind=kind, since=since, until=until)
        )
    except UnknownCursor:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, PAGE_GONE) from None
    items: list[GalleryItem] = []
    for rec in page.items:
        if not export_exists(settings, rec):
            # Published, then the render dir was emptied by hand: not the visitor's problem.
            # The row still counts towards the page, so a skipped one short-changes the page
            # by one rather than repeating or hiding a neighbour.
            log.warning(
                "gallery: skipping published image %s: its export files are missing", rec.id
            )
            continue
        items.append(gallery_item(rec))
    return Page(items=items, next=page.next)


@router.get("/{image_id}")
async def get_gallery_item(image_id: str, settings: SettingsDep, db: DbDep) -> GalleryItem:
    return gallery_item(_visible(settings, db, image_id))


# GET and HEAD, like the owner's file route: a link checker or a crawler probing a gallery URL
# gets 200 rather than 405 (#137). FileResponse serves a HEAD as headers only; the second route
# keeps the OpenAPI operation ids distinct.
@router.get("/{image_id}/files/{kind}")
@router.head("/{image_id}/files/{kind}", include_in_schema=False)
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


# Two public files outside /api and outside the gallery-off gate: with the gallery off the
# sitemap is empty rather than a 404, so a crawler that already knows it sees "nothing here"
# instead of an error it will retry (#187). main.py includes this router before the SPA
# fallback, which would otherwise answer both with the shell.
public_router = APIRouter(include_in_schema=False)

# The disallowed routes are owner routes that would only index as empty shells.
ROBOTS = (
    "User-agent: *\nDisallow: /api/\nDisallow: /login\nDisallow: /setup\n"
    "Disallow: /config\nDisallow: /images/\n"
)


@public_router.get("/sitemap.xml")
async def sitemap(request: Request, settings: SettingsDep, db: DbDep) -> Response:
    base = xml_escape(base_url(request))
    urls: list[str] = []
    if settings.public_gallery_enabled:
        urls.append(f"  <url><loc>{base}/gallery</loc></url>")
        for rec in db.published_images():
            if not export_exists(settings, rec):
                continue
            assert rec.exported_at  # export_exists checked it
            urls.append(
                f"  <url><loc>{base}/gallery/{rec.id}</loc>"
                f"<lastmod>{xml_escape(rec.exported_at)}</lastmod></url>"
            )
    body = (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
        + "".join(f"{url}\n" for url in urls)
        + "</urlset>\n"
    )
    return Response(body, media_type="application/xml", headers={"Cache-Control": CACHE})


@public_router.get("/robots.txt")
async def robots(request: Request) -> PlainTextResponse:
    return PlainTextResponse(
        f"{ROBOTS}Sitemap: {base_url(request)}/sitemap.xml\n", headers={"Cache-Control": CACHE}
    )
