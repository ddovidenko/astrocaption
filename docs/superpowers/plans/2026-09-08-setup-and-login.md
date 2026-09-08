# Setup & Login (Milestone 2, PR 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** First-run setup, password login with a session cookie, and a gate that makes every owner API route require that cookie, with matching setup and login pages in the React app.

**Architecture:** A new `backend/app/auth.py` (standard library only) does scrypt hashing, stateless HMAC session tokens and the login cooldown. `config.py` learns to write `config.json` atomically and exposes `password_hash`/`session_secret`/`trust_proxy` on `Settings`. A `require_owner` FastAPI dependency is attached to the images and fonts routers; a new `api/auth.py` router serves `/api/setup`, `/api/login`, `/api/logout`; `GET /api/health` becomes public-safe and a read-only `GET /api/config` takes over the owner-facing fields. The frontend gains react-router with `/setup`, `/login` and `/` (image list) and redirects from health state.

**Tech Stack:** Python 3.13+ / FastAPI / Pydantic / pytest; React 19 + TypeScript strict + Vite + vitest; react-router 8 (declarative mode, imports from `react-router`).

**Spec:** `docs/SPEC.md` § 5.1 (first run), § 8 (API), § 10 (auth & lockout), § 11 (`ASTROCAPTION_PASSWORD`, `TRUST_PROXY`). Design approved in chat 2026-09-08; the deltas are committed in SPEC.md on this branch.

## Global Constraints

- Python 3.13+, type hints everywhere, ruff defaults (line length 100, isort), mypy strict. Pydantic models for every request/response body.
- TypeScript strict, function components + hooks. No Redux.
- No new Python dependencies. The only new npm dependency is `react-router` (approved).
- Secrets (`password_hash`, `session_secret`, `nova_api_key`) live only in `data/config.json` and env vars; never logged, never returned by any endpoint.
- API error bodies are plain language (`{"detail": "..."}`); no server paths, no raw exception text.
- Public (logged-out) routes: `GET /api/health`, `/fonts/*` (static font files), the SPA shell. Everything else under `/api` requires the owner session.
- Password: at least 8 characters. Cookie `astrocaption_session`: HttpOnly, SameSite=Lax, `Secure` iff `TRUST_PROXY=1`, 30 days.
- Login cooldown: 5 failures → 60 s, global, in-memory, HTTP 429 with `Retry-After`.
- A corrupt `config.json` is not "setup required": setup stays closed and login is refused.
- Run `make lint test` before every commit that touches code. Conventional commit messages. Commit trailer:
  ```
  Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01LZ13YiDRbwh2oJSuC7qHQ6
  ```
- Backend commands run from `backend/` with `.venv/bin/pytest`, `.venv/bin/ruff`, `.venv/bin/mypy`. Frontend from `frontend/` with `npm test`, `npm run lint`.

## File map

| File | Responsibility |
|---|---|
| `backend/app/auth.py` (new) | `hash_password`, `verify_password`, `issue_session`, `session_is_valid`, `LoginLimiter`, `perform_setup`, cookie constants |
| `backend/app/config.py` | `Settings` gains `password_hash`, `session_secret`, `trust_proxy`, `env_locked`, `setup_required`, `auth_ready`; new `update_config` atomic writer |
| `backend/app/api/deps.py` | `require_owner` dependency, `is_authenticated(request, settings)` |
| `backend/app/api/auth.py` (new) | `/api/setup`, `/api/login`, `/api/logout` |
| `backend/app/api/health.py` | new `HealthOut` shape |
| `backend/app/api/config.py` (new) | `GET /api/config` (PUT arrives in PR 2) |
| `backend/app/api/images.py`, `backend/app/api/fonts.py` | routers gain `dependencies=[Depends(require_owner)]` |
| `backend/app/main.py` | mounts the new routers, holds the `LoginLimiter`, performs headless setup from `ASTROCAPTION_PASSWORD` |
| `backend/app/models.py` | `HealthOut`, `ConfigOut`, `SetupRequest`, `LoginRequest` |
| `backend/tests/test_auth.py` (new), `test_config.py` (new), `test_auth_api.py` (new), `conftest.py`, `test_api.py` | tests |
| `frontend/src/api.ts` | new types and calls, 401 handler |
| `frontend/src/App.tsx` | shell + routes + guards |
| `frontend/src/pages/ImagesPage.tsx` (new) | the existing upload/list UI, moved verbatim |
| `frontend/src/pages/SetupPage.tsx`, `LoginPage.tsx` (new) | forms |
| `frontend/src/main.tsx`, `styles.css` | `BrowserRouter`, form styles |
| `docs/INSTALL.md`, `docs/ARCHITECTURE.md` | first-run docs, module table |

---

### Task 1: Password hashing (`auth.py`)

**Files:**
- Create: `backend/app/auth.py`
- Test: `backend/tests/test_auth.py`

**Interfaces:**
- Produces: `hash_password(password: str) -> str` (format `scrypt$n$r$p$salt_b64$digest_b64`), `verify_password(password: str, stored: str) -> bool`, `MIN_PASSWORD_LENGTH = 8`.

- [ ] **Step 1: Write the failing tests**

```python
# backend/tests/test_auth.py
from __future__ import annotations

from app.auth import hash_password, verify_password


def test_hash_roundtrip_and_format() -> None:
    stored = hash_password("correct horse battery")
    parts = stored.split("$")
    assert parts[0] == "scrypt" and len(parts) == 6
    assert (parts[1], parts[2], parts[3]) == ("32768", "8", "1")
    assert verify_password("correct horse battery", stored)
    assert not verify_password("correct horse batter", stored)
    assert not verify_password("", stored)


def test_hash_is_salted() -> None:
    assert hash_password("same") != hash_password("same")


def test_verify_rejects_malformed_hashes() -> None:
    assert not verify_password("x", "")
    assert not verify_password("x", "bcrypt$whatever")
    assert not verify_password("x", "scrypt$32768$8$1$not-base64$zzz")
    assert not verify_password("x", "scrypt$32768$8$1$AAAA")
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd backend && .venv/bin/pytest tests/test_auth.py -q`
Expected: ImportError, `app.auth` does not exist.

- [ ] **Step 3: Write the implementation**

```python
# backend/app/auth.py
"""Passwords, sessions and the login cooldown (SPEC § 10). Standard library only.

Nothing here logs; the hash and the session secret are read from ``Settings`` and never
leave the process.
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import hmac
import secrets
import time
from collections.abc import Callable

SCRYPT_N = 2**15
SCRYPT_R = 8
SCRYPT_P = 1
SCRYPT_MAXMEM = 128 * 1024 * 1024  # n=2^15, r=8 needs ~32 MB; OpenSSL's default cap is exactly that
SALT_BYTES = 32
DIGEST_BYTES = 32
MIN_PASSWORD_LENGTH = 8

COOKIE_NAME = "astrocaption_session"
SESSION_TTL_SECONDS = 30 * 24 * 3600
CLOCK_SKEW_SECONDS = 60


def _b64(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def _unb64(text: str) -> bytes:
    padded = text + "=" * (-len(text) % 4)
    return base64.urlsafe_b64decode(padded.encode("ascii"))


def _scrypt(password: str, salt: bytes, n: int, r: int, p: int, dklen: int) -> bytes:
    return hashlib.scrypt(
        password.encode("utf-8"), salt=salt, n=n, r=r, p=p, maxmem=SCRYPT_MAXMEM, dklen=dklen
    )


def hash_password(password: str) -> str:
    """``scrypt$n$r$p$salt$digest`` with a fresh random salt; parameters travel with the hash."""
    salt = secrets.token_bytes(SALT_BYTES)
    digest = _scrypt(password, salt, SCRYPT_N, SCRYPT_R, SCRYPT_P, DIGEST_BYTES)
    return "$".join(
        ["scrypt", str(SCRYPT_N), str(SCRYPT_R), str(SCRYPT_P), _b64(salt), _b64(digest)]
    )


def verify_password(password: str, stored: str) -> bool:
    """Constant-time comparison; any malformed ``stored`` value is simply a mismatch."""
    try:
        scheme, n, r, p, salt_text, digest_text = stored.split("$")
        if scheme != "scrypt":
            return False
        expected = _unb64(digest_text)
        actual = _scrypt(password, _unb64(salt_text), int(n), int(r), int(p), len(expected))
    except (ValueError, TypeError, binascii.Error, UnicodeEncodeError):
        return False
    return hmac.compare_digest(actual, expected)
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd backend && .venv/bin/pytest tests/test_auth.py -q`
Expected: 3 passed.

