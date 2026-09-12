"""The 422 handler words errors from pydantic's error type, never from ``msg`` (#45).

A custom ``@field_validator`` that raises ``ValueError(f"bad {value}")`` would otherwise put
the submitted value (a password, a key) straight into the response.
"""

from __future__ import annotations

from typing import Any

import pytest
from fastapi import FastAPI
from fastapi.exceptions import RequestValidationError
from fastapi.testclient import TestClient
from pydantic import BaseModel, Field, field_validator

from app.main import plain_validation_error
from app.models import validation_message


class Leaky(BaseModel):
    secret: str = Field(max_length=20)
    count: int = Field(default=1, ge=1, le=5)

    @field_validator("secret")
    @classmethod
    def _echoes_its_input(cls, value: str) -> str:
        if "leak" in value:
            raise ValueError(f"bad value {value}")  # the mistake the handler must survive
        return value


def _client() -> TestClient:
    app = FastAPI()
    app.add_exception_handler(RequestValidationError, plain_validation_error)  # type: ignore[arg-type]

    @app.post("/leaky")
    async def leaky(body: Leaky) -> dict[str, str]:
        return {"ok": body.secret}

    return TestClient(app)


def test_a_leaky_validator_cannot_echo_the_submitted_value() -> None:
    resp = _client().post("/leaky", json={"secret": "please leak hunter2"})
    assert resp.status_code == 422
    assert resp.json() == {"detail": "secret: is not valid"}
    assert "hunter2" not in resp.text


def test_built_in_rules_are_worded_from_the_type_and_the_model_limits() -> None:
    client = _client()
    assert client.post("/leaky", json={}).json()["detail"] == "secret: is required"
    too_long = client.post("/leaky", json={"secret": "x" * 21})
    assert too_long.json()["detail"] == "secret: must be at most 20 characters long"
    assert "xxxxx" not in too_long.text
    over = client.post("/leaky", json={"secret": "ok", "count": 9})
    assert over.json()["detail"] == "count: must be at most 5"
    text = client.post("/leaky", json={"secret": "ok", "count": "nine"})
    assert text.json()["detail"] == "count: must be a whole number"
    assert "nine" not in text.text


@pytest.mark.parametrize(
    ("error", "message"),
    [
        ({"type": "missing"}, "is required"),
        ({"type": "blank"}, "must not be blank"),
        (
            {"type": "string_too_short", "ctx": {"min_length": 8}},
            "must be at least 8 characters long",
        ),
        (
            {"type": "literal_error", "ctx": {"expected": "'popular' or 'ngc_ic'"}},
            "must be one of 'popular' or 'ngc_ic'",
        ),
        (
            {"type": "string_pattern_mismatch", "ctx": {"pattern": "^#[0-9A-Fa-f]{6}$"}},
            "must match ^#[0-9A-Fa-f]{6}$",
        ),
        (
            {"type": "null_not_allowed"},
            "cannot be null; leave the field out to keep the current value",
        ),
        (
            {"type": "value_error", "msg": "Value error, bad value hunter2", "ctx": {"error": "x"}},
            "is not valid",
        ),
        ({"type": "greater_than_equal"}, "is not valid"),  # a known type without its context
        ({"type": "made_up_type", "msg": "hunter2"}, "is not valid"),
        ({}, "is not valid"),
        (
            {
                "type": "too_short",
                "ctx": {"field_type": "List", "min_length": 1, "actual_length": 0},
            },
            "must have at least 1 items",
        ),
        (
            {
                "type": "too_long",
                "ctx": {"field_type": "List", "max_length": 5000, "actual_length": 5001},
            },
            "must have at most 5000 items",
        ),
    ],
)
def test_validation_message_never_uses_msg(error: dict[str, Any], message: str) -> None:
    assert validation_message(error) == message


def test_unknown_type_logs_at_info_and_missing_context_logs_at_warning(
    caplog: pytest.LogCaptureFixture,
) -> None:
    with caplog.at_level("INFO", logger="app.models"):
        assert validation_message({"type": "made_up_type"}) == "is not valid"
    assert [r.levelname for r in caplog.records] == ["INFO"]

    caplog.clear()
    with caplog.at_level("INFO", logger="app.models"):
        assert validation_message({"type": "greater_than_equal"}) == "is not valid"
    assert [r.levelname for r in caplog.records] == ["WARNING"]
