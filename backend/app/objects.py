"""Convert nova's annotation list into stable catalogue objects in original pixels, and fold
the bundled catalogue's objects (looked up through the stored WCS, #17) into them."""

from __future__ import annotations

import math
from collections.abc import Mapping, Sequence

from .catalog import KIND_BY_SOURCE, ObjectsCatalog, enrich_names, kind_for, normalise
from .models import MAX_LABELS, ObjectKind, SolveObject, primary_name
from .wcs import Wcs

STAR_TYPES = frozenset({"bright", "hd"})

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


def kind_of(obj: SolveObject) -> ObjectKind:
    """The Objects tab bucket: stars by nova's type, catalogue objects by their source, the rest
    by what the names table knows (SPEC § 6.3)."""
    if obj.type in STAR_TYPES:
        return "star"
    source_kind = KIND_BY_SOURCE.get(obj.type)
    if source_kind is not None:
        return source_kind
    return kind_for(obj.catalog_names) or "other"


def objects_from_catalog(
    wcs: Wcs, solve_scale: float, catalog: ObjectsCatalog
) -> list[SolveObject]:
    """Every catalogue row whose centre lands inside the solve copy, in original pixels, with
    id 0 (``merge_objects`` assigns ids) and the row's source as ``type``."""
    centre, radius_deg = wcs.field()
    scale = wcs.plate_scale_deg()
    hits: list[SolveObject] = []
    for row in catalog.objects:
        # One dot product per row: skip anything farther from the frame centre than the frame's
        # own radius plus the object's, before the projection.
        dot = sum(p * q for p, q in zip(centre, row.unit, strict=True))
        limit = math.radians(radius_deg + row.radius_arcmin / 60)
        if dot < math.cos(min(limit, math.pi)):
            continue
        pixel = wcs.sky_to_pixel(row.ra, row.dec)
        if pixel is None:
            continue
        x, y = pixel
        if not (0.0 <= x <= wcs.width and 0.0 <= y <= wcs.height):
            continue
        hits.append(
            SolveObject(
                id=0,
                catalog_names=enrich_names(list(row.names)),
                type=row.type,
                x=x * solve_scale,
                y=y * solve_scale,
                radius=row.radius_arcmin / 60 / scale * solve_scale,
            )
        )
    return hits


def _joins_by_position(obj: SolveObject, hit: SolveObject) -> bool:
    if obj.radius <= 0 or hit.radius <= 0 or kind_of(obj) != kind_of(hit):
        return False
    return math.hypot(obj.x - hit.x, obj.y - hit.y) <= min(obj.radius, hit.radius) / 2


def merge_objects(
    existing: list[SolveObject], hits: list[SolveObject], *, next_id: int
) -> list[SolveObject]:
    """Fold ``hits`` into ``existing``: by any shared (normalised) name first, then by position
    for the same kind within half the smaller radius; a joined hit adds its names and nothing
    else. The rest are appended with ids from ``next_id`` by descending radius then primary
    name, dropping the smallest beyond ``MAX_LABELS``. ``existing`` keeps its order and ids,
    and is not mutated."""
    merged = [o.model_copy(update={"catalog_names": list(o.catalog_names)}) for o in existing]
    by_name: dict[str, SolveObject] = {}
    for o in merged:
        for n in o.catalog_names:
            by_name.setdefault(normalise(n), o)
    fresh: list[SolveObject] = []
    for hit in hits:
        target = next(
            (by_name[normalise(n)] for n in hit.catalog_names if normalise(n) in by_name), None
        )
        if target is None:
            target = next((o for o in merged if _joins_by_position(o, hit)), None)
        if target is None:
            fresh.append(hit)
            continue
        for n in hit.catalog_names:
            if normalise(n) not in by_name:
                target.catalog_names.append(n)
                by_name[normalise(n)] = target
    fresh.sort(key=lambda o: (-o.radius, primary_name(o.catalog_names)))
    room = max(0, MAX_LABELS - len(merged))
    for i, hit in enumerate(fresh[:room]):
        merged.append(hit.model_copy(update={"id": next_id + i}))
    return merged
