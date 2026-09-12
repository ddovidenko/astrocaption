from __future__ import annotations

import logging
from pathlib import Path

import pytest
from PIL import Image, JpegImagePlugin

from app.layout import build_default_annotations, default_style
from app.models import Annotations, Label, SolveObject
from app.placement import Box
from app.render import (
    ALIAS_SCALE,
    label_text,
    leader_segment,
    line_height,
    measure_label,
    render_annotated,
)
from tests.conftest import FONTS_DIR, write_test_image

OBJECTS = [
    SolveObject(
        id=1,
        catalog_names=["NGC 1976", "M 42", "Orion Nebula"],
        type="ngc",
        x=1100,
        y=1400,
        radius=130,
    ),
    SolveObject(
        id=2, catalog_names=["Alnitak", "HD 37742"], type="bright", x=1620, y=550, radius=0
    ),
]


def close(a: tuple[int, ...], b: tuple[int, ...], tol: int = 60) -> bool:
    return all(abs(x - y) <= tol for x, y in zip(a, b, strict=True))


def test_measurement_uses_line_heights_and_alias_scale() -> None:
    style = default_style(3000, 2000, FONTS_DIR)
    box = measure_label(FONTS_DIR, style, Label(object_id=1), OBJECTS[0])
    assert box.height == line_height(style.font_size) + line_height(
        round(style.font_size * ALIAS_SCALE)
    )
    no_alias = measure_label(FONTS_DIR, style, Label(object_id=1, show_aliases=False), OBJECTS[0])
    assert no_alias.height == line_height(style.font_size)
    assert no_alias.width <= box.width
    bigger = measure_label(
        FONTS_DIR, style, Label(object_id=1, font_size=style.font_size * 2), OBJECTS[0]
    )
    assert bigger.width > box.width and bigger.height > box.height


def test_label_text_override_and_alias_toggle() -> None:
    style = default_style(3000, 2000, FONTS_DIR)
    t = label_text(OBJECTS[0], Label(object_id=1), style)
    assert (t.primary, t.alias) == ("M 42", "NGC 1976 · Orion Nebula")
    t = label_text(
        OBJECTS[0], Label(object_id=1, text_override="  Orion  ", show_aliases=False), style
    )
    assert (t.primary, t.alias) == ("Orion", None)
    t = label_text(OBJECTS[0], Label(object_id=1, text_override="   "), style)
    assert t.primary == "M 42"


def test_leader_segment_geometry() -> None:
    seg = leader_segment(0, 0, 10, Box(100, -5, 200, 5))
    assert seg is not None
    (x1, y1), (x2, y2), gap = seg
    assert (x1, y1) == (10, 0) and (x2, y2) == (100, 0) and gap == 90
    assert leader_segment(0, 0, 10, Box(-5, -5, 5, 5)) is None


def test_render_keeps_size_draws_marker_and_preserves_icc(tmp_path: Path) -> None:
    icc = b"not-really-an-icc-profile-but-round-trips"
    original = write_test_image(tmp_path / "orig.jpg", 3000, 2000, icc_profile=icc)
    before = original.read_bytes()
    ann = build_default_annotations("x", 3000, 2000, OBJECTS, FONTS_DIR)
    out = tmp_path / "out.jpg"
    result = render_annotated(original, OBJECTS, ann, FONTS_DIR, out)
    assert (result.width, result.height) == (3000, 2000)
    assert original.read_bytes() == before  # never modified

    with Image.open(out) as img:
        assert img.size == (3000, 2000)
        assert img.info.get("icc_profile") == icc
        marker_edge = img.getpixel((1100 + 130, 1400))
        assert isinstance(marker_edge, tuple) and close(marker_edge, (255, 213, 74))
        background = img.getpixel((50, 50))
        assert isinstance(background, tuple) and close(background, (8, 10, 20), 12)


def test_render_scale_half(tmp_path: Path) -> None:
    original = write_test_image(tmp_path / "orig.jpg", 3000, 2000)
    ann = build_default_annotations("x", 3000, 2000, OBJECTS, FONTS_DIR)
    out = tmp_path / "half.jpg"
    result = render_annotated(original, OBJECTS, ann, FONTS_DIR, out, quality=80, scale=0.5)
    assert (result.width, result.height) == (1500, 1000)
    assert result.encoding == "quality 80, 4:4:4, progressive"


