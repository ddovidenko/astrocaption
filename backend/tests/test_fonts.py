"""Every bundled font must render what a label can contain (SPEC § 9).

Bayer designations carry Greek letters (θ1 Ori C), alias lines use the middle dot and some
common names an apostrophe. A font that lacks a glyph makes Pillow draw its missing-glyph box
while the browser silently substitutes a system font, and preview and export stop agreeing.
"""

from __future__ import annotations

import pytest
from PIL import Image, ImageDraw, ImageFont

from app.fonts import list_fonts

from .conftest import FONTS_DIR

REQUIRED_GLYPHS = "θιυλμ·’"
NOT_A_CHARACTER = "￿"  # never mapped by any font: renders the .notdef box
SIZE = 60


def _ink(font: ImageFont.FreeTypeFont, text: str) -> bytes:
    img = Image.new("L", (SIZE * 2, SIZE * 2), 0)
    ImageDraw.Draw(img).text((SIZE // 2, SIZE // 2), text, font=font, fill=255)
    return img.tobytes()


@pytest.mark.parametrize("file", [f.file for f in list_fonts(FONTS_DIR)])
def test_bundled_font_has_every_label_glyph(file: str) -> None:
    font = ImageFont.truetype(str(FONTS_DIR / file), SIZE)
    notdef = _ink(font, NOT_A_CHARACTER)
    missing = [ch for ch in REQUIRED_GLYPHS if _ink(font, ch) == notdef]
    assert not missing, f"{file} cannot render {''.join(missing)!r}"


def test_bundle_is_twelve_families_regular_and_bold() -> None:
    files = sorted(f.file for f in list_fonts(FONTS_DIR))
    assert len(files) == 24
    families = {name.rsplit("-", 1)[0] for name in files}
    assert len(families) == 12
    for family in families:
        assert f"{family}-Regular.ttf" in files and f"{family}-Bold.ttf" in files
