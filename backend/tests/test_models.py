from __future__ import annotations

import pytest
from pydantic import ValidationError

from app.layout import SIZE_RELATIVE
from app.models import ConfigUpdate, StyleConfig, StyleDefaults, StyleOverrides


def test_style_overrides_keeps_only_set_fields() -> None:
    o = StyleOverrides.model_validate({"text_color": "#ff8800", "font_size": 30, "halo": None})
    assert o.overrides() == {"text_color": "#ff8800", "font_size": 30}
    assert StyleOverrides().overrides() == {}


@pytest.mark.parametrize(
    "bad",
    [
        {"text_color": "red"},
        {"marker_color": "#FFF"},
        {"halo_color": "#12345G"},
        {"font_size": 5},
        {"marker_min_radius": 0},
        {"name_preference": "messier_first"},
        {"unknown_field": 1},
    ],
)
def test_style_overrides_rejects_bad_values_without_echoing_them(bad: dict[str, object]) -> None:
    with pytest.raises(ValidationError) as excinfo:
        StyleOverrides.model_validate(bad)
    text = "; ".join(str(e["msg"]) for e in excinfo.value.errors())
    for value in bad.values():
        assert str(value) not in text


def test_config_update_distinguishes_absent_from_null() -> None:
    absent = ConfigUpdate.model_validate({"site_title": "Sky"})
    cleared = ConfigUpdate.model_validate({"site_title": "Sky", "nova_api_key": None})
    assert "nova_api_key" not in absent.model_fields_set
    assert "nova_api_key" in cleared.model_fields_set and cleared.nova_api_key is None


def test_config_update_bounds() -> None:
    with pytest.raises(ValidationError):
        ConfigUpdate.model_validate({"max_upload_mb": 0})
    with pytest.raises(ValidationError):
        ConfigUpdate.model_validate({"site_title": ""})
    with pytest.raises(ValidationError):
        ConfigUpdate.model_validate({"bogus": 1})


def test_style_defaults_exclude_size_relative_fields() -> None:
    from app.api.config import style_defaults

    d = style_defaults()
    assert d["text_color"] == StyleConfig().text_color and d["font_file"] == "Inter-Regular.ttf"
    assert not SIZE_RELATIVE & set(d)
    assert StyleDefaults.model_validate(d).font_file == "Inter-Regular.ttf"


def test_style_defaults_model_matches_the_style_model() -> None:
    """The page reads every non-size field off style_defaults; none may go missing."""
    assert set(StyleDefaults.model_fields) == set(StyleConfig.model_fields) - SIZE_RELATIVE


def test_style_overrides_covers_every_style_field() -> None:
    """A new StyleConfig field must be settable from config.json and the page, not silently not."""
    assert set(StyleOverrides.model_fields) == set(StyleConfig.model_fields)


def test_config_update_strips_and_bounds_the_title() -> None:
    assert ConfigUpdate.model_validate({"site_title": "  Sky  "}).site_title == "Sky"
    with pytest.raises(ValidationError) as caught:
        ConfigUpdate.model_validate({"site_title": "   "})
    assert "must not be blank" in "; ".join(str(e["msg"]) for e in caught.value.errors())


def test_blank_check_does_not_apply_to_max_upload_mb() -> None:
    with pytest.raises(ValidationError) as caught:
        ConfigUpdate.model_validate({"max_upload_mb": "  "})
    assert caught.value.errors()[0]["type"] == "int_parsing"

    with pytest.raises(ValidationError) as caught:
        ConfigUpdate.model_validate({"site_title": "   "})
    assert caught.value.errors()[0]["type"] == "blank"
