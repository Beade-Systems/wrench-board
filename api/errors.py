"""Machine-readable HTTP errors.

`CodedHTTPException` keeps the usual string `detail` (so existing clients and
proxies see the same body) and adds a stable `code` plus optional `params` next
to it. The UI translates by `code`; `detail` is the English fallback.
"""

from __future__ import annotations

from typing import Any

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse


class CodedHTTPException(HTTPException):
    """HTTPException carrying a stable error `code` for client-side localisation."""

    def __init__(
        self,
        status_code: int,
        code: str,
        detail: str,
        params: dict[str, Any] | None = None,
        headers: dict[str, str] | None = None,
    ) -> None:
        super().__init__(status_code=status_code, detail=detail, headers=headers)
        self.code = code
        self.params = params or {}


async def _coded_http_exception_handler(_: Request, exc: CodedHTTPException) -> JSONResponse:
    body: dict[str, Any] = {"detail": exc.detail, "code": exc.code}
    if exc.params:
        body["params"] = exc.params
    return JSONResponse(body, status_code=exc.status_code, headers=exc.headers)


def install_error_handlers(app: FastAPI) -> None:
    app.add_exception_handler(CodedHTTPException, _coded_http_exception_handler)
