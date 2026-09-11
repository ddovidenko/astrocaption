"""Default annotation layout: style defaults, the enabled rule and auto-placement glue."""

from __future__ import annotations

import logging
from collections.abc import Mapping
from pathlib import Path

from pydantic import ValidationError

from .fonts import font_path
from .models import (
    MAX_FONT_SIZE,
    MAX_MARKER_MIN_RADIUS,
    MAX_STROKE_WIDTH,
    Annotations,
    Label,
    SolveObject,
    StyleConfig,
)
from .placement import Box, Circle, PlacementItem, place_labels, scale_unit
from .render import marker_radius, measure_label

log = logging.getLogger(__name__)

MIN_ENABLED_RADIUS_FRACTION = 0.004  # SPEC § 5.2 step 5
ALWAYS_ENABLED_TYPES = frozenset({"bright"})


def _clamp(v: int, lo: int, hi: int) -> int:
    return max(lo, min(hi, v))


def _size_kwargs(scale: float) -> dict[str, int]:
    """The style fields derived from the image size, at ``scale`` (``scale_unit``)."""
    return {
        "font_size": _clamp(round(12 * scale), 8, MAX_FONT_SIZE),
        "halo_width": _clamp(round(2 * scale), 1, MAX_STROKE_WIDTH),
        "marker_width": _clamp(round(1.5 * scale), 1, MAX_STROKE_WIDTH),
        "marker_min_radius": _clamp(round(6 * scale), 4, MAX_MARKER_MIN_RADIUS),
    }


SIZE_RELATIVE: frozenset[str] = frozenset(_size_kwargs(1.0))
"""Style fields with no fixed built-in: they are derived from each image's size.

The config page shows them blank ("auto") instead of a default value, so ``style_defaults``
in ``GET /api/config`` leaves them out. Derived here, so the two can never drift apart.
"""


def default_style(
    width: int,
    height: int,
    fonts_dir: Path,
    overrides: Mapping[str, object] | None = None,
) -> StyleConfig:
    """Size-relative defaults, then the owner's ``default_style`` from config.json on top.

    Derived values are clamped to the model bounds so a giant mosaic still validates, and a
    ``font_file`` override that is not a bundled font is dropped with a warning rather than
    failing every solve after nova has already succeeded.
    """
    base = StyleConfig.model_validate(_size_kwargs(scale_unit(width, height)))
    if not overrides:
        return base
    merged: dict[str, object] = {**base.model_dump(), **overrides}
    font = merged.get("font_file")
    if isinstance(font, str):
        try:
            font_path(fonts_dir, font)
        except LookupError:
            log.warning("ignoring default_style.font_file %r: not a bundled font", font)
            merged["font_file"] = base.font_file
    try:
        return StyleConfig.model_validate(merged)
    except ValidationError as exc:
        log.warning("ignoring invalid default_style in config.json: %s", exc)
        return base


def default_enabled(obj: SolveObject, width: int) -> bool:
    if obj.type in ALWAYS_ENABLED_TYPES:
        return True
    return obj.radius >= MIN_ENABLED_RADIUS_FRACTION * width


def autoplace(
    width: int,
    height: int,
    style: StyleConfig,
    labels: list[Label],
    objects: list[SolveObject],
    fonts_dir: Path,
    *,
    keep: frozenset[int] = frozenset(),
) -> list[Label]:
    """Run the placer on every enabled label not in ``keep``; others become obstacles."""
    by_id = {o.id: o for o in objects}
    items: list[PlacementItem] = []
    fixed_boxes: list[Box] = []
    fixed_circles: list[Circle] = []
    for label in labels:
        obj = by_id.get(label.object_id)
        if obj is None or not label.enabled:
            continue
        r = marker_radius(obj, style)
        box = measure_label(fonts_dir, style, label, obj)
        if label.object_id in keep:
            fixed_boxes.append(Box(label.x, label.y, label.x + box.width, label.y + box.height))
            fixed_circles.append(Circle(obj.x, obj.y, r))
        else:
            items.append(PlacementItem(label.object_id, obj.x, obj.y, r, box.width, box.height))
    placed = {
        p.id: p
        for p in place_labels(
            width, height, items, fixed_boxes=fixed_boxes, fixed_circles=fixed_circles
        )
    }
    out: list[Label] = []
    for label in labels:
        p = placed.get(label.object_id)
        if p is None:
            out.append(label)
        else:
            out.append(label.model_copy(update={"x": p.x, "y": p.y, "collided": p.collided}))
    return out


def build_default_annotations(
    image_id: str,
    width: int,
    height: int,
    objects: list[SolveObject],
    fonts_dir: Path,
    style_overrides: Mapping[str, object] | None = None,
) -> Annotations:
    style = default_style(width, height, fonts_dir, style_overrides)
    labels = [
        Label(object_id=o.id, enabled=default_enabled(o, width), x=o.x, y=o.y) for o in objects
    ]
    labels = autoplace(width, height, style, labels, objects, fonts_dir)
    return Annotations(image_id=image_id, style=style, labels=labels, version=1)


def rematch_annotations(
    previous: Annotations,
    old_objects: list[SolveObject],
    new_objects: list[SolveObject],
    width: int,
    height: int,
    fonts_dir: Path,
) -> Annotations:
    """After a re-solve, carry labels over by catalogue name; place only the new objects."""
    old_by_id = {o.id: o for o in old_objects}
    name_to_old: dict[str, int] = {}
    for o in old_objects:
        for n in o.catalog_names:
            name_to_old.setdefault(n, o.id)
    old_labels = {lab.object_id: lab for lab in previous.labels}

    labels: list[Label] = []
    keep: set[int] = set()
    for obj in new_objects:
        match = next((name_to_old[n] for n in obj.catalog_names if n in name_to_old), None)
        carried = old_labels.get(match) if match is not None and match in old_by_id else None
        if carried is not None:
            labels.append(carried.model_copy(update={"object_id": obj.id}))
            keep.add(obj.id)
        else:
            labels.append(
                Label(object_id=obj.id, enabled=default_enabled(obj, width), x=obj.x, y=obj.y)
            )
    labels = autoplace(
        width, height, previous.style, labels, new_objects, fonts_dir, keep=frozenset(keep)
    )
    return Annotations(
        image_id=previous.image_id,
        style=previous.style,
        labels=labels,
        version=previous.version + 1,
    )
