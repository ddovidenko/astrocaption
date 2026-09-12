from __future__ import annotations

import errno
import json
import logging
from collections.abc import Iterator
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.api.config import (
    CONFIG_SAVED_BUT_UNREADABLE,
    DATA_DIR_FULL,
    DATA_DIR_NOT_WRITABLE,
)
from app.config import CONFIG_NOT_JSON, ConfigError
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


def test_explicit_null_is_rejected_except_for_the_nova_key(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Only ``nova_api_key: null`` means something; for the other two it was a silent no-op (#47)."""
    with owner_client(tmp_path, monkeypatch) as client:
        for field in ("site_title", "max_upload_mb"):
            resp = client.put("/api/config", json={field: None})
            assert resp.status_code == 422, resp.text
            assert field in resp.json()["detail"] and "null" in resp.json()["detail"]
        assert client.get("/api/config").json()["site_title"] == "Sky"


def test_locked_fields_are_rejected_with_the_variable_name(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    with owner_client(tmp_path, monkeypatch, ASTROCAPTION_SITE_TITLE="Env title") as client:
        body = client.get("/api/config").json()
        assert body["locked"] == ["site_title"]
        assert body["locked_by"] == {"site_title": "ASTROCAPTION_SITE_TITLE"}
        resp = client.put("/api/config", json={"site_title": "Mine", "max_upload_mb": 9})
        assert resp.status_code == 422
        assert resp.json() == {
            "detail": "site_title is set by ASTROCAPTION_SITE_TITLE; unset it to change it here."
        }
        assert "max_upload_mb" not in read_config(tmp_path)  # nothing was written


def test_locked_message_names_the_legacy_key_variable(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The message must name the variable that is actually set, not the preferred spelling."""
    with owner_client(tmp_path, monkeypatch, ASTROMETRY_API_KEY="legacy") as client:
        assert client.get("/api/config").json()["locked_by"] == {
            "nova_api_key": "ASTROMETRY_API_KEY"
        }
        resp = client.put("/api/config", json={"nova_api_key": "mine"})
        assert resp.status_code == 422
        assert resp.json() == {
            "detail": "nova_api_key is set by ASTROMETRY_API_KEY; unset it to change it here."
        }
        assert "mine" not in resp.text and "legacy" not in resp.text


def test_locked_message_names_every_locked_field_that_was_touched(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    with owner_client(
        tmp_path, monkeypatch, ASTROCAPTION_SITE_TITLE="Env title", ASTROMETRY_API_KEY="legacy"
    ) as client:
        resp = client.put("/api/config", json={"site_title": "Mine", "nova_api_key": "k"})
        assert resp.status_code == 422
        assert resp.json() == {
            "detail": (
                "nova_api_key (ASTROMETRY_API_KEY), site_title (ASTROCAPTION_SITE_TITLE) "
                "are set by the environment; unset them to change them here."
            )
        }


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


def test_put_rejects_blank_title_with_the_model_rule(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """One rule, in the model: a blank title is a pydantic 422, and the value is not echoed."""
    with owner_client(tmp_path, monkeypatch) as client:
        resp = client.put("/api/config", json={"site_title": "   "})
        assert resp.status_code == 422
        detail = resp.json()["detail"]
        assert isinstance(detail, str)
        assert detail == "site_title: must not be blank"
        assert client.put("/api/config", json={"site_title": "  Padded  "}).status_code == 200
        assert read_config(tmp_path)["site_title"] == "Padded"  # stripped by the model


@pytest.mark.parametrize(
    ("exc", "detail"),
    [
        (PermissionError("Read-only file system"), DATA_DIR_NOT_WRITABLE),
        (OSError(errno.ENOSPC, "no space left on device"), DATA_DIR_FULL),
    ],
    ids=["not-writable", "disk-full"],
)
def test_put_500_names_the_write_failure_without_the_reason(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, exc: OSError, detail: str
) -> None:
    """A full disk is the one write failure the owner can act on, so it gets its own words;
    everything else is neutral, and the reason stays in the server log either way."""
    with owner_client(tmp_path, monkeypatch) as client:

        def _boom(*args: object, **kwargs: object) -> None:
            raise exc

        monkeypatch.setattr("app.api.config.update_config", _boom)
        resp = client.put("/api/config", json={"site_title": "X"})
        assert resp.status_code == 500
        assert resp.json() == {"detail": detail}
        assert str(tmp_path) not in resp.text and "Read-only" not in resp.text


def test_put_500_when_the_file_cannot_be_read_back(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    """A write that lands but leaves an unusable file is not a success."""
    with owner_client(tmp_path, monkeypatch) as client:
        path = tmp_path / "data" / "config.json"

        def _corrupt(*args: object, **kwargs: object) -> None:
            path.write_text("{oops")

        monkeypatch.setattr("app.api.config.update_config", _corrupt)
        with caplog.at_level(logging.ERROR, logger="app.api.config"):
            resp = client.put("/api/config", json={"site_title": "X"})
        assert resp.status_code == 500
        assert resp.json() == {"detail": CONFIG_SAVED_BUT_UNREADABLE}
        assert "unusable immediately after a write" in caplog.text
        assert str(tmp_path) not in resp.text and "Traceback" not in resp.text


def test_put_with_nothing_to_change_never_rewrites_the_file(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A no-op save must not touch the file that holds the password hash and the secret."""
    with owner_client(tmp_path, monkeypatch) as client:

        def _boom(*args: object, **kwargs: object) -> None:
            raise AssertionError("config.json must not be written for an empty update")

        monkeypatch.setattr("app.api.config.update_config", _boom)
        resp = client.put("/api/config", json={})
        assert resp.status_code == 200 and resp.json()["site_title"] == "Sky"


def test_concurrent_puts_of_different_fields_both_land(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Two saves at once: the lock keeps one read-modify-write from losing the other."""
    with owner_client(tmp_path, monkeypatch) as client:

        def put(body: dict[str, object]) -> int:
            code: int = client.put("/api/config", json=body).status_code
            return code

        with ThreadPoolExecutor(max_workers=2) as pool:
            codes = list(pool.map(put, [{"site_title": "Left"}, {"max_upload_mb": 42}]))
        assert codes == [200, 200]
        after = read_config(tmp_path)
        assert after["site_title"] == "Left" and after["max_upload_mb"] == 42
        assert "password_hash" in after and "session_secret" in after


def test_default_style_from_the_file_survives_a_round_trip(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """What GET reports is what a page-shaped PUT may send straight back (fields it cannot
    represent were dropped at load, with a server-log warning)."""
    data_dir = tmp_path / "data"
    data_dir.mkdir()
    (data_dir / "config.json").write_text(
        json.dumps(
            {
                "default_style": {
                    "text_color": "white",
                    "font_size": 300,
                    "halo": "false",
                    "bogus": 1,
                    "marker_color": "#ff8800",
                }
            }
        )
    )
    with owner_client(tmp_path, monkeypatch) as client:
        loaded = client.get("/api/config").json()["default_style"]
        assert loaded == {"halo": False, "marker_color": "#ff8800"}
        resp = client.put("/api/config", json={"site_title": "Fresh", "default_style": loaded})
        assert resp.status_code == 200, resp.text
        assert resp.json()["default_style"] == loaded
        assert read_config(tmp_path)["default_style"] == loaded


def test_422_labels_cannot_forge_a_log_line_or_flood_the_message(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    """Field names come from the client, so they are sanitised before they are echoed."""
    with owner_client(tmp_path, monkeypatch) as client:
        with caplog.at_level(logging.INFO, logger="app.main"):
            resp = client.put("/api/config", json={"leaked\nWARNING forged": 1})
        assert resp.status_code == 422
        detail = resp.json()["detail"]
        assert "\n" not in detail and "leaked?WARNING forged" in detail
        logged = [r for r in caplog.records if "request validation failed" in r.getMessage()]
        assert len(logged) == 1 and "\n" not in logged[0].getMessage()

        long_resp = client.put("/api/config", json={"x" * 200: 1})
        assert long_resp.status_code == 422
        label = long_resp.json()["detail"].split(":")[0]
        assert label == "x" * 60

        with caplog.at_level(logging.INFO, logger="app.main"):
            flood = client.put("/api/config", json={f"k{i}": 1 for i in range(40)})
        assert flood.status_code == 422
        problems = flood.json()["detail"].split("; ")
        assert len(problems) == 6 and problems[-1] == "and 35 more problems"
        last = [r for r in caplog.records if "request validation failed" in r.getMessage()][-1]
        assert last.getMessage().count("k") == 5  # five labels logged, not forty


def test_put_409_on_config_error(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    with owner_client(tmp_path, monkeypatch) as client:

        def _boom(*args: object, **kwargs: object) -> None:
            raise ConfigError(CONFIG_NOT_JSON)

        monkeypatch.setattr("app.api.config.update_config", _boom)
        resp = client.put("/api/config", json={"site_title": "X"})
        assert resp.status_code == 409
        assert resp.json() == {"detail": CONFIG_NOT_JSON}
        assert str(tmp_path) not in resp.text
        assert "Traceback" not in resp.text
