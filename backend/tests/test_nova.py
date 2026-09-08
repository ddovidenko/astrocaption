from __future__ import annotations

import asyncio
import json
from collections.abc import Callable
from pathlib import Path
from typing import Any

import httpx
import pytest

from app.solver import JobState, SolveRequest, SolverError, TransientSolverError
from app.solver.nova import BAD_KEY, NovaSolver, job_log_url, status_url
from tests.conftest import NOVA_FIXTURES, NOVA_NARROW_FIXTURES

Route = str | list[str] | dict[str, Any]  # fixture file, sequence of files, or inline JSON

BASE = "https://nova.example.test"
KEY = "super-secret-api-key"
SUBID = 16030035  # ids inside the recorded Orion fixtures
JOBID = 16837720
NARROW_SUBID = 16031943  # and the Pelican ones
NARROW_JOBID = 16840120


class Replay:
    """Serve fixture files per (method, path); lists are consumed in order."""

    def __init__(self, routes: dict[str, Route], fixtures_dir: Path = NOVA_FIXTURES) -> None:
        self.routes = {k: (list(v) if isinstance(v, list) else v) for k, v in routes.items()}
        self.fixtures_dir = fixtures_dir
        self.requests: list[tuple[httpx.Request, bytes]] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        body = request.read()
        self.requests.append((request, body))
        key = f"{request.method} {request.url.path}"
        entry = self.routes.get(key)
        if entry is None:
            return httpx.Response(404, text="not found")
        name: str | dict[str, Any]
        if isinstance(entry, list):
            name = entry.pop(0) if len(entry) > 1 else entry[0]
        else:
            name = entry
        if isinstance(name, dict):
            return httpx.Response(200, json=name)
        if name.startswith("status:"):
            return httpx.Response(int(name.split(":")[1]), text="<html>error</html>")
        if name == "raise":
            raise httpx.ConnectError("connection refused")
        path = self.fixtures_dir / name
        if name.endswith(".json"):
            return httpx.Response(200, json=json.loads(path.read_text()))
        return httpx.Response(200, content=path.read_bytes())


def make_solver(replay: Replay) -> NovaSolver:
    client = httpx.AsyncClient(transport=httpx.MockTransport(replay), base_url=BASE)
    return NovaSolver(KEY, client, BASE)


def run(coro: Any) -> Any:
    return asyncio.run(coro)


def happy_routes(subid: int = SUBID, jobid: int = JOBID) -> dict[str, Route]:
    return {
        "POST /api/login": "login.json",
        "POST /api/upload": "upload.json",
        f"GET /api/submissions/{subid}": [
            "submission_queued.json",
            "submission_pending.json",
            "submission_ready.json",
        ],
        f"GET /api/jobs/{jobid}": ["job_solving.json", "job_success.json"],
        f"GET /api/jobs/{jobid}/annotations/": "annotations.json",
        f"GET /api/jobs/{jobid}/info/": "job_info.json",
        f"GET /wcs_file/{jobid}": "wcs.fits",
    }


@pytest.mark.parametrize(
    ("fixtures_dir", "subid", "jobid", "n_annotations"),
    [
        pytest.param(NOVA_FIXTURES, SUBID, JOBID, 20, id="orion"),
        pytest.param(NOVA_NARROW_FIXTURES, NARROW_SUBID, NARROW_JOBID, 8, id="pelican"),
    ],
)
def test_full_flow_replays_fixtures(
    tmp_path: Path, fixtures_dir: Path, subid: int, jobid: int, n_annotations: int
) -> None:
    replay = Replay(happy_routes(subid, jobid), fixtures_dir)
    solver = make_solver(replay)
    image = tmp_path / "solve.jpg"
    image.write_bytes(b"\xff\xd8fakejpeg\xff\xd9")

    async def flow() -> Any:
        got_subid = await solver.submit(
            SolveRequest(image, scale_arcsec_per_px=1.94, scale_tolerance_pct=15)
        )
        assert got_subid == subid
        assert await solver.poll_submission(subid) is None  # queued
        assert await solver.poll_submission(subid) is None  # pending
        job = await solver.poll_submission(subid)
        assert job == jobid
        assert await solver.poll_job(job) == JobState.SOLVING
        assert await solver.poll_job(job) == JobState.SUCCESS
        return await solver.fetch_result(subid, job)

    result = run(flow())
    assert len(result.annotations) == n_annotations
    assert result.wcs_text.startswith("SIMPLE  =")
    expected_ra = json.loads((fixtures_dir / "job_info.json").read_text())["calibration"]["ra"]
    assert result.calibration is not None and result.calibration.ra == pytest.approx(expected_ra)

    login_req, login_body = replay.requests[0]
    assert login_req.url.path == "/api/login"
    assert json.loads(dict(httpx.QueryParams(login_body.decode()))["request-json"]) == {
        "apikey": KEY
    }

    upload_req, upload_body = replay.requests[1]
    assert upload_req.headers["content-type"].startswith("multipart/form-data")
    assert upload_body.index(b'name="request-json"') < upload_body.index(b'name="file"')
    start = upload_body.index(b"{", upload_body.index(b'name="request-json"'))
    params = json.loads(upload_body[start : upload_body.index(b"}", start) + 1])
    assert params["session"] == "3lzjzcyqcyaf9ykx2ka2m3ei4mpk9v6h"
    assert params["publicly_visible"] == "n"
    assert params["scale_units"] == "arcsecperpix"
    assert params["scale_type"] == "ev"
    assert params["scale_est"] == pytest.approx(1.94)
    assert params["scale_err"] == 15
    assert b"fakejpeg" in upload_body


