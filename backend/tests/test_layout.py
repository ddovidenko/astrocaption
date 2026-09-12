from __future__ import annotations

from app.layout import autoplace, default_enabled, default_style
from app.models import Label, SolveObject, primary_name
from app.objects import objects_from_nova
from tests.conftest import FONTS_DIR, NOVA_NARROW_FIXTURES, load_fixture


def test_default_style_clamps_to_model_bounds() -> None:
    style = default_style(20300, 8000, FONTS_DIR)  # s = 20.3: raw values exceed the bounds
    assert style.font_size == 200
    assert style.halo_width == 40
    assert style.marker_width == 30
    assert style.marker_min_radius == 122


def test_default_style_drops_unknown_font_but_keeps_other_overrides() -> None:
    style = default_style(3000, 2000, FONTS_DIR, {"font_file": "Nope.ttf", "font_size": 40})
    assert style.font_file == "Inter-Regular.ttf"
    assert style.font_size == 40


def test_default_style_accepts_bundled_font() -> None:
    style = default_style(3000, 2000, FONTS_DIR, {"font_file": "Roboto-Bold.ttf"})
    assert style.font_file == "Roboto-Bold.ttf"


def test_hd_stars_are_hidden_by_default_on_a_narrow_field() -> None:
    """SPEC § 5.2 step 5: hd entries have radius 0 and stay off; bright stars are always on."""
    raw = load_fixture("annotations.json", NOVA_NARROW_FIXTURES)["annotations"]
    objects = objects_from_nova(raw, 1.0)
    enabled = {primary_name(o.catalog_names) for o in objects if default_enabled(o, 2160)}
    assert enabled == {"IC 5070", "56 Cyg", "57 Cyg"}


def test_autoplace_falls_back_when_the_style_font_is_gone() -> None:
    objects = [
        SolveObject(
            id=1, catalog_names=["NGC 1976", "M 42"], type="ngc", x=1100, y=1400, radius=130
        ),
        SolveObject(id=2, catalog_names=["Alnitak"], type="bright", x=1620, y=550, radius=0),
    ]
    labels = [Label(object_id=o.id, enabled=True, x=o.x, y=o.y) for o in objects]
    style = default_style(3000, 2000, FONTS_DIR)
    placed_inter = autoplace(3000, 2000, style, labels, objects, FONTS_DIR)

    gone_style = style.model_copy(update={"font_file": "Gone-Regular.ttf"})
    placed_gone = autoplace(3000, 2000, gone_style, labels, objects, FONTS_DIR)

    assert [(lab.object_id, lab.x, lab.y) for lab in placed_gone] == [
        (lab.object_id, lab.x, lab.y) for lab in placed_inter
    ]
