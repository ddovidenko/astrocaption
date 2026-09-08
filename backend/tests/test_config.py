from __future__ import annotations

import json
import logging
import os
import stat
from pathlib import Path

import pytest

from app.auth import perform_setup, verify_password
from app.config import ConfigError, load_settings, update_config
from tests.conftest import FONTS_DIR


def env_for(tmp_path: Path, **extra: str) -> dict[str, str]:
    return {
        "ASTROCAPTION_DATA_DIR": str(tmp_path),
        "ASTROCAPTION_FONTS_DIR": str(FONTS_DIR),
        **extra,
    }


def test_settings_without_config_file_require_setup(tmp_path: Path) -> None:
    s = load_settings(env_for(tmp_path))
    assert s.password_hash is None and s.session_secret is None
    assert s.setup_required is True and s.auth_ready is False
    assert s.trust_proxy is False and s.env_locked == frozenset()


def test_settings_read_auth_fields_and_env_locks(tmp_path: Path) -> None:
    (tmp_path / "config.json").write_text(
        json.dumps({"password_hash": "scrypt$x", "session_secret": "s", "site_title": "File"})
    )
    s = load_settings(
        env_for(tmp_path, TRUST_PROXY="1", ASTROCAPTION_SITE_TITLE="Env", NOVA_API_KEY="k")
    )
    assert (s.password_hash, s.session_secret) == ("scrypt$x", "s")
    assert s.setup_required is False and s.auth_ready is True
    assert s.trust_proxy is True
    assert s.site_title == "Env" and s.env_locked == {"site_title", "nova_api_key"}
    assert "scrypt$x" not in repr(s)  # both secrets are repr=False


def test_corrupt_config_is_not_setup_required(tmp_path: Path) -> None:
    (tmp_path / "config.json").write_text("{not json")
    s = load_settings(env_for(tmp_path))
    assert s.config_error and s.setup_required is False and s.auth_ready is False
    assert "not valid JSON" in s.config_error


def test_config_error_is_a_fixed_sentence_and_the_reason_only_reaches_the_log(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    """No raw exception text and no server path in what the API may show (CLAUDE.md)."""
    (tmp_path / "config.json").write_text('{"nova_api_key": "k",')
    with caplog.at_level(logging.WARNING, logger="app.config"):
        s = load_settings(env_for(tmp_path))
    assert s.config_error == "config.json is not valid JSON; fix or remove it and restart"
    assert "line 1" not in s.config_error and "char" not in s.config_error
    assert str(tmp_path) not in s.config_error
    assert "Expecting" in caplog.text and str(tmp_path) in caplog.text  # the detail is logged

    (tmp_path / "config.json").write_text("[1, 2]")
    assert load_settings(env_for(tmp_path)).config_error == "config.json must contain a JSON object"


@pytest.mark.parametrize("present", ["password_hash", "session_secret"])
def test_half_written_config_reopens_setup(
    tmp_path: Path, present: str, caplog: pytest.LogCaptureFixture
) -> None:
    """One half cannot authenticate anybody; setup runs again and writes both."""
    (tmp_path / "config.json").write_text(json.dumps({present: "value", "site_title": "Half"}))
    with caplog.at_level(logging.WARNING, logger="app.config"):
        s = load_settings(env_for(tmp_path))
    assert s.setup_required is True and s.auth_ready is False and s.config_error is None
    assert "session_secret" in caplog.text and "value" not in caplog.text

    perform_setup(s, "hunter2hunter2")
    after = load_settings(env_for(tmp_path))
    assert after.auth_ready and after.setup_required is False
    assert after.password_hash and verify_password("hunter2hunter2", after.password_hash)
    assert after.site_title == "Half"  # the rest of the file is merged, not dropped


def test_update_config_merges_atomically_with_private_mode(tmp_path: Path) -> None:
    path = tmp_path / "config.json"
    update_config(path, {"site_title": "One", "nova_api_key": "k"})
    update_config(path, {"site_title": "Two", "nova_api_key": None, "extra": [1, 2]})
    assert json.loads(path.read_text()) == {"site_title": "Two", "extra": [1, 2]}
    assert stat.S_IMODE(path.stat().st_mode) == 0o600
    assert not path.with_suffix(".json.tmp").exists()
    assert sorted(os.listdir(tmp_path)) == ["config.json"]


def test_update_config_refuses_to_overwrite_a_corrupt_file(tmp_path: Path) -> None:
    path = tmp_path / "config.json"
    path.write_text("{oops")
    with pytest.raises(ConfigError) as caught:
        update_config(path, {"site_title": "x"})
    assert caught.value.public == "config.json is not valid JSON; fix or remove it and restart"
    assert str(path) in caught.value.detail  # the path is for the log, never for the public
    assert path.read_text() == "{oops"


def test_update_config_flushes_the_bytes_and_the_rename(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A power cut right after setup must not leave an empty or missing config.json."""
    synced: list[str] = []
    real_fsync = os.fsync

    def record(fd: int) -> None:
        synced.append("dir" if stat.S_ISDIR(os.fstat(fd).st_mode) else "file")
        real_fsync(fd)

    monkeypatch.setattr(os, "fsync", record)
    update_config(tmp_path / "config.json", {"site_title": "One"})
    assert synced == ["file", "dir"]


def test_update_config_survives_a_chmod_that_is_refused(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    """Some volume mounts (and Windows bind mounts) refuse chmod; the write still counts."""

    def refuse(*args: object, **kwargs: object) -> None:
        raise PermissionError("read-only filesystem")

    monkeypatch.setattr(os, "chmod", refuse)
    path = tmp_path / "config.json"
    with caplog.at_level(logging.WARNING, logger="app.config"):
        update_config(path, {"site_title": "One"})
    assert json.loads(path.read_text()) == {"site_title": "One"}
    assert "could not restrict permissions on config.json" in caplog.text


def test_perform_setup_writes_hash_secret_and_optional_fields(tmp_path: Path) -> None:
    before = load_settings(env_for(tmp_path))
    perform_setup(before, "hunter2hunter2", nova_api_key="  key  ", site_title="")
    after = load_settings(env_for(tmp_path))
    assert after.auth_ready and after.setup_required is False
    assert after.password_hash and verify_password("hunter2hunter2", after.password_hash)
    assert after.session_secret and len(after.session_secret) >= 32
    assert after.nova_api_key == "key" and after.site_title == "AstroCaption"
    written = json.loads((tmp_path / "config.json").read_text())
    assert "site_title" not in written and "password" not in written


def test_perform_setup_skips_env_locked_fields(tmp_path: Path) -> None:
    before = load_settings(env_for(tmp_path, NOVA_API_KEY="from-env"))
    assert before.env_locked == {"nova_api_key"}
    perform_setup(before, "hunter2hunter2", nova_api_key="typed-key", site_title="My Sky")
    written = json.loads((tmp_path / "config.json").read_text())
    assert "nova_api_key" not in written
    assert written["site_title"] == "My Sky"