def test_no_hints_means_no_scale_fields(tmp_path: Path) -> None:
    replay = Replay(happy_routes())
    image = tmp_path / "solve.jpg"
    image.write_bytes(b"x")
    run(make_solver(replay).submit(SolveRequest(image)))
    _, body = replay.requests[1]
    assert b"scale_units" not in body


def test_bad_api_key_is_reported_without_leaking_it(tmp_path: Path) -> None:
    replay = Replay({"POST /api/login": "login_bad_key.json"})
    image = tmp_path / "solve.jpg"
    image.write_bytes(b"x")
    with pytest.raises(SolverError) as excinfo:
        run(make_solver(replay).submit(SolveRequest(image)))
    assert str(excinfo.value) == BAD_KEY
    assert KEY not in str(excinfo.value)


def test_expired_session_triggers_one_relogin(tmp_path: Path) -> None:
    routes = happy_routes()
    routes["POST /api/upload"] = ["upload_bad_session.json", "upload.json"]
    replay = Replay(routes)
    image = tmp_path / "solve.jpg"
    image.write_bytes(b"x")
    assert run(make_solver(replay).submit(SolveRequest(image))) == SUBID
    paths = [r.url.path for r, _ in replay.requests]
    assert paths == ["/api/login", "/api/upload", "/api/login", "/api/upload"]


@pytest.mark.parametrize(
    ("route_value", "fragment", "transient"),
    [
        ("status:500", "HTTP 500", True),
        ("raise", "Could not reach", True),
        ("wcs.fits", "unexpected response", False),
    ],
)
def test_transport_failures_become_solver_errors(
    route_value: str, fragment: str, transient: bool
) -> None:
    replay = Replay({f"GET /api/jobs/{JOBID}": route_value})
    with pytest.raises(SolverError, match=fragment) as excinfo:
        run(make_solver(replay).poll_job(JOBID))
    assert isinstance(excinfo.value, TransientSolverError) is transient


def test_submission_finished_without_a_job_is_permanent() -> None:
    dead = {
        "processing_started": "2026-09-08 00:37:58.522033+00:00",
        "processing_finished": "2026-09-08 00:37:59.946128+00:00",
        "user_images": [],
        "images": [],
        "jobs": [],
        "job_calibrations": [],
        "user": 0,
    }
    replay = Replay({f"GET /api/submissions/{SUBID}": dead})
    with pytest.raises(SolverError, match="could not read the uploaded image") as excinfo:
        run(make_solver(replay).poll_submission(SUBID))
    assert not isinstance(excinfo.value, TransientSolverError)
    assert f"/status/{SUBID}" in str(excinfo.value)


def test_urls() -> None:
    assert status_url(BASE + "/", 5) == f"{BASE}/status/5"
    assert job_log_url(BASE, 6) == f"{BASE}/joblog/6"


def test_replay_never_hits_the_network() -> None:
    handler: Callable[[httpx.Request], httpx.Response] = Replay({})
    resp = handler(httpx.Request("GET", "https://nova.astrometry.net/api/jobs/1"))
    assert resp.status_code == 404
