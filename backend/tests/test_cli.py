from __future__ import annotations

import errno
import io
import json
import os
from collections.abc import Callable
from pathlib import Path

import pytest

from app.auth import issue_session, perform_setup, session_is_valid, verify_password
from app.cli import EXIT_CONFIG, EXIT_OK, EXIT_REFUSED, main, reset_password
from app.config import load_settings
from tests.conftest import FONTS_DIR, env_app_client, login

OLD, NEW = "old-password-1", "new-password-22"


def env_for(tmp_path: Path) -> dict[str, str]:
    return {"ASTROCAPTION_DATA_DIR": str(tmp_path), "ASTROCAPTION_FONTS_DIR": str(FONTS_DIR)}


def prompts(*answers: str) -> tuple[list[str], Callable[[str], str]]:
    """A prompt that hands out ``answers`` in order and records what it was asked."""
    asked: list[str] = []
    it = iter(answers)

    def prompt(text: str) -> str:
        asked.append(text)
        return next(it)

    return asked, prompt


def run(tmp_path: Path, *answers: str) -> tuple[int, str, str, list[str]]:
    asked, prompt = prompts(*answers)
    out, err = io.StringIO(), io.StringIO()
    code = reset_password(prompt=prompt, env=env_for(tmp_path), out=out, err=err)
    return code, out.getvalue(), err.getvalue(), asked


def read_config(tmp_path: Path) -> dict[str, object]:
    data: dict[str, object] = json.loads((tmp_path / "config.json").read_text())
    return data


def test_reset_rewrites_only_the_hash_and_logs_everyone_out(tmp_path: Path) -> None:
    perform_setup(load_settings(env_for(tmp_path)), OLD, site_title="Sky")
    before = read_config(tmp_path)
    old_token = issue_session(str(before["session_secret"]), str(before["password_hash"]))

    code, out, err, asked = run(tmp_path, NEW, NEW)

    assert code == EXIT_OK and err == ""
    assert "reset" in out.lower() and "logged out" in out.lower()
    after = read_config(tmp_path)
    assert after["session_secret"] == before["session_secret"] and after["site_title"] == "Sky"
    assert verify_password(NEW, str(after["password_hash"]))
    assert not verify_password(OLD, str(after["password_hash"]))
    assert not session_is_valid(
        old_token, str(after["session_secret"]), str(after["password_hash"])
    )
    assert len(asked) == 2 and "repeat" in asked[1].lower()
    for secret in (NEW, OLD, str(after["password_hash"])):
        assert secret not in out and secret not in err


def test_reset_completes_setup_when_there_is_no_password_yet(tmp_path: Path) -> None:
    code, out, _, _ = run(tmp_path, NEW, NEW)
    assert code == EXIT_OK and "setup" in out.lower()
    s = load_settings(env_for(tmp_path))
    assert s.auth_ready and s.password_hash and verify_password(NEW, s.password_hash)


def test_reset_completes_setup_from_a_half_written_config(tmp_path: Path) -> None:
    """A password_hash with no session_secret can't authenticate anyone; setup runs again."""
    (tmp_path / "config.json").write_text(json.dumps({"password_hash": "not-checked"}))

    code, out, _, _ = run(tmp_path, NEW, NEW)

    assert code == EXIT_OK and "setup" in out.lower()
    after = read_config(tmp_path)
    assert after.get("password_hash") and after.get("session_secret")
    assert verify_password(NEW, str(after["password_hash"]))


def test_mismatch_and_short_and_long_passwords_write_nothing(tmp_path: Path) -> None:
    perform_setup(load_settings(env_for(tmp_path)), OLD)
    before = (tmp_path / "config.json").read_bytes()

    code, _, err, asked = run(tmp_path, NEW, NEW + "x")
    assert code == EXIT_REFUSED and "do not match" in err and "Nothing was changed" in err
    assert len(asked) == 2

    code, _, err, asked = run(tmp_path, "short")
    assert code == EXIT_REFUSED and "at least 8" in err and "Nothing was changed" in err
    assert len(asked) == 1  # refused before the repeat prompt

    code, _, err, asked = run(tmp_path, "x" * 1025)
    assert code == EXIT_REFUSED and "at most 1024" in err and "Nothing was changed" in err
    assert len(asked) == 1  # refused before the repeat prompt

    assert (tmp_path / "config.json").read_bytes() == before


