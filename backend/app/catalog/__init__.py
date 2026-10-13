"""Bundled cross-identification table: NGC/IC designations → Messier, Caldwell, common names.

nova.astrometry.net annotates deep-sky objects with a single designation (``NGC 1976``);
the well-known names (``M 42``, ``Orion Nebula``) come from this table, generated from
OpenNGC (CC BY-SA 4.0, see ``OPENNGC-LICENSE.md``) by ``scripts/build_names_catalog.py``,
which also records each object's kind (galaxy / nebula / cluster) for the editor's Objects tab.
``objects.json`` (CDS tables, see ``CDS-ATTRIBUTION.md``) adds objects nova does not annotate,
looked up by position through the stored WCS (SPEC § 5.2, #17).
"""

from __future__ import annotations

import json
import math
import re
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Any, Literal, NoReturn, cast, get_args

Kind = Literal["galaxy", "nebula", "cluster"]

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
def _data() -> dict[str, Any]:
    return cast(dict[str, Any], json.loads(NAMES_FILE.read_text(encoding="utf-8")))


@lru_cache(maxsize=1)
def _index() -> dict[str, list[str]]:
    groups: list[list[str]] = _data()["aliases"]
    index: dict[str, list[str]] = {}
    for group in groups:
        for name in group:
            index.setdefault(normalise(name), group)
    return index


@lru_cache(maxsize=1)
def _kinds() -> dict[str, Kind]:
    out: dict[str, Kind] = {}
    for name, kind in _data()["kinds"].items():
        # The table is bundled at build time, so anything outside the three kinds is a defect in
        # the generator, not user data: fail loudly rather than drop the row.
        if kind not in get_args(Kind):
            raise ValueError(f"names.json: unknown kind {kind!r} for {name!r}")
        out[normalise(name)] = cast(Kind, kind)
    return out


def kind_for(names: list[str]) -> Kind | None:
    """OpenNGC's class of the object with these names: the first name the table knows, or None
    (a star, an association, or an object the table does not list)."""
    kinds = _kinds()
    for n in names:
        kind = kinds.get(normalise(n))
        if kind is not None:
            return kind
    return None


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


# --- the positional catalogue (objects.json), SPEC § 5.2 "Local catalogue" ---------------

Source = Literal["sharpless", "lbn", "barnard", "ldn", "pgc"]

# The kind an object of each source reports (ObjectOut.kind). Dark nebulae are nebulae: the
# Objects tab has no fourth bucket.
KIND_BY_SOURCE: dict[str, Kind] = {
    "sharpless": "nebula",
    "lbn": "nebula",
    "barnard": "nebula",
    "ldn": "nebula",
    "pgc": "galaxy",
}

OBJECTS_FILE = Path(__file__).with_name("objects.json")


@dataclass(frozen=True)
class CatalogObject:
    """One row of objects.json. ``unit`` is the J2000 direction as a unit vector, precomputed
    so a field lookup is one dot product per row."""

    names: tuple[str, ...]
    ra: float
    dec: float
    radius_arcmin: float
    type: str
    unit: tuple[float, float, float]


@dataclass(frozen=True)
class ObjectsCatalog:
    version: str
    objects: tuple[CatalogObject, ...]


def unit_vector(ra_deg: float, dec_deg: float) -> tuple[float, float, float]:
    ra, dec = math.radians(ra_deg), math.radians(dec_deg)
    return (math.cos(dec) * math.cos(ra), math.cos(dec) * math.sin(ra), math.sin(dec))


def _bad(path: Path, reason: str) -> NoReturn:
    raise ValueError(f"{path.name}: {reason}")


def load_objects_catalog(path: Path) -> ObjectsCatalog:
    """Read and validate a catalogue file. Every problem is a ``ValueError`` naming the file:
    the file is bundled at build time, so a bad row is a defect in the generator, never
    something to skip quietly."""
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise ValueError(f"{path.name}: cannot be read ({exc})") from exc
    if not isinstance(data, dict) or not isinstance(data.get("version"), str):
        _bad(path, "no version string")
    rows = data.get("objects")
    if not isinstance(rows, list):
        _bad(path, "no objects list")
    objects: list[CatalogObject] = []
    for i, row in enumerate(rows):
        try:
            names = tuple(str(n) for n in row["names"])
            ra, dec = float(row["ra"]), float(row["dec"])
            radius = float(row["radius_arcmin"])
            type_ = str(row["type"])
        except (KeyError, TypeError, ValueError) as exc:
            raise ValueError(f"{path.name}: row {i} is malformed ({exc})") from exc
        if not names or not all(names):
            _bad(path, f"row {i} has no names")
        if not (0.0 <= ra < 360.0) or not (-90.0 <= dec <= 90.0):
            _bad(path, f"row {i} ({names[0]}) has ra/dec out of range")
        if not (radius > 0.0) or not math.isfinite(radius):
            _bad(path, f"row {i} ({names[0]}) has no positive radius")
        if type_ not in KIND_BY_SOURCE:
            _bad(path, f"row {i} ({names[0]}) has unknown type {type_!r}")
        objects.append(CatalogObject(names, ra, dec, radius, type_, unit_vector(ra, dec)))
    return ObjectsCatalog(version=data["version"], objects=tuple(objects))


@lru_cache(maxsize=1)
def objects_catalog() -> ObjectsCatalog:
    """The shipped catalogue, read once."""
    return load_objects_catalog(OBJECTS_FILE)
