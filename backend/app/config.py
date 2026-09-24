"""Runtime configuration.

Sources, in order of precedence: environment variables, then ``data/config.json`` (written by
the setup flow and the config page), then built-in defaults. Environment-derived values (the
paths, the nova base URL, the two solve knobs) are fixed for the life of the process;
everything in config.json is live: ``SettingsSource`` re-reads the file whenever its size or
mtime changes. Secrets are read here and nowhere else; nothing in this module is ever logged
or returned by an API endpoint.
"""

from __future__ import annotations

import errno
import fcntl
import json
import logging
import math
import os
import tempfile
from collections.abc import Callable, Iterator, Mapping
from contextlib import contextmanager
from dataclasses import dataclass, field
from pathlib import Path

from pydantic import ValidationError

from .models import MAX_UPLOAD_MB, MIN_UPLOAD_MB, StyleOverrides, validation_message

log = logging.getLogger(__name__)

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
CONFIG_FILE_NAME = "config.json"
DEFAULT_MAX_UPLOAD_MB = 60
DEFAULT_SITE_TITLE = "AstroCaption"
DEFAULT_NOVA_BASE_URL = "https://nova.astrometry.net"
# The solve queue's two timings. They live here (rather than in worker.py, which imports this
# module) so that the env parsing below has one home; ``SolveWorker`` imports them back.
DEFAULT_POLL_SECONDS = 5.0
DEFAULT_SOLVE_TIMEOUT_SECONDS = 15.0 * 60

LOCKABLE: dict[str, tuple[str, ...]] = {
    "nova_api_key": ("NOVA_API_KEY", "ASTROMETRY_API_KEY"),
    "max_upload_mb": ("ASTROCAPTION_MAX_UPLOAD_MB",),
    "site_title": ("ASTROCAPTION_SITE_TITLE",),
    "public_gallery_enabled": ("ASTROCAPTION_PUBLIC_GALLERY",),
}
"""Env vars that pin each lockable config.json field (read-only in the UI when one is set).

The keys are exactly the fields ``load_settings`` may report in ``locked_by``; the values are
tried in order, so the first one set wins and is the name reported in ``locked_by``.
"""

DISK_FULL_ERRNOS = frozenset({errno.ENOSPC, errno.EDQUOT})


def write_failure_message(subject: str, *, disk_full: bool) -> str:
    """What the owner is told when ``subject`` could not be written to ./data (API and CLI)."""
    if disk_full:
        return (
            f"{subject} could not be saved: the disk holding ./data is full. "
            "Free some space and try again."
        )
    return (
        f"{subject} could not be saved: the server could not write to ./data. "
        "The server log says why."
    )


CONFIG_FIX_HINT = "fix it, or remove it and run setup again (removing it resets the owner password)"
"""How every ``config_error`` sentence ends: what the owner can actually do about it."""

CONFIG_UNREADABLE = f"config.json could not be read; {CONFIG_FIX_HINT}"
CONFIG_NOT_JSON = f"config.json is not valid JSON; {CONFIG_FIX_HINT}"
CONFIG_NOT_OBJECT = f"config.json must contain a JSON object; {CONFIG_FIX_HINT}"


class ConfigError(ValueError):
    """config.json exists but cannot be used.

    ``public`` is the fixed sentence users are shown (SPEC § 5.1 step 7: no server paths,
    no exception text); ``detail`` carries the reason, for the server log only.
    """

    def __init__(self, public: str, detail: str | None = None) -> None:
        detail = detail or public
        super().__init__(detail)
        self.public = public
        self.detail = detail


