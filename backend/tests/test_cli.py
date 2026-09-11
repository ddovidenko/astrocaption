from __future__ import annotations

import errno
import io
import json
import logging
import os
import stat
from collections.abc import Callable
from pathlib import Path

import pytest

from app.auth import issue_session, perform_setup, session_is_valid, verify_password
from app.cli import EXIT_CONFIG, EXIT_OK, EXIT_REFUSED, main, reset_password, run
from app.config import CONFIG_NOT_JSON, ConfigError, load_settings, update_config
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


def raising_prompt(exc: BaseException, *answers: str) -> Callable[[str], str]:
    """Answers ``answers``, then fails with ``exc`` (a terminal that stops working midway)."""
    it = iter(answers)

    def prompt(_text: str) -> str:
        try:
            return next(it)
        except StopIteration:
            raise exc from None

    return prompt


def stat_reporting_uid(uid: int) -> Callable[..., os.stat_result]:
    """A ``Path.stat`` that claims every path is a 0600 regular file owned by ``uid``."""

    def fake_stat(_self: Path, **_kwargs: object) -> os.stat_result:
        return os.stat_result((stat.S_IFREG | 0o600, 1, 1, 1, uid, uid, 10, 0, 0, 0))

    return fake_stat


def run_cli(tmp_path: Path, *answers: str) -> tuple[int, str, str, list[str]]:
    asked, prompt = prompts(*answers)
    out, err = io.StringIO(), io.StringIO()
    code = reset_password(prompt=prompt, env=env_for(tmp_path), out=out, err=err)
    return code, out.getvalue(), err.getvalue(), asked


def run_with(tmp_path: Path, prompt: Callable[[str], str]) -> tuple[int, str, str]:
    out, err = io.StringIO(), io.StringIO()
    code = reset_password(prompt=prompt, env=env_for(tmp_path), out=out, err=err)
    return code, out.getvalue(), err.getvalue()


def read_config(tmp_path: Path) -> dict[str, object]:
    data: dict[str, object] = json.loads((tmp_path / "config.json").read_text())
    return data


def test_reset_rewrites_only_the_hash_and_logs_everyone_out(tmp_path: Path) -> None:
    perform_setup(load_settings(env_for(tmp_path)), OLD, site_title="Sky")
    before = read_config(tmp_path)
    old_token = issue_session(str(before["session_secret"]), str(before["password_hash"]))

    code, out, err, asked = run_cli(tmp_path, NEW, NEW)

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
    assert stat.S_IMODE((tmp_path / "config.json").stat().st_mode) == 0o600  # still private
    for secret in (NEW, OLD, str(after["password_hash"])):
        assert secret not in out and secret not in err


def test_reset_completes_setup_when_there_is_no_password_yet(tmp_path: Path) -> None:
    code, out, _, _ = run_cli(tmp_path, NEW, NEW)
    assert code == EXIT_OK and "setup" in out.lower()
    s = load_settings(env_for(tmp_path))
    assert s.auth_ready and s.password_hash and verify_password(NEW, s.password_hash)


def test_reset_completes_setup_from_a_half_written_config(tmp_path: Path) -> None:
    """A password_hash with no session_secret can't authenticate anyone; setup runs again."""
    (tmp_path / "config.json").write_text(json.dumps({"password_hash": "not-checked"}))

    code, out, _, _ = run_cli(tmp_path, NEW, NEW)

    assert code == EXIT_OK and "setup" in out.lower()
    after = read_config(tmp_path)
    assert after.get("password_hash") and after.get("session_secret")
    assert verify_password(NEW, str(after["password_hash"]))


def test_mismatch_and_short_and_long_passwords_write_nothing(tmp_path: Path) -> None:
    perform_setup(load_settings(env_for(tmp_path)), OLD)
    before = (tmp_path / "config.json").read_bytes()

    code, _, err, asked = run_cli(tmp_path, NEW, NEW + "x")
    assert code == EXIT_REFUSED and "do not match" in err and "Nothing was changed" in err
    assert len(asked) == 2

    code, _, err, asked = run_cli(tmp_path, "short")
    assert code == EXIT_REFUSED and "at least 8" in err and "Nothing was changed" in err
    assert len(asked) == 1  # refused before the repeat prompt

    code, _, err, asked = run_cli(tmp_path, "x" * 1025)
    assert code == EXIT_REFUSED and "at most 1024" in err and "Nothing was changed" in err
    assert len(asked) == 1  # refused before the repeat prompt

    assert (tmp_path / "config.json").read_bytes() == before


def test_cancelled_prompt_writes_nothing(tmp_path: Path) -> None:
    perform_setup(load_settings(env_for(tmp_path)), OLD)
    before = (tmp_path / "config.json").read_bytes()

    for exc, answers in ((EOFError(), ()), (KeyboardInterrupt(), ()), (EOFError(), (NEW,))):
        code, out, err = run_with(tmp_path, raising_prompt(exc, *answers))
        assert code == EXIT_REFUSED and "Cancelled" in err and out == ""
        assert (tmp_path / "config.json").read_bytes() == before  # secret and hash intact