def test_cancelled_prompt_writes_nothing(tmp_path: Path) -> None:
    perform_setup(load_settings(env_for(tmp_path)), OLD)
    before = (tmp_path / "config.json").read_bytes()

    def prompt(_text: str) -> str:
        raise EOFError

    out, err = io.StringIO(), io.StringIO()
    code = reset_password(prompt=prompt, env=env_for(tmp_path), out=out, err=err)

    assert code == EXIT_REFUSED and "Cancelled" in err.getvalue()
    assert (tmp_path / "config.json").read_bytes() == before


def test_foreign_owned_config_is_refused(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Run as root (e.g. by mistake) on a source checkout, the write would leave a root-owned
    config.json the app (uid 1000) can no longer read: a harder lockout than the one being
    fixed. Refuse before prompting when the file belongs to someone else."""
    perform_setup(load_settings(env_for(tmp_path)), OLD)
    before = (tmp_path / "config.json").read_bytes()
    real_uid = (tmp_path / "config.json").stat().st_uid
    monkeypatch.setattr("app.cli.os.geteuid", lambda: real_uid + 1)

    code, _, err, asked = run(tmp_path, NEW, NEW)

    assert code == EXIT_CONFIG and "belongs to another user" in err and asked == []
    assert (tmp_path / "config.json").read_bytes() == before


def test_corrupt_config_is_left_alone(tmp_path: Path) -> None:
    (tmp_path / "config.json").write_text("{oops")
    code, _, err, asked = run(tmp_path, NEW, NEW)
    assert code == EXIT_CONFIG and "not valid JSON" in err and asked == []
    assert (tmp_path / "config.json").read_text() == "{oops"


@pytest.mark.skipif(os.geteuid() == 0, reason="root ignores directory permissions")
def test_unwritable_data_dir_is_reported(tmp_path: Path) -> None:
    perform_setup(load_settings(env_for(tmp_path)), OLD)
    tmp_path.chmod(0o500)
    try:
        code, _, err, _ = run(tmp_path, NEW, NEW)
    finally:
        tmp_path.chmod(0o700)
    assert code == EXIT_CONFIG and "not writable" in err
    assert verify_password(OLD, str(read_config(tmp_path)["password_hash"]))


def test_disk_full_is_reported(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    perform_setup(load_settings(env_for(tmp_path)), OLD)

    def boom(*_args: object, **_kwargs: object) -> None:
        raise OSError(errno.ENOSPC, "no space")

    monkeypatch.setattr("app.cli.update_config", boom)
    code, _, err, _ = run(tmp_path, NEW, NEW)

    assert code == EXIT_CONFIG and "could not be written" in err and "no space" in err
    assert verify_password(OLD, str(read_config(tmp_path)["password_hash"]))


def test_main_wires_argparse_to_getpass(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    for name, value in env_for(tmp_path).items():
        monkeypatch.setenv(name, value)
    answers = iter([NEW, NEW])
    monkeypatch.setattr("app.cli.getpass.getpass", lambda _prompt: next(answers))
    assert main(["reset-password"]) == EXIT_OK
    assert load_settings(env_for(tmp_path)).auth_ready
    with pytest.raises(SystemExit) as excinfo:
        main([])
    assert excinfo.value.code == 2


def test_running_app_picks_up_the_reset(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    with env_app_client(tmp_path, monkeypatch) as client:
        assert client.post("/api/setup", json={"password": OLD}).status_code == 204
        login(client, OLD)
        assert client.get("/api/images").status_code == 200

        out, err = io.StringIO(), io.StringIO()
        _, prompt = prompts(NEW, NEW)
        assert reset_password(prompt=prompt, env=os.environ, out=out, err=err) == EXIT_OK

        assert client.get("/api/images").status_code == 401  # the old session is gone
        assert client.post("/api/login", json={"password": OLD}).status_code == 401
        login(client, NEW)
        assert client.get("/api/images").status_code == 200
