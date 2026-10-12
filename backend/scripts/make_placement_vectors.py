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

from app.placement import Box, Circle, FixedItem, PlacementItem, place_labels

OUT = Path(__file__).resolve().parent.parent.parent / "tests" / "fixtures" / "placement"


def _case(
    name: str,
    width: int,
    height: int,
    items: list[PlacementItem],
    fixed: list[FixedItem] | None = None,
) -> None:
    fixed = fixed or []
    placed = place_labels(width, height, items, fixed=fixed)
    doc = {
        "name": name,
        "width": width,
        "height": height,
        "items": [vars(i) for i in items],
        # The fixed items' placements follow the items' in ``expected`` (#107).
        "fixed": [{"id": f.id, "box": vars(f.box), "circle": vars(f.circle)} for f in fixed],
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
        fixed=[FixedItem(9, Box(1560, 970, 1900, 1030), Circle(1700, 1100, 90))],
    )
    _case(
        "fixed_collided",  # two pinned labels parked on each other, and one in a clean slot
        3000,
        2000,
        [PlacementItem(1, 1500, 1000, 40, 300, 60)],
        fixed=[
            FixedItem(7, Box(1400, 900, 1700, 960), Circle(1300, 930, 10)),
            FixedItem(8, Box(1405, 905, 1705, 965), Circle(1300, 1050, 10)),
            FixedItem(9, Box(200, 200, 500, 260), Circle(150, 230, 10)),
        ],
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
