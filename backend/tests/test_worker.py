from __future__ import annotations

import asyncio
import json
from pathlib import Path

from app.config import Settings
from app.db import Database
from app.models import ImageRecord, SolveHints, SolveStatus, utcnow_iso
from app.solver import SolverError, SolveResult
from app.storage import image_dir, make_derivatives
from app.worker import NO_KEY_MESSAGE, SolveWorker
from tests.conftest import FakeSolver, load_fixture, nova_result, write_test_image

ENABLED_BY_DEFAULT = {  # 3000 px test image: radius ≥ 12 px in the solve copy, plus bright stars
    "M 42",
    "M 43",
    "NGC 1977",
    "NGC 1975",
    "NGC 1980",
    "NGC 1981",
    "IC 420",
    "NGC 1973",
    "NGC 1999",
    "Hatysa",
    "Thabit",
    "Mizan Batil I",
    "Trapezium",
    "Mizan Batil II",
    "θ1 Ori C",
    "θ1 Ori D",
    "45 Ori",
}


def seed_image(
    settings: Settings, db: Database, image_id: str = "img-1", width: int = 3000
) -> ImageRecord:
    settings.ensure_dirs()
    db.init()
    directory = image_dir(settings, image_id)
    original = write_test_image(directory / "original.jpg", width, width * 2 // 3)
    preview, thumb = make_derivatives(original, directory)
    now = utcnow_iso()
    rec = ImageRecord(
        id=image_id,
        created_at=now,
        updated_at=now,
        title="Orion",
        original_name="orion.jpg",
        original_path=original.relative_to(settings.data_dir).as_posix(),
        preview_path=preview.relative_to(settings.data_dir).as_posix(),
        thumb_path=thumb.relative_to(settings.data_dir).as_posix(),
        width=width,
        height=width * 2 // 3,
    )
    db.insert_image(rec)
    return rec


def make_worker(
    settings: Settings, db: Database, solver: FakeSolver | None, **kw: float
) -> SolveWorker:
    return SolveWorker(
        db, settings, lambda: solver, poll_interval=0.001, timeout=kw.get("timeout", 5)
    )


def test_successful_solve_stores_everything(settings: Settings) -> None:
    db = Database(settings.db_path)
    rec = seed_image(settings, db)
    solver = FakeSolver(submission_polls=2, job_polls=2)
    asyncio.run(make_worker(settings, db, solver).process(rec.id))

    got = db.get_image(rec.id)
    assert got is not None
    assert got.solve_status == SolveStatus.SOLVED
    assert got.solve_error is None
    assert got.nova_submission_id == 12345678 and got.nova_job_id == 7654321
    assert got.solve_scale == 1.0
    assert got.wcs_text and got.wcs_text.startswith("SIMPLE")
    assert got.calibration is not None
    assert got.calibration.pixscale == load_fixture("job_info.json")["calibration"]["pixscale"]

    directory = image_dir(settings, rec.id)
    assert (directory / "solve.jpg").is_file()
    assert (directory / "wcs.fits").read_text().startswith("SIMPLE")
    assert len(json.loads((directory / "nova_annotations.json").read_text())) == 20

    objects = db.get_objects(rec.id)
    assert len(objects) == 20
    ann = db.get_annotations(rec.id)
    assert ann is not None and ann.version == 1
    assert len(ann.labels) == 20
    enabled = {
        o.primary_name
        for o in objects
        if any(l.enabled and l.object_id == o.id for l in ann.labels)
    }
    assert enabled == ENABLED_BY_DEFAULT
    assert ann.style.font_size == 36  # 12 * (3000 / 1000)
    assert not any(l.collided for l in ann.labels if l.enabled)


def test_default_style_overrides_from_config(settings: Settings) -> None:
    from dataclasses import replace

    tuned = replace(settings, default_style={"name_preference": "ngc_ic", "font_size": 40})
    db = Database(tuned.db_path)
    rec = seed_image(tuned, db)
    asyncio.run(make_worker(tuned, db, FakeSolver()).process(rec.id))
    ann = db.get_annotations(rec.id)
    assert ann is not None
    assert ann.style.name_preference == "ngc_ic" and ann.style.font_size == 40
    ngc1976 = next(o for o in db.get_objects(rec.id) if "NGC 1976" in o.catalog_names)
    assert ngc1976.primary_name_for(ann.style.name_preference) == "NGC 1976"

    broken = replace(settings, default_style={"font_size": "huge"})
    db2 = Database(broken.db_path)
    rec2 = seed_image(broken, db2, image_id="img-2")
    asyncio.run(make_worker(broken, db2, FakeSolver()).process(rec2.id))
    ann2 = db2.get_annotations(rec2.id)
    assert ann2 is not None and ann2.style.font_size == 36  # invalid override ignored


def test_large_image_is_downscaled_for_solving_and_coordinates_scaled_back(
    settings: Settings,
) -> None:
    db = Database(settings.db_path)
    rec = seed_image(settings, db, width=6000)
    asyncio.run(make_worker(settings, db, FakeSolver()).process(rec.id))
    got = db.get_image(rec.id)
    assert got is not None and got.solve_scale == 2.0
    m42 = next(o for o in db.get_objects(rec.id) if o.primary_name == "M 42")
    src = next(
        a for a in load_fixture("annotations.json")["annotations"] if a["names"] == ["NGC 1976"]
    )
    assert (m42.x, m42.y, m42.radius) == (src["pixelx"] * 2, src["pixely"] * 2, src["radius"] * 2)


def test_scale_hint_is_converted_to_solve_copy_pixels(settings: Settings) -> None:
    db = Database(settings.db_path)
    rec = seed_image(settings, db, width=6000)
    solver = FakeSolver()
    hints = SolveHints(focal_length_mm=400, pixel_size_um=3.76, scale_tolerance_pct=10)
    asyncio.run(make_worker(settings, db, solver).process(rec.id, hints))
    [req] = solver.requests
    assert req.scale_arcsec_per_px is not None
    assert abs(req.scale_arcsec_per_px - 206.265 * 3.76 / 400 * 2) < 1e-9
    assert req.scale_tolerance_pct == 10


def test_resume_after_restart_skips_upload(settings: Settings) -> None:
    db = Database(settings.db_path)
    rec = seed_image(settings, db)
    db.update_image(rec.id, {"solve_status": SolveStatus.SOLVING, "nova_submission_id": 12345678})
    solver = FakeSolver()
    asyncio.run(make_worker(settings, db, solver).process(rec.id))
    assert solver.requests == []
    got = db.get_image(rec.id)
    assert got is not None and got.solve_status == SolveStatus.SOLVED


def test_failure_paths_set_plain_language_errors(settings: Settings) -> None:
    db = Database(settings.db_path)
    rec = seed_image(settings, db)

    asyncio.run(make_worker(settings, db, None).process(rec.id))
    got = db.get_image(rec.id)
    assert got is not None and got.solve_status == SolveStatus.FAILED
    assert got.solve_error == NO_KEY_MESSAGE

    asyncio.run(make_worker(settings, db, FakeSolver(fail=True)).process(rec.id))
    got = db.get_image(rec.id)
    assert got is not None and got.solve_status == SolveStatus.FAILED
    assert got.solve_error and "could not solve" in got.solve_error

    asyncio.run(
        make_worker(settings, db, FakeSolver(submit_error=SolverError("nova says no"))).process(
            rec.id
        )
    )
    got = db.get_image(rec.id)
    assert got is not None and got.solve_error == "nova says no"

    asyncio.run(
        make_worker(settings, db, FakeSolver(submission_polls=10**9), timeout=0.02).process(rec.id)
    )
    got = db.get_image(rec.id)
    assert got is not None and got.solve_error and got.solve_error.startswith("Timed out")
    assert "/status/12345678" in got.solve_error


def test_resolve_keeps_layout_and_rematches_by_name(settings: Settings) -> None:
    db = Database(settings.db_path)
    rec = seed_image(settings, db)
    asyncio.run(make_worker(settings, db, FakeSolver()).process(rec.id))
    ann = db.get_annotations(rec.id)
    assert ann is not None
    objects = {o.primary_name: o for o in db.get_objects(rec.id)}
    m42 = objects["M 42"]
    edited = [
        lab.model_copy(update={"x": 42.0, "y": 43.0, "text_override": "Great Orion Nebula"})
        if lab.object_id == m42.id
        else lab
        for lab in ann.labels
    ]
    db.save_annotations(ann.model_copy(update={"labels": edited, "version": 5}))

    base = nova_result()
    new_raw = [dict(a) for a in base.annotations if "IC 420" not in str(a["names"])]
    new_raw.append(
        {"radius": 60.0, "type": "ngc", "names": ["NGC 2024"], "pixelx": 1300.0, "pixely": 1600.0}
    )
    asyncio.run(
        make_worker(
            settings, db, FakeSolver(SolveResult(new_raw, base.wcs_text, base.calibration))
        ).process(rec.id)
    )
    new_objects = {o.primary_name: o for o in db.get_objects(rec.id)}
    assert "IC 420" not in new_objects and "NGC 2024" in new_objects
    ann2 = db.get_annotations(rec.id)
    assert ann2 is not None and ann2.version == 6
    by_obj = {lab.object_id: lab for lab in ann2.labels}
    carried = by_obj[new_objects["M 42"].id]
    assert (carried.x, carried.y, carried.text_override) == (42.0, 43.0, "Great Orion Nebula")
    fresh = by_obj[new_objects["NGC 2024"].id]
    assert fresh.enabled and (fresh.x, fresh.y) != (1300.0, 1600.0)
    assert len(ann2.labels) == len(new_objects)
    assert (Path(settings.data_dir) / "uploads" / rec.id / "solve.jpg").is_file()