def test_default_export_matches_source_jpeg_tables(tmp_path: Path) -> None:
    original = write_test_image(tmp_path / "orig.jpg", 1200, 800, quality=92, subsampling=2)
    with Image.open(original) as src:
        assert isinstance(src, JpegImagePlugin.JpegImageFile)
        src_tables = src.quantization
        assert JpegImagePlugin.get_sampling(src) == 2
    ann = build_default_annotations("x", 1200, 800, OBJECTS[:1], FONTS_DIR)
    out = tmp_path / "match.jpg"
    preview = tmp_path / "sub" / "preview.jpg"
    result = render_annotated(original, OBJECTS[:1], ann, FONTS_DIR, out, preview_path=preview)
    with Image.open(preview) as p:
        assert p.size == (1200, 800)  # already within the preview bound
    assert result.encoding == "matched original JPEG tables, 4:2:0, progressive"
    with Image.open(out) as back:
        assert isinstance(back, JpegImagePlugin.JpegImageFile)
        assert back.quantization == src_tables
        assert JpegImagePlugin.get_sampling(back) == 2
        assert back.info.get("progressive") or back.info.get("progression")

    forced = tmp_path / "forced.jpg"
    result = render_annotated(original, OBJECTS[:1], ann, FONTS_DIR, forced, quality=70)
    assert result.encoding == "quality 70, 4:4:4, progressive"
    with Image.open(forced) as back:
        assert isinstance(back, JpegImagePlugin.JpegImageFile)
        assert back.quantization != src_tables
        assert JpegImagePlugin.get_sampling(back) == 0


def test_png_source_falls_back_to_quality_95(tmp_path: Path) -> None:
    original = write_test_image(tmp_path / "orig.png", 800, 600, fmt="PNG")
    ann = build_default_annotations("x", 800, 600, OBJECTS[:1], FONTS_DIR)
    result = render_annotated(original, OBJECTS[:1], ann, FONTS_DIR, tmp_path / "out.jpg")
    assert result.encoding == "quality 95, 4:4:4, progressive"


def test_leader_is_drawn_when_forced_on(tmp_path: Path) -> None:
    original = write_test_image(tmp_path / "orig.jpg", 3000, 2000)
    style = default_style(3000, 2000, FONTS_DIR)
    label = Label(object_id=2, x=2200.0, y=520.0, leader="on")
    ann = Annotations(image_id="x", style=style, labels=[label])
    out = tmp_path / "leader.jpg"
    render_annotated(original, OBJECTS, ann, FONTS_DIR, out)
    r = float(style.marker_min_radius)
    box = measure_label(FONTS_DIR, style, label, OBJECTS[1])
    seg = leader_segment(1620, 550, r, Box(2200, 520, 2200 + box.width, 520 + box.height))
    assert seg is not None
    (x1, y1), (x2, y2), _gap = seg
    mid = (round((x1 + x2) / 2), round((y1 + y2) / 2))
    with Image.open(out) as img:
        px = img.getpixel(mid)
        assert isinstance(px, tuple) and close(px, (255, 213, 74))


def test_render_falls_back_when_the_stored_font_is_gone(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    original = write_test_image(tmp_path / "orig.jpg", 3000, 2000)
    ann = build_default_annotations("x", 3000, 2000, OBJECTS, FONTS_DIR)
    assert ann.style.font_file == "Inter-Regular.ttf"
    gone = ann.model_copy(
        update={"style": ann.style.model_copy(update={"font_file": "Gone-Regular.ttf"})}
    )

    caplog.set_level(logging.WARNING, logger="app.fonts")
    out_gone = tmp_path / "gone.jpg"
    render_annotated(original, OBJECTS, gone, FONTS_DIR, out_gone)
    out_inter = tmp_path / "inter.jpg"
    render_annotated(original, OBJECTS, ann, FONTS_DIR, out_inter)

    assert out_gone.read_bytes() == out_inter.read_bytes()
    assert "Gone-Regular.ttf" in caplog.text
    assert "Inter-Regular.ttf" in caplog.text