- [ ] **Step 5: Lint and commit**

```bash
cd backend && .venv/bin/ruff check . && .venv/bin/ruff format . && .venv/bin/mypy
cd .. && git add backend/app/auth.py backend/tests/test_auth.py
git commit -m "feat(auth): scrypt password hashing"
```

---

### Task 2: Session tokens and the login cooldown

**Files:**
- Modify: `backend/app/auth.py`
- Test: `backend/tests/test_auth.py`

**Interfaces:**
- Produces: `issue_session(secret: str, password_hash: str, now: float | None = None) -> str`; `session_is_valid(token: str | None, secret: str, password_hash: str, now: float | None = None) -> bool`; `class LoginLimiter(max_failures=5, cooldown=60.0, clock=time.monotonic)` with `retry_after() -> int` (0 when allowed), `record_failure() -> None`, `reset() -> None`.

- [ ] **Step 1: Write the failing tests** (append to `backend/tests/test_auth.py`)

```python
from app.auth import (
    SESSION_TTL_SECONDS,
    LoginLimiter,
    hash_password,
    issue_session,
    session_is_valid,
    verify_password,
)

HASH = hash_password("pw-for-sessions")


def test_session_roundtrip_and_expiry() -> None:
    token = issue_session("secret", HASH, now=1_000_000.0)
    assert session_is_valid(token, "secret", HASH, now=1_000_000.0 + 10)
    assert session_is_valid(token, "secret", HASH, now=1_000_000.0 + SESSION_TTL_SECONDS)
    assert not session_is_valid(token, "secret", HASH, now=1_000_000.0 + SESSION_TTL_SECONDS + 1)
    assert not session_is_valid(token, "secret", HASH, now=1_000_000.0 - 120)  # issued in the future


def test_session_rejects_tampering_other_secret_and_password_change() -> None:
    token = issue_session("secret", HASH, now=1_000_000.0)
    issued, sig = token.split(".")
    assert not session_is_valid(f"{int(issued) + 1}.{sig}", "secret", HASH, now=1_000_100.0)
    assert not session_is_valid(f"{issued}.{sig[:-1]}0", "secret", HASH, now=1_000_100.0)
    assert not session_is_valid(token, "other-secret", HASH, now=1_000_100.0)
    assert not session_is_valid(token, "secret", hash_password("new password"), now=1_000_100.0)
    assert not session_is_valid(None, "secret", HASH)
    assert not session_is_valid("", "secret", HASH)
    assert not session_is_valid("garbage", "secret", HASH)
    assert not session_is_valid("abc.def", "secret", HASH)


def test_login_limiter_locks_after_five_failures() -> None:
    now = [100.0]
    limiter = LoginLimiter(max_failures=5, cooldown=60.0, clock=lambda: now[0])
    for _ in range(4):
        limiter.record_failure()
        assert limiter.retry_after() == 0
    limiter.record_failure()
    assert limiter.retry_after() == 60
    now[0] += 59.5
    assert limiter.retry_after() == 1
    now[0] += 1.0
    assert limiter.retry_after() == 0
    limiter.record_failure()  # the counter restarted after the cooldown
    assert limiter.retry_after() == 0
    limiter.reset()
    for _ in range(4):
        limiter.record_failure()
    assert limiter.retry_after() == 0
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd backend && .venv/bin/pytest tests/test_auth.py -q`
Expected: ImportError for `issue_session`.

- [ ] **Step 3: Write the implementation** (append to `backend/app/auth.py`)

```python
def _fingerprint(password_hash: str) -> str:
    return hashlib.sha256(password_hash.encode("utf-8")).hexdigest()[:32]


def _signature(secret: str, issued: int, password_hash: str) -> str:
    message = f"{issued}:{_fingerprint(password_hash)}".encode()
    return hmac.new(secret.encode("utf-8"), message, hashlib.sha256).hexdigest()


def issue_session(secret: str, password_hash: str, now: float | None = None) -> str:
    """``<issued>.<hmac>``: stateless, bound to the current password hash (SPEC § 10)."""
    issued = int(time.time() if now is None else now)
    return f"{issued}.{_signature(secret, issued, password_hash)}"


def session_is_valid(
    token: str | None, secret: str, password_hash: str, now: float | None = None
) -> bool:
    if not token or "." not in token:
        return False
    issued_text, signature = token.split(".", 1)
    if not issued_text.isdigit():
        return False
    issued = int(issued_text)
    current = time.time() if now is None else now
    if issued > current + CLOCK_SKEW_SECONDS or current - issued > SESSION_TTL_SECONDS:
        return False
    return hmac.compare_digest(signature, _signature(secret, issued, password_hash))


class LoginLimiter:
    """Global cooldown: ``max_failures`` wrong passwords start ``cooldown`` seconds of 429s."""

    def __init__(
        self,
        max_failures: int = 5,
        cooldown: float = 60.0,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._max_failures = max_failures
        self._cooldown = cooldown
        self._clock = clock
        self._failures = 0
        self._locked_until = 0.0

    def retry_after(self) -> int:
        """Whole seconds until the next attempt is allowed; 0 when it is allowed now."""
        remaining = self._locked_until - self._clock()
        if remaining <= 0:
            return 0
        return max(1, int(remaining + 0.999))

    def record_failure(self) -> None:
        self._failures += 1
        if self._failures >= self._max_failures:
            self._failures = 0
            self._locked_until = self._clock() + self._cooldown

    def reset(self) -> None:
        self._failures = 0
        self._locked_until = 0.0
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd backend && .venv/bin/pytest tests/test_auth.py -q`
Expected: 6 passed.

- [ ] **Step 5: Lint and commit**

```bash
cd backend && .venv/bin/ruff check . && .venv/bin/ruff format . && .venv/bin/mypy
cd .. && git add backend/app/auth.py backend/tests/test_auth.py
git commit -m "feat(auth): stateless session tokens and login cooldown"
```

---

### Task 3: Settings fields and the atomic config writer

**Files:**
- Modify: `backend/app/config.py`
- Modify: `backend/app/auth.py` (add `perform_setup`)
- Modify: `backend/tests/conftest.py:44-58` (`make_settings`)
- Test: `backend/tests/test_config.py` (new)

**Interfaces:**
- Produces on `Settings`: `password_hash: str | None` (repr=False), `session_secret: str | None` (repr=False), `trust_proxy: bool`, `env_locked: frozenset[str]` (subset of `{"nova_api_key", "max_upload_mb", "site_title"}`), properties `setup_required: bool` (no hash AND no config error) and `auth_ready: bool` (hash and secret both present).
- Produces: `update_config(path: Path, updates: Mapping[str, object | None]) -> None` — merges into the existing JSON object (a `None` value removes the key), raises `ConfigError` instead of overwriting a corrupt file, writes `path` atomically with mode 0600.
- Produces: `perform_setup(settings: Settings, password: str, *, nova_api_key: str | None = None, site_title: str | None = None) -> None` in `auth.py`: writes `password_hash` and a fresh `session_secret`, plus the key/title when given non-empty.

- [ ] **Step 1: Write the failing tests**

