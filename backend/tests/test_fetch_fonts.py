"""The fetch script's pure parts. The network part is run by hand (`make fonts`)."""

from __future__ import annotations

import pytest

from scripts.fetch_fonts import FAMILIES, file_name, parse_css

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


def test_family_list_is_the_twelve_from_the_spec() -> None:
    assert [f.name for f in FAMILIES] == [
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
    assert all(f.licence.endswith(("OFL.txt", "UFL.txt")) for f in FAMILIES)
