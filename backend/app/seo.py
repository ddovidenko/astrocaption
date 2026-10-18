"""Head tags for the public routes (#187): what a crawler or a link-preview bot reads before
the SPA runs. Pure builders here; ``head_for`` picks the route.

This is the one public module that reads annotations and objects, and only for a published
image: the description names the enabled labels as the export prints them, which the public
export already shows.
"""

from __future__ import annotations

import html
import logging
import re
from dataclasses import dataclass
from datetime import UTC, datetime
from urllib.parse import quote

from fastapi import Request

from .config import Settings
from .db import Database
from .models import Annotations, ImageRecord, SolveObject
from .render import label_text
from .storage import PREVIEW_MAX_PX, export_exists, fit_within

log = logging.getLogger(__name__)

MAX_NAMES = 8
MONTHS = ("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec")


@dataclass(frozen=True)
class Head:
    title: str  # unescaped; the shell template escapes it
    tags: str  # head lines, each ending in a newline, every value escaped


def day_label(iso: str) -> str:
    """The upload day as the cards print it (frontend/src/day.ts): UTC, "22 Sep 2026"."""
    d = datetime.fromisoformat(iso)
    if d.tzinfo is not None:
        d = d.astimezone(UTC)
    return f"{d.day} {MONTHS[d.month - 1]} {d.year}"


def label_names(ann: Annotations | None, objects: list[SolveObject]) -> list[str]:
    """The enabled labels' text in label order, as the export prints it; a label whose
    object is gone is skipped."""
    if ann is None:
        return []
    by_id = {o.id: o for o in objects}
    names: list[str] = []
    for label in ann.labels:
        obj = by_id.get(label.object_id)
        if label.enabled and obj is not None:
            names.append(label_text(obj, label, ann.style).primary)
    return names


def image_description(names: list[str], created_at: str) -> str:
    tail = f"Annotated astrophoto, uploaded {day_label(created_at)}."
    if not names:
        return tail
    shown = " · ".join(names[:MAX_NAMES])
    if len(names) > MAX_NAMES:
        shown += f" and {len(names) - MAX_NAMES} more"
    return f"{shown}. {tail}"


def _meta(attr: str, name: str, value: str) -> str:
    return f'<meta {attr}="{name}" content="{html.escape(value, quote=True)}" />\n'


def _image_tags(base: str, rec: ImageRecord) -> str:
    assert rec.exported_at  # the callers check export_exists first
    w, h = fit_within(rec.width, rec.height, PREVIEW_MAX_PX)
    url = f"{base}/api/gallery/{rec.id}/files/annotated-preview?v={quote(rec.exported_at)}"
    return (
        _meta("property", "og:image", url)
        + _meta("property", "og:image:width", str(w))
        + _meta("property", "og:image:height", str(h))
        + _meta("name", "twitter:card", "summary_large_image")
    )


def _common(url: str, kind: str, title: str, description: str, site_title: str) -> str:
    return (
        _meta("name", "description", description)
        + f'<link rel="canonical" href="{html.escape(url, quote=True)}" />\n'
        + _meta("property", "og:type", kind)
        + _meta("property", "og:title", title)
        + _meta("property", "og:description", description)
        + _meta("property", "og:url", url)
        + _meta("property", "og:site_name", site_title)
    )


def image_head(base: str, site_title: str, rec: ImageRecord, names: list[str]) -> Head:
    url = f"{base}/gallery/{rec.id}"
    description = image_description(names, rec.created_at)
    tags = _common(url, "article", rec.title, description, site_title) + _image_tags(base, rec)
    return Head(title=f"{rec.title} · {site_title}", tags=tags)


def gallery_head(base: str, site_title: str, count: int, newest: ImageRecord | None) -> Head:
    if count == 0:
        description = "Annotated astrophotos"
    elif count == 1:
        description = "1 annotated astrophoto"
    else:
        description = f"{count} annotated astrophotos"
    tags = _common(f"{base}/gallery", "website", site_title, description, site_title)
    if newest is not None:
        tags += _image_tags(base, newest)
    return Head(title=site_title, tags=tags)


_IMAGE_PATH = re.compile(r"^gallery/([^/]+)$")


def base_url(request: Request) -> str:
    """Scheme and host as the request names them (the proxy middleware has already applied
    X-Forwarded-Proto under TRUST_PROXY), without the trailing slash."""
    return str(request.base_url).rstrip("/")


def head_for(request: Request, path: str, settings: Settings, db: Database) -> tuple[int, Head]:
    """Status and head for a client route. Only the public gallery routes get tags; every
    other route is the shell with the site title. A miss on a gallery route is 404 with the
    plain head, the same body whether the id is unknown, unpublished or lacks files."""
    site = settings.site_title
    plain = Head(site, "")
    is_gallery = path in ("", "gallery")
    image_match = _IMAGE_PATH.match(path)
    if not is_gallery and image_match is None:
        return 200, plain
    if not settings.public_gallery_enabled:
        # The root is also the sign-in landing and the owner's page: never a 404.
        return (200 if path == "" else 404), plain
    base = base_url(request)
    if is_gallery:
        rows = db.published_images()
        newest = next((r for r in rows if export_exists(settings, r)), None)
        return 200, gallery_head(base, site, len(rows), newest)
    assert image_match is not None  # the only other way in
    rec = db.get_image(image_match.group(1))
    if rec is None or not rec.published or not export_exists(settings, rec):
        return 404, plain
    try:
        names = label_names(db.get_annotations(rec.id), db.get_objects(rec.id))
    except Exception:  # a corrupt row must not take the page down; the export still shows
        log.warning("head tags: could not read the labels of image %s", rec.id, exc_info=True)
        names = []
    return 200, image_head(base, site, rec, names)
