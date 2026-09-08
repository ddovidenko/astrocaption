from __future__ import annotations

from fastapi import APIRouter

from .. import __version__
from ..models import HealthOut
from .deps import SettingsDep

router = APIRouter(prefix="/api", tags=["health"])


@router.get("/health")
async def health(settings: SettingsDep) -> HealthOut:
    return HealthOut(
        version=__version__,
        site_title=settings.site_title,
        nova_api_key_set=settings.nova_api_key_set,
    )
