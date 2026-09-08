"""Single-consumer solve queue. Solves run one at a time (SPEC § 14) and survive restarts.

Row lifecycle: an image is PENDING (previous nova ids, if any, untouched) until nova accepts
the upload; SOLVING, with the new submission id, while nova works; then SOLVED or FAILED.
A restart re-enqueues PENDING rows from scratch and resumes SOLVING rows by polling the
stored submission, so an upload to nova never happens twice for the same attempt. Scale
hints live on the row (``solve_hints``), so they survive restarts too.
"""

from __future__ import annotations

import asyncio
import json
import logging
from collections.abc import Awaitable, Callable
from pathlib import Path

from .config import Settings, SettingsSource
from .db import Database
from .layout import build_default_annotations, rematch_annotations
from .models import ImageRecord, SolveStatus
from .objects import objects_from_nova
from .solver import JobState, Solver, SolveRequest, SolverError, TransientSolverError
from .solver.nova import status_url
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
UNEXPECTED_MESSAGE = (
    "Something went wrong on this server while solving; details are in the server log."
    " Use Re-solve to try again."
)


class ImageGoneError(Exception):
    """The image row disappeared (it was deleted) while its solve was in progress."""


class SolveWorker:
    def __init__(
        self,
        db: Database,
        settings: SettingsSource | Settings,
        solver_factory: Callable[[], Solver | None],
        *,
        poll_interval: float = 5.0,
        timeout: float = 15 * 60,
    ) -> None:
        self.db = db
        self._source = (
            settings if isinstance(settings, SettingsSource) else SettingsSource(settings)
        )
        self.solver_factory = solver_factory
        self.poll_interval = poll_interval
        self.timeout = timeout
        self._queue: asyncio.Queue[str] = asyncio.Queue()
        self._task: asyncio.Task[None] | None = None
        self.current: str | None = None

    @property
    def settings(self) -> Settings:
        return self._source.current()

    # -- lifecycle --------------------------------------------------------------------

    async def start(self) -> None:
        for rec in self.db.images_needing_solve():
            self._queue.put_nowait(rec.id)
        self._task = asyncio.create_task(self._run(), name="solve-worker")

    async def stop(self) -> None:
        if self._task is not None:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
            self._task = None

    def enqueue(self, image_id: str) -> None:
        self._queue.put_nowait(image_id)

    async def _run(self) -> None:
        while True:
            image_id = await self._queue.get()
            try:
                await self.process(image_id)
            except asyncio.CancelledError:
                raise
            except Exception:  # pragma: no cover - last-resort guard
                log.exception("solve worker crashed on image %s", image_id)
            finally:
                self._queue.task_done()

    # -- pipeline --------------------------------------------------------------------------

    async def process(self, image_id: str) -> None:
        rec = self.db.get_image(image_id)
        if rec is None:
            return
        self.current = image_id
        try:
            await self._solve(rec)
        except ImageGoneError:
            log.info("image %s was deleted during its solve; dropping it", image_id)
        except SolverError as exc:
            log.warning("solve failed for %s: %s", image_id, exc)
            self._fail(image_id, str(exc))
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001 - logged with traceback by _report_unexpected
            self._report_unexpected(image_id)
        finally:
            self.current = None

    def _report_unexpected(self, image_id: str) -> None:
        """Plain language for the owner; the traceback stays in the log (CLAUDE.md)."""
        try:
            rec = self.db.get_image(image_id)
        except Exception:
            log.exception("unexpected error while solving %s (database unavailable)", image_id)
            return
        if rec is None:
            log.info("image %s was deleted during its solve; dropping it", image_id)
            return
        log.exception("unexpected error while solving %s", image_id)
        message = UNEXPECTED_MESSAGE
        if rec.nova_submission_id is not None:
            url = status_url(self.settings.nova_base_url, rec.nova_submission_id)
            message = f"{message} Nova status: {url}"
        self._fail(image_id, message)

    def _fail(self, image_id: str, message: str) -> None:
        try:
            self.db.update_image(
                image_id, {"solve_status": SolveStatus.FAILED, "solve_error": message}
            )
        except Exception:  # the failure handler must never take the worker down
            log.exception("could not record the failure of image %s: %s", image_id, message)

    def _ensure_present(self, image_id: str) -> None:
        if self.db.get_image(image_id) is None:
            raise ImageGoneError(image_id)

    async def _solve(self, rec: ImageRecord) -> None:
        solver = self.solver_factory()
        if solver is None:
            raise SolverError(NO_KEY_MESSAGE)
        settings = self.settings
        directory = image_dir(settings, rec.id)
        directory.mkdir(parents=True, exist_ok=True)

        resume = rec.solve_status == SolveStatus.SOLVING and rec.nova_submission_id is not None
        if resume:
            assert rec.nova_submission_id is not None
            submission_id = rec.nova_submission_id
            job_id = rec.nova_job_id
            scale = rec.solve_scale
        else:
            solve_copy = directory / "solve.jpg"
            scale = await asyncio.to_thread(
                make_solve_copy, settings.data_dir / rec.original_path, solve_copy
            )
            self._ensure_present(rec.id)
            hints = rec.solve_hints
            hint = hints.arcsec_per_pixel if hints else None
            request = SolveRequest(
                image_path=solve_copy,
                scale_arcsec_per_px=hint * scale if hint is not None else None,
                scale_tolerance_pct=hints.scale_tolerance_pct if hints else 20.0,
            )
            submission_id = await solver.submit(request)
            # Only now does the row leave PENDING: the new ids replace the old ones atomically.
            self.db.update_image(
                rec.id,
                {
                    "solve_status": SolveStatus.SOLVING,
                    "solve_error": None,
                    "solve_scale": scale,
                    "nova_submission_id": submission_id,
                    "nova_job_id": None,
                },
            )
            job_id = None

        deadline = asyncio.get_running_loop().time() + self.timeout
        if job_id is None:
            job_id = await self._poll_until(
                rec.id, submission_id, deadline, lambda: solver.poll_submission(submission_id)
            )
            self.db.update_image(rec.id, {"nova_job_id": job_id})
        jid = job_id

        async def job_finished() -> JobState | None:
            state = await solver.poll_job(jid)
            if state == JobState.FAILURE:
                raise SolverError(FAILED_MESSAGE)
            return state if state == JobState.SUCCESS else None

        await self._poll_until(rec.id, submission_id, deadline, job_finished)
        result = await self._poll_until(
            rec.id, submission_id, deadline, lambda: solver.fetch_result(submission_id, jid)
        )
        self._ensure_present(rec.id)
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

    async def _poll_until[T](
        self,
        image_id: str,
        submission_id: int,
        deadline: float,
        step: Callable[[], Awaitable[T | None]],
    ) -> T:
        """Run ``step`` until it returns a value.

        Transient solver errors (nova unreachable or 5xx) are retried until ``deadline``;
        any other SolverError propagates at once. A deleted image aborts the solve.
        """
        loop = asyncio.get_running_loop()
        last_error: str | None = None
        while True:
            self._ensure_present(image_id)
            try:
                result = await step()
                last_error = None
            except TransientSolverError as exc:
                result = None
                last_error = str(exc)
                log.warning("image %s: %s (retrying)", image_id, exc)
            if result is not None:
                return result
            self._check_deadline(loop.time(), deadline, submission_id, last_error)
            await asyncio.sleep(self.poll_interval)

    def _check_deadline(
        self, now: float, deadline: float, submission_id: int, last_error: str | None
    ) -> None:
        if now < deadline:
            return
        minutes = round(self.timeout / 60)
        url = status_url(self.settings.nova_base_url, submission_id)
        detail = f" Last error: {last_error}" if last_error else ""
        raise SolverError(
            f"Timed out after {minutes} minutes waiting for nova.astrometry.net."
            f" Check {url} and use Re-solve.{detail}"
        )

    def _store_result(
        self,
        rec: ImageRecord,
        scale: float,
        annotations: object,
        wcs_text: str,
    ) -> None:
        """Blocking part of a successful solve: files, objects and the default layout."""
        settings = self.settings
        directory = image_dir(settings, rec.id)
        (directory / "nova_annotations.json").write_text(
            json.dumps(annotations, indent=1), encoding="utf-8"
        )
        if wcs_text:
            (directory / "wcs.fits").write_text(wcs_text, encoding="ascii", errors="replace")

        raw = annotations if isinstance(annotations, list) else []
        new_objects = objects_from_nova(raw, scale)
        previous = self.db.get_annotations(rec.id)
        fonts: Path = settings.fonts_dir
        if previous is None:
            ann = build_default_annotations(
                rec.id, rec.width, rec.height, new_objects, fonts, settings.default_style
            )
        else:
            old_objects = self.db.get_objects(rec.id)
            ann = rematch_annotations(
                previous, old_objects, new_objects, rec.width, rec.height, fonts
            )
        self.db.replace_objects(rec.id, new_objects)
        self.db.save_annotations(ann)
