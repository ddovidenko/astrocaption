"""Bundled cross-identification table: NGC/IC designations → Messier, Caldwell, common names.

nova.astrometry.net annotates deep-sky objects with a single designation (``NGC 1976``);
the well-known names (``M 42``, ``Orion Nebula``) come from this table, generated from
OpenNGC (CC BY-SA 4.0, see ``OPENNGC-LICENSE.md``) by ``scripts/build_names_catalog.py``.
"""

from __future__ import annotations

import json
import re
from functools import lru_cache
from pathlib import Path

NAMES_FILE = Path(__file__).with_name("names.json")

_SPACING = re.compile(r"^([A-Za-z]+)\s*0*(\d+)(.*)$")


def normalise(name: str) -> str:
    """Canonical form for lookups: ``NGC1976`` / ``NGC 01976`` → ``NGC 1976``; case-insensitive."""
    n = " ".join(name.split())
    m = _SPACING.match(n)
    if m:
        prefix, number, rest = m.groups()
        n = f"{prefix} {number}{rest}"
    return n.casefold()


@lru_cache(maxsize=1)
def _index() -> dict[str, list[str]]:
    groups: list[list[str]] = json.loads(NAMES_FILE.read_text(encoding="utf-8"))
    index: dict[str, list[str]] = {}
    for group in groups:
        for name in group:
            index.setdefault(normalise(name), group)
    return index


def aliases_for(name: str) -> list[str]:
    """Every known name of the object called ``name`` (excluding ``name`` itself)."""
    group = _index().get(normalise(name), [])
    key = normalise(name)
    return [n for n in group if normalise(n) != key]


def enrich_names(names: list[str]) -> list[str]:
    """``names`` followed by any bundled aliases, de-duplicated, original order first."""
    out: list[str] = []
    seen: set[str] = set()
    for n in names:
        key = normalise(n)
        if key not in seen:
            seen.add(key)
            out.append(n)
    for n in list(out):
        for alias in aliases_for(n):
            key = normalise(alias)
            if key not in seen:
                seen.add(key)
                out.append(alias)
    return out
