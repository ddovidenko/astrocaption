"""(Re)generate tests/fixtures/render/vectors.json: the numbers the canvas must reproduce.

The file pins ``render.py`` (text boxes, line heights, alias sizes, ascents, leader geometry)
and ``placement.anchor_box`` for real label strings from both nova fixtures in every bundled
font. Three tests read it: ``tests/test_render_parity.py`` (render.py must still produce it),
``frontend/src/editor/metrics.test.ts`` (the TypeScript port, with Pillow's widths standing in
for the canvas) and, from milestone-3 PR 4, ``frontend/e2e/parity.spec.ts`` (a real canvas must
measure every ``texts`` entry within 0.5 px of Pillow). Run from backend/:
python scripts/make_render_vectors.py   (``make render-vectors``)
"""

from __future__ import annotations

import json
import sys
from dataclasses import asdict
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.fonts import DEFAULT_FONT_FILE, list_fonts, load_font
from app.layout import default_style
from app.models import MAX_FONT_SIZE, MIN_FONT_SIZE, Label, LeaderMode, SolveObject, StyleConfig
from app.objects import objects_from_nova
from app.placement import ANCHORS, Box, anchor_box, scale_unit
from app.render import label_text, leader_segment, leader_visible, marker_radius, measure_label

BACKEND = Path(__file__).resolve().parent.parent
REPO_ROOT = BACKEND.parent
OUT = REPO_ROOT / "tests" / "fixtures" / "render" / "vectors.json"
FONTS_DIR = REPO_ROOT / "fonts"
FIXTURES = (BACKEND / "tests" / "fixtures" / "nova", BACKEND / "tests" / "fixtures" / "nova-narrow")

# Every bundled font at three sizes for the strings that exercise the glyphs labels need
# (Greek Bayer letters, the middle dot, the apostrophe, digits, a long alias line) ...
SIZES_EVERY_FONT = (12, 24, 48)
GLYPH_STRINGS = (
    "θ1 Ori C",
    "ι Ori · 44 Ori",
    "υ Ori · 36 Ori",
    "M 43 · Mairan's Nebula",
    "M 42 · LBN 974 · Great Orion Nebula · Orion Nebula",
    "NGC 1976",
    "HD 198639",
    "the Running Man Nebula",
    "Trapezium",
    "56 Cyg",
)
# ... and the default font at many sizes for every fixture string.
SIZES_DEFAULT_FONT = (
    6,
    8,
    10,
    12,
    14,
    15,
    16,
    18,
    20,
    24,
    28,
    32,
    35,
    40,
    48,
    64,
    80,
    100,
    120,
    160,
    200,
)
# Per-label sizes for the label cases. 15 and 35 make ``size × 0.7`` land on .5, where Python's
# round() (half to even) and JavaScript's Math.round() (half up) disagree.
LABEL_SIZES = (15, 24, 35, 48)
LEADER_MODES: tuple[LeaderMode, ...] = ("auto", "on", "off")


def _r(x: float) -> float:
    """Six decimals: enough for sub-pixel geometry, stable across JSON round trips."""
    return round(x, 6)


def fixture_objects() -> list[SolveObject]:
    objects: list[SolveObject] = []
    for fixtures_dir in FIXTURES:
        raw = json.loads((fixtures_dir / "annotations.json").read_text(encoding="utf-8"))
        objects.extend(objects_from_nova(raw["annotations"], 1.0))
    return objects


def label_strings(objects: list[SolveObject]) -> list[str]:
    """Every primary and alias line a fixture object can produce under either name preference."""
    strings: set[str] = set()
    for obj in objects:
        for preference in ("popular", "ngc_ic"):
            style = StyleConfig(name_preference=preference)
            text = label_text(obj, Label(object_id=obj.id), style)
            strings.add(text.primary)
            if text.alias:
                strings.add(text.alias)
    return sorted(strings)


def text_vectors(fonts_dir: Path, strings: list[str]) -> list[list[Any]]:
    grid: list[tuple[str, int, tuple[str, ...]]] = [
        (font.file, size, GLYPH_STRINGS)
        for font in list_fonts(fonts_dir)
        for size in SIZES_EVERY_FONT
    ]
    grid += [(DEFAULT_FONT_FILE, size, tuple(strings)) for size in SIZES_DEFAULT_FONT]
    out: list[list[Any]] = []
    for file, size, texts in grid:
        font = load_font(fonts_dir, file, size)
        for text in texts:
            out.append([file, size, text, _r(font.getlength(text))])
    return out


def _label_case(
    fonts_dir: Path, style: StyleConfig, label: Label, obj: SolveObject
) -> dict[str, Any]:
    text = label_text(obj, label, style)
    box = measure_label(fonts_dir, style, label, obj)
    primary_font = load_font(fonts_dir, style.font_file, box.primary_size)
    alias_font = load_font(fonts_dir, style.font_file, box.alias_size)
    return {
        "style": style.model_dump(),
        "label": label.model_dump(),
        "object": {**obj.model_dump(), "primary_name": obj.primary_name_for(style.name_preference)},
        "text": {"primary": text.primary, "alias": text.alias},
        "box": asdict(box),
        "marker_radius": marker_radius(obj, style),
        "widths": {
            "primary": _r(primary_font.getlength(text.primary)),
            "alias": _r(alias_font.getlength(text.alias)) if text.alias else None,
        },
        "ascents": {
            "primary": primary_font.getmetrics()[0],
            "alias": alias_font.getmetrics()[0] if text.alias else None,
        },
    }