@dataclass(frozen=True)
class Settings:
    data_dir: Path
    fonts_dir: Path
    static_dir: Path
    nova_api_key: str | None = field(repr=False)
    max_upload_mb: int
    site_title: str
    public_gallery_enabled: bool = True  # SPEC § 5.5: the logged-out gallery can be switched off
    nova_base_url: str = DEFAULT_NOVA_BASE_URL
    # The two solve knobs are process-level: read once at start from the environment, never
    # lockable and never on the config page (changing them means restarting the app).
    solve_poll_seconds: float = DEFAULT_POLL_SECONDS
    solve_timeout_seconds: float = DEFAULT_SOLVE_TIMEOUT_SECONDS
    default_style: dict[str, object] = field(default_factory=dict)
    config_error: str | None = None  # why config.json was ignored, if it was
    password_hash: str | None = field(default=None, repr=False)
    session_secret: str | None = field(default=None, repr=False)
    trust_proxy: bool = False
    locked_by: dict[str, str] = field(default_factory=dict)  # locked field -> the variable name

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
        """No usable owner credentials yet (SPEC § 5.1).

        A corrupt config.json is *not* setup-required: setup stays closed until the owner
        fixes the file. A half-written one (a hash without a secret, or the reverse) is:
        it cannot authenticate anybody, and setup writes both halves fresh.
        """
        return self.config_error is None and (
            self.password_hash is None or self.session_secret is None
        )

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
        raise ConfigError(CONFIG_UNREADABLE, f"{path}: {exc.strerror or exc}") from exc
    except ValueError as exc:
        raise ConfigError(CONFIG_NOT_JSON, f"{path}: {exc}") from exc
    if not isinstance(loaded, dict):
        raise ConfigError(CONFIG_NOT_OBJECT, f"{path}: top level is {type(loaded).__name__}")
    return loaded


def _from_env(e: Mapping[str, str], name: str) -> tuple[str | None, str | None]:
    """The value pinning ``name``, and the variable it came from; ``(None, None)`` when free."""
    for var in LOCKABLE[name]:
        value = e.get(var)
        if value:
            return value, var
    return None, None


def _upload_mb(raw: object) -> int:
    """config.json's (or the env's) upload limit, clamped to what the API would accept."""
    try:
        value = int(str(raw)) if raw else DEFAULT_MAX_UPLOAD_MB
    except (TypeError, ValueError):
        log.warning("ignoring max_upload_mb: not a whole number; using %d", DEFAULT_MAX_UPLOAD_MB)
        return DEFAULT_MAX_UPLOAD_MB
    clamped = max(MIN_UPLOAD_MB, min(MAX_UPLOAD_MB, value))
    if clamped != value:
        log.warning(
            "max_upload_mb %d is outside %d-%d; using %d",
            value,
            MIN_UPLOAD_MB,
            MAX_UPLOAD_MB,
            clamped,
        )
    return clamped


_FLAG_WORDS = {
    "1": True,
    "true": True,
    "yes": True,
    "on": True,
    "0": False,
    "false": False,
    "no": False,
    "off": False,
}


def _flag_from_env(raw: str, var: str) -> bool:
    """``public_gallery_enabled`` from an environment variable's flag word (1/true/yes/on,
    0/false/no/off, case-insensitive); anything else is logged and treated as on.

    ``var`` names the variable for the log line; the value itself is never logged
    (CLAUDE.md: reasons only)."""
    word = raw.strip().lower()
    if word in _FLAG_WORDS:
        return _FLAG_WORDS[word]
    log.warning("ignoring %s: not true/false; the public gallery stays on", var)
    return True


def _flag_from_config(raw: object) -> bool:
    """``public_gallery_enabled`` from config.json: unset means on, a JSON boolean is taken as
    is, anything else is logged and treated as on."""
    if raw is None:
        return True
    if isinstance(raw, bool):
        return raw
    log.warning(
        "ignoring public_gallery_enabled in config.json: not true/false; the public gallery"
        " stays on"
    )
    return True


def _positive_seconds(raw: object, *, default: float, name: str, lo: float, hi: float) -> float:
    """A number of seconds from the environment, bounded by ``lo``-``hi``.

    Unset or blank falls back to ``default`` silently (not configured); anything that is not a
    finite number in range falls back with one warning line naming the variable and the bounds
    (misconfigured). The value itself is never echoed, like every other line in this module.
    """
    text = str(raw).strip() if raw is not None else ""
    if not text:
        return default
    try:
        value = float(text)
    except ValueError:
        value = math.nan
    if not math.isfinite(value) or not lo <= value <= hi:
        log.warning(
            "%s is not a number of seconds between %g and %g; using %g", name, lo, hi, default
        )
        return default
    return value


