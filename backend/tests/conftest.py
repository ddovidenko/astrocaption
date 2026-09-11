from __future__ import annotations

import json
import random
import time
from collections.abc import Callable, Iterator
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient
from PIL import Image, ImageDraw

from app.auth import hash_password
from app.config import REPO_ROOT, Settings
from app.db import Database
from app.main import create_app
from app.models import Calibration, ImageRecord, utcnow_iso
from app.solver import JobState, Solver, SolveRequest, SolverError, SolveResult
from app.storage import image_dir, make_derivatives
from app.worker import SolveWorker

FONTS_DIR = REPO_ROOT / "fonts"
NOVA_FIXTURES = Path(__file__).parent / "fixtures" / "nova"  # 3.9° Orion field, no hd
NOVA_NARROW_FIXTURES = Path(__file__).parent / "fixtures" / "nova-narrow"  # 1° Pelican, hd

TEST_PASSWORD = "correct horse battery"
TEST_PASSWORD_HASH = hash_password(TEST_PASSWORD)  # once per session; scrypt is deliberately slow
TEST_SESSION_SECRET = "test-session-secret"


def load_fixture(name: str, fixtures_dir: Path = NOVA_FIXTURES) -> Any:
    return json.loads((fixtures_dir / name).read_text(encoding="utf-8"))


def nova_result(fixtures_dir: Path = NOVA_FIXTURES) -> SolveResult:
    return SolveResult(
        annotations=load_fixture("annotations.json", fixtures_dir)["annotations"],
        wcs_text=(fixtures_dir / "wcs.fits").read_text(encoding="ascii"),
        calibration=Calibration.model_validate(
            load_fixture("job_info.json", fixtures_dir)["calibration"]
        ),
    )


def make_settings(tmp_path: Path, **overrides: Any) -> Settings:
    values: dict[str, Any] = {
        "data_dir": tmp_path / "data",
        "fonts_dir": FONTS_DIR,
        "static_dir": tmp_path / "no-static",
        "nova_api_key": None,
        "max_upload_mb": 5,
        "site_title": "Test Site",
        "nova_base_url": "https://nova.example.test",
        "default_style": {},
        "password_hash": TEST_PASSWORD_HASH,
        "session_secret": TEST_SESSION_SECRET,
    }
    values.update(overrides)
    return Settings(**values)


@pytest.fixture
def settings(tmp_path: Path) -> Settings:
    return make_settings(tmp_path)


def write_test_image(
    path: Path, width: int = 3000, height: int = 2000, fmt: str = "JPEG", **save_kwargs: Any
) -> Path:
    """A dark frame with deterministic 'stars' so JPEG output is realistic but small."""
    img = Image.new("RGB", (width, height), (8, 10, 20))
    draw = ImageDraw.Draw(img)
    rng = random.Random(7)
    for _ in range(400):
        x, y = rng.uniform(0, width), rng.uniform(0, height)
        r = rng.uniform(1, 4) * width / 3000
        draw.ellipse([x - r, y - r, x + r, y + r], fill=(230, 230, 255))
    path.parent.mkdir(parents=True, exist_ok=True)
    img.save(path, fmt, **save_kwargs)
    return path


@pytest.fixture
def sample_jpeg(tmp_path: Path) -> Path:
    return write_test_image(tmp_path / "orion.jpg")


class FakeSolver:
    """In-memory Solver that replays the recorded nova result without any HTTP."""

    def __init__(
        self,
        result: SolveResult | None = None,
        *,
        fail: bool = False,
        submission_polls: int = 1,
        job_polls: int = 1,
        submit_error: SolverError | None = None,
    ) -> None:
        self.result = result or nova_result()
        self.fail = fail
        self.submission_polls = submission_polls
        self.job_polls = job_polls
        self.submit_error = submit_error
        self.requests: list[SolveRequest] = []
        self.submission_poll_count = 0
        self.job_poll_count = 0

    async def submit(self, request: SolveRequest) -> int:
        self.requests.append(request)
        if self.submit_error is not None:
            raise self.submit_error
        return 12345678

    async def poll_submission(self, submission_id: int) -> int | None:
        self.submission_poll_count += 1
        return 7654321 if self.submission_poll_count >= self.submission_polls else None

    async def poll_job(self, job_id: int) -> JobState:
        self.job_poll_count += 1
        if self.job_poll_count < self.job_polls:
            return JobState.SOLVING
        return JobState.FAILURE if self.fail else JobState.SUCCESS

    async def fetch_result(self, submission_id: int, job_id: int) -> SolveResult:
        return self.result


@pytest.fixture
def fake_solver() -> FakeSolver:
    return FakeSolver()


