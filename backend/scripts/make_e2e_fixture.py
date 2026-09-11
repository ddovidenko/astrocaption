"""Write frontend/e2e/fixtures/field.jpg: a 3000 × 2250 dark frame with deterministic stars.

The recorded nova fixtures come from a 3000 × 2250 solve copy, so this size puts every
recorded annotation inside the image. Run with ``make e2e-fixture``.
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.config import REPO_ROOT
from tests.conftest import write_test_image

TARGET = REPO_ROOT / "frontend" / "e2e" / "fixtures" / "field.jpg"


def main() -> None:
    write_test_image(TARGET, 3000, 2250, quality=70, optimize=True)
    print(f"wrote {TARGET} ({TARGET.stat().st_size // 1024} KB)")


if __name__ == "__main__":
    main()