def _first_message(exc: ValidationError) -> str:
    """Pydantic's reason for a rejected field, without the value it rejected."""
    return "; ".join(validation_message(e) for e in exc.errors()) or "is not valid"


def _normalise_style(raw: object) -> dict[str, object]:
    """config.json's ``default_style``, as the same overrides ``PUT /api/config`` would store.

    Best effort: a file the page cannot represent should not cost the owner the fields that
    are fine, so a whole-object failure is retried field by field and only the bad ones (and
    fields the model does not know) are dropped, each with a log line naming the field.
    """
    if not isinstance(raw, Mapping):
        if raw is not None:
            log.warning("ignoring default_style in config.json: not a JSON object")
        return {}
    fields = {str(k): v for k, v in raw.items()}
    try:
        return StyleOverrides.model_validate(fields).overrides()
    except ValidationError:
        pass  # one bad field must not drop the good ones; find out which below
    kept: dict[str, object] = {}
    for name, value in fields.items():
        try:
            kept.update(StyleOverrides.model_validate({name: value}).overrides())
        except ValidationError as exc:  # the reason only, never the value (CLAUDE.md)
            log.warning("ignoring default_style.%s in config.json: %s", name, _first_message(exc))
    return kept  # every value here already passed the model; there are no cross-field rules


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
            config_error = exc.public  # what the API may show; the reason stays in the log
            log.warning("ignoring config.json: %s", exc.detail)

    from_env = {name: _from_env(e, name) for name in LOCKABLE}
    locked_by = {name: var for name, (_, var) in from_env.items() if var is not None}

    key = from_env["nova_api_key"][0] or cfg.get("nova_api_key")
    max_mb = _upload_mb(from_env["max_upload_mb"][0] or cfg.get("max_upload_mb"))
    title = from_env["site_title"][0] or cfg.get("site_title") or DEFAULT_SITE_TITLE
    gallery_env, gallery_var = from_env["public_gallery_enabled"]
    gallery_on = (
        _flag_from_env(gallery_env, gallery_var or "ASTROCAPTION_PUBLIC_GALLERY")
        if gallery_env is not None
        else _flag_from_config(cfg.get("public_gallery_enabled"))
    )
    default_style = _normalise_style(cfg.get("default_style"))
    poll_seconds = _positive_seconds(
        e.get("ASTROCAPTION_SOLVE_POLL_SECONDS"),
        default=DEFAULT_POLL_SECONDS,
        name="ASTROCAPTION_SOLVE_POLL_SECONDS",
        lo=0.1,
        hi=3600,
    )
    solve_timeout = _positive_seconds(
        e.get("ASTROCAPTION_SOLVE_TIMEOUT_SECONDS"),
        default=DEFAULT_SOLVE_TIMEOUT_SECONDS,
        name="ASTROCAPTION_SOLVE_TIMEOUT_SECONDS",
        lo=1,
        hi=86400,
    )
    raw_hash = cfg.get("password_hash")
    raw_secret = cfg.get("session_secret")
    password_hash = raw_hash if isinstance(raw_hash, str) and raw_hash else None
    session_secret = raw_secret if isinstance(raw_secret, str) and raw_secret else None
    if config_error is None and (password_hash is None) != (session_secret is None):
        log.warning(
            "config.json has a password_hash but no session_secret (or vice versa); "
            "setup will run again"
        )

    return Settings(
        data_dir=data_dir,
        fonts_dir=fonts_dir,
        static_dir=static_dir.resolve(),
        nova_api_key=str(key).strip() if key else None,
        max_upload_mb=max_mb,
        site_title=str(title),
        public_gallery_enabled=gallery_on,
        nova_base_url=e.get("NOVA_BASE_URL", DEFAULT_NOVA_BASE_URL).rstrip("/"),
        solve_poll_seconds=poll_seconds,
        solve_timeout_seconds=solve_timeout,
        default_style=default_style,
        config_error=config_error,
        password_hash=password_hash,
        session_secret=session_secret,
        trust_proxy=e.get("TRUST_PROXY", "").strip().lower() in {"1", "true", "yes"},
        locked_by=locked_by,
    )


