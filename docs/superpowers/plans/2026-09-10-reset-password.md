# Lockout Recovery (Milestone 2, PR 3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A shell command that resets the owner password (or completes setup) without the browser, a `make` wrapper for the compose install, the lockout document the docs already point at, and the README quick-start fixes from #6.

**Architecture:** `backend/app/cli.py` is a thin argparse entry point over the pieces that already exist: `load_settings` (same data-dir resolution as the app), `hash_password`, `perform_setup` and the atomic `update_config`. It rewrites only `password_hash` when a password exists (the running app re-reads the file live and every session is invalidated because tokens are bound to the hash), or performs setup when none exists. Prompts go through an injectable `prompt` callable so tests never touch a TTY. Closes #42 and #6.

**Tech Stack:** Python 3.13+ standard library (`argparse`, `getpass`); pytest. No new dependencies.

**Spec:** `docs/SPEC.md` § 10 (lockout recovery, `docker compose exec app python -m app.cli reset-password`, deleting `config.json` re-runs setup while keeping images), § 5.1 step 6 (headless password), CLAUDE.md (`make reset-password`, `docs/LOCKOUT.md`). Design agreed in chat 2026-09-10: interactive prompts only, no `--password-stdin`; exit 1 for a bad password (nothing written), exit 2 for a config or write failure.

## Global Constraints

