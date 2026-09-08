"""(Re)generate the favicon set in frontend/public/ from frontend/icon/icon-source.png.

The master is a square, opaque PNG. Vite copies frontend/public/ verbatim into the build,
so the outputs land at the site root and are linked from frontend/index.html.
Run from backend/:  python scripts/make_favicons.py   (or `make favicons` at the repo root)
"""

from __future__ import annotations

import json
from pathlib import Path

from PIL import Image, ImageFilter

FRONTEND = Path(__file__).resolve().parent.parent.parent / "frontend"
SOURCE = FRONTEND / "icon" / "icon-source.png"
OUT = FRONTEND / "public"

ICO_SIZES = [16, 32, 48]
PNG_FILES = {
    "favicon-16x16.png": 16,
    "favicon-32x32.png": 32,
    "apple-touch-icon.png": 180,
    "icon-192.png": 192,
    "icon-512.png": 512,
}


# At 32 px and below the grid and tick marks are finer than a pixel and only add mud, so
# small sizes keep just the bright shapes, slightly thickened, with a touch of sharpening.
SMALL_MAX = 32
SMALL_KEEP_LUMINANCE = 160
SMALL_DILATE_PX = 5


def _simplified(source: Image.Image) -> Image.Image:
    background = Image.new("RGB", source.size, source.getpixel((2, 2)))
    faint = source.convert("L").point(lambda v: 255 if v < SMALL_KEEP_LUMINANCE else 0)
    return Image.composite(background, source, faint).filter(ImageFilter.MaxFilter(SMALL_DILATE_PX))


def _resized(source: Image.Image, size: int) -> Image.Image:
    if size > SMALL_MAX:
        return source.resize((size, size), Image.Resampling.LANCZOS)
    small = _simplified(source).resize((size, size), Image.Resampling.LANCZOS)
    return small.filter(ImageFilter.UnsharpMask(radius=1, percent=120, threshold=2))


def main() -> None:
    source = Image.open(SOURCE).convert("RGB")
    if source.width != source.height:
        raise SystemExit(f"{SOURCE.name} must be square, got {source.width}x{source.height}")
    OUT.mkdir(parents=True, exist_ok=True)

    for name, size in PNG_FILES.items():
        _resized(source, size).save(OUT / name, optimize=True)

    # Pillow's ICO writer downsamples one image itself, which would skip the small-size
    # treatment, so supply every frame. The primary image must be the largest: the writer
    # drops any requested size bigger than it.
    frames = [_resized(source, s) for s in sorted(ICO_SIZES, reverse=True)]
    frames[0].save(
        OUT / "favicon.ico",
        sizes=[(s, s) for s in ICO_SIZES],
        append_images=frames[1:],
    )

    # Sample the corner for the browser-chrome colour so the tab strip matches the icon.
    r, g, b = source.getpixel((2, 2))  # type: ignore[misc]
    theme = f"#{r:02x}{g:02x}{b:02x}"
    manifest = {
        "name": "AstroCaption",
        "short_name": "AstroCaption",
        "icons": [
            {"src": "/icon-192.png", "sizes": "192x192", "type": "image/png"},
            {"src": "/icon-512.png", "sizes": "512x512", "type": "image/png"},
        ],
        "theme_color": theme,
        "background_color": theme,
        "display": "standalone",
    }
    (OUT / "site.webmanifest").write_text(json.dumps(manifest, indent=2) + "\n")
    print(f"wrote {len(PNG_FILES) + 2} files to {OUT.relative_to(FRONTEND.parent)}  theme {theme}")


if __name__ == "__main__":
    main()
