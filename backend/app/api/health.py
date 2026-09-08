from __future__ import annotations

from fastapi import APIRouter, Request

from .. import __version__
from ..models import HealthOut
from .deps import SettingsDep, is_authenticated

router = APIRouter(prefix="/api", tags=["health"])


@router.get("/health")
async def health(request: Request, settings: SettingsDep) -> HealthOut:
    return HealthOut(
        version=__version__,
        site_title=settings.site_title,
        setup_required=settings.setup_required,
        authenticated=is_authenticated(request, settings),
        config_error=settings.config_error,
    )
