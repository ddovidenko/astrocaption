"""Publish toggle (owner) and the public gallery routes (SPEC § 5.5, § 8)."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from fastapi.testclient import TestClient

from app.config import Settings
from app.db import Database
from app.models import SolveStatus
from tests.conftest import upload, wait_for_status

PUBLISH_NEEDS_EXPORT = "Export the image before publishing it."
NOT_FOUND = "Image not found."


def solved_image(client: TestClient, sample_jpeg: Path) -> dict[str, Any]:
    body = upload(client, sample_jpeg, title="Orion Field")
    solved = wait_for_status(client, body["id"], {"solved", "failed"})
    assert solved["solve_status"] == "solved", solved["solve_error"]
    return solved


def exported_image(client: TestClient, sample_jpeg: Path) -> dict[str, Any]:
    image = solved_image(client, sample_jpeg)
    resp = client.post(f"/api/images/{image['id']}/export", json={})
    assert resp.status_code == 200, resp.text
    fetched: dict[str, Any] = client.get(f"/api/images/{image['id']}").json()
    return fetched


def set_published(client: TestClient, image_id: str, value: bool) -> Any:
    return client.put(f"/api/images/{image_id}/published", json={"published": value})


def test_publish_requires_an_export(client: TestClient, sample_jpeg: Path) -> None:
    image = solved_image(client, sample_jpeg)
    resp = set_published(client, image["id"], True)
    assert resp.status_code == 409 and resp.json() == {"detail": PUBLISH_NEEDS_EXPORT}
    assert client.get(f"/api/images/{image['id']}").json()["published"] is False
    # Unpublishing an unpublished image is a no-op, not an error.
    resp = set_published(client, image["id"], False)
    assert resp.status_code == 200 and resp.json()["published"] is False


def test_publish_and_unpublish_an_exported_image(client: TestClient, sample_jpeg: Path) -> None:
    image = exported_image(client, sample_jpeg)
    resp = set_published(client, image["id"], True)
    assert resp.status_code == 200, resp.text
    assert resp.json()["published"] is True
    assert client.get(f"/api/images/{image['id']}").json()["published"] is True
    resp = set_published(client, image["id"], False)
    assert resp.status_code == 200 and resp.json()["published"] is False


def test_publish_is_refused_when_the_export_file_is_gone(
    client: TestClient, settings: Settings, sample_jpeg: Path
) -> None:
    image = exported_image(client, sample_jpeg)
    (settings.renders_dir / image["id"] / "annotated.jpg").unlink()
    resp = set_published(client, image["id"], True)
    assert resp.status_code == 409 and resp.json() == {"detail": PUBLISH_NEEDS_EXPORT}


def test_publish_is_refused_while_a_resolve_runs(
    client: TestClient, settings: Settings, sample_jpeg: Path
) -> None:
    image = exported_image(client, sample_jpeg)
    # Flip the row under the API: the fake solver answers instantly, so a real re-solve would
    # be solved again before the request could observe the running state.
    Database(settings.db_path).update_image(image["id"], {"solve_status": SolveStatus.SOLVING})
    resp = set_published(client, image["id"], True)
    assert resp.status_code == 409 and resp.json() == {"detail": PUBLISH_NEEDS_EXPORT}


def test_publish_unknown_image_and_logged_out(client: TestClient, anon_client: TestClient) -> None:
    assert set_published(client, "nope", True).status_code == 404
    resp = anon_client.put("/api/images/nope/published", json={"published": True})
    assert resp.status_code == 401
    assert resp.json() == {"detail": "Sign in to continue."}


def published_image(client: TestClient, sample_jpeg: Path) -> dict[str, Any]:
    image = exported_image(client, sample_jpeg)
    resp = set_published(client, image["id"], True)
    assert resp.status_code == 200, resp.text
    body: dict[str, Any] = resp.json()
    return body


def test_gallery_lists_published_images_newest_first_and_nothing_else(
    client: TestClient, anon_client: TestClient, sample_jpeg: Path
) -> None:
    first = published_image(client, sample_jpeg)
    unpublished = exported_image(client, sample_jpeg)
    second = published_image(client, sample_jpeg)
    resp = anon_client.get("/api/gallery")
    assert resp.status_code == 200, resp.text
    items = resp.json()
    assert [i["id"] for i in items] == [second["id"], first["id"]]
    assert unpublished["id"] not in {i["id"] for i in items}
    item = items[0]
    assert set(item) == {
        "id",
        "title",
        "width",
        "height",
        "exported_at",
        "thumb_url",
        "preview_url",
        "annotated_preview_url",
        "export_url",
    }
    assert item["title"] == "Orion Field"
    base = f"/api/gallery/{second['id']}/files/"
    assert item["thumb_url"] == f"{base}thumb"
    assert item["preview_url"] == f"{base}preview"
    assert item["annotated_preview_url"].startswith(f"{base}annotated-preview?v=")
    assert item["export_url"].startswith(f"{base}export?v=")
    # No cookie was involved: the same list is served to the owner too.
    assert client.get("/api/gallery").json() == items


def test_gallery_payloads_never_carry_server_paths(
    client: TestClient, anon_client: TestClient, sample_jpeg: Path, settings: Settings
) -> None:
    image = published_image(client, sample_jpeg)
    for url in ("/api/gallery", f"/api/gallery/{image['id']}"):
        text = anon_client.get(url).text
        assert str(settings.data_dir) not in text
        assert "uploads/" not in text and "renders/" not in text


def test_gallery_item_and_files_for_a_published_image(
    anon_client: TestClient, client: TestClient, sample_jpeg: Path
) -> None:
    image = published_image(client, sample_jpeg)
    resp = anon_client.get(f"/api/gallery/{image['id']}")
    assert resp.status_code == 200, resp.text
    item = resp.json()
    for key in ("thumb_url", "preview_url", "annotated_preview_url", "export_url"):
        file_resp = anon_client.get(item[key])
        assert file_resp.status_code == 200, (key, file_resp.text)
        assert file_resp.headers["content-type"] == "image/jpeg"
        assert file_resp.headers["cache-control"] == "public, max-age=86400"
        assert file_resp.content[:2] == b"\xff\xd8", key  # a JPEG, not an error page
    export = anon_client.get(item["export_url"])
    assert 'filename="Orion-Field-annotated.jpg"' in export.headers["content-disposition"]
    # The unannotated original is owner-only: no public kind serves it.
    assert anon_client.get(f"/api/gallery/{image['id']}/files/original").status_code == 422
    assert anon_client.get(f"/api/images/{image['id']}/files/original").status_code == 401


def test_gallery_hides_unpublished_unknown_and_unsolved_images(
    anon_client: TestClient, client: TestClient, settings: Settings, sample_jpeg: Path
) -> None:
    image = exported_image(client, sample_jpeg)  # exported but not published
    for url in (
        f"/api/gallery/{image['id']}",
        f"/api/gallery/{image['id']}/files/thumb",
        f"/api/gallery/{image['id']}/files/export",
        "/api/gallery/nope",
        "/api/gallery/nope/files/thumb",
    ):
        resp = anon_client.get(url)
        assert resp.status_code == 404 and resp.json() == {"detail": NOT_FOUND}, url
    assert set_published(client, image["id"], True).status_code == 200
    assert anon_client.get(f"/api/gallery/{image['id']}").status_code == 200
    # A re-solve in flight takes the image out of the gallery; it is not unpublished.
    Database(settings.db_path).update_image(image["id"], {"solve_status": SolveStatus.SOLVING})
    assert anon_client.get("/api/gallery").json() == []
    assert anon_client.get(f"/api/gallery/{image['id']}").status_code == 404
    assert client.get(f"/api/images/{image['id']}").json()["published"] is True


def test_gallery_skips_a_published_row_whose_export_vanished(
    anon_client: TestClient, client: TestClient, settings: Settings, sample_jpeg: Path
) -> None:
    kept = published_image(client, sample_jpeg)
    gone = published_image(client, sample_jpeg)
    (settings.renders_dir / gone["id"] / "annotated.jpg").unlink()
    assert [i["id"] for i in anon_client.get("/api/gallery").json()] == [kept["id"]]
    resp = anon_client.get(f"/api/gallery/{gone['id']}")
    assert resp.status_code == 404 and resp.json() == {"detail": NOT_FOUND}


def test_gallery_is_404_everywhere_when_switched_off(
    tmp_path: Path, sample_jpeg: Path, fake_solver: Any
) -> None:
    from tests.conftest import login, make_client, make_settings

    settings = make_settings(tmp_path, public_gallery_enabled=False)
    with make_client(settings, lambda: fake_solver) as client:
        login(client)
        image = published_image(client, sample_jpeg)
        assert client.get(f"/api/images/{image['id']}").json()["published"] is True
        for url in (
            "/api/gallery",
            f"/api/gallery/{image['id']}",
            f"/api/gallery/{image['id']}/files/thumb",
            f"/api/gallery/{image['id']}/files/export",
        ):
            resp = client.get(url)
            assert resp.status_code == 404 and resp.json() == {"detail": NOT_FOUND}, url