```python
# backend/tests/test_config.py
from __future__ import annotations

import json
import os
import stat
from pathlib import Path

import pytest

from app.auth import perform_setup, verify_password
from app.config import ConfigError, load_settings, update_config
from tests.conftest import FONTS_DIR


def env_for(tmp_path: Path, **extra: str) -> dict[str, str]:
    return {"ASTROCAPTION_DATA_DIR": str(tmp_path), "ASTROCAPTION_FONTS_DIR": str(FONTS_DIR), **extra}


def test_settings_without_config_file_require_setup(tmp_path: Path) -> None:
    s = load_settings(env_for(tmp_path))
    assert s.password_hash is None and s.session_secret is None
    assert s.setup_required is True and s.auth_ready is False
    assert s.trust_proxy is False and s.env_locked == frozenset()


def test_settings_read_auth_fields_and_env_locks(tmp_path: Path) -> None:
    (tmp_path / "config.json").write_text(
        json.dumps({"password_hash": "scrypt$x", "session_secret": "s", "site_title": "File"})
    )
    s = load_settings(env_for(tmp_path, TRUST_PROXY="1", ASTROCAPTION_SITE_TITLE="Env", NOVA_API_KEY="k"))
    assert (s.password_hash, s.session_secret) == ("scrypt$x", "s")
    assert s.setup_required is False and s.auth_ready is True
    assert s.trust_proxy is True
    assert s.site_title == "Env" and s.env_locked == {"site_title", "nova_api_key"}
    assert "scrypt$x" not in repr(s)  # both secrets are repr=False


def test_corrupt_config_is_not_setup_required(tmp_path: Path) -> None:
    (tmp_path / "config.json").write_text("{not json")
    s = load_settings(env_for(tmp_path))
    assert s.config_error and s.setup_required is False and s.auth_ready is False


def test_update_config_merges_atomically_with_private_mode(tmp_path: Path) -> None:
    path = tmp_path / "config.json"
    update_config(path, {"site_title": "One", "nova_api_key": "k"})
    update_config(path, {"site_title": "Two", "nova_api_key": None, "extra": [1, 2]})
    assert json.loads(path.read_text()) == {"site_title": "Two", "extra": [1, 2]}
    assert stat.S_IMODE(path.stat().st_mode) == 0o600
    assert not path.with_suffix(".json.tmp").exists()
    assert sorted(os.listdir(tmp_path)) == ["config.json"]


def test_update_config_refuses_to_overwrite_a_corrupt_file(tmp_path: Path) -> None:
    path = tmp_path / "config.json"
    path.write_text("{oops")
    with pytest.raises(ConfigError):
        update_config(path, {"site_title": "x"})
    assert path.read_text() == "{oops"


def test_perform_setup_writes_hash_secret_and_optional_fields(tmp_path: Path) -> None:
    before = load_settings(env_for(tmp_path))
    perform_setup(before, "hunter2hunter2", nova_api_key="  key  ", site_title="")
    after = load_settings(env_for(tmp_path))
    assert after.auth_ready and after.setup_required is False
    assert after.password_hash and verify_password("hunter2hunter2", after.password_hash)
    assert after.session_secret and len(after.session_secret) >= 32
    assert after.nova_api_key == "key" and after.site_title == "AstroCaption"
    written = json.loads((tmp_path / "config.json").read_text())
    assert "site_title" not in written and "password" not in written
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd backend && .venv/bin/pytest tests/test_config.py -q`
Expected: ImportError (`update_config`, `perform_setup`).

- [ ] **Step 3: Extend `Settings` and `load_settings`** in `backend/app/config.py`

Replace the `Settings` dataclass body's tail (after `config_error`) and the return of `load_settings`:

```python
@dataclass(frozen=True)
class Settings:
    data_dir: Path
    fonts_dir: Path
    static_dir: Path
    nova_api_key: str | None = field(repr=False)
    max_upload_mb: int
    site_title: str
    nova_base_url: str = DEFAULT_NOVA_BASE_URL
    default_style: dict[str, object] = field(default_factory=dict)
    config_error: str | None = None  # why config.json was ignored, if it was
    password_hash: str | None = field(default=None, repr=False)
    session_secret: str | None = field(default=None, repr=False)
    trust_proxy: bool = False
    env_locked: frozenset[str] = frozenset()  # settings an env var overrides (read-only in the UI)

    # ... existing properties unchanged ...

    @property
    def setup_required(self) -> bool:
        """No owner password yet. A corrupt config.json is *not* setup-required (SPEC § 5.1)."""
        return self.password_hash is None and self.config_error is None

    @property
    def auth_ready(self) -> bool:
        return bool(self.password_hash and self.session_secret)
```

In `load_settings`, after `title = ...`:

```python
    env_locked = frozenset(
        name
        for name, present in (
            ("nova_api_key", bool(e.get("NOVA_API_KEY") or e.get("ASTROMETRY_API_KEY"))),
            ("max_upload_mb", bool(e.get("ASTROCAPTION_MAX_UPLOAD_MB"))),
            ("site_title", bool(e.get("ASTROCAPTION_SITE_TITLE"))),
        )
        if present
    )
    password_hash = cfg.get("password_hash")
    session_secret = cfg.get("session_secret")
```

and add to the `Settings(...)` call:

```python
        password_hash=password_hash if isinstance(password_hash, str) and password_hash else None,
        session_secret=session_secret if isinstance(session_secret, str) and session_secret else None,
        trust_proxy=e.get("TRUST_PROXY", "").strip().lower() in {"1", "true", "yes"},
        env_locked=env_locked,
```

Update the module docstring's first sentence to: `Sources, in order of precedence: environment variables, then ``data/config.json`` (written by the setup flow and the config page), then built-in defaults.`

- [ ] **Step 4: Add `update_config`** at the end of `backend/app/config.py`

```python
def update_config(path: Path, updates: Mapping[str, object | None]) -> None:
    """Merge ``updates`` into config.json atomically. ``None`` removes a key.

    Written as a private file (0600): it holds the password hash and the session secret.
    A file that cannot be parsed is left untouched and reported, never replaced.
    """
    current: dict[str, object] = _parse_config(path) if path.is_file() else {}
    for key, value in updates.items():
        if value is None:
            current.pop(key, None)
        else:
            current[key] = value
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".json.tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(current, fh, indent=2)
            fh.write("\n")
        os.replace(tmp, path)
    except BaseException:
        tmp.unlink(missing_ok=True)
        raise
    os.chmod(path, 0o600)
```

- [ ] **Step 5: Add `perform_setup`** at the end of `backend/app/auth.py`

```python
from .config import Settings, update_config  # add to the imports at the top


def perform_setup(
    settings: Settings,
    password: str,
    *,
    nova_api_key: str | None = None,
    site_title: str | None = None,
) -> None:
    """Write the owner password hash and a fresh session secret (SPEC § 5.1 step 4)."""
    updates: dict[str, object | None] = {
        "password_hash": hash_password(password),
        "session_secret": secrets.token_urlsafe(32),
    }
    if nova_api_key and nova_api_key.strip():
        updates["nova_api_key"] = nova_api_key.strip()
    if site_title and site_title.strip():
        updates["site_title"] = site_title.strip()
    update_config(settings.config_path, updates)
```

- [ ] **Step 6: Give test settings an owner** in `backend/tests/conftest.py`

Add near the top, after the fixture-dir constants:

```python
from app.auth import hash_password

TEST_PASSWORD = "correct horse battery"
TEST_PASSWORD_HASH = hash_password(TEST_PASSWORD)  # once per session; scrypt is deliberately slow
TEST_SESSION_SECRET = "test-session-secret"
```

and in `make_settings` add to `values`: `"password_hash": TEST_PASSWORD_HASH, "session_secret": TEST_SESSION_SECRET,`.

- [ ] **Step 7: Run the tests to verify they pass**

Run: `cd backend && .venv/bin/pytest tests/test_config.py tests/test_auth.py -q`
Expected: all passed. Then `cd backend && .venv/bin/pytest -q` — the whole suite must still pass (nothing is gated yet).

- [ ] **Step 8: Lint and commit**

```bash
cd backend && .venv/bin/ruff check . && .venv/bin/ruff format . && .venv/bin/mypy
cd .. && git add backend/app/config.py backend/app/auth.py backend/tests/conftest.py backend/tests/test_config.py
git commit -m "feat(config): auth fields, env locks and an atomic config.json writer"
```

---

### Task 4: The owner gate, the new health shape and `GET /api/config`