def label_vectors(fonts_dir: Path, objects: list[SolveObject]) -> list[dict[str, Any]]:
    """Every fixture object under the size-relative default style and under a second style
    with a bold condensed font, NGC/IC names first, a per-label size, and some aliases or
    names overridden."""
    base = default_style(3000, 2000, fonts_dir)  # s = 3: font 36, marker_min_radius 18
    other = base.model_copy(
        update={
            "font_file": "RobotoCondensed-Bold.ttf",
            "name_preference": "ngc_ic",
            "marker_min_radius": 4,
        }
    )
    cases: list[dict[str, Any]] = []
    for i, obj in enumerate(objects):
        cases.append(_label_case(fonts_dir, base, Label(object_id=obj.id), obj))
        tuned = Label(
            object_id=obj.id,
            font_size=LABEL_SIZES[i % len(LABEL_SIZES)],
            show_aliases=None if i % 3 else False,
            text_override="Override · text" if i % 5 == 0 else None,
        )
        cases.append(_label_case(fonts_dir, other, tuned, obj))
    return cases


def leader_vectors() -> list[dict[str, Any]]:
    """A marker at the centre of a 3000 × 2000 frame and boxes around it: each side, a diagonal,
    a box near enough for ``auto`` to hide the leader, a box inside a big marker, a box that
    contains the marker centre, a zero-radius marker a fraction of a pixel from its box, and a
    box at exactly 12·s."""
    width, height = 3000, 2000
    s = scale_unit(width, height)
    cx, cy = 1500.0, 1000.0
    geometries: list[tuple[float, Box]] = [
        (18.0, Box(1560, 970, 1900, 1030)),  # right
        (18.0, Box(1100, 970, 1440, 1030)),  # left
        (18.0, Box(1330, 700, 1670, 760)),  # above
        (18.0, Box(1330, 1240, 1670, 1300)),  # below
        (18.0, Box(1540, 1040, 1880, 1100)),  # below-right, nearest point is a corner
        (130.0, Box(1650, 970, 1990, 1030)),  # gap 20 < 12·s = 36: auto hides the leader
        (130.0, Box(1520, 990, 1600, 1010)),  # inside the marker: no segment
        (18.0, Box(1400, 950, 1600, 1050)),  # box contains the centre: no segment
        (0.0, Box(1500.5, 1000.5, 1700, 1050)),  # point marker, box a fraction of a pixel away
        (18.0, Box(1554.0, 985, 1900, 1030)),  # gap exactly 36 = 12·s: auto does not draw (>)
    ]
    cases: list[dict[str, Any]] = []
    for r, box in geometries:
        seg = leader_segment(cx, cy, r, box)
        visible = {
            mode: seg is not None and leader_visible(Label(object_id=1, leader=mode), seg[2], s)
            for mode in LEADER_MODES
        }
        cases.append(
            {
                "cx": cx,
                "cy": cy,
                "r": r,
                "s": s,
                "box": asdict(box),
                "segment": None
                if seg is None
                else {
                    "from": [_r(seg[0][0]), _r(seg[0][1])],
                    "to": [_r(seg[1][0]), _r(seg[1][1])],
                    "gap": _r(seg[2]),
                },
                "visible": visible,
            }
        )
    return cases


def anchor_vectors() -> list[dict[str, Any]]:
    cases: list[dict[str, Any]] = []
    geometries = ((1500.0, 1000.0, 58.0, 300.0, 60.0), (40.0, 1990.0, 24.5, 200.0, 43.0))
    for cx, cy, offset, w, h in geometries:
        for anchor in ANCHORS:
            box = anchor_box(anchor, cx, cy, offset, w, h)
            cases.append(
                {
                    "anchor": anchor,
                    "cx": cx,
                    "cy": cy,
                    "offset": offset,
                    "w": w,
                    "h": h,
                    "box": {k: _r(v) for k, v in asdict(box).items()},
                }
            )
    return cases


def build_vectors(fonts_dir: Path) -> dict[str, Any]:
    objects = fixture_objects()
    return {
        "min_font_size": MIN_FONT_SIZE,
        "max_font_size": MAX_FONT_SIZE,
        "fonts": [font.model_dump() for font in list_fonts(fonts_dir)],
        "texts": text_vectors(fonts_dir, label_strings(objects)),
        "labels": label_vectors(fonts_dir, objects),
        "leaders": leader_vectors(),
        "anchors": anchor_vectors(),
    }


def dump(doc: dict[str, Any]) -> str:
    """One list entry per line, so a diff shows which font or rule changed."""
    lines = ["{"]
    keys = list(doc)
    for key in keys:
        value = doc[key]
        tail = "" if key == keys[-1] else ","
        if isinstance(value, list):
            lines.append(f' "{key}": [')
            for i, item in enumerate(value):
                sep = "," if i < len(value) - 1 else ""
                entry = json.dumps(item, ensure_ascii=False, separators=(",", ":"))
                lines.append(f"  {entry}{sep}")
            lines.append(f" ]{tail}")
        else:
            lines.append(f' "{key}": {json.dumps(value)}{tail}')
    lines.append("}")
    return "\n".join(lines) + "\n"


def main() -> None:
    doc = build_vectors(FONTS_DIR)
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(dump(doc), encoding="utf-8")
    print(
        f"wrote {OUT.relative_to(REPO_ROOT)}: {len(doc['fonts'])} fonts, {len(doc['texts'])} texts,"
        f" {len(doc['labels'])} labels, {len(doc['leaders'])} leaders, {len(doc['anchors'])} anchors"
    )


if __name__ == "__main__":
    main()
