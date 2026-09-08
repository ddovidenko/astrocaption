from __future__ import annotations

from fastapi import APIRouter, Depends

from ..fonts import list_fonts
from ..models import FontOut
from .deps import SettingsDep, require_owner

router = APIRouter(prefix="/api", tags=["fonts"], dependencies=[Depends(require_owner)])


@router.get("/fonts")
async def fonts(settings: SettingsDep) -> list[FontOut]:
    return list_fonts(settings.fonts_dir)
