"""Environment-backed worker resource limits."""

from __future__ import annotations

import math
import os
from dataclasses import dataclass
from typing import Mapping


class ConfigurationError(ValueError):
    """Raised when a worker setting is missing or invalid."""


def _positive_float(values: Mapping[str, str], name: str, default: float) -> float:
    raw_value = values.get(name)
    if raw_value is None or not raw_value.strip():
        return default
    try:
        value = float(raw_value)
    except ValueError as exc:
        raise ConfigurationError(f"{name} must be a number") from exc
    if not math.isfinite(value) or value <= 0:
        raise ConfigurationError(f"{name} must be greater than zero")
    return value


def _integer(
    values: Mapping[str, str],
    name: str,
    default: int,
    *,
    allow_zero: bool = False,
) -> int:
    raw_value = values.get(name)
    if raw_value is None or not raw_value.strip():
        return default
    try:
        value = int(raw_value)
    except ValueError as exc:
        raise ConfigurationError(f"{name} must be an integer") from exc
    minimum = 0 if allow_zero else 1
    if value < minimum:
        comparison = "zero or greater" if allow_zero else "greater than zero"
        raise ConfigurationError(f"{name} must be {comparison}")
    return value


def _string(values: Mapping[str, str], name: str, default: str) -> str:
    raw_value = values.get(name)
    if raw_value is None:
        return default
    value = raw_value.strip()
    if not value:
        raise ConfigurationError(f"{name} must not be empty")
    return value


@dataclass(frozen=True)
class Settings:
    """Validated limits used by outbound retrieval and later extraction."""

    fetch_timeout_seconds: float = 15.0
    max_redirects: int = 3
    max_download_bytes: int = 10_000_000
    max_extracted_chars: int = 200_000
    browserless_url: str = "http://browserless:3000/content"

    @classmethod
    def from_env(cls, values: Mapping[str, str] | None = None) -> "Settings":
        source = os.environ if values is None else values
        return cls(
            fetch_timeout_seconds=_positive_float(
                source, "FETCH_TIMEOUT_SECONDS", cls.fetch_timeout_seconds
            ),
            max_redirects=_integer(
                source, "MAX_REDIRECTS", cls.max_redirects, allow_zero=True
            ),
            max_download_bytes=_integer(
                source, "MAX_DOWNLOAD_BYTES", cls.max_download_bytes
            ),
            max_extracted_chars=_integer(
                source, "MAX_EXTRACTED_CHARS", cls.max_extracted_chars
            ),
            browserless_url=_string(
                source, "BROWSERLESS_URL", cls.browserless_url
            ),
        )
