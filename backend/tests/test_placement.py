from __future__ import annotations

import json
from pathlib import Path

import pytest

from app.placement import (
    ANCHORS,
    GAP_FACTOR,
    PAD_FACTOR,
    Box,
    Circle,
    PlacementItem,
    anchor_box,
    box_crosses_ring,
    box_inside,
    boxes_overlap,
    place_labels,
    scale_unit,
)

VECTORS = Path(__file__).resolve().parent.parent.parent / "tests" / "fixtures" / "placement"


def test_single_item_goes_right_at_gap() -> None:
    w, h = 3000, 2000
    s = scale_unit(w, h)
    item = PlacementItem(1, 1500, 1000, 40, 300, 60)
    [p] = place_labels(w, h, [item])
    assert p.x == pytest.approx(1500 + 40 + GAP_FACTOR * s)
    assert p.y == pytest.approx(1000 - 30)
    assert not p.collided


def test_near_right_edge_falls_back_to_left() -> None:
    w, h = 3000, 2000
    s = scale_unit(w, h)
    item = PlacementItem(1, 2950, 1000, 30, 400, 70)
    [p] = place_labels(w, h, [item])
    assert p.x == pytest.approx(2950 - 30 - GAP_FACTOR * s - 400)
    assert not p.collided


def test_stacked_items_do_not_overlap_and_avoid_larger_marker() -> None:
    w, h = 3000, 2000
    s = scale_unit(w, h)
    items = [PlacementItem(i, 1500, 1000, 130 - 30 * i, 320, 64) for i in range(1, 5)]
    placed = place_labels(w, h, items)
    boxes = [Box(p.x, p.y, p.x + 320, p.y + 64) for p in placed]
    assert not any(p.collided for p in placed)
    for i, a in enumerate(boxes):
        for b in boxes[i + 1 :]:
            assert not boxes_overlap(a, b, PAD_FACTOR * s)
    biggest = Circle(1500, 1000, 100)
    for p, b in zip(placed, boxes, strict=True):
        if p.id != 1:
            assert not box_crosses_ring(b, biggest, PAD_FACTOR * s)


def test_impossible_fit_is_marked_collided_and_falls_back_right() -> None:
    w, h = 400, 300
    s = scale_unit(w, h)
    items = [PlacementItem(i, 200, 150, 8, 390, 120) for i in range(1, 4)]
    placed = place_labels(w, h, items)
    assert sum(p.collided for p in placed) >= 1
    for p in placed:
        if p.collided:
            assert p.x == pytest.approx(200 + 8 + GAP_FACTOR * s)
            assert p.y == pytest.approx(150 - 60)


def test_fixed_obstacles_are_avoided() -> None:
    w, h = 3000, 2000
    item = PlacementItem(1, 1500, 1000, 40, 300, 60)
    blocker = Box(1540, 900, 2000, 1100)  # occupies the "right" slot
    [p] = place_labels(w, h, [item], fixed_boxes=[blocker])
    assert not boxes_overlap(
        Box(p.x, p.y, p.x + 300, p.y + 60), blocker, PAD_FACTOR * scale_unit(w, h)
    )
    assert not p.collided


def test_ring_semantics() -> None:
    big = Circle(0, 0, 1000)
    assert not box_crosses_ring(Box(-100, -100, 100, 100), big, 4)  # fully inside
    assert not box_crosses_ring(Box(1100, 0, 1300, 50), big, 4)  # fully outside
    assert box_crosses_ring(Box(900, -20, 1100, 20), big, 4)  # straddles the outline
    assert box_crosses_ring(Box(980, 0, 1200, 50), big, 4)  # within pad of the outline


def test_labels_inside_a_huge_marker_do_not_collide() -> None:
    """Trapezium case: four stars inside M 42's 1540 px circle must still get clean slots."""
    w, h = 7994, 5995
    items = [PlacementItem(1, 4019, 3142, 1540, 1778, 197)] + [
        PlacementItem(i, 4019 + i, 3142 + i, 48, 400, 197) for i in range(2, 6)
    ]
    placed = place_labels(w, h, items)
    assert not any(p.collided for p in placed)


