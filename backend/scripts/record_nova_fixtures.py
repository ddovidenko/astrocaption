"""Record real nova.astrometry.net responses into tests/fixtures/nova/.

Usage (from backend/):

    python scripts/record_nova_fixtures.py path/to/image.jpg

The API key comes from NOVA_API_KEY, ASTROMETRY_API_KEY or data/config.json (the same lookup
the app uses). The image is downscaled exactly like the app does (≤ 3000 px solve copy) so the
recorded pixel coordinates match what the worker receives, and the upload is marked not
publicly visible on nova. Session tokens and the nova user id are scrubbed before writing.

This is the only code path that talks to nova outside the app itself; the test suite never
runs it.
"""

from __future__ import annotations

import asyncio
import json
import sys
import tempfile
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.config import load_settings
from app.storage import make_solve_copy

FIXTURES = Path(__file__).resolve().parent.parent / "tests" / "fixtures" / "nova"
FAKE_SESSION = "3lzjzcyqcyaf9ykx2ka2m3ei4mpk9v6h"
POLL_SECONDS = 5


def _save(name: str, payload: Any) -> None:
    path = FIXTURES / name
    if isinstance(payload, bytes | bytearray):
        path.write_bytes(payload)
    else:
        path.write_text(json.dumps(payload, indent=1) + "\n", encoding="utf-8")
    print("wrote", path.name)


async def record(image: Path, api_key: str, base: str) -> int:
    solve_copy = Path(tempfile.mkdtemp(prefix="astrocaption-record-")) / "solve.jpg"
    scale = make_solve_copy(image, solve_copy)
    print(f"solve copy {solve_copy} (scale {scale:.4f})")
    recorded: list[str] = []

    timeout = httpx.Timeout(30.0, read=300.0, write=300.0)
    async with httpx.AsyncClient(timeout=timeout) as c:
        bad = await c.post(
            f"{base}/api/login", data={"request-json": json.dumps({"apikey": "not-a-real-key"})}
        )
        _save("login_bad_key.json", bad.json())
        recorded.append("login_bad_key.json")

        login = (
            await c.post(
                f"{base}/api/login", data={"request-json": json.dumps({"apikey": api_key})}
            )
        ).json()
        # nova echoes the account e-mail in "message"; never write it to the repo
        _save("login.json", {**login, "message": "authenticated user: ", "session": FAKE_SESSION})
        recorded.append("login.json")
        if login.get("status") != "success":
            print("login failed:", login.get("errormessage"), file=sys.stderr)
            return 1

        params = {
            "session": login["session"],
            "publicly_visible": "n",
            "allow_modifications": "d",
            "allow_commercial_use": "d",
        }
        with solve_copy.open("rb") as fh:
            upload = (
                await c.post(
                    f"{base}/api/upload",
                    data={"request-json": json.dumps(params)},
                    files={"file": (solve_copy.name, fh, "image/jpeg")},
                )
            ).json()
        _save("upload.json", upload)
        recorded.append("upload.json")
        if upload.get("status") != "success":
            print("upload failed:", upload.get("errormessage"), file=sys.stderr)
            return 1
        subid = upload["subid"]
        print(f"submission {subid}: {base}/status/{subid}")

        job: int | None = None
        seen: set[str] = set()
        while job is None:
            sub = {**(await c.get(f"{base}/api/submissions/{subid}")).json(), "user": 0}
            jobs = [j for j in sub.get("jobs", []) if j is not None]
            if jobs:
                name = "submission_ready.json"
                job = int(jobs[0])
            else:
                name = "submission_pending.json" if sub.get("jobs") else "submission_queued.json"
            if name not in seen:
                _save(name, sub)
                recorded.append(name)
                seen.add(name)
            if job is None:
                await asyncio.sleep(POLL_SECONDS)
        print(f"job {job}: {base}/joblog/{job}")

        while True:
            st = (await c.get(f"{base}/api/jobs/{job}")).json()
            status = st.get("status")
            name = {"success": "job_success.json", "failure": "job_failure.json"}.get(
                status, "job_solving.json"
            )
            if name not in seen:
                _save(name, st)
                recorded.append(name)
                seen.add(name)
            if status in ("success", "failure"):
                break
            await asyncio.sleep(POLL_SECONDS)

        _save("job_info.json", (await c.get(f"{base}/api/jobs/{job}/info/")).json())
        _save("annotations.json", (await c.get(f"{base}/api/jobs/{job}/annotations/")).json())
        wcs = await c.get(f"{base}/wcs_file/{job}")
        if wcs.is_success:
            _save("wcs.fits", wcs.content)
            recorded.append("wcs.fits")
        else:
            print(f"wcs_file returned HTTP {wcs.status_code}", file=sys.stderr)
        recorded += ["job_info.json", "annotations.json"]
        _save(
            "provenance.json",
            {
                "recorded_at": datetime.now(UTC).replace(microsecond=0).isoformat(),
                "nova_base_url": base,
                "solve_copy_scale": scale,
                "solve_status": status,
                "recorded_files": sorted(set(recorded)),
            },
        )
    return 0 if status == "success" else 1


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print(__doc__)
        return 2
    settings = load_settings()
    if not settings.nova_api_key:
        print(
            "No API key: set NOVA_API_KEY / ASTROMETRY_API_KEY or data/config.json", file=sys.stderr
        )
        return 2
    return asyncio.run(record(Path(argv[1]), settings.nova_api_key, settings.nova_base_url))


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
