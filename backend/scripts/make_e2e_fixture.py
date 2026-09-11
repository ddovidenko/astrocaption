"""Write frontend/e2e/fixtures/field.jpg: a 3000 × 2250 dark frame with deterministic stars.

The recorded nova fixtures come from a 3000 × 2250 solve copy, so this size puts every
recorded annotation inside the image. Run with ``make e2e-fixture``.
"""

from __future__ import annotations

import random
from pathlib import Path

from PIL import Image, ImageDraw

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
TARGET = REPO_ROOT / "frontend" / "e2e" / "fixtures" / "field.jpg"
WIDTH, HEIGHT = 3000, 2250


def main() -> None:
    img = Image.new("RGB", (WIDTH, HEIGHT), (8, 10, 20))
    draw = ImageDraw.Draw(img)
    rng = random.Random(7)
    for _ in range(400):
        x, y = rng.uniform(0, WIDTH), rng.uniform(0, HEIGHT)
        r = rng.uniform(1, 4)
        draw.ellipse([x - r, y - r, x + r, y + r], fill=(230, 230, 255))
    TARGET.parent.mkdir(parents=True, exist_ok=True)
    img.save(TARGET, "JPEG", quality=70, optimize=True)
    print(f"wrote {TARGET} ({TARGET.stat().st_size // 1024} KB)")


if __name__ == "__main__":
    main()
