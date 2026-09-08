"""Convert nova's annotation list into stable catalogue objects in original pixels."""

from __future__ import annotations

import math
from collections.abc import Mapping, Sequence

from .catalog import enrich_names
from .models import SolveObject, primary_name

NAME_SEPARATOR = " / "  # nova joins Bayer and Flamsteed designations: "ι Ori / 44 Ori"


def split_names(raw_names: object) -> list[str]:
    """Nova's ``names`` list, split on " / " and de-duplicated, order preserved."""
    if not isinstance(raw_names, list):
        return []
    names: list[str] = []
    for entry in raw_names:
        for part in str(entry).split(NAME_SEPARATOR):
            text = part.strip()
            if text and text not in names:
                names.append(text)
    return names


def _parse(entry: Mapping[str, object]) -> tuple[list[str], str, float, float, float] | None:
    names = split_names(entry.get("names"))
    if not names:
        return None
    try:
        x = float(entry.get("pixelx", 0.0))  # type: ignore[arg-type]
        y = float(entry.get("pixely", 0.0))  # type: ignore[arg-type]
        radius = float(entry.get("radius", 0.0) or 0.0)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return None
    if not all(math.isfinite(v) for v in (x, y, radius)):
        return None
    return names, str(entry.get("type") or "unknown"), x, y, max(0.0, radius)


def objects_from_nova(
    annotations: Sequence[Mapping[str, object]], solve_scale: float
) -> list[SolveObject]:
    """Scale nova's pixel coordinates back to the original image and add known aliases.

    Ids are assigned by descending radius, then primary name, so they are deterministic
    for a given nova response. Entries are never merged: nova places e.g. NGC 1980 and
    ι Ori at the same pixel and they are different objects.
    """
    parsed = [p for p in (_parse(raw) for raw in annotations) if p is not None]
    parsed.sort(key=lambda p: (-p[4], primary_name(enrich_names(p[0]))))
    return [
        SolveObject(
            id=i,
            catalog_names=enrich_names(names),
            type=type_,
            x=x * solve_scale,
            y=y * solve_scale,
            radius=radius * solve_scale,
        )
        for i, (names, type_, x, y, radius) in enumerate(parsed, start=1)
    ]
