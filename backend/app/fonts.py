"""Bundled font registry. Fonts are always referenced by file name (CLAUDE.md)."""

from __future__ import annotations

import logging
from functools import lru_cache
from pathlib import Path

from PIL import ImageFont

from .models import FontOut, StyleConfig

log = logging.getLogger(__name__)

DEFAULT_FONT_FILE = StyleConfig().font_file


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
def resolve_font_file(fonts_dir: Path, file: str) -> str:
    """``file`` if it is a bundled font, else the built-in default with a warning.

    Stored styles outlive the bundle (a family can be dropped in an upgrade); rendering and
    placement must keep working, and the warning names the file so the owner can pick another.
    Cached so a stored style with a gone font logs once per process, not once per request.
    """
    try:
        font_path(fonts_dir, file)
    except LookupError:
        log.warning("font %r is not bundled; using %s", file, DEFAULT_FONT_FILE)
        try:
            font_path(fonts_dir, DEFAULT_FONT_FILE)
        except LookupError:
            log.error("default font %s is missing from the fonts directory", DEFAULT_FONT_FILE)
        return DEFAULT_FONT_FILE
    return file


def resolved_style(fonts_dir: Path, style: StyleConfig) -> StyleConfig:
    """``style`` unchanged when its font is bundled, else with the font swapped for the default."""
    font = resolve_font_file(fonts_dir, style.font_file)
    if font == style.font_file:
        return style
    return style.model_copy(update={"font_file": font})


@lru_cache(maxsize=512)
def load_font(fonts_dir: Path, file: str, size: int) -> ImageFont.FreeTypeFont:
    return ImageFont.truetype(str(font_path(fonts_dir, file)), size)


@lru_cache(maxsize=8)
def list_fonts(fonts_dir: Path) -> list[FontOut]:
    fonts: list[FontOut] = []
    for path in sorted(fonts_dir.glob("*.ttf")):
        try:
            family, style = ImageFont.truetype(str(path), 24).getname()
        except OSError:  # a truncated or non-TTF file must not cost the page its font list
            log.warning("skipping unreadable font %s", path.name)
            continue
        fonts.append(FontOut(file=path.name, family=family or path.stem, weight=style or "Regular"))
    return fonts
