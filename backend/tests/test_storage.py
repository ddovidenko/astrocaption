from __future__ import annotations

from pathlib import Path

import pytest
from PIL import Image

from app import storage
from app.storage import (
    UnsupportedImageError,
    is_jpeg,
    make_derivatives,
    make_solve_copy,
    probe_image,
    to_rgb,
)
from tests.conftest import write_test_image


def first_band_extrema(img: Image.Image) -> tuple[int, int]:
    first = img.getextrema()[0]
    assert isinstance(first, tuple)
    return first


def write_16bit(path: Path, fmt: str, width: int = 300, height: int = 200) -> Path:
    """Greyscale ramp from 5000 to ~30000 in a 16-bit container."""
    img = Image.new("I", (width, height))
    img.putdata([5000 + (x * 25000 // width) for _y in range(height) for x in range(width)])
    img.convert("I;16").save(path, fmt)
    return path


@pytest.mark.parametrize(("fmt", "suffix"), [("PNG", ".png"), ("TIFF", ".tif")])
def test_16bit_greyscale_is_rescaled_not_clipped(tmp_path: Path, fmt: str, suffix: str) -> None:
    src = write_16bit(tmp_path / f"mono{suffix}", fmt)
    with Image.open(src) as img:
        assert img.mode in storage.HIGH_BIT_MODES
        rgb = to_rgb(img)
    assert rgb.mode == "RGB"
    lo, hi = first_band_extrema(rgb)
    assert 15 <= lo <= 25  # 5000 / 65535 * 255 ≈ 19
    assert 110 <= hi <= 122  # ~30000 / 65535 * 255 ≈ 117
    preview, _thumb = make_derivatives(src, tmp_path)
    with Image.open(preview) as p:
        assert first_band_extrema(p)[1] < 200  # not solid white
    assert make_solve_copy(src, tmp_path / "solve.jpg") == 1.0
    with Image.open(tmp_path / "solve.jpg") as s:
        assert first_band_extrema(s)[1] < 200


def test_probe_rejects_too_many_pixels(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    src = write_test_image(tmp_path / "big.png", 200, 100, fmt="PNG")
    monkeypatch.setattr(storage, "MAX_IMAGE_PIXELS", 10_000)
    with pytest.raises(UnsupportedImageError, match="megapixels"):
        probe_image(src)


def test_probe_uses_detected_format_not_extension(tmp_path: Path) -> None:
    src = write_test_image(tmp_path / "actually_png.jpg", 100, 80, fmt="PNG")
    assert probe_image(src) == (100, 80, "png")
    jpg = write_test_image(tmp_path / "real.jpeg", 100, 80)
    assert probe_image(jpg) == (100, 80, "jpg")


def test_mpo_camera_jpeg_is_accepted_as_jpeg(tmp_path: Path) -> None:
    frame = Image.new("RGB", (120, 90), (10, 20, 30))
    second = Image.new("RGB", (60, 45), (1, 2, 3))
    path = tmp_path / "camera.jpg"
    frame.save(path, "MPO", save_all=True, append_images=[second])
    with Image.open(path) as img:
        assert img.format == "MPO"
        assert is_jpeg(img)
    assert probe_image(path) == (120, 90, "jpg")
    preview, _thumb = make_derivatives(path, tmp_path)
    with Image.open(preview) as p:
        assert p.size == (120, 90)