**Files:**
- Modify: `backend/app/api/deps.py`
- Modify: `backend/app/models.py:397-402` (`HealthOut`), add `ConfigOut`
- Modify: `backend/app/api/health.py`
- Create: `backend/app/api/config.py`
- Modify: `backend/app/api/images.py:44`, `backend/app/api/fonts.py:9` (router `dependencies`)
- Modify: `backend/app/main.py` (include the config router)
- Modify: `backend/tests/conftest.py` (`client` logs in; new `anon_client`), `backend/tests/test_api.py:32-46, 339-344, 376-384`
- Test: `backend/tests/test_auth_api.py` (new)

**Interfaces:**
- Consumes: `session_is_valid`, `COOKIE_NAME` (Task 2); `Settings.auth_ready`, `setup_required`, `env_locked` (Task 3).
- Produces: `require_owner(request: Request, settings: SettingsDep) -> None` and `is_authenticated(request: Request, settings: Settings) -> bool` in `deps.py`; `OwnerDep = Depends(require_owner)` is **not** created — routers use `dependencies=[Depends(require_owner)]` directly.
- Produces: `HealthOut(status, version, site_title, setup_required, authenticated, config_error)`; `ConfigOut(site_title, max_upload_mb, nova_api_key_set, default_style, locked)`.
- Produces in conftest: `login(client: TestClient, password: str = TEST_PASSWORD) -> None`, fixture `anon_client` (same app, no cookie). The `client` fixture is logged in.

- [ ] **Step 1: Write the failing tests**

Update `test_health_and_fonts` in `backend/tests/test_api.py`:

```python
def test_health_and_fonts(client: TestClient) -> None:
    health = client.get("/api/health").json()
    assert health == {
        "status": "ok",
        "version": health["version"],
        "site_title": "Test Site",
        "setup_required": False,
        "authenticated": True,
        "config_error": None,
    }
    config = client.get("/api/config").json()
    assert config == {
        "site_title": "Test Site",
        "max_upload_mb": 5,
        "nova_api_key_set": False,
        "default_style": {},
        "locked": [],
    }
    fonts = client.get("/api/fonts").json()
    # ... rest unchanged ...
```

Update the two `env_client` tests (they run without a password, so they read health only):

```python
def test_health_reflects_a_key_added_after_start(env_client: tuple[TestClient, Path]) -> None:
    client, data_dir = env_client
    assert client.get("/api/health").json()["setup_required"] is True
    assert client.get("/api/config").status_code == 401
    (data_dir / "config.json").write_text(
        json.dumps({"password_hash": TEST_PASSWORD_HASH, "session_secret": "s"})
    )
    assert client.get("/api/health").json()["setup_required"] is False
    login(client)
    assert client.get("/api/config").json()["nova_api_key_set"] is False
    (data_dir / "config.json").write_text(
        json.dumps({"password_hash": TEST_PASSWORD_HASH, "session_secret": "s", "nova_api_key": "k"})
    )
    assert client.get("/api/config").json()["nova_api_key_set"] is True


def test_health_reports_a_broken_config_file(env_client: tuple[TestClient, Path]) -> None:
    client, data_dir = env_client
    (data_dir / "config.json").write_text('{"nova_api_key": "k",')
    body = client.get("/api/health").json()
    assert body["setup_required"] is False and body["authenticated"] is False
    assert body["config_error"] and "not valid JSON" in body["config_error"]
    assert client.post("/api/setup", json={"password": "hunter2hunter2"}).status_code == 404
    (data_dir / "config.json").write_text(
        json.dumps({"password_hash": TEST_PASSWORD_HASH, "session_secret": "s", "nova_api_key": "k"})
    )
    body = client.get("/api/health").json()
    assert body["setup_required"] is False and body["config_error"] is None
```

