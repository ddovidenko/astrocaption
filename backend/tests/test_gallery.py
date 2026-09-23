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
