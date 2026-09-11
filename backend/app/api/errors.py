"""Failure text shared by the routes that write config.json (setup and the config page)."""

from __future__ import annotations

import errno

from fastapi import HTTPException, status

from ..config import ConfigError

DISK_FULL_ERRNOS = frozenset({errno.ENOSPC, errno.EDQUOT})


def write_failure_message(subject: str, *, disk_full: bool) -> str:
    """What the owner is told when ``subject`` could not be written to ./data."""
    if disk_full:
        return (
            f"{subject} could not be saved: the disk holding ./data is full. "
            "Free some space and try again."
        )
    return (
        f"{subject} could not be saved: the server could not write to ./data. "
        "The server log says why."
    )


def config_write_error(exc: ConfigError | OSError, subject: str) -> HTTPException:
    """The response for a failed config.json write; the reason itself stays in the log."""
    if isinstance(exc, ConfigError):
        return HTTPException(status.HTTP_409_CONFLICT, exc.public)
    return HTTPException(
        status.HTTP_500_INTERNAL_SERVER_ERROR,
        write_failure_message(subject, disk_full=exc.errno in DISK_FULL_ERRNOS),
    )
