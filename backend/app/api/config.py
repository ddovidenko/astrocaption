"""Owner settings: read, and write through the atomic config.json writer."""

from __future__ import annotations

import asyncio
import errno
import logging
from collections.abc import Mapping
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Request, status

from ..config import ConfigError, Settings, SettingsSource, update_config
from ..fonts import FontNotFoundError, font_path
from ..layout import SIZE_RELATIVE
from ..models import ConfigOut, ConfigUpdate, StyleConfig, StyleDefaults
from .deps import SettingsDep, require_owner

log = logging.getLogger(__name__)
router = APIRouter(prefix="/api", tags=["config"], dependencies=[Depends(require_owner)])

DATA_DIR_FULL = (
    "Settings could not be saved: the disk holding ./data is full. Free some space and try again."
)
DATA_DIR_NOT_WRITABLE = (
    "Settings could not be saved: the server could not write to ./data. The server log says why."
)
CONFIG_SAVED_BUT_UNREADABLE = (
    "The settings were written, but config.json could not be read back. "
    "Reload the page; if the settings look wrong, check the server log."
)
DISK_FULL_ERRNOS = {errno.ENOSPC, errno.EDQUOT}


def style_defaults() -> dict[str, object]:
    """Fixed built-ins the page shows for unset fields; sizes are derived per image instead."""
    return StyleConfig().model_dump(exclude=set(SIZE_RELATIVE))


def config_out(settings: Settings) -> ConfigOut:
    return ConfigOut(
        site_title=settings.site_title,
        max_upload_mb=settings.max_upload_mb,
        nova_api_key_set=settings.nova_api_key_set,
        default_style=dict(settings.default_style),
        style_defaults=StyleDefaults.model_validate(style_defaults()),
        locked=sorted(settings.env_locked),
        locked_by=dict(settings.locked_by),
    )


@router.get("/config")
async def get_config(settings: SettingsDep) -> ConfigOut:
    return config_out(settings)


def _locked_message(locked: list[str], settings: Settings) -> str:
    if len(locked) == 1:
        return f"{locked[0]} is set by {settings.locked_by[locked[0]]}; unset it to change it here."
    named = ", ".join(f"{name} ({settings.locked_by[name]})" for name in locked)
    return f"{named} are set by the environment; unset them to change them here."


def _updates_for(body: ConfigUpdate, settings: Settings) -> dict[str, object | None]:
    """Translate a partial update into config.json changes, or raise a plain 422."""
    locked = sorted(body.model_fields_set & settings.env_locked)
    if locked:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT, _locked_message(locked, settings)
        )
    updates: dict[str, object | None] = {}
    if "site_title" in body.model_fields_set and body.site_title is not None:
        updates["site_title"] = body.site_title  # the model already stripped and length-checked it
    if "max_upload_mb" in body.model_fields_set and body.max_upload_mb is not None:
        updates["max_upload_mb"] = body.max_upload_mb
    if "nova_api_key" in body.model_fields_set:
        key = (body.nova_api_key or "").strip()
        updates["nova_api_key"] = key or None  # null (or blank) clears the key
    if body.default_style is not None:
        overrides = body.default_style.overrides()
        font = overrides.get("font_file")
        if isinstance(font, str):
            try:
                font_path(settings.fonts_dir, font)
            except FontNotFoundError:
                raise HTTPException(
                    status.HTTP_422_UNPROCESSABLE_CONTENT,
                    "default_style.font_file is not a bundled font.",
                ) from None
        updates["default_style"] = overrides or None  # an empty set removes the key
    return updates


def _write_and_reload(
    source: SettingsSource, path: Path, updates: Mapping[str, object | None]
) -> Settings:
    """One thread hop for the whole write: both halves block on the filesystem."""
    update_config(path, updates)
    return source.reload()


@router.put("/config")
async def put_config(body: ConfigUpdate, request: Request, settings: SettingsDep) -> ConfigOut:
    updates = _updates_for(body, settings)
    if not updates:  # nothing to change: never rewrite the file that holds the secrets
        return config_out(settings)
    source: SettingsSource = request.app.state.settings_source
    lock: asyncio.Lock = request.app.state.config_lock
    async with lock:  # two saves at once must not read-modify-write over each other
        try:
            fresh = await asyncio.to_thread(
                _write_and_reload, source, settings.config_path, updates
            )
        except ConfigError as exc:
            raise HTTPException(status.HTTP_409_CONFLICT, exc.public) from exc
        except OSError as exc:
            log.exception("config.json could not be written")
            full = exc.errno in DISK_FULL_ERRNOS
            raise HTTPException(
                status.HTTP_500_INTERNAL_SERVER_ERROR,
                DATA_DIR_FULL if full else DATA_DIR_NOT_WRITABLE,
            ) from exc
    log.info("config updated: %s", ", ".join(sorted(updates)))  # names only, never values
    if fresh.config_error is not None:  # the write landed, the file no longer parses
        log.error("config.json unusable immediately after a write: %s", fresh.config_error)
        raise HTTPException(status.HTTP_500_INTERNAL_SERVER_ERROR, CONFIG_SAVED_BUT_UNREADABLE)
    return config_out(fresh)
