"""Refresh the bundled fonts in fonts/ from Google Fonts (SPEC § 9).

The Google Fonts CSS API serves static TTF instances to a legacy user agent, one per
weight, for the subsets we ask for. Each family's licence text comes from the google/fonts
repository. Run from backend/:  python scripts/fetch_fonts.py   (or `make fonts` at the repo
root). Network access is needed; tests never run this.

Every family must cover Greek (Bayer letters such as θ1 Ori C), the middle dot and the
curly apostrophe; tests/test_fonts.py checks the result.
"""

from __future__ import annotations

import http.client
import re
import sys
import urllib.parse
import urllib.request
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


FAMILIES: list[str] = [
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

LICENCE_OVERRIDES: dict[str, str] = {"Ubuntu": "ufl/ubuntu/UFL.txt"}


def licence_path(name: str) -> str:
    """Path inside github.com/google/fonts for a family's licence text."""
    return LICENCE_OVERRIDES.get(name, f"ofl/{_slug(name).lower()}/OFL.txt")


_STYLE_NORMAL = re.compile(r"font-style:\s*normal")
_WEIGHT = re.compile(r"font-weight:\s*(\d+)")
_URL = re.compile(r"url\(\s*['\"]?(https://[^)'\"]+)['\"]?\s*\)")


def parse_css(css: str) -> dict[str, str]:
    """``{weight: ttf_url}`` from a CSS API response; both weights must be present.

    Works per ``@font-face`` block so an italic face never shadows a normal one of the
    same weight: a block counts only when it is ``font-style: normal`` and its
    ``font-weight`` is one of ``WEIGHTS``. Its ``src`` may list several urls (woff2 and
    ttf side by side); the ``.ttf`` one is picked out of all of them. A normal-style
    block for a known weight with no ``.ttf`` url is a hard error rather than being
    treated as though the weight were simply absent.
    """
    found: dict[str, str] = {}
    for block in css.split("@font-face")[1:]:
        if not _STYLE_NORMAL.search(block):
            continue
        weight_match = _WEIGHT.search(block)
        if weight_match is None or weight_match.group(1) not in WEIGHTS:
            continue
        weight = weight_match.group(1)
        ttf_urls = [url for url in _URL.findall(block) if url.endswith(".ttf")]
        if not ttf_urls:
            raise ValueError(f"no .ttf src in the weight {weight} block")
        if weight in found:
            raise ValueError(f"CSS response has weight {weight} twice")
        found[weight] = ttf_urls[0]
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


def fetch_family(name: str) -> list[str]:
    query = urllib.parse.quote(name) + ":400,700&subset=" + SUBSETS
    urls = parse_css(_get(f"{CSS_API}?family={query}").decode("utf-8"))
    written = []
    for weight, url in urls.items():
        file = file_name(name, weight)
        (FONTS_DIR / file).write_bytes(_get(url))
        written.append(file)
    licence = LICENSES_DIR / f"{_slug(name)}.txt"
    licence.write_bytes(_get(LICENCE_BASE + licence_path(name)))
    return written


def main() -> int:
    LICENSES_DIR.mkdir(parents=True, exist_ok=True)
    expected_fonts = {file_name(family, weight) for family in FAMILIES for weight in WEIGHTS}
    expected_licences = {f"{_slug(family)}.txt" for family in FAMILIES}
    stray_fonts = sorted(p.name for p in FONTS_DIR.glob("*.ttf") if p.name not in expected_fonts)
    stray_licences = sorted(
        p.name for p in LICENSES_DIR.glob("*.txt") if p.name not in expected_licences
    )
    strays = stray_fonts + stray_licences
    if strays:
        print(
            f"not in the family list, remove by hand before refreshing: {', '.join(strays)}",
            file=sys.stderr,
        )
        return 1
    for family in FAMILIES:
        try:
            written = fetch_family(family)
        except (OSError, http.client.HTTPException, ValueError) as exc:
            print(
                f"fetch failed for {family}: {exc}; fonts/ may be half-updated; run "
                "'git checkout fonts/' and 'git clean -n fonts/'",
                file=sys.stderr,
            )
            return 1
        print(f"{family}: {', '.join(written)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
