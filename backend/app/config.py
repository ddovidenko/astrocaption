"""Runtime configuration.

Sources, in order of precedence: environment variables, then ``data/config.json``
(written by the setup flow in milestone 2), then built-in defaults. Secrets are
read here and nowhere else; nothing in this module is ever logged or returned by
an API endpoint.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
CONFIG_FILE_NAME = "config.json"
DEFAULT_MAX_UPLOAD_MB = 60
DEFAULT_SITE_TITLE = "AstroCaption"


@dataclass(frozen=True)
class Settings:
    data_dir: Path
    fonts_dir: Path
    static_dir: Path
    nova_api_key: str | None
    max_upload_mb: int
    site_title: str
    nova_base_url: str = "https://nova.astrometry.net"
    default_style: dict[str, object] = field(default_factory=dict)

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

    def ensure_dirs(self) -> None:
        self.uploads_dir.mkdir(parents=True, exist_ok=True)
        self.renders_dir.mkdir(parents=True, exist_ok=True)


def _read_config_file(path: Path) -> dict[str, object]:
    if not path.is_file():
        return {}
    try:
        loaded = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return loaded if isinstance(loaded, dict) else {}


def load_settings(env: dict[str, str] | None = None) -> Settings:
    """Build settings from the environment (default ``os.environ``) and ``config.json``."""
    e = os.environ if env is None else env
    data_dir = Path(e.get("ASTROCAPTION_DATA_DIR", str(REPO_ROOT / "data"))).resolve()
    fonts_dir = Path(e.get("ASTROCAPTION_FONTS_DIR", str(REPO_ROOT / "fonts"))).resolve()
    static_dir = Path(e.get("ASTROCAPTION_STATIC_DIR", str(REPO_ROOT / "backend" / "static")))
    cfg = _read_config_file(data_dir / CONFIG_FILE_NAME)

    key = e.get("NOVA_API_KEY") or e.get("ASTROMETRY_API_KEY") or cfg.get("nova_api_key")
    max_mb_raw = e.get("ASTROCAPTION_MAX_UPLOAD_MB") or cfg.get("max_upload_mb")
    try:
        max_mb = int(str(max_mb_raw)) if max_mb_raw else DEFAULT_MAX_UPLOAD_MB
    except (TypeError, ValueError):
        max_mb = DEFAULT_MAX_UPLOAD_MB
    title = e.get("ASTROCAPTION_SITE_TITLE") or cfg.get("site_title") or DEFAULT_SITE_TITLE
    raw_style = cfg.get("default_style")
    default_style = dict(raw_style) if isinstance(raw_style, dict) else {}

    return Settings(
        data_dir=data_dir,
        fonts_dir=fonts_dir,
        static_dir=static_dir.resolve(),
        nova_api_key=str(key).strip() if key else None,
        max_upload_mb=max(1, max_mb),
        site_title=str(title),
        nova_base_url=e.get("NOVA_BASE_URL", "https://nova.astrometry.net").rstrip("/"),
        default_style=default_style,
    )
