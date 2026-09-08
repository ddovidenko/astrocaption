from __future__ import annotations

import json
import re
from collections.abc import Iterable, Iterator
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from starlette.routing import BaseRoute

from app.auth import LoginLimiter, hash_password
from app.config import update_config
from app.main import create_app
from tests.conftest import TEST_PASSWORD, login

# Routes that must stay reachable while logged out: health for the Docker healthcheck,
# setup/login/logout because a session cookie is exactly what they exist to obtain.
PUBLIC_API_ROUTES = {"/api/health", "/api/setup", "/api/login", "/api/logout"}


def _flatten_routes(routes: Iterable[BaseRoute]) -> Iterator[BaseRoute]:
    """FastAPI wraps ``include_router`` results in an internal router-of-routers; unwrap it."""
    for route in routes:
        original_router = getattr(route, "original_router", None)
        if original_router is not None:
            yield from _flatten_routes(original_router.routes)
        else:
            yield route


def owner_routes(app: FastAPI) -> list[tuple[str, str]]:
    """Every (method, path) under ``/api`` except the public allowlist, derived from the
    live app so a newly added route is covered automatically instead of relying on a
    hand-maintained list."""
    found: list[tuple[str, str]] = []
    for route in _flatten_routes(app.routes):
        path = getattr(route, "path", None)
        methods = getattr(route, "methods", None)
        if not path or not methods or not path.startswith("/api/"):
            continue
        if path in PUBLIC_API_ROUTES:
            continue
        concrete_path = re.sub(r"\{[^/}]+\}", "x", path)
        for method in sorted(methods - {"HEAD"}):
            found.append((method, concrete_path))
    return found


def test_owner_routes_need_a_session(anon_client: TestClient) -> None:
    routes = owner_routes(anon_client.app)  # type: ignore[arg-type]
    assert routes  # the derivation itself must find something, or this test proves nothing
    assert ("GET", "/api/docs") in routes
    assert ("GET", "/api/openapi.json") in routes
    for method, path in routes:
        resp = anon_client.request(method, path)
        assert resp.status_code == 401, (method, path, resp.text)
        assert resp.json() == {"detail": "Sign in to continue."}


def test_openapi_docs_are_reachable_once_logged_in(client: TestClient) -> None:
    assert client.get("/api/openapi.json").status_code == 200
    assert client.get("/api/docs").status_code == 200


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


def test_validation_errors_are_plain_language_without_input_echo(anon_client: TestClient) -> None:
    long_password = "x" * 2000
    resp = anon_client.post("/api/login", json={"password": long_password})
    assert resp.status_code == 422
    assert long_password not in resp.text
    body = resp.json()
    assert isinstance(body["detail"], str)
    assert "password" in body["detail"]

    resp2 = anon_client.post("/api/setup", json={})
    assert resp2.status_code == 422
    body2 = resp2.json()
    assert isinstance(body2["detail"], str)
    assert "password" in body2["detail"]


def test_headless_setup_ignores_an_empty_password(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    """An unset ``ASTROCAPTION_PASSWORD`` in compose.yml expands to "", not the variable's
    absence; that must behave exactly like the variable being unset, with no log line."""
    with fresh_app_client(tmp_path, monkeypatch, ASTROCAPTION_PASSWORD="") as client:
        assert client.get("/api/health").json()["setup_required"] is True
    assert "ASTROCAPTION_PASSWORD" not in caplog.text


def test_login_cooldown_after_five_failures(anon_client: TestClient) -> None:
    for _ in range(5):
        assert anon_client.post("/api/login", json={"password": "nope"}).status_code == 401
    # The fifth wrong password already locked the account: a *correct* password right
    # after must still be turned away with 429, not allowed through.
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
