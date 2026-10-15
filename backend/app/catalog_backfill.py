"""One-time lookup of the local catalogue for images solved before it shipped (SPEC § 5.2).

Runs in the lifespan before the server accepts requests, so no editor is mid-edit while its
document is rewritten. Per image: project the catalogue through the stored WCS, merge the hits
into the stored objects (ids continue after the highest), and when anything was added run the
re-solve rematch, which carries every existing label untouched and places only the new ones. A
lookup that only appends names to existing objects stores the objects and leaves the document
as it is: the content hash covers the names (#217), so an export made before reads as out of
date. Never contacts nova.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass

from .catalog import objects_catalog
from .config import Settings
from .db import Database
from .layout import rematch_annotations
from .models import ImageRecord
from .worker import lookup_catalog

log = logging.getLogger(__name__)


@dataclass
class BackfillReport:
    visited: int = 0
    changed: int = 0
    added: int = 0


def _backfill_one(db: Database, settings: Settings, rec: ImageRecord, version: str) -> int | None:
    """One image: the number of objects added (0 when only names were), None when it was left
    as it was."""
    assert rec.wcs_text  # the query guarantees it
    previous = db.get_annotations(rec.id)
    if previous is None:
        log.warning("image %s: catalogue backfill skipped: no layout stored", rec.id)
        return None
    old_objects = db.get_objects(rec.id)
    merged = lookup_catalog(rec.id, rec.wcs_text, rec.solve_scale, old_objects)
    if merged is None:
        return None  # logged by the lookup; unstamped, so the next start tries again
    if merged == old_objects:
        db.update_image(rec.id, {"objects_catalog": version})
        return None
    added = len(merged) - len(old_objects)
    if added == 0:
        # Names appended to existing objects: the labels stay where they are, the objects move
        # and the content hash (which covers their names, #217) moves with them, so an export
        # made before now reads as out of date.
        if not db.store_solve_result(rec.id, merged, previous, {"objects_catalog": version}):
            return None  # deleted meanwhile
        return 0
    ann = rematch_annotations(
        previous,
        old_objects,
        merged,
        rec.width,
        rec.height,
        settings.fonts_dir,
        min_radius_fraction=settings.min_label_radius_fraction,
    )
    if not db.store_solve_result(rec.id, merged, ann, {"objects_catalog": version}):
        return None  # deleted meanwhile
    return added


def run(db: Database, settings: Settings) -> BackfillReport:
    version = objects_catalog().version
    report = BackfillReport()
    for rec in db.images_for_catalog_backfill(version):
        report.visited += 1
        try:
            added = _backfill_one(db, settings, rec, version)
        except Exception:
            # One odd stored header must never keep the server from starting. The image keeps
            # its objects and stays unstamped, so the next start logs it again.
            log.exception("image %s: catalogue backfill failed; image left as it was", rec.id)
            continue
        if added is not None:
            report.changed += 1
            report.added += added
    log.info(
        "catalogue backfill: %d image%s visited, %d changed, %d objects added (catalogue %s)",
        report.visited,
        "" if report.visited == 1 else "s",
        report.changed,
        report.added,
        version,
    )
    return report
