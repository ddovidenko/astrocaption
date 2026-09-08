from __future__ import annotations

from app.auth import hash_password, verify_password


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
