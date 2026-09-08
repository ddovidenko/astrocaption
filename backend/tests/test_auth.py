from __future__ import annotations

from app.auth import (
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


HASH = hash_password("pw-for-sessions")


def test_session_roundtrip_and_expiry() -> None:
    token = issue_session("secret", HASH, now=1_000_000.0)
    assert session_is_valid(token, "secret", HASH, now=1_000_000.0 + 10)
    assert session_is_valid(token, "secret", HASH, now=1_000_000.0 + SESSION_TTL_SECONDS)
    assert not session_is_valid(token, "secret", HASH, now=1_000_000.0 + SESSION_TTL_SECONDS + 1)
    assert not session_is_valid(
        token, "secret", HASH, now=1_000_000.0 - 120
    )  # issued in the future


def test_session_rejects_tampering_other_secret_and_password_change() -> None:
    token = issue_session("secret", HASH, now=1_000_000.0)
    issued, sig = token.split(".")
    assert not session_is_valid(f"{int(issued) + 1}.{sig}", "secret", HASH, now=1_000_100.0)
    assert not session_is_valid(f"{issued}.{sig[:-1]}0", "secret", HASH, now=1_000_100.0)
    assert not session_is_valid(token, "other-secret", HASH, now=1_000_100.0)
    assert not session_is_valid(token, "secret", hash_password("new password"), now=1_000_100.0)
    assert not session_is_valid(None, "secret", HASH)
    assert not session_is_valid("", "secret", HASH)
    assert not session_is_valid("garbage", "secret", HASH)
    assert not session_is_valid("abc.def", "secret", HASH)


def test_login_limiter_locks_after_five_failures() -> None:
    now = [100.0]
    limiter = LoginLimiter(max_failures=5, cooldown=60.0, clock=lambda: now[0])
    for _ in range(4):
        limiter.record_failure()
        assert limiter.retry_after() == 0
    limiter.record_failure()
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
