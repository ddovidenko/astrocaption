"""Every bundled font must render what a label can contain (SPEC § 9).

Bayer designations carry Greek letters (θ1 Ori C), alias lines use the middle dot and some
common names an apostrophe. A font that lacks a glyph makes Pillow draw its missing-glyph box
while the browser silently substitutes a system font, and preview and export stop agreeing.
fetch_fonts.py runs this same check on every TTF as it fetches it; this test exercises the
bundled files that are already on disk.
"""

from __future__ import annotations

import pytest

from app.fonts import list_fonts
from scripts.fetch_fonts import FAMILIES, WEIGHTS, file_name, licence_file_name, missing_glyphs

from .conftest import FONTS_DIR


@pytest.mark.parametrize("file", [f.file for f in list_fonts(FONTS_DIR)])
def test_bundled_font_has_every_label_glyph(file: str) -> None:
    missing = missing_glyphs(FONTS_DIR / file)
    assert not missing, f"{file} cannot render {''.join(missing)!r}"


def test_bundle_matches_the_family_list() -> None:
    fonts = {p.name for p in FONTS_DIR.glob("*.ttf")}
    assert fonts == {file_name(family, weight) for family in FAMILIES for weight in WEIGHTS}
    licences = {p.name for p in (FONTS_DIR / "LICENSES").glob("*.txt")}
    assert licences == {licence_file_name(family) for family in FAMILIES}
