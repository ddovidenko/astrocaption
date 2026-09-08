"""nova.astrometry.net client (https://astrometry.net/doc/net/api.html).

Never called from tests; the recorded responses live in ``tests/fixtures/nova/`` and
``tests/test_nova.py`` replays them through an ``httpx.MockTransport``.
"""

from __future__ import annotations

import json
import logging
from typing import Any

import httpx

from ..models import Calibration
from .base import JobState, SolveRequest, SolverError, SolveResult

log = logging.getLogger(__name__)

NOVA_BASE_URL = "https://nova.astrometry.net"
UNREACHABLE = "Could not reach nova.astrometry.net"
BAD_KEY = (
    "nova.astrometry.net rejected the API key. Check NOVA_API_KEY (or nova_api_key in"
    " data/config.json); the key is shown on your nova.astrometry.net profile page."
)


def status_url(base_url: str, submission_id: int) -> str:
    return f"{base_url.rstrip('/')}/status/{submission_id}"


def job_log_url(base_url: str, job_id: int) -> str:
    return f"{base_url.rstrip('/')}/joblog/{job_id}"


class NovaSolver:
    def __init__(
        self, api_key: str, client: httpx.AsyncClient, base_url: str = NOVA_BASE_URL
    ) -> None:
        self._api_key = api_key
        self._client = client
        self._base = base_url.rstrip("/")
        self._session: str | None = None

    # -- urls -----------------------------------------------------------------------

    def status_url(self, submission_id: int) -> str | None:
        return status_url(self._base, submission_id)

    def job_log_url(self, job_id: int) -> str | None:
        return job_log_url(self._base, job_id)

    # -- transport helpers ------------------------------------------------------------

    async def _request(self, method: str, path: str, **kwargs: Any) -> httpx.Response:
        try:
            resp = await self._client.request(method, f"{self._base}{path}", **kwargs)
        except httpx.HTTPError as exc:
            raise SolverError(f"{UNREACHABLE} ({exc.__class__.__name__}).") from exc
        if resp.status_code >= 500:
            raise SolverError(
                f"nova.astrometry.net returned HTTP {resp.status_code}; it may be down."
                " Try again later."
            )
        return resp

    async def _json(self, method: str, path: str, **kwargs: Any) -> dict[str, Any]:
        resp = await self._request(method, path, **kwargs)
        try:
            payload = resp.json()
        except ValueError as exc:
            raise SolverError(
                f"nova.astrometry.net returned an unexpected response (HTTP {resp.status_code})."
            ) from exc
        if not isinstance(payload, dict):
            raise SolverError("nova.astrometry.net returned an unexpected response.")
        return payload

    async def _login(self) -> str:
        payload = await self._json(
            "POST", "/api/login", data={"request-json": json.dumps({"apikey": self._api_key})}
        )
        if payload.get("status") != "success" or not payload.get("session"):
            raise SolverError(BAD_KEY)
        self._session = str(payload["session"])
        return self._session

    async def _session_key(self) -> str:
        return self._session or await self._login()

    # -- Solver protocol ---------------------------------------------------------------

    async def submit(self, request: SolveRequest) -> int:
        for attempt in range(2):
            session = await self._session_key()
            params: dict[str, Any] = {
                "session": session,
                "publicly_visible": "n",
                "allow_modifications": "d",
                "allow_commercial_use": "d",
            }
            if request.scale_arcsec_per_px is not None:
                params.update(
                    scale_units="arcsecperpix",
                    scale_type="ev",
                    scale_est=request.scale_arcsec_per_px,
                    scale_err=request.scale_tolerance_pct,
                )
            with request.image_path.open("rb") as fh:
                payload = await self._json(
                    "POST",
                    "/api/upload",
                    data={"request-json": json.dumps(params)},
                    files={"file": (request.image_path.name, fh, "image/jpeg")},
                )
            if payload.get("status") == "success" and payload.get("subid") is not None:
                return int(payload["subid"])
            message = str(payload.get("errormessage") or "unknown error")
            if "session" in message.lower() and attempt == 0:
                self._session = None  # expired session: log in again once
                continue
            raise SolverError(f"nova.astrometry.net refused the upload: {message}")
        raise SolverError("nova.astrometry.net refused the upload.")

    async def poll_submission(self, submission_id: int) -> int | None:
        payload = await self._json("GET", f"/api/submissions/{submission_id}")
        jobs = payload.get("jobs") or []
        for job in jobs:
            if job is not None:
                return int(job)
        return None

    async def poll_job(self, job_id: int) -> JobState:
        payload = await self._json("GET", f"/api/jobs/{job_id}")
        status = str(payload.get("status") or "")
        if status == "success":
            return JobState.SUCCESS
        if status == "failure":
            return JobState.FAILURE
        return JobState.SOLVING

    async def fetch_result(self, submission_id: int, job_id: int) -> SolveResult:
        ann = await self._json("GET", f"/api/jobs/{job_id}/annotations/")
        entries = ann.get("annotations")
        if not isinstance(entries, list):
            raise SolverError("nova.astrometry.net returned no annotation list for this job.")

        calibration: Calibration | None = None
        info = await self._json("GET", f"/api/jobs/{job_id}/info/")
        raw_cal = info.get("calibration")
        if isinstance(raw_cal, dict):
            try:
                calibration = Calibration.model_validate(raw_cal)
            except ValueError:
                log.warning("nova job %s: unparseable calibration %r", job_id, raw_cal)

        wcs_resp = await self._request("GET", f"/wcs_file/{job_id}")
        wcs_text = wcs_resp.content.decode("ascii", errors="replace") if wcs_resp.is_success else ""
        return SolveResult(annotations=entries, wcs_text=wcs_text, calibration=calibration)
