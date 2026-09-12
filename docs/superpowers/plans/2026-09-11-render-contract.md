# Render Contract (Milestone 3, PR 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pin the numbers the browser canvas must reproduce from `backend/app/render.py` (text boxes, line heights, alias sizes, per-size ascents, leader segments, anchor boxes) in one shared vectors file, publish the ascent table through `GET /api/fonts`, port the arithmetic to `frontend/src/editor/metrics.ts`, and close #45 (422 wording from the error type) and #9 (radius-0 objects enabled by default).

**Architecture:** `backend/scripts/make_render_vectors.py` computes `tests/fixtures/render/vectors.json` from the real label strings in both nova fixtures, every bundled font and `render.py`'s functions; `make render-vectors` regenerates it. `backend/tests/test_render_parity.py` rebuilds the document in memory and asserts it equals the file, so any change to `render.py`, the font bundle or Pillow shows up as a stale fixture. `frontend/src/editor/metrics.ts` is a pure-function port (no Konva, no DOM except the optional `canvasMeasurer`) that takes a `TextMeasurer` callback; `metrics.test.ts` replays the vectors with Pillow's widths standing in for the canvas, so the arithmetic on top of measurement is pinned exactly, and the browser's own measurement is checked later by `frontend/e2e/parity.spec.ts` (PR 4). `list_fonts` gains a measured ascent table per font (index `size − 6`, sizes 6–200) because FreeType's fixed-point rounding cannot be derived from a ratio.

**Tech Stack:** Python 3.13+ standard library, Pillow (`ImageFont.getmetrics`, `getlength`), FastAPI, pydantic (`pydantic_core.PydanticCustomError`), pytest; TypeScript strict, vitest. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-11-editor-v1-design.md` § 1 (spike findings), § 2 (ascents in `/api/fonts`), § 3 "Shared metrics module", § 4 (#45, #9), § 6 (vectors and tests), § 8 item 2. `docs/SPEC.md` § 5.2 step 5, § 6.2, § 6.4, § 8 (`GET /fonts`), § 9.

Two deliberate deviations from the design text, both smaller than what it describes: `measureLabel` takes a `TextMeasurer` callback instead of a canvas context (so vitest can pin it without a browser and the canvas passes `canvasMeasurer(ctx)`), and ascents are looked up by `ascentFor(font, size)` rather than inside `measureLabel` (the text shape needs them at draw time, the box does not).

## Global Constraints

- Python 3.13+ (CI and Docker run 3.14), type hints everywhere, ruff defaults (line length 100, isort), mypy strict over `app`, `tests`, `scripts`. TypeScript strict with `noUncheckedIndexedAccess`.
- No new dependencies (CLAUDE.md: ask first). `pydantic_core` ships with pydantic and is already imported transitively.
- Never call nova.astrometry.net from tests; the vectors come from `backend/tests/fixtures/nova/` and `nova-narrow/`.
- Fonts are referenced by file name only (`Inter-Regular.ttf`). `MIN_FONT_SIZE = 6`, `MAX_FONT_SIZE = 200` (`backend/app/models.py`); the ascent table has `195` entries, index `size − MIN_FONT_SIZE`.
- API responses never carry raw exception text or the submitted value (CLAUDE.md, #45).
- Preview and export must produce the same layout: every function in `metrics.ts` mirrors a function in `render.py` or `placement.py` with the same name in camelCase; both sides are pinned to `tests/fixtures/render/vectors.json`.
- Python's `round()` is half-to-even; JavaScript's `Math.round` is half-up. `15 × 0.7 = 10.5 → 10` in Python, `11` in JS. The port uses `roundHalfEven`; the vectors include label sizes 15 and 35 so the test catches a regression.
- Backend commands run from `backend/` with `.venv/bin/pytest`, `.venv/bin/ruff`, `.venv/bin/mypy`; frontend commands from `frontend/` with `npm test` and `npm run lint`. After Python edits run `make format` (ruff format + fix) first; then `make lint test` at the repo root before every commit that touches code.
- Dev servers run as the systemd unit `astrocaption-dev`; do not run `npm ci` or `make install` on this checkout while it is active. This PR installs nothing.
- Conventional commit messages ending with:
  ```
  Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01Ukpr5zaBbiD93v2geqyN5N
  ```
- Branch `feat/render-contract` from `main`. Stop after `gh pr create` and `gh pr checks --watch`; the owner smoke-tests and merges.

## File map

| File | Responsibility |
|---|---|
| `backend/app/fonts.py` (modify) | `FONT_SIZES`, `ascent_table(path)`; `list_fonts` fills `FontOut.ascents`. |
| `backend/app/models.py` (modify) | `FontOut.ascents`; `VALIDATION_MESSAGES` + `validation_message` from the error type (#45); `ConfigUpdate` null rule raises `PydanticCustomError("null_not_allowed", ...)`. |
| `backend/app/render.py` (modify) | Import `MIN_FONT_SIZE` from models instead of redefining it. |
| `backend/app/layout.py` (modify) | `STAR_TYPES`; `default_enabled` enables non-stellar objects with radius 0 (#9). |
| `backend/scripts/make_render_vectors.py` (create) | `build_vectors(fonts_dir)` and the one-entry-per-line writer; `main()` writes `tests/fixtures/render/vectors.json`. |
| `tests/fixtures/render/vectors.json` (create, generated) | The contract: fonts with ascents, text widths, label boxes, leader segments, anchor boxes. |
| `backend/tests/test_fonts.py` (modify) | Ascent table equals `load_font(...).getmetrics()[0]` for every font and size. |
| `backend/tests/test_api.py` (modify) | `/api/fonts` carries the table; Orion default-enabled count 17 → 19. |
| `backend/tests/test_layout.py` (modify) | #9 rule test. |
| `backend/tests/test_worker.py` (modify) | `ENABLED_BY_DEFAULT` gains IC 427 and IC 428. |
| `backend/tests/test_validation_errors.py` (create) | Leaky-validator test and the wording table (#45). |
| `backend/tests/test_config_api.py` (modify) | Blank-title wording follows the table. |
| `backend/tests/test_render_parity.py` (create) | `build_vectors(FONTS_DIR) == vectors.json`; glyph strings are real labels. |
| `frontend/src/api.ts` (modify) | `FontOut.ascents`; `LeaderMode`, `StyleConfig`, `Label`, `Annotations`, `ObjectOut` types. |
| `frontend/tsconfig.json` (modify) | `resolveJsonModule: true` so the test can import the vectors. |
| `frontend/src/editor/metrics.ts` (create) | The port: sizes, `roundHalfEven`, `ascentFor`, `labelText`, `measureLabel`, `leaderSegment`, `leaderVisible`, `anchorBox`, `canvasMeasurer`. |
| `frontend/src/editor/metrics.test.ts` (create) | Replays every vector against the port. |
| `Makefile`, `CLAUDE.md` (modify) | `make render-vectors`. |
| `docs/SPEC.md` (modify) | § 8 `GET /fonts` shape; § 9 numeric parity tolerances. |
| `docs/ARCHITECTURE.md` (modify) | Parity paragraph names the vectors file, the script and the three tests. |

---

### Task 1: Ascent table in `GET /api/fonts`

**Files:**
- Modify: `backend/app/models.py` (class `FontOut`, around line 394)
- Modify: `backend/app/fonts.py` (imports, `list_fonts`)
- Modify: `backend/app/render.py:28` (`MIN_FONT_SIZE`)
- Modify: `backend/tests/test_fonts.py`, `backend/tests/test_api.py::test_health_and_fonts`
- Modify: `frontend/src/api.ts` (`FontOut`), `docs/SPEC.md` § 8 (the `GET /fonts` line)

**Interfaces:**
- Produces: `fonts.FONT_SIZES: range` (6..200 inclusive), `fonts.ascent_table(path: Path) -> list[int]`, `FontOut.ascents: list[int]` (195 ints, index `size - MIN_FONT_SIZE`). Task 4 dumps `FontOut` into the vectors; Task 6 reads `ascents` in TypeScript.

- [ ] **Step 1: Create the branch**

```bash
cd ~/astrocaption && git checkout main && git pull && git checkout -b feat/render-contract
```

- [ ] **Step 2: Write the failing tests**

Append to `backend/tests/test_fonts.py` (extend the existing import lines; `FONT_SIZES` and `load_font` do not exist yet):

```python
from app.fonts import DEFAULT_FONT_FILE, FONT_SIZES, list_fonts, load_font, resolve_font_file
from app.models import MAX_FONT_SIZE, MIN_FONT_SIZE
```

```python
def test_ascent_table_is_the_renderers_metric_at_every_size() -> None:
    """Design § 2: the canvas draws on the alphabetic baseline at ``y + ascent`` and takes the
    ascent from ``GET /api/fonts``; it must be exactly what ``draw.text`` uses for the export.
    FreeType rounds in 26.6 fixed point, so the table is measured, never derived from a ratio."""
    fonts = list_fonts(FONTS_DIR)
    assert fonts, "no bundled fonts found"
    for font in fonts:
        assert len(font.ascents) == MAX_FONT_SIZE - MIN_FONT_SIZE + 1
        expected = [load_font(FONTS_DIR, font.file, size).getmetrics()[0] for size in FONT_SIZES]
        assert font.ascents == expected, font.file
