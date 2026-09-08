from __future__ import annotations

import hashlib
import os
from pathlib import Path

from fastapi.testclient import TestClient
from PIL import Image

from app.config import Settings
from tests.conftest import (
    FakeSolver,
    load_fixture,
    make_client,
    make_settings,
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
        "nova_api_key_set": False,
    }
    fonts = client.get("/api/fonts").json()
    assert len(fonts) == 24
    inter = next(f for f in fonts if f["file"] == "Inter-Regular.ttf")
    assert (inter["family"], inter["weight"], inter["sample"]) == ("Inter", "Regular", "NGC 1976")
    font = client.get("/fonts/Inter-Regular.ttf")
    assert font.status_code == 200 and font.headers["content-type"] == "font/ttf"


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


def test_upload_too_large(tmp_path: Path) -> None:
    settings = make_settings(tmp_path, max_upload_mb=1)
    noisy = tmp_path / "noise.png"
    Image.frombytes("RGB", (1200, 900), os.urandom(1200 * 900 * 3)).save(noisy)
    assert noisy.stat().st_size > 1024 * 1024
    with make_client(settings, lambda: None) as client, noisy.open("rb") as fh:
        resp = client.post("/api/images", files={"file": ("noise.png", fh, "image/png")})
        assert resp.status_code == 413
        assert list(settings.uploads_dir.iterdir()) == []


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
    assert sum(lab["enabled"] for lab in ann["labels"]) == 17
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


def test_export_and_resolve_conflict_while_solving(tmp_path: Path, sample_jpeg: Path) -> None:
    settings = make_settings(tmp_path)
    stuck = FakeSolver(submission_polls=10**9)
    with make_client(settings, lambda: stuck) as client:
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
