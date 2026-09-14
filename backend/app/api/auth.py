"""First-run setup, login, logout and the password change (SPEC § 5.1, § 10)."""

from __future__ import annotations

import asyncio
import logging
from functools import partial
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
from ..config import Settings, SettingsSource, write_and_reload
from ..models import LoginRequest, PasswordChangeRequest, SetupRequest
from .deps import SettingsDep, is_authenticated, require_owner
from .errors import config_write_guard

log = logging.getLogger(__name__)

router = APIRouter(prefix="/api", tags=["auth"])

WRONG_CURRENT_MESSAGE = "The current password is wrong."
SAME_PASSWORD_MESSAGE = "The new password must differ from the current one."
NOT_CONFIGURED_MESSAGE = "The site is not configured; run setup again."
PASSWORD_CHANGED_BUT_UNREADABLE = (
    "The password was changed, but config.json could not be read back afterwards, so this "
    "browser was not re-signed-in. Sign in again with the new password; if that fails, see "
    "docs/LOCKOUT.md and the server log."
)


def get_limiter(request: Request) -> LoginLimiter:
    limiter: LoginLimiter = request.app.state.login_limiter
    return limiter


async def _verify_throttled(
    limiter: LoginLimiter, password: str, password_hash: str, *, failure_log: str
) -> bool:
    """Check ``password`` against ``password_hash`` through the sign-in cooldown.

    The one throttled password check in the app: ``login`` and ``change_password`` share it,
    so a stolen session cannot guess the current password any faster than a stranger can
    guess the sign-in one (SPEC § 10). Raises the 429 while the cooldown is running; returns
    False (having logged ``failure_log``) on a wrong password, True on a right one.
    """
    wait = limiter.retry_after()
    if wait:
        raise HTTPException(
            status.HTTP_429_TOO_MANY_REQUESTS,
            f"Too many wrong passwords. Try again in {wait} seconds.",
            headers={"Retry-After": str(wait)},
        )
    # Claim the attempt before verifying, not after: verify_password runs in a worker
    # thread, so recording the failure only on a bad result would let N concurrent
    # requests all pass the retry_after() check first and each get a free guess. A
    # correct password below undoes this via reset() (which also clears any earlier
    # failures in the window), so the cooldown itself is unaffected by this ordering.
    just_locked = limiter.record_failure()
    if not await asyncio.to_thread(verify_password, password, password_hash):
        # Never the password itself, and no caller detail: one owner, one global cooldown.
        log.warning(failure_log)
        if just_locked:
            log.warning("sign-in cooldown started after %d failures", limiter.max_failures)
        return False
    limiter.reset()
    return True


def session_cookie_params(settings: Settings) -> dict[str, Any]:
    """The cookie attributes in one place: a browser only drops a cookie when the path,
    ``Secure`` and ``SameSite`` of the deletion match the ones it was set with, so
    ``set_session_cookie`` and ``logout`` must not be able to drift apart."""
    return {
        "path": "/",
        "httponly": True,
        "samesite": "lax",
        "secure": settings.trust_proxy,
    }


def set_session_cookie(
    response: Response, settings: Settings, *, secret: str, password_hash: str
) -> None:
    """Mint a session for the given credential pair and put it on ``response``."""
    response.set_cookie(
        COOKIE_NAME,
        issue_session(secret, password_hash),
        max_age=SESSION_TTL_SECONDS,
        **session_cookie_params(settings),
    )


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
        # Unreadable since the check, or unwritable.
        with config_write_guard("The password", "setup could not write config.json"):
            await asyncio.to_thread(
                set_owner_password,
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
    ok = await _verify_throttled(
        get_limiter(request),
        body.password,
        settings.password_hash,
        failure_log="failed sign-in attempt",
    )
    if not ok:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Wrong password.")
    set_session_cookie(
        response,
        settings,
        secret=settings.session_secret,
        password_hash=settings.password_hash,
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
    treats a 401 as a lost session.

    The whole read-check-write runs under ``config_write_lock``, verify included: that lock is
    what keeps setup, the config page and this route from interleaving on config.json. The
    two body-only refusals come first, before the cooldown is ever consulted - they read
    nothing but the request, so a doomed 422 must not cost a scrypt or a limiter slot.
    """
    source: SettingsSource = request.app.state.settings_source
    lock: asyncio.Lock = request.app.state.config_write_lock
    async with lock:
        settings: Settings = source.current()
        if settings.config_error is not None:
            raise HTTPException(status.HTTP_409_CONFLICT, settings.config_error)
        if not settings.auth_ready:
            log.warning("password change refused: config.json no longer holds a usable password")
            raise HTTPException(status.HTTP_409_CONFLICT, NOT_CONFIGURED_MESSAGE)
        assert settings.password_hash and settings.session_secret  # auth_ready guarantees both
        refusal = validate_new_password(body.new_password)
        if refusal is not None:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, refusal)
        if body.new_password == body.current_password:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, SAME_PASSWORD_MESSAGE)
        ok = await _verify_throttled(
            get_limiter(request),
            body.current_password,
            settings.password_hash,
            failure_log="failed password change: wrong current password",
        )
        if not ok:
            raise HTTPException(status.HTTP_403_FORBIDDEN, WRONG_CURRENT_MESSAGE)
        with config_write_guard("The password", "password change could not write config.json"):
            (written_hash, written_secret), fresh = await asyncio.to_thread(
                write_and_reload, source, partial(set_owner_password, settings, body.new_password)
            )
        if not fresh.auth_ready:
            # set_owner_password already wrote the new hash - the password IS changed - but
            # the reload cannot see a full pair, so the app itself can no longer authenticate
            # anyone; a cookie minted here would be useless. Say exactly that.
            log.error(
                "password changed but config.json could not be read back afterward: %s",
                fresh.config_error or "no usable password hash and session secret",
            )
            raise HTTPException(
                status.HTTP_500_INTERNAL_SERVER_ERROR, PASSWORD_CHANGED_BUT_UNREADABLE
            )
        if fresh.password_hash != written_hash:
            # Something else (a CLI reset) rewrote the file between the write and the reload.
            # The cookie below is still minted from the pair this route wrote, because that is
            # the truth about what happened here; the next request will refuse it, which is
            # what the CLI promised when it said every browser would be signed out.
            log.warning(
                "config.json was rewritten again right after the password change; "
                "this browser will be signed out on its next request"
            )
        log.info("owner password changed")
    set_session_cookie(response, settings, secret=written_secret, password_hash=written_hash)
