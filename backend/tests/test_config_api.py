from __future__ import annotations

import json
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from tests.conftest import env_app_client, login

PASSWORD = "config-page-pw1"


@contextmanager
def owner_client(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, **env: str
) -> Iterator[TestClient]:
    """A live-config app that has been set up and signed in."""
    with env_app_client(tmp_path, monkeypatch, **env) as client:
        resp = client.post("/api/setup", json={"password": PASSWORD, "site_title": "Sky"})
        assert resp.status_code == 204, resp.text
        login(client, PASSWORD)
        yield client


def read_config(tmp_path: Path) -> dict[str, object]:
    data: dict[str, object] = json.loads((tmp_path / "data" / "config.json").read_text())
    return data


def test_put_is_partial_and_keeps_the_secrets(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    with owner_client(tmp_path, monkeypatch) as client:
        before = read_config(tmp_path)
        resp = client.put("/api/config", json={"max_upload_mb": 12})
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["max_upload_mb"] == 12 and body["site_title"] == "Sky"
        assert body["nova_api_key_set"] is False and body["locked"] == []
        after = read_config(tmp_path)
        assert after["password_hash"] == before["password_hash"]
        assert after["session_secret"] == before["session_secret"]
        assert after["max_upload_mb"] == 12 and after["site_title"] == "Sky"
        # Live without a restart: health reflects a title change immediately.
        assert client.put("/api/config", json={"site_title": "New sky"}).status_code == 200
        assert client.get("/api/health").json()["site_title"] == "New sky"


def test_nova_key_set_keep_and_clear(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    with owner_client(tmp_path, monkeypatch) as client:
        assert (
            client.put("/api/config", json={"nova_api_key": "  abc  "}).json()["nova_api_key_set"]
            is True
        )
        assert read_config(tmp_path)["nova_api_key"] == "abc"
        assert (
            client.put("/api/config", json={"site_title": "Still"}).json()["nova_api_key_set"]
            is True
        )
        assert (
            client.put("/api/config", json={"nova_api_key": None}).json()["nova_api_key_set"]
            is False
        )
        assert "nova_api_key" not in read_config(tmp_path)
        assert "abc" not in client.get("/api/config").text


def test_locked_fields_are_rejected_with_the_variable_name(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    with owner_client(tmp_path, monkeypatch, ASTROCAPTION_SITE_TITLE="Env title") as client:
        assert client.get("/api/config").json()["locked"] == ["site_title"]
        resp = client.put("/api/config", json={"site_title": "Mine", "max_upload_mb": 9})
        assert resp.status_code == 422
        assert resp.json() == {
            "detail": "site_title is set by ASTROCAPTION_SITE_TITLE; unset it to change it here."
        }
        assert "max_upload_mb" not in read_config(tmp_path)  # nothing was written


def test_default_style_is_validated_and_stored_as_overrides(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    with owner_client(tmp_path, monkeypatch) as client:
        bad_font = client.put("/api/config", json={"default_style": {"font_file": "Comic.ttf"}})
        assert bad_font.status_code == 422
        assert bad_font.json() == {"detail": "default_style.font_file is not a bundled font."}
        bad_colour = client.put("/api/config", json={"default_style": {"text_color": "red"}})
        assert bad_colour.status_code == 422 and "red" not in bad_colour.text
        assert "default_style" not in read_config(tmp_path)

        ok = client.put(
            "/api/config",
            json={
                "default_style": {
                    "font_file": "Roboto-Bold.ttf",
                    "text_color": "#ff8800",
                    "halo": None,
                }
            },
        )
        assert ok.status_code == 200
        assert ok.json()["default_style"] == {
            "font_file": "Roboto-Bold.ttf",
            "text_color": "#ff8800",
        }
        assert read_config(tmp_path)["default_style"] == {
            "font_file": "Roboto-Bold.ttf",
            "text_color": "#ff8800",
        }
        # Sending a style replaces the override set; an empty one removes the key.
        assert client.put("/api/config", json={"default_style": {}}).json()["default_style"] == {}
        assert "default_style" not in read_config(tmp_path)


def test_put_rejects_unknown_fields_and_needs_a_session(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    with owner_client(tmp_path, monkeypatch) as client:
        assert client.put("/api/config", json={"password": "x"}).status_code == 422
        client.post("/api/logout")
        assert client.put("/api/config", json={"site_title": "Nope"}).status_code == 401


def test_put_refuses_to_touch_a_corrupt_config(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    with owner_client(tmp_path, monkeypatch) as client:
        path = tmp_path / "data" / "config.json"
        good = path.read_text()
        path.write_text("{oops")
        # The session is gone with the hash, so this is a 401 before it can be a 409:
        assert client.put("/api/config", json={"site_title": "X"}).status_code == 401
        path.write_text(good)
        assert client.put("/api/config", json={"site_title": "Back"}).status_code == 200


def test_put_rejects_blank_title(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    with owner_client(tmp_path, monkeypatch) as client:
        resp = client.put("/api/config", json={"site_title": "   "})
        assert resp.status_code == 422
        assert resp.json() == {"detail": "site_title must not be blank."}


def test_put_500_on_unwritable_data_dir(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    with owner_client(tmp_path, monkeypatch) as client:

        def _boom(*args: object, **kwargs: object) -> None:
            raise OSError("Read-only file system")

        monkeypatch.setattr("app.api.config.update_config", _boom)
        resp = client.put("/api/config", json={"site_title": "X"})
        assert resp.status_code == 500
        assert resp.json() == {
            "detail": (
                "Settings could not be saved: the data directory is not writable. "
                "Check the permissions on ./data and try again."
            )
        }
        assert str(tmp_path) not in resp.text