(add `import json` and `from tests.conftest import TEST_PASSWORD_HASH, login` to the test module's imports; the `/api/setup` 404 line will pass once Task 5 lands — until then mark it with a comment and expect the test to fail on that line only.)

New file `backend/tests/test_auth_api.py`:

```python
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

OWNER_ROUTES = [
    ("GET", "/api/images"),
    ("POST", "/api/images"),
    ("GET", "/api/images/x"),
    ("DELETE", "/api/images/x"),
    ("POST", "/api/images/x/solve"),
    ("GET", "/api/images/x/objects"),
    ("GET", "/api/images/x/annotations"),
    ("POST", "/api/images/x/export"),
    ("GET", "/api/images/x/export"),
    ("GET", "/api/images/x/files/preview"),
    ("GET", "/api/fonts"),
    ("GET", "/api/config"),
]


@pytest.mark.parametrize(("method", "path"), OWNER_ROUTES)
def test_owner_routes_need_a_session(anon_client: TestClient, method: str, path: str) -> None:
    resp = anon_client.request(method, path)
    assert resp.status_code == 401, (method, path, resp.text)
    assert resp.json() == {"detail": "Sign in to continue."}


def test_public_routes_stay_public(anon_client: TestClient) -> None:
    body = anon_client.get("/api/health").json()
    assert body["authenticated"] is False and body["setup_required"] is False
    assert anon_client.get("/fonts/Inter-Regular.ttf").status_code == 200


def test_forged_cookie_is_ignored(anon_client: TestClient) -> None:
    anon_client.cookies.set("astrocaption_session", "1.deadbeef")
    assert anon_client.get("/api/images").status_code == 401
    assert anon_client.get("/api/health").json()["authenticated"] is False
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd backend && .venv/bin/pytest tests/test_auth_api.py tests/test_api.py -q -k "health or session or public or forged"`
Expected: failures (`anon_client` fixture missing, 200 instead of 401, old health keys).

- [ ] **Step 3: Write `require_owner` and `is_authenticated`** in `backend/app/api/deps.py`

Place both functions **after** the `SettingsDep = ...` line at the bottom of the file, since `require_owner` uses that alias.

```python
from fastapi import Depends, HTTPException, Request, status

from ..auth import COOKIE_NAME, session_is_valid
# (keep the existing imports)


def is_authenticated(request: Request, settings: Settings) -> bool:
    if not settings.auth_ready:
        return False
    assert settings.session_secret and settings.password_hash  # auth_ready guarantees both
    return session_is_valid(
        request.cookies.get(COOKIE_NAME), settings.session_secret, settings.password_hash
    )


def require_owner(request: Request, settings: SettingsDep) -> None:
    """Router-level gate for every owner route (SPEC § 8). Plain 401, no hints."""
    if not is_authenticated(request, settings):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Sign in to continue.")
```

- [ ] **Step 4: Models** in `backend/app/models.py` — replace `HealthOut` and add `ConfigOut` after it

```python
class HealthOut(BaseModel):
    """Public: safe for the Docker healthcheck and the logged-out page."""

    status: Literal["ok"] = "ok"
    version: str
    site_title: str
    setup_required: bool
    authenticated: bool
    config_error: str | None = None


class ConfigOut(BaseModel):
    """Owner-facing settings. The nova key is write-only: only its presence is reported."""

    site_title: str
    max_upload_mb: int
    nova_api_key_set: bool
    default_style: dict[str, object]
    locked: list[str]  # fields pinned by environment variables
```

- [ ] **Step 5: Health and config routers**

`backend/app/api/health.py`:

```python
from __future__ import annotations

from fastapi import APIRouter, Request

from .. import __version__
from ..models import HealthOut
from .deps import SettingsDep, is_authenticated

router = APIRouter(prefix="/api", tags=["health"])


@router.get("/health")
async def health(request: Request, settings: SettingsDep) -> HealthOut:
    return HealthOut(
        version=__version__,
        site_title=settings.site_title,
        setup_required=settings.setup_required,
        authenticated=is_authenticated(request, settings),
        config_error=settings.config_error,
    )
```

`backend/app/api/config.py` (new):

```python
"""Owner settings. ``PUT`` arrives with the config page (milestone 2, PR 2)."""

from __future__ import annotations

from fastapi import APIRouter, Depends

from ..config import Settings
from ..models import ConfigOut
from .deps import SettingsDep, require_owner

router = APIRouter(prefix="/api", tags=["config"], dependencies=[Depends(require_owner)])


def config_out(settings: Settings) -> ConfigOut:
    return ConfigOut(
        site_title=settings.site_title,
        max_upload_mb=settings.max_upload_mb,
        nova_api_key_set=settings.nova_api_key_set,
        default_style=dict(settings.default_style),
        locked=sorted(settings.env_locked),
    )


@router.get("/config")
async def get_config(settings: SettingsDep) -> ConfigOut:
    return config_out(settings)
```

- [ ] **Step 6: Gate the existing routers**

`backend/app/api/images.py` line 44 becomes:

```python
router = APIRouter(
    prefix="/api/images", tags=["images"], dependencies=[Depends(require_owner)]
)
```

with `Depends` added to the `fastapi` import and `from .deps import DbDep, SettingsDep, WorkerDep, require_owner`.

`backend/app/api/fonts.py`:

```python
from fastapi import APIRouter, Depends

from .deps import SettingsDep, require_owner

router = APIRouter(prefix="/api", tags=["fonts"], dependencies=[Depends(require_owner)])
```

`backend/app/main.py`: `from .api import config, fonts, health, images` and `app.include_router(config.router)` after the fonts router.

- [ ] **Step 7: Test fixtures** in `backend/tests/conftest.py`

```python
def login(client: TestClient, password: str = TEST_PASSWORD) -> None:
    resp = client.post("/api/login", json={"password": password})
    assert resp.status_code == 204, resp.text


@pytest.fixture
def client(settings: Settings, fake_solver: FakeSolver) -> Iterator[TestClient]:
    """Logged-in owner."""
    with make_client(settings, lambda: fake_solver) as c:
        login(c)
        yield c


@pytest.fixture
def anon_client(settings: Settings, fake_solver: FakeSolver) -> Iterator[TestClient]:
    """Same app, no session cookie."""
    with make_client(settings, lambda: fake_solver) as c:
        yield c
```

Also search `backend/tests` for every `make_client(` call inside a `with` in test bodies (test_api.py lines 106, 134, 154, 234, 247, 267, 313 and test_worker.py if any) and add `login(client)` as the first statement inside the `with` block. `upload()` and friends already assert 201 so a missing login fails loudly.

`login` posts to `/api/login`, which does not exist until Task 5. **Run Task 5's Step 3 (the auth router) before running the suite** if you want green here; otherwise proceed to Task 5 and run both together. Do not commit Task 4 alone with a red suite: commit Tasks 4 and 5 together if needed, in that case with the message from Task 5.

- [ ] **Step 8: Lint**

```bash
cd backend && .venv/bin/ruff check . && .venv/bin/ruff format . && .venv/bin/mypy
```

---

### Task 5: `/api/setup`, `/api/login`, `/api/logout` and headless setup

**Files:**
- Create: `backend/app/api/auth.py`
- Modify: `backend/app/models.py` (add `SetupRequest`, `LoginRequest`)
- Modify: `backend/app/main.py` (limiter on `app.state`, `setup_password` parameter, headless setup in lifespan, include router)
- Test: `backend/tests/test_auth_api.py`

**Interfaces:**
- Consumes: `hash_password`, `verify_password`, `issue_session`, `LoginLimiter`, `perform_setup`, `COOKIE_NAME`, `SESSION_TTL_SECONDS`, `MIN_PASSWORD_LENGTH` (Tasks 1–3); `is_authenticated` (Task 4).
- Produces: `create_app(..., setup_password: str | None = None)`; `app.state.login_limiter: LoginLimiter`. Responses: setup/login/logout all `204 No Content`; login sets the cookie, logout clears it.

- [ ] **Step 1: Write the failing tests** (append to `backend/tests/test_auth_api.py`)

```python
import json
from pathlib import Path

from app.auth import LoginLimiter
from app.main import create_app
from tests.conftest import TEST_PASSWORD, login


def fresh_app_client(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, **env: str) -> TestClient:
    """An app reading a data dir with no config.json (setup required), config live."""
    data_dir = tmp_path / "data"
    data_dir.mkdir()
    monkeypatch.setenv("ASTROCAPTION_DATA_DIR", str(data_dir))
    for name in ("NOVA_API_KEY", "ASTROMETRY_API_KEY", "ASTROCAPTION_SITE_TITLE", "TRUST_PROXY"):
        monkeypatch.delenv(name, raising=False)
    for name, value in env.items():
        monkeypatch.setenv(name, value)
    setup_password = env.get("ASTROCAPTION_PASSWORD")
    app = create_app(solver_factory=lambda: None, poll_interval=0.01, setup_password=setup_password)
    return TestClient(app)


def test_setup_then_login_then_logout(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    with fresh_app_client(tmp_path, monkeypatch) as client:
        assert client.get("/api/health").json()["setup_required"] is True
        assert client.post("/api/login", json={"password": "anything"}).status_code == 401
        assert client.post("/api/setup", json={"password": "short"}).status_code == 422
        resp = client.post(
            "/api/setup",
            json={"password": "hunter2hunter2", "nova_api_key": "k", "site_title": "My sky"},
        )
        assert resp.status_code == 204 and "set-cookie" not in resp.headers
        assert client.post("/api/setup", json={"password": "hunter2hunter2"}).status_code == 404
        health = client.get("/api/health").json()
        assert health["setup_required"] is False and health["authenticated"] is False
        assert health["site_title"] == "My sky"
        assert client.get("/api/images").status_code == 401

        wrong = client.post("/api/login", json={"password": "hunter2hunter3"})
        assert wrong.status_code == 401 and wrong.json()["detail"] == "Wrong password."
        ok = client.post("/api/login", json={"password": "hunter2hunter2"})
        assert ok.status_code == 204
        cookie = ok.headers["set-cookie"]
        assert "astrocaption_session=" in cookie and "HttpOnly" in cookie
        assert "SameSite=lax" in cookie and "Secure" not in cookie and "Max-Age=2592000" in cookie
        assert client.get("/api/health").json()["authenticated"] is True
        assert client.get("/api/images").json() == []
        assert client.get("/api/config").json()["nova_api_key_set"] is True

        out = client.post("/api/logout")
        assert out.status_code == 204 and "Max-Age=0" in out.headers["set-cookie"]
        assert client.get("/api/health").json()["authenticated"] is False
        assert client.get("/api/images").status_code == 401

        written = json.loads((tmp_path / "data" / "config.json").read_text())
        assert set(written) == {"password_hash", "session_secret", "nova_api_key", "site_title"}
        assert "hunter2" not in json.dumps(written)


def test_secure_cookie_behind_a_proxy(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    with fresh_app_client(tmp_path, monkeypatch, TRUST_PROXY="1") as client:
        assert client.post("/api/setup", json={"password": "hunter2hunter2"}).status_code == 204
        ok = client.post("/api/login", json={"password": "hunter2hunter2"})
        assert "Secure" in ok.headers["set-cookie"]


def test_headless_setup_from_environment(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    with fresh_app_client(tmp_path, monkeypatch, ASTROCAPTION_PASSWORD="from-the-env") as client:
        assert client.get("/api/health").json()["setup_required"] is False
        assert client.post("/api/setup", json={"password": "hunter2hunter2"}).status_code == 404
        assert client.post("/api/login", json={"password": "from-the-env"}).status_code == 204
    # A second start with the variable still set changes nothing.
    with fresh_app_client(tmp_path, monkeypatch, ASTROCAPTION_PASSWORD="from-the-env") as client:
        assert client.post("/api/login", json={"password": "from-the-env"}).status_code == 204


def test_headless_setup_ignores_a_short_password(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    with fresh_app_client(tmp_path, monkeypatch, ASTROCAPTION_PASSWORD="abc") as client:
        assert client.get("/api/health").json()["setup_required"] is True
    assert "ASTROCAPTION_PASSWORD" in caplog.text and "abc" not in caplog.text


def test_login_cooldown_after_five_failures(anon_client: TestClient) -> None:
    for _ in range(5):
        assert anon_client.post("/api/login", json={"password": "nope"}).status_code == 401
    blocked = anon_client.post("/api/login", json={"password": TEST_PASSWORD})
    assert blocked.status_code == 429
    assert blocked.headers["retry-after"] == "60"
    assert "60 seconds" in blocked.json()["detail"]
    limiter: LoginLimiter = anon_client.app.state.login_limiter  # type: ignore[attr-defined]
    limiter.reset()
    login(anon_client)
    assert anon_client.get("/api/images").status_code == 200


def test_password_reset_invalidates_sessions(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    with fresh_app_client(tmp_path, monkeypatch) as client:
        client.post("/api/setup", json={"password": "hunter2hunter2"})
        login(client, "hunter2hunter2")
        assert client.get("/api/images").status_code == 200
        # The reset CLI arrives in PR 3; drive the hash change through update_config directly.
        update_config(
            tmp_path / "data" / "config.json", {"password_hash": hash_password("new-password-1")}
        )
        assert client.get("/api/images").status_code == 401
        login(client, "new-password-1")
        assert client.get("/api/images").status_code == 200
```

(the module imports become `from app.auth import LoginLimiter, hash_password` and `from app.config import update_config`.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd backend && .venv/bin/pytest tests/test_auth_api.py -q`
Expected: 404s on `/api/login` and `/api/setup`, `TypeError` on `setup_password`.

- [ ] **Step 3: Request models** in `backend/app/models.py`, after `ConfigOut`

```python
class SetupRequest(BaseModel):
    password: str = Field(max_length=1024)
    nova_api_key: str | None = Field(default=None, max_length=200)
    site_title: str | None = Field(default=None, max_length=200)


class LoginRequest(BaseModel):
    password: str = Field(max_length=1024)
```

- [ ] **Step 4: The auth router** `backend/app/api/auth.py`

```python
"""First-run setup, login and logout (SPEC § 5.1, § 10)."""

from __future__ import annotations

import asyncio

from fastapi import APIRouter, HTTPException, Request, Response, status

from ..auth import (
    COOKIE_NAME,
    MIN_PASSWORD_LENGTH,
    SESSION_TTL_SECONDS,
    LoginLimiter,
    issue_session,
    perform_setup,
    verify_password,
)
from ..models import LoginRequest, SetupRequest
from .deps import SettingsDep

router = APIRouter(prefix="/api", tags=["auth"])


def get_limiter(request: Request) -> LoginLimiter:
    limiter: LoginLimiter = request.app.state.login_limiter
    return limiter


@router.post("/setup", status_code=status.HTTP_204_NO_CONTENT)
async def setup(body: SetupRequest, settings: SettingsDep) -> None:
    if not settings.setup_required:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Setup has already been completed.")
    if len(body.password) < MIN_PASSWORD_LENGTH:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT,
            f"Password must be at least {MIN_PASSWORD_LENGTH} characters.",
        )
    await asyncio.to_thread(
        perform_setup,
        settings,
        body.password,
        nova_api_key=body.nova_api_key,
        site_title=body.site_title,
    )


@router.post("/login", status_code=status.HTTP_204_NO_CONTENT)
async def login(
    body: LoginRequest, request: Request, response: Response, settings: SettingsDep
) -> None:
    if not settings.auth_ready:
        detail = "Set up the site first." if settings.setup_required else "The site is not configured."
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, detail)
    assert settings.password_hash and settings.session_secret
    limiter = get_limiter(request)
    wait = limiter.retry_after()
    if wait:
        raise HTTPException(
            status.HTTP_429_TOO_MANY_REQUESTS,
            f"Too many failed sign-ins. Try again in {wait} seconds.",
            headers={"Retry-After": str(wait)},
        )
    if not await asyncio.to_thread(verify_password, body.password, settings.password_hash):
        limiter.record_failure()
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Wrong password.")
    limiter.reset()
    response.set_cookie(
        COOKIE_NAME,
        issue_session(settings.session_secret, settings.password_hash),
        max_age=SESSION_TTL_SECONDS,
        path="/",
        httponly=True,
        samesite="lax",
        secure=settings.trust_proxy,
    )


