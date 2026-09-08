"""Owner settings: read, and write through the atomic config.json writer."""

from __future__ import annotations

import asyncio
import logging

from fastapi import APIRouter, Depends, HTTPException, Request, status

from ..config import ENV_VAR_FOR, ConfigError, Settings, SettingsSource, update_config
from ..fonts import FontNotFoundError, font_path
from ..models import ConfigOut, ConfigUpdate, StyleConfig
from .deps import SettingsDep, require_owner

log = logging.getLogger(__name__)
router = APIRouter(prefix="/api", tags=["config"], dependencies=[Depends(require_owner)])

SIZE_RELATIVE = frozenset({"font_size", "halo_width", "marker_width", "marker_min_radius"})
DATA_DIR_NOT_WRITABLE = (
    "Settings could not be saved: the data directory is not writable. "
    "Check the permissions on ./data and try again."
)


def style_defaults() -> dict[str, object]:
    """Fixed built-ins the page shows for unset fields; sizes are derived per image instead."""
    return {k: v for k, v in StyleConfig().model_dump().items() if k not in SIZE_RELATIVE}


def config_out(settings: Settings) -> ConfigOut:
    return ConfigOut(
        site_title=settings.site_title,
        max_upload_mb=settings.max_upload_mb,
        nova_api_key_set=settings.nova_api_key_set,
        default_style=dict(settings.default_style),
        style_defaults=style_defaults(),
        locked=sorted(settings.env_locked),
    )


@router.get("/config")
async def get_config(settings: SettingsDep) -> ConfigOut:
    return config_out(settings)


def _updates_for(body: ConfigUpdate, settings: Settings) -> dict[str, object | None]:
    """Translate a partial update into config.json changes, or raise a plain 422."""
    locked = sorted(body.model_fields_set & settings.env_locked)
    if locked:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT,
            f"{locked[0]} is set by {ENV_VAR_FOR[locked[0]]}; unset it to change it here.",
        )
    updates: dict[str, object | None] = {}
    if "site_title" in body.model_fields_set and body.site_title is not None:
        title = body.site_title.strip()
        if not title:
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_CONTENT, "site_title must not be blank."
            )
        updates["site_title"] = title
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


@router.put("/config")
async def put_config(body: ConfigUpdate, request: Request, settings: SettingsDep) -> ConfigOut:
    updates = _updates_for(body, settings)
    source: SettingsSource = request.app.state.settings_source
    if updates:
        try:
            await asyncio.to_thread(update_config, settings.config_path, updates)
        except ConfigError as exc:
            raise HTTPException(status.HTTP_409_CONFLICT, exc.public) from exc
        except OSError as exc:
            log.exception("config.json could not be written")
            raise HTTPException(
                status.HTTP_500_INTERNAL_SERVER_ERROR, DATA_DIR_NOT_WRITABLE
            ) from exc
        log.info("config updated: %s", ", ".join(sorted(updates)))  # names only, never values
    return config_out(source.reload())