def test_a_prompt_that_cannot_be_read_as_text_writes_nothing(tmp_path: Path) -> None:
    perform_setup(load_settings(env_for(tmp_path)), OLD)
    before = (tmp_path / "config.json").read_bytes()
    broken = UnicodeDecodeError("utf-8", b"\xff", 0, 1, "invalid start byte")

    code, out, err = run_with(tmp_path, raising_prompt(broken))

    assert code == EXIT_REFUSED and out == ""
    assert "character encoding" in err and "LANG" in err and "Nothing was changed" in err
    assert (tmp_path / "config.json").read_bytes() == before


def test_a_prompt_that_cannot_be_used_writes_nothing(tmp_path: Path) -> None:
    """No controlling terminal (a cron job, a detached exec): say so, do not crash."""
    perform_setup(load_settings(env_for(tmp_path)), OLD)
    before = (tmp_path / "config.json").read_bytes()
    no_tty = OSError(errno.ENOTTY, "Inappropriate ioctl for device")

    code, out, err = run_with(tmp_path, raising_prompt(no_tty))

    assert code == EXIT_REFUSED and out == ""
    assert "prompt could not be used" in err and "Inappropriate ioctl" in err
    assert "Nothing was changed" in err
    assert (tmp_path / "config.json").read_bytes() == before


