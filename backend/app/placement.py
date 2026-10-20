"""Deterministic label auto-placement (SPEC § 6.4).

Pure geometry: callers measure text boxes and marker radii first, so this module has
no font dependency and the TypeScript port must produce identical output for the
shared vectors in ``tests/fixtures/placement/``.

All coordinates are original-image pixels. ``s = max(W, H) / 1000`` is the scale unit.
A larger object's marker only blocks its ring line: labels may sit inside a big nebula's
circle, they just must not cross the drawn outline. An object whose own circle spills past
the frame (M 31 filling the field) is labelled at its centre, as if it were a point.
"""

from __future__ import annotations

import math
from collections.abc import Sequence
from dataclasses import dataclass

ANCHORS: tuple[str, ...] = (
    "right",
    "left",
    "below",
    "above",
    "below-right",
    "below-left",
    "above-right",
    "above-left",
)
GAP_FACTOR = 6.0
PAD_FACTOR = 4.0
RING_STEP_FACTOR = 40.0
MAX_RINGS = 4
SQRT_HALF = math.sqrt(0.5)


@dataclass(frozen=True)
class PlacementItem:
    """An enabled label to place: marker centre, marker radius and text box size."""

    id: int
    x: float
    y: float
    radius: float
    w: float
    h: float


@dataclass(frozen=True)
class Placement:
    id: int
    x: float
    y: float
    collided: bool


@dataclass(frozen=True)
class FixedItem:
    """A label the placer must avoid but never moves (a pinned label, or one carried over a
    re-solve): its text box and its marker ring. It gets a ``Placement`` back like the placed
    items, with ``collided`` judged against every other final box and ring (#107)."""

    id: int
    box: Box
    circle: Circle


@dataclass(frozen=True)
class Box:
    left: float
    top: float
    right: float
    bottom: float


@dataclass(frozen=True)
class Circle:
    x: float
    y: float
    r: float


def scale_unit(width: float, height: float) -> float:
    return max(width, height) / 1000.0


def anchor_box(anchor: str, cx: float, cy: float, offset: float, w: float, h: float) -> Box:
    """Text box of size ``w × h`` placed at ``anchor`` around (cx, cy) at distance ``offset``."""
    if anchor == "right":
        left, top = cx + offset, cy - h / 2
    elif anchor == "left":
        left, top = cx - offset - w, cy - h / 2
    elif anchor == "below":
        left, top = cx - w / 2, cy + offset
    elif anchor == "above":
        left, top = cx - w / 2, cy - offset - h
    else:
        d = offset * SQRT_HALF
        if anchor == "below-right":
            left, top = cx + d, cy + d
        elif anchor == "below-left":
            left, top = cx - d - w, cy + d
        elif anchor == "above-right":
            left, top = cx + d, cy - d - h
        elif anchor == "above-left":
            left, top = cx - d - w, cy - d - h
        else:
            raise ValueError(f"unknown anchor {anchor!r}")
    return Box(left, top, left + w, top + h)


def boxes_overlap(a: Box, b: Box, pad: float) -> bool:
    return (
        a.left < b.right + pad
        and b.left < a.right + pad
        and a.top < b.bottom + pad
        and b.top < a.bottom + pad
    )


def box_crosses_ring(box: Box, c: Circle, pad: float) -> bool:
    """True when the circle's outline passes through ``box`` (inflated by ``pad``).

    A box entirely inside a large marker (e.g. a star label inside M 42's circle) or
    entirely outside it is fine; sitting on the drawn ring is not. Squared distances only
    (#117): ``hypot`` is not bit-identical between Python and V8, and a corner exactly on
    ``r ± pad`` must fall on the same side in both placers.
    """
    nx = min(max(c.x, box.left), box.right)
    ny = min(max(c.y, box.top), box.bottom)
    dnx, dny = c.x - nx, c.y - ny
    nearest_sq = dnx * dnx + dny * dny
    fx = box.left if abs(c.x - box.left) > abs(c.x - box.right) else box.right
    fy = box.top if abs(c.y - box.top) > abs(c.y - box.bottom) else box.bottom
    dfx, dfy = c.x - fx, c.y - fy
    farthest_sq = dfx * dfx + dfy * dfy
    outer, inner = c.r + pad, c.r - pad
    return nearest_sq < outer * outer and (inner <= 0 or farthest_sq > inner * inner)


def segment_crosses_box(
    a: tuple[float, float], b: tuple[float, float], box: Box, pad: float
) -> bool:
    """True when the segment ``a``–``b`` enters ``box`` inflated by ``pad`` (#118): a leader
    running through another label's text. Products and sums only, like the ring tests: the
    box is convex, so the segment misses it exactly when a box axis or the segment's own line
    separates the two. A segment touching the inflated edge counts as clear."""
    left, top = box.left - pad, box.top - pad
    right, bottom = box.right + pad, box.bottom + pad
    (ax, ay), (bx, by) = a, b
    if max(ax, bx) <= left or min(ax, bx) >= right:
        return False
    if max(ay, by) <= top or min(ay, by) >= bottom:
        return False
    dx, dy = bx - ax, by - ay
    sides = [
        dx * (cy - ay) - dy * (cx - ax)
        for cx, cy in ((left, top), (right, top), (right, bottom), (left, bottom))
    ]
    return not (all(v <= 0 for v in sides) or all(v >= 0 for v in sides))


