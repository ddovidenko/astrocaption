from __future__ import annotations

from fastapi import APIRouter

from ..fonts import list_fonts
from ..models import FontOut
from .deps import SettingsDep

router = APIRouter(prefix="/api", tags=["fonts"])


@router.get("/fonts")
async def fonts(settings: SettingsDep) -> list[FontOut]:
    return list_fonts(settings.fonts_dir)
