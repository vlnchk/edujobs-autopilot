"""FastAPI entrypoint for the stateless content worker."""

from __future__ import annotations

from fastapi import FastAPI
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

from .config import Settings
from .models import (
    ExtractFailure,
    ExtractRequest,
    ExtractResponse,
    WorkerErrorCode,
)
from .service import extract_source


app = FastAPI(title="EduJobs Content Worker", version="0.1.0")
settings = Settings.from_env()


def _failure(code: WorkerErrorCode, message: str) -> ExtractFailure:
    return ExtractFailure(
        status="extraction_failed",
        source_type="unknown",
        error_code=code,
        error_message=message,
        warnings=[],
    )


@app.get("/health", include_in_schema=False)
async def health() -> dict[str, str]:
    """Return a dependency-free liveness response for the local sandbox."""
    return {"status": "ok"}


@app.exception_handler(RequestValidationError)
async def request_validation_error(
    _request: object, _exc: RequestValidationError
) -> JSONResponse:
    failure = _failure(
        WorkerErrorCode.INVALID_INPUT,
        "Request body must contain exactly one non-empty string field: url",
    )
    return JSONResponse(status_code=422, content=failure.model_dump(mode="json"))


@app.post("/extract", response_model=ExtractResponse)
async def extract(request: ExtractRequest) -> ExtractResponse:
    return await extract_source(request.url, settings)
