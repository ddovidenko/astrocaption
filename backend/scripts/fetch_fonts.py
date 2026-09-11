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
import urllib.error
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

_STYLE_NORMAL = re.compile(r"font-style:\s*normal")
_WEIGHT = re.compile(r"font-weight:\s*(\d+)")
_URL = re.compile(r"url\((https://[^)]+)\)")


def parse_css(css: str) -> dict[str, str]:
    """``{weight: ttf_url}`` from a CSS API response; both weights must be present.

    Works per ``@font-face`` block so an italic face never shadows a normal one of the
    same weight: a block counts only when it is ``font-style: normal``, its
    ``font-weight`` is one of ``WEIGHTS``, and its ``src`` includes a ``.ttf`` url (a
    woff2-only block is treated the same as one with no usable src at all).
    """
    found: dict[str, str] = {}
    for block in css.split("@font-face")[1:]:
        if not _STYLE_NORMAL.search(block):
            continue
        weight_match = _WEIGHT.search(block)
        if weight_match is None or weight_match.group(1) not in WEIGHTS:
            continue
        url_match = _URL.search(block)
        if url_match is None or not url_match.group(1).endswith(".ttf"):
            continue
        weight = weight_match.group(1)
        if weight in found:
            raise ValueError(f"CSS response has weight {weight} twice")
        found[weight] = url_match.group(1)
    missing = [w for w in WEIGHTS if w not in found]
    if missing:
        raise ValueError(f"CSS response lacks weight(s) {', '.join(missing)}")
    return found


def _slug(family: str) -> str:
    return family.replace(" ", "")


def file_name(family: str, weight: str) -> str:
    return f"{_slug(family)}-{WEIGHTS[weight]}.ttf"


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
    licence = LICENSES_DIR / f"{_slug(family.name)}.txt"
    licence.write_bytes(_get(LICENCE_BASE + family.licence))
    return written


def main() -> int:
    LICENSES_DIR.mkdir(parents=True, exist_ok=True)
    expected_fonts: set[str] = set()
    for family in FAMILIES:
        try:
            written = fetch_family(family)
        except (urllib.error.URLError, ValueError) as exc:
            print(
                f"fetch failed for {family.name}: {exc}; fonts/ may be half-updated, "
                "run 'git checkout fonts/'"
            )
            return 1
        expected_fonts.update(written)
        print(f"{family.name}: {', '.join(written)}")
    expected_licences = {f"{_slug(family.name)}.txt" for family in FAMILIES}
    stray_fonts = sorted(p.name for p in FONTS_DIR.glob("*.ttf") if p.name not in expected_fonts)
    stray_licences = sorted(
        p.name for p in LICENSES_DIR.glob("*.txt") if p.name not in expected_licences
    )
    strays = stray_fonts + stray_licences
    if strays:
        print(f"not in the family list, remove by hand: {', '.join(strays)}")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
