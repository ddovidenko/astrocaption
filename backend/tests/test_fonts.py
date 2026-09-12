"""Every bundled font must render what a label can contain (SPEC § 9).

Bayer designations carry Greek letters (θ1 Ori C), alias lines use the middle dot and some
common names an apostrophe. A font that lacks a glyph makes Pillow draw its missing-glyph box
while the browser silently substitutes a system font, and preview and export stop agreeing.
fetch_fonts.py runs this same check on every TTF as it fetches it; this test exercises the
bundled files that are already on disk.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from app.fonts import DEFAULT_FONT_FILE, FONT_SIZES, list_fonts, load_font, resolve_font_file
from app.models import MAX_FONT_SIZE, MIN_FONT_SIZE
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


def test_resolve_font_file_logs_when_the_default_itself_is_missing(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    """An empty fonts dir is missing both the requested font and the default; both are logged.

    No cache_clear() needed: tmp_path is a fresh directory per test, so it is a fresh
    lru_cache key regardless of what other tests have already resolved.
    """
    with caplog.at_level("WARNING"):
        resolved = resolve_font_file(tmp_path, "Gone-Regular.ttf")
    assert resolved == DEFAULT_FONT_FILE
    assert any("Gone-Regular.ttf" in r.message and r.levelname == "WARNING" for r in caplog.records)
    assert any(DEFAULT_FONT_FILE in r.message and r.levelname == "ERROR" for r in caplog.records)


def test_ascent_table_is_the_renderers_metric_at_every_size() -> None:
    """Design § 2: the canvas draws on the alphabetic baseline at ``y + ascent`` and takes the
    ascent from ``GET /api/fonts``; it must be exactly what ``draw.text`` uses for the export.
    FreeType rounds in 26.6 fixed point, so the table is measured, never derived from a ratio."""
    fonts = list_fonts(FONTS_DIR)
    assert fonts, "no bundled fonts found"
    for font in fonts:
        assert len(font.ascents) == MAX_FONT_SIZE - MIN_FONT_SIZE + 1
        expected = [load_font(FONTS_DIR, font.file, size).getmetrics()[0] for size in FONT_SIZES]
        assert font.ascents == expected, font.file
