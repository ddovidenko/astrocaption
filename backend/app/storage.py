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

import logging
import shutil
from dataclasses import dataclass
from pathlib import Path

from PIL import Image, JpegImagePlugin, UnidentifiedImageError

from .config import Settings

log = logging.getLogger(__name__)

# Uploads may be large astrophotos, but a decompression bomb (a tiny file declaring a huge
# canvas) must not take the single process down. Pillow warns above this and refuses at 2×;
# probe_image refuses at 1× before anything is decoded.
MAX_IMAGE_PIXELS = 300_000_000
Image.MAX_IMAGE_PIXELS = MAX_IMAGE_PIXELS

PREVIEW_MAX_PX = 2048
THUMB_MAX_PX = 400
SOLVE_MAX_PX = 3000
PREVIEW_QUALITY = 88
THUMB_QUALITY = 85
SOLVE_QUALITY = 92

HIGH_BIT_MODES = ("I;16", "I;16L", "I;16B", "I;16N", "I", "F")


@dataclass(frozen=True)
class ImageFormat:
    name: str  # shown to the owner
    media_type: str
    pillow: tuple[str, ...]  # Pillow format ids that map to this stored extension
    suffixes: tuple[str, ...]  # upload file-name suffixes accepted for it


# The one table describing what can be uploaded, keyed by the extension we store it under.
# Pillow reports a JPEG carrying an MPF multi-picture segment (many cameras) as "MPO".
FORMATS: dict[str, ImageFormat] = {
    "jpg": ImageFormat("JPEG", "image/jpeg", ("JPEG", "MPO"), (".jpg", ".jpeg")),
    "png": ImageFormat("PNG", "image/png", ("PNG",), (".png",)),
    "tif": ImageFormat("TIFF", "image/tiff", ("TIFF",), (".tif", ".tiff")),
}
_SUFFIX_TO_EXT = {suffix: ext for ext, fmt in FORMATS.items() for suffix in fmt.suffixes}
_PILLOW_TO_EXT = {pillow: ext for ext, fmt in FORMATS.items() for pillow in fmt.pillow}


class UnsupportedImageError(ValueError):
    pass


def image_dir(settings: Settings, image_id: str) -> Path:
    return settings.uploads_dir / image_id


def render_dir(settings: Settings, image_id: str) -> Path:
    return settings.renders_dir / image_id


def normalised_extension(filename: str) -> str | None:
    return _SUFFIX_TO_EXT.get(Path(filename).suffix.lower())


def format_of(path: Path) -> ImageFormat | None:
    """The stored format of an original, from its extension."""
    return FORMATS.get(path.suffix.lstrip(".").lower())


def is_jpeg(img: Image.Image) -> bool:
    """True for JPEG and MPO (a JPEG with a multi-picture segment)."""
    return isinstance(img, JpegImagePlugin.JpegImageFile)


def probe_image(path: Path) -> tuple[int, int, str]:
    """Validate an upload without decoding it; returns ``(width, height, extension)``.

    The extension comes from the detected format, not the upload's file name.
    """
    try:
        with Image.open(path) as img:
            ext = _PILLOW_TO_EXT.get(img.format or "")
            if ext is None:
                raise UnsupportedImageError(f"unsupported image format: {img.format}")
            width, height = img.size
    except UnidentifiedImageError as exc:
        raise UnsupportedImageError("file is not a readable image") from exc
    except Image.DecompressionBombError as exc:
        raise UnsupportedImageError("image declares too many pixels") from exc
    if width < 16 or height < 16:
        raise UnsupportedImageError("image is too small")
    if width * height > MAX_IMAGE_PIXELS:
        raise UnsupportedImageError(
            f"image has {width * height / 1e6:.0f} megapixels; the limit is"
            f" {MAX_IMAGE_PIXELS / 1e6:.0f}"
        )
    return width, height, ext


