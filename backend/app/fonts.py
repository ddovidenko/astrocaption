"""Bundled font registry. Fonts are always referenced by file name (CLAUDE.md)."""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path

from PIL import ImageFont

from .models import FontOut


class FontNotFoundError(LookupError):
    pass


def font_path(fonts_dir: Path, file: str) -> Path:
    """Resolve a bundled font by file name, refusing anything that is not a plain name."""
    if not file or Path(file).name != file or not file.lower().endswith(".ttf"):
        raise FontNotFoundError(file)
    path = fonts_dir / file
    if not path.is_file():
        raise FontNotFoundError(file)
    return path


@lru_cache(maxsize=512)
def load_font(fonts_dir: Path, file: str, size: int) -> ImageFont.FreeTypeFont:
    return ImageFont.truetype(str(font_path(fonts_dir, file)), size)


@lru_cache(maxsize=8)
def list_fonts(fonts_dir: Path) -> list[FontOut]:
    fonts: list[FontOut] = []
    for path in sorted(fonts_dir.glob("*.ttf")):
        family, style = ImageFont.truetype(str(path), 24).getname()
        fonts.append(FontOut(file=path.name, family=family or path.stem, weight=style or "Regular"))
    return fonts