def _file_stamp(path: Path) -> tuple[int, int, int] | None:
    """What "the file changed" means here: mtime, size *and* inode.

    ``update_config`` publishes every write with ``os.replace``, so the inode is new each
    time. A password reset (a fixed-length hash swapped for another, in the same second on a
    coarse-mtime filesystem) is therefore always noticed, and the app logs the browsers out
    without a restart.
    """
    try:
        st = path.stat()
    except OSError:
        return None
    return st.st_mtime_ns, st.st_size, st.st_ino


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

    def reload(self) -> Settings:
        """Re-read config.json now, whatever the stamp says (after the app itself wrote it)."""
        if self._fixed is not None:
            return self._fixed
        # Stamp first, like current(): a write that lands mid-load is then picked up by the
        # next current() instead of being hidden behind a stamp taken after it.
        stamp = _file_stamp(self._current.config_path)
        self._current = load_settings(self._env)
        self._stamp = stamp
        return self._current


def write_and_reload[T](source: SettingsSource, write: Callable[[], T]) -> tuple[T, Settings]:
    """Run ``write``, then re-read config.json, and hand back both results.

    One thread hop for the pair (both halves block on the filesystem), and the caller gets
    what the write itself produced as well as what the file says afterwards - which are not
    always the same thing, because another process may write between the two.
    """
    written = write()
    return written, source.reload()


@contextmanager
def _config_write_lock(path: Path) -> Iterator[None]:
    """Hold ``config.json.lock`` exclusively while config.json is read and rewritten.

    The app's own writers share an asyncio lock, but the CLI (``app.cli reset-password``)
    is a second process on the same file: without this, its read-modify-write could
    interleave with the config page's and drop one of the two changes. The lock file is
    only a handle for ``flock`` - it stays empty, and a leftover one is harmless.
    """
    fd = os.open(path.with_suffix(".json.lock"), os.O_WRONLY | os.O_CREAT, 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX)
        yield
    finally:
        os.close(fd)  # releases the lock


def update_config(path: Path, updates: Mapping[str, object | None]) -> None:
    """Merge ``updates`` into config.json atomically. ``None`` removes a key.

    The file is published with ``os.replace``, so the process that writes becomes its owner:
    a root run leaves a file the app's own user cannot read (the CLI refuses that case).

    Written as a private file (0600): it holds the password hash and the session secret.
    A file that cannot be parsed is left untouched and reported, never replaced. Parse,
    write and rename happen under a cross-process lock, so two writers never lose an update.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    with _config_write_lock(path):
        current: dict[str, object] = _parse_config(path) if path.is_file() else {}
        for key, value in updates.items():
            if value is None:
                current.pop(key, None)
            else:
                current[key] = value
        # A unique temp name, not a fixed one: two writers (and a crashed earlier run)
        # must never share the half-written file that is about to be published.
        fd, tmp_name = tempfile.mkstemp(dir=path.parent, prefix=".config-", suffix=".tmp")
        tmp = Path(tmp_name)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as fh:
                json.dump(current, fh, indent=2)
                fh.write("\n")
                fh.flush()
                os.fsync(fh.fileno())  # the bytes, before the rename that publishes them
            os.replace(tmp, path)
        except BaseException:
            tmp.unlink(missing_ok=True)
            raise
        _fsync_dir(path.parent)  # and the rename itself, or a crash can lose the whole file
        try:
            os.chmod(path, 0o600)
        except OSError:
            log.warning("could not restrict permissions on %s", path.name)


def _fsync_dir(directory: Path) -> None:
    """Best effort: some filesystems (and Windows) refuse to fsync a directory."""
    try:
        fd = os.open(directory, os.O_RDONLY)
    except OSError:
        return
    try:
        os.fsync(fd)
    except OSError:
        pass
    finally:
        os.close(fd)
