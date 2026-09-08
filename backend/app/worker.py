"""Single-consumer solve queue. Solves run one at a time (SPEC § 14) and survive restarts."""

from __future__ import annotations

import asyncio
import json
import logging
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

from .config import Settings
from .db import Database
from .layout import build_default_annotations, rematch_annotations
from .models import ImageRecord, SolveHints, SolveStatus
from .objects import objects_from_nova
from .solver import JobState, Solver, SolveRequest, SolverError
from .storage import image_dir, make_solve_copy

log = logging.getLogger(__name__)

NO_KEY_MESSAGE = (
    "No nova.astrometry.net API key is configured. Set NOVA_API_KEY (or nova_api_key in"
    " data/config.json) and use Re-solve."
)
FAILED_MESSAGE = (
    "nova.astrometry.net could not solve this image. Try Re-solve with scale hints"
    " (focal length and pixel size), or check that the image shows enough stars."
)


@dataclass(frozen=True)
class SolveTask:
    image_id: str
    hints: SolveHints | None = None


class SolveWorker:
    def __init__(
        self,
        db: Database,
        settings: Settings,
        solver_factory: Callable[[], Solver | None],
        *,
        poll_interval: float = 5.0,
        timeout: float = 15 * 60,
    ) -> None:
        self.db = db
        self.settings = settings
        self.solver_factory = solver_factory
        self.poll_interval = poll_interval
        self.timeout = timeout
        self._queue: asyncio.Queue[SolveTask] = asyncio.Queue()
        self._task: asyncio.Task[None] | None = None
        self.current: str | None = None

    # -- lifecycle --------------------------------------------------------------------

    async def start(self) -> None:
        for rec in self.db.images_needing_solve():
            self._queue.put_nowait(SolveTask(rec.id))
        self._task = asyncio.create_task(self._run(), name="solve-worker")

    async def stop(self) -> None:
        if self._task is not None:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
            self._task = None

    def enqueue(self, image_id: str, hints: SolveHints | None = None) -> None:
        self._queue.put_nowait(SolveTask(image_id, hints))

    async def _run(self) -> None:
        while True:
            task = await self._queue.get()
            try:
                await self.process(task.image_id, task.hints)
            except asyncio.CancelledError:
                raise
            except Exception:  # pragma: no cover - last-resort guard
                log.exception("solve worker crashed on image %s", task.image_id)
            finally:
                self._queue.task_done()

    # -- pipeline --------------------------------------------------------------------------

    async def process(self, image_id: str, hints: SolveHints | None = None) -> None:
        rec = self.db.get_image(image_id)
        if rec is None:
            return
        self.current = image_id
        try:
            await self._solve(rec, hints)
        except SolverError as exc:
            log.warning("solve failed for %s: %s", image_id, exc)
            self._fail(image_id, str(exc))
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            log.exception("unexpected error while solving %s", image_id)
            self._fail(image_id, f"Unexpected error while solving: {exc.__class__.__name__}: {exc}")
        finally:
            self.current = None

    def _fail(self, image_id: str, message: str) -> None:
        self.db.update_image(image_id, {"solve_status": SolveStatus.FAILED, "solve_error": message})

    async def _solve(self, rec: ImageRecord, hints: SolveHints | None) -> None:
        solver = self.solver_factory()
        if solver is None:
            raise SolverError(NO_KEY_MESSAGE)
        directory = image_dir(self.settings, rec.id)
        directory.mkdir(parents=True, exist_ok=True)

        resume = rec.solve_status == SolveStatus.SOLVING and rec.nova_submission_id is not None
        self.db.update_image(rec.id, {"solve_status": SolveStatus.SOLVING, "solve_error": None})

        if resume:
            assert rec.nova_submission_id is not None
            submission_id = rec.nova_submission_id
            job_id = rec.nova_job_id
            scale = rec.solve_scale
        else:
            solve_copy = directory / "solve.jpg"
            scale = await asyncio.to_thread(
                make_solve_copy, self.settings.data_dir / rec.original_path, solve_copy
            )
            self.db.update_image(
                rec.id, {"solve_scale": scale, "nova_submission_id": None, "nova_job_id": None}
            )
            hint = hints.arcsec_per_pixel if hints else None
            request = SolveRequest(
                image_path=solve_copy,
                scale_arcsec_per_px=hint * scale if hint is not None else None,
                scale_tolerance_pct=hints.scale_tolerance_pct if hints else 20.0,
            )
            submission_id = await solver.submit(request)
            self.db.update_image(rec.id, {"nova_submission_id": submission_id})
            job_id = None

        loop = asyncio.get_running_loop()
        deadline = loop.time() + self.timeout

        while job_id is None:
            job_id = await solver.poll_submission(submission_id)
            if job_id is None:
                self._check_deadline(loop.time(), deadline, solver, submission_id)
                await asyncio.sleep(self.poll_interval)
        self.db.update_image(rec.id, {"nova_job_id": job_id})

        while True:
            state = await solver.poll_job(job_id)
            if state == JobState.SUCCESS:
                break
            if state == JobState.FAILURE:
                raise SolverError(FAILED_MESSAGE)
            self._check_deadline(loop.time(), deadline, solver, submission_id)
            await asyncio.sleep(self.poll_interval)

        result = await solver.fetch_result(submission_id, job_id)
        await asyncio.to_thread(self._store_result, rec, scale, result.annotations, result.wcs_text)
        self.db.update_image(
            rec.id,
            {
                "solve_status": SolveStatus.SOLVED,
                "solve_error": None,
                "wcs_text": result.wcs_text or None,
                "calibration": result.calibration,
            },
        )

    def _check_deadline(
        self, now: float, deadline: float, solver: Solver, submission_id: int
    ) -> None:
        if now < deadline:
            return
        minutes = round(self.timeout / 60)
        url = solver.status_url(submission_id)
        where = f" Check {url} and use Re-solve." if url else " Use Re-solve to try again."
        raise SolverError(
            f"Timed out after {minutes} minutes waiting for nova.astrometry.net.{where}"
        )

    def _store_result(
        self,
        rec: ImageRecord,
        scale: float,
        annotations: object,
        wcs_text: str,
    ) -> None:
        """Blocking part of a successful solve: files, objects and the default layout."""
        directory = image_dir(self.settings, rec.id)
        (directory / "nova_annotations.json").write_text(
            json.dumps(annotations, indent=1), encoding="utf-8"
        )
        if wcs_text:
            (directory / "wcs.fits").write_text(wcs_text, encoding="ascii", errors="replace")

        raw = annotations if isinstance(annotations, list) else []
        new_objects = objects_from_nova(raw, scale)
        previous = self.db.get_annotations(rec.id)
        fonts: Path = self.settings.fonts_dir
        if previous is None:
            ann = build_default_annotations(
                rec.id, rec.width, rec.height, new_objects, fonts, self.settings.default_style
            )
        else:
            old_objects = self.db.get_objects(rec.id)
            ann = rematch_annotations(
                previous, old_objects, new_objects, rec.width, rec.height, fonts
            )
        self.db.replace_objects(rec.id, new_objects)
        self.db.save_annotations(ann)
