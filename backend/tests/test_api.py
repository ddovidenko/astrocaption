from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
from collections.abc import Iterator
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from PIL import Image
from starlette.requests import Request

from app.config import CONFIG_FIX_HINT, Settings
from app.db import Database
from app.fonts import FontNotFoundError, load_font
from app.layout import SIZE_RELATIVE
from app.main import create_app, font_not_found_error
from app.models import MAX_FONT_SIZE, MIN_FONT_SIZE, StyleConfig
from tests.conftest import (
    FONTS_DIR,
    NOVA_NARROW_FIXTURES,
    TEST_PASSWORD_HASH,
    FakeSolver,
    load_fixture,
    login,
    make_client,
    make_settings,
    nova_result,
    upload,
    wait_for_status,
    write_test_image,
)


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def test_health_and_fonts(client: TestClient) -> None:
    health = client.get("/api/health").json()
    assert health == {
        "status": "ok",
        "version": health["version"],
        "site_title": "Test Site",
        "setup_required": False,
        "authenticated": True,
        "config_error": None,
        "locked": [],
    }
    config = client.get("/api/config").json()
    style_defaults = StyleConfig().model_dump(exclude=set(SIZE_RELATIVE))
    assert config == {
        "site_title": "Test Site",
        "max_upload_mb": 5,
        "nova_api_key_set": False,
        "default_style": {},
        "locked": [],
        "locked_by": {},
        "style_defaults": style_defaults,
    }
    fonts = client.get("/api/fonts").json()
    assert len(fonts) == 24
    inter = next(f for f in fonts if f["file"] == "Inter-Regular.ttf")
    assert (inter["family"], inter["weight"], inter["sample"]) == ("Inter", "Regular", "NGC 1976")
    assert len(inter["ascents"]) == MAX_FONT_SIZE - MIN_FONT_SIZE + 1
    at_24 = load_font(FONTS_DIR, "Inter-Regular.ttf", 24).getmetrics()[0]
    assert inter["ascents"][24 - MIN_FONT_SIZE] == at_24
    font = client.get("/fonts/Inter-Regular.ttf")
    assert font.status_code == 200 and font.headers["content-type"] == "font/ttf"


def test_font_list_skips_a_file_it_cannot_read(
    tmp_path: Path, settings: Settings, caplog: pytest.LogCaptureFixture
) -> None:
    """One junk .ttf in the fonts directory must not cost the config page its whole list."""
    from app.fonts import list_fonts

    fonts_dir = tmp_path / "fonts"
    fonts_dir.mkdir()
    (fonts_dir / "Junk-Regular.ttf").write_bytes(b"not a font at all")
    (fonts_dir / "Inter-Regular.ttf").write_bytes(
        (settings.fonts_dir / "Inter-Regular.ttf").read_bytes()
    )
    with caplog.at_level(logging.WARNING, logger="app.fonts"):
        fonts = list_fonts(fonts_dir)
    assert [f.file for f in fonts] == ["Inter-Regular.ttf"]
    assert "skipping unreadable font Junk-Regular.ttf" in caplog.text


def test_upload_stores_original_untouched_with_derivatives(
    client: TestClient, settings: Settings, sample_jpeg: Path
) -> None:
    body = upload(client, sample_jpeg, title="Orion")
    assert (body["title"], body["width"], body["height"]) == ("Orion", 3000, 2000)
    assert body["solve_status"] in ("pending", "solving", "solved")
    folder = settings.uploads_dir / body["id"]
    assert sha256(folder / "original.jpg") == sha256(sample_jpeg)
    with Image.open(folder / "preview.jpg") as p:
        assert p.size == (2048, 1365)
    with Image.open(folder / "thumb.jpg") as t:
        assert max(t.size) == 400
    assert client.get(body["preview_url"]).headers["content-type"] == "image/jpeg"
    assert client.get(body["thumb_url"]).status_code == 200
    assert client.get(body["original_url"]).headers["content-type"] == "image/jpeg"
    assert client.get(f"/api/images/{body['id']}/files/annotated-preview").status_code == 404
    listed = client.get("/api/images").json()
    assert [i["id"] for i in listed] == [body["id"]]


