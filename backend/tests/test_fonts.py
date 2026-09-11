"""Every bundled font must render what a label can contain (SPEC § 9).

Bayer designations carry Greek letters (θ1 Ori C), alias lines use the middle dot and some
common names an apostrophe. A font that lacks a glyph makes Pillow draw its missing-glyph box
while the browser silently substitutes a system font, and preview and export stop agreeing.
"""

from __future__ import annotations

import pytest
from PIL import Image, ImageDraw, ImageFont

from app.fonts import list_fonts
from scripts.fetch_fonts import FAMILIES, WEIGHTS, _slug, file_name

from .conftest import FONTS_DIR

# Every lowercase Greek letter alpha-omega (including final sigma), since a Bayer
# designation can use any of them, plus the middle dot and the curly apostrophe.
REQUIRED_GLYPHS = "".join(chr(c) for c in range(0x3B1, 0x3CA)) + "·’"
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
    blank = _ink(font, "")
    missing = [ch for ch in REQUIRED_GLYPHS if _ink(font, ch) in (notdef, blank)]
    assert not missing, f"{file} cannot render {''.join(missing)!r}"


def test_bundle_matches_the_family_list() -> None:
    fonts = {p.name for p in FONTS_DIR.glob("*.ttf")}
    assert fonts == {file_name(family, weight) for family in FAMILIES for weight in WEIGHTS}
    licences = {p.name for p in (FONTS_DIR / "LICENSES").glob("*.txt")}
    assert licences == {_slug(family) + ".txt" for family in FAMILIES}
