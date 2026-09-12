"""``PUT /api/images/{id}/annotations`` (design § 4): the editor's autosave with a version check."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from fastapi.testclient import TestClient

from tests.conftest import FakeSolver, login, make_client, make_settings, upload, wait_for_status

CONFLICT = "This image was changed elsewhere. Reload to continue editing."


def solved_image(
    client: TestClient, sample_jpeg: Path
) -> tuple[str, dict[str, Any], list[dict[str, Any]]]:
    image_id = upload(client, sample_jpeg, title="Orion")["id"]
    assert wait_for_status(client, image_id, {"solved", "failed"})["solve_status"] == "solved"
    ann = client.get(f"/api/images/{image_id}/annotations").json()
    objects = client.get(f"/api/images/{image_id}/objects").json()
    return image_id, ann, objects


def test_put_stores_the_document_with_a_bumped_version(
    client: TestClient, sample_jpeg: Path
) -> None:
    image_id, ann, _ = solved_image(client, sample_jpeg)
    ann["labels"][0]["x"] += 25.5
    ann["labels"][0]["collided"] = False
    ann["style"]["text_color"] = "#ABCDEF"
    resp = client.put(f"/api/images/{image_id}/annotations", json=ann)
    assert resp.status_code == 200, resp.text
    stored = resp.json()
    assert stored["version"] == ann["version"] + 1
    assert stored["updated_at"] != ann["updated_at"] or stored["updated_at"] >= ann["updated_at"]
    assert stored["labels"][0]["x"] == ann["labels"][0]["x"]
    assert stored["style"]["text_color"] == "#ABCDEF"
    assert client.get(f"/api/images/{image_id}/annotations").json() == stored


def test_put_with_a_stale_version_is_a_409_and_writes_nothing(
    client: TestClient, sample_jpeg: Path
) -> None:
    image_id, ann, _ = solved_image(client, sample_jpeg)
    first = client.put(f"/api/images/{image_id}/annotations", json=ann).json()
    ann["labels"][0]["x"] = -1.0  # a second editor still holding the old version
    resp = client.put(f"/api/images/{image_id}/annotations", json=ann)
    assert resp.status_code == 409
    assert resp.json() == {"detail": CONFLICT}
    assert client.get(f"/api/images/{image_id}/annotations").json() == first


def test_put_validates_objects_font_and_colours_without_echoing(
    client: TestClient, sample_jpeg: Path
) -> None:
    image_id, ann, objects = solved_image(client, sample_jpeg)
    url = f"/api/images/{image_id}/annotations"

    unknown = {**ann, "labels": ann["labels"] + [{"object_id": 999_999}]}
    resp = client.put(url, json=unknown)
    assert resp.status_code == 422 and "999999" not in resp.text
    assert (
        resp.json()["detail"] == "labels: every label must name one of this image's objects, once."
    )

    duplicate = {**ann, "labels": ann["labels"] + [ann["labels"][0]]}
    assert client.put(url, json=duplicate).status_code == 422

    bad_font = {**ann, "style": {**ann["style"], "font_file": "Comic-Sans.ttf"}}
    resp = client.put(url, json=bad_font)
    assert resp.status_code == 422 and "Comic" not in resp.text
    assert resp.json()["detail"] == "style.font_file is not a bundled font."

    bad_colour = {**ann, "style": {**ann["style"], "marker_color": "orange"}}
    resp = client.put(url, json=bad_colour)
    assert resp.status_code == 422 and "orange" not in resp.text
    assert resp.json()["detail"] == "style.marker_color: must match ^#[0-9A-Fa-f]{6}$"

    bad_label_colour = {
        **ann,
        "labels": [{**ann["labels"][0], "color": "orange"}] + ann["labels"][1:],
    }
    resp = client.put(url, json=bad_label_colour)
    assert resp.status_code == 422 and "orange" not in resp.text

    assert client.put(url, json={**ann, "version": 0}).status_code == 422
    assert client.get(url).json() == ann  # nothing above was stored
    assert len(objects) == 20


def test_put_needs_a_solved_image(client: TestClient, sample_jpeg: Path, tmp_path: Path) -> None:
    doc = {"style": {}, "labels": [], "version": 1}
    assert client.put("/api/images/nope/annotations", json=doc).status_code == 404

    # solving: 409 while the solver hasn't finished
    solving_settings = make_settings(tmp_path / "solving")
    stuck = FakeSolver(submission_polls=10**9)
    with make_client(solving_settings, lambda: stuck) as solving_client:
        login(solving_client)
        body = upload(solving_client, sample_jpeg)
        resp = solving_client.put(f"/api/images/{body['id']}/annotations", json=doc)
        assert resp.status_code == 409
        assert (
            resp.json()["detail"] == "The image is still being solved; try again when it is done."
        )

    # never solved (no key): 404, no annotations row
    failed_settings = make_settings(tmp_path / "failed")
    with make_client(failed_settings, lambda: None) as failed_client:
        login(failed_client)
        body = upload(failed_client, sample_jpeg)
        wait_for_status(failed_client, body["id"], {"solved", "failed"})
        resp = failed_client.put(f"/api/images/{body['id']}/annotations", json=doc)
        assert resp.status_code == 404
        assert resp.json()["detail"] == "Image has not been solved yet."
