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
