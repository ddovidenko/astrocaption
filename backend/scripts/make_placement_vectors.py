"""(Re)generate the shared auto-placement test vectors in tests/fixtures/placement/.

The vectors pin the Python implementation's output; the TypeScript port (milestone 3)
must reproduce them exactly. Run from backend/:  python scripts/make_placement_vectors.py
"""

from __future__ import annotations

import json
import random
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.placement import Box, Circle, PlacementItem, place_labels

OUT = Path(__file__).resolve().parent.parent.parent / "tests" / "fixtures" / "placement"


def _case(
    name: str,
    width: int,
    height: int,
    items: list[PlacementItem],
    fixed_boxes: list[Box] | None = None,
    fixed_circles: list[Circle] | None = None,
) -> None:
    fb = fixed_boxes or []
    fc = fixed_circles or []
    placed = place_labels(width, height, items, fixed_boxes=fb, fixed_circles=fc)
    doc = {
        "name": name,
        "width": width,
        "height": height,
        "items": [vars(i) for i in items],
        "fixed_boxes": [vars(b) for b in fb],
        "fixed_circles": [vars(c) for c in fc],
        "expected": [vars(p) for p in placed],
    }
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / f"{name}.json").write_text(json.dumps(doc, indent=1) + "\n", encoding="utf-8")
    print("wrote", name, "collided:", sum(p.collided for p in placed))


def main() -> None:
    _case("single_right", 3000, 2000, [PlacementItem(1, 1500, 1000, 40, 300, 60)])
    _case(
        "edge_left_fallback",
        3000,
        2000,
        [PlacementItem(1, 2950, 1000, 30, 400, 70), PlacementItem(2, 40, 1990, 10, 200, 40)],
    )
    _case(
        "stacked_same_position",
        3000,
        2000,
        [
            PlacementItem(1, 1500, 1000, 120, 320, 64),
            PlacementItem(2, 1500, 1000, 40, 260, 64),
            PlacementItem(3, 1500, 1000, 20, 180, 40),
            PlacementItem(4, 1500, 1000, 12, 150, 40),
        ],
    )
    _case(
        "collision_forced",
        400,
        300,
        [PlacementItem(i, 200, 150, 8, 390, 120) for i in range(1, 5)],
    )
    _case(
        "fixed_obstacles",
        3000,
        2000,
        [PlacementItem(1, 1500, 1000, 40, 300, 60), PlacementItem(2, 1500, 1200, 20, 300, 60)],
        fixed_boxes=[Box(1560, 970, 1900, 1030)],
        fixed_circles=[Circle(1700, 1100, 90)],
    )
    _case(
        "huge_marker_centre_label",  # M 31 filling a 6248 × 4176 frame; ring spills past every edge
        6248,
        4176,
        [
            PlacementItem(1, 3185, 2119, 3817, 900, 180),
            PlacementItem(2, 2674, 3614, 348, 600, 180),
            PlacementItem(3, 2685, 1207, 166, 500, 180),
            PlacementItem(4, 6025, 96, 37, 400, 180),
        ],
    )
    rng = random.Random(20260907)
    for k in range(3):
        w, h = rng.choice([(6000, 4000), (4128, 2752), (1920, 1080)])
        items = [
            PlacementItem(
                i,
                round(rng.uniform(0, w), 1),
                round(rng.uniform(0, h), 1),
                round(rng.choice([0, 0, 0, 5, 12, 30, 80, 200]) * w / 3000 + 6, 1),
                round(rng.uniform(80, 600) * w / 3000),
                round(rng.uniform(30, 90) * w / 3000),
            )
            for i in range(1, rng.randint(12, 40))
        ]
        _case(f"random_{k}", w, h, items)


if __name__ == "__main__":
    main()