@router.post("/logout", status_code=status.HTTP_204_NO_CONTENT)
async def logout(response: Response, settings: SettingsDep) -> None:
    response.delete_cookie(
        COOKIE_NAME, path="/", httponly=True, samesite="lax", secure=settings.trust_proxy
    )
```

Note: check the constant name for 422 in the installed Starlette (`status.HTTP_422_UNPROCESSABLE_CONTENT` in Starlette ≥ 0.47, `HTTP_422_UNPROCESSABLE_ENTITY` earlier) with `grep -n "422" backend/.venv/lib/python*/site-packages/starlette/status.py` and use the one that is not deprecated.

- [ ] **Step 5: Wire it in `backend/app/main.py`**

Add imports `import os` and `from .auth import MIN_PASSWORD_LENGTH, LoginLimiter, perform_setup`, and `from .api import auth, config, fonts, health, images`.

Signature and body changes:

```python
def create_app(
    settings: Settings | None = None,
    *,
    solver_factory: Callable[[], Solver | None] | None = None,
    poll_interval: float = 5.0,
    solve_timeout: float = 15 * 60,
    setup_password: str | None = None,
) -> FastAPI:
```

Inside `lifespan`, right after `cfg.ensure_dirs()`:

```python
        if setup_password is not None:
            _headless_setup(source, setup_password)
```

Add the helper below `create_app`:

```python
def _headless_setup(source: SettingsSource, password: str) -> None:
    """``ASTROCAPTION_PASSWORD``: complete first-run setup without the browser (SPEC § 11)."""
    current = source.current()
    if not current.setup_required:
        return
    if len(password) < MIN_PASSWORD_LENGTH:
        log.error(
            "ASTROCAPTION_PASSWORD ignored: shorter than %d characters; open /setup instead",
            MIN_PASSWORD_LENGTH,
        )
        return
    perform_setup(current, password)
    log.info("owner password set from ASTROCAPTION_PASSWORD")
```

After `app.state.worker = worker`: `app.state.login_limiter = LoginLimiter()`.
Include routers: `app.include_router(auth.router)` and `app.include_router(config.router)` next to the others.
Module bottom: `app = create_app(setup_password=os.environ.get("ASTROCAPTION_PASSWORD"))`.

- [ ] **Step 6: Run the whole backend suite**

Run: `cd backend && .venv/bin/pytest -q`
Expected: all passed, including Task 4's tests. If a test in `test_api.py`/`test_worker.py` fails with 401, that `with make_client(...)` block is missing `login(client)`.

- [ ] **Step 7: Lint and commit**

```bash
cd backend && .venv/bin/ruff check . && .venv/bin/ruff format . && .venv/bin/mypy
cd .. && git add backend
git commit -m "feat(api): first-run setup, login, logout and the owner session gate"
```

---

### Task 6: Frontend API client

**Files:**
- Modify: `frontend/package.json` (add `react-router`), `frontend/package-lock.json`
- Modify: `frontend/src/api.ts`
- Test: `frontend/src/api.test.ts`

**Interfaces:**
- Produces in `api.ts`: `HealthOut { status, version, site_title, setup_required, authenticated, config_error }`; `ConfigOut { site_title, max_upload_mb, nova_api_key_set, default_style: Record<string, unknown>, locked: string[] }`; `SetupRequest { password, nova_api_key?, site_title? }`; `api.setup(body)`, `api.login(password)`, `api.logout()`, `api.config()` (all `Promise<void>` except `config`); `setUnauthorizedHandler(fn: (() => void) | null)`; pure helper `isSessionLoss(url: string, status: number): boolean` (true for a 401 on any URL except `/api/login`); `describeError(err: unknown): string` moved here from `App.tsx` (component files should export only components).

- [ ] **Step 1: Install react-router**

Run: `cd frontend && npm install react-router@^8.3.1` — then `git diff --stat package.json package-lock.json` shows only that addition.

- [ ] **Step 2: Write the failing tests** (append to the `describe` in `frontend/src/api.test.ts`)

```ts
  it('treats a 401 as session loss everywhere except the login call', () => {
    expect(isSessionLoss('/api/images', 401)).toBe(true)
    expect(isSessionLoss('/api/config', 401)).toBe(true)
    expect(isSessionLoss('/api/login', 401)).toBe(false)
    expect(isSessionLoss('/api/images', 403)).toBe(false)
    expect(isSessionLoss('/api/images', 200)).toBe(false)
  })
