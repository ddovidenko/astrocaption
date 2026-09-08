from __future__ import annotations

from pathlib import Path

import pytest

from app.config import Settings
from app.db import SCHEMA_VERSION, Database
from app.models import SolveHints
from tests.conftest import seed_image


def test_migration_from_v1_adds_hints_column(tmp_path: Path) -> None:
    db = Database(tmp_path / "x.sqlite")
    db.init()
    with db.connect() as conn:  # rewind to the version-1 shape
        conn.execute("ALTER TABLE images DROP COLUMN solve_hints_json")
        conn.execute("PRAGMA user_version = 1")
    db.init()
    with db.connect() as conn:
        columns = {row["name"] for row in conn.execute("PRAGMA table_info(images)")}
        assert "solve_hints_json" in columns
        assert conn.execute("PRAGMA user_version").fetchone()[0] == SCHEMA_VERSION
    db.init()  # idempotent


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
    monkeypatch.setattr(dbmod, "SCHEMA_VERSION", 3)
    monkeypatch.setitem(
        dbmod.MIGRATIONS, 3, ("ALTER TABLE images ADD COLUMN scratch TEXT", "THIS IS NOT SQL")
    )
    with pytest.raises(Exception, match="syntax error"):
        db.init()
    with db.connect() as conn:
        assert conn.execute("PRAGMA user_version").fetchone()[0] == 2
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
    listed = db.list_images()
    assert [i.id for i in listed] == [rec.id]
    assert listed[0].solve_hints is None and listed[0].calibration is None


def test_record_fields_and_table_columns_agree(tmp_path: Path) -> None:
    from app.db import IMAGE_COLUMNS

    db = Database(tmp_path / "x.sqlite")
    db.init()
    with db.connect() as conn:
        columns = {row["name"] for row in conn.execute("PRAGMA table_info(images)")}
    assert columns == set(IMAGE_COLUMNS)
