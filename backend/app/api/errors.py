"""Failure text shared by the routes that write config.json (setup and the config page)."""

from __future__ import annotations

from fastapi import HTTPException, status

from ..config import DISK_FULL_ERRNOS, ConfigError, write_failure_message

__all__ = ["DISK_FULL_ERRNOS", "config_write_error", "write_failure_message"]


def config_write_error(exc: ConfigError | OSError, subject: str) -> HTTPException:
    """The response for a failed config.json write; the reason itself stays in the log."""
    if isinstance(exc, ConfigError):
        return HTTPException(status.HTTP_409_CONFLICT, exc.public)
    return HTTPException(
        status.HTTP_500_INTERNAL_SERVER_ERROR,
        write_failure_message(subject, disk_full=exc.errno in DISK_FULL_ERRNOS),
    )
