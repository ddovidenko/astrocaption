"""Owner maintenance from the shell: ``python -m app.cli reset-password`` (docs/LOCKOUT.md).

Runs inside the container (``make reset-password``) or on a source checkout
(``make reset-password-dev``), finding the data directory exactly as the app does. Nothing
here prints or logs a password or a hash.
"""

from __future__ import annotations

import argparse
import errno
import getpass
import logging
import os
import sys
from collections.abc import Callable, Mapping
from pathlib import Path
from typing import TextIO

from .auth import hash_password, perform_setup, validate_new_password
from .config import ConfigError, Settings, load_settings, update_config

log = logging.getLogger(__name__)

EXIT_OK = 0
EXIT_REFUSED = 1  # the password was refused, or the prompt was cancelled; nothing was written
EXIT_CONFIG = 3  # config.json could not be read or written (argparse already uses 2 for usage)

Prompt = Callable[[str], str]

UNCHANGED = "Nothing was changed."
CANCELLED_MESSAGE = f"Cancelled. {UNCHANGED}"
ENCODING_MESSAGE = (
    "The password could not be read as text; check the terminal's character encoding "
    f"(LANG/LC_ALL) and try again. {UNCHANGED}"
)
UNEXPECTED_MESSAGE = "Something went wrong; nothing was changed. See the message above."


def _config_owner(settings: Settings) -> tuple[int | None, Path, str | None]:
    """Who owns config.json, or the data directory when there is no config.json yet.

    Returns ``(uid, the path it came from, None)``; ``(None, path, message)`` when the owner
    cannot be read at all; and ``(None, config_path, None)`` when neither exists yet, which
    is a fresh install this command may create.
    """
    for path in (settings.config_path, settings.data_dir):
        try:
            return path.stat().st_uid, path, None
        except FileNotFoundError:
            continue  # no config.json yet: the directory that will hold it decides
        except OSError as exc:
            reason = exc.strerror or "cannot be read"
            return None, path, f"{path} could not be read ({reason}). {UNCHANGED}"
    return None, settings.config_path, None


def _foreign_owner_message(path: Path, owner_uid: int, euid: int) -> str:
    if owner_uid == 0:
        return f"{path} is owned by root; restore it with: sudo chown {euid} {path}  {UNCHANGED}"
    return (
        f"{path} belongs to uid {owner_uid}; run this command as that user. Inside the "
        f"container: make reset-password; on a source checkout: make reset-password-dev. "
        f"{UNCHANGED}"
    )


def reset_password(
    prompt: Prompt | None = None,
    env: Mapping[str, str] | None = None,
    out: TextIO | None = None,
    err: TextIO | None = None,
) -> int:
    """Ask for a new owner password twice and store its hash; complete setup if there is none.

    The running app re-reads config.json as soon as it changes, and every session token is
    bound to the hash, so a reset logs every browser out without a restart (SPEC § 10).
    ``prompt``, ``out`` and ``err`` default to ``getpass.getpass``/``sys.stdout``/``sys.stderr``
    at call time, so tests can patch or replace them.
    """
    ask = prompt or getpass.getpass
    out = out or sys.stdout
    err = err or sys.stderr
    settings = load_settings(env)

    owner_uid, owned_path, problem = _config_owner(settings)
    if problem is not None:
        print(problem, file=err)
        return EXIT_CONFIG
    euid = os.geteuid()
    if owner_uid is not None and owner_uid != euid:
        # Writing anyway would publish a file the app's own user can no longer read: a
        # harder lockout than the one being fixed. Refuse before asking for anything.
        print(_foreign_owner_message(owned_path, owner_uid, euid), file=err)
        return EXIT_CONFIG

    if settings.config_error is not None:
        print(f"{settings.config_path}: {settings.config_error}", file=err)
        return EXIT_CONFIG

    def ask_or_refuse(text: str) -> tuple[str | None, str]:
        """``(password, "")`` or ``(None, why it could not be read)``."""
        try:
            return ask(text), ""
        except (EOFError, KeyboardInterrupt):
            return None, CANCELLED_MESSAGE
        except UnicodeDecodeError:  # a terminal handing over bytes this locale cannot decode
            return None, ENCODING_MESSAGE
        except OSError as exc:  # no controlling terminal, /dev/tty gone, closed stdin
            reason = exc.strerror or "the prompt failed"
            return None, f"The password prompt could not be used ({reason}). {UNCHANGED}"

    password, refusal = ask_or_refuse("New owner password: ")
    if password is None:
        print(refusal, file=err)
        return EXIT_REFUSED
    too = validate_new_password(password)
    if too is not None:
        print(f"{too} {UNCHANGED}", file=err)
        return EXIT_REFUSED

    repeat, refusal = ask_or_refuse("Repeat the new password: ")
    if repeat is None:
        print(refusal, file=err)
        return EXIT_REFUSED
    if repeat != password:
        print(f"The two passwords do not match. {UNCHANGED}", file=err)
        return EXIT_REFUSED

    # Read again: typing a password takes as long as the owner takes, and config.json may
    # have been set up, reset or removed meanwhile. Which write is right is decided here.
    settings = load_settings(env)
    try:
        if settings.setup_required:
            perform_setup(settings, password)
            done = f"Setup completed: the owner password hash is stored in {settings.config_path}."
        else:
            update_config(settings.config_path, {"password_hash": hash_password(password)})
            done = "Owner password reset. Every signed-in browser has been logged out."
    except ConfigError as exc:  # the file changed under us since it was read
        log.error("config.json could not be used: %s", exc.detail)
        print(exc.public, file=err)
        return EXIT_CONFIG
    except OSError as exc:
        if exc.errno in (errno.EACCES, errno.EPERM):
            reason = exc.strerror or "permission denied"
            print(
                f"{settings.config_path} is not writable by this user ({reason}). "
                f"Inside the container the app runs as uid 1000; fix the permissions on "
                f"./data. {UNCHANGED}",
                file=err,
            )
        else:
            reason = exc.strerror or "write failed"
            print(f"{settings.config_path} could not be written ({reason}). {UNCHANGED}", file=err)
        return EXIT_CONFIG

    if not load_settings(env).auth_ready:
        # Someone else rewrote the file between the read above and the write: the result
        # cannot sign anybody in, so do not claim it can.
        print(
            f"{settings.config_path} changed while the password was being typed and is now "
            "incomplete; run the command again.",
            file=err,
        )
        return EXIT_CONFIG
    print(done, file=out)
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


def run(argv: list[str] | None = None) -> int:
    """``main`` with a last resort: an unexpected failure is a log line, not a traceback."""
    try:
        return main(argv)
    except Exception:
        log.exception("reset-password failed")
        print(UNEXPECTED_MESSAGE, file=sys.stderr)
        return EXIT_CONFIG


if __name__ == "__main__":
    # ERROR, not WARNING: load_settings warns with the path and the decoder's own words when
    # config.json is unreadable, and this command already says that in plain language.
    logging.basicConfig(level=logging.ERROR, format="%(levelname)s %(name)s: %(message)s")
    sys.exit(run())
