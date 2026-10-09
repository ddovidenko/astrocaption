"""Chunked uploads (#166): POST /api/uploads, PUT chunks, finish, delete, and the sweeps."""

from __future__ import annotations

import hashlib
import os
import time
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from app.config import Settings

from .conftest import FakeSolver, login, make_client, make_settings

CHUNK = 1024 * 1024


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def noisy_png(tmp_path: Path) -> Path:
    """Over 3 MB: four chunks at the 1 MB chunk size the tests run with."""
    noisy = tmp_path / "noise.png"
    Image.frombytes("RGB", (1200, 900), os.urandom(1200 * 900 * 3)).save(noisy)
    assert noisy.stat().st_size > 3 * CHUNK
    return noisy


@pytest.fixture
def chunky(tmp_path: Path) -> Settings:
    return make_settings(tmp_path, upload_chunk_mb=1)


@pytest.fixture
def client(chunky: Settings, fake_solver: FakeSolver) -> Iterator[TestClient]:
    with make_client(chunky, lambda: fake_solver) as c:
        login(c)
        yield c


def open_session(client: TestClient, path: Path, title: str | None = None) -> dict[str, Any]:
    resp = client.post(
        "/api/uploads", json={"name": path.name, "size": path.stat().st_size, "title": title}
    )
    assert resp.status_code == 201, resp.text
    body: dict[str, Any] = resp.json()
    return body


def chunks_of(path: Path, size: int) -> list[bytes]:
    data = path.read_bytes()
    return [data[i : i + size] for i in range(0, len(data), size)]


def test_chunked_upload_ends_in_the_same_image_as_a_single_shot_one(
    client: TestClient, chunky: Settings, tmp_path: Path
) -> None:
    noisy = noisy_png(tmp_path)
    session = open_session(client, noisy, title="Noise")
    parts = chunks_of(noisy, session["chunk_bytes"])
    assert session["chunks"] == len(parts) == 4
    for n, part in enumerate(parts):
        resp = client.put(f"/api/uploads/{session['id']}/{n}", content=part)
        assert resp.status_code == 204, resp.text
    # Sending a chunk again replaces it: that is what a retry does.
    assert client.put(f"/api/uploads/{session['id']}/1", content=parts[1]).status_code == 204

    resp = client.post(f"/api/uploads/{session['id']}/finish")
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert (body["title"], body["original_name"], body["width"]) == ("Noise", "noise.png", 1200)
    assert body["solve_status"] in ("pending", "solving", "solved")
    folder = chunky.uploads_dir / body["id"]
    assert sha256(folder / "original.png") == sha256(noisy)
    assert (folder / "preview.jpg").is_file()
    assert not (chunky.partial_uploads_dir / session["id"]).exists()
    listed = client.get("/api/images").json()["items"]
    assert [i["id"] for i in listed] == [body["id"]]
    # Finishing twice is a session that no longer exists, not a second image.
    assert client.post(f"/api/uploads/{session['id']}/finish").status_code == 404


def test_open_refuses_before_any_byte_moves(client: TestClient, chunky: Settings) -> None:
    resp = client.post("/api/uploads", json={"name": "cube.fits", "size": 10})
    assert resp.status_code == 415
    assert resp.json()["detail"] == "Unsupported file type. Upload a JPG, PNG or TIFF."
    resp = client.post("/api/uploads", json={"name": "big.jpg", "size": 6 * CHUNK})
    assert resp.status_code == 413
    assert resp.json()["detail"] == "File is larger than the 5 MB upload limit."
    assert client.post("/api/uploads", json={"name": "big.jpg", "size": 0}).status_code == 422
    assert (
        not any(chunky.partial_uploads_dir.glob("*"))
        if chunky.partial_uploads_dir.exists()
        else True
    )


def test_chunks_are_checked_against_what_the_session_declared(
    client: TestClient, tmp_path: Path
) -> None:
    noisy = noisy_png(tmp_path)
    session = open_session(client, noisy)
    parts = chunks_of(noisy, CHUNK)
    sid = session["id"]
    gone = "That upload is no longer open; start it again."
    incomplete = "The upload is incomplete; start it again."
    # Out of range, oversized (declared and streamed), and short chunks.
    assert client.put(f"/api/uploads/{sid}/{len(parts)}", content=parts[0]).status_code == 422
    resp = client.put(f"/api/uploads/{sid}/0", content=parts[0] + b"x")
    assert resp.status_code == 413
    assert (
        resp.json()["detail"] == "The upload sent a larger chunk than it declared; start it again."
    )
    resp = client.put(f"/api/uploads/{sid}/0", content=parts[0][:-1])
    assert resp.status_code == 422
    assert resp.json()["detail"] == incomplete
    # Finishing with a chunk missing: nothing is assembled and the session stays open.
    for n, part in enumerate(parts[:-1]):
        assert client.put(f"/api/uploads/{sid}/{n}", content=part).status_code == 204
    resp = client.post(f"/api/uploads/{sid}/finish")
    assert resp.status_code == 409
    assert resp.json()["detail"] == incomplete
    assert client.get("/api/images").json()["items"] == []
    # Unknown and malformed ids, then a cancelled session, all read as gone.
    unknown = "00000000-0000-0000-0000-000000000000"
    assert client.put(f"/api/uploads/{unknown}/0", content=parts[0]).status_code == 404
    assert client.post(f"/api/uploads/{unknown}/finish").json()["detail"] == gone
    assert client.post("/api/uploads/../etc/finish").status_code == 404
    assert client.delete(f"/api/uploads/{sid}").status_code == 204
    assert client.delete(f"/api/uploads/{sid}").status_code == 204
    assert client.put(f"/api/uploads/{sid}/0", content=parts[0]).status_code == 404


def test_sessions_are_owner_only(chunky: Settings, fake_solver: FakeSolver) -> None:
    with make_client(chunky, lambda: fake_solver) as anon:
        assert anon.post("/api/uploads", json={"name": "a.jpg", "size": 1}).status_code == 401
        assert anon.put("/api/uploads/x/0", content=b"x").status_code == 401


def test_startup_and_new_sessions_sweep_abandoned_ones(
    tmp_path: Path, fake_solver: FakeSolver
) -> None:
    settings = make_settings(tmp_path, upload_chunk_mb=1)
    leftover = settings.partial_uploads_dir / "11111111-1111-1111-1111-111111111111"
    leftover.mkdir(parents=True)
    (leftover / "000000.part").write_bytes(b"x")
    with make_client(settings, lambda: fake_solver) as client:
        assert not leftover.exists()  # startup: nothing resumes across a restart
        login(client)
        stale = settings.partial_uploads_dir / "22222222-2222-2222-2222-222222222222"
        fresh = settings.partial_uploads_dir / "33333333-3333-3333-3333-333333333333"
        for d in (stale, fresh):
            d.mkdir(parents=True)
        old = time.time() - 25 * 3600
        os.utime(stale, (old, old))
        assert client.post("/api/uploads", json={"name": "a.jpg", "size": 1}).status_code == 201
        assert not stale.exists()
        assert fresh.exists()
