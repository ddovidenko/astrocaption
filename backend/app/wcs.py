"""The stored WCS header (nova's ``wcs.fits`` text), parsed and projected both ways.

TAN (gnomonic) projection with SIP distortion, pure stdlib: astropy would cost more than a
quarter of the image budget. ``sky_to_pixel`` is what the local catalogue lookup uses
(SPEC § 5.2); ``pixel_to_sky`` gives the field's centre and radius. Pixels follow the FITS
convention nova writes its own annotations in (one-based, no half-pixel shift needed: the
oracle test in tests/test_wcs.py pins this against nova's positions to a hundredth of a pixel).
"""

from __future__ import annotations

import re
from dataclasses import dataclass

CARD = 80
_SIP_KEY = re.compile(r"^(A|B|AP|BP)_(\d+)_(\d+)$")
_REQUIRED = (
    "CRVAL1",
    "CRVAL2",
    "CRPIX1",
    "CRPIX2",
    "CD1_1",
    "CD1_2",
    "CD2_1",
    "CD2_2",
    "IMAGEW",
    "IMAGEH",
)


class WcsError(Exception):
    """A header the lookup cannot use. ``public`` names the problem in a sentence; ``detail``
    is for the server log."""

    def __init__(self, public: str, detail: str | None = None) -> None:
        super().__init__(public)
        self.public = public
        self.detail = detail or public


def parse_cards(text: str) -> dict[str, float | str]:
    """Every ``KEY = value`` card of an 80-column FITS header. Numbers become floats, quoted
    strings lose their quotes and padding, comments after ``/`` are dropped."""
    cards: dict[str, float | str] = {}
    for i in range(0, len(text), CARD):
        chunk = text[i : i + CARD]
        if len(chunk) < 10 or chunk[8:10] != "= ":
            continue
        key = chunk[:8].strip()
        rest = chunk[10:]
        if rest.lstrip().startswith("'"):
            value: float | str = rest.split("'")[1].strip()
        else:
            raw = rest.split("/", 1)[0].strip()
            try:
                value = float(raw)
            except ValueError:
                value = raw
        if key:
            cards[key] = value
    return cards


@dataclass(frozen=True)
class Wcs:
    crval: tuple[float, float]
    crpix: tuple[float, float]
    cd: tuple[float, float, float, float]  # CD1_1, CD1_2, CD2_1, CD2_2
    width: int
    height: int
    a: dict[tuple[int, int], float]
    b: dict[tuple[int, int], float]
    ap: dict[tuple[int, int], float]
    bp: dict[tuple[int, int], float]

    @classmethod
    def from_text(cls, text: str) -> Wcs:
        cards = parse_cards(text)
        if not cards or "CTYPE1" not in cards:
            raise WcsError("the stored solve holds no WCS header", f"{len(cards)} cards, no CTYPE1")
        ctype1, ctype2 = str(cards.get("CTYPE1")), str(cards.get("CTYPE2"))
        if not ctype1.startswith("RA---TAN") or not ctype2.startswith("DEC--TAN"):
            raise WcsError(
                "the stored WCS uses a projection this build cannot read",
                f"CTYPE1={ctype1!r} CTYPE2={ctype2!r}",
            )
        missing = [k for k in _REQUIRED if not isinstance(cards.get(k), float)]
        if missing:
            raise WcsError(
                f"the stored WCS header lacks {', '.join(missing)}", f"missing {missing}"
            )
        polys: dict[str, dict[tuple[int, int], float]] = {"A": {}, "B": {}, "AP": {}, "BP": {}}
        for key, value in cards.items():
            m = _SIP_KEY.match(key)
            if m and isinstance(value, float):
                polys[m.group(1)][(int(m.group(2)), int(m.group(3)))] = value

        def f(key: str) -> float:
            return float(cards[key])

        return cls(
            crval=(f("CRVAL1"), f("CRVAL2")),
            crpix=(f("CRPIX1"), f("CRPIX2")),
            cd=(f("CD1_1"), f("CD1_2"), f("CD2_1"), f("CD2_2")),
            width=int(f("IMAGEW")),
            height=int(f("IMAGEH")),
            a=polys["A"],
            b=polys["B"],
            ap=polys["AP"],
            bp=polys["BP"],
        )
