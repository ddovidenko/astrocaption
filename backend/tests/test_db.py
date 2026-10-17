from __future__ import annotations

import hashlib
import json
import logging
from datetime import date
from pathlib import Path

import pytest

from app.config import Settings
from app.db import SCHEMA_VERSION, Database, ListFilter, UnknownCursor, fold, fold_names, hash_of
from app.models import (
    Annotations,
    ImageRecord,
    Label,
    SolveHints,
    SolveObject,
    SolveStatus,
    StyleConfig,
)
from tests.conftest import seed_image


def test_migration_from_v1_adds_hints_column(tmp_path: Path) -> None:
    db = Database(tmp_path / "x.sqlite")
    db.init()
    with db.connect() as conn:  # rewind to the version-1 shape
        conn.execute("ALTER TABLE images DROP COLUMN solve_hints_json")
        conn.execute("ALTER TABLE images DROP COLUMN solve_failure")
        conn.execute("ALTER TABLE images DROP COLUMN exported_hash")
        conn.execute("ALTER TABLE images DROP COLUMN objects_catalog")  # added by 6
        conn.execute("ALTER TABLE objects DROP COLUMN kind")  # added by 8
        conn.execute("PRAGMA user_version = 1")
    db.init()
    with db.connect() as conn:
        columns = {row["name"] for row in conn.execute("PRAGMA table_info(images)")}
        assert {"solve_hints_json", "solve_failure", "exported_hash"} <= columns
        assert conn.execute("PRAGMA user_version").fetchone()[0] == SCHEMA_VERSION
    db.init()  # idempotent


def test_migration_from_v2_adds_the_failure_kind_column(tmp_path: Path) -> None:
    """A database written by the previous build gains ``solve_failure`` and reads NULL there:
    rows that failed before this column existed are simply not resumable."""
    db = Database(tmp_path / "x.sqlite")
    db.init()
    with db.connect() as conn:  # rewind to the version-2 shape
        conn.execute("ALTER TABLE images DROP COLUMN solve_failure")
        conn.execute("ALTER TABLE images DROP COLUMN exported_hash")
        conn.execute("ALTER TABLE images DROP COLUMN objects_catalog")  # added by 6
        conn.execute("ALTER TABLE objects DROP COLUMN kind")  # added by 8
        conn.execute("PRAGMA user_version = 2")
    db.init()
    with db.connect() as conn:
        columns = {row["name"] for row in conn.execute("PRAGMA table_info(images)")}
        assert "solve_failure" in columns
        assert conn.execute("PRAGMA user_version").fetchone()[0] == SCHEMA_VERSION
    db.init()  # idempotent


def test_migration_from_v3_adds_the_exported_hash_column(tmp_path: Path) -> None:
    """An export made before this column existed reads NULL there: the pages then call it out
    of date until the next export records which document it rendered (#91)."""
    db = Database(tmp_path / "x.sqlite")
    db.init()
    with db.connect() as conn:  # rewind to the version-3 shape
        conn.execute("ALTER TABLE images DROP COLUMN exported_hash")
        conn.execute("ALTER TABLE images DROP COLUMN objects_catalog")  # added by 6
        conn.execute("ALTER TABLE objects DROP COLUMN kind")  # added by 8
        conn.execute("PRAGMA user_version = 3")
    db.init()
    with db.connect() as conn:
        columns = {row["name"] for row in conn.execute("PRAGMA table_info(images)")}
        assert "exported_hash" in columns
        assert "exported_version" not in columns
        assert conn.execute("PRAGMA user_version").fetchone()[0] == SCHEMA_VERSION
    db.init()  # idempotent


def test_migration_from_v4_swaps_the_exported_version_column_for_the_hash(tmp_path: Path) -> None:
    """Schema 4 (one build, never released) recorded the exported document's version; 5 records
    its content hash instead, so an undo back to the exported document reads as exported."""
    db = Database(tmp_path / "x.sqlite")
    db.init()
    with db.connect() as conn:  # rewind to the version-4 shape
        conn.execute("ALTER TABLE images DROP COLUMN exported_hash")
        conn.execute("ALTER TABLE images ADD COLUMN exported_version INTEGER")
        conn.execute("ALTER TABLE images DROP COLUMN objects_catalog")  # added by 6
        conn.execute("ALTER TABLE objects DROP COLUMN kind")  # added by 8
        conn.execute("PRAGMA user_version = 4")
    db.init()
    with db.connect() as conn:
        columns = {row["name"] for row in conn.execute("PRAGMA table_info(images)")}
        assert "exported_hash" in columns
        assert "exported_version" not in columns
        assert conn.execute("PRAGMA user_version").fetchone()[0] == SCHEMA_VERSION
    db.init()  # idempotent


def _solved_with_names(
    db: Database, image_id: str, names: list[str]
) -> tuple[list[SolveObject], Annotations]:
    objects = [SolveObject(id=1, catalog_names=names, type="galaxy", x=10.0, y=20.0, radius=5)]
    ann = Annotations(
        image_id=image_id, style=StyleConfig(), labels=[Label(object_id=1)], version=1
    )
    assert db.store_solve_result(image_id, objects, ann, {"solve_status": SolveStatus.SOLVED})
    return objects, ann