def test_upload_title_defaults_to_filename(client: TestClient, sample_jpeg: Path) -> None:
    assert upload(client, sample_jpeg)["title"] == "orion"


def test_upload_rejections(client: TestClient, settings: Settings, tmp_path: Path) -> None:
    bad = tmp_path / "notes.txt"
    bad.write_text("hello")
    with bad.open("rb") as fh:
        assert (
            client.post("/api/images", files={"file": ("notes.txt", fh, "text/plain")}).status_code
            == 415
        )
    fake = tmp_path / "fake.jpg"
    fake.write_bytes(b"definitely not a jpeg")
    with fake.open("rb") as fh:
        resp = client.post("/api/images", files={"file": ("fake.jpg", fh, "image/jpeg")})
    assert resp.status_code == 415
    assert list(settings.uploads_dir.iterdir()) == []


def _noisy_png(tmp_path: Path) -> Path:
    noisy = tmp_path / "noise.png"
    Image.frombytes("RGB", (1200, 900), os.urandom(1200 * 900 * 3)).save(noisy)
    assert noisy.stat().st_size > 1024 * 1024
    return noisy


def test_upload_too_large_is_refused_before_the_body_is_read(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    settings = make_settings(tmp_path, max_upload_mb=1)
    noisy = _noisy_png(tmp_path)

    def body_was_read(*args: object) -> int:
        raise AssertionError("the upload body was spooled before the size check")

    monkeypatch.setattr("app.api.images._copy_limited", body_was_read)
    with make_client(settings, lambda: None) as client, noisy.open("rb") as fh:
        login(client)
        resp = client.post("/api/images", files={"file": ("noise.png", fh, "image/png")})
    assert resp.status_code == 413
    assert resp.json() == {"detail": "File is larger than the 1 MB upload limit."}
    assert list(settings.uploads_dir.iterdir()) == []


def test_anonymous_upload_is_refused_before_the_body_is_parsed(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Not signed in comes before too large: an anonymous caller must not get their body
    spooled, nor learn the site's upload limit from a 413."""
    settings = make_settings(tmp_path, max_upload_mb=1)
    noisy = _noisy_png(tmp_path)

    def body_was_read(*args: object) -> int:
        raise AssertionError("an anonymous upload body was spooled")

    monkeypatch.setattr("app.api.images._copy_limited", body_was_read)
    with make_client(settings, lambda: None) as client, noisy.open("rb") as fh:
        resp = client.post("/api/images", files={"file": ("noise.png", fh, "image/png")})
    assert resp.status_code == 401
    assert resp.headers["content-type"] == "application/json"
    assert resp.json() == {"detail": "Sign in to continue."}
    assert list(settings.uploads_dir.iterdir()) == []


def test_anonymous_oversized_upload_is_a_401_not_a_413(
    anon_client: TestClient, client: TestClient
) -> None:
    headers = {
        "content-length": str(50 * 1024 * 1024),
        "content-type": "multipart/form-data; boundary=astrocaption",
    }
    resp = anon_client.post("/api/images", content=b"x", headers=headers)
    assert resp.status_code == 401 and resp.json() == {"detail": "Sign in to continue."}
    assert "MB" not in resp.text  # the upload limit is not public
    # The same declared length from the owner still trips the size guard, which is what
    # proves the header reached the middleware in the anonymous case above.
    assert client.post("/api/images", content=b"x", headers=headers).status_code == 413


def test_upload_too_large_without_content_length_is_refused_after_the_cap(
    tmp_path: Path,
) -> None:
    """A chunked upload carries no Content-Length; the streaming cap is the backstop."""
    settings = make_settings(tmp_path, max_upload_mb=1)
    noisy = _noisy_png(tmp_path)
    boundary = b"astrocaption-test-boundary"
    head = (
        b"--" + boundary + b"\r\n"
        b'Content-Disposition: form-data; name="file"; filename="noise.png"\r\n'
        b"Content-Type: image/png\r\n\r\n"
    )
    tail = b"\r\n--" + boundary + b"--\r\n"

    def chunks() -> Iterator[bytes]:
        yield head
        with noisy.open("rb") as fh:
            while chunk := fh.read(65536):
                yield chunk
        yield tail

    with make_client(settings, lambda: None) as client:
        login(client)
        resp = client.post(
            "/api/images",
            content=chunks(),
            headers={"content-type": f"multipart/form-data; boundary={boundary.decode()}"},
        )
    assert "content-length" not in resp.request.headers
    assert resp.status_code == 413
    assert list(settings.uploads_dir.iterdir()) == []


def test_content_length_precheck_only_guards_the_upload_route(client: TestClient) -> None:
    resp = client.get("/api/images", headers={"content-length": str(10**12)})
    assert resp.status_code == 200


def test_narrow_field_hides_hd_stars_but_lists_them(tmp_path: Path) -> None:
    settings = make_settings(tmp_path)
    pelican = write_test_image(tmp_path / "pelican.jpg", 2160, 2880)
    solver = FakeSolver(nova_result(NOVA_NARROW_FIXTURES))
    with make_client(settings, lambda: solver) as client:
        login(client)
        image_id = upload(client, pelican)["id"]
        solved = wait_for_status(client, image_id, {"solved", "failed"})
        assert solved["solve_status"] == "solved", solved["solve_error"]
        assert solved["object_count"] == 8
        assert solved["calibration"]["radius"] == pytest.approx(0.9965, abs=1e-3)

        objects = client.get(f"/api/images/{image_id}/objects").json()
        by_type: dict[str, list[str]] = {}
        for o in objects:
            by_type.setdefault(o["type"], []).append(o["primary_name"])
        assert by_type["ic"] == ["IC 5070"]
        assert sorted(by_type["bright"]) == ["56 Cyg", "57 Cyg"]
        assert len(by_type["hd"]) == 5 and all(n.startswith("HD ") for n in by_type["hd"])

        labels = client.get(f"/api/images/{image_id}/annotations").json()["labels"]
        enabled = {lab["object_id"] for lab in labels if lab["enabled"]}
        assert enabled == {o["id"] for o in objects if o["type"] != "hd"}


def test_solve_objects_annotations_and_export(
    client: TestClient, settings: Settings, sample_jpeg: Path
) -> None:
    body = upload(client, sample_jpeg, title="Orion Belt")
    image_id = body["id"]
    solved = wait_for_status(client, image_id, {"solved", "failed"})
    assert solved["solve_status"] == "solved", solved["solve_error"]
    assert solved["object_count"] == 20
    assert solved["nova_status_url"] == "https://nova.example.test/status/12345678"
    assert solved["nova_job_log_url"] == "https://nova.example.test/joblog/7654321"
    assert solved["calibration"]["ra"] == load_fixture("job_info.json")["calibration"]["ra"]

    objects = client.get(f"/api/images/{image_id}/objects").json()
    assert len(objects) == 20
    m42 = objects[0]
    assert (m42["primary_name"], m42["catalog_names"]) == (
        "M 42",
        ["NGC 1976", "M 42", "LBN 974", "Great Orion Nebula", "Orion Nebula"],
    )
    assert {o["primary_name"] for o in objects} >= {"Hatysa", "Trapezium", "θ1 Ori C", "M 43"}

    ann = client.get(f"/api/images/{image_id}/annotations").json()
    assert ann["image_id"] == image_id and ann["version"] == 1
    # 8 bright stars + 9 objects with a known radius above 0.4 % of the width + IC 427 and
    # IC 428, which nova reports with radius 0 ("no size known", #9)
    assert sum(lab["enabled"] for lab in ann["labels"]) == 19
    assert ann["style"]["font_file"] == "Inter-Regular.ttf"

    original = settings.data_dir / "uploads" / image_id / "original.jpg"
    before = sha256(original)
    resp = client.post(f"/api/images/{image_id}/export", json={"quality": 92, "scale": 1.0})
    assert resp.status_code == 200, resp.text
    exported = resp.json()
    assert (exported["width"], exported["height"]) == (3000, 2000) and exported["bytes"] > 0
    assert exported["encoding"] == "quality 92, 4:4:4, progressive"
    matched = client.post(f"/api/images/{image_id}/export", json={}).json()
    assert matched["encoding"].startswith("matched original JPEG tables")
    assert solved["original_format"] == "JPEG"
    assert sha256(original) == before

    download = client.get(f"/api/images/{image_id}/export")
    assert download.status_code == 200
    assert download.headers["content-type"] == "image/jpeg"
    assert 'filename="Orion-Belt-annotated.jpg"' in download.headers["content-disposition"]
    with Image.open(settings.renders_dir / image_id / "annotated.jpg") as img:
        assert img.size == (3000, 2000)
    preview = client.get(exported["annotated_preview_url"])
    assert preview.status_code == 200
    with Image.open(settings.renders_dir / image_id / "annotated_preview.jpg") as img:
        assert img.size == (2048, 1365)

    half = client.post(f"/api/images/{image_id}/export", json={"scale": 0.5}).json()
    assert (half["width"], half["height"]) == (1500, 1000)
    after = client.get(f"/api/images/{image_id}").json()
    assert after["exported_at"] and after["export_url"].startswith(
        f"/api/images/{image_id}/export?v="
    )


def test_export_and_annotations_survive_a_dropped_font(
    client: TestClient, settings: Settings, sample_jpeg: Path
) -> None:
    """A stored style can outlive the bundle (a family dropped in an upgrade, issue #59)."""
    body = upload(client, sample_jpeg)
    image_id = body["id"]
    solved = wait_for_status(client, image_id, {"solved", "failed"})
    assert solved["solve_status"] == "solved", solved["solve_error"]

    db = Database(settings.db_path)
    ann = db.get_annotations(image_id)
    assert ann is not None
    gone = ann.model_copy(
        update={"style": ann.style.model_copy(update={"font_file": "Lato-Regular.ttf"})}
    )
    db.save_annotations(gone)

    fetched = client.get(f"/api/images/{image_id}/annotations").json()
    assert fetched["style"]["font_file"] == "Inter-Regular.ttf"

    resp = client.post(f"/api/images/{image_id}/export", json={})
    assert resp.status_code == 200, resp.text

    stored = db.get_annotations(image_id)
    assert stored is not None and stored.style.font_file == "Lato-Regular.ttf"


def test_font_not_found_error_is_a_plain_500(caplog: pytest.LogCaptureFixture) -> None:
    """If the fonts directory is missing even the built-in default, ``load_font`` raises
    ``FontNotFoundError`` out of ``export_image`` (issue #59); the handler must turn that
    into plain language rather than a bare 500, and never name a path -- only the file."""
    request = Request({"type": "http"})
    with caplog.at_level("ERROR"):
        response = asyncio.run(
            font_not_found_error(request, FontNotFoundError("Inter-Regular.ttf"))
        )
    assert response.status_code == 500
    body = json.loads(bytes(response.body))
    assert body == {
        "detail": (
            "The server's font bundle is incomplete: Inter-Regular.ttf is missing from the "
            "fonts directory. Restore the bundled fonts and restart."
        )
    }
    assert "/" not in body["detail"]
    assert any("Inter-Regular.ttf" in r.message and r.levelname == "ERROR" for r in caplog.records)


def test_export_and_resolve_conflict_while_solving(tmp_path: Path, sample_jpeg: Path) -> None:
    settings = make_settings(tmp_path)
    stuck = FakeSolver(submission_polls=10**9)
    with make_client(settings, lambda: stuck) as client:
        login(client)
        body = upload(client, sample_jpeg)
        image_id = body["id"]
        assert client.post(f"/api/images/{image_id}/export").status_code == 409
        assert client.get(f"/api/images/{image_id}/export").status_code == 404
        assert client.get(f"/api/images/{image_id}/annotations").status_code == 404
        assert client.get(f"/api/images/{image_id}/objects").json() == []
        assert client.post(f"/api/images/{image_id}/solve").status_code == 409


def test_failed_solve_then_resolve_with_hints(tmp_path: Path, sample_jpeg: Path) -> None:
    settings = make_settings(tmp_path)
    solver = FakeSolver(fail=True)
    with make_client(settings, lambda: solver) as client:
        login(client)
        body = upload(client, sample_jpeg)
        failed = wait_for_status(client, body["id"], {"solved", "failed"})
        assert failed["solve_status"] == "failed"
        assert "could not solve" in failed["solve_error"]
        assert failed["nova_status_url"] and failed["nova_job_log_url"]

        solver.fail = False
        resp = client.post(
            f"/api/images/{body['id']}/solve", json={"focal_length_mm": 400, "pixel_size_um": 3.76}
        )
        assert resp.status_code == 200 and resp.json()["solve_status"] == "pending"
        solved = wait_for_status(client, body["id"], {"solved", "failed"})
        assert solved["solve_status"] == "solved" and solved["solve_error"] is None
        assert solver.requests[-1].scale_arcsec_per_px is not None
        assert abs(solver.requests[-1].scale_arcsec_per_px - 206.265 * 3.76 / 400) < 1e-9


def test_missing_key_gives_guidance(tmp_path: Path, sample_jpeg: Path) -> None:
    settings = make_settings(tmp_path)
    with make_client(settings, lambda: None) as client:
        login(client)
        body = upload(client, sample_jpeg)
        failed = wait_for_status(client, body["id"], {"solved", "failed"})
        assert failed["solve_status"] == "failed" and "NOVA_API_KEY" in failed["solve_error"]


def test_delete_removes_row_and_files(
    client: TestClient, settings: Settings, sample_jpeg: Path
) -> None:
    body = upload(client, sample_jpeg)
    wait_for_status(client, body["id"], {"solved", "failed"})
    client.post(f"/api/images/{body['id']}/export")
    assert client.delete(f"/api/images/{body['id']}").status_code == 204
    assert client.get(f"/api/images/{body['id']}").status_code == 404
    assert client.delete(f"/api/images/{body['id']}").status_code == 404
    assert not (settings.uploads_dir / body["id"]).exists()
    assert not (settings.renders_dir / body["id"]).exists()


def test_unknown_image_404(client: TestClient) -> None:
    assert client.get("/api/images/nope").status_code == 404
    assert client.get("/api/images/nope/files/preview").status_code == 404
    assert client.post("/api/images/nope/solve").status_code == 404


def test_spa_is_served_when_built(tmp_path: Path) -> None:
    static = tmp_path / "static"
    (static / "assets").mkdir(parents=True)
    (static / "index.html").write_text("<html>spa</html>")
    (static / "assets" / "app.js").write_text("console.log(1)")
    settings = make_settings(tmp_path, static_dir=static)
    with make_client(settings, lambda: None) as client:
        assert client.get("/").text == "<html>spa</html>"
        assert client.get("/some/client/route").text == "<html>spa</html>"
        assert client.get("/assets/app.js").text == "console.log(1)"
        assert client.get("/api/does-not-exist").status_code == 404


def test_png_upload_is_accepted(client: TestClient, tmp_path: Path) -> None:
    png = write_test_image(tmp_path / "field.png", 800, 600, fmt="PNG")
    body = upload(client, png)
    assert body["original_name"] == "field.png"
    assert body["original_format"] == "PNG"
    assert client.get(body["original_url"]).headers["content-type"] == "image/png"


def test_png_named_jpg_is_stored_by_content(
    client: TestClient, settings: Settings, tmp_path: Path
) -> None:
    disguised = write_test_image(tmp_path / "disguised.jpg", 100, 80, fmt="PNG")
    body = upload(client, disguised)
    assert body["original_format"] == "PNG"
    assert (settings.uploads_dir / body["id"] / "original.png").is_file()
    assert not (settings.uploads_dir / body["id"] / "original.upload").exists()
    assert client.get(body["original_url"]).headers["content-type"] == "image/png"


def test_resolve_persists_hints_on_the_row(
    client: TestClient, settings: Settings, sample_jpeg: Path
) -> None:
    body = upload(client, sample_jpeg)
    wait_for_status(client, body["id"], {"solved", "failed"})
    resp = client.post(
        f"/api/images/{body['id']}/solve", json={"focal_length_mm": 400, "pixel_size_um": 3.76}
    )
    assert resp.status_code == 200
    row = Database(settings.db_path).get_image(body["id"])
    assert row is not None and row.solve_hints is not None
    assert row.solve_hints.focal_length_mm == 400
    assert wait_for_status(client, body["id"], {"solved", "failed"})["solve_status"] == "solved"


def test_health_reflects_a_key_added_after_start(env_client: tuple[TestClient, Path]) -> None:
    client, data_dir = env_client
    assert client.get("/api/health").json()["setup_required"] is True
    assert client.get("/api/config").status_code == 401
    (data_dir / "config.json").write_text(
        json.dumps({"password_hash": TEST_PASSWORD_HASH, "session_secret": "s"})
    )
    assert client.get("/api/health").json()["setup_required"] is False
    login(client)
    assert client.get("/api/config").json()["nova_api_key_set"] is False
    (data_dir / "config.json").write_text(
        json.dumps(
            {"password_hash": TEST_PASSWORD_HASH, "session_secret": "s", "nova_api_key": "k"}
        )
    )
    assert client.get("/api/config").json()["nova_api_key_set"] is True


def test_truncated_jpeg_is_rejected_cleanly(
    client: TestClient, settings: Settings, tmp_path: Path
) -> None:
    whole = write_test_image(tmp_path / "whole.jpg", 1200, 800)
    truncated = tmp_path / "cut.jpg"
    truncated.write_bytes(whole.read_bytes()[: whole.stat().st_size * 6 // 10])
    with truncated.open("rb") as fh:
        resp = client.post("/api/images", files={"file": ("cut.jpg", fh, "image/jpeg")})
    assert resp.status_code == 415
    assert "truncated or corrupt" in resp.json()["detail"]
    assert list(settings.uploads_dir.iterdir()) == []


def test_upload_files_are_removed_when_the_row_cannot_be_written(
    tmp_path: Path, sample_jpeg: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    settings = make_settings(tmp_path)

    def boom(self: Database, rec: object) -> None:
        raise RuntimeError("database is locked")

    monkeypatch.setattr(Database, "insert_image", boom)
    app = create_app(settings, solver_factory=lambda: None, poll_interval=0.01)
    with TestClient(app, raise_server_exceptions=False) as client, sample_jpeg.open("rb") as fh:
        login(client)
        resp = client.post("/api/images", files={"file": ("orion.jpg", fh, "image/jpeg")})
        assert resp.status_code == 500
        assert list(settings.uploads_dir.iterdir()) == []


def test_health_reports_a_broken_config_file(env_client: tuple[TestClient, Path]) -> None:
    client, data_dir = env_client
    (data_dir / "config.json").write_text('{"nova_api_key": "k",')
    body = client.get("/api/health").json()
    assert body["setup_required"] is False and body["authenticated"] is False
    assert body["config_error"] == f"config.json is not valid JSON; {CONFIG_FIX_HINT}"
    # No raw exception text and no server path reaches the page (CLAUDE.md).
    assert "line 1" not in body["config_error"] and str(data_dir) not in body["config_error"]
    broken = client.post("/api/setup", json={"password": "hunter2hunter2"})
    assert broken.status_code == 409 and broken.json() == {"detail": body["config_error"]}
    (data_dir / "config.json").write_text(
        json.dumps(
            {"password_hash": TEST_PASSWORD_HASH, "session_secret": "s", "nova_api_key": "k"}
        )
    )
    body = client.get("/api/health").json()
    assert body["setup_required"] is False and body["config_error"] is None
