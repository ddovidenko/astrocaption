"""The fetch script's pure parts. The network part is run by hand (`make fonts`)."""

from __future__ import annotations

import pytest

from scripts.fetch_fonts import FAMILIES, file_name, licence_path, parse_css

CSS = """
@font-face {
  font-family: 'Manrope';
  font-style: normal;
  font-weight: 400;
  src: url(https://fonts.gstatic.com/s/manrope/v1/regular.ttf) format('truetype');
}
@font-face {
  font-family: 'Manrope';
  font-style: normal;
  font-weight: 700;
  src: url(https://fonts.gstatic.com/s/manrope/v1/bold.ttf) format('truetype');
}
"""


def test_parse_css_maps_weight_to_ttf_url() -> None:
    assert parse_css(CSS) == {
        "400": "https://fonts.gstatic.com/s/manrope/v1/regular.ttf",
        "700": "https://fonts.gstatic.com/s/manrope/v1/bold.ttf",
    }


def test_parse_css_rejects_a_response_without_both_weights() -> None:
    with pytest.raises(ValueError, match="700"):
        parse_css("@font-face" + CSS.split("@font-face")[1])


def test_file_names_follow_the_bundle_convention() -> None:
    assert file_name("Roboto Condensed", "400") == "RobotoCondensed-Regular.ttf"
    assert file_name("Source Serif 4", "700") == "SourceSerif4-Bold.ttf"


def test_parse_css_prefers_normal_over_a_preceding_italic_of_the_same_weight() -> None:
    css = """
@font-face {
  font-family: 'Manrope';
  font-style: italic;
  font-weight: 400;
  src: url(https://fonts.gstatic.com/s/manrope/v1/italic.ttf) format('truetype');
}
@font-face {
  font-family: 'Manrope';
  font-style: normal;
  font-weight: 400;
  src: url(https://fonts.gstatic.com/s/manrope/v1/regular.ttf) format('truetype');
}
@font-face {
  font-family: 'Manrope';
  font-style: normal;
  font-weight: 700;
  src: url(https://fonts.gstatic.com/s/manrope/v1/bold.ttf) format('truetype');
}
"""
    assert parse_css(css) == {
        "400": "https://fonts.gstatic.com/s/manrope/v1/regular.ttf",
        "700": "https://fonts.gstatic.com/s/manrope/v1/bold.ttf",
    }


def test_parse_css_rejects_two_normal_blocks_of_the_same_weight() -> None:
    css = """
@font-face {
  font-family: 'Manrope';
  font-style: normal;
  font-weight: 400;
  src: url(https://fonts.gstatic.com/s/manrope/v1/regular.ttf) format('truetype');
}
@font-face {
  font-family: 'Manrope';
  font-style: normal;
  font-weight: 400;
  src: url(https://fonts.gstatic.com/s/manrope/v1/regular-2.ttf) format('truetype');
}
@font-face {
  font-family: 'Manrope';
  font-style: normal;
  font-weight: 700;
  src: url(https://fonts.gstatic.com/s/manrope/v1/bold.ttf) format('truetype');
}
"""
    with pytest.raises(ValueError, match="400"):
        parse_css(css)


def test_parse_css_raises_when_a_normal_weight_block_has_no_ttf_src() -> None:
    css = """
@font-face {
  font-family: 'Manrope';
  font-style: normal;
  font-weight: 400;
  src: url(https://fonts.gstatic.com/s/manrope/v1/regular.ttf) format('truetype');
}
@font-face {
  font-family: 'Manrope';
  font-style: normal;
  font-weight: 700;
  src: url(https://fonts.gstatic.com/s/manrope/v1/bold.woff2) format('woff2');
}
"""
    with pytest.raises(ValueError, match="700"):
        parse_css(css)


def test_parse_css_finds_the_ttf_url_among_several_quoted_srcs() -> None:
    css = """
@font-face {
  font-family: 'Manrope';
  font-style: normal;
  font-weight: 400;
  src: url( 'https://fonts.gstatic.com/s/manrope/v1/regular.woff2' ) format('woff2'),
       url("https://fonts.gstatic.com/s/manrope/v1/regular.ttf") format('truetype');
}
@font-face {
  font-family: 'Manrope';
  font-style: normal;
  font-weight: 700;
  src: url(https://fonts.gstatic.com/s/manrope/v1/bold.ttf) format('truetype');
}
"""
    assert parse_css(css) == {
        "400": "https://fonts.gstatic.com/s/manrope/v1/regular.ttf",
        "700": "https://fonts.gstatic.com/s/manrope/v1/bold.ttf",
    }


def test_family_list_is_the_twelve_from_the_spec() -> None:
    assert FAMILIES == [
        "Inter",
        "Roboto",
        "Open Sans",
        "Source Sans 3",
        "Fira Sans",
        "IBM Plex Sans",
        "JetBrains Mono",
        "Ubuntu",
        "Manrope",
        "Roboto Condensed",
        "Play",
        "Source Serif 4",
    ]
    assert licence_path("Ubuntu") == "ufl/ubuntu/UFL.txt"
    assert licence_path("Source Serif 4") == "ofl/sourceserif4/OFL.txt"