def test_content_hash_covers_the_objects_names(settings: Settings) -> None:
    """A name appended to an object changes the rendered text, so it must move the hash the
    export is compared with (#217): every read path and the PUT response agree on it."""
    db = Database(settings.db_path)
    rec = seed_image(settings, db)
    objects, ann = _solved_with_names(db, rec.id, ["NGC 1924"])
    before = db.annotations_hash(rec.id)
    stored = db.get_annotations(rec.id)
    assert stored is not None and before is not None
    assert stored.content_hash == before == db.annotations_hashes()[rec.id] == hash_of(ann, objects)
    renamed = [objects[0].model_copy(update={"catalog_names": ["NGC 1924", "PGC 17319"]})]
    db.replace_objects(rec.id, renamed)
    after = db.annotations_hash(rec.id)
    assert after is not None and after != before
    stored = db.get_annotations(rec.id)
    assert stored is not None and after == stored.content_hash == hash_of(ann, renamed)


def test_migration_from_v6_keeps_a_current_export_current(settings: Settings) -> None:
    """Schema 7 widens the content hash to the objects' names (#217). An export that was current
    under the old formula (style and labels only) is re-stamped with the new hash, so no owner
    sees every export turn 'out of date' on upgrade; one that was already stale stays stale."""
    db = Database(settings.db_path)
    current, stale = seed_image(settings, db, "cur"), seed_image(settings, db, "old")
    for rec in (current, stale):
        _solved_with_names(db, rec.id, ["NGC 1924"])
    with db.connect() as conn:
        row = conn.execute(
            "SELECT style_json, labels_json FROM annotations WHERE image_id = 'cur'"
        ).fetchone()
        old_formula = hashlib.sha256(
            f"{row['style_json']}\n{row['labels_json']}".encode()
        ).hexdigest()[:32]
        for image_id, value in (("cur", old_formula), ("old", "0123456789abcdef0123456789abcdef")):
            conn.execute(
                "UPDATE images SET exported_at = '2026-10-01T00:00:00+00:00', exported_hash = ?,"
                " objects_catalog = '2026-10-13' WHERE id = ?",
                (value, image_id),
            )
        conn.execute("ALTER TABLE objects DROP COLUMN kind")  # added by 8
        conn.execute("PRAGMA user_version = 6")
    db.init()
    cur, old = db.get_image("cur"), db.get_image("old")
    assert cur is not None and old is not None
    assert cur.exported_hash == db.annotations_hash("cur") != old_formula
    assert old.exported_hash == "0123456789abcdef0123456789abcdef"
    # The catalogue stamps are cleared too, so the startup backfill revisits every image once
    # and applies the names-only merges the previous build held back.
    assert cur.objects_catalog is None and old.objects_catalog is None
    with db.connect() as conn:
        assert conn.execute("PRAGMA user_version").fetchone()[0] == SCHEMA_VERSION
    db.init()  # idempotent


def test_update_image_of_a_missing_row_logs_and_changes_nothing(
    settings: Settings, caplog: pytest.LogCaptureFixture
) -> None:
    """Several worker paths update a row that a delete may have removed meanwhile; that is
    allowed, but it is said in the log rather than passing in silence (#80)."""
    db = Database(settings.db_path)
    seed_image(settings, db)
    with caplog.at_level(logging.DEBUG, logger="app.db"):
        db.update_image("gone", {"solve_failure": "timeout"})
    assert "update_image: no row with id gone" in caplog.text
    assert db.get_image("gone") is None


def test_solve_failure_round_trip(settings: Settings) -> None:
    db = Database(settings.db_path)
    rec = seed_image(settings, db)
    assert rec.solve_failure is None
    db.update_image(rec.id, {"solve_failure": "timeout"})
    got = db.get_image(rec.id)
    assert got is not None and got.solve_failure == "timeout"
    db.update_image(rec.id, {"solve_failure": None})
    got = db.get_image(rec.id)
    assert got is not None and got.solve_failure is None


def test_solve_hints_round_trip(settings: Settings) -> None:
    db = Database(settings.db_path)
    rec = seed_image(settings, db)
    assert rec.solve_hints is None
    db.update_image(rec.id, {"solve_hints": SolveHints(focal_length_mm=400, pixel_size_um=3.76)})
    got = db.get_image(rec.id)
    assert got is not None and got.solve_hints is not None
    assert (got.solve_hints.focal_length_mm, got.solve_hints.pixel_size_um) == (400, 3.76)
    db.update_image(rec.id, {"solve_hints": None})
    got = db.get_image(rec.id)
    assert got is not None and got.solve_hints is None


def test_newer_schema_refuses_to_start(tmp_path: Path) -> None:
    db = Database(tmp_path / "x.sqlite")
    db.init()
    with db.connect() as conn:
        conn.execute("PRAGMA user_version = 99")
    with pytest.raises(RuntimeError, match="newer than this build"):
        db.init()