def test_marker_larger_than_the_frame_is_labelled_at_its_centre() -> None:
    """M 31 on a 6248 × 4176 frame: its 3817 px ring leaves no slot outside it."""
    w, h = 6248, 4176
    s = scale_unit(w, h)
    m31 = PlacementItem(1, 3185, 2119, 3817, 900, 180)
    [p] = place_labels(w, h, [m31])
    assert not p.collided
    assert box_inside(Box(p.x, p.y, p.x + 900, p.y + 180), w, h)
    assert p.x == pytest.approx(3185 + GAP_FACTOR * s)  # "right" of the centre point
    assert p.y == pytest.approx(2119 - 90)
    # a small crowded object still reports a collision rather than moving into its marker
    crowd = [PlacementItem(i, 200, 150, 8, 390, 120) for i in range(1, 4)]
    assert any(q.collided for q in place_labels(400, 300, crowd))


def test_output_order_matches_input_order() -> None:
    items = [PlacementItem(5, 100, 100, 5, 50, 20), PlacementItem(2, 900, 900, 50, 50, 20)]
    assert [p.id for p in place_labels(1000, 1000, items)] == [5, 2]


def test_anchor_geometry_is_symmetric() -> None:
    boxes = {a: anchor_box(a, 0, 0, 10, 40, 20) for a in ANCHORS}
    assert boxes["right"].left == 10 and boxes["left"].right == -10
    assert boxes["below"].top == 10 and boxes["above"].bottom == -10
    assert boxes["below-right"].left == pytest.approx(boxes["below-right"].top)
    assert boxes["above-left"].right == pytest.approx(-boxes["below-right"].left)
    assert boxes["above-left"].bottom == pytest.approx(-boxes["below-right"].top)


@pytest.mark.parametrize("vector", sorted(VECTORS.glob("*.json")), ids=lambda p: p.stem)
def test_shared_vectors(vector: Path) -> None:
    doc = json.loads(vector.read_text(encoding="utf-8"))
    items = [PlacementItem(**it) for it in doc["items"]]
    placed = place_labels(
        doc["width"],
        doc["height"],
        items,
        fixed_boxes=[Box(**b) for b in doc["fixed_boxes"]],
        fixed_circles=[Circle(**c) for c in doc["fixed_circles"]],
    )
    assert len(placed) == len(doc["expected"])
    for got, want in zip(placed, doc["expected"], strict=True):
        assert got.id == want["id"]
        assert got.collided == want["collided"]
        assert got.x == pytest.approx(want["x"], abs=1e-9)
        assert got.y == pytest.approx(want["y"], abs=1e-9)


@pytest.mark.parametrize("vector", sorted(VECTORS.glob("random_*.json")), ids=lambda p: p.stem)
def test_random_vectors_satisfy_invariants(vector: Path) -> None:
    doc = json.loads(vector.read_text(encoding="utf-8"))
    w, h = doc["width"], doc["height"]
    s = scale_unit(w, h)
    items = {it["id"]: PlacementItem(**it) for it in doc["items"]}
    placed = place_labels(w, h, list(items.values()))
    ok = [p for p in placed if not p.collided]
    boxes = {p.id: Box(p.x, p.y, p.x + items[p.id].w, p.y + items[p.id].h) for p in ok}
    for p in ok:
        b = boxes[p.id]
        assert 0 <= b.left and 0 <= b.top and b.right <= w and b.bottom <= h
    ids = list(boxes)
    for i, first in enumerate(ids):
        for second in ids[i + 1 :]:
            assert not boxes_overlap(boxes[first], boxes[second], PAD_FACTOR * s), (first, second)
    for p in ok:
        for other in items.values():
            if other.radius > items[p.id].radius:
                circle = Circle(other.x, other.y, other.radius)
                assert not box_crosses_ring(boxes[p.id], circle, PAD_FACTOR * s)