```

and add `isSessionLoss` to the import line.

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd frontend && npm test --silent`
Expected: FAIL, `isSessionLoss` is not exported.

- [ ] **Step 4: Implement** in `frontend/src/api.ts`

Replace `HealthOut`:

```ts
export interface HealthOut {
  status: 'ok'
  version: string
  site_title: string
  setup_required: boolean
  authenticated: boolean
  config_error: string | null
}

export interface ConfigOut {
  site_title: string
  max_upload_mb: number
  nova_api_key_set: boolean
  default_style: Record<string, unknown>
  locked: string[]
}

export interface SetupRequest {
  password: string
  nova_api_key?: string
  site_title?: string
}
```

Replace `request` with:

```ts
let onUnauthorized: (() => void) | null = null

/** Called once per 401 outside the login call, so the shell can send the user to /login. */
export function setUnauthorizedHandler(fn: (() => void) | null): void {
  onUnauthorized = fn
}

export function isSessionLoss(url: string, status: number): boolean {
  return status === 401 && url !== '/api/login'
}

export function describeError(err: unknown): string {
  if (err instanceof ApiError) return err.message
  if (err instanceof Error) return err.message
  return 'Something went wrong.'
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init)
  if (isSessionLoss(url, res.status)) onUnauthorized?.()
  if (res.status === 204) return undefined as T
  return parseBody(res.status, res.ok, await res.text()) as T
}
```

Add to `api`:

```ts
  setup: (body: SetupRequest) => request<void>('/api/setup', json('POST', body)),
  login: (password: string) => request<void>('/api/login', json('POST', { password })),
  logout: () => request<void>('/api/logout', json('POST')),
  config: () => request<ConfigOut>('/api/config'),
```

Update the file's first comment to `// Typed client for the API. Mirrors backend/app/models.py.`

- [ ] **Step 5: Run tests and lint**

Run: `cd frontend && npm test --silent && npm run lint --silent`
Expected: tests pass; lint fails only in `App.tsx` on the removed `nova_api_key_set` field (fixed in Task 7). If it does, proceed to Task 7 and commit both tasks together with Task 7's message. Otherwise:

- [ ] **Step 6: Commit**

```bash
git add frontend/package.json frontend/package-lock.json frontend/src/api.ts frontend/src/api.test.ts
git commit -m "feat(frontend): auth calls, config type and react-router dependency"
```

---

### Task 7: Routes, guards, setup and login pages

**Files:**
- Create: `frontend/src/pages/ImagesPage.tsx`, `frontend/src/pages/SetupPage.tsx`, `frontend/src/pages/LoginPage.tsx`
- Modify: `frontend/src/App.tsx`, `frontend/src/main.tsx`, `frontend/src/styles.css`

**Interfaces:**
- Consumes: `api.health/setup/login/logout/config`, `setUnauthorizedHandler`, `HealthOut` (Task 6).
- Produces: `ImagesPage({ health }: { health: HealthOut })`, `SetupPage({ health, onDone })`, `LoginPage({ health, onDone })` where `onDone: () => Promise<void>` re-fetches health.

- [ ] **Step 1: Move the image list to `frontend/src/pages/ImagesPage.tsx`**

Move `POLL_MS`, `UploadPanel`, `ImageCard` and the body of today's `App` component from `App.tsx` into `ImagesPage.tsx` unchanged (`describeError` now comes from `./api`, see Task 6), except:

- the component is `export default function ImagesPage({ health }: { health: HealthOut })`;
- delete the `health` state, the initial `api.health()` fetch, and the `document.title` effect (the shell owns those);
- `refresh` fetches only `api.listImages()`;
- the two notices become:

```tsx
        {health.config_error && (
          <div className="notice error">
            <code>data/config.json</code> was ignored: {health.config_error}
          </div>
        )}
        {config && !config.nova_api_key_set && (
          <div className="notice">
            No nova.astrometry.net API key is configured. Set <code>NOVA_API_KEY</code> (or{' '}
            <code>nova_api_key</code> in <code>data/config.json</code>); no restart is needed, and
            solves fail until a key is present.
          </div>
        )}
```

with `const [config, setConfig] = useState<ConfigOut | null>(null)` loaded once in the mount effect via `api.config()` (errors ignored like the old health fetch). The page returns a fragment with the two notices, `<UploadPanel>`, the error line and the `<section className="images">`; the `<header>` and `<main>` wrappers stay in the shell.

- [ ] **Step 2: Write `SetupPage.tsx`**

```tsx
import { useState } from 'react'
import { Link, Navigate } from 'react-router'
import { api, describeError, type HealthOut } from '../api'

export default function SetupPage({ health, onDone }: { health: HealthOut; onDone: () => Promise<void> }) {
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [novaKey, setNovaKey] = useState('')
  const [siteTitle, setSiteTitle] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)

  if (done) return <Navigate to="/login" replace />
  if (!health.setup_required) {
    return (
      <section className="panel">
        <h2>Setup</h2>
        <p>
          {health.config_error
            ? 'This site cannot be set up until data/config.json is fixed or removed.'
            : 'This site is already set up.'}{' '}
          <Link to="/login">Sign in</Link>
        </p>
      </section>
    )
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (password !== confirm) {
      setError('The two passwords do not match.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      await api.setup({ password, nova_api_key: novaKey.trim() || undefined, site_title: siteTitle.trim() || undefined })
      setDone(true) // navigate first, so the refreshed health never renders the "already set up" branch
      await onDone()
    } catch (err) {
      setError(describeError(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="panel">
      <h2>Welcome</h2>
      <p className="meta">Choose the owner password. You can add the nova.astrometry.net key later.</p>
      <form className="auth" onSubmit={submit}>
        <label>
          Password (at least 8 characters)
          <input type="password" value={password} minLength={8} required autoComplete="new-password" onChange={(e) => setPassword(e.target.value)} />
        </label>
        <label>
          Password again
          <input type="password" value={confirm} required autoComplete="new-password" onChange={(e) => setConfirm(e.target.value)} />
        </label>
        <label>
          nova.astrometry.net API key (optional)
          <input type="text" value={novaKey} autoComplete="off" onChange={(e) => setNovaKey(e.target.value)} />
        </label>
        <label>
          Site title (optional)
          <input type="text" value={siteTitle} placeholder="AstroCaption" onChange={(e) => setSiteTitle(e.target.value)} />
        </label>
        {error && <p className="error">{error}</p>}
        <button type="submit" disabled={busy}>
          {busy ? 'Saving…' : 'Finish setup'}
        </button>
      </form>
    </section>
  )
}
```

- [ ] **Step 3: Write `LoginPage.tsx`**

```tsx
import { useState } from 'react'
import { Navigate } from 'react-router'
import { api, describeError, type HealthOut } from '../api'

export default function LoginPage({ health, onDone }: { health: HealthOut; onDone: () => Promise<void> }) {
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (health.setup_required) return <Navigate to="/setup" replace />
  if (health.authenticated) return <Navigate to="/" replace />

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await api.login(password)
      await onDone()
    } catch (err) {
      setError(describeError(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="panel">
      <h2>Sign in</h2>
      {health.config_error && (
        <div className="notice error">
          <code>data/config.json</code> cannot be read: {health.config_error}. Fix or remove the file, then reload.
        </div>
      )}
      <form className="auth" onSubmit={submit}>
        <label>
          Password
          <input type="password" value={password} required autoFocus autoComplete="current-password" onChange={(e) => setPassword(e.target.value)} />
        </label>
        {error && <p className="error">{error}</p>}
        <button type="submit" disabled={busy || !!health.config_error}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </section>
  )
}
```

- [ ] **Step 4: Rewrite `App.tsx` as the shell**

