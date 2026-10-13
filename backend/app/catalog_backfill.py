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
from .worker import lookup_catalog

log = logging.getLogger(__name__)


@dataclass
class BackfillReport:
    visited: int = 0
    changed: int = 0
    added: int = 0


def run(db: Database, settings: Settings) -> BackfillReport:
    version = objects_catalog().version
    report = BackfillReport()
    for rec in db.images_for_catalog_backfill(version):
        report.visited += 1
        assert rec.wcs_text  # the query guarantees it
        previous = db.get_annotations(rec.id)
        if previous is None:
            log.warning("image %s: catalogue backfill skipped: no layout stored", rec.id)
            continue
        old_objects = db.get_objects(rec.id)
        merged = lookup_catalog(rec.id, rec.wcs_text, rec.solve_scale, old_objects)
        added = len(merged) - len(old_objects)
        same_names = all(
            a.catalog_names == b.catalog_names for a, b in zip(old_objects, merged, strict=False)
        )
        if added == 0 and same_names:
            db.update_image(rec.id, {"objects_catalog": version})
            continue
        ann = rematch_annotations(
            previous, old_objects, merged, rec.width, rec.height, settings.fonts_dir
        )
        if not db.store_solve_result(rec.id, merged, ann, {"objects_catalog": version}):
            continue  # deleted meanwhile
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
