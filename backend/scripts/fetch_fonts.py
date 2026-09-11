"""Refresh the bundled fonts in fonts/ from Google Fonts (SPEC § 9).

The Google Fonts CSS API serves static TTF instances to a legacy user agent, one per
weight, for the subsets we ask for. Each family's licence text comes from the google/fonts
repository. Run from backend/:  python scripts/fetch_fonts.py   (or `make fonts` at the repo
root). Network access is needed; tests never run this.

Every family must cover Greek (Bayer letters such as θ1 Ori C), the middle dot and the
curly apostrophe; tests/test_fonts.py checks the result.
"""

from __future__ import annotations

import re
import sys
import urllib.parse
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import cast

FONTS_DIR = Path(__file__).resolve().parent.parent.parent / "fonts"
LICENSES_DIR = FONTS_DIR / "LICENSES"
CSS_API = "https://fonts.googleapis.com/css"
SUBSETS = "latin,latin-ext,greek,cyrillic"
LICENCE_BASE = "https://raw.githubusercontent.com/google/fonts/main/"
LEGACY_UA = {"User-Agent": "Mozilla/4.0"}  # newer agents get variable WOFF2, not static TTF
WEIGHTS = {"400": "Regular", "700": "Bold"}
TIMEOUT = 60


@dataclass(frozen=True)
class Family:
    name: str
    licence: str  # path inside github.com/google/fonts


FAMILIES: list[Family] = [
    Family("Inter", "ofl/inter/OFL.txt"),
    Family("Roboto", "ofl/roboto/OFL.txt"),
    Family("Open Sans", "ofl/opensans/OFL.txt"),
    Family("Source Sans 3", "ofl/sourcesans3/OFL.txt"),
    Family("Fira Sans", "ofl/firasans/OFL.txt"),
    Family("IBM Plex Sans", "ofl/ibmplexsans/OFL.txt"),
    Family("JetBrains Mono", "ofl/jetbrainsmono/OFL.txt"),
    Family("Ubuntu", "ufl/ubuntu/UFL.txt"),
    Family("Manrope", "ofl/manrope/OFL.txt"),
    Family("Roboto Condensed", "ofl/robotocondensed/OFL.txt"),
    Family("Play", "ofl/play/OFL.txt"),
    Family("Source Serif 4", "ofl/sourceserif4/OFL.txt"),
]

_FACE = re.compile(r"font-weight:\s*(\d+);.*?url\((https://[^)]+\.ttf)\)", re.DOTALL)


def parse_css(css: str) -> dict[str, str]:
    """``{weight: ttf_url}`` from a CSS API response; both weights must be present."""
    found = {w: url for w, url in _FACE.findall(css) if w in WEIGHTS}
    missing = [w for w in WEIGHTS if w not in found]
    if missing:
        raise ValueError(f"CSS response lacks weight(s) {', '.join(missing)}")
    return found


def file_name(family: str, weight: str) -> str:
    return f"{family.replace(' ', '')}-{WEIGHTS[weight]}.ttf"


def _get(url: str) -> bytes:
    request = urllib.request.Request(url, headers=LEGACY_UA)
    with urllib.request.urlopen(request, timeout=TIMEOUT) as response:
        return cast(bytes, response.read())


def fetch_family(family: Family) -> list[str]:
    query = urllib.parse.quote(family.name) + ":400,700&subset=" + SUBSETS
    urls = parse_css(_get(f"{CSS_API}?family={query}").decode("utf-8"))
    written = []
    for weight, url in urls.items():
        name = file_name(family.name, weight)
        (FONTS_DIR / name).write_bytes(_get(url))
        written.append(name)
    licence = LICENSES_DIR / f"{family.name.replace(' ', '')}.txt"
    licence.write_bytes(_get(LICENCE_BASE + family.licence))
    return written


def main() -> int:
    LICENSES_DIR.mkdir(parents=True, exist_ok=True)
    expected: set[str] = set()
    for family in FAMILIES:
        written = fetch_family(family)
        expected.update(written)
        print(f"{family.name}: {', '.join(written)}")
    strays = sorted(p.name for p in FONTS_DIR.glob("*.ttf") if p.name not in expected)
    if strays:
        print(f"not in the family list, remove by hand: {', '.join(strays)}")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