def make_client(settings: Settings, solver_factory: Callable[[], Solver | None]) -> TestClient:
    app = create_app(settings, solver_factory=solver_factory, poll_interval=0.01, solve_timeout=10)
    return TestClient(app)


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


def upload(client: TestClient, path: Path, title: str | None = None) -> dict[str, Any]:
    with path.open("rb") as fh:
        data = {"title": title} if title else {}
        resp = client.post("/api/images", files={"file": (path.name, fh, "image/jpeg")}, data=data)
    assert resp.status_code == 201, resp.text
    body: dict[str, Any] = resp.json()
    return body


def wait_for_status(
    client: TestClient, image_id: str, statuses: set[str], timeout: float = 15.0
) -> dict[str, Any]:
    deadline = time.monotonic() + timeout
    while True:
        resp = client.get(f"/api/images/{image_id}")
        assert resp.status_code == 200, resp.text
        body: dict[str, Any] = resp.json()
        if body["solve_status"] in statuses:
            return body
        if time.monotonic() > deadline:
            raise AssertionError(f"timed out waiting for {statuses}; last {body}")
        time.sleep(0.02)


def seed_image(
    settings: Settings, db: Database, image_id: str = "img-1", width: int = 3000
) -> ImageRecord:
    """An uploaded-but-unsolved image on disk and in the database."""
    settings.ensure_dirs()
    db.init()
    directory = image_dir(settings, image_id)
    original = write_test_image(directory / "original.jpg", width, width * 2 // 3)
    preview, thumb = make_derivatives(original, directory)
    now = utcnow_iso()
    rec = ImageRecord(
        id=image_id,
        created_at=now,
        updated_at=now,
        title="Orion",
        original_name="orion.jpg",
        original_path=original.relative_to(settings.data_dir).as_posix(),
        preview_path=preview.relative_to(settings.data_dir).as_posix(),
        thumb_path=thumb.relative_to(settings.data_dir).as_posix(),
        width=width,
        height=width * 2 // 3,
    )
    db.insert_image(rec)
    return rec


def make_worker(
    settings: Settings, db: Database, solver: Solver | None, **kwargs: Any
) -> SolveWorker:
    kwargs.setdefault("poll_interval", 0.001)
    kwargs.setdefault("timeout", 5)
    return SolveWorker(db, settings, lambda: solver, **kwargs)


ENV_ISOLATED = (
    "NOVA_API_KEY",
    "ASTROMETRY_API_KEY",
    "ASTROCAPTION_SITE_TITLE",
    "ASTROCAPTION_MAX_UPLOAD_MB",
    "TRUST_PROXY",
)


def env_for(tmp_path: Path, **extra: str) -> dict[str, str]:
    """Settings environment for a scratch data dir (``load_settings(env_for(tmp_path))``)."""
    return {
        "ASTROCAPTION_DATA_DIR": str(tmp_path),
        "ASTROCAPTION_FONTS_DIR": str(FONTS_DIR),
        **extra,
    }


def read_config(path: Path) -> dict[str, object]:
    data: dict[str, object] = json.loads(path.read_text(encoding="utf-8"))
    return data


def seed_owner(tmp_path: Path, **extra: object) -> Path:
    """A config.json whose owner password is TEST_PASSWORD, written directly with the cached
    hash (scrypt is deliberately slow) rather than through setup."""
    path = tmp_path / "config.json"
    path.write_text(
        json.dumps(
            {"password_hash": TEST_PASSWORD_HASH, "session_secret": TEST_SESSION_SECRET, **extra}
        ),
        encoding="utf-8",
    )
    path.chmod(0o600)
    return path


def env_app_client(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, **env: str) -> TestClient:
    """An app configured from the environment, so config.json in ``tmp_path/data`` is live.

    Starts with no config.json (setup required). The developer's own shell variables are
    cleared so every test sees the same environment; ``env`` sets the ones a test needs.
    """
    data_dir = tmp_path / "data"
    data_dir.mkdir(exist_ok=True)
    monkeypatch.setenv("ASTROCAPTION_DATA_DIR", str(data_dir))
    for name in ENV_ISOLATED:
        monkeypatch.delenv(name, raising=False)
    for name, value in env.items():
        monkeypatch.setenv(name, value)
    app = create_app(
        solver_factory=lambda: None,
        poll_interval=0.01,
        setup_password=env.get("ASTROCAPTION_PASSWORD"),
    )
    return TestClient(app)


@pytest.fixture
def env_client(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> Iterator[tuple[TestClient, Path]]:
    with env_app_client(tmp_path, monkeypatch) as client:
        yield client, tmp_path / "data"
