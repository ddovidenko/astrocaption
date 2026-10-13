"""The startup backfill: images solved before the local catalogue shipped gain its objects
once, additively (SPEC § 5.2 "Local catalogue", #17)."""

from __future__ import annotations

import asyncio
import logging

import pytest

from app import catalog_backfill, worker
from app.catalog import objects_catalog
from app.catalog_backfill import run
from app.config import Settings
from app.db import Database
from app.models import SolveObject
from tests.conftest import FakeSolver, make_worker, seed_image


def solved_without_catalogue(settings: Settings, db: Database, image_id: str = "img-1") -> None:
    """A solve as this build does it, then rewound: catalogue objects removed, stamp cleared,
    one label edited. What an image solved before #17 looks like."""
    rec = seed_image(settings, db, image_id)
    asyncio.run(make_worker(settings, db, FakeSolver()).process(rec.id))
    nova_only = [o for o in db.get_objects(rec.id) if o.type in ("ngc", "ic", "bright")]
    ann = db.get_annotations(rec.id)
    assert ann is not None
    kept = [lab for lab in ann.labels if lab.object_id <= 20]
    edited = [
        lab.model_copy(update={"x": 42.0, "y": 43.0, "text_override": "edited", "enabled": True})
        if lab.object_id == 1
        else lab
        for lab in kept
    ]
    db.replace_objects(rec.id, nova_only)
    db.save_annotations(ann.model_copy(update={"labels": edited, "version": 3}))
    db.update_image(rec.id, {"objects_catalog": None})


def test_backfill_adds_objects_and_keeps_every_existing_label(
    settings: Settings, caplog: pytest.LogCaptureFixture
) -> None:
    db = Database(settings.db_path)
    solved_without_catalogue(settings, db)
    with caplog.at_level(logging.INFO, logger="app.catalog_backfill"):
        report = run(db, settings)
    assert (report.visited, report.changed) == (1, 1) and report.added > 0
    objects = db.get_objects("img-1")
    assert [o.id for o in objects[:20]] == list(range(1, 21))
    assert {n for o in objects for n in o.catalog_names} >= {"Sh2-279"}
    ann = db.get_annotations("img-1")
    assert ann is not None and ann.version == 4  # the document moved: the export reads as stale
    by_obj = {lab.object_id: lab for lab in ann.labels}
    edited = by_obj[1]
    assert (edited.x, edited.y, edited.text_override, edited.enabled) == (
        42.0,
        43.0,
        "edited",
        True,
    )
    assert len(ann.labels) == len(objects)
    got = db.get_image("img-1")
    assert got is not None and got.objects_catalog == objects_catalog().version
    assert "catalogue backfill: 1 image visited, 1 changed, " in caplog.text


def test_backfill_is_idempotent_and_skips_what_is_not_due(settings: Settings) -> None:
    db = Database(settings.db_path)
    solved_without_catalogue(settings, db, "a")
    unsolved = seed_image(settings, db, "b")
    run(db, settings)
    objects_after_first = db.get_objects("a")
    first = db.get_annotations("a")
    assert first is not None
    report = run(db, settings)
    assert (report.visited, report.changed, report.added) == (0, 0, 0)
    assert db.get_objects("a") == objects_after_first
    second = db.get_annotations("a")
    assert second is not None and second.version == first.version
    still_unsolved = db.get_image(unsolved.id)
    assert still_unsolved is not None and still_unsolved.objects_catalog is None


def test_backfill_stamps_an_image_that_gains_nothing_without_touching_its_document(
    settings: Settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A field with nothing in the catalogue: the stamp is written, the version does not move."""
    db = Database(settings.db_path)
    solved_without_catalogue(settings, db)
    monkeypatch.setattr(
        catalog_backfill, "lookup_catalog", lambda image_id, wcs_text, scale, existing: existing
    )
    report = run(db, settings)
    assert (report.visited, report.changed, report.added) == (1, 0, 0)
    ann = db.get_annotations("img-1")
    assert ann is not None and ann.version == 3
    got = db.get_image("img-1")
    assert got is not None and got.objects_catalog == objects_catalog().version


def test_backfill_skips_a_solved_image_without_a_layout(
    settings: Settings, caplog: pytest.LogCaptureFixture
) -> None:
    db = Database(settings.db_path)
    solved_without_catalogue(settings, db)
    with db.connect() as conn:
        conn.execute("DELETE FROM annotations WHERE image_id = 'img-1'")
    with caplog.at_level(logging.WARNING, logger="app.catalog_backfill"):
        report = run(db, settings)
    assert (report.visited, report.changed) == (1, 0)
    got = db.get_image("img-1")
    assert got is not None and got.objects_catalog is None
    assert "img-1" in caplog.text and "no layout" in caplog.text


def test_backfill_skips_an_image_whose_lookup_fails_and_finishes_the_rest(
    settings: Settings, caplog: pytest.LogCaptureFixture, monkeypatch: pytest.MonkeyPatch
) -> None:
    """One odd stored header must never stop the server from starting: the image is logged,
    left unstamped and the loop goes on."""
    db = Database(settings.db_path)
    solved_without_catalogue(settings, db, "bad")
    solved_without_catalogue(settings, db, "good")
    real = worker.lookup_catalog

    def flaky(
        image_id: str, wcs_text: str, scale: float, existing: list[SolveObject]
    ) -> list[SolveObject]:
        if image_id == "bad":
            raise ZeroDivisionError("float division by zero")
        return real(image_id, wcs_text, scale, existing)

    monkeypatch.setattr(catalog_backfill, "lookup_catalog", flaky)
    with caplog.at_level(logging.ERROR, logger="app.catalog_backfill"):
        report = run(db, settings)
    assert (report.visited, report.changed) == (2, 1)
    bad = db.get_image("bad")
    assert bad is not None and bad.objects_catalog is None
    bad_ann = db.get_annotations("bad")
    assert bad_ann is not None and bad_ann.version == 3
    good = db.get_image("good")
    assert good is not None and good.objects_catalog == objects_catalog().version
    assert "catalogue backfill failed" in caplog.text and "bad" in caplog.text


def test_backfill_leaves_a_document_alone_when_only_names_would_change(
    settings: Settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A name appended to an existing object changes the rendered text without moving the
    document hash, so the export would read as current while it is not: the backfill applies
    names only alongside added rows, and otherwise just stamps."""
    db = Database(settings.db_path)
    solved_without_catalogue(settings, db)

    def names_only(
        image_id: str, wcs_text: str, scale: float, existing: list[SolveObject]
    ) -> list[SolveObject]:
        first, *rest = existing
        return [
            first.model_copy(update={"catalog_names": [*first.catalog_names, "Sh2-999"]}),
            *rest,
        ]

    monkeypatch.setattr(catalog_backfill, "lookup_catalog", names_only)
    report = run(db, settings)
    assert (report.visited, report.changed, report.added) == (1, 0, 0)
    assert "Sh2-999" not in {n for o in db.get_objects("img-1") for n in o.catalog_names}
    ann = db.get_annotations("img-1")
    assert ann is not None and ann.version == 3
    got = db.get_image("img-1")
    assert got is not None and got.objects_catalog == objects_catalog().version
