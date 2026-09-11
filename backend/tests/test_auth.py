from __future__ import annotations

import base64
import logging

import pytest

from app.auth import (
    CLOCK_SKEW_SECONDS,
    SESSION_TTL_SECONDS,
    LoginLimiter,
    hash_password,
    issue_session,
    session_is_valid,
    verify_password,
)


def test_hash_roundtrip_and_format() -> None:
    stored = hash_password("correct horse battery")
    parts = stored.split("$")
    assert parts[0] == "scrypt" and len(parts) == 6
    assert (parts[1], parts[2], parts[3]) == ("32768", "8", "1")
    assert verify_password("correct horse battery", stored)
    assert not verify_password("correct horse batter", stored)
    assert not verify_password("", stored)


def test_hash_is_salted() -> None:
    assert hash_password("same") != hash_password("same")


def test_verify_rejects_malformed_hashes() -> None:
    assert not verify_password("x", "")
    assert not verify_password("x", "bcrypt$whatever")
    assert not verify_password("x", "scrypt$32768$8$1$not-base64$zzz")
    assert not verify_password("x", "scrypt$32768$8$1$AAAA")
    assert not verify_password("x", "scrypt$100000000000000000000$8$1$AAAA$AAAA")


@pytest.mark.parametrize("dropped", [5, 40])
def test_verify_rejects_a_truncated_digest(dropped: int) -> None:
    """scrypt output is prefix-consistent: a clipped digest must not authenticate against a
    shorter comparison."""
    password = "correct horse battery"
    fields = hash_password(password).split("$")
    fields[5] = fields[5][:-dropped]
    assert not verify_password(password, "$".join(fields))


def test_verify_rejects_wrong_parameters() -> None:
    password = "correct horse battery"
    fields = hash_password(password).split("$")

    def with_field(index: int, value: str) -> str:
        parts = list(fields)
        parts[index] = value
        return "$".join(parts)

    short_salt = base64.urlsafe_b64encode(b"\x00" * 16).decode("ascii").rstrip("=")
    assert verify_password(password, with_field(0, "scrypt"))  # the untouched hash still works
    assert not verify_password(password, with_field(4, short_salt))
    assert not verify_password(password, with_field(1, "32767"))  # not a power of two
    assert not verify_password(password, with_field(1, "0"))
    assert not verify_password(password, with_field(2, "0"))
    assert not verify_password(password, with_field(3, "0"))


def test_unusable_hash_is_logged_once_and_a_wrong_password_is_not(
    caplog: pytest.LogCaptureFixture,
) -> None:
    stored = hash_password("correct horse battery")
    with caplog.at_level(logging.ERROR, logger="app.auth"):
        assert not verify_password("x", stored[:-5])
    assert caplog.text.count("not a usable scrypt hash") == 1
    assert "remove the line to run setup again" in caplog.text
    assert stored[:20] not in caplog.text  # no hash material in the message

    caplog.clear()
    with caplog.at_level(logging.ERROR, logger="app.auth"):
        assert not verify_password("wrong password", stored)
    assert caplog.text == ""


HASH = hash_password("pw-for-sessions")


def test_session_roundtrip_and_expiry() -> None:
    token = issue_session("secret", HASH, now=1_000_000.0)
    assert session_is_valid(token, "secret", HASH, now=1_000_000.0 + 10)
    assert session_is_valid(token, "secret", HASH, now=1_000_000.0 + SESSION_TTL_SECONDS)
    assert not session_is_valid(token, "secret", HASH, now=1_000_000.0 + SESSION_TTL_SECONDS + 1)
    # Clock skew: a token issued exactly CLOCK_SKEW_SECONDS ahead is still accepted, one more is not.
    assert session_is_valid(token, "secret", HASH, now=1_000_000.0 - CLOCK_SKEW_SECONDS)
    assert not session_is_valid(token, "secret", HASH, now=1_000_000.0 - CLOCK_SKEW_SECONDS - 1)
    assert not session_is_valid(
        token, "secret", HASH, now=1_000_000.0 - 120
    )  # issued in the future


def test_session_rejects_tampering_other_secret_and_password_change() -> None:
    token = issue_session("secret", HASH, now=1_000_000.0)
    issued, sig = token.split(".")
    assert not session_is_valid(f"{int(issued) + 1}.{sig}", "secret", HASH, now=1_000_100.0)
    flipped = "1" if sig[-1] == "0" else "0"  # always a different last character
    assert not session_is_valid(f"{issued}.{sig[:-1]}{flipped}", "secret", HASH, now=1_000_100.0)
    assert not session_is_valid(token, "other-secret", HASH, now=1_000_100.0)
    assert not session_is_valid(token, "secret", hash_password("new password"), now=1_000_100.0)
    assert not session_is_valid(None, "secret", HASH)
    assert not session_is_valid("", "secret", HASH)
    assert not session_is_valid("garbage", "secret", HASH)
    assert not session_is_valid("abc.def", "secret", HASH)
    assert not session_is_valid("²." + "a" * 64, "secret", HASH, now=1_000_100.0)
    # compare_digest() raises TypeError on a non-ASCII str: that must be a plain False,
    # not a 500 on every route the cookie is sent to.
    assert not session_is_valid(f"{issued}.éabc", "secret", HASH, now=1_000_100.0)
    assert not session_is_valid(f"{issued}." + "é" * 64, "secret", HASH, now=1_000_100.0)
    assert not session_is_valid(f"{issued}." + "A" * 64, "secret", HASH, now=1_000_100.0)
    assert not session_is_valid(f"{issued}.{sig}0", "secret", HASH, now=1_000_100.0)
    assert not session_is_valid("1" * 5000 + "." + "a" * 64, "secret", HASH, now=1_000_100.0)


def test_login_limiter_locks_after_five_failures() -> None:
    now = [100.0]
    limiter = LoginLimiter(max_failures=5, cooldown=60.0, clock=lambda: now[0])
    assert limiter.max_failures == 5
    assert limiter.retry_after() == 0  # allowed before any failure
    for _ in range(4):
        assert limiter.record_failure() is False  # only the locking failure reports True
        assert limiter.retry_after() == 0
    assert limiter.record_failure() is True
    assert limiter.retry_after() == 60
    now[0] += 59.5
    assert limiter.retry_after() == 1
    now[0] += 1.0
    assert limiter.retry_after() == 0
    limiter.record_failure()  # the counter restarted after the cooldown
    assert limiter.retry_after() == 0
    limiter.reset()
    for _ in range(4):
        limiter.record_failure()
    assert limiter.retry_after() == 0
