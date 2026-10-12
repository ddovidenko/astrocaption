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
from typing import NamedTuple

from .config import ConfigError, Settings, SettingsSource, _merge_and_write, config_write_lock
from .models import MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH

log = logging.getLogger(__name__)

SCRYPT_N = 2**15
SCRYPT_R = 8
SCRYPT_P = 1
SCRYPT_MAXMEM = 128 * 1024 * 1024  # n=2^15, r=8 needs ~32 MB; OpenSSL's default cap is exactly that
SALT_BYTES = 32
DIGEST_BYTES = 32

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


def validate_new_password(password: str) -> str | None:
    """Why this password may not be used, as one plain sentence, or ``None`` when it may.

    The one place the bound is applied. All four ways to choose a password ask here - the
    setup page, the headless ``ASTROCAPTION_PASSWORD`` start, ``app.cli reset-password`` and
    the config page's password change - so a password any of them accepts is never one the
    login endpoint would reject.
    """
    if len(password) < MIN_PASSWORD_LENGTH:
        return f"Password must be at least {MIN_PASSWORD_LENGTH} characters."
    if len(password) > MAX_PASSWORD_LENGTH:
        return f"Password must be at most {MAX_PASSWORD_LENGTH} characters."
    return None


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
    """Global cooldown: ``max_failures`` wrong passwords start ``cooldown`` seconds of 429s.

    In-memory, one instance per process: the app is one uvicorn worker (CLAUDE.md), so a
    restart forgets the cooldown and a second worker would count separately.
    """

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


class PasswordRefused(Exception):
    """The caller's precondition said no once config.json was read under the lock; nothing
    was written. ``reason`` is for the caller and the log, never the response."""

    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


class PasswordNotStored(Exception):
    """The write landed, but config.json read back without the pair just written (an I/O
    fault, or a writer that bypassed the lock): the password may well have changed, yet the
    app cannot sign anybody in with it. ``detail`` is for the log."""

    def __init__(self, detail: str) -> None:
        super().__init__(detail)
        self.detail = detail


class PasswordWrite(NamedTuple):
    password_hash: str
    session_secret: str
    before: Settings
    """What config.json held when the lock was taken (the CLI words its report from it)."""


def require_setup(settings: Settings) -> str | None:
    """The precondition first-run setup shares between the route and ``ASTROCAPTION_PASSWORD``."""
    return None if settings.setup_required else "an owner password is already set"


def set_owner_password(
    source: SettingsSource,
    password: str,
    *,
    nova_api_key: str | None = None,
    site_title: str | None = None,
    precondition: Callable[[Settings], str | None] | None = None,
) -> PasswordWrite:
    """Write the owner password hash and a fresh session secret (SPEC § 5.1 step 4, § 10).

    The one writer of the owner password, for setup, ``ASTROCAPTION_PASSWORD``, the CLI and
    the password change (#49). It holds the cross-process config lock from the read to the
    read-back, so the decision is taken on what the file holds *now*, not on a read from
    before a prompt or a scrypt: config.json is re-read under the lock, a ``config_error``
    raises ``ConfigError``, ``precondition`` (given the fresh settings) may refuse with a
    reason (``PasswordRefused``, nothing written), the pair is written, and the file is read
    back: a result that is not a usable pair, or not the pair just written, raises
    ``PasswordNotStored``. Every read goes through ``source.reload()``, so the running app
    sees the change at once.

    Returns the pair it wrote, so a caller that needs to mint a session from it uses what
    this call stored rather than whatever a later read of config.json happens to find.

    ``nova_api_key``/``site_title`` are skipped when the fresh settings' ``locked_by`` pins
    them: the environment variable wins regardless, so writing the form value would only
    park a stale one in config.json that never takes effect.
    """
    config_path = source.current().config_path  # fixed for the life of the process
    with config_write_lock(config_path):
        before = source.reload()
        if before.config_error is not None:
            raise ConfigError(before.config_error)
        if precondition is not None and (reason := precondition(before)) is not None:
            raise PasswordRefused(reason)
        password_hash = hash_password(password)
        session_secret = secrets.token_urlsafe(32)
        updates: dict[str, object | None] = {
            "password_hash": password_hash,
            "session_secret": session_secret,
        }
        for name, raw in (("nova_api_key", nova_api_key), ("site_title", site_title)):
            value = raw.strip() if raw else ""
            if not value:
                continue
            if name in before.locked_by:
                log.info("setup: %s ignored, pinned by the environment", name)
                continue
            updates[name] = value
        _merge_and_write(config_path, updates)
        after = source.reload()
        if not after.auth_ready:
            raise PasswordNotStored(
                after.config_error or "no usable password hash and session secret"
            )
        if after.password_hash != password_hash:
            raise PasswordNotStored("the stored password hash is not the one just written")
    return PasswordWrite(password_hash, session_secret, before)
