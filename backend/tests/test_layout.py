from __future__ import annotations

import pytest

from app.layout import autoplace, default_enabled, default_style
from app.models import Label, SolveObject, StyleConfig, primary_name
from app.objects import objects_from_nova
from tests.conftest import FONTS_DIR, NOVA_NARROW_FIXTURES, load_fixture


def test_default_style_clamps_to_model_bounds() -> None:
    style = default_style(20300, 8000, FONTS_DIR)  # s = 20.3: raw values exceed the bounds
    assert style.font_size == 200
    assert style.halo_width == 40
    assert style.marker_width == 30
    assert style.marker_min_radius == 122


def test_default_style_drops_unknown_font_but_keeps_other_overrides(
    caplog: pytest.LogCaptureFixture,
) -> None:
    with caplog.at_level("WARNING"):
        style = default_style(3000, 2000, FONTS_DIR, {"font_file": "Nope.ttf", "font_size": 40})
    assert style.font_file == "Inter-Regular.ttf"
    assert style.font_size == 40
    assert any(
        "default_style.font_file" in r.message and "Nope.ttf" in r.message for r in caplog.records
    )


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

    assert [lab.model_dump() for lab in placed_gone] == [lab.model_dump() for lab in placed_inter]


def test_objects_with_no_known_size_are_enabled_but_hd_stars_are_not() -> None:
    """#9: nova reports radius 0 for NGC 206 (the catalogue has no size for it) and for every
    hd star (a point). "No size known" enables; a known size below the threshold does not."""
    ngc_206 = SolveObject(id=1, catalog_names=["NGC 206"], type="ngc", x=100, y=100, radius=0)
    small = SolveObject(id=2, catalog_names=["NGC 1924"], type="ngc", x=100, y=100, radius=5)
    hd = SolveObject(id=3, catalog_names=["HD 198639"], type="hd", x=100, y=100, radius=0)
    bright = SolveObject(id=4, catalog_names=["Alnitak"], type="bright", x=100, y=100, radius=0)
    assert default_enabled(ngc_206, 3000)
    assert not default_enabled(small, 3000)  # 5 px is below 0.4 % of 3000
    assert not default_enabled(hd, 3000)
    assert default_enabled(bright, 3000)


def _kept_field() -> tuple[list[SolveObject], StyleConfig]:
    objects = [
        SolveObject(
            id=1, catalog_names=["NGC 1976", "M 42"], type="ngc", x=1100, y=1400, radius=130
        ),
        SolveObject(id=2, catalog_names=["Alnitak"], type="bright", x=1620, y=550, radius=0),
        SolveObject(id=3, catalog_names=["NGC 2024"], type="ngc", x=1900, y=900, radius=90),
    ]
    return objects, default_style(3000, 2000, FONTS_DIR)


def test_autoplace_leaves_a_kept_label_in_a_clean_slot_uncollided() -> None:
    """A pinned label parked exactly where the placer would have put it stays clean once the
    others are laid out around it."""
    objects, style = _kept_field()
    fresh = autoplace(
        3000,
        2000,
        style,
        [Label(object_id=o.id, enabled=True, x=o.x, y=o.y) for o in objects],
        objects,
        FONTS_DIR,
    )
    assert not fresh[0].collided
    # Object 1 keeps the slot it was just given; the other two start on their objects again, so
    # the placer has to fit them around it.
    labels = [
        fresh[0].model_copy(update={"pinned": True}),
        *(
            lab.model_copy(update={"x": o.x, "y": o.y})
            for lab, o in zip(fresh[1:], objects[1:], strict=True)
        ),
    ]
    out = autoplace(3000, 2000, style, labels, objects, FONTS_DIR, keep=frozenset({1}))
    assert (out[0].x, out[0].y) == (fresh[0].x, fresh[0].y)
    assert out[0].pinned is True
    assert out[0].collided is False


def test_autoplace_flags_two_kept_labels_parked_on_top_of_each_other() -> None:
    objects, style = _kept_field()
    labels = [
        Label(object_id=1, enabled=True, x=1400, y=900, pinned=True),
        Label(object_id=2, enabled=True, x=1405, y=905, pinned=True),
        Label(object_id=3, enabled=False, x=1900, y=900),
    ]
    out = autoplace(3000, 2000, style, labels, objects, FONTS_DIR, keep=frozenset({1, 2}))
    assert [(lab.x, lab.y) for lab in out[:2]] == [(1400, 900), (1405, 905)]
    assert [lab.collided for lab in out[:2]] == [True, True]
    assert out[2].collided is False  # disabled: never touched


def test_autoplace_clears_a_kept_labels_stale_collided_flag() -> None:
    objects = [
        SolveObject(id=1, catalog_names=["NGC 1976", "M 42"], type="ngc", x=300, y=300, radius=40),
        SolveObject(id=2, catalog_names=["Alnitak"], type="bright", x=2700, y=1700, radius=0),
    ]
    style = default_style(3000, 2000, FONTS_DIR)
    labels = [
        Label(object_id=1, enabled=True, x=420, y=290, pinned=True, collided=True),
        Label(object_id=2, enabled=True, x=2700, y=1700),
    ]
    out = autoplace(3000, 2000, style, labels, objects, FONTS_DIR, keep=frozenset({1}))
    assert (out[0].x, out[0].y) == (420, 290)
    assert out[0].collided is False
