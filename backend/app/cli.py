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
from typing import TextIO

from .auth import set_owner_password, validate_new_password
from .config import (
    DISK_FULL_ERRNOS,
    ConfigError,
    Settings,
    load_settings,
    write_failure_message,
)

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


def _owner_problem(settings: Settings) -> str | None:
    """Why this process must not write config.json, or None when it may.

    ``update_config`` publishes the file with ``os.replace``, so whoever runs this command
    becomes its owner. A root run against a uid-1000 install would leave a file the app can
    no longer read: a harder lockout than the one being fixed. The directory decides when
    there is no config.json yet (a fresh install this command may create).
    """
    euid = os.geteuid()
    for path in (settings.config_path, settings.data_dir):
        try:
            owner = path.stat().st_uid
        except FileNotFoundError:
            continue
        except OSError as exc:
            return f"{path} could not be read ({exc.strerror or 'cannot be read'}). {UNCHANGED}"
        if owner == euid:
            return None
        if owner == 0:
            return (
                f"{path} is owned by root; restore it with: sudo chown {euid} {path}  {UNCHANGED}"
            )
        return (
            f"{path} belongs to uid {owner}; run this command as that user. Inside the "
            f"container: make reset-password; on a source checkout: make reset-password-dev. "
            f"{UNCHANGED}"
        )
    return None


def reset_password(
    prompt: Prompt | None = None,
    env: Mapping[str, str] | None = None,
    out: TextIO | None = None,
    err: TextIO | None = None,
) -> int:
    """Ask for a new owner password twice and store it; complete setup if there is none.

    The running app re-reads config.json as soon as it changes, and every session token is
    bound to the hash, so a reset logs every browser out without a restart (SPEC § 10).
    ``prompt``, ``out`` and ``err`` default to ``getpass.getpass``/``sys.stdout``/``sys.stderr``
    at call time, so tests can patch or replace them.
    """
    ask = prompt or getpass.getpass
    out = out or sys.stdout
    err = err or sys.stderr

    def refuse(message: str, code: int = EXIT_REFUSED) -> int:
        print(message, file=err)
        return code

    settings = load_settings(env)
    if (problem := _owner_problem(settings)) is not None:
        return refuse(problem, EXIT_CONFIG)
    if settings.config_error is not None:
        return refuse(f"{settings.config_path}: {settings.config_error}", EXIT_CONFIG)

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
        return refuse(refusal)
    if (too := validate_new_password(password)) is not None:
        return refuse(f"{too} {UNCHANGED}")
    repeat, refusal = ask_or_refuse("Repeat the new password: ")
    if repeat is None:
        return refuse(refusal)
    if repeat != password:
        return refuse(f"The two passwords do not match. {UNCHANGED}")

    # Read again: typing a password takes as long as the owner takes, and config.json may
    # have been set up, reset or removed meanwhile. The write is the same either way (a new
    # hash and session secret: the hash change alone logs every browser out); the second
    # read only decides what to call it.
    settings = load_settings(env)
    was_setup = settings.setup_required
    try:
        set_owner_password(settings, password)
    except ConfigError as exc:  # the file changed under us since it was read
        log.error("config.json could not be used: %s", exc.detail)
        return refuse(exc.public, EXIT_CONFIG)
    except OSError as exc:
        if exc.errno in (errno.EACCES, errno.EPERM):
            reason = exc.strerror or "permission denied"
            return refuse(
                f"{settings.config_path} is not writable by this user ({reason}). "
                f"Inside the container the app runs as uid 1000; fix the permissions on "
                f"./data. {UNCHANGED}",
                EXIT_CONFIG,
            )
        sentence = write_failure_message("The password", disk_full=exc.errno in DISK_FULL_ERRNOS)
        return refuse(f"{sentence} {UNCHANGED}", EXIT_CONFIG)

    if not load_settings(env).auth_ready:
        # Someone else rewrote the file between the read above and the write: the result
        # cannot sign anybody in, so do not claim it can.
        return refuse(
            f"{settings.config_path} changed while the password was being typed and is now "
            "incomplete; run the command again.",
            EXIT_CONFIG,
        )
    if was_setup:
        print(
            f"Setup completed: the owner password hash is stored in {settings.config_path}.",
            file=out,
        )
    else:
        print("Owner password reset. Every signed-in browser has been logged out.", file=out)
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
    parser.parse_args(argv)  # the only command; argparse rejects anything else with exit 2
    return reset_password()


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
