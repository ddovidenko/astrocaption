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