```tsx
import { useCallback, useEffect, useState } from 'react'
import { Navigate, Route, Routes, useNavigate } from 'react-router'
import { api, describeError, setUnauthorizedHandler, type HealthOut } from './api'
import ImagesPage from './pages/ImagesPage'
import LoginPage from './pages/LoginPage'
import SetupPage from './pages/SetupPage'

export default function App() {
  const [health, setHealth] = useState<HealthOut | null>(null)
  const [error, setError] = useState<string | null>(null)
  const navigate = useNavigate()

  const refreshHealth = useCallback(async () => {
    try {
      setHealth(await api.health())
      setError(null)
    } catch (err) {
      setError(describeError(err))
    }
  }, [])

  useEffect(() => {
    void refreshHealth()
  }, [refreshHealth])

  useEffect(() => {
    setUnauthorizedHandler(() => {
      setHealth((h) => (h ? { ...h, authenticated: false } : h))
      navigate('/login', { replace: true })
    })
    return () => setUnauthorizedHandler(null)
  }, [navigate])

  useEffect(() => {
    if (health?.site_title) document.title = health.site_title
  }, [health])

  async function logout() {
    try {
      await api.logout()
    } finally {
      await refreshHealth()
      navigate('/login', { replace: true })
    }
  }

  return (
    <>
      <header>
        <h1>{health?.site_title ?? 'AstroCaption'}</h1>
        {health && <span className="version">v{health.version}</span>}
        {health?.authenticated && (
          <nav>
            <button className="secondary" onClick={() => void logout()}>
              Log out
            </button>
          </nav>
        )}
      </header>
      <main>
        {error && <p className="error">{error}</p>}
        {health && (
          <Routes>
            <Route path="/setup" element={<SetupPage health={health} onDone={refreshHealth} />} />
            <Route path="/login" element={<LoginPage health={health} onDone={refreshHealth} />} />
            <Route path="/" element={<Guard health={health}><ImagesPage health={health} /></Guard>} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        )}
      </main>
    </>
  )
}

/** Owner-only routes: setup first, then sign-in, then the page. */
function Guard({ health, children }: { health: HealthOut; children: React.ReactNode }) {
  if (health.setup_required) return <Navigate to="/setup" replace />
  if (!health.authenticated) return <Navigate to="/login" replace />
  return children
}
```

- [ ] **Step 5: `main.tsx` and styles**

`main.tsx`: import `{ BrowserRouter } from 'react-router'` and wrap: `<ErrorBoundary><BrowserRouter><App /></BrowserRouter></ErrorBoundary>`.

Append to `styles.css`:

```css
header nav { margin-left: auto; }
form.auth { display: grid; gap: 0.75rem; max-width: 380px; }
form.auth label { display: grid; gap: 0.3rem; color: var(--muted); font-size: 0.9rem; }
input[type='password'] { background: var(--bg); color: var(--text); border: 1px solid var(--border); border-radius: 4px; padding: 0.4rem 0.6rem; }
form.auth button { justify-self: start; }
```

- [ ] **Step 6: Lint, test, and try it in the browser**

Run: `cd frontend && npm run lint --silent && npm test --silent`
Expected: clean.

The dev servers run as the systemd unit `astrocaption-dev` and reload on save. Verify in a browser (or with the Playwright MCP tools against `http://localhost:5173`):
1. With no `data/config.json` (move it aside if one exists: `mv data/config.json data/config.json.bak`), `/` redirects to `/setup`; a mismatched confirmation shows the message; a 7-character password is refused; a valid submit lands on `/login`.
2. A wrong password shows "Wrong password."; the right one lands on `/` with the image list and a **Log out** button; reload keeps the session.
3. Log out returns to `/login`; `/` bounces back to `/login`.
4. Deleting the cookie in devtools and clicking "Re-solve" or "Export" lands on `/login` (the 401 handler).
Restore `data/config.json.bak` afterwards if you moved one (its `password_hash` is still valid).

- [ ] **Step 7: Commit**

```bash
git add frontend
git commit -m "feat(frontend): setup and login pages behind react-router"
```

---

### Task 8: Docs, full verification, PR

**Files:**
- Modify: `docs/INSTALL.md`, `docs/ARCHITECTURE.md`

- [ ] **Step 1: INSTALL.md**

- Status line: `> Status: milestone 2. Upload, solve, export and the owner login work; the config page and the lockout CLI follow in this milestone.`
- After "Three commands", insert a **First run** section:

```markdown
## First run

The first visit to <http://localhost:8080> shows the setup page: choose the owner password
(at least 8 characters), optionally paste the nova API key and a site title. That writes
`data/config.json` (password hash, a random session secret, the key, the title) with owner-only
permissions and sends you to the sign-in page. Setup is closed from then on.

Headless installs set `ASTROCAPTION_PASSWORD` instead: on start, if no password has been set
yet, the app performs setup with it. The variable is read once, so you can remove it afterwards.
Passwords shorter than 8 characters are ignored with a log line.

Sign-ins are rate-limited (five wrong passwords → 60 seconds). Forgot the password: see
`docs/LOCKOUT.md` (arrives with the reset CLI in this milestone).
```

- Configuration table: add rows `| Owner password | setup page, or \`ASTROCAPTION_PASSWORD\` env at first start | required |` and `| Secure cookies | \`TRUST_PROXY=1\` env when the app is served over HTTPS by a proxy | off |`. Add a sentence under the table: values set by environment variables win over `config.json`; the config page (PR 2) shows them read-only.
- In the minimal `config.json` example, add a line before it: "Setup adds `password_hash` and `session_secret` to this file; leave those two alone."
- Replace `TRUST_PROXY=1 (secure cookies) becomes relevant with the login in milestone 2.` with `Set \`TRUST_PROXY=1\` in \`compose.yml\` once the proxy terminates HTTPS, so the session cookie is marked Secure.`

- [ ] **Step 2: ARCHITECTURE.md**

Title → `# Architecture (milestone 2)`. Add table rows:

```markdown
| `app/auth.py` | scrypt password hashes, stateless HMAC session tokens, login cooldown, first-run setup writer. Standard library only. |
| `app/api/deps.py` | Request-scoped dependencies; `require_owner` gates every owner router on the session cookie. |
| `app/api/auth.py` | `/api/setup`, `/api/login`, `/api/logout`. |
| `app/api/config.py` | Owner settings (`GET`; `PUT` with the config page). |
```

and one line under the diagram: `Every router except health carries the require_owner dependency; the cookie is validated per request against the secret and password hash in config.json, so a password reset logs everyone out.`

- [ ] **Step 3: Full verification**

Run: `make lint test`
Expected: ruff, mypy, eslint, tsc, pytest and vitest all clean. Then `make build` and confirm `docker image ls astrocaption:local` is under 400 MB, and that `docker run --rm -e ASTROCAPTION_PASSWORD=short astrocaption:local` logs the "ignored" line (Ctrl-C after the ready line).

- [ ] **Step 4: Commit and open the PR**

```bash
git add docs/INSTALL.md docs/ARCHITECTURE.md
git commit -m "docs: first-run setup, login and TRUST_PROXY in INSTALL and ARCHITECTURE"
git push -u origin feat/setup-and-login
gh pr create --title "feat: first-run setup, login and the owner session gate" --body "$(cat <<'EOF'
Milestone 2, PR 1 of 4. Implements SPEC § 5.1, § 8 (setup/login/logout, health/config split), § 10.

- scrypt password hashing (stdlib), stateless HMAC sessions bound to the password hash, global login cooldown
- `require_owner` on every owner router; `GET /api/health` is public-safe; `GET /api/config` takes over the owner fields
- `ASTROCAPTION_PASSWORD` headless setup, `TRUST_PROXY=1` secure cookie
- react-router with /setup, /login and the image list; 401s send the user to /login
- INSTALL.md first-run section

Config page (#8), reset-password CLI (LOCKOUT.md, README #6) and the Playwright smoke test (#11) follow in separate PRs.

🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_01LZ13YiDRbwh2oJSuC7qHQ6
EOF
)"
```

Then the review ritual from CLAUDE.md before merging: `/code-review high`, a silent-failure pass, `/simplify`, `make lint test`, and the owner's smoke test on `make dev`.
