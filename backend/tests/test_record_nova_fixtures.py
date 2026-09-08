"""The fixture recorder drives the real NovaSolver through a recording transport.

Replaying the committed fixtures through it must write the same fixture set back, which is
the guarantee that a fresh recording cannot drift from what the client actually sends.
"""

from __future__ import annotations

import asyncio
import json
from pathlib import Path

import httpx

from scripts.record_nova_fixtures import RecordingTransport, record
from tests.conftest import NOVA_FIXTURES, write_test_image
from tests.test_nova import BASE, KEY, Replay, happy_routes

HAND_WRITTEN = {"job_failure.json", "upload_bad_session.json"}


def test_replaying_fixtures_reproduces_them(tmp_path: Path) -> None:
    routes = happy_routes()
    routes["POST /api/login"] = ["login_bad_key.json", "login.json"]
    replay = Replay(routes)
    out = tmp_path / "out"
    image = write_test_image(tmp_path / "field.jpg", 6000, 4000)

    rc = asyncio.run(
        record(
            image,
            KEY,
            BASE,
            fixtures_dir=out,
            transport=httpx.MockTransport(replay),
            poll_seconds=0,
        )
    )
    assert rc == 0

    provenance = json.loads((out / "provenance.json").read_text())
    expected = json.loads((NOVA_FIXTURES / "provenance.json").read_text())
    assert provenance["recorded_files"] == expected["recorded_files"]
    assert provenance["solve_status"] == "success"
    assert provenance["nova_base_url"] == BASE
    assert provenance["solve_copy_scale"] == 2.0

    for name in expected["recorded_files"]:
        assert (out / name).read_bytes() == (NOVA_FIXTURES / name).read_bytes(), name
    assert {p.name for p in out.iterdir()} == set(expected["recorded_files"]) | {"provenance.json"}

    # every request the recorder made went through NovaSolver: the bad-key probe, the real
    # login, the upload, then polling and the result fetch
    paths = [r.url.path for r, _ in replay.requests]
    assert paths[:3] == ["/api/login", "/api/login", "/api/upload"]
    assert "/wcs_file/16837720" in paths


def test_login_scrubs_email_and_session(tmp_path: Path) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "status": "success",
                "message": "authenticated user: owner@example.com",
                "session": "real-session-token",
            },
        )

    transport = RecordingTransport(httpx.MockTransport(handler), tmp_path)

    async def go() -> httpx.Response:
        async with httpx.AsyncClient(transport=transport, base_url=BASE) as client:
            return await client.post("/api/login", data={"request-json": "{}"})

    resp = asyncio.run(go())
    assert resp.json()["session"] == "real-session-token"  # the client still gets the real one
    saved = (tmp_path / "login.json").read_text()
    assert "owner@example.com" not in saved
    assert "real-session-token" not in saved
    assert transport.recorded == ["login.json"]


def test_expired_session_reply_is_recorded_scrubbed(tmp_path: Path) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200, json={"status": "error", "errormessage": "no session with key: real-token"}
        )

    transport = RecordingTransport(httpx.MockTransport(handler), tmp_path)

    async def go() -> None:
        async with httpx.AsyncClient(transport=transport, base_url=BASE) as client:
            await client.post("/api/upload", data={"request-json": "{}"})

    asyncio.run(go())
    assert (tmp_path / "upload_bad_session.json").read_bytes() == (
        NOVA_FIXTURES / "upload_bad_session.json"
    ).read_bytes()


def test_unrecognised_and_failed_responses_are_not_saved(tmp_path: Path) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.startswith("/wcs_file/"):
            return httpx.Response(404, text="no such job")
        return httpx.Response(200, text="<html>home</html>")

    transport = RecordingTransport(httpx.MockTransport(handler), tmp_path)

    async def go() -> None:
        async with httpx.AsyncClient(transport=transport, base_url=BASE) as client:
            await client.get("/")
            await client.get("/wcs_file/1")

    asyncio.run(go())
    assert list(tmp_path.iterdir()) == []
    assert transport.recorded == []
