"""Record real nova.astrometry.net responses into tests/fixtures/nova/.

Usage (from backend/):

    python scripts/record_nova_fixtures.py path/to/image.jpg [output-dir]

The output directory defaults to tests/fixtures/nova/ (the Orion set the tests replay); pass
another directory, e.g. tests/fixtures/nova-narrow/, to record a second field without
overwriting it.

The API key comes from NOVA_API_KEY, ASTROMETRY_API_KEY or data/config.json (the same lookup
the app uses). The image is downscaled exactly like the app does (≤ 3000 px solve copy) so the
recorded pixel coordinates match what the worker receives.

The recorder does not speak the nova protocol itself: it runs the app's own ``NovaSolver``
through a ``RecordingTransport`` that names, scrubs and writes every response on its way
back to the client. Whatever the client sends is what gets recorded, so the fixtures cannot
drift from the code that replays them. Session tokens, the account e-mail and the nova user
id are scrubbed before writing.

This is the only code path that talks to nova outside the app itself; the test suite runs it
against a replay of the committed fixtures only.
"""

from __future__ import annotations

import asyncio
import json
import re
import sys
import tempfile
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.config import load_settings
from app.solver import JobState, SolveRequest, SolverError
from app.solver.nova import NovaSolver, job_log_url, status_url
from app.storage import make_solve_copy

FIXTURES = Path(__file__).resolve().parent.parent / "tests" / "fixtures" / "nova"
FAKE_SESSION = "3lzjzcyqcyaf9ykx2ka2m3ei4mpk9v6h"
POLL_SECONDS = 5.0

_SUBMISSION = re.compile(r"^/api/submissions/\d+/?$")
_JOB = re.compile(r"^/api/jobs/\d+/?$")
_JOB_INFO = re.compile(r"^/api/jobs/\d+/info/?$")
_JOB_ANNOTATIONS = re.compile(r"^/api/jobs/\d+/annotations/?$")
_WCS = re.compile(r"^/wcs_file/\d+/?$")
_SESSION_IN_MESSAGE = re.compile(r"(no session with key: )\S+")


def _fixture_name(request: httpx.Request, payload: Any) -> str | None:
    """Which fixture file a response belongs to, or ``None`` if it is not one we keep."""
    path = request.url.path
    is_json = isinstance(payload, dict)
    if request.method == "POST" and path == "/api/login" and is_json:
        return "login.json" if payload.get("status") == "success" else "login_bad_key.json"
    if request.method == "POST" and path == "/api/upload" and is_json:
        if payload.get("status") == "success":
            return "upload.json"
        if "session" in str(payload.get("errormessage", "")).lower():
            return "upload_bad_session.json"
        return "upload_error.json"
    if request.method != "GET":
        return None
    if _SUBMISSION.match(path) and is_json:
        jobs = payload.get("jobs") or []
        if any(j is not None for j in jobs):
            return "submission_ready.json"
        return "submission_pending.json" if jobs else "submission_queued.json"
    if _JOB.match(path) and is_json:
        return {"success": "job_success.json", "failure": "job_failure.json"}.get(
            str(payload.get("status")), "job_solving.json"
        )
    if _JOB_INFO.match(path) and is_json:
        return "job_info.json"
    if _JOB_ANNOTATIONS.match(path) and is_json:
        return "annotations.json"
    if _WCS.match(path) and isinstance(payload, bytes):
        return "wcs.fits"
    return None


def _scrub(payload: Any) -> Any:
    """Strip the account e-mail, session tokens and the nova user id from a response body."""
    if not isinstance(payload, dict):
        return payload
    out = dict(payload)
    if "session" in out:
        out["session"] = FAKE_SESSION
    if str(out.get("message", "")).startswith("authenticated user:"):
        out["message"] = "authenticated user: "
    if "errormessage" in out:
        out["errormessage"] = _SESSION_IN_MESSAGE.sub(rf"\g<1>{FAKE_SESSION}", out["errormessage"])
    if "user" in out:
        out["user"] = 0
    return out


