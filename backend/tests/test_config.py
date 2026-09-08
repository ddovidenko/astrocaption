from __future__ import annotations

import json
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
    with pytest.raises(ConfigError):
        update_config(path, {"site_title": "x"})
    assert path.read_text() == "{oops"


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
