from __future__ import annotations

from app.layout import default_style
from tests.conftest import FONTS_DIR


def test_default_style_clamps_to_model_bounds() -> None:
    style = default_style(20300, 8000, FONTS_DIR)  # s = 20.3: raw values exceed the bounds
    assert style.font_size == 200
    assert style.halo_width == 40
    assert style.marker_width == 30
    assert style.marker_min_radius == 122


def test_default_style_drops_unknown_font_but_keeps_other_overrides() -> None:
    style = default_style(3000, 2000, FONTS_DIR, {"font_file": "Nope.ttf", "font_size": 40})
    assert style.font_file == "Inter-Regular.ttf"
    assert style.font_size == 40


def test_default_style_accepts_bundled_font() -> None:
    style = default_style(3000, 2000, FONTS_DIR, {"font_file": "Roboto-Bold.ttf"})
    assert style.font_file == "Roboto-Bold.ttf"
