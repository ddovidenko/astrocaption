"""First-run setup, login and logout (SPEC § 5.1, § 10)."""

from __future__ import annotations

import asyncio
import logging
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status

from ..auth import (
    COOKIE_NAME,
    SESSION_TTL_SECONDS,
    LoginLimiter,
    issue_session,
    set_owner_password,
    validate_new_password,
    verify_password,
)
from ..config import ConfigError, Settings
from ..models import LoginRequest, PasswordChangeRequest, SetupRequest
from .config import CONFIG_SAVED_BUT_UNREADABLE
from .deps import SettingsDep, is_authenticated, require_owner
from .errors import config_write_error

log = logging.getLogger(__name__)

router = APIRouter(prefix="/api", tags=["auth"])

WRONG_CURRENT_MESSAGE = "The current password is wrong."
SAME_PASSWORD_MESSAGE = "The new password must differ from the current one."


def get_limiter(request: Request) -> LoginLimiter:
    limiter: LoginLimiter = request.app.state.login_limiter
    return limiter


def _cooldown_response(limiter: LoginLimiter) -> HTTPException | None:
    """The sign-in cooldown as a 429, shared by ``login`` and ``change_password`` (both
    verify a password through the same limiter, SPEC § 10)."""
    wait = limiter.retry_after()
    if not wait:
        return None
    return HTTPException(
        status.HTTP_429_TOO_MANY_REQUESTS,
        f"Too many failed sign-ins. Try again in {wait} seconds.",
        headers={"Retry-After": str(wait)},
    )


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
async def setup(body: SetupRequest, request: Request) -> None:
    lock: asyncio.Lock = request.app.state.config_write_lock
    async with lock:
        # Re-read inside the lock: two browsers submitting the form at the same moment must
        # not both write a password hash, each believing it owns the site.
        settings: Settings = request.app.state.settings_source.current()
        if settings.config_error is not None:
            raise HTTPException(status.HTTP_409_CONFLICT, settings.config_error)
        if not settings.setup_required:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Setup has already been completed.")
        refusal = validate_new_password(body.password)
        if refusal is not None:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, refusal)
        try:
            await asyncio.to_thread(
                set_owner_password,
                settings,
                body.password,
                nova_api_key=body.nova_api_key,
                site_title=body.site_title,
            )
        except (ConfigError, OSError) as exc:  # unreadable since the check, or unwritable
            if isinstance(exc, OSError):
                log.exception("setup could not write config.json")
            raise config_write_error(exc, "The password") from exc


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
    cooldown = _cooldown_response(limiter)
    if cooldown is not None:
        raise cooldown
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
async def logout(request: Request, response: Response, settings: SettingsDep) -> None:
    # Public route, but the clearing Set-Cookie only goes out to the owner's own session.
    # SameSite=Lax keeps a cross-site POST from carrying the cookie, so without this check a
    # third-party page could force-log-out the owner (#39). No session: nothing to clear, 204.
    if is_authenticated(request, settings):
        response.delete_cookie(COOKIE_NAME, **session_cookie_params(settings))


@router.post(
    "/password", status_code=status.HTTP_204_NO_CONTENT, dependencies=[Depends(require_owner)]
)
async def change_password(
    body: PasswordChangeRequest, request: Request, response: Response
) -> None:
    """Change the owner password from the config page (#43). The current password is checked
    through the sign-in limiter, so a stolen session cannot guess it unthrottled; the write
    goes through ``set_owner_password``, which also rotates the session secret (every other
    session is signed out, SPEC § 10), and this response carries a fresh cookie so the owner
    who made the change stays signed in. A wrong current password is 403, never 401: the page
    treats a 401 as a lost session."""
    lock: asyncio.Lock = request.app.state.config_write_lock
    async with lock:
        settings: Settings = request.app.state.settings_source.current()
        if settings.config_error is not None:
            raise HTTPException(status.HTTP_409_CONFLICT, settings.config_error)
        if not settings.auth_ready:
            raise HTTPException(status.HTTP_409_CONFLICT, "The site is not configured.")
        assert settings.password_hash and settings.session_secret  # auth_ready guarantees both
        limiter = get_limiter(request)
        cooldown = _cooldown_response(limiter)
        if cooldown is not None:
            raise cooldown
        just_locked = limiter.record_failure()
        if not await asyncio.to_thread(
            verify_password, body.current_password, settings.password_hash
        ):
            log.warning("failed password change: wrong current password")
            if just_locked:
                log.warning("sign-in cooldown started after %d failures", limiter.max_failures)
            raise HTTPException(status.HTTP_403_FORBIDDEN, WRONG_CURRENT_MESSAGE)
        limiter.reset()
        refusal = validate_new_password(body.new_password)
        if refusal is not None:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, refusal)
        if body.new_password == body.current_password:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, SAME_PASSWORD_MESSAGE)
        try:
            await asyncio.to_thread(set_owner_password, settings, body.new_password)
        except (ConfigError, OSError) as exc:
            if isinstance(exc, OSError):
                log.exception("password change could not write config.json")
            raise config_write_error(exc, "The password") from exc
        fresh: Settings = request.app.state.settings_source.reload()
        if not fresh.auth_ready:
            # set_owner_password already wrote the new hash - the password IS changed - but
            # the reload can't see a full pair to build a cookie from. Same wording as the
            # config page's saved-but-unreadable case (api/config.py).
            log.error("password changed but config.json could not be read back afterward")
            raise HTTPException(status.HTTP_500_INTERNAL_SERVER_ERROR, CONFIG_SAVED_BUT_UNREADABLE)
        assert fresh.password_hash and fresh.session_secret  # auth_ready guarantees both
        log.info("owner password changed")
    response.set_cookie(
        COOKIE_NAME,
        issue_session(fresh.session_secret, fresh.password_hash),
        **session_cookie_params(fresh, with_max_age=True),
    )
