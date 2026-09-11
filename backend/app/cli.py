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
            print(
                f"Setup completed: the owner password is stored in {settings.config_path}.",
                file=out,
            )
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
    log.info(
        "owner password %s from the command line", "set" if settings.setup_required else "reset"
    )
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