def test_foreign_owned_config_is_refused(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Run as the wrong user on a source checkout, the write would leave a config.json the
    app can no longer read: a harder lockout than the one being fixed. Refuse before
    prompting when the file belongs to someone else."""
    perform_setup(load_settings(env_for(tmp_path)), OLD)
    before = (tmp_path / "config.json").read_bytes()
    real_uid = (tmp_path / "config.json").stat().st_uid
    monkeypatch.setattr("app.cli.os.geteuid", lambda: real_uid + 1)

    code, _, err, asked = run_cli(tmp_path, NEW, NEW)

    assert code == EXIT_CONFIG and asked == []
    assert f"belongs to uid {real_uid}" in err and "make reset-password-dev" in err
    assert "Nothing was changed" in err
    assert (tmp_path / "config.json").read_bytes() == before


@pytest.mark.skipif(os.geteuid() == 0, reason="running as root, the refusal does not apply")
def test_a_root_owned_config_names_the_chown_that_fixes_it(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The classic self-inflicted lockout: `sudo` on the command, once."""
    perform_setup(load_settings(env_for(tmp_path)), OLD)
    before = (tmp_path / "config.json").read_bytes()
    monkeypatch.setattr(Path, "stat", stat_reporting_uid(0))

    code, _, err, asked = run_cli(tmp_path, NEW, NEW)

    assert code == EXIT_CONFIG and asked == []
    assert "owned by root" in err and f"sudo chown {os.geteuid()} " in err
    assert "Nothing was changed" in err
    assert (tmp_path / "config.json").read_bytes() == before


def test_a_foreign_data_dir_is_refused_before_the_file_exists(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """No config.json yet: the directory that would hold it decides who may write it."""
    real_uid = tmp_path.stat().st_uid
    monkeypatch.setattr("app.cli.os.geteuid", lambda: real_uid + 1)

    code, _, err, asked = run_cli(tmp_path, NEW, NEW)

    assert code == EXIT_CONFIG and asked == []
    assert str(tmp_path) in err and f"belongs to uid {real_uid}" in err
    assert not (tmp_path / "config.json").exists()


def test_an_unreadable_owner_is_reported(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    perform_setup(load_settings(env_for(tmp_path)), OLD)
    before = (tmp_path / "config.json").read_bytes()

    def refuse(_self: Path, **_kwargs: object) -> os.stat_result:
        raise PermissionError(errno.EACCES, "Permission denied")

    monkeypatch.setattr(Path, "stat", refuse)

    code, _, err, asked = run_cli(tmp_path, NEW, NEW)

    assert code == EXIT_CONFIG and asked == []
    assert "could not be read (Permission denied)" in err and "Nothing was changed" in err
    assert (tmp_path / "config.json").read_bytes() == before


def test_corrupt_config_is_left_alone(tmp_path: Path) -> None:
    (tmp_path / "config.json").write_text("{oops")
    code, _, err, asked = run_cli(tmp_path, NEW, NEW)
    assert code == EXIT_CONFIG and "not valid JSON" in err and asked == []
    assert str(tmp_path / "config.json") in err  # the path first, like every other refusal
    assert (tmp_path / "config.json").read_text() == "{oops"


@pytest.mark.skipif(os.geteuid() == 0, reason="root ignores directory permissions")
def test_unwritable_data_dir_is_reported(tmp_path: Path) -> None:
    perform_setup(load_settings(env_for(tmp_path)), OLD)
    before = (tmp_path / "config.json").read_bytes()
    tmp_path.chmod(0o500)
    try:
        code, out, err, _ = run_cli(tmp_path, NEW, NEW)
    finally:
        tmp_path.chmod(0o700)
    assert code == EXIT_CONFIG and out == ""
    assert "not writable" in err and "Nothing was changed" in err
    assert (tmp_path / "config.json").read_bytes() == before
    assert verify_password(OLD, str(read_config(tmp_path)["password_hash"]))


def test_disk_full_is_reported(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    perform_setup(load_settings(env_for(tmp_path)), OLD)
    before = (tmp_path / "config.json").read_bytes()

    def boom(*_args: object, **_kwargs: object) -> None:
        raise OSError(errno.ENOSPC, "no space")

    monkeypatch.setattr("app.cli.update_config", boom)
    code, out, err, _ = run_cli(tmp_path, NEW, NEW)

    assert code == EXIT_CONFIG and out == ""
    assert "could not be written" in err and "no space" in err
    assert (tmp_path / "config.json").read_bytes() == before


def test_a_failed_setup_write_is_reported(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """The setup branch writes through ``app.auth``; its failures reach the same message."""

    def boom(*_args: object, **_kwargs: object) -> None:
        raise OSError(errno.ENOSPC, "no space")

    monkeypatch.setattr("app.auth.update_config", boom)
    code, out, err, _ = run_cli(tmp_path, NEW, NEW)

    assert code == EXIT_CONFIG and out == ""
    assert "could not be written" in err and "no space" in err
    assert not (tmp_path / "config.json").exists()


def test_a_config_error_on_the_write_path_is_logged_and_shown_in_plain_language(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    perform_setup(load_settings(env_for(tmp_path)), OLD)
    before = (tmp_path / "config.json").read_bytes()

    def boom(*_args: object, **_kwargs: object) -> None:
        raise ConfigError(CONFIG_NOT_JSON, "line 3 column 5")

    monkeypatch.setattr("app.cli.update_config", boom)
    with caplog.at_level(logging.ERROR, logger="app.cli"):
        code, out, err, _ = run_cli(tmp_path, NEW, NEW)

    assert code == EXIT_CONFIG and out == "" and CONFIG_NOT_JSON in err
    assert "line 3 column 5" in caplog.text  # the reason is for the log
    assert "line 3 column 5" not in err  # ... not for the person at the terminal
    assert (tmp_path / "config.json").read_bytes() == before


def test_a_config_removed_while_typing_completes_setup_instead_of_half_resetting(
    tmp_path: Path,
) -> None:
    """Deciding from the read taken before the prompts would write a hash into an empty
    file - no session_secret, nobody can sign in - and call it a reset."""
    perform_setup(load_settings(env_for(tmp_path)), OLD)
    answers = iter([NEW, NEW])

    def prompt(_text: str) -> str:
        value = next(answers)
        (tmp_path / "config.json").unlink(missing_ok=True)
        return value

    code, out, err = run_with(tmp_path, prompt)

    assert code == EXIT_OK and err == ""
    assert "setup" in out.lower() and "reset" not in out.lower()
    after = load_settings(env_for(tmp_path))
    assert after.auth_ready and after.password_hash
    assert verify_password(NEW, after.password_hash)


def test_a_config_left_incomplete_by_the_write_is_reported(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Another writer dropped the session_secret as the hash was going in: the file cannot
    sign anybody in, so the command must not claim it can."""
    perform_setup(load_settings(env_for(tmp_path)), OLD)

    def strip_the_secret_then_write(path: Path, updates: dict[str, object | None]) -> None:
        data = json.loads(path.read_text())
        data.pop("session_secret")
        path.write_text(json.dumps(data))
        update_config(path, updates)

    monkeypatch.setattr("app.cli.update_config", strip_the_secret_then_write)
    code, out, err, _ = run_cli(tmp_path, NEW, NEW)

    assert code == EXIT_CONFIG and out == ""
    assert "changed while the password was being typed" in err
    assert not load_settings(env_for(tmp_path)).auth_ready


def test_main_wires_argparse_to_getpass(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    for name, value in env_for(tmp_path).items():
        monkeypatch.setenv(name, value)
    answers = iter([NEW, NEW])
    monkeypatch.setattr("app.cli.getpass.getpass", lambda _prompt: next(answers))
    assert main(["reset-password"]) == EXIT_OK
    assert load_settings(env_for(tmp_path)).auth_ready
    with pytest.raises(SystemExit) as excinfo:
        main([])
    assert excinfo.value.code == 2  # argparse's usage error, never EXIT_CONFIG


def test_run_turns_an_unexpected_failure_into_one_line(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
    caplog: pytest.LogCaptureFixture,
) -> None:
    def boom(*_args: object, **_kwargs: object) -> int:
        raise RuntimeError("something nobody predicted")

    monkeypatch.setattr("app.cli.reset_password", boom)
    with caplog.at_level(logging.ERROR, logger="app.cli"):
        code = run(["reset-password"])

    assert code == EXIT_CONFIG
    assert "Something went wrong; nothing was changed." in capsys.readouterr().err
    assert "something nobody predicted" in caplog.text  # the traceback stays in the log


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
