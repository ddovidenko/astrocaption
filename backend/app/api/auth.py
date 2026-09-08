"""First-run setup, login and logout (SPEC § 5.1, § 10)."""

from __future__ import annotations

import asyncio
import logging
from typing import Any

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
from ..config import Settings
from ..models import LoginRequest, SetupRequest
from .deps import SettingsDep

log = logging.getLogger(__name__)

router = APIRouter(prefix="/api", tags=["auth"])


def get_limiter(request: Request) -> LoginLimiter:
    limiter: LoginLimiter = request.app.state.login_limiter
    return limiter


def session_cookie_params(settings: Settings, *, with_max_age: bool = False) -> dict[str, Any]:
    """The cookie attributes in one place: a browser only drops a cookie when the path,
    ``Secure`` and ``SameSite`` of the deletion match the ones it was set with, so ``login``
    and ``logout`` must not be able to drift apart."""
    params: dict[str, Any] = {
        "path": "/",
        "httponly": True,
        "samesite": "lax",
        "secure": settings.trust_proxy,
    }
    if with_max_age:
        params["max_age"] = SESSION_TTL_SECONDS
    return params


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
        detail = (
            "Set up the site first." if settings.setup_required else "The site is not configured."
        )
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
    # Claim the attempt before verifying, not after: verify_password runs in a worker
    # thread, so recording the failure only on a bad result would let N concurrent
    # requests all pass the retry_after() check first and each get a free guess. A
    # correct password below undoes this via reset() (which also clears any earlier
    # failures in the window), so the cooldown itself is unaffected by this ordering.
    just_locked = limiter.record_failure()
    if not await asyncio.to_thread(verify_password, body.password, settings.password_hash):
        # Never the password itself, and no caller detail: one owner, one global cooldown.
        log.warning("failed sign-in attempt")
        if just_locked:
            log.warning("sign-in cooldown started after %d failures", limiter.max_failures)
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Wrong password.")
    limiter.reset()
    response.set_cookie(
        COOKIE_NAME,
        issue_session(settings.session_secret, settings.password_hash),
        **session_cookie_params(settings, with_max_age=True),
    )


@router.post("/logout", status_code=status.HTTP_204_NO_CONTENT)
async def logout(response: Response, settings: SettingsDep) -> None:
    response.delete_cookie(COOKIE_NAME, **session_cookie_params(settings))
