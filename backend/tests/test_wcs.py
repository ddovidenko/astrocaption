"""The stored WCS header, parsed and projected (SPEC § 5.2 "Local catalogue", #17)."""

from __future__ import annotations

import json
import math
from pathlib import Path

import pytest

from app.catalog import unit_vector
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


# --- projection -----------------------------------------------------------------------------

# J2000 positions from OpenNGC (NGC.csv, sexagesimal → degrees), for the objects nova annotated
# in the two recorded fields. nova's pixelx/pixely for the same objects come from the fixtures.
OPENNGC_DEG = {
    "IC 420": (83.03958, -4.50475),
    "IC 427": (84.07508, -6.61644),
    "IC 428": (84.10088, -6.45156),
    "NGC 1924": (82.00804, -5.31075),  # 05:28:01.93 -05:18:38.7
    "NGC 1973": (83.76992, -4.73178),
    "NGC 1975": (83.82450, -4.68522),
    "NGC 1976": (83.81867, -5.38967),
    "NGC 1977": (83.81583, -4.84433),
    "NGC 1980": (83.85829, -5.90989),
    "NGC 1981": (83.78996, -4.42506),
    "NGC 1982": (83.88075, -5.26747),
    "NGC 1999": (84.10563, -6.71586),
    "IC 5070": (312.75300, 44.40150),
}


def _nova_pixels(fixtures_dir: Path) -> dict[str, tuple[float, float]]:
    entries = json.loads((fixtures_dir / "annotations.json").read_text())["annotations"]
    return {
        e["names"][0]: (e["pixelx"], e["pixely"]) for e in entries if e["type"] in ("ngc", "ic")
    }


@pytest.mark.parametrize(
    ("text", "fixtures_dir"),
    [(ORION, NOVA_FIXTURES), (PELICAN, NOVA_NARROW_FIXTURES)],
    ids=["orion", "pelican"],
)
def test_sky_to_pixel_lands_on_novas_own_pixels(text: str, fixtures_dir: Path) -> None:
    """The oracle: OpenNGC's J2000 positions, through the stored header, must hit the pixel nova
    reported for the same object. 0.5 px is generous: the real figure is a few hundredths."""
    wcs = Wcs.from_text(text)
    checked = 0
    for name, (px, py) in _nova_pixels(fixtures_dir).items():
        if name not in OPENNGC_DEG:
            continue
        got = wcs.sky_to_pixel(*OPENNGC_DEG[name])
        assert got is not None, name
        assert got[0] == pytest.approx(px, abs=0.5), name
        assert got[1] == pytest.approx(py, abs=0.5), name
        checked += 1
    assert checked >= 1
    if fixtures_dir is NOVA_FIXTURES:
        assert checked == 12  # every NGC/IC entry of the Orion fixture has a position above


#: The minimal TAN frame moved so that a celestial pole lies inside it (#216).
NORTH_POLE_TAN = MINIMAL_TAN.replace("CRVAL2  = -4.0", "CRVAL2  = 89.0")
SOUTH_POLE_TAN = MINIMAL_TAN.replace(
    "CRVAL2  = -4.0 ", "CRVAL2  = -89.0"
)  # keeps the 80-column card


@pytest.mark.parametrize(
    "text",
    [ORION, PELICAN, NORTH_POLE_TAN, SOUTH_POLE_TAN],
    ids=["orion", "pelican", "north-pole", "south-pole"],
)
def test_pixel_to_sky_round_trips_across_the_frame(text: str) -> None:
    wcs = Wcs.from_text(text)
    for x, y in [
        (1.0, 1.0),
        (wcs.width, 1.0),
        (1.0, wcs.height),
        (wcs.width, wcs.height),
        (wcs.width / 2, wcs.height / 2),
        (137.5, 2001.25),
    ]:
        ra, dec = wcs.pixel_to_sky(x, y)
        assert 0.0 <= ra < 360.0 and -90.0 <= dec <= 90.0
        back = wcs.sky_to_pixel(ra, dec)
        assert back is not None
        assert back[0] == pytest.approx(x, abs=0.01) and back[1] == pytest.approx(y, abs=0.01)


def test_plate_scale_matches_the_cd_matrix() -> None:
    assert Wcs.from_text(ORION).plate_scale_deg() * 3600 == pytest.approx(4.6716, abs=0.001)
    assert Wcs.from_text(PELICAN).plate_scale_deg() * 3600 == pytest.approx(1.9929, abs=0.001)


def test_field_covers_the_corners() -> None:
    wcs = Wcs.from_text(ORION)
    centre, radius_deg = wcs.field()
    assert 2.0 < radius_deg < 3.0  # a 3000x2250 frame at 4.67"/px: half-diagonal ≈ 2.43°
    for x, y in [(1.0, 1.0), (wcs.width, wcs.height)]:
        corner = unit_vector(*wcs.pixel_to_sky(x, y))
        dot = sum(a * b for a, b in zip(centre, corner, strict=True))
        assert math.degrees(math.acos(min(1.0, dot))) <= radius_deg + 1e-6


def test_field_of_a_frame_containing_the_pole_stays_small() -> None:
    """Corners on the far side of the pole came back at dec < -90, which blew the field radius
    up to ~178 degrees and switched the catalogue prefilter off (#216)."""
    _, radius_deg = Wcs.from_text(NORTH_POLE_TAN).field()
    assert radius_deg < 3.0  # a 3 x 2.25 degree frame: half-diagonal 1.9 degrees


def test_a_point_behind_the_tangent_plane_is_none() -> None:
    wcs = Wcs.from_text(ORION)
    assert wcs.sky_to_pixel(wcs.crval[0] + 180.0, -wcs.crval[1]) is None


def test_a_header_without_sip_projects_as_a_plain_tan() -> None:
    wcs = Wcs.from_text(MINIMAL_TAN)
    assert wcs.sky_to_pixel(84.0, -4.0) == pytest.approx((1500.0, 1125.0))
    # One pixel east: CD1_1 = -0.001 deg/px, so RA grows westwards on the pixel axis.
    ra, _ = wcs.pixel_to_sky(1499.0, 1125.0)
    assert ra > 84.0


def test_wcs_from_text_refuses_a_singular_cd_matrix() -> None:
    """A zero plate scale would divide every projection by zero; it is refused like a missing card."""
    text = MINIMAL_TAN.replace(card("CD2_2", "0.001"), card("CD2_2", "0.0")).replace(
        card("CD1_1", "-0.001"), card("CD1_1", "0.0")
    )
    with pytest.raises(WcsError) as caught:
        Wcs.from_text(text)
    assert "scale" in caught.value.public
