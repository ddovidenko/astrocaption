"""Runtime configuration.

Sources, in order of precedence: environment variables, then ``data/config.json`` (written by
the setup flow and the config page), then built-in defaults. Environment-derived values (the
paths, the nova base URL) are fixed for the life of the process; everything in config.json is
live: ``SettingsSource`` re-reads the file whenever its size or mtime changes. Secrets are
read here and nowhere else; nothing in this module is ever logged or returned by an API
endpoint.
"""

from __future__ import annotations

import json
import logging
import os
from collections.abc import Mapping
from dataclasses import dataclass, field
from pathlib import Path

log = logging.getLogger(__name__)

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
CONFIG_FILE_NAME = "config.json"
DEFAULT_MAX_UPLOAD_MB = 60
DEFAULT_SITE_TITLE = "AstroCaption"
DEFAULT_NOVA_BASE_URL = "https://nova.astrometry.net"


class ConfigError(ValueError):
    """config.json exists but cannot be used."""


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

    @property
    def uploads_dir(self) -> Path:
        return self.data_dir / "uploads"

    @property
    def renders_dir(self) -> Path:
        return self.data_dir / "renders"

    @property
    def db_path(self) -> Path:
        return self.data_dir / "astrocaption.sqlite"

    @property
    def config_path(self) -> Path:
        return self.data_dir / CONFIG_FILE_NAME

    @property
    def nova_api_key_set(self) -> bool:
        return bool(self.nova_api_key)

    @property
    def setup_required(self) -> bool:
        """No owner password yet. A corrupt config.json is *not* setup-required (SPEC § 5.1)."""
        return self.password_hash is None and self.config_error is None

    @property
    def auth_ready(self) -> bool:
        return bool(self.password_hash and self.session_secret)

    def ensure_dirs(self) -> None:
        self.uploads_dir.mkdir(parents=True, exist_ok=True)
        self.renders_dir.mkdir(parents=True, exist_ok=True)


def _parse_config(path: Path) -> dict[str, object]:
    try:
        loaded = json.loads(path.read_text(encoding="utf-8"))
    except OSError as exc:
        raise ConfigError(f"{path.name} could not be read: {exc.strerror or exc}") from exc
    except ValueError as exc:
        raise ConfigError(f"{path.name} is not valid JSON: {exc}") from exc
    if not isinstance(loaded, dict):
        raise ConfigError(f"{path.name} must contain a JSON object")
    return loaded


def load_settings(env: Mapping[str, str] | None = None) -> Settings:
    """Build settings from the environment (default ``os.environ``) and ``config.json``."""
    e = os.environ if env is None else env
    data_dir = Path(e.get("ASTROCAPTION_DATA_DIR", str(REPO_ROOT / "data"))).resolve()
    fonts_dir = Path(e.get("ASTROCAPTION_FONTS_DIR", str(REPO_ROOT / "fonts"))).resolve()
    static_dir = Path(e.get("ASTROCAPTION_STATIC_DIR", str(REPO_ROOT / "backend" / "static")))

    cfg: dict[str, object] = {}
    config_error: str | None = None
    config_path = data_dir / CONFIG_FILE_NAME
    if config_path.is_file():
        try:
            cfg = _parse_config(config_path)
        except ConfigError as exc:
            config_error = str(exc)
            log.warning("ignoring %s: %s", config_path, exc)

    key = e.get("NOVA_API_KEY") or e.get("ASTROMETRY_API_KEY") or cfg.get("nova_api_key")
    max_mb_raw = e.get("ASTROCAPTION_MAX_UPLOAD_MB") or cfg.get("max_upload_mb")
    try:
        max_mb = int(str(max_mb_raw)) if max_mb_raw else DEFAULT_MAX_UPLOAD_MB
    except (TypeError, ValueError):
        max_mb = DEFAULT_MAX_UPLOAD_MB
    title = e.get("ASTROCAPTION_SITE_TITLE") or cfg.get("site_title") or DEFAULT_SITE_TITLE
    raw_style = cfg.get("default_style")
    default_style = dict(raw_style) if isinstance(raw_style, dict) else {}

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

    return Settings(
        data_dir=data_dir,
        fonts_dir=fonts_dir,
        static_dir=static_dir.resolve(),
        nova_api_key=str(key).strip() if key else None,
        max_upload_mb=max(1, max_mb),
        site_title=str(title),
        nova_base_url=e.get("NOVA_BASE_URL", DEFAULT_NOVA_BASE_URL).rstrip("/"),
        default_style=default_style,
        config_error=config_error,
        password_hash=password_hash if isinstance(password_hash, str) and password_hash else None,
        session_secret=session_secret
        if isinstance(session_secret, str) and session_secret
        else None,
        trust_proxy=e.get("TRUST_PROXY", "").strip().lower() in {"1", "true", "yes"},
        env_locked=env_locked,
    )


def _file_stamp(path: Path) -> tuple[int, int] | None:
    try:
        st = path.stat()
    except OSError:
        return None
    return st.st_mtime_ns, st.st_size


class SettingsSource:
    """Hands out the current ``Settings``, re-reading config.json only when the file changed.

    Built from an explicit ``Settings`` (tests, embedding) it never reloads.
    """

    def __init__(self, fixed: Settings | None = None, env: Mapping[str, str] | None = None) -> None:
        self._fixed = fixed
        self._env = env
        self._current = fixed if fixed is not None else load_settings(env)
        self._stamp = None if fixed is not None else _file_stamp(self._current.config_path)

    def current(self) -> Settings:
        if self._fixed is not None:
            return self._fixed
        stamp = _file_stamp(self._current.config_path)
        if stamp != self._stamp:
            self._stamp = stamp
            self._current = load_settings(self._env)
        return self._current


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
