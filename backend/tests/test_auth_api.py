from __future__ import annotations

import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.auth import LoginLimiter, hash_password
from app.config import update_config
from app.main import create_app
from tests.conftest import TEST_PASSWORD, login

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


def fresh_app_client(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, **env: str) -> TestClient:
    """An app reading a data dir with no config.json (setup required), config live."""
    data_dir = tmp_path / "data"
    data_dir.mkdir(exist_ok=True)
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
