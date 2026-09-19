from __future__ import annotations

import logging
from pathlib import Path

import pytest
from PIL import Image, JpegImagePlugin

from app.fonts import resolve_font_file
from app.layout import build_default_annotations, default_style
from app.models import Annotations, Label, SolveObject
from app.placement import Box, Circle, segment_crosses_ring
from app.render import (
    ALIAS_SCALE,
    label_text,
    leader_segment,
    line_height,
    measure_label,
    render_annotated,
    route_leader,
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
    assert (t.primary, t.alias) == ("M 42", "Orion Nebula · NGC 1976")
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


def test_segment_crosses_ring_only_when_it_cuts_the_outline() -> None:
    # Through a small ring: crosses.
    assert segment_crosses_ring((10, 0), (100, 0), Circle(50, 0, 5), 4)
    # Passing the ring's centre at r + pad - epsilon: still crosses (the pad is a margin).
    assert segment_crosses_ring((10, -8.5), (100, -8.5), Circle(50, 0, 5), 4)
    # Passing it at exactly r + pad: clear (strict, and exact in both languages: no hypot).
    assert not segment_crosses_ring((10, -9), (100, -9), Circle(50, 0, 5), 4)
    # Entirely inside a big ring (a Trapezium star's leader inside M 42): clear.
    assert not segment_crosses_ring((10, 0), (100, 0), Circle(30, 0, 500), 4)
    # From inside a big ring to outside it: crosses the outline.
    assert segment_crosses_ring((10, 0), (100, 0), Circle(30, 0, 60), 4)
    # Ending short of the outline (inside r - pad): clear.
    assert not segment_crosses_ring((10, 0), (50, 0), Circle(30, 0, 60), 4)
    # Ending exactly on r - pad: clear (strict).
    assert not segment_crosses_ring((10, 0), (86, 0), Circle(30, 0, 60), 4)
    # A zero-length segment is a point.
    assert segment_crosses_ring((50, 3), (50, 3), Circle(50, 0, 5), 4)


def test_route_leader_avoids_another_ring() -> None:
    box = Box(100, -60, 200, 60)
    # No obstacles: the nearest point, as the plain segment.
    assert route_leader(0, 0, 10, box, [], 4) == leader_segment(0, 0, 10, box)[:2]  # type: ignore[index]
    # A ring in the way of the nearest point (the left face's midpoint): the marker is level
    # with the box, so only the left face faces it, and its top corner is the first clear one.
    routed = route_leader(0, 0, 10, box, [Circle(50, 0, 5)], 4)
    assert routed is not None
    (x1, y1), (x2, y2) = routed
    assert (x2, y2) == (100, -60)
    dist = (100**2 + 60**2) ** 0.5
    assert abs(x1 - 100 / dist * 10) < 1e-9 and abs(y1 - (-60) / dist * 10) < 1e-9
    # That corner's path blocked too: the bottom corner.
    blockers = [Circle(50, 0, 5), Circle(50, -30, 5)]
    routed = route_leader(0, 0, 10, box, blockers, 4)
    assert routed is not None and routed[1] == (100, 60)
    # Nothing clears: the nearest point is used.
    routed = route_leader(0, 0, 10, box, [Circle(30, 0, 60)], 4)
    assert routed is not None and routed[1] == (100, 0)
    # Entirely inside a big ring: the nearest point stays.
    routed = route_leader(0, 0, 10, box, [Circle(30, 0, 500)], 4)
    assert routed is not None and routed[1] == (100, 0)
    # The box swallowing the marker still means no leader, whatever the obstacles.
    assert route_leader(0, 0, 10, Box(-5, -5, 5, 5), [Circle(50, 0, 5)], 4) is None


def test_route_leader_never_crosses_the_label_itself() -> None:
    """Only the box's faces that face the marker (and their corners) are candidates: with the
    near side fully blocked, the far corners are clear of every ring but would run the leader
    across the text, so the nearest point is used instead."""
    box = Box(100, -60, 200, 60)
    blockers = [Circle(50, 0, 5), Circle(50, -30, 5), Circle(50, 30, 5)]
    routed = route_leader(0, 0, 10, box, blockers, 4)
    assert routed is not None and routed[1] == (100, 0)
    # A marker above the box sees the top face and its corners, never the bottom ones.
    above = Box(-100, 100, 100, 160)
    blockers = [Circle(0, 50, 5), Circle(-50, 50, 5), Circle(50, 50, 5)]
    routed = route_leader(0, 0, 10, above, blockers, 4)
    assert routed is not None and routed[1] == (0, 100)
    # Diagonal to the box: both facing faces' midpoints and three corners are candidates.
    diagonal = Box(100, 100, 200, 160)
    routed = route_leader(0, 0, 10, diagonal, [Circle(50, 50, 5)], 4)
    assert routed is not None and routed[1] == (150, 100)


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


def test_leader_routes_around_another_marker(tmp_path: Path) -> None:
    """Alnitak's label at the edge of M 42's shadow: the nearest-point leader (top-right
    corner) would cut M 42's ring; the right edge's midpoint clears it (#14). A disabled
    label's ring on that route does not count."""
    original = write_test_image(tmp_path / "orig.jpg", 3000, 2000)
    style = default_style(3000, 2000, FONTS_DIR)
    box = measure_label(FONTS_DIR, style, Label(object_id=2), OBJECTS[1])
    label = Label(object_id=2, x=1200.0 - box.width, y=1520.0, leader="on")
    # A star on the routed leader's path, whose label is off: no obstacle.
    bystander = SolveObject(id=3, catalog_names=["HD 1"], type="hd", x=1410, y=1053, radius=0)
    labels = [Label(object_id=1, x=1300, y=1300), label, Label(object_id=3, enabled=False)]
    ann = Annotations(image_id="x", style=style, labels=labels)
    out = tmp_path / "leader.jpg"
    render_annotated(original, [*OBJECTS, bystander], ann, FONTS_DIR, out)
    r = float(style.marker_min_radius)
    rect = Box(label.x, label.y, label.x + box.width, label.y + box.height)
    naive = leader_segment(1620, 550, r, rect)
    routed = route_leader(1620, 550, r, rect, [Circle(1100, 1400, 130)], 4 * 3)
    assert naive is not None and routed is not None
    assert naive[1] == (rect.right, rect.top)
    assert routed[1] == (rect.right, (rect.top + rect.bottom) / 2)
    counted = route_leader(1620, 550, r, rect, [Circle(1100, 1400, 130), Circle(1410, 1053, r)], 12)
    assert counted is not None and counted[1] != routed[1]  # the bystander would have mattered
    with Image.open(out) as img:
        for (x1, y1), (x2, y2), drawn in ((*routed, True), (naive[0], naive[1], False)):
            px = img.getpixel((round(x1 + 0.8 * (x2 - x1)), round(y1 + 0.8 * (y2 - y1))))
            assert isinstance(px, tuple) and close(px, (255, 213, 74)) == drawn


def test_auto_leader_is_decided_on_the_nearest_gap(tmp_path: Path) -> None:
    """A label adjacent to its marker draws no auto leader even when a ring beside the gap would
    route a forced one elsewhere: avoidance never decides whether a leader exists."""
    original = write_test_image(tmp_path / "orig.jpg", 3000, 2000)
    style = default_style(3000, 2000, FONTS_DIR)
    r = float(style.marker_min_radius)
    # Alnitak at (1620, 550); this box's nearest gap is 34.8 px < 12·s = 36, and a star ring
    # beside that gap would send a forced leader to the box's bottom-right corner.
    bystander = SolveObject(id=3, catalog_names=["HD 1"], type="hd", x=1580.5, y=544.3, radius=0)
    box = measure_label(FONTS_DIR, style, Label(object_id=2), OBJECTS[1])
    rect = Box(1470, 434, 1470 + box.width, 434 + box.height)
    naive = leader_segment(1620, 550, r, rect)
    routed = route_leader(1620, 550, r, rect, [Circle(bystander.x, bystander.y, r)], 12)
    assert naive is not None and routed is not None
    assert naive[2] < 36 and routed[1] != naive[1]
    objects = [*OBJECTS, bystander]
    for mode, drawn in (("auto", False), ("on", True)):
        label = Label(object_id=2, x=1470.0, y=434.0, leader=mode)  # type: ignore[arg-type]
        labels = [Label(object_id=1, enabled=False), label, Label(object_id=3, x=1900, y=900)]
        ann = Annotations(image_id="x", style=style, labels=labels)
        out = tmp_path / f"leader-{mode}.jpg"
        render_annotated(original, objects, ann, FONTS_DIR, out)
        with Image.open(out) as img:
            (x1, y1), (x2, y2) = routed
            px = img.getpixel((round(x1 + 0.5 * (x2 - x1)), round(y1 + 0.5 * (y2 - y1))))
            assert isinstance(px, tuple) and close(px, (255, 213, 74)) == drawn


def test_render_falls_back_when_the_stored_font_is_gone(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    original = write_test_image(tmp_path / "orig.jpg", 3000, 2000)
    ann = build_default_annotations("x", 3000, 2000, OBJECTS, FONTS_DIR)
    assert ann.style.font_file == "Inter-Regular.ttf"
    gone = ann.model_copy(
        update={"style": ann.style.model_copy(update={"font_file": "Gone-Regular.ttf"})}
    )

    resolve_font_file.cache_clear()  # the warning is now cached per (fonts_dir, file)
    caplog.set_level(logging.WARNING, logger="app.fonts")
    out_gone = tmp_path / "gone.jpg"
    render_annotated(original, OBJECTS, gone, FONTS_DIR, out_gone)
    out_inter = tmp_path / "inter.jpg"
    render_annotated(original, OBJECTS, ann, FONTS_DIR, out_inter)

    assert out_gone.read_bytes() == out_inter.read_bytes()
    assert "Gone-Regular.ttf" in caplog.text
    assert "Inter-Regular.ttf" in caplog.text
