"""Server-side renderer (Pillow): text measurement and the full-resolution export.

The browser canvas (milestone 3) must implement the same layout rules:
  * a label is one or two lines drawn from its top-left corner ``(x, y)``;
  * line height is ``ceil(size * LINE_HEIGHT)``; the alias line uses ``ALIAS_SCALE``;
  * the marker is a circle of radius ``max(catalogue radius, style.marker_min_radius)``;
  * the leader runs from the marker edge to the closest point of the text box.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from PIL import Image, ImageDraw, JpegImagePlugin

from .fonts import load_font
from .models import Annotations, Label, SolveObject, StyleConfig
from .placement import Box, scale_unit

# Uploads are owner-only and capped by max_upload_mb; large astrophotos exceed Pillow's
# default decompression-bomb threshold (~89 MP).
Image.MAX_IMAGE_PIXELS = None

ALIAS_SCALE = 0.7
LINE_HEIGHT = 1.2
ALIAS_SEP = " · "
LEADER_GAP_FACTOR = 12.0  # auto leader when the box is farther than 12·s from the marker edge
MIN_FONT_SIZE = 6
DEFAULT_QUALITY = 95  # used when the source is not a JPEG and no quality was requested
SUBSAMPLING_NAMES = {0: "4:4:4", 1: "4:2:2", 2: "4:2:0"}


@dataclass(frozen=True)
class RenderResult:
    width: int
    height: int
    encoding: str  # human-readable description of the JPEG settings used


def jpeg_save_options(src: Image.Image, quality: int | None) -> tuple[dict[str, Any], str]:
    """Encoder settings for an export.

    With no explicit quality and a JPEG source, reuse the source's quantisation tables and
    chroma subsampling: the coefficients requantise onto the same grid, so the export is
    about the same size as the upload with the smallest possible generational loss.
    """
    tables = getattr(src, "quantization", None)
    if quality is None and src.format == "JPEG" and isinstance(tables, dict) and tables:
        sampling = JpegImagePlugin.get_sampling(src)
        if sampling not in SUBSAMPLING_NAMES:
            sampling = 0
        options: dict[str, Any] = {"qtables": tables, "subsampling": sampling}
        return options, f"matched original JPEG tables, {SUBSAMPLING_NAMES[sampling]}, progressive"
    q = DEFAULT_QUALITY if quality is None else quality
    return {"quality": q, "subsampling": 0}, f"quality {q}, 4:4:4, progressive"


@dataclass(frozen=True)
class LabelText:
    primary: str
    alias: str | None


@dataclass(frozen=True)
class LabelBox:
    width: int
    height: int
    primary_size: int
    alias_size: int
    line1_height: int
    line2_height: int


def effective_font_size(label: Label, style: StyleConfig) -> int:
    return label.font_size if label.font_size is not None else style.font_size


def alias_font_size(size: int) -> int:
    return max(MIN_FONT_SIZE, round(size * ALIAS_SCALE))


def line_height(size: int) -> int:
    return math.ceil(size * LINE_HEIGHT)


def marker_radius(obj: SolveObject, style: StyleConfig) -> float:
    return max(obj.radius, float(style.marker_min_radius))


def label_text(obj: SolveObject, label: Label, style: StyleConfig) -> LabelText:
    override = (label.text_override or "").strip()
    primary = override or obj.primary_name_for(style.name_preference)
    show = style.show_aliases if label.show_aliases is None else label.show_aliases
    aliases = obj.aliases_for(style.name_preference)
    alias = ALIAS_SEP.join(aliases) if show and aliases else None
    return LabelText(primary=primary, alias=alias)


def measure_label(fonts_dir: Path, style: StyleConfig, label: Label, obj: SolveObject) -> LabelBox:
    text = label_text(obj, label, style)
    size = effective_font_size(label, style)
    asize = alias_font_size(size)
    width = load_font(fonts_dir, style.font_file, size).getlength(text.primary)
    h1 = line_height(size)
    h2 = 0
    if text.alias:
        width = max(width, load_font(fonts_dir, style.font_file, asize).getlength(text.alias))
        h2 = line_height(asize)
    return LabelBox(
        width=math.ceil(width),
        height=h1 + h2,
        primary_size=size,
        alias_size=asize,
        line1_height=h1,
        line2_height=h2,
    )


def leader_segment(
    cx: float, cy: float, r: float, box: Box
) -> tuple[tuple[float, float], tuple[float, float], float] | None:
    """Segment from the marker edge to the closest point of ``box`` and the gap between them."""
    nx = min(max(cx, box.left), box.right)
    ny = min(max(cy, box.top), box.bottom)
    dx, dy = nx - cx, ny - cy
    dist = math.hypot(dx, dy)
    if dist <= r:
        return None
    ux, uy = dx / dist, dy / dist
    return (cx + ux * r, cy + uy * r), (nx, ny), dist - r


def leader_visible(label: Label, gap: float, s: float) -> bool:
    if label.leader == "on":
        return True
    if label.leader == "off":
        return False
    return gap > LEADER_GAP_FACTOR * s


def draw_annotations(
    img: Image.Image, objects: list[SolveObject], ann: Annotations, fonts_dir: Path
) -> None:
    """Draw markers, leaders and labels onto ``img`` in place (``img`` must be a copy)."""
    draw = ImageDraw.Draw(img)
    style = ann.style
    by_id = {o.id: o for o in objects}
    s = scale_unit(img.width, img.height)
    stroke = style.halo_width if style.halo else 0

    for label in ann.labels:
        obj = by_id.get(label.object_id)
        if not label.enabled or obj is None:
            continue
        r = marker_radius(obj, style)
        draw.ellipse(
            [obj.x - r, obj.y - r, obj.x + r, obj.y + r],
            outline=style.marker_color,
            width=style.marker_width,
        )
        box = measure_label(fonts_dir, style, label, obj)
        rect = Box(label.x, label.y, label.x + box.width, label.y + box.height)
        seg = leader_segment(obj.x, obj.y, r, rect)
        if seg is not None and leader_visible(label, seg[2], s):
            draw.line([seg[0], seg[1]], fill=style.leader_color, width=style.marker_width)
        text = label_text(obj, label, style)
        color = label.color or style.text_color
        draw.text(
            (label.x, label.y),
            text.primary,
            font=load_font(fonts_dir, style.font_file, box.primary_size),
            fill=color,
            stroke_width=stroke,
            stroke_fill=style.halo_color,
        )
        if text.alias:
            draw.text(
                (label.x, label.y + box.line1_height),
                text.alias,
                font=load_font(fonts_dir, style.font_file, box.alias_size),
                fill=color,
                stroke_width=stroke,
                stroke_fill=style.halo_color,
            )


def render_annotated(
    original_path: Path,
    objects: list[SolveObject],
    ann: Annotations,
    fonts_dir: Path,
    out_path: Path,
    *,
    quality: int | None = None,
    scale: float = 1.0,
) -> RenderResult:
    """Render ``original`` + annotations to ``out_path`` (JPEG). The original is never modified."""
    with Image.open(original_path) as src:
        icc = src.info.get("icc_profile")
        options, encoding = jpeg_save_options(src, quality)
        img = src.convert("RGB")
    draw_annotations(img, objects, ann, fonts_dir)
    if scale != 1.0:
        size = (max(1, round(img.width * scale)), max(1, round(img.height * scale)))
        img = img.resize(size, Image.Resampling.LANCZOS)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    img.save(out_path, "JPEG", optimize=True, progressive=True, icc_profile=icc, **options)
    return RenderResult(img.width, img.height, encoding)
