"""One-time lookup of the local catalogue for images solved before it shipped (SPEC § 5.2).

Runs in the lifespan before the server accepts requests, so no editor is mid-edit while its
document is rewritten. Per image: project the catalogue through the stored WCS, merge the hits
into the stored objects (ids continue after the highest), and when anything was added run the
re-solve rematch, which carries every existing label untouched and places only the new ones.
Never contacts nova.
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


def _backfill_one(db: Database, settings: Settings, rec: ImageRecord, version: str) -> int:
    """One image: the number of objects added, 0 when its document was left alone."""
    assert rec.wcs_text  # the query guarantees it
    previous = db.get_annotations(rec.id)
    if previous is None:
        log.warning("image %s: catalogue backfill skipped: no layout stored", rec.id)
        return 0
    old_objects = db.get_objects(rec.id)
    merged = lookup_catalog(rec.id, rec.wcs_text, rec.solve_scale, old_objects)
    added = len(merged) - len(old_objects)
    if added == 0:
        # Names a hit would only have appended to existing objects are not applied here: they
        # change a label's text without moving the document hash, so the export would read as
        # current while it no longer is. They arrive with any added row, whose new label moves it.
        db.update_image(rec.id, {"objects_catalog": version})
        return 0
    ann = rematch_annotations(
        previous, old_objects, merged, rec.width, rec.height, settings.fonts_dir
    )
    if not db.store_solve_result(rec.id, merged, ann, {"objects_catalog": version}):
        return 0  # deleted meanwhile
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
        if added:
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
