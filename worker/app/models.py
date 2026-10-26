"""Strict request and response models for the worker API."""

from __future__ import annotations

from enum import Enum
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


class WorkerErrorCode(str, Enum):
    INVALID_INPUT = "INVALID_INPUT"
    FETCH_FAILED = "FETCH_FAILED"
    LINK_BROKEN = "LINK_BROKEN"
    UNSUPPORTED_SOURCE = "UNSUPPORTED_SOURCE"
    EXTRACTION_FAILED = "EXTRACTION_FAILED"
    BROWSERLESS_FAILED = "BROWSERLESS_FAILED"
    TIMEOUT = "TIMEOUT"
    CONTENT_TOO_LARGE = "CONTENT_TOO_LARGE"


class ContractModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class ExtractRequest(ContractModel):
    url: str = Field(min_length=1)


class ExtractSuccess(ContractModel):
    status: Literal["success"] = "success"
    source_type: str
    title: str | None = None
    text: str
    links: list[str] = Field(default_factory=list)
    extraction_method: str
    warnings: list[str] = Field(default_factory=list)


class ExtractFailure(ContractModel):
    status: Literal["broken", "extraction_failed"]
    source_type: str
    error_code: WorkerErrorCode
    error_message: str
    warnings: list[str] = Field(default_factory=list)


ExtractResponse = ExtractSuccess | ExtractFailure
