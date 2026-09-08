"""Owner settings. ``PUT`` arrives with the config page (milestone 2, PR 2)."""

from __future__ import annotations

from fastapi import APIRouter, Depends

from ..config import Settings
from ..models import ConfigOut, StyleConfig
from .deps import SettingsDep, require_owner

router = APIRouter(prefix="/api", tags=["config"], dependencies=[Depends(require_owner)])

SIZE_RELATIVE = frozenset({"font_size", "halo_width", "marker_width", "marker_min_radius"})


def style_defaults() -> dict[str, object]:
    """Fixed built-ins the page shows for unset fields; sizes are derived per image instead."""
    return {k: v for k, v in StyleConfig().model_dump().items() if k not in SIZE_RELATIVE}


def config_out(settings: Settings) -> ConfigOut:
    return ConfigOut(
        site_title=settings.site_title,
        max_upload_mb=settings.max_upload_mb,
        nova_api_key_set=settings.nova_api_key_set,
        default_style=dict(settings.default_style),
        locked=sorted(settings.env_locked),
        style_defaults=style_defaults(),
    )


@router.get("/config")
async def get_config(settings: SettingsDep) -> ConfigOut:
    return config_out(settings)
