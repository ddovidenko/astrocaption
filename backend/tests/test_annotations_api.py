"""``PUT /api/images/{id}/annotations`` (design § 4): the editor's autosave with a version check."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

from app.db import Database
from app.models import AnnotationsUpdate
from tests.conftest import FakeSolver, login, make_client, make_settings, upload, wait_for_status

CONFLICT = "This image was changed elsewhere. Reload to continue editing."
OBJECTS_DUPLICATE = "labels: each of this image's objects may appear only once."
OBJECTS_UNKNOWN = "labels: every label must name one of this image's objects."
OBJECTS_MISSING = "labels: the document must list every one of this image's objects."


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
    assert stored["updated_at"] >= ann["updated_at"]
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


def test_put_with_a_stale_version_is_a_409_even_with_a_now_invalid_document(
    client: TestClient, sample_jpeg: Path
) -> None:
    """A stale document (e.g. from before a re-solve) may name objects that no longer exist.
    The version conflict must still win: 409 to reload, not a 422 about the labels."""
    image_id, ann, _ = solved_image(client, sample_jpeg)
    first = client.put(f"/api/images/{image_id}/annotations", json=ann).json()
    stale = {**ann, "labels": ann["labels"] + [{"object_id": 999_999}]}
    resp = client.put(f"/api/images/{image_id}/annotations", json=stale)
    assert resp.status_code == 409
    assert resp.json() == {"detail": CONFLICT}
    assert client.get(f"/api/images/{image_id}/annotations").json() == first


def test_put_loses_the_compare_and_swap_race_is_a_409(
    client: TestClient, sample_jpeg: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    image_id, ann, _ = solved_image(client, sample_jpeg)
    monkeypatch.setattr(
        Database, "update_annotations_if_version", lambda self, ann, expected_version: False
    )
    resp = client.put(f"/api/images/{image_id}/annotations", json=ann)
    assert resp.status_code == 409
    assert resp.json() == {"detail": CONFLICT}


def test_put_validates_objects_font_and_colours_without_echoing(
    client: TestClient, sample_jpeg: Path
) -> None:
    image_id, ann, _ = solved_image(client, sample_jpeg)
    url = f"/api/images/{image_id}/annotations"

    unknown = {**ann, "labels": ann["labels"] + [{"object_id": 999_999}]}
    resp = client.put(url, json=unknown)
    assert resp.status_code == 422 and "999999" not in resp.text
    assert resp.json()["detail"] == OBJECTS_UNKNOWN

    duplicate = {**ann, "labels": ann["labels"] + [ann["labels"][0]]}
    resp = client.put(url, json=duplicate)
    assert resp.status_code == 422
    assert resp.json()["detail"] == OBJECTS_DUPLICATE

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


def test_put_rejects_a_duplicate_object_id(client: TestClient, sample_jpeg: Path) -> None:
    image_id, ann, _ = solved_image(client, sample_jpeg)
    url = f"/api/images/{image_id}/annotations"
    dup_id = ann["labels"][0]["object_id"]
    doc = {**ann, "labels": ann["labels"] + [ann["labels"][0]]}
    resp = client.put(url, json=doc)
    assert resp.status_code == 422
    assert resp.json()["detail"] == OBJECTS_DUPLICATE
    assert str(dup_id) not in resp.text
    assert client.get(url).json() == ann


def test_put_rejects_an_unknown_object_id(client: TestClient, sample_jpeg: Path) -> None:
    image_id, ann, objects = solved_image(client, sample_jpeg)
    url = f"/api/images/{image_id}/annotations"
    unknown_id = max(o["id"] for o in objects) + 1
    doc = {**ann, "labels": ann["labels"] + [{"object_id": unknown_id}]}
    resp = client.put(url, json=doc)
    assert resp.status_code == 422
    assert resp.json()["detail"] == OBJECTS_UNKNOWN
    assert str(unknown_id) not in resp.text
    assert client.get(url).json() == ann


def test_put_rejects_a_document_missing_an_object(client: TestClient, sample_jpeg: Path) -> None:
    image_id, ann, _ = solved_image(client, sample_jpeg)
    url = f"/api/images/{image_id}/annotations"
    dropped_id = ann["labels"][0]["object_id"]
    doc = {**ann, "labels": ann["labels"][1:]}
    resp = client.put(url, json=doc)
    assert resp.status_code == 422
    assert resp.json()["detail"] == OBJECTS_MISSING
    assert str(dropped_id) not in resp.text
    assert client.get(url).json() == ann


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


def test_autoarrange_places_enabled_labels_and_stores_nothing(
    client: TestClient, sample_jpeg: Path
) -> None:
    image_id, ann, _ = solved_image(client, sample_jpeg)
    moved = {
        **ann,
        "labels": [{**lab, "x": 0.0, "y": 0.0, "collided": True} for lab in ann["labels"]],
    }
    resp = client.post(f"/api/images/{image_id}/autoarrange", json=moved)
    assert resp.status_code == 200, resp.text
    placed = resp.json()
    assert placed["version"] == ann["version"]
    assert placed["image_id"] == image_id
    enabled = [lab for lab in placed["labels"] if lab["enabled"]]
    disabled = [lab for lab in placed["labels"] if not lab["enabled"]]
    assert enabled and all((lab["x"], lab["y"]) != (0.0, 0.0) for lab in enabled)
    assert all((lab["x"], lab["y"]) == (0.0, 0.0) for lab in disabled)  # untouched
    assert not any(lab["collided"] for lab in enabled)
    # the initial layout, reproduced: same positions as the solve produced
    by_id = {lab["object_id"]: lab for lab in ann["labels"]}
    for lab in enabled:
        assert (lab["x"], lab["y"]) == (by_id[lab["object_id"]]["x"], by_id[lab["object_id"]]["y"])
    assert client.get(f"/api/images/{image_id}/annotations").json() == ann  # not stored


def test_autoarrange_validates_like_put(client: TestClient, sample_jpeg: Path) -> None:
    image_id, ann, _ = solved_image(client, sample_jpeg)
    url = f"/api/images/{image_id}/autoarrange"
    resp = client.post(url, json={**ann, "labels": ann["labels"] + [{"object_id": 999_999}]})
    assert resp.status_code == 422 and resp.json()["detail"] == OBJECTS_UNKNOWN
    resp = client.post(url, json={**ann, "style": {**ann["style"], "font_file": "Nope.ttf"}})
    assert resp.status_code == 422 and "Nope" not in resp.text
    assert client.post("/api/images/nope/autoarrange", json=ann).status_code == 404


def test_autoarrange_checks_the_version(client: TestClient, sample_jpeg: Path) -> None:
    image_id, ann, _ = solved_image(client, sample_jpeg)
    ann["labels"][0]["x"] += 1.0
    put_resp = client.put(f"/api/images/{image_id}/annotations", json=ann)
    assert put_resp.status_code == 200, put_resp.text
    resp = client.post(f"/api/images/{image_id}/autoarrange", json=ann)  # ann.version is now stale
    assert resp.status_code == 409
    assert resp.json() == {"detail": CONFLICT}


def test_put_rejects_an_unknown_label_field_without_echoing(
    client: TestClient, sample_jpeg: Path
) -> None:
    image_id, ann, _ = solved_image(client, sample_jpeg)
    url = f"/api/images/{image_id}/annotations"
    doc = {**ann, "labels": [{**ann["labels"][0], "colour": "#123456"}] + ann["labels"][1:]}
    resp = client.put(url, json=doc)
    assert resp.status_code == 422
    assert resp.json()["detail"] == "labels.0.colour: is not a known field"
    assert client.get(url).json() == ann


def test_annotations_update_forbids_an_unknown_top_level_field() -> None:
    with pytest.raises(ValidationError) as excinfo:
        AnnotationsUpdate.model_validate({"style": {}, "labels": [], "version": 1, "extra": 1})
    assert excinfo.value.errors()[0]["type"] == "extra_forbidden"


def test_put_rejects_nan_coordinates(client: TestClient, sample_jpeg: Path) -> None:
    image_id, ann, _ = solved_image(client, sample_jpeg)
    doc = {**ann, "labels": [{**ann["labels"][0], "x": float("nan")}] + ann["labels"][1:]}
    body = json.dumps(doc, allow_nan=True)
    resp = client.put(
        f"/api/images/{image_id}/annotations",
        content=body,
        headers={"Content-Type": "application/json"},
    )
    assert resp.status_code == 422
    assert "labels.0.x" in resp.json()["detail"]
    assert "NaN" not in resp.text
    assert client.get(f"/api/images/{image_id}/annotations").json() == ann


def test_put_lost_cas_with_the_row_gone_is_a_404(
    client: TestClient, sample_jpeg: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """False from the compare-and-swap is ambiguous: someone else won, or the row is simply
    gone. The second check after the loss tells them apart."""
    image_id, ann, _ = solved_image(client, sample_jpeg)
    monkeypatch.setattr(
        Database, "update_annotations_if_version", lambda self, ann, expected_version: False
    )
    real_get_annotations = Database.get_annotations
    calls = {"n": 0}

    def fake_get_annotations(self: Database, iid: str) -> Any:
        calls["n"] += 1
        if calls["n"] > 1:  # the second call, made by put_annotations after the lost CAS
            return None
        return real_get_annotations(self, iid)

    monkeypatch.setattr(Database, "get_annotations", fake_get_annotations)
    resp = client.put(f"/api/images/{image_id}/annotations", json=ann)
    assert resp.status_code == 404
    assert resp.json() == {"detail": "Image not found."}
