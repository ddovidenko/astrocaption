"""Passwords, sessions and the login cooldown (SPEC § 10). Standard library only.

Nothing here logs; the hash and the session secret are read from ``Settings`` and never
leave the process.
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import hmac
import secrets
import time
from collections.abc import Callable

from .config import Settings, update_config

SCRYPT_N = 2**15
SCRYPT_R = 8
SCRYPT_P = 1
SCRYPT_MAXMEM = 128 * 1024 * 1024  # n=2^15, r=8 needs ~32 MB; OpenSSL's default cap is exactly that
SALT_BYTES = 32
DIGEST_BYTES = 32
MIN_PASSWORD_LENGTH = 8

COOKIE_NAME = "astrocaption_session"
SESSION_TTL_SECONDS = 30 * 24 * 3600
CLOCK_SKEW_SECONDS = 60


def _b64(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def _unb64(text: str) -> bytes:
    padded = text + "=" * (-len(text) % 4)
    return base64.urlsafe_b64decode(padded.encode("ascii"))


def _scrypt(password: str, salt: bytes, n: int, r: int, p: int, dklen: int) -> bytes:
    return hashlib.scrypt(
        password.encode("utf-8"), salt=salt, n=n, r=r, p=p, maxmem=SCRYPT_MAXMEM, dklen=dklen
    )


def hash_password(password: str) -> str:
    """``scrypt$n$r$p$salt$digest`` with a fresh random salt; parameters travel with the hash."""
    salt = secrets.token_bytes(SALT_BYTES)
    digest = _scrypt(password, salt, SCRYPT_N, SCRYPT_R, SCRYPT_P, DIGEST_BYTES)
    return "$".join(
        ["scrypt", str(SCRYPT_N), str(SCRYPT_R), str(SCRYPT_P), _b64(salt), _b64(digest)]
    )


def verify_password(password: str, stored: str) -> bool:
    """Constant-time comparison; any malformed ``stored`` value is simply a mismatch."""
    try:
        scheme, n, r, p, salt_text, digest_text = stored.split("$")
        if scheme != "scrypt":
            return False
        expected = _unb64(digest_text)
        actual = _scrypt(password, _unb64(salt_text), int(n), int(r), int(p), len(expected))
    except (ValueError, TypeError, binascii.Error, UnicodeEncodeError, OverflowError):
        return False
    return hmac.compare_digest(actual, expected)


def _fingerprint(password_hash: str) -> str:
    return hashlib.sha256(password_hash.encode("utf-8")).hexdigest()[:32]


def _signature(secret: str, issued: int, password_hash: str) -> str:
    message = f"{issued}:{_fingerprint(password_hash)}".encode()
    return hmac.new(secret.encode("utf-8"), message, hashlib.sha256).hexdigest()


def issue_session(secret: str, password_hash: str, now: float | None = None) -> str:
    """``<issued>.<hmac>``: stateless, bound to the current password hash (SPEC § 10)."""
    issued = int(time.time() if now is None else now)
    return f"{issued}.{_signature(secret, issued, password_hash)}"


def session_is_valid(
    token: str | None, secret: str, password_hash: str, now: float | None = None
) -> bool:
    if not token or "." not in token:
        return False
    issued_text, signature = token.split(".", 1)
    if not (issued_text.isascii() and issued_text.isdigit() and len(issued_text) <= 12):
        return False
    try:
        issued = int(issued_text)
    except ValueError:
        return False
    current = time.time() if now is None else now
    if issued > current + CLOCK_SKEW_SECONDS or current - issued > SESSION_TTL_SECONDS:
        return False
    return hmac.compare_digest(signature, _signature(secret, issued, password_hash))


class LoginLimiter:
    """Global cooldown: ``max_failures`` wrong passwords start ``cooldown`` seconds of 429s."""

    def __init__(
        self,
        max_failures: int = 5,
        cooldown: float = 60.0,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._max_failures = max_failures
        self._cooldown = cooldown
        self._clock = clock
        self._failures = 0
        self._locked_until = 0.0

    def retry_after(self) -> int:
        """Whole seconds until the next attempt is allowed; 0 when it is allowed now."""
        remaining = self._locked_until - self._clock()
        if remaining <= 0:
            return 0
        return max(1, int(remaining + 0.999))

    def record_failure(self) -> None:
        self._failures += 1
        if self._failures >= self._max_failures:
            self._failures = 0
            self._locked_until = self._clock() + self._cooldown

    def reset(self) -> None:
        self._failures = 0
        self._locked_until = 0.0


def perform_setup(
    settings: Settings,
    password: str,
    *,
    nova_api_key: str | None = None,
    site_title: str | None = None,
) -> None:
    """Write the owner password hash and a fresh session secret (SPEC § 5.1 step 4).

    ``nova_api_key``/``site_title`` are skipped when ``settings.env_locked`` already pins
    them: the environment variable wins regardless, so writing the form value would only
    park a stale one in config.json that never takes effect.
    """
    updates: dict[str, object | None] = {
        "password_hash": hash_password(password),
        "session_secret": secrets.token_urlsafe(32),
    }
    if nova_api_key and nova_api_key.strip() and "nova_api_key" not in settings.env_locked:
        updates["nova_api_key"] = nova_api_key.strip()
    if site_title and site_title.strip() and "site_title" not in settings.env_locked:
        updates["site_title"] = site_title.strip()
    update_config(settings.config_path, updates)
