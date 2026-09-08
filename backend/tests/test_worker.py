from __future__ import annotations

import asyncio
import json
import logging
from pathlib import Path

import pytest

from app.config import Settings
from app.db import Database
from app.models import SolveHints, SolveStatus
from app.solver import JobState, SolveRequest, SolverError, SolveResult, TransientSolverError
from app.storage import image_dir
from app.worker import NO_KEY_MESSAGE, UNEXPECTED_MESSAGE, SolveWorker
from tests.conftest import FakeSolver, load_fixture, make_worker, nova_result, seed_image

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


def test_successful_solve_stores_everything(settings: Settings) -> None:
    db = Database(settings.db_path)
    rec = seed_image(settings, db)
    solver = FakeSolver(submission_polls=2, job_polls=2)
    asyncio.run(make_worker(settings, db, solver).process(rec.id))

    got = db.get_image(rec.id)
    assert got is not None
    assert got.solve_status == SolveStatus.SOLVED
    assert got is not None
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
    db.update_image(rec.id, {"solve_hints": hints})
    asyncio.run(make_worker(settings, db, solver).process(rec.id))
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


class FlakySolver(FakeSolver):
    """Raises transient SolverErrors a configurable number of times per phase."""

    def __init__(self, *, poll_failures: int, job_failures: int, fetch_failures: int) -> None:
        super().__init__()
        self.poll_failures = poll_failures
        self.job_failures = job_failures
        self.fetch_failures = fetch_failures

    async def poll_submission(self, submission_id: int) -> int | None:
        if self.poll_failures > 0:
            self.poll_failures -= 1
            raise TransientSolverError("nova.astrometry.net returned HTTP 502; it may be down.")
        return await super().poll_submission(submission_id)

    async def poll_job(self, job_id: int) -> JobState:
        if self.job_failures > 0:
            self.job_failures -= 1
            raise TransientSolverError("Could not reach nova.astrometry.net (ReadTimeout).")
        return await super().poll_job(job_id)

    async def fetch_result(self, submission_id: int, job_id: int) -> SolveResult:
        if self.fetch_failures > 0:
            self.fetch_failures -= 1
            raise TransientSolverError("nova.astrometry.net returned HTTP 503.")
        return await super().fetch_result(submission_id, job_id)


def test_transient_nova_errors_are_retried(settings: Settings) -> None:
    db = Database(settings.db_path)
    rec = seed_image(settings, db)
    solver = FlakySolver(poll_failures=2, job_failures=1, fetch_failures=1)
    asyncio.run(make_worker(settings, db, solver).process(rec.id))
    got = db.get_image(rec.id)
    assert got is not None
    assert got is not None and got.solve_status == SolveStatus.SOLVED, got.solve_error
    assert (solver.poll_failures, solver.job_failures, solver.fetch_failures) == (0, 0, 0)


def test_old_nova_ids_survive_a_failed_resubmit(settings: Settings) -> None:
    db = Database(settings.db_path)
    rec = seed_image(settings, db)
    db.update_image(
        rec.id,
        {
            "solve_status": SolveStatus.FAILED,
            "solve_error": "old failure",
            "nova_submission_id": 100,
            "nova_job_id": 200,
        },
    )
    db.update_image(rec.id, {"solve_status": SolveStatus.PENDING, "solve_error": None})
    asyncio.run(
        make_worker(settings, db, FakeSolver(submit_error=SolverError("nova says no"))).process(
            rec.id
        )
    )
    got = db.get_image(rec.id)
    assert got is not None and got.solve_status == SolveStatus.FAILED
    assert got is not None
    assert got.solve_error == "nova says no"
    assert (got.nova_submission_id, got.nova_job_id) == (100, 200)  # links to the old attempt kept

    db.update_image(rec.id, {"solve_status": SolveStatus.PENDING})
    asyncio.run(make_worker(settings, db, FakeSolver()).process(rec.id))
    got = db.get_image(rec.id)
    assert got is not None and got.solve_status == SolveStatus.SOLVED
    assert (got.nova_submission_id, got.nova_job_id) == (12345678, 7654321)


def test_row_stays_pending_until_nova_accepts_the_upload(settings: Settings) -> None:
    db = Database(settings.db_path)
    rec = seed_image(settings, db)
    seen: list[str] = []

    class Observing(FakeSolver):
        async def submit(self, request: SolveRequest) -> int:
            row = db.get_image(rec.id)
            assert row is not None
            seen.append(row.solve_status.value)
            return await super().submit(request)

        async def poll_submission(self, submission_id: int) -> int | None:
            row = db.get_image(rec.id)
            assert row is not None
            seen.append(f"{row.solve_status.value}:{row.nova_submission_id}")
            return await super().poll_submission(submission_id)

    asyncio.run(make_worker(settings, db, Observing()).process(rec.id))
    assert seen == ["pending", "solving:12345678"]


