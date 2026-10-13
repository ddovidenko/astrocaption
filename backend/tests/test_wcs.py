"""The stored WCS header, parsed and projected (SPEC § 5.2 "Local catalogue", #17)."""

from __future__ import annotations

import pytest

from app.wcs import Wcs, WcsError, parse_cards
from tests.conftest import NOVA_FIXTURES, NOVA_NARROW_FIXTURES

ORION = (NOVA_FIXTURES / "wcs.fits").read_text(encoding="ascii")
PELICAN = (NOVA_NARROW_FIXTURES / "wcs.fits").read_text(encoding="ascii")


def test_parse_cards_reads_numbers_strings_and_ignores_comments() -> None:
    cards = parse_cards(ORION)
    assert cards["CTYPE1"] == "RA---TAN-SIP"
    assert cards["CRVAL1"] == pytest.approx(84.4663663446)
    assert cards["IMAGEW"] == 3000
    assert cards["A_ORDER"] == 2
    assert "SIMPLE" in cards and cards["SIMPLE"] == "T"


def test_wcs_from_text_reads_the_orion_header() -> None:
    wcs = Wcs.from_text(ORION)
    assert wcs.width == 3000 and wcs.height == 2250
    assert wcs.crpix == pytest.approx((599.724601746, 964.673423767))
    assert wcs.a[(2, 0)] == pytest.approx(7.07500197684e-07)
    assert wcs.bp[(0, 0)] == pytest.approx(-1.60105921188e-05)


def card(key: str, value: str) -> str:
    return f"{key:<8}= {value:<70}"[:80]


MINIMAL_TAN = "".join(
    card(k, v)
    for k, v in [
        ("CTYPE1", "'RA---TAN'"),
        ("CTYPE2", "'DEC--TAN'"),
        ("CRVAL1", "84.0"),
        ("CRVAL2", "-4.0"),
        ("CRPIX1", "1500.0"),
        ("CRPIX2", "1125.0"),
        ("CD1_1", "-0.001"),
        ("CD1_2", "0.0"),
        ("CD2_1", "0.0"),
        ("CD2_2", "0.001"),
        ("IMAGEW", "3000"),
        ("IMAGEH", "2250"),
    ]
)


def test_wcs_from_text_accepts_a_tan_header_without_sip() -> None:
    wcs = Wcs.from_text(MINIMAL_TAN)
    assert wcs.a == {} and wcs.ap == {}
    assert wcs.crval == (84.0, -4.0)


@pytest.mark.parametrize(
    ("text", "public"),
    [
        ("", "no WCS"),
        (MINIMAL_TAN.replace("CRPIX2", "CRPIXX"), "CRPIX2"),
        (MINIMAL_TAN.replace("'RA---TAN'", "'RA---SIN'"), "projection"),
        ("garbage that is not a header at all", "no WCS"),
    ],
)
def test_wcs_from_text_refuses_a_bad_header_with_a_named_reason(text: str, public: str) -> None:
    with pytest.raises(WcsError) as caught:
        Wcs.from_text(text)
    assert public in caught.value.public
    assert caught.value.detail  # for the log
