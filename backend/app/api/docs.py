"""OpenAPI schema and Swagger UI, owner-only.

FastAPI normally registers these with no auth of their own; mounting them on our own
gated router keeps the owner API surface (routes, models, examples) out of reach of a
logged-out visitor.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, Request
from fastapi.openapi.docs import get_swagger_ui_html
from fastapi.responses import HTMLResponse, JSONResponse

from .deps import require_owner

router = APIRouter(prefix="/api", include_in_schema=False, dependencies=[Depends(require_owner)])


@router.get("/openapi.json")
async def openapi(request: Request) -> JSONResponse:
    return JSONResponse(request.app.openapi())


@router.get("/docs")
async def docs() -> HTMLResponse:
    return get_swagger_ui_html(openapi_url="/api/openapi.json", title="AstroCaption API")