def test_hints_stored_on_the_row_survive_a_restart(settings: Settings) -> None:
    db = Database(settings.db_path)
    rec = seed_image(settings, db)
    db.update_image(rec.id, {"solve_hints": SolveHints(focal_length_mm=400, pixel_size_um=3.76)})
    solver = FakeSolver()
    asyncio.run(make_worker(settings, db, solver).process(rec.id))  # no in-memory hints
    [req] = solver.requests
    assert req.scale_arcsec_per_px is not None
    assert abs(req.scale_arcsec_per_px - 206.265 * 3.76 / 400) < 1e-9


def test_deleted_image_mid_solve_is_dropped_quietly(settings: Settings) -> None:
    db = Database(settings.db_path)
    rec = seed_image(settings, db)

    class Deleting(FakeSolver):
        async def poll_submission(self, submission_id: int) -> int | None:
            if self.submission_poll_count == 1:
                db.delete_image(rec.id)
            return await super().poll_submission(submission_id)

    solver = Deleting(submission_polls=5)
    asyncio.run(make_worker(settings, db, solver).process(rec.id))
    assert db.get_image(rec.id) is None
    assert solver.submission_poll_count == 2  # noticed the deletion before the third poll


def test_unexpected_errors_never_leak_details_to_the_page(settings: Settings) -> None:
    db = Database(settings.db_path)
    rec = seed_image(settings, db)

    class Broken(FakeSolver):
        async def fetch_result(self, submission_id: int, job_id: int) -> SolveResult:
            raise RuntimeError(
                "[Errno 28] No space left on device: '/srv/data/uploads/x/solve.jpg'"
            )

    asyncio.run(make_worker(settings, db, Broken()).process(rec.id))
    got = db.get_image(rec.id)
    assert got is not None and got.solve_status == SolveStatus.FAILED
    assert got.solve_error is not None
    assert got.solve_error.startswith(UNEXPECTED_MESSAGE)
    assert "/srv/" not in got.solve_error and "Errno" not in got.solve_error
    assert "https://nova.example.test/status/12345678" in got.solve_error


def test_permanent_solver_errors_fail_immediately(settings: Settings) -> None:
    db = Database(settings.db_path)
    rec = seed_image(settings, db)

    class Rejecting(FakeSolver):
        async def poll_submission(self, submission_id: int) -> int | None:
            raise SolverError("nova.astrometry.net could not read the uploaded image.")

    solver = Rejecting()
    asyncio.run(make_worker(settings, db, solver, timeout=60).process(rec.id))
    got = db.get_image(rec.id)
    assert got is not None and got.solve_status == SolveStatus.FAILED
    assert got.solve_error == "nova.astrometry.net could not read the uploaded image."
    assert solver.submission_poll_count == 0  # not retried


def test_stale_transient_error_is_not_reported_after_a_good_poll(settings: Settings) -> None:
    db = Database(settings.db_path)
    rec = seed_image(settings, db)
    solver = FlakySolver(poll_failures=1, job_failures=0, fetch_failures=0)
    solver.submission_polls = 10**9  # nova legitimately still working
    asyncio.run(make_worker(settings, db, solver, timeout=0.05).process(rec.id))
    got = db.get_image(rec.id)
    assert got is not None and got.solve_error is not None
    assert got.solve_error.startswith("Timed out")
    assert "Last error" not in got.solve_error


def test_delete_during_unexpected_error_is_logged_quietly(
    settings: Settings, caplog: pytest.LogCaptureFixture
) -> None:
    db = Database(settings.db_path)
    rec = seed_image(settings, db)

    class DeletingThenBroken(FakeSolver):
        async def fetch_result(self, submission_id: int, job_id: int) -> SolveResult:
            db.delete_image(rec.id)
            raise RuntimeError("uploads/x/solve.jpg vanished")

    with caplog.at_level(logging.INFO, logger="app.worker"):
        asyncio.run(make_worker(settings, db, DeletingThenBroken()).process(rec.id))
    assert db.get_image(rec.id) is None
    assert not [r for r in caplog.records if r.levelno >= logging.ERROR]
    assert any("deleted during its solve" in r.getMessage() for r in caplog.records)


def test_default_style_is_read_live(tmp_path: Path) -> None:
    """A default_style written to config.json after start applies to the next solve."""
    from app.config import SettingsSource
    from tests.conftest import FONTS_DIR

    data_dir = tmp_path / "data"
    env = {"ASTROCAPTION_DATA_DIR": str(data_dir), "ASTROCAPTION_FONTS_DIR": str(FONTS_DIR)}
    source = SettingsSource(env=env)
    db = Database(source.current().db_path)
    rec = seed_image(source.current(), db)
    (data_dir / "config.json").write_text(
        '{"default_style": {"name_preference": "ngc_ic"}}', encoding="utf-8"
    )
    worker = SolveWorker(db, source, lambda: FakeSolver(), poll_interval=0.001, timeout=5)
    asyncio.run(worker.process(rec.id))
    ann = db.get_annotations(rec.id)
    assert ann is not None and ann.style.name_preference == "ngc_ic"
