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

from app.config import REPO_ROOT, Settings
from app.db import Database
from app.main import create_app
from app.models import Calibration, ImageRecord, utcnow_iso
from app.solver import JobState, Solver, SolveRequest, SolverError, SolveResult
from app.storage import image_dir, make_derivatives
from app.worker import SolveWorker

FONTS_DIR = REPO_ROOT / "fonts"
NOVA_FIXTURES = Path(__file__).parent / "fixtures" / "nova"


def load_fixture(name: str) -> Any:
    return json.loads((NOVA_FIXTURES / name).read_text(encoding="utf-8"))


def nova_result() -> SolveResult:
    return SolveResult(
        annotations=load_fixture("annotations.json")["annotations"],
        wcs_text=(NOVA_FIXTURES / "wcs.fits").read_text(encoding="ascii"),
        calibration=Calibration.model_validate(load_fixture("job_info.json")["calibration"]),
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


@pytest.fixture
def client(settings: Settings, fake_solver: FakeSolver) -> Iterator[TestClient]:
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


@pytest.fixture
def env_client(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> Iterator[tuple[TestClient, Path]]:
    """An app configured from the environment, so config.json in ``data_dir`` is live."""
    data_dir = tmp_path / "data"
    data_dir.mkdir()
    monkeypatch.setenv("ASTROCAPTION_DATA_DIR", str(data_dir))
    monkeypatch.delenv("NOVA_API_KEY", raising=False)
    monkeypatch.delenv("ASTROMETRY_API_KEY", raising=False)
    app = create_app(solver_factory=lambda: None, poll_interval=0.01)
    with TestClient(app) as client:
        yield client, data_dir