- Python 3.13+, type hints everywhere, ruff (line length 100, isort), mypy strict. No new dependencies.
- The password and the hash are never printed or logged; the CLI prints one plain sentence per outcome. Paths may appear in CLI output (it runs in the owner's own shell), never in API responses.
- `config.json` is written only through `update_config`; a corrupt file is never overwritten; `session_secret` is kept on a reset (the hash change alone logs everyone out).
- Minimum password length is `MIN_PASSWORD_LENGTH` (8) from `backend/app/auth.py`, the same rule the setup page enforces.
- Exit codes: 0 success, 1 the password was refused (mismatch or too short) and nothing was written, 2 the config could not be read or written.
- Tests never touch the checkout's `data/`; they use `tmp_path` and `env_app_client`.
- Run `make lint test` before every commit that touches code. Conventional commit messages ending with:
  ```
  Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01LZ13YiDRbwh2oJSuC7qHQ6
  ```
- Backend commands run from `backend/` with `.venv/bin/pytest`, `.venv/bin/ruff`, `.venv/bin/mypy`.
- Stop after `gh pr create` and `gh pr checks --watch`; the owner merges.

## File map

| File | Responsibility |
|---|---|
| `backend/app/cli.py` (new) | `reset_password(prompt, env, out, err) -> int`, `main(argv) -> int`, `python -m app.cli` |
| `backend/tests/test_cli.py` (new) | unit tests with an injected prompt; one end-to-end test through the API |
| `Makefile` | `reset-password` target |
| `docs/LOCKOUT.md` (new) | recovery guide |
| `docs/INSTALL.md`, `README.md`, `docs/ARCHITECTURE.md` | pointers, status line, clone step (#6), module row |

---

### Task 1: The `reset-password` command

**Files:**
- Create: `backend/app/cli.py`
- Test: `backend/tests/test_cli.py`

**Interfaces:**
- Consumes: `load_settings(env)`, `update_config(path, updates)`, `ConfigError.public` (`backend/app/config.py`); `hash_password`, `perform_setup(settings, password)`, `MIN_PASSWORD_LENGTH`, `verify_password`, `issue_session`, `session_is_valid` (`backend/app/auth.py`); `env_app_client`, `login` (`backend/tests/conftest.py`).
- Produces: `reset_password(prompt: Callable[[str], str] = getpass.getpass, env: Mapping[str, str] | None = None, out: TextIO = sys.stdout, err: TextIO = sys.stderr) -> int` and `main(argv: list[str] | None = None) -> int`; constants `EXIT_OK = 0`, `EXIT_REFUSED = 1`, `EXIT_CONFIG = 2`.

- [ ] **Step 1: Write the failing tests** — `backend/tests/test_cli.py`

```python
from __future__ import annotations

import io
import json
import os
from collections.abc import Callable
from pathlib import Path

import pytest

from app.auth import hash_password, issue_session, perform_setup, session_is_valid, verify_password
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
    assert not session_is_valid(old_token, str(after["session_secret"]), str(after["password_hash"]))
    assert len(asked) == 2 and "repeat" in asked[1].lower()
    for secret in (NEW, OLD, str(after["password_hash"])):
        assert secret not in out and secret not in err


def test_reset_completes_setup_when_there_is_no_password_yet(tmp_path: Path) -> None:
    code, out, _, _ = run(tmp_path, NEW, NEW)
    assert code == EXIT_OK and "setup" in out.lower()
    s = load_settings(env_for(tmp_path))
    assert s.auth_ready and s.password_hash and verify_password(NEW, s.password_hash)


def test_mismatch_and_short_passwords_write_nothing(tmp_path: Path) -> None:
    perform_setup(load_settings(env_for(tmp_path)), OLD)
    before = (tmp_path / "config.json").read_bytes()

    code, _, err, asked = run(tmp_path, NEW, NEW + "x")
    assert code == EXIT_REFUSED and "do not match" in err and "Nothing was changed" in err
    assert len(asked) == 2

    code, _, err, asked = run(tmp_path, "short")
    assert code == EXIT_REFUSED and "at least 8" in err and "Nothing was changed" in err
    assert len(asked) == 1  # refused before the repeat prompt

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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd backend && .venv/bin/pytest tests/test_cli.py -q`
Expected: `ModuleNotFoundError: No module named 'app.cli'`.

- [ ] **Step 3: Write `backend/app/cli.py`**

```python
"""Owner maintenance from the shell: ``python -m app.cli reset-password`` (docs/LOCKOUT.md).

Runs inside the container (``make reset-password``) or on a source checkout, finding the data
directory exactly as the app does. Nothing here prints or logs a password or a hash.
"""

from __future__ import annotations

import argparse
import getpass
import logging
import sys
from collections.abc import Callable, Mapping
from typing import TextIO

from .auth import MIN_PASSWORD_LENGTH, hash_password, perform_setup
from .config import ConfigError, load_settings, update_config

log = logging.getLogger(__name__)

EXIT_OK = 0
EXIT_REFUSED = 1  # the password was refused; nothing was written
EXIT_CONFIG = 2  # config.json could not be read or written

Prompt = Callable[[str], str]


def reset_password(
    prompt: Prompt | None = None,
    env: Mapping[str, str] | None = None,
    out: TextIO = sys.stdout,
    err: TextIO = sys.stderr,
) -> int:
    """Ask for a new owner password twice and store its hash; complete setup if there is none.

    The running app re-reads config.json as soon as it changes, and every session token is
    bound to the hash, so a reset logs every browser out without a restart (SPEC § 10).
    ``prompt`` defaults to ``getpass.getpass`` at call time, so tests can patch it.
    """
    ask = prompt or getpass.getpass
    settings = load_settings(env)
    if settings.config_error is not None:
        print(f"{settings.config_path}: {settings.config_error}", file=err)
        return EXIT_CONFIG

    password = ask("New owner password: ")
    if len(password) < MIN_PASSWORD_LENGTH:
        print(
            f"Password must be at least {MIN_PASSWORD_LENGTH} characters. Nothing was changed.",
            file=err,
        )
        return EXIT_REFUSED
    if ask("Repeat the new password: ") != password:
        print("The two passwords do not match. Nothing was changed.", file=err)
        return EXIT_REFUSED

    try:
        if settings.setup_required:
            perform_setup(settings, password)
            print(f"Setup completed: the owner password is stored in {settings.config_path}.", file=out)
        else:
            update_config(settings.config_path, {"password_hash": hash_password(password)})
            print("Owner password reset. Every signed-in browser has been logged out.", file=out)
    except ConfigError as exc:  # the file changed under us since it was read
        print(f"{settings.config_path}: {exc.public}", file=err)
        return EXIT_CONFIG
    except OSError as exc:
        reason = exc.strerror or "write failed"
        print(
            f"{settings.config_path} is not writable by this user ({reason}). "
            "Inside the container the app runs as uid 1000; fix the permissions on ./data.",
            file=err,
        )
        return EXIT_CONFIG
    log.info("owner password %s from the command line", "set" if settings.setup_required else "reset")
    return EXIT_OK


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="python -m app.cli", description="AstroCaption owner maintenance."
    )
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser(
        "reset-password",
        help="choose a new owner password (or complete setup); every session is logged out",
    )
    args = parser.parse_args(argv)
    if args.command == "reset-password":
        return reset_password()
    parser.error(f"unknown command {args.command}")  # argparse exits 2


if __name__ == "__main__":
    logging.basicConfig(level=logging.WARNING, format="%(levelname)s %(name)s: %(message)s")
    sys.exit(main())
```

Note for mypy: `parser.error` returns `NoReturn`, so `main` type-checks without a trailing `return`. If mypy still complains, end with `return EXIT_REFUSED  # unreachable`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd backend && .venv/bin/pytest tests/test_cli.py -q`
Expected: 7 passed (6 if running as root).

- [ ] **Step 5: Lint, full suite, commit**

```bash
cd backend && .venv/bin/ruff check . && .venv/bin/ruff format . && .venv/bin/mypy && .venv/bin/pytest -q
cd .. && git add backend && git commit -m "feat(cli): reset-password command that rewrites the hash or completes setup"
```

---

### Task 2: `make reset-password`, LOCKOUT.md, INSTALL, README (#6), ARCHITECTURE

**Files:**
- Modify: `Makefile` (target + `.PHONY`)
- Create: `docs/LOCKOUT.md`
- Modify: `docs/INSTALL.md` (the "Forgot the password" paragraph in "First run"), `README.md` (status line, quick start), `docs/ARCHITECTURE.md` (module table)

**Interfaces:**
- Consumes: the command from Task 1 (`python -m app.cli reset-password`, exit codes 0/1/2).

- [ ] **Step 1: Makefile**

Add `reset-password` to the `.PHONY` list and, after the `up` target:

```make
reset-password: ## Choose a new owner password inside the running container (docs/LOCKOUT.md)
	docker compose exec app python -m app.cli reset-password
```

Check: `make help` lists it; `make -n reset-password` prints the compose command.

- [ ] **Step 2: `docs/LOCKOUT.md`**

```markdown
# Locked out

Three situations, three fixes. None of them touches your images, exports or the database.

## Wrong password too many times

Five wrong passwords start a 60-second cooldown; the sign-in page says how long to wait.
Wait it out and try again. The counter is in memory, so restarting the container also
clears it.

## Forgot the password

Choose a new one from the shell. With the compose install:

```sh
make reset-password
# or, without make:
docker compose exec app python -m app.cli reset-password
```

Running from source (`make dev`):

```sh
cd backend && .venv/bin/python -m app.cli reset-password
```

It asks for the new password twice (at least 8 characters, nothing is echoed), rewrites the
password hash in `data/config.json`, and prints one line. The running app picks the file up
at once: every signed-in browser is logged out, and the new password works immediately.
Your nova key, site title and default style stay as they were.

Exit codes: 0 done; 1 the password was refused (too short or the two entries differed) and
nothing was written; 2 `config.json` could not be read or written (the message says why).

## Setup never completed, or `config.json` is damaged

If the site still shows the setup page you can finish setup from the shell with the same
command, or set `ASTROCAPTION_PASSWORD` for one start (see `docs/INSTALL.md`, "First run").

If `config.json` cannot be read, the app refuses to sign anyone in and the sign-in page
says so. Fix the JSON, or remove the file: removing it reopens setup and forgets the
password, the nova key, the site title and the default style, nothing else. Removing only
the `password_hash` line reopens setup and keeps the rest.

`config.json` is written by the app as uid 1000 with owner-only permissions, so editing it
on the host may need `sudo`.
```

- [ ] **Step 3: INSTALL, README, ARCHITECTURE**

`docs/INSTALL.md`, in "First run": replace the interim recovery paragraph (the one that starts "Forgot the password: stop the container, delete the `password_hash` line") with:

```markdown
Forgot the password: `make reset-password` (or `docker compose exec app python -m app.cli
reset-password`) asks for a new one and logs every browser out; see `docs/LOCKOUT.md` for the
other lockout cases.
```

Also update the status line at the top to: `> Status: milestone 2. Upload, solve, export, the owner login, the config page and the lockout tools work; the editor arrives in milestone 3.`

`README.md`: status paragraph becomes:

```markdown
Status: **milestone 2** (upload → solve → auto-placed labels → export, behind an owner login, with
a config page). The editor is milestone 3; see `docs/SPEC.md` § 13 for the roadmap.
```

and the quick start becomes:

```sh
git clone https://github.com/ddovidenko/astrocaption.git && cd astrocaption
export NOVA_API_KEY=...            # from your nova.astrometry.net profile (or add it later on the config page)
docker compose up -d --build
```

followed by the line: `Then visit http://localhost:8080 and choose the owner password.` Add `- Locked out: \`docs/LOCKOUT.md\`` to the links list.

`docs/ARCHITECTURE.md`: add the row `| \`app/cli.py\` | \`python -m app.cli reset-password\`: rewrites the password hash (or completes setup) through the same writer as the API. |`.

- [ ] **Step 4: Verify and commit**

Run: `make lint test` (docs and Makefile only, but the gate is the rule). Also `make -n reset-password`.

```bash
git add Makefile docs README.md
git commit -m "docs: LOCKOUT.md, make reset-password, README clone step and visit line"
```

- [ ] **Step 5: Push and PR**

```bash
git push -u origin feat/reset-password
gh pr create --title "feat: reset-password command, LOCKOUT.md and README quick start" --body "$(cat <<'EOF'
Milestone 2, PR 3 of 4. Closes #42, closes #6.

- `python -m app.cli reset-password`: asks twice without echo, rewrites `password_hash` through the atomic writer (every session is logged out at once, nothing else changes) or completes setup when there is no password; exit 1 refuses without writing, exit 2 for a config that cannot be read or written
- `make reset-password` wraps it for the compose install
- `docs/LOCKOUT.md` covers the cooldown, the reset, and re-running setup; INSTALL points at it
- README: clone step, "then visit" line, milestone 2 status

🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_01LZ13YiDRbwh2oJSuC7qHQ6
EOF
)"
gh pr checks --watch
```

Then stop: the owner merges.
