from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from enum import StrEnum
from pathlib import Path
from typing import Protocol

from ..models import Calibration


class SolverError(Exception):
    """A solve failed in a way the owner should read about in plain language."""


class JobState(StrEnum):
    SOLVING = "solving"
    SUCCESS = "success"
    FAILURE = "failure"


@dataclass(frozen=True)
class SolveRequest:
    image_path: Path
    scale_arcsec_per_px: float | None = None  # in pixels of ``image_path``
    scale_tolerance_pct: float = 20.0


@dataclass(frozen=True)
class SolveResult:
    annotations: Sequence[Mapping[str, object]] = field(default_factory=list)
    wcs_text: str = ""
    calibration: Calibration | None = None


class Solver(Protocol):
    """Asynchronous plate solver with resumable job polling.

    The worker persists the submission and job ids between calls so a solve survives
    a container restart.
    """

    async def submit(self, request: SolveRequest) -> int:
        """Upload the image and return a submission id."""
        ...

    async def poll_submission(self, submission_id: int) -> int | None:
        """Return the job id once nova has assigned one, else ``None``."""
        ...

    async def poll_job(self, job_id: int) -> JobState: ...

    async def fetch_result(self, submission_id: int, job_id: int) -> SolveResult: ...

    def status_url(self, submission_id: int) -> str | None: ...

    def job_log_url(self, job_id: int) -> str | None: ...
