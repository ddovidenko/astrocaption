"""The fetch script's pure parts. The network part is run by hand (`make fonts`)."""

from __future__ import annotations

import pytest

from scripts.fetch_fonts import FAMILIES, file_name, licence_path, missing_glyphs, parse_css

from .conftest import FONTS_DIR


def block(
    weight: str = "400",
    style: str = "normal",
    srcs: tuple[tuple[str, str], ...] = (
        ("https://fonts.gstatic.com/s/manrope/v1/regular.ttf", "truetype"),
    ),
) -> str:
    """One ``@font-face`` block in the shape the Google Fonts CSS API serves."""
    src = ", ".join(f"url({url}) format('{fmt}')" for url, fmt in srcs)
    return f"""
@font-face {{
  font-family: 'Manrope';
  font-style: {style};
  font-weight: {weight};
  src: {src};
}}
"""


BOLD = block("700", srcs=(("https://fonts.gstatic.com/s/manrope/v1/bold.ttf", "truetype"),))


def test_parse_css_maps_weight_to_ttf_url() -> None:
    assert parse_css(block() + BOLD) == {
        "400": "https://fonts.gstatic.com/s/manrope/v1/regular.ttf",
        "700": "https://fonts.gstatic.com/s/manrope/v1/bold.ttf",
    }


def test_parse_css_rejects_a_response_without_both_weights() -> None:
    with pytest.raises(ValueError, match="700"):
        parse_css(block())


def test_file_names_follow_the_bundle_convention() -> None:
    assert file_name("Roboto Condensed", "400") == "RobotoCondensed-Regular.ttf"
    assert file_name("Source Serif 4", "700") == "SourceSerif4-Bold.ttf"


def test_parse_css_prefers_normal_over_a_preceding_italic_of_the_same_weight() -> None:
    italic = block(
        style="italic",
        srcs=(("https://fonts.gstatic.com/s/manrope/v1/italic.ttf", "truetype"),),
    )
    assert parse_css(italic + block() + BOLD) == {
        "400": "https://fonts.gstatic.com/s/manrope/v1/regular.ttf",
        "700": "https://fonts.gstatic.com/s/manrope/v1/bold.ttf",
    }


def test_parse_css_rejects_two_normal_blocks_of_the_same_weight() -> None:
    second_regular = block(
        srcs=(("https://fonts.gstatic.com/s/manrope/v1/regular-2.ttf", "truetype"),)
    )
    with pytest.raises(ValueError, match="400"):
        parse_css(block() + second_regular + BOLD)


def test_parse_css_raises_when_a_normal_weight_block_has_no_ttf_src() -> None:
    bold_without_ttf = block(
        "700", srcs=(("https://fonts.gstatic.com/s/manrope/v1/bold.woff2", "woff2"),)
    )
    with pytest.raises(ValueError, match="700"):
        parse_css(block() + bold_without_ttf)


def test_parse_css_finds_the_ttf_url_among_several_quoted_srcs() -> None:
    regular_with_woff2 = block(
        srcs=(
            ("https://fonts.gstatic.com/s/manrope/v1/regular.woff2", "woff2"),
            ("https://fonts.gstatic.com/s/manrope/v1/regular.ttf", "truetype"),
        )
    )
    assert parse_css(regular_with_woff2 + BOLD) == {
        "400": "https://fonts.gstatic.com/s/manrope/v1/regular.ttf",
        "700": "https://fonts.gstatic.com/s/manrope/v1/bold.ttf",
    }


def test_twelve_families() -> None:
    assert len(FAMILIES) == 12


def test_licence_path_overrides_ubuntu() -> None:
    assert licence_path("Ubuntu") == "ufl/ubuntu/UFL.txt"
    assert licence_path("Source Serif 4") == "ofl/sourceserif4/OFL.txt"


def test_missing_glyphs_is_empty_for_a_bundled_font() -> None:
    assert missing_glyphs(FONTS_DIR / "Inter-Regular.ttf") == []