def segment_crosses_ring(
    a: tuple[float, float], b: tuple[float, float], c: Circle, pad: float
) -> bool:
    """True when the segment ``a``–``b`` cuts the circle's outline (inflated by ``pad``).

    The leader counterpart of ``box_crosses_ring``: a leader entirely inside a big marker
    (a Trapezium star's, inside M 42) or entirely outside it is fine; one that passes through
    the drawn ring is not. Squared distances only: ``hypot`` is not bit-identical between
    Python and V8, and a value on the threshold must fall on the same side in both renderers.
    """
    ax, ay = a[0] - c.x, a[1] - c.y
    bx, by = b[0] - c.x, b[1] - c.y
    dx, dy = bx - ax, by - ay
    length_sq = dx * dx + dy * dy
    t = 0.0 if length_sq == 0 else min(1.0, max(0.0, -(ax * dx + ay * dy) / length_sq))
    px, py = ax + t * dx, ay + t * dy
    nearest_sq = px * px + py * py
    farthest_sq = max(ax * ax + ay * ay, bx * bx + by * by)
    outer, inner = c.r + pad, c.r - pad
    return nearest_sq < outer * outer and (inner <= 0 or farthest_sq > inner * inner)


def ring_encloses(c: Circle, x: float, y: float) -> bool:
    """True when the point (x, y) lies strictly inside the circle: the outline itself does not
    count. ``route_leader`` drops a ring that encloses the leader's own marker (#220): a label
    outside that ring cannot be reached without crossing it. Squared distances only, as for the
    other ring tests."""
    dx, dy = x - c.x, y - c.y
    return dx * dx + dy * dy < c.r * c.r


def box_inside(box: Box, width: float, height: float) -> bool:
    return box.left >= 0 and box.top >= 0 and box.right <= width and box.bottom <= height


def ring_inside_frame(it: PlacementItem, width: float, height: float) -> bool:
    return it.radius <= min(it.x, it.y, width - it.x, height - it.y)


def _search(
    it: PlacementItem,
    radius: float,
    width: float,
    height: float,
    gap: float,
    pad: float,
    step: float,
    accepted: Sequence[Box],
    markers: Sequence[Circle],
) -> Box | None:
    """First anchor (ring by ring) whose box fits the frame and clears every obstacle."""
    for ring in range(MAX_RINGS + 1):
        offset = radius + gap + ring * step
        for anchor in ANCHORS:
            box = anchor_box(anchor, it.x, it.y, offset, it.w, it.h)
            if not box_inside(box, width, height):
                continue
            if any(boxes_overlap(box, other, pad) for other in accepted):
                continue
            if any(box_crosses_ring(box, c, pad) for c in markers):
                continue
            return box
    return None


def place_labels(
    width: float,
    height: float,
    items: Sequence[PlacementItem],
    *,
    fixed: Sequence[FixedItem] = (),
) -> list[Placement]:
    """Place every item; returns placements for ``items`` in their order, then one per
    ``fixed`` item in theirs.

    ``fixed`` items are obstacles that are never moved (labels the owner pinned or already
    positioned, and their markers), used by Auto-arrange and when re-solving. A placed item is
    ``collided`` when the search found no clean slot; a fixed one when, once everything else
    is laid out around it, its box touches another box or crosses another marker's ring.
    """
    s = scale_unit(width, height)
    gap = GAP_FACTOR * s
    pad = PAD_FACTOR * s
    step = RING_STEP_FACTOR * s

    order = sorted(items, key=lambda it: (-it.radius, it.id))
    accepted: list[Box] = [f.box for f in fixed]
    markers: list[Circle] = [f.circle for f in fixed]
    result: dict[int, Placement] = {}

    for it in order:
        chosen = _search(it, it.radius, width, height, gap, pad, step, accepted, markers)
        if chosen is None and not ring_inside_frame(it, width, height):
            # The catalogue circle spills past the frame, so no slot exists outside it.
            # Label the centre instead: a box inside a big marker is fine, only the ring
            # line is protected, and the renderer draws no leader for it.
            chosen = _search(it, 0.0, width, height, gap, pad, step, accepted, markers)
        collided = chosen is None
        if chosen is None:
            chosen = anchor_box("right", it.x, it.y, it.radius + gap, it.w, it.h)
        accepted.append(chosen)
        markers.append(Circle(it.x, it.y, it.radius))
        result[it.id] = Placement(it.id, chosen.left, chosen.top, collided)

    kept = [
        Placement(f.id, f.box.left, f.box.top, _touches(k, f.box, accepted, markers, pad))
        for k, f in enumerate(fixed)
    ]
    return [result[it.id] for it in items] + kept


def _touches(k: int, box: Box, boxes: Sequence[Box], markers: Sequence[Circle], pad: float) -> bool:
    """Whether ``box`` (the ``k``-th of ``boxes``, whose own ring is ``markers[k]``) touches any
    *other* box or crosses any other ring: the fixed items' ``collided``."""
    return any(boxes_overlap(box, o, pad) for i, o in enumerate(boxes) if i != k) or any(
        box_crosses_ring(box, c, pad) for i, c in enumerate(markers) if i != k
    )