def to_rgb(img: Image.Image) -> Image.Image:
    """8-bit RGB copy of ``img``.

    16-bit and floating-point greyscale (mono masters, 16-bit TIFF/PNG exports) are rescaled
    from their full range; a plain ``convert("RGB")`` would clip everything above 255 to white.
    """
    if img.mode not in HIGH_BIT_MODES:
        return img.convert("RGB")
    if img.mode in ("I", "F"):
        hi = _band_max(img)
        peak = 65535.0 if img.mode == "I" and hi <= 65535 else max(hi, 1.0)
        work = img
    else:  # the I;16 family always spans 0..65535
        peak = 65535.0
        work = img.convert("I")
    return work.point(lambda v: v * (255.0 / peak)).convert("L").convert("RGB")


def _band_max(img: Image.Image) -> float:
    """Maximum sample value of a single-band image (``getextrema`` is typed for both shapes)."""
    hi = img.getextrema()[1]
    return float(hi) if isinstance(hi, int | float) else 0.0


def fit_within(width: int, height: int, max_px: int) -> tuple[int, int]:
    longest = max(width, height)
    if longest <= max_px:
        return width, height
    f = max_px / longest
    return max(1, round(width * f)), max(1, round(height * f))


def write_preview(img: Image.Image, dest: Path, icc: bytes | None) -> None:
    """Save a ≤ PREVIEW_MAX_PX JPEG copy of an RGB image."""
    preview = img.resize(
        fit_within(img.width, img.height, PREVIEW_MAX_PX), Image.Resampling.LANCZOS
    )
    dest.parent.mkdir(parents=True, exist_ok=True)
    preview.save(dest, "JPEG", quality=PREVIEW_QUALITY, optimize=True, icc_profile=icc)


def _open_rgb(path: Path, draft_px: int | None = None) -> tuple[Image.Image, bytes | None]:
    """Decode fully; a truncated or corrupt file surfaces as UnsupportedImageError."""
    try:
        with Image.open(path) as src:
            icc = src.info.get("icc_profile")
            if draft_px is not None and is_jpeg(src):
                # DCT-domain downscale: decodes a 60 MB JPEG several times faster.
                src.draft("RGB", (draft_px * 2, draft_px * 2))
            img = to_rgb(src)
    except UnidentifiedImageError as exc:
        raise UnsupportedImageError("file is not a readable image") from exc
    except OSError as exc:
        if exc.errno is not None:
            raise  # a real OS error (disk, permissions) is the system's, not the file's
        raise UnsupportedImageError("image data is truncated or corrupt") from exc
    return img, icc


def make_derivatives(original: Path, dest_dir: Path) -> tuple[Path, Path]:
    """Write preview.jpg and thumb.jpg next to the original; returns their paths."""
    img, icc = _open_rgb(original, draft_px=PREVIEW_MAX_PX)
    preview_path = dest_dir / "preview.jpg"
    write_preview(img, preview_path, icc)
    with Image.open(preview_path) as preview:
        thumb = preview.resize(
            fit_within(preview.width, preview.height, THUMB_MAX_PX), Image.Resampling.LANCZOS
        )
    thumb_path = dest_dir / "thumb.jpg"
    thumb.save(thumb_path, "JPEG", quality=THUMB_QUALITY, optimize=True, icc_profile=icc)
    return preview_path, thumb_path


def make_solve_copy(original: Path, dest: Path) -> float:
    """Write the ≤ SOLVE_MAX_PX JPEG sent to the solver; returns ``original_width / copy_width``."""
    with Image.open(original) as src:
        orig_w, orig_h = src.size
    img, _icc = _open_rgb(original, draft_px=SOLVE_MAX_PX)
    target = fit_within(orig_w, orig_h, SOLVE_MAX_PX)
    if img.size != target:
        img = img.resize(target, Image.Resampling.LANCZOS)
    img.save(dest, "JPEG", quality=SOLVE_QUALITY, optimize=True)
    return orig_w / img.width


def _log_rm_error(_func: object, path: str, exc: BaseException) -> None:
    if not isinstance(exc, FileNotFoundError):
        log.warning("could not remove %s: %s", path, exc)


def delete_image_files(settings: Settings, image_id: str) -> None:
    shutil.rmtree(image_dir(settings, image_id), onexc=_log_rm_error)
    shutil.rmtree(render_dir(settings, image_id), onexc=_log_rm_error)
