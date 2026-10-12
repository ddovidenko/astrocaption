"""Failure text shared by the routes that write config.json (setup, the config page, the
password change)."""

from __future__ import annotations

import logging
from collections.abc import Iterator
from contextlib import contextmanager

from fastapi import HTTPException, status

from ..config import DISK_FULL_ERRNOS, ConfigError, Settings, write_failure_message

log = logging.getLogger(__name__)

__all__ = [
    "CONFIG_SAVED_BUT_UNREADABLE",
    "DISK_FULL_ERRNOS",
    "config_state_error",
    "config_write_error",
    "config_write_guard",
    "write_failure_message",
]

CONFIG_SAVED_BUT_UNREADABLE = (
    "The settings were written, but config.json could not be read back. "
    "Reload the page; if the settings look wrong, check the server log."
)


def config_write_error(exc: ConfigError | OSError, subject: str) -> HTTPException:
    """The response for a failed config.json write; the reason itself stays in the log."""
    if isinstance(exc, ConfigError):
        # The file stopped being usable between the check and the write. The public sentence
        # says so in plain language; only the log gets to say why. A file the server could not
        # read is its fault (500); one that is there but unusable is the owner's state (409).
        log.error("%s could not be saved: %s", subject, exc.detail)
        return HTTPException(_config_status(exc.fault), exc.public)
    return HTTPException(
        status.HTTP_500_INTERNAL_SERVER_ERROR,
        write_failure_message(subject, disk_full=exc.errno in DISK_FULL_ERRNOS),
    )


def _config_status(fault: bool) -> int:
    return status.HTTP_500_INTERNAL_SERVER_ERROR if fault else status.HTTP_409_CONFLICT


def config_state_error(settings: Settings) -> HTTPException:
    """The response for a route that cannot proceed because config.json is unusable (#47):
    a read fault is a 500, a file that parses wrong or not at all is a 409. Only for settings
    whose ``config_error`` is set."""
    assert settings.config_error is not None
    return HTTPException(_config_status(settings.config_fault), settings.config_error)


@contextmanager
def config_write_guard(subject: str, log_message: str) -> Iterator[None]:
    """Turn a failed config.json write into the plain-language response it deserves.

    ``subject`` names what could not be saved, in the sentence the owner reads;
    ``log_message`` is the line an OSError is logged under (with its traceback, which never
    reaches the response). Every route that writes config.json goes through here, so none of
    them can drift into answering with a raw exception.
    """
    try:
        yield
    except (ConfigError, OSError) as exc:
        if isinstance(exc, OSError):
            log.exception(log_message)
        raise config_write_error(exc, subject) from exc
