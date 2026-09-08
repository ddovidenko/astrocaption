"""Filesystem layout under the data directory and image derivative generation.

data/uploads/<id>/original.<ext>       the upload, byte-for-byte, never modified
data/uploads/<id>/preview.jpg          ≤ 2048 px preview
data/uploads/<id>/thumb.jpg            ≤ 400 px thumbnail
data/uploads/<id>/solve.jpg            ≤ 3000 px copy sent to the solver
data/uploads/<id>/nova_annotations.json  raw solver annotation list
data/uploads/<id>/wcs.fits             WCS header returned by the solver
data/renders/<id>/annotated.jpg        latest export
data/renders/<id>/annotated_preview.jpg  ≤ 2048 px copy of the export
"""

from __future__ import annotations

import shutil
from pathlib import Path

from PIL import Image, UnidentifiedImageError

from .config import Settings

Image.MAX_IMAGE_PIXELS = None

PREVIEW_MAX_PX = 2048
THUMB_MAX_PX = 400
SOLVE_MAX_PX = 3000
PREVIEW_QUALITY = 88
THUMB_QUALITY = 85
SOLVE_QUALITY = 92

ALLOWED_EXTENSIONS = {".jpg": "jpg", ".jpeg": "jpg", ".png": "png", ".tif": "tif", ".tiff": "tif"}
ALLOWED_FORMATS = {"JPEG", "PNG", "TIFF"}


class UnsupportedImageError(ValueError):
    pass


def image_dir(settings: Settings, image_id: str) -> Path:
    return settings.uploads_dir / image_id


def render_dir(settings: Settings, image_id: str) -> Path:
    return settings.renders_dir / image_id


def normalised_extension(filename: str) -> str | None:
    return ALLOWED_EXTENSIONS.get(Path(filename).suffix.lower())


def probe_image(path: Path) -> tuple[int, int]:
    """Validate the upload with Pillow and return ``(width, height)``."""
    try:
        with Image.open(path) as img:
            if img.format not in ALLOWED_FORMATS:
                raise UnsupportedImageError(f"unsupported image format: {img.format}")
            width, height = img.size
    except UnidentifiedImageError as exc:
        raise UnsupportedImageError("file is not a readable image") from exc
    if width < 16 or height < 16:
        raise UnsupportedImageError("image is too small")
    return width, height


def _fit(width: int, height: int, max_px: int) -> tuple[int, int]:
    longest = max(width, height)
    if longest <= max_px:
        return width, height
    f = max_px / longest
    return max(1, round(width * f)), max(1, round(height * f))


def _open_rgb(path: Path, draft_px: int | None = None) -> tuple[Image.Image, bytes | None]:
    with Image.open(path) as src:
        icc = src.info.get("icc_profile")
        if draft_px is not None and src.format == "JPEG":
            # DCT-domain downscale: decodes a 60 MB JPEG several times faster.
            src.draft("RGB", (draft_px * 2, draft_px * 2))
        img = src.convert("RGB")
    return img, icc


def make_derivatives(original: Path, dest_dir: Path) -> tuple[Path, Path]:
    """Write preview.jpg and thumb.jpg next to the original; returns their paths."""
    img, icc = _open_rgb(original, draft_px=PREVIEW_MAX_PX)
    preview = img.resize(_fit(img.width, img.height, PREVIEW_MAX_PX), Image.Resampling.LANCZOS)
    preview_path = dest_dir / "preview.jpg"
    preview.save(preview_path, "JPEG", quality=PREVIEW_QUALITY, optimize=True, icc_profile=icc)
    thumb = preview.resize(
        _fit(preview.width, preview.height, THUMB_MAX_PX), Image.Resampling.LANCZOS
    )
    thumb_path = dest_dir / "thumb.jpg"
    thumb.save(thumb_path, "JPEG", quality=THUMB_QUALITY, optimize=True, icc_profile=icc)
    return preview_path, thumb_path


def make_solve_copy(original: Path, dest: Path) -> float:
    """Write the ≤ SOLVE_MAX_PX JPEG sent to the solver; returns ``original_width / copy_width``."""
    with Image.open(original) as src:
        orig_w, _orig_h = src.size
    img, _icc = _open_rgb(original, draft_px=SOLVE_MAX_PX)
    target = _fit(orig_w, _orig_h, SOLVE_MAX_PX)
    if img.size != target:
        img = img.resize(target, Image.Resampling.LANCZOS)
    img.save(dest, "JPEG", quality=SOLVE_QUALITY, optimize=True)
    return orig_w / img.width


def make_annotated_preview(render_path: Path, dest: Path) -> None:
    img, icc = _open_rgb(render_path, draft_px=PREVIEW_MAX_PX)
    preview = img.resize(_fit(img.width, img.height, PREVIEW_MAX_PX), Image.Resampling.LANCZOS)
    preview.save(dest, "JPEG", quality=PREVIEW_QUALITY, optimize=True, icc_profile=icc)


def delete_image_files(settings: Settings, image_id: str) -> None:
    shutil.rmtree(image_dir(settings, image_id), ignore_errors=True)
    shutil.rmtree(render_dir(settings, image_id), ignore_errors=True)
