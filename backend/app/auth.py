"""Passwords, sessions and the login cooldown (SPEC § 10). Standard library only.

The hash and the session secret are read from ``Settings`` and never leave the process:
the only log line here reports that ``password_hash`` is unusable, and it carries no hash
material.
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import hmac
import logging
import secrets
import time
from collections.abc import Callable

from .config import Settings, update_config

log = logging.getLogger(__name__)

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

SIGNATURE_HEX_LENGTH = 64  # HMAC-SHA256 as hex
_HEX_DIGITS = frozenset("0123456789abcdef")

UNUSABLE_HASH_MESSAGE = (
    "password_hash in config.json is not a usable scrypt hash; remove the line to run setup again"
)


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


def _parse_stored(stored: str) -> tuple[bytes, bytes, int, int, int] | None:
    """``(salt, digest, n, r, p)`` from a stored hash, or ``None`` when it is not usable.

    Every field is checked against what ``hash_password`` can produce. The digest length
    especially: scrypt output is prefix-consistent, so deriving the comparison length from
    the stored value would let a clipped ``password_hash`` line (a truncated copy-paste into
    config.json) authenticate against a shorter, weaker comparison.
    """
    try:
        scheme, n_text, r_text, p_text, salt_text, digest_text = stored.split("$")
        if scheme != "scrypt":
            return None
        salt = _unb64(salt_text)
        digest = _unb64(digest_text)
        n, r, p = int(n_text), int(r_text), int(p_text)
    except (ValueError, TypeError, binascii.Error, OverflowError):
        return None
    if len(salt) != SALT_BYTES or len(digest) != DIGEST_BYTES:
        return None
    if not (2 <= n <= SCRYPT_N) or n & (n - 1):  # scrypt requires a power of two
        return None
    if not (1 <= r <= 32) or not (1 <= p <= 16):
        return None
    if 128 * r * (n + p + 2) > SCRYPT_MAXMEM:  # what OpenSSL itself would refuse
        return None
    return salt, digest, n, r, p


def verify_password(password: str, stored: str) -> bool:
    """Constant-time comparison. An unusable ``stored`` value is a mismatch, logged once."""
    parsed = _parse_stored(stored)
    if parsed is None:
        log.error(UNUSABLE_HASH_MESSAGE)
        return False
    salt, digest, n, r, p = parsed
    try:
        actual = _scrypt(password, salt, n, r, p, DIGEST_BYTES)
    except UnicodeEncodeError:  # a lone surrogate in the submitted password; it cannot match
        return False
    return hmac.compare_digest(actual, digest)


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
    # compare_digest raises TypeError on a non-ASCII str, which would turn a junk cookie
    # into a 500 on every route; check the shape first.
    if len(signature) != SIGNATURE_HEX_LENGTH or not _HEX_DIGITS.issuperset(signature):
        return False
    issued = int(issued_text)
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

    @property
    def max_failures(self) -> int:
        return self._max_failures

    def retry_after(self) -> int:
        """Whole seconds until the next attempt is allowed; 0 when it is allowed now."""
        remaining = self._locked_until - self._clock()
        if remaining <= 0:
            return 0
        return max(1, int(remaining + 0.999))

    def record_failure(self) -> bool:
        """Count an attempt. True when this one started the cooldown."""
        self._failures += 1
        if self._failures >= self._max_failures:
            self._failures = 0
            self._locked_until = self._clock() + self._cooldown
            return True
        return False

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

    ``nova_api_key``/``site_title`` are skipped when ``settings.locked_by`` already pins
    them: the environment variable wins regardless, so writing the form value would only
    park a stale one in config.json that never takes effect.
    """
    updates: dict[str, object | None] = {
        "password_hash": hash_password(password),
        "session_secret": secrets.token_urlsafe(32),
    }
    for name, raw in (("nova_api_key", nova_api_key), ("site_title", site_title)):
        value = raw.strip() if raw else ""
        if not value:
            continue
        if name in settings.locked_by:
            log.info("setup: %s ignored, pinned by the environment", name)
            continue
        updates[name] = value
    update_config(settings.config_path, updates)