```

In `backend/tests/test_api.py`, extend the imports and `test_health_and_fonts`:

```python
from app.fonts import FontNotFoundError, load_font
from app.models import MAX_FONT_SIZE, MIN_FONT_SIZE, StyleConfig
from tests.conftest import (
    FONTS_DIR,
    NOVA_NARROW_FIXTURES,
    ...
```

Replace the two `inter` lines in `test_health_and_fonts` with:

```python
    inter = next(f for f in fonts if f["file"] == "Inter-Regular.ttf")
    assert (inter["family"], inter["weight"], inter["sample"]) == ("Inter", "Regular", "NGC 1976")
    assert len(inter["ascents"]) == MAX_FONT_SIZE - MIN_FONT_SIZE + 1
    at_24 = load_font(FONTS_DIR, "Inter-Regular.ttf", 24).getmetrics()[0]
    assert inter["ascents"][24 - MIN_FONT_SIZE] == at_24
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd backend && .venv/bin/pytest tests/test_fonts.py tests/test_api.py::test_health_and_fonts -q`
Expected: ImportError on `FONT_SIZES` (collection error): the module has no such name yet.

- [ ] **Step 4: Implement**

`backend/app/models.py`, class `FontOut`:

```python
class FontOut(BaseModel):
    file: str
    family: str
    weight: str
    sample: str = "NGC 1976"
    # Pillow's ascent for every size the style model allows, index ``size - MIN_FONT_SIZE``.
    # ``draw.text((x, y))`` puts ``y`` on the ascender line; the canvas draws on the alphabetic
    # baseline and needs ``y + ascent``. Measured on the server: FreeType's fixed-point rounding
    # makes ``ceil(ascender × size / upem)`` off by one at some sizes (design § 1, § 2).
    ascents: list[int]
```

`backend/app/fonts.py`:

```python
from .models import MAX_FONT_SIZE, MIN_FONT_SIZE, FontOut, StyleConfig

...

DEFAULT_FONT_FILE = StyleConfig().font_file
FONT_SIZES = range(MIN_FONT_SIZE, MAX_FONT_SIZE + 1)


def ascent_table(path: Path) -> list[int]:
    """``getmetrics()[0]`` at every allowed size (0.13 s for the whole bundle; cached by
    ``list_fonts``). Loads the face directly rather than through ``load_font`` so 4680 sizes
    do not churn the renderer's cache."""
    return [ImageFont.truetype(str(path), size).getmetrics()[0] for size in FONT_SIZES]
```

and in `list_fonts`, inside the existing `try`:

```python
        try:
            family, style = ImageFont.truetype(str(path), 24).getname()
            ascents = ascent_table(path)
        except OSError:  # a truncated or non-TTF file must not cost the page its font list
            log.warning("skipping unreadable font %s", path.name)
            continue
        fonts.append(
            FontOut(
                file=path.name,
                family=family or path.stem,
                weight=style or "Regular",
                ascents=ascents,
            )
        )
```

`backend/app/render.py`: delete the line `MIN_FONT_SIZE = 6` and import it: `from .models import MIN_FONT_SIZE, Annotations, Label, SolveObject, StyleConfig`.

`frontend/src/api.ts`, interface `FontOut`:

```ts
export interface FontOut {
  file: string
  family: string
  weight: string
  sample: string
  /** Pillow's ascent at every allowed size, index `size - MIN_FONT_SIZE` (6..200); see editor/metrics.ts. */
  ascents: number[]
}
```

`docs/SPEC.md` § 8, replace the `GET /fonts` line with:

```
- `GET /fonts` → list of bundled fonts {file, family, weight, sample, ascents}; `ascents` is Pillow's ascent at
  every allowed size (index `size − 6`, sizes 6–200), which the editor adds to a label's `y` to draw on the
  canvas baseline where the export draws (§ 9). The files are served at `/fonts/<file>`
```

- [ ] **Step 5: Run the tests and lint**

Run: `cd backend && .venv/bin/pytest tests/test_fonts.py tests/test_api.py -q && cd .. && make lint`
Expected: all pass; ruff/mypy/eslint/tsc clean (the `test_font_list_skips_a_file_it_cannot_read` test still passes because `ascent_table` sits inside the `try`).

- [ ] **Step 6: Commit**

```bash
git add backend/app/models.py backend/app/fonts.py backend/app/render.py backend/tests/test_fonts.py backend/tests/test_api.py frontend/src/api.ts docs/SPEC.md
git commit -m "feat: publish Pillow's per-size ascent table in GET /api/fonts

The canvas draws on the alphabetic baseline at y + ascent to land where
draw.text((x, y)) puts the export; FreeType's 26.6 rounding makes the
value unpredictable from a ratio, so the server measures it per size.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Ukpr5zaBbiD93v2geqyN5N"
```

---

### Task 2: Radius-0 non-stellar objects are enabled by default (#9)

**Files:**
- Modify: `backend/app/layout.py` (`ALWAYS_ENABLED_TYPES`, `default_enabled`)
- Modify: `backend/tests/test_layout.py`, `backend/tests/test_api.py` (line 275), `backend/tests/test_worker.py` (`ENABLED_BY_DEFAULT`)

**Interfaces:**
- Produces: `layout.STAR_TYPES: frozenset[str]` = `{"bright", "hd"}`; `default_enabled(obj, width)` unchanged signature.

- [ ] **Step 1: Write the failing test**

Append to `backend/tests/test_layout.py`:

```python
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
```

Update the expectations the rule changes. `backend/tests/test_api.py` line 275:

```python
    # 8 bright stars + 9 objects with a known radius above 0.4 % of the width + IC 427 and
    # IC 428, which nova reports with radius 0 ("no size known", #9)
    assert sum(lab["enabled"] for lab in ann["labels"]) == 19
```

`backend/tests/test_worker.py`, `ENABLED_BY_DEFAULT`: change the comment to `# 3000 px test image: radius ≥ 12 px in the solve copy or no size known (#9), plus bright stars` and add `"IC 427",` and `"IC 428",` to the set.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd backend && .venv/bin/pytest tests/test_layout.py tests/test_api.py::test_solve_objects_annotations_and_export tests/test_worker.py -q`
Expected: three failures (the new test's `ngc_206` assertion, the count `17 != 19`, the worker's set).

- [ ] **Step 3: Implement**

`backend/app/layout.py`:

```python
MIN_ENABLED_RADIUS_FRACTION = 0.004  # SPEC § 5.2 step 5
ALWAYS_ENABLED_TYPES = frozenset({"bright"})
STAR_TYPES = frozenset({"bright", "hd"})  # nova's stellar types; their radius is always 0


def default_enabled(obj: SolveObject, width: int) -> bool:
    """SPEC § 5.2 step 5. Bright stars always, ``hd`` stars never (hundreds per narrow field,
    hidden behind the object list's type filter). Any other object when its radius clears the
    threshold, or when nova gives no size at all: radius 0 there means "unknown", not "tiny"
    (NGC 206 in M 31, #9)."""
    if obj.type in STAR_TYPES:
        return obj.type in ALWAYS_ENABLED_TYPES
    return obj.radius == 0 or obj.radius >= MIN_ENABLED_RADIUS_FRACTION * width
```

- [ ] **Step 4: Run the tests**

Run: `cd backend && .venv/bin/pytest -q`
Expected: all pass, including `test_worker.py`'s `assert not any(l.collided ...)` (IC 427 and IC 428 sit about 190 px apart on the 3000 px image with room around them). If that collided assertion fails, do not loosen it: report the placement to the reviewer with the two labels' boxes.

- [ ] **Step 5: Lint and commit**

Run: `make lint`

```bash
git add backend/app/layout.py backend/tests/test_layout.py backend/tests/test_api.py backend/tests/test_worker.py
git commit -m "feat: enable non-stellar objects nova reports without a size (#9)

Closes #9

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Ukpr5zaBbiD93v2geqyN5N"
```

---

### Task 3: 422 wording from the error type (#45)

**Files:**
- Modify: `backend/app/models.py` (`validation_message` around line 500, `ConfigUpdate._null_is_not_a_value`, the comment above `SetupRequest`)
- Create: `backend/tests/test_validation_errors.py`
- Modify: `backend/tests/test_config_api.py:205`

**Interfaces:**
- Consumes: `main.plain_validation_error` (unchanged; it calls `validation_message`), `config.py:184` (unchanged; same function for config.json errors).
- Produces: `models.VALIDATION_MESSAGES: dict[str, str]`, `models.GENERIC_VALIDATION_MESSAGE = "is not valid"`, `validation_message(error) -> str` with the same signature.

- [ ] **Step 1: Write the failing tests**

Create `backend/tests/test_validation_errors.py`:

```python
"""The 422 handler words errors from pydantic's error type, never from ``msg`` (#45).

A custom ``@field_validator`` that raises ``ValueError(f"bad {value}")`` would otherwise put
the submitted value (a password, a key) straight into the response.
"""

from __future__ import annotations

from typing import Any

import pytest
from fastapi import FastAPI
from fastapi.exceptions import RequestValidationError
from fastapi.testclient import TestClient
from pydantic import BaseModel, Field, field_validator

from app.main import plain_validation_error
from app.models import validation_message


class Leaky(BaseModel):
    secret: str = Field(max_length=20)
    count: int = Field(default=1, ge=1, le=5)

    @field_validator("secret")
    @classmethod
    def _echoes_its_input(cls, value: str) -> str:
        if "leak" in value:
            raise ValueError(f"bad value {value}")  # the mistake the handler must survive
        return value


def _client() -> TestClient:
    app = FastAPI()
    app.add_exception_handler(RequestValidationError, plain_validation_error)  # type: ignore[arg-type]

    @app.post("/leaky")
    async def leaky(body: Leaky) -> dict[str, str]:
        return {"ok": body.secret}

    return TestClient(app)


def test_a_leaky_validator_cannot_echo_the_submitted_value() -> None:
    resp = _client().post("/leaky", json={"secret": "please leak hunter2"})
    assert resp.status_code == 422
    assert resp.json() == {"detail": "secret: is not valid"}
    assert "hunter2" not in resp.text


def test_built_in_rules_are_worded_from_the_type_and_the_model_limits() -> None:
    client = _client()
    assert client.post("/leaky", json={}).json()["detail"] == "secret: is required"
    too_long = client.post("/leaky", json={"secret": "x" * 21})
    assert too_long.json()["detail"] == "secret: must be at most 20 characters long"
    assert "xxxxx" not in too_long.text
    over = client.post("/leaky", json={"secret": "ok", "count": 9})
    assert over.json()["detail"] == "count: must be at most 5"
    text = client.post("/leaky", json={"secret": "ok", "count": "nine"})
    assert text.json()["detail"] == "count: must be a whole number"
    assert "nine" not in text.text


@pytest.mark.parametrize(
    ("error", "message"),
    [
        ({"type": "missing"}, "is required"),
        ({"type": "string_too_short", "ctx": {"min_length": 1}}, "must not be blank"),
        ({"type": "string_too_short", "ctx": {"min_length": 8}}, "must be at least 8 characters long"),
        (
            {"type": "literal_error", "ctx": {"expected": "'popular' or 'ngc_ic'"}},
            "must be one of 'popular' or 'ngc_ic'",
        ),
        ({"type": "null_not_allowed"}, "cannot be null; leave the field out to keep the current value"),
        (
            {"type": "value_error", "msg": "Value error, bad value hunter2", "ctx": {"error": "x"}},
            "is not valid",
        ),
        ({"type": "greater_than_equal"}, "is not valid"),  # a known type without its context
        ({"type": "made_up_type", "msg": "hunter2"}, "is not valid"),
        ({}, "is not valid"),
    ],
)
def test_validation_message_never_uses_msg(error: dict[str, Any], message: str) -> None:
    assert validation_message(error) == message
```

In `backend/tests/test_config_api.py::test_put_rejects_blank_title_with_the_model_rule` change the expected detail to:

```python
        assert detail == "site_title: must not be blank"
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd backend && .venv/bin/pytest tests/test_validation_errors.py tests/test_config_api.py -q`
Expected: the leaky test fails (`"secret: Value error, bad value please leak hunter2"`), the wording tests fail, the blank-title test fails with the old pydantic sentence.

- [ ] **Step 3: Implement**

`backend/app/models.py`. Add to the imports:

```python
from pydantic_core import PydanticCustomError
```

Replace `validation_message`:

```python
# 422 wording by pydantic error type (#45). Built from the type, never from ``msg``: a custom
# validator's ``ValueError(f"bad {value}")`` would otherwise echo the submitted value.
# ``{...}`` placeholders are filled from ``ctx``, which for these types holds the model's own
# limits (``max_length``, ``le``, the literal choices), never the input.
VALIDATION_MESSAGES: dict[str, str] = {
    "missing": "is required",
    "extra_forbidden": "is not a known field",
    "json_invalid": "the body is not valid JSON",
    "string_type": "must be text",
    "string_too_short": "must be at least {min_length} characters long",
    "string_too_long": "must be at most {max_length} characters long",
    "string_pattern_mismatch": "is not in the expected format",
    "int_type": "must be a whole number",
    "int_parsing": "must be a whole number",
    "int_from_float": "must be a whole number",
    "float_type": "must be a number",
    "float_parsing": "must be a number",
    "bool_type": "must be true or false",
    "bool_parsing": "must be true or false",
    "greater_than": "must be greater than {gt}",
    "greater_than_equal": "must be at least {ge}",
    "less_than": "must be less than {lt}",
    "less_than_equal": "must be at most {le}",
    "literal_error": "must be one of {expected}",
    "enum": "must be one of {expected}",
    "list_type": "must be a list",
    "dict_type": "must be an object",
    "model_type": "must be an object",
    "model_attributes_type": "must be an object",
    "null_not_allowed": "cannot be null; leave the field out to keep the current value",
}
GENERIC_VALIDATION_MESSAGE = "is not valid"


def validation_message(error: Mapping[str, Any]) -> str:
    """Pydantic's reason for one rejected value, never the value itself (CLAUDE.md, #45)."""
    kind = str(error.get("type", ""))
    ctx = error.get("ctx") or {}
    if kind == "string_too_short" and ctx.get("min_length") == 1:
        return "must not be blank"
    template = VALIDATION_MESSAGES.get(kind, GENERIC_VALIDATION_MESSAGE)
    try:
        return template.format(**ctx)
    except (KeyError, IndexError):  # a known type whose context is missing: still no crash
        return GENERIC_VALIDATION_MESSAGE
```

In `ConfigUpdate._null_is_not_a_value`, replace the two comment lines and the raise with:

```python
        # ``None`` here only means "absent"; an explicit null has no meaning for these two
        # fields (unlike ``nova_api_key``), so it is rejected instead of silently kept (#47).
        # Worded by VALIDATION_MESSAGES under this type, not by the message given here.
        if value is None:
            raise PydanticCustomError("null_not_allowed", "cannot be null")
        return value
```

Replace the two comment lines above `class SetupRequest`:

```python
# The 422 handler words errors from their pydantic type (``VALIDATION_MESSAGES``), never from a
# validator's message, so a custom validator that needs specific wording raises
# ``PydanticCustomError`` with a type listed there (``ConfigUpdate`` does).
```

- [ ] **Step 4: Run the tests**

Run: `cd backend && .venv/bin/pytest -q`
Expected: all pass. `test_explicit_null_is_rejected_except_for_the_nova_key` still finds `"null"` in the detail through the table entry; `test_a_body_that_is_not_json_gets_a_plain_422` still sees the `json_invalid` sentence.

- [ ] **Step 5: Lint and commit**

Run: `make lint`

```bash
git add backend/app/models.py backend/tests/test_validation_errors.py backend/tests/test_config_api.py
git commit -m "fix: word 422 errors from the pydantic error type, never from msg (#45)

Closes #45

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Ukpr5zaBbiD93v2geqyN5N"
```

---

### Task 4: The render vectors script and fixture

**Files:**
- Create: `backend/scripts/make_render_vectors.py`
- Create (generated): `tests/fixtures/render/vectors.json`
- Modify: `Makefile` (`.PHONY`, new target after `placement-vectors`), `CLAUDE.md` (Commands block)

**Interfaces:**
- Consumes: `fonts.list_fonts`, `fonts.load_font`, `fonts.DEFAULT_FONT_FILE`, `layout.default_style`, `objects.objects_from_nova`, `render.label_text / measure_label / marker_radius / leader_segment / leader_visible`, `placement.ANCHORS / anchor_box / scale_unit / Box`.
- Produces: `make_render_vectors.build_vectors(fonts_dir: Path) -> dict[str, Any]`, `make_render_vectors.OUT: Path`, `make_render_vectors.GLYPH_STRINGS`, `make_render_vectors.label_strings(objects) -> list[str]`, `make_render_vectors.fixture_objects() -> list[SolveObject]`. The JSON document shape (Task 5 and Task 6 read it):

```
{
 "min_font_size": 6, "max_font_size": 200,
 "fonts":   [FontOut dumps: {file, family, weight, sample, ascents[195]}],
 "texts":   [[font_file, size, text, width], ...]                      // Pillow getlength, 6 decimals
 "labels":  [{style: StyleConfig, label: Label, object: ObjectOut-shaped, text: {primary, alias|null},
              box: {width, height, primary_size, alias_size, line1_height, line2_height},
              marker_radius, widths: {primary, alias|null}, ascents: {primary, alias|null}}, ...],
 "leaders": [{cx, cy, r, s, box: {left, top, right, bottom},
              segment: {from: [x, y], to: [x, y], gap} | null, visible: {auto, on, off}}, ...],
 "anchors": [{anchor, cx, cy, offset, w, h, box: {left, top, right, bottom}}, ...]
}
```

- [ ] **Step 1: Write the script**

Create `backend/scripts/make_render_vectors.py`:

```python
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
SIZES_DEFAULT_FONT = (6, 8, 10, 12, 14, 15, 16, 18, 20, 24, 28, 32, 35, 40, 48, 64, 80, 100, 120, 160, 200)
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
```

Note on the tenth leader geometry: the box's left edge is at `1554 = 1500 + 18 + 36`, so the gap is exactly `12·s` and `auto` must not draw (the rule is strictly greater). If `leader_segment` returns `36.000000000000004` or `35.99999…` because of the unit-vector arithmetic, keep the geometry: the vector then records whatever `render.py` does, which is the point.

- [ ] **Step 2: Add the Makefile target and the CLAUDE.md line**

`Makefile`: add `render-vectors` to the `.PHONY` list (after `placement-vectors`) and this target after the `placement-vectors` target (the recipe line starts with a tab, like every other recipe in the file):

```make
render-vectors: $(VENV)/.installed ## Regenerate tests/fixtures/render/vectors.json from render.py (the canvas parity contract)
	cd backend && .venv/bin/python scripts/make_render_vectors.py
```

`CLAUDE.md`, Commands block, after the `make placement-vectors` line:

```
make render-vectors      # regenerate tests/fixtures/render/vectors.json from render.py (text boxes, ascents, leaders, anchors)
```

- [ ] **Step 3: Generate the fixture and inspect it**

Run:

```bash
cd ~/astrocaption && make render-vectors && wc -c tests/fixtures/render/vectors.json && cd backend && .venv/bin/python -c "
import json; d = json.load(open('../tests/fixtures/render/vectors.json'))
print({k: (len(v) if isinstance(v, list) else v) for k, v in d.items()})
print(sorted({c['box']['primary_size'] for c in d['labels']}))
print([c['segment'] is None for c in d['leaders']], [c['visible']['auto'] for c in d['leaders']])
"
```

Expected: 24 fonts, `10 × 24 × 3 + 46 × 21 = 1686` texts, 56 labels, 10 leaders, 16 anchors; primary sizes `[15, 24, 35, 36, 48]`; leaders 7 and 8 have no segment; the file is well under 200 KB. Run `make render-vectors` a second time and check `git status` shows no further change (determinism).

- [ ] **Step 4: Lint and commit**

Run: `make lint` (mypy covers `scripts/`).

```bash
git add backend/scripts/make_render_vectors.py tests/fixtures/render/vectors.json Makefile CLAUDE.md
git commit -m "test: shared render vectors from render.py (make render-vectors)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Ukpr5zaBbiD93v2geqyN5N"
```

---

### Task 5: `test_render_parity.py` pins `render.py` to the vectors

**Files:**
- Create: `backend/tests/test_render_parity.py`

**Interfaces:**
- Consumes: `scripts.make_render_vectors.build_vectors / OUT / GLYPH_STRINGS / label_strings / fixture_objects` (Task 4).

- [ ] **Step 1: Write the test**

```python
"""The render contract (CLAUDE.md hard rule): render.py must still produce
tests/fixtures/render/vectors.json.

The TypeScript port (frontend/src/editor/metrics.ts) is pinned to the same file by
frontend/src/editor/metrics.test.ts, and the browser's canvas measurement is checked against
the ``texts`` entries by frontend/e2e/parity.spec.ts. A failure here means render.py, the font
bundle or Pillow changed: read the diff, then ``make render-vectors`` and commit the file with
the change that caused it.
"""

from __future__ import annotations

import json

from scripts.make_render_vectors import (
    GLYPH_STRINGS,
    OUT,
    build_vectors,
    fixture_objects,
    label_strings,
)
from tests.conftest import FONTS_DIR


def test_render_vectors_are_current() -> None:
    stored = json.loads(OUT.read_text(encoding="utf-8"))
    built = build_vectors(FONTS_DIR)
    assert set(built) == set(stored)
    for key, value in built.items():
        assert value == stored[key], f"vectors.json '{key}' is stale: run make render-vectors"


def test_glyph_strings_are_real_fixture_labels() -> None:
    """The every-font grid uses a subset of the fixture strings, not made-up text."""
    assert set(GLYPH_STRINGS) <= set(label_strings(fixture_objects()))


def test_vectors_cover_the_rounding_trap() -> None:
    """Sizes 15 and 35 put ``size × 0.7`` on .5, where Python and JavaScript round differently."""
    sizes = {case["box"]["primary_size"] for case in build_vectors(FONTS_DIR)["labels"]}
    assert {15, 35} <= sizes
```

- [ ] **Step 2: Run it**

Run: `cd backend && .venv/bin/pytest tests/test_render_parity.py -q`
Expected: 3 passed. Then prove it bites: temporarily change `LINE_HEIGHT` in `backend/app/render.py` to `1.25`, run again, expect `test_render_vectors_are_current` to fail on `'labels'`; revert the change (`git checkout backend/app/render.py`) and confirm it passes again.

- [ ] **Step 3: Lint and commit**

Run: `make lint`

```bash
git add backend/tests/test_render_parity.py
git commit -m "test: pin render.py to the shared render vectors

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Ukpr5zaBbiD93v2geqyN5N"
```

---

### Task 6: `metrics.ts`, the TypeScript port, pinned by vitest

**Files:**
- Modify: `frontend/src/api.ts` (annotation types after `NamePreference`), `frontend/tsconfig.json`
- Create: `frontend/src/editor/metrics.ts`, `frontend/src/editor/metrics.test.ts`

**Interfaces:**
- Consumes: `tests/fixtures/render/vectors.json` (Task 4), `fontFamilyFor` from `frontend/src/pages/labelPreview.ts`, `FontOut.ascents` (Task 1).
- Produces (PR 4's canvas and PR 5's client-side placement consume these):
  - constants `MIN_FONT_SIZE`, `MAX_FONT_SIZE`, `ALIAS_SCALE`, `LINE_HEIGHT`, `ALIAS_SEP`, `LEADER_GAP_FACTOR`, `ANCHORS`
  - `roundHalfEven(x: number): number`
  - `effectiveFontSize(label: Label, style: StyleConfig): number`, `aliasFontSize(size: number): number`, `lineHeight(size: number): number`, `scaleUnit(width: number, height: number): number`, `markerRadius(obj: ObjectOut, style: StyleConfig): number`
  - `ascentFor(font: FontOut, size: number): number` (throws `RangeError` outside 6..200)
  - `type TextMeasurer = (text: string, fontFile: string, size: number) => number`, `canvasMeasurer(ctx: CanvasRenderingContext2D): TextMeasurer`
  - `interface LabelLines { primary: string; alias: string | null }`, `labelText(obj, label, style): LabelLines`
  - `interface LabelBox { width; height; primarySize; aliasSize; line1Height; line2Height }`, `measureLabel(measure: TextMeasurer, style, label, obj): LabelBox`
  - `interface Box { left; top; right; bottom }`, `interface LeaderSegment { from: [number, number]; to: [number, number]; gap: number }`, `leaderSegment(cx, cy, r, box): LeaderSegment | null`, `leaderVisible(label, gap, s): boolean`
  - `type Anchor`, `anchorBox(anchor, cx, cy, offset, w, h): Box`

- [ ] **Step 1: Add the API types**

`frontend/src/api.ts`, after `export type NamePreference = ...`:

```ts
export type LeaderMode = 'auto' | 'on' | 'off'

/** Global style of one image, in original-image pixels. Mirrors StyleConfig. */
export interface StyleConfig {
  font_file: string
  font_size: number
  text_color: string
  marker_color: string
  leader_color: string
  halo: boolean
  halo_color: string
  halo_width: number
  marker_width: number
  marker_min_radius: number
  show_aliases: boolean
  name_preference: NamePreference
}

/** One object's call-out; `x, y` is the top-left of the text box in original pixels. Mirrors Label. */
export interface Label {
  object_id: number
  enabled: boolean
  x: number
  y: number
  font_size: number | null
  text_override: string | null
  color: string | null
  show_aliases: boolean | null
  leader: LeaderMode
  collided: boolean
}

export interface Annotations {
  image_id: string
  style: StyleConfig
  labels: Label[]
  version: number
  updated_at: string
}

/** A catalogued object; `primary_name` already follows the image's name preference. Mirrors ObjectOut. */
export interface ObjectOut {
  id: number
  catalog_names: string[]
  primary_name: string
  type: string
  x: number
  y: number
  radius: number
}
```

`frontend/tsconfig.json`: add `"resolveJsonModule": true,` after `"isolatedModules": true,`.

- [ ] **Step 2: Write the failing test**

Create `frontend/src/editor/metrics.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import raw from '../../../tests/fixtures/render/vectors.json'
import type { FontOut, Label, LeaderMode, ObjectOut, StyleConfig } from '../api'
import {
  ANCHORS,
  MAX_FONT_SIZE,
  MIN_FONT_SIZE,
  anchorBox,
  ascentFor,
  labelText,
  leaderSegment,
  leaderVisible,
  markerRadius,
  measureLabel,
  roundHalfEven,
  type Anchor,
  type Box,
  type TextMeasurer,
} from './metrics'

interface LabelCase {
  style: StyleConfig
  label: Label
  object: ObjectOut
  text: { primary: string; alias: string | null }
  box: {
    width: number
    height: number
    primary_size: number
    alias_size: number
    line1_height: number
    line2_height: number
  }
  marker_radius: number
  widths: { primary: number; alias: number | null }
  ascents: { primary: number; alias: number | null }
}
interface LeaderCase {
  cx: number
  cy: number
  r: number
  s: number
  box: Box
  segment: { from: [number, number]; to: [number, number]; gap: number } | null
  visible: Record<LeaderMode, boolean>
}
interface AnchorCase {
  anchor: Anchor
  cx: number
  cy: number
  offset: number
  w: number
  h: number
  box: Box
}
interface Vectors {
  min_font_size: number
  max_font_size: number
  fonts: FontOut[]
  texts: [string, number, string, number][]
  labels: LabelCase[]
  leaders: LeaderCase[]
  anchors: AnchorCase[]
}

const vectors = raw as unknown as Vectors
const fontByFile = new Map(vectors.fonts.map((f) => [f.file, f]))
const EPS = 1e-6 // the generator rounds to six decimals

/** Pillow's widths stand in for the canvas; the arithmetic on top of them is what this file pins. */
function pillowMeasurer(): TextMeasurer {
  const key = (file: string, size: number, text: string) => `${file} ${size} ${text}`
  const widths = new Map<string, number>()
  for (const [file, size, text, width] of vectors.texts) widths.set(key(file, size, text), width)
  for (const c of vectors.labels) {
    widths.set(key(c.style.font_file, c.box.primary_size, c.text.primary), c.widths.primary)
    if (c.text.alias !== null && c.widths.alias !== null) {
      widths.set(key(c.style.font_file, c.box.alias_size, c.text.alias), c.widths.alias)
    }
  }
  return (text, file, size) => {
    const width = widths.get(key(file, size, text))
    if (width === undefined) throw new Error(`no Pillow width for ${file} ${size}px ${JSON.stringify(text)}`)
    return width
  }
}

function expectBox(got: Box, want: Box): void {
  expect(Math.abs(got.left - want.left)).toBeLessThanOrEqual(EPS)
  expect(Math.abs(got.top - want.top)).toBeLessThanOrEqual(EPS)
  expect(Math.abs(got.right - want.right)).toBeLessThanOrEqual(EPS)
  expect(Math.abs(got.bottom - want.bottom)).toBeLessThanOrEqual(EPS)
}

describe('render vectors', () => {
  it('loaded the contract the Python side generated', () => {
    expect(vectors.min_font_size).toBe(MIN_FONT_SIZE)
    expect(vectors.max_font_size).toBe(MAX_FONT_SIZE)
    expect(vectors.fonts.length).toBeGreaterThan(0)
    expect(vectors.labels.length).toBeGreaterThan(0)
  })

  it('rounds halves to even like Python', () => {
    expect(roundHalfEven(10.5)).toBe(10)
    expect(roundHalfEven(17.5)).toBe(18)
    expect(roundHalfEven(24.5)).toBe(24)
    expect(roundHalfEven(31.499999999999996)).toBe(31)
    expect(roundHalfEven(2.5)).toBe(2)
    expect(roundHalfEven(3.5)).toBe(4)
    expect(roundHalfEven(4.2)).toBe(4)
    expect(roundHalfEven(4.7)).toBe(5)
  })

  it('has an ascent for every allowed size and refuses the rest', () => {
    for (const font of vectors.fonts) {
      expect(font.ascents).toHaveLength(MAX_FONT_SIZE - MIN_FONT_SIZE + 1)
      expect(ascentFor(font, MIN_FONT_SIZE)).toBe(font.ascents[0])
      expect(ascentFor(font, MAX_FONT_SIZE)).toBe(font.ascents[font.ascents.length - 1])
      expect(() => ascentFor(font, MIN_FONT_SIZE - 1)).toThrow(RangeError)
      expect(() => ascentFor(font, MAX_FONT_SIZE + 1)).toThrow(RangeError)
    }
  })

  it('covers the sizes where Python and JavaScript rounding differ', () => {
    const sizes = new Set(vectors.labels.map((c) => c.box.primary_size))
    expect(sizes).toContain(15)
    expect(sizes).toContain(35)
  })

  it('reproduces every label box, text, marker radius and ascent', () => {
    const measure = pillowMeasurer()
    for (const c of vectors.labels) {
      const font = fontByFile.get(c.style.font_file)
      expect(font, c.style.font_file).toBeDefined()
      expect(labelText(c.object, c.label, c.style)).toEqual(c.text)
      expect(measureLabel(measure, c.style, c.label, c.object)).toEqual({
        width: c.box.width,
        height: c.box.height,
        primarySize: c.box.primary_size,
        aliasSize: c.box.alias_size,
        line1Height: c.box.line1_height,
        line2Height: c.box.line2_height,
      })
      expect(markerRadius(c.object, c.style)).toBe(c.marker_radius)
      expect(ascentFor(font!, c.box.primary_size)).toBe(c.ascents.primary)
      if (c.ascents.alias !== null) expect(ascentFor(font!, c.box.alias_size)).toBe(c.ascents.alias)
    }
  })

  it('reproduces every leader segment and its visibility per mode', () => {
    const label = (mode: LeaderMode): Label => ({
      object_id: 1,
      enabled: true,
      x: 0,
      y: 0,
      font_size: null,
      text_override: null,
      color: null,
      show_aliases: null,
      leader: mode,
      collided: false,
    })
    for (const c of vectors.leaders) {
      const seg = leaderSegment(c.cx, c.cy, c.r, c.box)
      if (c.segment === null) {
        expect(seg).toBeNull()
      } else {
        expect(seg).not.toBeNull()
        expect(Math.abs(seg!.from[0] - c.segment.from[0])).toBeLessThanOrEqual(EPS)
        expect(Math.abs(seg!.from[1] - c.segment.from[1])).toBeLessThanOrEqual(EPS)
        expect(Math.abs(seg!.to[0] - c.segment.to[0])).toBeLessThanOrEqual(EPS)
        expect(Math.abs(seg!.to[1] - c.segment.to[1])).toBeLessThanOrEqual(EPS)
        expect(Math.abs(seg!.gap - c.segment.gap)).toBeLessThanOrEqual(EPS)
      }
      for (const mode of ['auto', 'on', 'off'] as const) {
        const drawn = seg !== null && leaderVisible(label(mode), seg.gap, c.s)
        expect(drawn, `${JSON.stringify(c.box)} ${mode}`).toBe(c.visible[mode])
      }
    }
  })

  it('reproduces every anchor box', () => {
    expect(vectors.anchors.map((c) => c.anchor).slice(0, ANCHORS.length)).toEqual([...ANCHORS])
    for (const c of vectors.anchors) {
      expectBox(anchorBox(c.anchor, c.cx, c.cy, c.offset, c.w, c.h), c.box)
    }
  })
})
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd frontend && npm test --silent`
Expected: FAIL with `Failed to resolve import "./metrics"`.

- [ ] **Step 4: Write the module**

Create `frontend/src/editor/metrics.ts`:

```ts
// Layout arithmetic shared by the canvas (milestone-3 PR 4) and the tests. Mirrors
// backend/app/render.py and placement.anchor_box; tests/fixtures/render/vectors.json pins both
// sides (CLAUDE.md hard rule: preview and export must produce the same layout). Every number the
// canvas draws with comes from here.
//
// Font inputs come only from GET /annotations (the style's font_file) and GET /fonts (the ascent
// table), never from the image record, the config defaults or a cached document (#62): the
// server resolves a font that is no longer bundled to the default, and the browser must draw
// with the same one. A /fonts/<file> 404 would fall back to a system font silently.
import type { FontOut, Label, ObjectOut, StyleConfig } from '../api'
import { fontFamilyFor } from '../pages/labelPreview'

export const MIN_FONT_SIZE = 6
export const MAX_FONT_SIZE = 200
export const ALIAS_SCALE = 0.7
export const LINE_HEIGHT = 1.2
export const ALIAS_SEP = ' · '
/** Auto leaders appear when the box is farther than 12·s from the marker edge, s = max(W, H) / 1000. */
export const LEADER_GAP_FACTOR = 12
const SQRT_HALF = Math.sqrt(0.5)

/** Python's round(): halves go to the even neighbour (15 × 0.7 = 10.5 → 10), unlike Math.round. */
export function roundHalfEven(x: number): number {
  const floor = Math.floor(x)
  const diff = x - floor
  if (diff < 0.5) return floor
  if (diff > 0.5) return floor + 1
  return floor % 2 === 0 ? floor : floor + 1
}

export function effectiveFontSize(label: Label, style: StyleConfig): number {
  return label.font_size ?? style.font_size
}

export function aliasFontSize(size: number): number {
  return Math.max(MIN_FONT_SIZE, roundHalfEven(size * ALIAS_SCALE))
}

export function lineHeight(size: number): number {
  return Math.ceil(size * LINE_HEIGHT)
}

export function scaleUnit(width: number, height: number): number {
  return Math.max(width, height) / 1000
}

export function markerRadius(obj: ObjectOut, style: StyleConfig): number {
  return Math.max(obj.radius, style.marker_min_radius)
}

/** Pillow's ascent at `size`: the baseline sits that far below the label's top edge (`y`). */
export function ascentFor(font: FontOut, size: number): number {
  const ascent = font.ascents[size - MIN_FONT_SIZE]
  if (ascent === undefined) throw new RangeError(`no ascent for ${font.file} at ${size}px`)
  return ascent
}

export interface LabelLines {
  primary: string
  alias: string | null
}

/** `obj.primary_name` already follows the image's name preference: the server ranks names
 *  (models.primary_name), so a preference change means re-fetching the objects. */
export function labelText(obj: ObjectOut, label: Label, style: StyleConfig): LabelLines {
  const override = (label.text_override ?? '').trim()
  const primary = override || obj.primary_name
  const show = label.show_aliases ?? style.show_aliases
  const aliases = obj.catalog_names.filter((n) => n !== obj.primary_name)
  return { primary, alias: show && aliases.length > 0 ? aliases.join(ALIAS_SEP) : null }
}

/** Advance width of `text` set in `fontFile` at `size` px, in original-image pixels. */
export type TextMeasurer = (text: string, fontFile: string, size: number) => number

/** The canvas measurer. `geometricPrecision` turns hinting off so widths agree with Pillow's
 *  getlength within 0.5 px at every size (design § 1); default canvas text rounds to whole
 *  pixels and drifts up to 27 % at small sizes. The font must be loaded (FontFace) first. */
export function canvasMeasurer(ctx: CanvasRenderingContext2D): TextMeasurer {
  ctx.textRendering = 'geometricPrecision'
  return (text, fontFile, size) => {
    ctx.font = `${size}px "${fontFamilyFor(fontFile)}"`
    return ctx.measureText(text).width
  }
}

export interface LabelBox {
  width: number
  height: number
  primarySize: number
  aliasSize: number
  line1Height: number
  line2Height: number
}

export function measureLabel(measure: TextMeasurer, style: StyleConfig, label: Label, obj: ObjectOut): LabelBox {
  const text = labelText(obj, label, style)
  const size = effectiveFontSize(label, style)
  const aliasSize = aliasFontSize(size)
  let width = measure(text.primary, style.font_file, size)
  const line1Height = lineHeight(size)
  let line2Height = 0
  if (text.alias !== null) {
    width = Math.max(width, measure(text.alias, style.font_file, aliasSize))
    line2Height = lineHeight(aliasSize)
  }
  return {
    width: Math.ceil(width),
    height: line1Height + line2Height,
    primarySize: size,
    aliasSize,
    line1Height,
    line2Height,
  }
}

export interface Box {
  left: number
  top: number
  right: number
  bottom: number
}

export interface LeaderSegment {
  from: [number, number]
  to: [number, number]
  gap: number
}

/** From the marker edge to the closest point of `box`, or null when the box reaches the marker. */
export function leaderSegment(cx: number, cy: number, r: number, box: Box): LeaderSegment | null {
  const nx = Math.min(Math.max(cx, box.left), box.right)
  const ny = Math.min(Math.max(cy, box.top), box.bottom)
  const dx = nx - cx
  const dy = ny - cy
  const dist = Math.hypot(dx, dy)
  if (dist <= r) return null
  const ux = dx / dist
  const uy = dy / dist
  return { from: [cx + ux * r, cy + uy * r], to: [nx, ny], gap: dist - r }
}

export function leaderVisible(label: Label, gap: number, s: number): boolean {
  if (label.leader === 'on') return true
  if (label.leader === 'off') return false
  return gap > LEADER_GAP_FACTOR * s
}

export type Anchor =
  | 'right'
  | 'left'
  | 'below'
  | 'above'
  | 'below-right'
  | 'below-left'
  | 'above-right'
  | 'above-left'

/** The placer's search order (SPEC § 6.4). */
export const ANCHORS: readonly Anchor[] = [
  'right',
  'left',
  'below',
  'above',
  'below-right',
  'below-left',
  'above-right',
  'above-left',
]

/** Text box of size `w × h` placed at `anchor` around (cx, cy) at distance `offset`. */
export function anchorBox(anchor: Anchor, cx: number, cy: number, offset: number, w: number, h: number): Box {
  let left: number
  let top: number
  const d = offset * SQRT_HALF
  switch (anchor) {
    case 'right':
      left = cx + offset
      top = cy - h / 2
      break
    case 'left':
      left = cx - offset - w
      top = cy - h / 2
      break
    case 'below':
      left = cx - w / 2
      top = cy + offset
      break
    case 'above':
      left = cx - w / 2
      top = cy - offset - h
      break
    case 'below-right':
      left = cx + d
      top = cy + d
      break
    case 'below-left':
      left = cx - d - w
      top = cy + d
      break
    case 'above-right':
      left = cx + d
      top = cy - d - h
      break
    case 'above-left':
      left = cx - d - w
      top = cy - d - h
      break
    default:
      throw new RangeError(`unknown anchor ${String(anchor)}`) // mirrors placement.anchor_box
  }
  return { left, top, right: left + w, bottom: top + h }
}
```

- [ ] **Step 5: Run the tests and lint**

Run: `cd frontend && npm test --silent && npm run lint --silent`
Expected: vitest passes (the existing `api.test.ts`, `configForm.test.ts`, `labelPreview.test.ts` and the new file); eslint and both tsc projects clean. `lib.dom.d.ts` in the installed TypeScript declares `textRendering`, so the assignment type-checks. Then prove the rounding guard bites: change `roundHalfEven(size * ALIAS_SCALE)` to `Math.round(size * ALIAS_SCALE)` in `aliasFontSize`, run `npm test`, expect the label-box test to fail on a size-15 or size-35 case, and revert.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/api.ts frontend/tsconfig.json frontend/src/editor/metrics.ts frontend/src/editor/metrics.test.ts
git commit -m "feat: editor metrics module, the TypeScript side of the render contract

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Ukpr5zaBbiD93v2geqyN5N"
```

---

### Task 7: Docs, full verification, pull request

**Files:**
- Modify: `docs/SPEC.md` § 9, `docs/ARCHITECTURE.md` ("Parity contract for milestone 3")

- [ ] **Step 1: SPEC § 9 regains the numeric tolerances**

In `docs/SPEC.md` § 9 replace the sentence `The render-parity tests (milestone 3) measure real label strings in every font.` with:

```
The render contract is pinned by `tests/fixtures/render/vectors.json` (`make render-vectors`): text boxes,
line heights, alias sizes, ascents, leader segments and anchor boxes that `render.py` computes for real
label strings from the nova fixtures, in every bundled font. `backend/tests/test_render_parity.py` and
`frontend/src/editor/metrics.test.ts` replay it exactly. The browser measures text with
`textRendering: geometricPrecision` and must return every vector string's width within 0.5 px of
Pillow's; the editor's rendering of the e2e field may differ from the server's annotated preview in at
most 1 % of pixels by more than 48 (of 255) in any channel (`frontend/e2e/parity.spec.ts`, milestone 3).
```

- [ ] **Step 2: ARCHITECTURE.md names the pieces**

Replace the paragraph starting `Two tests hold the contract (CLAUDE.md):` with:

```
`backend/scripts/make_render_vectors.py` (`make render-vectors`) writes those numbers, for the real
label strings of both nova fixtures in every bundled font, to `tests/fixtures/render/vectors.json`.
Three tests hold the contract (CLAUDE.md): `backend/tests/test_render_parity.py` rebuilds the file
from `render.py` and fails when it is stale; `frontend/src/editor/metrics.test.ts` replays it against
the TypeScript port `frontend/src/editor/metrics.ts` with Pillow's widths standing in for the canvas;
and `frontend/e2e/parity.spec.ts` (arriving with the editor canvas) measures the same strings on a real
canvas and pixel-diffs the Konva stage against the server's annotated preview within a tolerance
(SPEC § 9). The pixel diff runs under Playwright because Konva needs a browser. `GET /api/fonts`
carries Pillow's ascent per size, because the browser draws on the alphabetic baseline and Pillow on
the ascender line.
```

- [ ] **Step 3: Full verification**

Run: `cd ~/astrocaption && make lint test`
Expected: ruff, mypy, eslint, tsc clean; pytest and vitest all green. Then `git status` must show only the two doc files.

- [ ] **Step 4: Commit and open the PR**

```bash
git add docs/SPEC.md docs/ARCHITECTURE.md
git commit -m "docs: render contract, parity tolerances and make render-vectors

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Ukpr5zaBbiD93v2geqyN5N"
git push -u origin feat/render-contract
```

PR body (`gh pr create --title "feat: render contract (milestone 3, PR 2)" --body-file <file>`):

```
Milestone 3, PR 2 of 8 (design: docs/superpowers/specs/2026-09-11-editor-v1-design.md § 2, § 3, § 4, § 6).

- `GET /api/fonts` carries Pillow's ascent per size (6–200) so the canvas can draw on the baseline where the export draws.
- `tests/fixtures/render/vectors.json` + `make render-vectors`: text boxes, line heights, alias sizes, ascents, leader segments and anchor boxes from `render.py` for the real fixture strings in every bundled font.
- `backend/tests/test_render_parity.py` pins `render.py` to the file; `frontend/src/editor/metrics.ts` is the TypeScript port, pinned by `metrics.test.ts` (Python-style half-to-even rounding included: sizes 15 and 35 are in the vectors).
- 422 messages come from the pydantic error type, never from `msg`; a leaky-validator test proves the submitted value cannot be echoed. Closes #45
- Non-stellar objects nova reports with radius 0 (NGC 206) are enabled by default; `hd` stars stay off. Closes #9
- SPEC § 9 states the numeric parity tolerances (0.5 px widths; 1 % of pixels over 48); the pixel test itself arrives with PR 4.

🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_01Ukpr5zaBbiD93v2geqyN5N
```

Then `gh pr checks --watch`. Stop there: the owner smoke-tests on `make dev` (the config page still lists 24 fonts; a solve of the Orion fixture now enables IC 427 and IC 428) and says "merge".
