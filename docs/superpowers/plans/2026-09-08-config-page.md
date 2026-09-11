# Config Page (Milestone 2, PR 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the owner edit the site title, upload limit, nova key and the default label style in the browser, with validation, environment-pinned fields shown read-only, and changes live without a restart.

**Architecture:** `PUT /api/config` (owner-only) takes a partial `ConfigUpdate`, rejects fields pinned by environment variables, validates `default_style` as a set of overrides against the style model and the bundled fonts, writes through the existing atomic `update_config`, then forces the live `SettingsSource` to reload and returns the same shape as `GET`. The frontend gains a `/config` route behind the owner guard, a form built from `GET /api/config` and `GET /api/fonts`, native colour pickers, and pure helpers (tested with vitest) that map form state to the request body. Closes #8.

**Tech Stack:** Python 3.13+ / FastAPI / Pydantic v2 / pytest; React 19 + TypeScript strict + react-router 8 + vitest. No new dependencies.

**Spec:** `docs/SPEC.md` § 8 (`GET/PUT /config`), § 6.3 (name preference), § 7 (config keys), § 11 (env vars). Design agreed in chat 2026-09-08 (native `<input type="color">` pickers; no password change, that is #43).

## Global Constraints

- Python 3.13+, type hints everywhere, ruff defaults (line length 100, isort), mypy strict. Pydantic models for every request/response body. TypeScript strict, function components + hooks.
- No new dependencies on either side.
- Secrets (`password_hash`, `session_secret`, `nova_api_key`) are never logged, never returned. `PUT /api/config` must never drop `password_hash` or `session_secret` from `config.json` (a missing one reopens setup).
- API error bodies are plain language `{"detail": "..."}`, no server paths, no raw exception text, and never echo a submitted value. Custom `@field_validator` messages must not include the value; prefer `Field(pattern=...)`/bounds so Pydantic's own message is used.
- Fields pinned by environment variables (`nova_api_key` ← `NOVA_API_KEY`/`ASTROMETRY_API_KEY`, `max_upload_mb` ← `ASTROCAPTION_MAX_UPLOAD_MB`, `site_title` ← `ASTROCAPTION_SITE_TITLE`) are listed in `Settings.env_locked`; a write to one is rejected with 422 naming the variable.
- Fonts are referenced by file name only (CLAUDE.md); a `default_style.font_file` must be a bundled font (`fonts.font_path` resolves it).
- `config.json` is written only through `update_config` (atomic, 0600, fsync). `ConfigError` → 409 with its `public` sentence; `OSError` → 500 with the plain "data directory is not writable" message (same wording as setup).
- Coordinates and style lengths are original-image pixels; `default_style` stores only the owner's overrides so size-relative defaults keep applying to unset fields (`layout.default_style`).
- Browser checks run against a scratch data directory, never the checkout's `data/` (see the memory note): build the frontend and run a second uvicorn with `ASTROCAPTION_DATA_DIR` pointing at a temp dir.
- Run `make lint test` before every commit that touches code. Conventional commit messages ending with:
  ```
  Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01LZ13YiDRbwh2oJSuC7qHQ6
  ```
- Backend commands run from `backend/` with `.venv/bin/pytest`, `.venv/bin/ruff`, `.venv/bin/mypy`; frontend from `frontend/` with `npm test --silent`, `npm run lint --silent`.
- Stop after `gh pr create` and `gh pr checks --watch`; the owner merges.

## File map

| File | Responsibility |
|---|---|
| `backend/app/models.py` | `StyleOverrides` (all style fields optional, colours pattern-checked), `ConfigUpdate`, `ConfigOut` gains `style_defaults` |
| `backend/app/config.py` | `SettingsSource.reload()` forces a re-read after a write; `ENV_VAR_FOR` maps a locked field to its variable name |
| `backend/app/api/config.py` | `PUT /api/config`: locked check, font check, write, reload, respond |
| `backend/tests/test_config_api.py` (new) | the PUT behaviour end to end through `env_app_client` |
| `frontend/src/api.ts` | `StyleOverrides`, `ConfigUpdate`, `FontOut`, `api.fonts()`, `api.updateConfig()` |
| `frontend/src/pages/configForm.ts` (new) | pure form-state ⇄ request helpers (vitest) |
| `frontend/src/pages/configForm.test.ts` (new) | tests for those helpers |
| `frontend/src/pages/ConfigPage.tsx` (new) | the page |
| `frontend/src/App.tsx`, `styles.css` | route, nav link, form styles |
| `docs/SPEC.md`, `docs/INSTALL.md`, `docs/ARCHITECTURE.md` | PUT semantics, "or the config page", module row |

---

### Task 1: Request models and the settings reload hook

**Files:**
- Modify: `backend/app/models.py` (after `ConfigOut`)
- Modify: `backend/app/config.py` (`SettingsSource`, new constant)
- Test: `backend/tests/test_config.py` (append), `backend/tests/test_models.py` (new)

**Interfaces:**
- Produces: `StyleOverrides` (Pydantic, `extra="forbid"`): every `StyleConfig` field as `X | None = None` with the same bounds; colour fields `Field(default=None, pattern=r"^#[0-9A-Fa-f]{6}$")`; `.overrides() -> dict[str, object]` returns only the set, non-None fields.
- Produces: `ConfigUpdate` (`extra="forbid"`): `site_title: str | None = Field(None, min_length=1, max_length=200)`, `max_upload_mb: int | None = Field(None, ge=1, le=1024)`, `nova_api_key: str | None = Field(None, max_length=200)`, `default_style: StyleOverrides | None = None`. Callers use `model_fields_set` to tell "absent" from "null".
- Produces: `ConfigOut.style_defaults: dict[str, object]` = `StyleConfig().model_dump()` minus the size-relative fields (`font_size`, `halo_width`, `marker_width`, `marker_min_radius`), so the page can show the built-in colours, font, booleans and name preference when no override is set.
- Produces: `ENV_VAR_FOR: dict[str, str]` in `config.py` = `{"nova_api_key": "NOVA_API_KEY", "max_upload_mb": "ASTROCAPTION_MAX_UPLOAD_MB", "site_title": "ASTROCAPTION_SITE_TITLE"}`; `SettingsSource.reload() -> Settings` re-reads config.json unconditionally (returns the fixed settings unchanged when built from one).

- [ ] **Step 1: Write the failing tests**

`backend/tests/test_models.py` (new):

```python
from __future__ import annotations

import pytest
from pydantic import ValidationError

from app.models import ConfigUpdate, StyleConfig, StyleOverrides


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
    assert not {"font_size", "halo_width", "marker_width", "marker_min_radius"} & set(d)
```

Append to `backend/tests/test_config.py`:

```python
def test_settings_source_reload_reads_a_same_stamp_write(tmp_path: Path) -> None:
    from app.config import SettingsSource, update_config

    env = env_for(tmp_path)
    path = tmp_path / "config.json"
    update_config(path, {"site_title": "AAAA"})
    source = SettingsSource(env=env)
    assert source.current().site_title == "AAAA"
    # Same length, and force the same mtime so the stamp cannot notice the change.
    update_config(path, {"site_title": "BBBB"})
    os.utime(path, ns=(source._stamp[0], source._stamp[0]))  # type: ignore[index]
    assert source.current().site_title == "AAAA"  # stamp unchanged: stale by design
    assert source.reload().site_title == "BBBB"
    assert source.current().site_title == "BBBB"


def test_env_var_for_covers_every_lockable_field(tmp_path: Path) -> None:
    from app.config import ENV_VAR_FOR

    s = load_settings(
        env_for(tmp_path, NOVA_API_KEY="k", ASTROCAPTION_MAX_UPLOAD_MB="7", ASTROCAPTION_SITE_TITLE="T")
    )
    assert set(ENV_VAR_FOR) == s.env_locked == {"nova_api_key", "max_upload_mb", "site_title"}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd backend && .venv/bin/pytest tests/test_models.py tests/test_config.py -q`
Expected: ImportError (`StyleOverrides`, `ConfigUpdate`), AttributeError (`reload`, `ENV_VAR_FOR`).

- [ ] **Step 3: Models** in `backend/app/models.py`, after `ConfigOut`

```python
HEX_COLOR = r"^#[0-9A-Fa-f]{6}$"


class StyleOverrides(BaseModel):
    """The owner's ``default_style``: only the fields they chose; the rest stay size-relative.

    Bounds mirror ``StyleConfig``. Colours are ``#RRGGBB`` (what ``<input type="color">``
    produces and what Pillow accepts). Unknown fields are refused so a typo cannot be stored.
    """

    model_config = ConfigDict(extra="forbid")

    font_file: str | None = Field(default=None, max_length=100)
    font_size: int | None = Field(default=None, ge=MIN_FONT_SIZE, le=MAX_FONT_SIZE)
    text_color: str | None = Field(default=None, pattern=HEX_COLOR)
    marker_color: str | None = Field(default=None, pattern=HEX_COLOR)
    leader_color: str | None = Field(default=None, pattern=HEX_COLOR)
    halo: bool | None = None
    halo_color: str | None = Field(default=None, pattern=HEX_COLOR)
    halo_width: int | None = Field(default=None, ge=0, le=MAX_STROKE_WIDTH)
    marker_width: int | None = Field(default=None, ge=1, le=MAX_STROKE_WIDTH)
    marker_min_radius: int | None = Field(default=None, ge=1, le=MAX_MARKER_MIN_RADIUS)
    show_aliases: bool | None = None
    name_preference: NamePreference | None = None

    def overrides(self) -> dict[str, object]:
        return {k: v for k, v in self.model_dump().items() if v is not None}


class ConfigUpdate(BaseModel):
    """Partial update: absent fields are kept; ``nova_api_key: null`` clears the key."""

    model_config = ConfigDict(extra="forbid")

    site_title: str | None = Field(default=None, min_length=1, max_length=200)
    max_upload_mb: int | None = Field(default=None, ge=1, le=1024)
    nova_api_key: str | None = Field(default=None, max_length=200)
    default_style: StyleOverrides | None = None
```

Add `ConfigDict` to the `pydantic` import. Add to `ConfigOut`:

```python
    style_defaults: dict[str, object]  # built-in font/colours/booleans for fields with no override
```

- [ ] **Step 4: `style_defaults()` and `config_out`** in `backend/app/api/config.py`

```python
SIZE_RELATIVE = frozenset({"font_size", "halo_width", "marker_width", "marker_min_radius"})


def style_defaults() -> dict[str, object]:
    """Fixed built-ins the page shows for unset fields; sizes are derived per image instead."""
    return {k: v for k, v in StyleConfig().model_dump().items() if k not in SIZE_RELATIVE}
```

and `style_defaults=style_defaults(),` in `config_out`. Import `StyleConfig` from `..models`.

- [ ] **Step 5: `config.py`** — add after `DEFAULT_NOVA_BASE_URL`:

```python
ENV_VAR_FOR = {
    "nova_api_key": "NOVA_API_KEY",
    "max_upload_mb": "ASTROCAPTION_MAX_UPLOAD_MB",
    "site_title": "ASTROCAPTION_SITE_TITLE",
}
```

and to `SettingsSource`:

```python
    def reload(self) -> Settings:
        """Re-read config.json now, whatever the stamp says (after the app itself wrote it)."""
        if self._fixed is not None:
            return self._fixed
        self._current = load_settings(self._env)
        self._stamp = _file_stamp(self._current.config_path)
        return self._current
```

Use `ENV_VAR_FOR` inside `load_settings` for the `env_locked` computation so the two cannot drift: keep the explicit `NOVA_API_KEY or ASTROMETRY_API_KEY` check for the key, but assert in a comment that the keys of `ENV_VAR_FOR` are the lockable fields.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd backend && .venv/bin/pytest tests/test_models.py tests/test_config.py tests/test_api.py -q -k "config or models or health"`
Expected: pass. `test_health_and_fonts` in `test_api.py` asserts the exact `GET /api/config` body: add `"style_defaults": {...}` there (build the expected dict from `StyleConfig()` in the test rather than spelling out the colours).

- [ ] **Step 7: Lint and commit**

```bash
cd backend && .venv/bin/ruff check . && .venv/bin/ruff format . && .venv/bin/mypy && .venv/bin/pytest -q
cd .. && git add backend && git commit -m "feat(config): style override and update models, settings reload hook"
```

---

### Task 2: `PUT /api/config`

**Files:**
- Modify: `backend/app/api/config.py`
- Test: `backend/tests/test_config_api.py` (new)

**Interfaces:**
- Consumes: `ConfigUpdate`, `StyleOverrides.overrides()`, `ConfigOut` (Task 1); `ENV_VAR_FOR`, `SettingsSource.reload()`, `update_config`, `ConfigError` (config.py); `font_path` (fonts.py); `env_app_client`, `login` (conftest); the `OSError` message used by setup in `api/auth.py` (reuse the constant: hoist `"The password could not be saved: …"` wording into a shared `DATA_DIR_NOT_WRITABLE = "Settings could not be saved: the data directory is not writable. Check the permissions on ./data and try again."` in `api/config.py` and have setup keep its own password wording).
- Produces: `PUT /api/config` → 200 `ConfigOut`; 422 for locked fields and bad values; 409 `ConfigError.public`; 500 plain.

- [ ] **Step 1: Write the failing tests** — `backend/tests/test_config_api.py`

```python
from __future__ import annotations

import json
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from tests.conftest import env_app_client, login

PASSWORD = "config-page-pw1"


@contextmanager
def owner_client(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, **env: str
) -> Iterator[TestClient]:
    """A live-config app that has been set up and signed in."""
    with env_app_client(tmp_path, monkeypatch, **env) as client:
        resp = client.post("/api/setup", json={"password": PASSWORD, "site_title": "Sky"})
        assert resp.status_code == 204, resp.text
        login(client, PASSWORD)
        yield client


def read_config(tmp_path: Path) -> dict[str, object]:
    data: dict[str, object] = json.loads((tmp_path / "data" / "config.json").read_text())
    return data


def test_put_is_partial_and_keeps_the_secrets(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    with owner_client(tmp_path, monkeypatch) as client:
        before = read_config(tmp_path)
        resp = client.put("/api/config", json={"max_upload_mb": 12})
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["max_upload_mb"] == 12 and body["site_title"] == "Sky"
        assert body["nova_api_key_set"] is False and body["locked"] == []
        after = read_config(tmp_path)
        assert after["password_hash"] == before["password_hash"]
        assert after["session_secret"] == before["session_secret"]
        assert after["max_upload_mb"] == 12 and after["site_title"] == "Sky"
        # Live without a restart: health reflects a title change immediately.
        assert client.put("/api/config", json={"site_title": "New sky"}).status_code == 200
        assert client.get("/api/health").json()["site_title"] == "New sky"


def test_nova_key_set_keep_and_clear(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    with owner_client(tmp_path, monkeypatch) as client:
        assert client.put("/api/config", json={"nova_api_key": "  abc  "}).json()["nova_api_key_set"] is True
        assert read_config(tmp_path)["nova_api_key"] == "abc"
        assert client.put("/api/config", json={"site_title": "Still"}).json()["nova_api_key_set"] is True
        assert client.put("/api/config", json={"nova_api_key": None}).json()["nova_api_key_set"] is False
        assert "nova_api_key" not in read_config(tmp_path)
        assert "abc" not in client.get("/api/config").text


def test_locked_fields_are_rejected_with_the_variable_name(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    with owner_client(tmp_path, monkeypatch, ASTROCAPTION_SITE_TITLE="Env title") as client:
        assert client.get("/api/config").json()["locked"] == ["site_title"]
        resp = client.put("/api/config", json={"site_title": "Mine", "max_upload_mb": 9})
        assert resp.status_code == 422
        assert resp.json() == {"detail": "site_title is set by ASTROCAPTION_SITE_TITLE; unset it to change it here."}
        assert "max_upload_mb" not in read_config(tmp_path)  # nothing was written


def test_default_style_is_validated_and_stored_as_overrides(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    with owner_client(tmp_path, monkeypatch) as client:
        bad_font = client.put("/api/config", json={"default_style": {"font_file": "Comic.ttf"}})
        assert bad_font.status_code == 422
        assert bad_font.json() == {"detail": "default_style.font_file is not a bundled font."}
        bad_colour = client.put("/api/config", json={"default_style": {"text_color": "red"}})
        assert bad_colour.status_code == 422 and "red" not in bad_colour.text
        assert "default_style" not in read_config(tmp_path)

        ok = client.put(
            "/api/config",
            json={"default_style": {"font_file": "Roboto-Bold.ttf", "text_color": "#ff8800", "halo": None}},
        )
        assert ok.status_code == 200
        assert ok.json()["default_style"] == {"font_file": "Roboto-Bold.ttf", "text_color": "#ff8800"}
        assert read_config(tmp_path)["default_style"] == {"font_file": "Roboto-Bold.ttf", "text_color": "#ff8800"}
        # Sending a style replaces the override set; an empty one removes the key.
        assert client.put("/api/config", json={"default_style": {}}).json()["default_style"] == {}
        assert "default_style" not in read_config(tmp_path)


def test_put_rejects_unknown_fields_and_needs_a_session(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    with owner_client(tmp_path, monkeypatch) as client:
        assert client.put("/api/config", json={"password": "x"}).status_code == 422
        client.post("/api/logout")
        assert client.put("/api/config", json={"site_title": "Nope"}).status_code == 401


def test_put_refuses_to_touch_a_corrupt_config(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    with owner_client(tmp_path, monkeypatch) as client:
        path = tmp_path / "data" / "config.json"
        good = path.read_text()
        path.write_text("{oops")
        # The session is gone with the hash, so this is a 401 before it can be a 409:
        assert client.put("/api/config", json={"site_title": "X"}).status_code == 401
        path.write_text(good)
        assert client.put("/api/config", json={"site_title": "Back"}).status_code == 200
```

(The corrupt-file 409 path is unreachable while signed in, because a corrupt file also drops the session; the test documents that. The `OSError` → 500 branch mirrors setup's and is exercised by mocking: add one more test that monkeypatches `app.api.config.update_config` to raise `OSError` and asserts 500 with the plain message and no path in the body.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd backend && .venv/bin/pytest tests/test_config_api.py -q`
Expected: 405 Method Not Allowed on every PUT.

- [ ] **Step 3: The route** — `backend/app/api/config.py`

```python
"""Owner settings: read, and write through the atomic config.json writer."""

from __future__ import annotations

import asyncio
import logging

from fastapi import APIRouter, Depends, HTTPException, Request, status

from ..config import ENV_VAR_FOR, ConfigError, Settings, SettingsSource, update_config
from ..fonts import FontNotFoundError, font_path
from ..models import ConfigOut, ConfigUpdate, StyleConfig
from .deps import SettingsDep, require_owner

log = logging.getLogger(__name__)
router = APIRouter(prefix="/api", tags=["config"], dependencies=[Depends(require_owner)])

SIZE_RELATIVE = frozenset({"font_size", "halo_width", "marker_width", "marker_min_radius"})
DATA_DIR_NOT_WRITABLE = (
    "Settings could not be saved: the data directory is not writable. "
    "Check the permissions on ./data and try again."
)


def style_defaults() -> dict[str, object]:
    """Fixed built-ins the page shows for unset fields; sizes are derived per image instead."""
    return {k: v for k, v in StyleConfig().model_dump().items() if k not in SIZE_RELATIVE}


def config_out(settings: Settings) -> ConfigOut:
    return ConfigOut(
        site_title=settings.site_title,
        max_upload_mb=settings.max_upload_mb,
        nova_api_key_set=settings.nova_api_key_set,
        default_style=dict(settings.default_style),
        style_defaults=style_defaults(),
        locked=sorted(settings.env_locked),
    )


@router.get("/config")
async def get_config(settings: SettingsDep) -> ConfigOut:
    return config_out(settings)


def _updates_for(body: ConfigUpdate, settings: Settings) -> dict[str, object | None]:
    """Translate a partial update into config.json changes, or raise a plain 422."""
    locked = sorted(body.model_fields_set & settings.env_locked)
    if locked:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT,
            f"{locked[0]} is set by {ENV_VAR_FOR[locked[0]]}; unset it to change it here.",
        )
    updates: dict[str, object | None] = {}
    if "site_title" in body.model_fields_set and body.site_title is not None:
        title = body.site_title.strip()
        if not title:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "site_title must not be blank.")
        updates["site_title"] = title
    if "max_upload_mb" in body.model_fields_set and body.max_upload_mb is not None:
        updates["max_upload_mb"] = body.max_upload_mb
    if "nova_api_key" in body.model_fields_set:
        key = (body.nova_api_key or "").strip()
        updates["nova_api_key"] = key or None  # null (or blank) clears the key
    if body.default_style is not None:
        overrides = body.default_style.overrides()
        font = overrides.get("font_file")
        if isinstance(font, str):
            try:
                font_path(settings.fonts_dir, font)
            except FontNotFoundError:
                raise HTTPException(
                    status.HTTP_422_UNPROCESSABLE_CONTENT,
                    "default_style.font_file is not a bundled font.",
                ) from None
        updates["default_style"] = overrides or None  # an empty set removes the key
    return updates


@router.put("/config")
async def put_config(body: ConfigUpdate, request: Request, settings: SettingsDep) -> ConfigOut:
    updates = _updates_for(body, settings)
    source: SettingsSource = request.app.state.settings_source
    if updates:
        try:
            await asyncio.to_thread(update_config, settings.config_path, updates)
        except ConfigError as exc:
            raise HTTPException(status.HTTP_409_CONFLICT, exc.public) from exc
        except OSError as exc:
            log.exception("config.json could not be written")
            raise HTTPException(status.HTTP_500_INTERNAL_SERVER_ERROR, DATA_DIR_NOT_WRITABLE) from exc
        log.info("config updated: %s", ", ".join(sorted(updates)))  # names only, never values
    return config_out(source.reload())
```

Add a test line for the blank title: `client.put("/api/config", json={"site_title": "   "})` → 422 `{"detail": "site_title must not be blank."}`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd backend && .venv/bin/pytest tests/test_config_api.py tests/test_auth_api.py -q`
Expected: pass, including the derived owner-route test (it now enumerates `PUT /api/config` too).

- [ ] **Step 5: Lint and commit**

```bash
cd backend && .venv/bin/ruff check . && .venv/bin/ruff format . && .venv/bin/mypy && .venv/bin/pytest -q
cd .. && git add backend && git commit -m "feat(api): PUT /api/config with locked-field and style validation"
```

---

### Task 3: Frontend API client and form helpers

**Files:**
- Modify: `frontend/src/api.ts`
- Create: `frontend/src/pages/configForm.ts`, `frontend/src/pages/configForm.test.ts`

**Interfaces:**
- Produces in `api.ts`: `StyleOverrides` (all optional: `font_file`, `font_size`, `text_color`, `marker_color`, `leader_color`, `halo`, `halo_color`, `halo_width`, `marker_width`, `marker_min_radius`, `show_aliases`, `name_preference: 'popular' | 'ngc_ic'`); `ConfigOut.default_style: StyleOverrides`, `ConfigOut.style_defaults: StyleDefaults` (`{ font_file: string; text_color: string; marker_color: string; leader_color: string; halo: boolean; halo_color: string; show_aliases: boolean; name_preference: 'popular' | 'ngc_ic' }`); `ConfigUpdate { site_title?: string; max_upload_mb?: number; nova_api_key?: string | null; default_style?: StyleOverrides }`; `FontOut { file; family; weight; sample }`; `api.fonts(): Promise<FontOut[]>`; `api.updateConfig(body: ConfigUpdate): Promise<ConfigOut>`.
- Produces in `configForm.ts`: `StyleForm` (every style field as a string: `''` = use default; booleans as `'' | 'on' | 'off'`), `styleFormFromOverrides(o: StyleOverrides): StyleForm`, `overridesFromStyleForm(f: StyleForm): StyleOverrides`, `Tri = '' | 'on' | 'off'`.

- [ ] **Step 1: Write the failing tests** — `frontend/src/pages/configForm.test.ts`

```ts
import { describe, expect, it } from 'vitest'
import { overridesFromStyleForm, styleFormFromOverrides, type StyleForm } from './configForm'

const empty: StyleForm = {
  font_file: '',
  font_size: '',
  text_color: '',
  marker_color: '',
  leader_color: '',
  halo: '',
  halo_color: '',
  halo_width: '',
  marker_width: '',
  marker_min_radius: '',
  show_aliases: '',
  name_preference: '',
}

describe('config form helpers', () => {
  it('round-trips overrides through the form', () => {
    const o = { font_file: 'Roboto-Bold.ttf', font_size: 30, halo: false, text_color: '#ff8800' }
    const form = styleFormFromOverrides(o)
    expect(form).toEqual({ ...empty, font_file: 'Roboto-Bold.ttf', font_size: '30', halo: 'off', text_color: '#ff8800' })
    expect(overridesFromStyleForm(form)).toEqual(o)
  })

  it('treats blanks as "use the default" and drops them', () => {
    expect(overridesFromStyleForm(empty)).toEqual({})
    expect(overridesFromStyleForm({ ...empty, font_size: '  ', halo: 'on' })).toEqual({ halo: true })
  })

  it('leaves a non-numeric size for the server to reject rather than guessing', () => {
    expect(overridesFromStyleForm({ ...empty, marker_width: 'abc' })).toEqual({ marker_width: NaN })
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `cd frontend && npm test --silent`
Expected: FAIL, module `./configForm` not found.

- [ ] **Step 3: Types and calls in `api.ts`**

Replace `ConfigOut` and add:

```ts
export type NamePreference = 'popular' | 'ngc_ic'

/** The owner's default_style: only the fields they chose to override. Mirrors StyleOverrides. */
export interface StyleOverrides {
  font_file?: string
  font_size?: number
  text_color?: string
  marker_color?: string
  leader_color?: string
  halo?: boolean
  halo_color?: string
  halo_width?: number
  marker_width?: number
  marker_min_radius?: number
  show_aliases?: boolean
  name_preference?: NamePreference
}

/** Built-in values for fields with no override (sizes are per image, so not listed). */
export interface StyleDefaults {
  font_file: string
  text_color: string
  marker_color: string
  leader_color: string
  halo: boolean
  halo_color: string
  show_aliases: boolean
  name_preference: NamePreference
}

export interface ConfigOut {
  site_title: string
  max_upload_mb: number
  nova_api_key_set: boolean
  default_style: StyleOverrides
  style_defaults: StyleDefaults
  locked: string[]
}

/** Partial: absent keeps, `nova_api_key: null` clears; `default_style` replaces the override set. */
export interface ConfigUpdate {
  site_title?: string
  max_upload_mb?: number
  nova_api_key?: string | null
  default_style?: StyleOverrides
}

export interface FontOut {
  file: string
  family: string
  weight: string
  sample: string
}
```

and in `api`:

```ts
  fonts: () => request<FontOut[]>('/api/fonts'),
  updateConfig: (body: ConfigUpdate) => request<ConfigOut>('/api/config', json('PUT', body)),
```

- [ ] **Step 4: `configForm.ts`**

```ts
import type { NamePreference, StyleOverrides } from '../api'

export type Tri = '' | 'on' | 'off'

/** Form state for the default style. '' everywhere means "use the default". */
export interface StyleForm {
  font_file: string
  font_size: string
  text_color: string
  marker_color: string
  leader_color: string
  halo: Tri
  halo_color: string
  halo_width: string
  marker_width: string
  marker_min_radius: string
  show_aliases: Tri
  name_preference: '' | NamePreference
}

const tri = (v: boolean | undefined): Tri => (v === undefined ? '' : v ? 'on' : 'off')
const str = (v: string | number | undefined): string => (v === undefined ? '' : String(v))

export function styleFormFromOverrides(o: StyleOverrides): StyleForm {
  return {
    font_file: str(o.font_file),
    font_size: str(o.font_size),
    text_color: str(o.text_color),
    marker_color: str(o.marker_color),
    leader_color: str(o.leader_color),
    halo: tri(o.halo),
    halo_color: str(o.halo_color),
    halo_width: str(o.halo_width),
    marker_width: str(o.marker_width),
    marker_min_radius: str(o.marker_min_radius),
    show_aliases: tri(o.show_aliases),
    name_preference: o.name_preference ?? '',
  }
}

const num = (v: string): number | undefined => (v.trim() === '' ? undefined : Number(v))
const bool = (v: Tri): boolean | undefined => (v === '' ? undefined : v === 'on')
const text = (v: string): string | undefined => (v.trim() === '' ? undefined : v.trim())

/** Blank fields are dropped so the server keeps its size-relative defaults for them. */
export function overridesFromStyleForm(f: StyleForm): StyleOverrides {
  const o: StyleOverrides = {
    font_file: text(f.font_file),
    font_size: num(f.font_size),
    text_color: text(f.text_color),
    marker_color: text(f.marker_color),
    leader_color: text(f.leader_color),
    halo: bool(f.halo),
    halo_color: text(f.halo_color),
    halo_width: num(f.halo_width),
    marker_width: num(f.marker_width),
    marker_min_radius: num(f.marker_min_radius),
    show_aliases: bool(f.show_aliases),
    name_preference: f.name_preference === '' ? undefined : f.name_preference,
  }
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as StyleOverrides
}
```

- [ ] **Step 5: Run tests and lint**

Run: `cd frontend && npm test --silent && npm run lint --silent`
Expected: clean (no consumer of the new types yet, so nothing else breaks).

- [ ] **Step 6: Commit**

```bash
git add frontend/src/api.ts frontend/src/pages/configForm.ts frontend/src/pages/configForm.test.ts
git commit -m "feat(frontend): config update types, fonts call and style form helpers"
```

---

### Task 4: The config page, route and nav link

**Files:**
- Create: `frontend/src/pages/ConfigPage.tsx`
- Modify: `frontend/src/App.tsx`, `frontend/src/styles.css`

**Interfaces:**
- Consumes: `api.config`, `api.fonts`, `api.updateConfig`, `ConfigOut`, `FontOut`, `pageError`, `describeError` (api.ts); `styleFormFromOverrides`, `overridesFromStyleForm`, `StyleForm`, `Tri` (configForm.ts); `refreshHealth` prop as the other pages.
- Produces: `ConfigPage({ refreshHealth }: { refreshHealth: () => Promise<HealthOut | null> })`, route `/config` inside `Guard`, a `Config` link in the header when authenticated.

- [ ] **Step 1: `ConfigPage.tsx`**

```tsx
import { useEffect, useState } from 'react'
import { api, pageError, type ConfigOut, type ConfigUpdate, type FontOut, type HealthOut } from '../api'
import { overridesFromStyleForm, styleFormFromOverrides, type StyleForm, type Tri } from './configForm'

type ColorField = 'text_color' | 'marker_color' | 'leader_color' | 'halo_color'
type SizeField = 'font_size' | 'halo_width' | 'marker_width' | 'marker_min_radius'

export default function ConfigPage({ refreshHealth }: { refreshHealth: () => Promise<HealthOut | null> }) {
  const [config, setConfig] = useState<ConfigOut | null>(null)
  const [fonts, setFonts] = useState<FontOut[]>([])
  const [siteTitle, setSiteTitle] = useState('')
  const [uploadMb, setUploadMb] = useState('')
  const [novaKey, setNovaKey] = useState('')
  const [clearKey, setClearKey] = useState(false)
  const [style, setStyle] = useState<StyleForm>(styleFormFromOverrides({}))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    Promise.all([api.config(), api.fonts()])
      .then(([cfg, list]) => {
        if (cancelled) return
        setConfig(cfg)
        setFonts(list)
        setSiteTitle(cfg.site_title)
        setUploadMb(String(cfg.max_upload_mb))
        setStyle(styleFormFromOverrides(cfg.default_style))
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(pageError(err))
      })
    return () => {
      cancelled = true
    }
  }, [])

  if (!config) return error ? <p className="error">{error}</p> : <p className="meta">Loading…</p>

  const locked = (field: string) => config.locked.includes(field)
  const setField = <K extends keyof StyleForm>(key: K, value: StyleForm[K]) =>
    setStyle((s) => ({ ...s, [key]: value }))

  async function save(e: React.FormEvent) {
    e.preventDefault()
    if (!config) return
    setBusy(true)
    setError(null)
    setSaved(null)
    const body: ConfigUpdate = { default_style: overridesFromStyleForm(style) }
    if (!locked('site_title') && siteTitle.trim() !== config.site_title) body.site_title = siteTitle.trim()
    if (!locked('max_upload_mb') && uploadMb !== String(config.max_upload_mb)) body.max_upload_mb = Number(uploadMb)
    if (!locked('nova_api_key')) {
      if (clearKey) body.nova_api_key = null
      else if (novaKey.trim()) body.nova_api_key = novaKey.trim()
    }
    try {
      const fresh = await api.updateConfig(body)
      setConfig(fresh)
      setSiteTitle(fresh.site_title)
      setUploadMb(String(fresh.max_upload_mb))
      setStyle(styleFormFromOverrides(fresh.default_style))
      setNovaKey('')
      setClearKey(false)
      setSaved('Saved.')
      await refreshHealth() // the header title follows site_title
    } catch (err) {
      setError(pageError(err))
    } finally {
      setBusy(false)
    }
  }

  const d = config.style_defaults
  const colorRow = (label: string, key: ColorField) => (
    <label key={key}>
      {label}
      <span className="color-row">
        <input
          type="color"
          value={style[key] || d[key]}
          onChange={(e) => setField(key, e.target.value)}
          aria-label={label}
        />
        <code>{style[key] || `${d[key]} (default)`}</code>
        {style[key] && (
          <button type="button" className="secondary" onClick={() => setField(key, '')}>
            Use default
          </button>
        )}
      </span>
    </label>
  )
  const sizeRow = (label: string, key: SizeField, min: number, max: number) => (
    <label key={key}>
      {label}
      <input
        type="number"
        min={min}
        max={max}
        placeholder="auto"
        value={style[key]}
        onChange={(e) => setField(key, e.target.value)}
      />
    </label>
  )
  const triRow = (label: string, key: 'halo' | 'show_aliases') => (
    <label key={key}>
      {label}
      <select value={style[key]} onChange={(e) => setField(key, e.target.value as Tri)}>
        <option value="">Default ({d[key] ? 'on' : 'off'})</option>
        <option value="on">On</option>
        <option value="off">Off</option>
      </select>
    </label>
  )

  return (
    <form className="config" onSubmit={save}>
      <section className="panel">
        <h2>Site</h2>
        <label>
          Site title
          <input type="text" value={siteTitle} maxLength={200} disabled={locked('site_title')} onChange={(e) => setSiteTitle(e.target.value)} />
          {locked('site_title') && <span className="meta">set by ASTROCAPTION_SITE_TITLE</span>}
        </label>
        <label>
          Upload limit (MB)
          <input type="number" min={1} max={1024} value={uploadMb} disabled={locked('max_upload_mb')} onChange={(e) => setUploadMb(e.target.value)} />
          {locked('max_upload_mb') && <span className="meta">set by ASTROCAPTION_MAX_UPLOAD_MB</span>}
        </label>
      </section>

      <section className="panel">
        <h2>Solver</h2>
        <p className="meta">
          nova.astrometry.net API key: {config.nova_api_key_set ? 'set' : 'not set'}
          {locked('nova_api_key') && ' (set by NOVA_API_KEY)'}
        </p>
        {!locked('nova_api_key') && (
          <>
            <label>
              {config.nova_api_key_set ? 'Replace key' : 'Key'}
              <input type="text" value={novaKey} autoComplete="off" disabled={clearKey} onChange={(e) => setNovaKey(e.target.value)} />
            </label>
            {config.nova_api_key_set && (
              <label className="hints">
                <input type="checkbox" checked={clearKey} onChange={(e) => setClearKey(e.target.checked)} /> Remove the stored key
              </label>
            )}
          </>
        )}
      </section>

      <section className="panel">
        <h2>Default label style</h2>
        <p className="meta">Applies to newly solved images. Blank fields use the size-relative defaults.</p>
        <div className="grid2">
          <label>
            Font
            <select value={style.font_file} onChange={(e) => setField('font_file', e.target.value)}>
              <option value="">Default ({d.font_file})</option>
              {fonts.map((f) => (
                <option key={f.file} value={f.file}>
                  {f.family} {f.weight}
                </option>
              ))}
            </select>
          </label>
          <label>
            Primary name
            <select value={style.name_preference} onChange={(e) => setField('name_preference', e.target.value as StyleForm['name_preference'])}>
              <option value="">Default ({d.name_preference === 'popular' ? 'Messier/Caldwell first' : 'NGC/IC first'})</option>
              <option value="popular">Messier, Caldwell, Sharpless, Barnard first</option>
              <option value="ngc_ic">NGC / IC first</option>
            </select>
          </label>
          {sizeRow('Font size (px)', 'font_size', 6, 200)}
          {sizeRow('Marker line width (px)', 'marker_width', 1, 40)}
          {sizeRow('Marker minimum radius (px)', 'marker_min_radius', 1, 400)}
          {sizeRow('Halo width (px)', 'halo_width', 0, 40)}
          {triRow('Halo', 'halo')}
          {triRow('Alias line', 'show_aliases')}
          {colorRow('Text colour', 'text_color')}
          {colorRow('Marker colour', 'marker_color')}
          {colorRow('Leader colour', 'leader_color')}
          {colorRow('Halo colour', 'halo_color')}
        </div>
      </section>

      <div className="actions">
        <button type="submit" disabled={busy}>
          {busy ? 'Saving…' : 'Save'}
        </button>
        {saved && <span className="meta">{saved}</span>}
        {error && <span className="error">{error}</span>}
      </div>
    </form>
  )
}
```

Notes for the implementer: `pageError` returns null only for a lost session, in which case the shell is redirecting and no message should be set. `<input type="color">` requires a `#rrggbb` value; `style_defaults` colours are uppercase from the model, and the browser lowercases what it emits; the stored value is whatever the picker emitted.

- [ ] **Step 2: Route and nav** in `App.tsx`

Import `Link` from `react-router` and `ConfigPage`. In the header `<nav>`, before the Log out button: `<Link to="/config">Config</Link>`. Add the route inside `<Routes>`:

```tsx
            <Route
              path="/config"
              element={
                <Guard health={health}>
                  <ConfigPage refreshHealth={refreshHealth} />
                </Guard>
              }
            />
```

- [ ] **Step 3: Styles** — append to `styles.css`

```css
header nav { display: flex; gap: 0.75rem; align-items: center; }
form.config { display: grid; gap: 1.5rem; }
form.config label { display: grid; gap: 0.3rem; color: var(--muted); font-size: 0.9rem; }
form.config .grid2 { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 0.75rem 1.5rem; }
form.config select, form.auth select { background: var(--bg); color: var(--text); border: 1px solid var(--border); border-radius: 4px; padding: 0.4rem 0.6rem; }
.color-row { display: flex; gap: 0.5rem; align-items: center; }
.color-row input[type='color'] { width: 2.6rem; height: 2rem; padding: 0; border: 1px solid var(--border); border-radius: 4px; background: var(--bg); }
```

Change the existing `header nav { margin-left: auto; }` to include `display: flex; gap: 0.75rem; align-items: center;` rather than adding a second rule.

- [ ] **Step 4: Lint, test, browser check against a scratch data dir**

Run: `cd frontend && npm run lint --silent && npm test --silent`

Browser check (never against the checkout's `data/`):

```sh
cd frontend && npm run build            # writes ../backend/static (git-ignored)
SCRATCH=$(mktemp -d)
cd ../backend && ASTROCAPTION_DATA_DIR=$SCRATCH .venv/bin/uvicorn app.main:app --port 18000 &
```

Then with the Playwright MCP tools against http://localhost:18000: complete setup, sign in, open Config via the header link; change the title and see the header update after Save; set a font, a colour via the picker, a font size; Save; reload and confirm the values persist; clear a colour with "Use default"; enter an upload limit of 0 and confirm the plain 422 message appears; enter a key, Save, confirm the line reads "set", tick "Remove the stored key", Save, confirm "not set". Kill the uvicorn (`kill %1`), `rm -rf $SCRATCH backend/static`. Save two screenshots into the SDD workspace.

- [ ] **Step 5: Commit**

```bash
git add frontend
git commit -m "feat(frontend): config page with colour pickers and env-locked fields"
```

---

### Task 5: Docs and full verification

**Files:**
- Modify: `docs/SPEC.md` § 8 config line, `docs/INSTALL.md` configuration table and the "config page (PR 2)" sentence, `docs/ARCHITECTURE.md` module row for `app/api/config.py`

- [ ] **Step 1: Docs**

SPEC § 8, replace the `GET/PUT /config` bullet with:

```markdown
- `GET/PUT /config` → {site_title, max_upload_mb, nova_api_key_set, default_style, style_defaults, locked}. `PUT`
  is partial: absent fields are kept, `nova_api_key: null` clears the key, `default_style` replaces the owner's
  override set (only the fields they chose; blank ones keep the size-relative defaults) and is validated against
  the style model and the bundled fonts. `locked` lists the fields pinned by environment variables; a `PUT` that
  touches one is rejected with a plain message naming the variable. `style_defaults` carries the built-in
  font, colours, booleans and name preference for fields without an override. Writes go through the atomic
  config.json writer and the running app re-reads the file immediately.
```

INSTALL.md: in the configuration table, add ", or the config page" to the nova key, upload limit, site title and default label style rows; replace "the config page (PR 2) shows them read-only" with "the config page shows them read-only"; under the `default_style` paragraph add "The config page edits the same object; blank fields keep the size-relative defaults." Status line: mention the config page is in.

ARCHITECTURE.md: `app/api/config.py` row → "Owner settings: `GET`, and `PUT` with locked-field and style validation through the atomic writer."

- [ ] **Step 2: Verify**

Run: `make lint test`. Expected: all clean (pytest count grows by about 12, vitest by 3).

- [ ] **Step 3: Commit, push, PR**

```bash
git add docs && git commit -m "docs: config page in SPEC, INSTALL and ARCHITECTURE"
git push -u origin feat/config-page
gh pr create --title "feat: config page with default label style" --body "$(cat <<'EOF'
Milestone 2, PR 2 of 4. Closes #8.

- `PUT /api/config`: partial updates, write-only nova key (null clears), `default_style` stored as overrides and validated against the style model and bundled fonts, env-pinned fields rejected with the variable name, writes through the atomic writer with an immediate settings reload
- `/config` page: site, solver and default-style sections, native colour pickers with "Use default", fonts from `/api/fonts`, locked fields disabled, header link
- SPEC § 8, INSTALL, ARCHITECTURE updated

🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_01LZ13YiDRbwh2oJSuC7qHQ6
EOF
)"
gh pr checks --watch
```

Then stop: the owner merges.