class RecordingTransport(httpx.AsyncBaseTransport):
    """Pass requests to ``inner`` and write each recognised response to ``fixtures_dir``.

    The first response of each kind wins, so a long poll records one ``job_solving.json``
    rather than dozens. The client receives the untouched response.
    """

    def __init__(self, inner: httpx.AsyncBaseTransport, fixtures_dir: Path) -> None:
        self._inner = inner
        self._dir = fixtures_dir
        self.recorded: list[str] = []

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        response = await self._inner.handle_async_request(request)
        content = await response.aread()
        if response.is_success:
            self._record(request, content)
        return httpx.Response(
            response.status_code,
            headers=response.headers,
            content=content,
            request=request,
        )

    async def aclose(self) -> None:
        await self._inner.aclose()

    def _record(self, request: httpx.Request, content: bytes) -> None:
        payload: Any
        try:
            payload = json.loads(content)
        except ValueError:
            payload = content
        name = _fixture_name(request, payload)
        if name is None or name in self.recorded:
            return
        self._dir.mkdir(parents=True, exist_ok=True)
        path = self._dir / name
        if isinstance(payload, bytes):
            path.write_bytes(payload)
        else:
            path.write_text(json.dumps(_scrub(payload), indent=1) + "\n", encoding="utf-8")
        self.recorded.append(name)
        print("wrote", path.name)


async def record(
    image: Path,
    api_key: str,
    base: str,
    *,
    fixtures_dir: Path = FIXTURES,
    transport: httpx.AsyncBaseTransport | None = None,
    poll_seconds: float = POLL_SECONDS,
) -> int:
    solve_copy = Path(tempfile.mkdtemp(prefix="astrocaption-record-")) / "solve.jpg"
    scale = make_solve_copy(image, solve_copy)
    print(f"solve copy {solve_copy} (scale {scale:.4f})")
    request = SolveRequest(solve_copy)

    recorder = RecordingTransport(transport or httpx.AsyncHTTPTransport(), fixtures_dir)
    timeout = httpx.Timeout(30.0, read=300.0, write=300.0)
    async with httpx.AsyncClient(transport=recorder, timeout=timeout) as client:
        try:
            await NovaSolver("not-a-real-key", client, base).submit(request)
        except SolverError:
            pass  # expected: this probe only records login_bad_key.json
        else:
            print("nova accepted a bogus API key; login_bad_key.json not recorded", file=sys.stderr)

        solver = NovaSolver(api_key, client, base)
        subid = await solver.submit(request)
        print(f"submission {subid}: {status_url(base, subid)}")

        job = await solver.poll_submission(subid)
        while job is None:
            await asyncio.sleep(poll_seconds)
            job = await solver.poll_submission(subid)
        print(f"job {job}: {job_log_url(base, job)}")

        state = await solver.poll_job(job)
        while state == JobState.SOLVING:
            await asyncio.sleep(poll_seconds)
            state = await solver.poll_job(job)
        if state == JobState.SUCCESS:
            await solver.fetch_result(subid, job)

    if "wcs.fits" not in recorder.recorded and state == JobState.SUCCESS:
        print("wcs_file was not recorded", file=sys.stderr)
    provenance = {
        "recorded_at": datetime.now(UTC).replace(microsecond=0).isoformat(),
        "nova_base_url": base,
        "solve_copy_scale": scale,
        "solve_status": state.value,
        "recorded_files": sorted(recorder.recorded),
    }
    (fixtures_dir / "provenance.json").write_text(
        json.dumps(provenance, indent=1) + "\n", encoding="utf-8"
    )
    print("wrote provenance.json")
    return 0 if state == JobState.SUCCESS else 1


def main(argv: list[str]) -> int:
    if len(argv) not in (2, 3):
        print(__doc__)
        return 2
    settings = load_settings()
    if not settings.nova_api_key:
        print(
            "No API key: set NOVA_API_KEY / ASTROMETRY_API_KEY or data/config.json", file=sys.stderr
        )
        return 2
    out = Path(argv[2]) if len(argv) == 3 else FIXTURES
    return asyncio.run(
        record(Path(argv[1]), settings.nova_api_key, settings.nova_base_url, fixtures_dir=out)
    )


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