def test_failed_migration_rolls_back(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    from app import db as dbmod

    db = Database(tmp_path / "x.sqlite")
    db.init()
    monkeypatch.setattr(dbmod, "SCHEMA_VERSION", SCHEMA_VERSION + 1)
    monkeypatch.setitem(
        dbmod.MIGRATIONS,
        SCHEMA_VERSION + 1,
        ("ALTER TABLE images ADD COLUMN scratch TEXT", "THIS IS NOT SQL"),
    )
    with pytest.raises(Exception, match="syntax error"):
        db.init()
    with db.connect() as conn:
        assert conn.execute("PRAGMA user_version").fetchone()[0] == SCHEMA_VERSION
        columns = {row["name"] for row in conn.execute("PRAGMA table_info(images)")}
        assert "scratch" not in columns


def test_corrupt_json_cell_does_not_break_listing(settings: Settings) -> None:
    db = Database(settings.db_path)
    rec = seed_image(settings, db)
    with db.connect() as conn:
        conn.execute(
            "UPDATE images SET solve_hints_json = ?, calibration_json = ? WHERE id = ?",
            ("{not json", "[1,2]", rec.id),
        )
    listed = db.list_images().items
    assert [i.id for i in listed] == [rec.id]
    assert listed[0].solve_hints is None and listed[0].calibration is None


def test_record_fields_and_table_columns_agree(tmp_path: Path) -> None:
    from app.db import IMAGE_COLUMNS

    db = Database(tmp_path / "x.sqlite")
    db.init()
    with db.connect() as conn:
        columns = {row["name"] for row in conn.execute("PRAGMA table_info(images)")}
    assert columns == set(IMAGE_COLUMNS)


def test_update_annotations_if_version_is_a_compare_and_swap(settings: Settings) -> None:
    db = Database(settings.db_path)
    rec = seed_image(settings, db)
    first = Annotations(image_id=rec.id, style=StyleConfig(), labels=[], version=1)
    db.save_annotations(first)
    newer = first.model_copy(update={"version": 2, "labels": [Label(object_id=1)]})
    assert db.update_annotations_if_version(newer, expected_version=1)
    stored = db.get_annotations(rec.id)
    assert stored is not None and stored.version == 2 and len(stored.labels) == 1
    stale = first.model_copy(update={"version": 2, "labels": []})
    assert not db.update_annotations_if_version(stale, expected_version=1)  # someone else won
    assert db.get_annotations(rec.id) == stored
    missing = newer.model_copy(update={"image_id": "missing"})
    assert not db.update_annotations_if_version(missing, expected_version=1)  # no such row


def test_get_annotations_drops_a_legacy_colour_instead_of_500ing(
    settings: Settings, caplog: pytest.LogCaptureFixture
) -> None:
    """A row written before hex validation existed (an early config.json could carry
    ``"text_color": "white"``) must still load, with the bad field falling back to its
    default rather than taking down every GET/export/re-solve for that image."""
    db = Database(settings.db_path)
    rec = seed_image(settings, db)
    style = {"text_color": "white", "marker_color": "#112233"}
    with db.connect() as conn:
        conn.execute(
            "INSERT INTO annotations (image_id, style_json, labels_json, version, updated_at)"
            " VALUES (?, ?, ?, ?, ?)",
            (rec.id, json.dumps(style), "[]", 1, "2026-01-01T00:00:00+00:00"),
        )
    with caplog.at_level("WARNING", logger="app.db"):
        ann = db.get_annotations(rec.id)
    assert ann is not None
    assert ann.style.text_color == "#FFFFFF"  # the model default, not the bad value
    assert ann.style.marker_color == "#112233"  # the other field survived
    assert "text_color" in caplog.text
    assert "white" not in caplog.text


def _seed_annotations_row(db: Database, image_id: str, style_json: str, labels_json: str) -> None:
    """A row as an older build (or a hand edit) might have left it, bypassing the models."""
    with db.connect() as conn:
        conn.execute(
            "INSERT INTO annotations (image_id, style_json, labels_json, version, updated_at)"
            " VALUES (?, ?, ?, ?, ?)",
            (image_id, style_json, labels_json, 1, "2026-01-01T00:00:00+00:00"),
        )


def test_get_annotations_repairs_labels_field_by_field(
    settings: Settings, caplog: pytest.LogCaptureFixture
) -> None:
    """#69: the labels column is read as tolerantly as the style. A field that no longer
    validates (a renamed field, a legacy colour, an over-long override) falls back to its
    default; no label loses its row. A label whose position cannot be read is disabled rather
    than shown at the top-left corner. Field names are logged, values never."""
    db = Database(settings.db_path)
    rec = seed_image(settings, db)
    labels = [
        {"object_id": 1, "x": 10, "y": 20, "colour": "#123456"},  # a since-renamed field
        {"object_id": 2, "x": 10, "y": 20, "color": "white"},  # a legacy colour
        {"object_id": 3, "x": 10, "y": 20, "text_override": "z" * 500},  # over the cap
        {"object_id": 4, "x": "NaN", "y": 20, "enabled": True, "pinned": True},  # bad position
        {"object_id": 5, "x": 1, "y": 2, "pinned": True},  # fine as it is
        {"object_id": 6, "left": 10, "top": 20},  # a position under since-renamed names
    ]
    _seed_annotations_row(db, rec.id, "{}", json.dumps(labels))
    with caplog.at_level("WARNING", logger="app.db"):
        ann = db.get_annotations(rec.id)
    assert ann is not None
    by_id = {lab.object_id: lab for lab in ann.labels}
    assert set(by_id) == {1, 2, 3, 4, 5, 6}
    assert by_id[1].x == 10 and by_id[1].color is None
    assert by_id[2].color is None and by_id[2].x == 10
    assert by_id[3].text_override is None
    assert by_id[4].enabled is False and by_id[4].x == 0.0 and by_id[4].y == 20
    assert by_id[4].pinned is False  # else Reset positions would keep it in the corner
    assert by_id[5] == Label(object_id=5, x=1, y=2, pinned=True)
    assert by_id[6].enabled is False and by_id[6].pinned is False  # absent, not just bad
    assert "colour" in caplog.text and "text_override" in caplog.text
    assert "white" not in caplog.text and "zzz" not in caplog.text


def test_get_annotations_drops_only_labels_that_name_no_object(
    settings: Settings, caplog: pytest.LogCaptureFixture
) -> None:
    """A label without a readable ``object_id`` has nothing to attach to; it is the one case
    that is dropped, with a warning, and the rest of the row still loads."""
    db = Database(settings.db_path)
    rec = seed_image(settings, db)
    labels = [{"x": 1, "y": 2}, {"object_id": "seven"}, "junk", None, {"object_id": 9}]
    _seed_annotations_row(db, rec.id, "{}", json.dumps(labels))
    with caplog.at_level("WARNING", logger="app.db"):
        ann = db.get_annotations(rec.id)
    assert ann is not None
    assert [lab.object_id for lab in ann.labels] == [9]
    assert "unreadable label entries" in caplog.text and "seven" not in caplog.text


@pytest.mark.parametrize("style_json", ["null", "[1, 2]", '"white"'])
def test_get_annotations_treats_a_non_object_style_as_all_defaults(
    settings: Settings, caplog: pytest.LogCaptureFixture, style_json: str
) -> None:
    db = Database(settings.db_path)
    rec = seed_image(settings, db)
    _seed_annotations_row(db, rec.id, style_json, "[]")
    with caplog.at_level("WARNING", logger="app.db"):
        ann = db.get_annotations(rec.id)
    assert ann is not None and ann.style == StyleConfig()
    assert "style" in caplog.text and "white" not in caplog.text


@pytest.mark.parametrize("labels_json", ["null", "{}", '"x"'])
def test_get_annotations_treats_a_non_list_labels_column_as_empty(
    settings: Settings, caplog: pytest.LogCaptureFixture, labels_json: str
) -> None:
    db = Database(settings.db_path)
    rec = seed_image(settings, db)
    _seed_annotations_row(db, rec.id, "{}", labels_json)
    with caplog.at_level("WARNING", logger="app.db"):
        ann = db.get_annotations(rec.id)
    assert ann is not None and ann.labels == []
    assert "labels" in caplog.text


@pytest.mark.parametrize(
    ("style_json", "labels_json"),
    [("{not json", "[]"), ("{}", "[1,"), ("{}", "[" * 100_000 + "]" * 100_000)],
    ids=["style", "labels", "labels-nested-past-the-recursion-limit"],
)
def test_get_annotations_treats_a_malformed_column_as_defaults(
    settings: Settings, caplog: pytest.LogCaptureFixture, style_json: str, labels_json: str
) -> None:
    """A hand-edited row whose column is not JSON at all loads like a non-object/non-list one."""
    db = Database(settings.db_path)
    rec = seed_image(settings, db)
    _seed_annotations_row(db, rec.id, style_json, labels_json)
    with caplog.at_level("WARNING", logger="app.db"):
        ann = db.get_annotations(rec.id)
    assert ann is not None and ann.style == StyleConfig() and ann.labels == []
    assert "not json" not in caplog.text


def test_list_published_images_is_published_solved_newest_first(tmp_path: Path) -> None:
    db = Database(tmp_path / "t.sqlite")
    db.init()
    rows = [
        ("old-pub", "2026-09-01T00:00:00Z", True, SolveStatus.SOLVED),
        ("new-pub", "2026-09-02T00:00:00Z", True, SolveStatus.SOLVED),
        ("unpub", "2026-09-03T00:00:00Z", False, SolveStatus.SOLVED),
        ("pub-solving", "2026-09-04T00:00:00Z", True, SolveStatus.SOLVING),
        ("pub-failed", "2026-09-05T00:00:00Z", True, SolveStatus.FAILED),
    ]
    for image_id, created, published, status in rows:
        db.insert_image(
            ImageRecord(
                id=image_id,
                created_at=created,
                updated_at=created,
                title=image_id,
                original_name="x.jpg",
                original_path=f"uploads/{image_id}/original.jpg",
                preview_path=f"uploads/{image_id}/preview.jpg",
                thumb_path=f"uploads/{image_id}/thumb.jpg",
                width=100,
                height=80,
                published=published,
                solve_status=status,
            )
        )
    assert [r.id for r in db.list_published_images().items] == ["new-pub", "old-pub"]


def _plain_image(image_id: str, created: str, published: bool = False) -> ImageRecord:
    return ImageRecord(
        id=image_id,
        created_at=created,
        updated_at=created,
        title=image_id,
        original_name="x.jpg",
        original_path=f"uploads/{image_id}/original.jpg",
        preview_path=f"uploads/{image_id}/preview.jpg",
        thumb_path=f"uploads/{image_id}/thumb.jpg",
        width=100,
        height=80,
        published=published,
        solve_status=SolveStatus.SOLVED,
    )


def test_list_images_pages_newest_first_by_insertion(tmp_path: Path) -> None:
    db = Database(tmp_path / "t.sqlite")
    db.init()
    # Insertion order is the list's order; created_at is display only (#214).
    for image_id, created in [
        ("a", "2026-09-01T00:00:00Z"),
        ("b", "2026-09-02T00:00:00Z"),
        ("c", "2026-09-02T00:00:00Z"),
        ("d", "2026-09-02T00:00:00Z"),
        ("e", "2026-09-03T00:00:00Z"),
    ]:
        db.insert_image(_plain_image(image_id, created))
    page = db.list_images(limit=2)
    assert [r.id for r in page.items] == ["e", "d"]
    assert page.next == "d"
    page = db.list_images(limit=2, before="d")
    assert [r.id for r in page.items] == ["c", "b"]
    assert page.next == "b"
    page = db.list_images(limit=2, before="b")
    assert [r.id for r in page.items] == ["a"]
    assert page.next is None
    # An exact fit still ends the chain rather than promising an empty page.
    assert db.list_images(limit=5).next is None
    # A row that lands after the cursor row (newer) never shifts the page after it.
    db.insert_image(_plain_image("f", "2026-09-04T00:00:00Z"))
    assert [r.id for r in db.list_images(limit=2, before="d").items] == ["c", "b"]


def test_list_images_follows_insertion_when_the_clock_stepped_back(tmp_path: Path) -> None:
    """A host whose wall clock is stepped backwards (WSL2 does it every half minute, #214)
    stamps a later upload with an earlier created_at. The list and its cursor still follow the
    order the rows arrived in."""
    db = Database(tmp_path / "t.sqlite")
    db.init()
    for image_id, created in [
        ("a", "2026-09-01T00:00:05Z"),
        ("b", "2026-09-01T00:00:06Z"),
        ("c", "2026-09-01T00:00:04Z"),  # stamped after a 2 s backward step
    ]:
        db.insert_image(_plain_image(image_id, created))
    page = db.list_images(limit=2)
    assert ([r.id for r in page.items], page.next) == (["c", "b"], "b")
    page = db.list_images(limit=2, before="b")
    assert ([r.id for r in page.items], page.next) == (["a"], None)


def test_list_images_keeps_order_when_a_deleted_newest_rowid_is_reused(tmp_path: Path) -> None:
    """Without AUTOINCREMENT SQLite hands the deleted newest row's rowid to the next insert;
    that rowid is still the highest, so the replacement lists first (was a known limit, #137)."""
    db = Database(tmp_path / "t.sqlite")
    db.init()
    db.insert_image(_plain_image("a", "2026-09-01T00:00:00Z"))
    db.insert_image(_plain_image("b", "2026-09-01T00:00:00Z"))
    assert db.delete_image("b")
    db.insert_image(_plain_image("c", "2026-09-01T00:00:00Z"))
    assert [r.id for r in db.list_images().items] == ["c", "a"]


def test_list_images_unknown_cursor_raises(tmp_path: Path) -> None:
    db = Database(tmp_path / "t.sqlite")
    db.init()
    db.insert_image(_plain_image("a", "2026-09-01T00:00:00Z"))
    with pytest.raises(UnknownCursor):
        db.list_images(limit=2, before="gone")


def test_list_published_images_pages_the_filtered_rows(tmp_path: Path) -> None:
    db = Database(tmp_path / "t.sqlite")
    db.init()
    for image_id, published in [("a", True), ("b", False), ("c", True), ("d", True)]:
        db.insert_image(_plain_image(image_id, "2026-09-01T00:00:00Z", published))
    page = db.list_published_images(limit=2)
    assert [r.id for r in page.items] == ["d", "c"]
    assert page.next == "c"
    page = db.list_published_images(limit=2, before="c")
    assert ([r.id for r in page.items], page.next) == (["a"], None)


def _solved(db: Database, image_id: str, object_ids: list[int], version: int) -> None:
    objects = [
        SolveObject(id=i, catalog_names=[f"NGC {i}"], type="galaxy", x=10.0 * i, y=20.0, radius=5)
        for i in object_ids
    ]
    ann = Annotations(
        image_id=image_id,
        style=StyleConfig(),
        labels=[Label(object_id=i) for i in object_ids],
        version=version,
    )
    assert db.store_solve_result(
        image_id, objects, ann, {"solve_status": SolveStatus.SOLVED, "solve_error": None}
    )


def test_store_solve_result_lands_objects_layout_and_status_together(settings: Settings) -> None:
    db = Database(settings.db_path)
    rec = seed_image(settings, db)
    _solved(db, rec.id, [1, 2], version=1)
    stored = db.get_image(rec.id)
    assert stored is not None and stored.solve_status == SolveStatus.SOLVED
    assert [o.id for o in db.get_objects(rec.id)] == [1, 2]
    ann = db.get_annotations(rec.id)
    assert ann is not None and [lab.object_id for lab in ann.labels] == [1, 2]
    # A re-solve replaces all three at once; the previous objects are gone, not merged.
    _solved(db, rec.id, [3], version=2)
    assert [o.id for o in db.get_objects(rec.id)] == [3]
    ann = db.get_annotations(rec.id)
    assert ann is not None and ann.version == 2 and [lab.object_id for lab in ann.labels] == [3]


def test_store_solve_result_that_fails_part_way_leaves_the_previous_solve(
    settings: Settings,
) -> None:
    """A duplicate object id breaks the insert after the row update and the delete: everything
    rolls back, so a reader never sees the solved row with no objects (#174)."""
    db = Database(settings.db_path)
    rec = seed_image(settings, db)
    _solved(db, rec.id, [1, 2], version=1)
    before = (db.get_image(rec.id), db.get_objects(rec.id), db.get_annotations(rec.id))
    dup = [
        SolveObject(id=7, catalog_names=["M 7"], type="cluster", x=1, y=1),
        SolveObject(id=7, catalog_names=["M 7"], type="cluster", x=2, y=2),
    ]
    ann = Annotations(image_id=rec.id, style=StyleConfig(), labels=[Label(object_id=7)], version=2)
    with pytest.raises(Exception):  # noqa: B017 - sqlite3.IntegrityError, by way of the driver
        db.store_solve_result(rec.id, dup, ann, {"solve_status": SolveStatus.SOLVED})
    assert (db.get_image(rec.id), db.get_objects(rec.id), db.get_annotations(rec.id)) == before


def test_store_solve_result_for_a_deleted_image_writes_nothing(
    settings: Settings, caplog: pytest.LogCaptureFixture
) -> None:
    db = Database(settings.db_path)
    rec = seed_image(settings, db)
    assert db.delete_image(rec.id)
    objects = [SolveObject(id=1, catalog_names=["M 1"], type="nebula", x=1, y=1)]
    ann = Annotations(image_id=rec.id, style=StyleConfig(), labels=[Label(object_id=1)])
    with caplog.at_level(logging.DEBUG, logger="app.db"):
        assert not db.store_solve_result(rec.id, objects, ann, {"solve_status": SolveStatus.SOLVED})
    assert "store_solve_result: no row with id img-1" in caplog.text
    assert db.get_objects(rec.id) == []
    assert db.get_annotations(rec.id) is None


def test_migration_from_v5_adds_the_objects_catalog_stamp(tmp_path: Path) -> None:
    """Images solved before the local catalogue existed read NULL: the startup backfill looks
    them up once (#17)."""
    db = Database(tmp_path / "x.sqlite")
    db.init()
    with db.connect() as conn:  # rewind to the version-5 shape
        conn.execute("ALTER TABLE images DROP COLUMN objects_catalog")
        conn.execute("ALTER TABLE objects DROP COLUMN kind")  # added by 8
        conn.execute("PRAGMA user_version = 5")
    db.init()
    with db.connect() as conn:
        columns = {row["name"] for row in conn.execute("PRAGMA table_info(images)")}
        assert "objects_catalog" in columns
        assert conn.execute("PRAGMA user_version").fetchone()[0] == SCHEMA_VERSION
    db.init()  # idempotent


def test_images_for_catalog_backfill_picks_solved_rows_with_a_wcs_and_a_stale_stamp(
    tmp_path: Path,
) -> None:
    from app.models import SolveStatus
    from tests.conftest import make_settings, seed_image

    settings = make_settings(tmp_path)
    db = Database(settings.db_path)
    stale = seed_image(settings, db, "stale")
    fresh = seed_image(settings, db, "fresh")
    no_wcs = seed_image(settings, db, "no-wcs")
    unsolved = seed_image(settings, db, "unsolved")
    db.update_image(
        stale.id,
        {"solve_status": SolveStatus.SOLVED, "wcs_text": "SIMPLE", "objects_catalog": "2025-01-01"},
    )
    db.update_image(
        fresh.id,
        {"solve_status": SolveStatus.SOLVED, "wcs_text": "SIMPLE", "objects_catalog": "2026-10-13"},
    )
    db.update_image(no_wcs.id, {"solve_status": SolveStatus.SOLVED})
    assert unsolved.solve_status == SolveStatus.PENDING
    assert [r.id for r in db.images_for_catalog_backfill("2026-10-13")] == ["stale"]
    db.update_image(stale.id, {"objects_catalog": None})
    assert [r.id for r in db.images_for_catalog_backfill("2026-10-13")] == ["stale"]


def test_fold_casefolds_unicode_and_drops_whitespace() -> None:
    assert fold("  M 27 ") == "m27"
    assert fold("Туманность Андромеды") == "туманностьандромеды"
    assert fold("Straße") == "strasse"
    assert fold("") == ""


def test_fold_names_folds_every_name_in_the_json_array() -> None:
    names = fold_names('["NGC 6960", "C 34", "Veil Nebula"]')
    assert "ngc6960" in names
    assert "veilnebula" in names
    # Names are separated, so a query cannot bridge two of them.
    assert "c34veil" not in names


def _with_objects(
    db: Database, image_id: str, created: str, names: list[list[str]], published: bool = False
) -> None:
    db.insert_image(_plain_image(image_id, created, published))
    db.replace_objects(
        image_id,
        [
            SolveObject(id=i, catalog_names=n, type="ngc", x=1.0, y=1.0, radius=1)
            for i, n in enumerate(names, start=1)
        ],
    )


def _ids(db: Database, **filter: object) -> list[str]:
    return [r.id for r in db.list_images(filter=ListFilter(**filter)).items]  # type: ignore[arg-type]


def test_list_images_q_matches_title_primary_name_and_alias(tmp_path: Path) -> None:
    db = Database(tmp_path / "t.sqlite")
    db.init()
    _with_objects(db, "veil", "2026-09-01T00:00:00Z", [["NGC 6960", "C 34", "Veil Nebula"]])
    _with_objects(db, "m27", "2026-09-02T00:00:00Z", [["NGC 6853", "M 27", "Dumbbell Nebula"]])
    db.insert_image(_plain_image("M31_stacked_final", "2026-09-03T00:00:00Z"))
    assert _ids(db, q="veil") == ["veil"]
    assert _ids(db, q="NGC6960") == ["veil"]
    assert _ids(db, q="ngc 6960") == ["veil"]
    assert _ids(db, q="c 34") == ["veil"]
    assert _ids(db, q="m27") == ["m27"]
    assert _ids(db, q="dumbbell") == ["m27"]
    assert _ids(db, q="m31") == ["M31_stacked_final"]
    assert _ids(db, q="nebula") == ["m27", "veil"]  # newest first, both by an object name
    assert _ids(db, q="andromeda") == []


def test_list_images_blank_q_is_no_filter(tmp_path: Path) -> None:
    db = Database(tmp_path / "t.sqlite")
    db.init()
    db.insert_image(_plain_image("a", "2026-09-01T00:00:00Z"))
    db.insert_image(_plain_image("b", "2026-09-02T00:00:00Z"))
    assert [r.id for r in db.list_images(filter=ListFilter(q="   ")).items] == ["b", "a"]
    assert [r.id for r in db.list_images().items] == ["b", "a"]


def test_list_images_q_treats_like_wildcards_literally(tmp_path: Path) -> None:
    db = Database(tmp_path / "t.sqlite")
    db.init()
    db.insert_image(_plain_image("M_27", "2026-09-01T00:00:00Z"))
    db.insert_image(_plain_image("M 27", "2026-09-02T00:00:00Z"))
    db.insert_image(_plain_image("100%", "2026-09-03T00:00:00Z"))
    assert [r.id for r in db.list_images(filter=ListFilter(q="M_27")).items] == ["M_27"]
    assert [r.id for r in db.list_images(filter=ListFilter(q="%")).items] == ["100%"]


def test_list_images_q_pages_inside_the_result_set(tmp_path: Path) -> None:
    db = Database(tmp_path / "t.sqlite")
    db.init()
    for n in range(5):
        db.insert_image(_plain_image(f"orion-{n}", f"2026-09-0{n + 1}T00:00:00Z"))
        db.insert_image(_plain_image(f"other-{n}", f"2026-09-0{n + 1}T12:00:00Z"))
    first = db.list_images(2, None, ListFilter(q="orion"))
    assert [r.id for r in first.items] == ["orion-4", "orion-3"]
    assert first.next == "orion-3"
    second = db.list_images(2, first.next, ListFilter(q="orion"))
    assert [r.id for r in second.items] == ["orion-2", "orion-1"]
    third = db.list_images(2, second.next, ListFilter(q="orion"))
    assert ([r.id for r in third.items], third.next) == (["orion-0"], None)


def test_list_images_status_and_published_filters(tmp_path: Path) -> None:
    db = Database(tmp_path / "t.sqlite")
    db.init()
    rows = [
        ("pending", SolveStatus.PENDING, False),
        ("solving", SolveStatus.SOLVING, False),
        ("failed", SolveStatus.FAILED, True),
        ("solved-pub", SolveStatus.SOLVED, True),
        ("solved-unpub", SolveStatus.SOLVED, False),
    ]
    for n, (image_id, status, published) in enumerate(rows):
        rec = _plain_image(image_id, f"2026-09-0{n + 1}T00:00:00Z", published)
        db.insert_image(rec.model_copy(update={"solve_status": status}))
    assert _ids(db, status="solving") == ["solving", "pending"]
    assert _ids(db, status="failed") == ["failed"]
    assert _ids(db, status="solved") == ["solved-unpub", "solved-pub"]
    assert _ids(db, published=True) == ["solved-pub", "failed"]
    assert _ids(db, published=False) == ["solved-unpub", "solving", "pending"]
    assert _ids(db, status="solved", published=True) == ["solved-pub"]
    assert _ids(db, status="solved", published=True, q="unpub") == []


def test_list_published_images_searches_and_an_owner_field_can_only_narrow(
    tmp_path: Path,
) -> None:
    db = Database(tmp_path / "t.sqlite")
    db.init()
    _with_objects(db, "veil-unpub", "2026-09-01T00:00:00Z", [["NGC 6960", "Veil Nebula"]])
    _with_objects(db, "veil-pub", "2026-09-02T00:00:00Z", [["NGC 6992", "Eastern Veil"]], True)
    db.insert_image(_plain_image("m27-pub", "2026-09-03T00:00:00Z", published=True))
    gallery = db.list_published_images(filter=ListFilter(q="veil"))
    assert [r.id for r in gallery.items] == ["veil-pub"]
    # The gallery's own conditions are ANDed first, so an owner field never widens the list.
    narrowed = db.list_published_images(filter=ListFilter(q="veil", published=False))
    assert narrowed.items == []


def test_migration_from_v7_classifies_every_stored_object(tmp_path: Path) -> None:
    """A database the previous build wrote has objects but no ``kind`` column. Schema 8 adds
    it and fills it from the names table and nova's type, so the kind filter and the editor's
    chips agree from the first start."""
    db = Database(tmp_path / "x.sqlite")
    db.init()
    _with_objects(
        db,
        "field",
        "2026-09-01T00:00:00Z",
        [["NGC 224", "M 31"], ["NGC 1976", "M 42"], ["NGC 1912", "M 38"], ["Foo 1"]],
    )
    with db.connect() as conn:  # rewind to the version-7 shape
        conn.execute("ALTER TABLE objects DROP COLUMN kind")
        conn.execute(
            "INSERT INTO objects (image_id, id, catalog_names, type, x, y, radius)"
            " VALUES ('field', 5, '[\"ι Ori\"]', 'bright', 1, 1, 0)"
        )
        conn.execute("PRAGMA user_version = 7")
    db.init()
    with db.connect() as conn:
        assert conn.execute("PRAGMA user_version").fetchone()[0] == SCHEMA_VERSION
        kinds = {
            row["id"]: row["kind"]
            for row in conn.execute("SELECT id, kind FROM objects WHERE image_id = 'field'")
        }
    assert kinds == {1: "galaxy", 2: "nebula", 3: "cluster", 4: "other", 5: "star"}
    db.init()  # idempotent


def test_migration_from_v7_with_no_objects_still_stamps(tmp_path: Path) -> None:
    db = Database(tmp_path / "x.sqlite")
    db.init()
    with db.connect() as conn:
        conn.execute("ALTER TABLE objects DROP COLUMN kind")
        conn.execute("PRAGMA user_version = 7")
    db.init()
    with db.connect() as conn:
        assert conn.execute("PRAGMA user_version").fetchone()[0] == SCHEMA_VERSION
        assert "kind" in {row["name"] for row in conn.execute("PRAGMA table_info(objects)")}


def test_replace_objects_stores_the_kind_and_get_objects_reads_it(tmp_path: Path) -> None:
    db = Database(tmp_path / "t.sqlite")
    db.init()
    db.insert_image(_plain_image("a", "2026-09-01T00:00:00Z"))
    db.replace_objects(
        "a",
        [
            SolveObject(id=1, catalog_names=["NGC 224"], type="ngc", x=1.0, y=1.0, radius=1),
            SolveObject(id=2, catalog_names=["ι Ori"], type="bright", x=1.0, y=1.0, radius=0),
            SolveObject(id=3, catalog_names=["LDN 1"], type="ldn", x=1.0, y=1.0, radius=1),
        ],
    )
    assert [o.kind for o in db.get_objects("a")] == ["galaxy", "star", "nebula"]
    # The stored object is the one the Objects tab and the kind filter share.
    with db.connect() as conn:
        rows = conn.execute("SELECT id, kind FROM objects WHERE image_id = 'a' ORDER BY id")
        assert [(r["id"], r["kind"]) for r in rows] == [(1, "galaxy"), (2, "star"), (3, "nebula")]


def test_store_solve_result_stores_the_kind(settings: Settings) -> None:
    db = Database(settings.db_path)
    rec = seed_image(settings, db, "solved")
    ann = Annotations(image_id=rec.id, style=StyleConfig(), labels=[], version=1)
    ok = db.store_solve_result(
        rec.id,
        [SolveObject(id=1, catalog_names=["NGC 1976", "M 42"], type="ngc", x=1.0, y=1.0, radius=1)],
        ann,
        {"solve_status": SolveStatus.SOLVED},
    )
    assert ok
    assert [o.kind for o in db.get_objects(rec.id)] == ["nebula"]


def test_list_images_kind_needs_a_stored_object_of_that_kind(tmp_path: Path) -> None:
    db = Database(tmp_path / "t.sqlite")
    db.init()
    _with_objects(db, "andromeda", "2026-09-01T00:00:00Z", [["NGC 224", "M 31"]])
    db.replace_objects(  # the galaxy plus one of nova's stars (type "bright")
        "andromeda",
        [
            SolveObject(
                id=1, catalog_names=["NGC 224", "M 31"], type="ngc", x=1.0, y=1.0, radius=1
            ),
            SolveObject(id=2, catalog_names=["ι Ori"], type="bright", x=1.0, y=1.0, radius=0),
        ],
    )
    _with_objects(db, "orion", "2026-09-02T00:00:00Z", [["NGC 1976", "M 42"]])
    _with_objects(db, "unknown", "2026-09-03T00:00:00Z", [["Foo 1"]])
    db.insert_image(_plain_image("no-objects", "2026-09-04T00:00:00Z"))
    assert _ids(db, kind="galaxy") == ["andromeda"]
    assert _ids(db, kind="nebula") == ["orion"]
    assert _ids(db, kind="star") == ["andromeda"]  # nova's `bright` rows are stars
    assert _ids(db, kind="other") == ["unknown"]  # a stored row of kind other, not "no row"
    assert _ids(db, kind="cluster") == []
    # Independent of the search: a nebula whose names contain "m 4".
    assert _ids(db, kind="nebula", q="m 4") == ["orion"]
    assert _ids(db, kind="galaxy", q="m 4") == []


def test_list_images_date_range_is_inclusive_and_inverted_is_empty(tmp_path: Path) -> None:
    db = Database(tmp_path / "t.sqlite")
    db.init()
    db.insert_image(_plain_image("before", "2026-09-30T23:59:59+00:00"))
    db.insert_image(_plain_image("first", "2026-10-01T00:00:00+00:00"))
    db.insert_image(_plain_image("late", "2026-10-02T23:59:59+00:00"))
    db.insert_image(_plain_image("after", "2026-10-03T00:00:00+00:00"))
    assert _ids(db, since=date(2026, 10, 1)) == ["after", "late", "first"]
    assert _ids(db, until=date(2026, 10, 2)) == ["late", "first", "before"]
    # Both ends inclusive, to the last second of the `until` day.
    assert _ids(db, since=date(2026, 10, 1), until=date(2026, 10, 2)) == ["late", "first"]
    assert _ids(db, since=date(2026, 10, 2), until=date(2026, 10, 2)) == ["late"]
    # Swapped pickers are an empty list, not an error.
    assert _ids(db, since=date(2026, 10, 3), until=date(2026, 10, 1)) == []
    # The stamp's spelling of UTC does not matter: "Z" sorts after any digit too.
    db.insert_image(_plain_image("zulu", "2026-10-02T12:00:00Z"))
    assert _ids(db, since=date(2026, 10, 2), until=date(2026, 10, 2)) == ["zulu", "late"]


def test_list_published_images_narrows_by_kind_and_date_inside_the_gallery_rows(
    tmp_path: Path,
) -> None:
    db = Database(tmp_path / "t.sqlite")
    db.init()
    _with_objects(db, "m31-unpub", "2026-10-01T00:00:00Z", [["NGC 224"]])
    _with_objects(db, "m31-pub", "2026-10-02T00:00:00Z", [["NGC 224"]], True)
    _with_objects(db, "m42-pub", "2026-10-03T00:00:00Z", [["NGC 1976"]], True)

    def gallery(**filter: object) -> list[str]:
        page = db.list_published_images(filter=ListFilter(**filter))  # type: ignore[arg-type]
        return [r.id for r in page.items]

    assert gallery(kind="galaxy") == ["m31-pub"]
    assert gallery(since=date(2026, 10, 3)) == ["m42-pub"]
    assert gallery(kind="galaxy", until=date(2026, 10, 1)) == []
