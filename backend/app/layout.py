"""Default annotation layout: style defaults, the enabled rule and auto-placement glue."""

from __future__ import annotations

import logging
from collections.abc import Mapping
from pathlib import Path

from pydantic import ValidationError

from .fonts import resolve_font_file, resolved_style
from .models import (
    MAX_FONT_SIZE,
    MAX_MARKER_MIN_RADIUS,
    MAX_STROKE_WIDTH,
    Annotations,
    Label,
    SolveObject,
    StyleConfig,
)
from .placement import (
    PAD_FACTOR,
    Box,
    Circle,
    PlacementItem,
    box_crosses_ring,
    boxes_overlap,
    place_labels,
    scale_unit,
)
from .render import marker_radius, measure_label

log = logging.getLogger(__name__)

MIN_ENABLED_RADIUS_FRACTION = 0.004  # SPEC § 5.2 step 5
ALWAYS_ENABLED_TYPES = frozenset({"bright"})
NEVER_ENABLED_TYPES = frozenset(
    {"hd"}
)  # nova's per-star rows: radius 0 means a point, not "unknown"


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
        resolved = resolve_font_file(fonts_dir, font)
        if resolved != font:
            log.warning("ignoring default_style.font_file %r: not a bundled font", font)
        merged["font_file"] = resolved
    try:
        return StyleConfig.model_validate(merged)
    except ValidationError as exc:
        log.warning("ignoring invalid default_style in config.json: %s", exc)
        return base


def default_enabled(obj: SolveObject, width: int) -> bool:
    """SPEC § 5.2 step 5. Bright stars always, ``hd`` stars never (hundreds per narrow field,
    hidden behind the object list's type filter). Any other object when its radius clears the
    threshold, or when nova gives no size at all: radius 0 there means "unknown", not "tiny"
    (NGC 206 in M 31, #9)."""
    if obj.type in NEVER_ENABLED_TYPES:
        return False
    if obj.type in ALWAYS_ENABLED_TYPES:
        return True
    return obj.radius == 0 or obj.radius >= MIN_ENABLED_RADIUS_FRACTION * width


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
    """Run the placer on every enabled label not in ``keep``; others become obstacles.

    A kept label keeps its position and its pin, but ``collided`` is recomputed for it against
    the freshly laid-out document: the labels around it have just moved, so a stored verdict
    would be stale in both directions.
    """
    style = resolved_style(fonts_dir, style)
    by_id = {o.id: o for o in objects}
    items: list[PlacementItem] = []
    fixed_boxes: list[Box] = []
    fixed_circles: list[Circle] = []
    sizes: dict[int, tuple[float, float]] = {}
    markers: dict[int, Circle] = {}
    for label in labels:
        obj = by_id.get(label.object_id)
        if obj is None or not label.enabled:
            continue
        r = marker_radius(obj, style)
        box = measure_label(fonts_dir, style, label, obj)
        sizes[label.object_id] = (box.width, box.height)
        markers[label.object_id] = Circle(obj.x, obj.y, r)
        if label.object_id in keep:
            fixed_boxes.append(Box(label.x, label.y, label.x + box.width, label.y + box.height))
            fixed_circles.append(markers[label.object_id])
        else:
            items.append(PlacementItem(label.object_id, obj.x, obj.y, r, box.width, box.height))
    placed = {
        p.id: p
        for p in place_labels(
            width, height, items, fixed_boxes=fixed_boxes, fixed_circles=fixed_circles
        )
    }
    # Where every enabled label ends up — the ones just placed and the kept ones alike. This is
    # what the kept labels' ``collided`` is recomputed against below.
    final: dict[int, Box] = {}
    for label in labels:
        size = sizes.get(label.object_id)
        if size is None:
            continue
        p = placed.get(label.object_id)
        x, y = (p.x, p.y) if p is not None else (label.x, label.y)
        final[label.object_id] = Box(x, y, x + size[0], y + size[1])
    pad = PAD_FACTOR * scale_unit(width, height)
    out: list[Label] = []
    for label in labels:
        oid = label.object_id
        p = placed.get(oid)
        if p is not None:
            out.append(label.model_copy(update={"x": p.x, "y": p.y, "collided": p.collided}))
        elif oid in final:
            # A kept label is not moved and stays pinned, but its stored verdict is from whenever
            # it was last placed: everything around it has just been laid out afresh, so the badge
            # would otherwise lie in both directions. Same pad as the placer's own search.
            out.append(label.model_copy(update={"collided": _collides(oid, final, markers, pad)}))
        else:
            out.append(label)
    return out


def _collides(
    oid: int, boxes: Mapping[int, Box], markers: Mapping[int, Circle], pad: float
) -> bool:
    """Whether ``oid``'s box touches any *other* enabled label's box or marker ring."""
    box = boxes[oid]
    return any(
        boxes_overlap(box, other, pad) for other_id, other in boxes.items() if other_id != oid
    ) or any(box_crosses_ring(box, c, pad) for other_id, c in markers.items() if other_id != oid)


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
