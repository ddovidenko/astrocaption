"""Owner settings: read, and write through the atomic config.json writer."""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Mapping
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Request, status

from ..config import ConfigError, Settings, SettingsSource, update_config
from ..fonts import list_fonts
from ..models import ConfigOut, ConfigUpdate, StyleConfig, StyleDefaults
from .deps import SettingsDep, require_owner
from .errors import config_write_error, write_failure_message

log = logging.getLogger(__name__)
router = APIRouter(prefix="/api", tags=["config"], dependencies=[Depends(require_owner)])

DATA_DIR_FULL = write_failure_message("Settings", disk_full=True)
DATA_DIR_NOT_WRITABLE = write_failure_message("Settings", disk_full=False)
CONFIG_SAVED_BUT_UNREADABLE = (
    "The settings were written, but config.json could not be read back. "
    "Reload the page; if the settings look wrong, check the server log."
)

# Fixed built-ins the page shows for unset fields; sizes are derived per image instead.
# ``StyleDefaults`` lists exactly the non-size fields, so validating the model's defaults
# through it drops the size ones (a test pins the two field sets against each other).
STYLE_DEFAULTS = StyleDefaults.model_validate(StyleConfig(), from_attributes=True)


def style_defaults() -> dict[str, object]:
    return STYLE_DEFAULTS.model_dump()


def config_out(settings: Settings) -> ConfigOut:
    return ConfigOut(
        site_title=settings.site_title,
        max_upload_mb=settings.max_upload_mb,
        nova_api_key_set=settings.nova_api_key_set,
        default_style=dict(settings.default_style),
        style_defaults=STYLE_DEFAULTS,
        locked=sorted(settings.locked_by),
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
    locked = sorted(body.model_fields_set & settings.locked_by.keys())
    if locked:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT, _locked_message(locked, settings)
        )
    updates: dict[str, object | None] = {}
    if body.site_title is not None:
        updates["site_title"] = body.site_title  # the model already stripped and length-checked it
    if body.max_upload_mb is not None:
        updates["max_upload_mb"] = body.max_upload_mb
    if "nova_api_key" in body.model_fields_set:  # only here does an explicit null mean something
        key = (body.nova_api_key or "").strip()
        updates["nova_api_key"] = key or None  # null (or blank) clears the key
    if body.default_style is not None:
        overrides = body.default_style.overrides()
        font = overrides.get("font_file")
        # The same cached list the page offers, so a font is savable iff it is selectable.
        if isinstance(font, str) and font not in {f.file for f in list_fonts(settings.fonts_dir)}:
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_CONTENT,
                "default_style.font_file is not a bundled font.",
            )
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
    lock: asyncio.Lock = request.app.state.config_write_lock
    async with lock:  # two saves (or a save and setup) must not read-modify-write over each other
        try:
            fresh = await asyncio.to_thread(
                _write_and_reload, source, settings.config_path, updates
            )
        except (ConfigError, OSError) as exc:
            if isinstance(exc, OSError):
                log.exception("config.json could not be written")
            raise config_write_error(exc, "Settings") from exc
    log.info("config updated: %s", ", ".join(sorted(updates)))  # names only, never values
    if fresh.config_error is not None:  # the write landed, the file no longer parses
        log.error("config.json unusable immediately after a write: %s", fresh.config_error)
        raise HTTPException(status.HTTP_500_INTERNAL_SERVER_ERROR, CONFIG_SAVED_BUT_UNREADABLE)
    return config_out(fresh)
