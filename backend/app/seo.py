"""Head tags for the public routes (#187): what a crawler or a link-preview bot reads before
the SPA runs. Pure builders, plus the two lookups ``spa.py``'s routes call.

This is the one public module that reads annotations and objects, and only for a published
image: the description names the enabled labels as the export prints them, which the public
export already shows.
"""

from __future__ import annotations

import html
import logging
from dataclasses import dataclass
from datetime import UTC, datetime

from pydantic import ValidationError

from .api.gallery import gallery_item, visible_image
from .config import Settings
from .db import Database
from .models import Annotations, ImageRecord, SolveObject
from .render import ALIAS_SEP, label_text
from .storage import PREVIEW_MAX_PX, export_exists, fit_within

log = logging.getLogger(__name__)

MAX_NAMES = 8
#: How many of the newest gallery rows the gallery page tries for its card image: the first
#: with its files on disk wins, so a render dir emptied by hand does not cost the card.
NEWEST_CANDIDATES = 3
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
    shown = ALIAS_SEP.join(names[:MAX_NAMES])
    if len(names) > MAX_NAMES:
        shown += f" and {len(names) - MAX_NAMES} more"
    return f"{shown}. {tail}"


def _meta(attr: str, name: str, value: str) -> str:
    return f'<meta {attr}="{name}" content="{html.escape(value, quote=True)}" />\n'


def _image_tags(base: str, rec: ImageRecord) -> str:
    w, h = fit_within(rec.width, rec.height, PREVIEW_MAX_PX)
    return (
        _meta("property", "og:image", base + gallery_item(rec).annotated_preview_url)
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


def gallery_head_for(settings: Settings, db: Database, base: str) -> Head | None:
    """The gallery page's head, or None while the gallery is off."""
    if not settings.public_gallery_enabled:
        return None
    newest = None
    for rec in db.published_images(limit=NEWEST_CANDIDATES):
        if export_exists(settings, rec):
            newest = rec
            break
        log.warning("head tags: skipping published image %s: its export files are missing", rec.id)
    return gallery_head(base, settings.site_title, db.count_published_images(), newest)


def image_head_for(settings: Settings, db: Database, base: str, image_id: str) -> Head | None:
    """An image page's head, or None when a visitor may not see the image (the gallery is
    off, or the id is unknown, unpublished or without its files: one answer for all)."""
    if not settings.public_gallery_enabled:
        return None
    rec = visible_image(settings, db, image_id)
    if rec is None:
        return None
    try:
        names = label_names(db.get_annotations(rec.id), db.get_objects(rec.id))
    except (ValueError, TypeError, ValidationError):  # a corrupt objects row (#187)
        log.error(
            "head tags: image %s has an unreadable objects row; its description names no "
            "labels until the row is repaired",
            rec.id,
        )
        names = []
    return image_head(base, settings.site_title, rec, names)
