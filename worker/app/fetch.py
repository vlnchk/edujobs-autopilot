"""Bounded HTTP retrieval with destination checks on every redirect."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Mapping

import httpx

from .config import Settings
from .models import WorkerErrorCode
from .security import (
    DnsResolutionError,
    InvalidUrlError,
    NonexistentHostError,
    UnsafeTargetError,
    validate_url_target,
)


REDIRECT_STATUSES = {301, 302, 303, 307, 308}


class FetchError(RuntimeError):
    def __init__(self, code: WorkerErrorCode, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


@dataclass(frozen=True)
class FetchedResource:
    url: str
    status_code: int
    headers: Mapping[str, str]
    content: bytes


async def fetch_url(
    url: str,
    settings: Settings,
    *,
    transport: httpx.AsyncBaseTransport | None = None,
) -> FetchedResource:
    """Fetch one bounded resource without automatically following redirects."""

    current_url = url
    redirect_count = 0
    try:
        async with httpx.AsyncClient(
            follow_redirects=False,
            timeout=httpx.Timeout(settings.fetch_timeout_seconds),
            transport=transport,
            trust_env=False,
        ) as client:
            while True:
                await validate_url_target(current_url)
                async with client.stream("GET", current_url) as response:
                    location = response.headers.get("location")
                    if response.status_code in REDIRECT_STATUSES and location:
                        if redirect_count >= settings.max_redirects:
                            raise FetchError(
                                WorkerErrorCode.FETCH_FAILED,
                                "Maximum redirect limit exceeded",
                            )
                        try:
                            current_url = str(response.url.join(location))
                        except Exception as exc:
                            raise FetchError(
                                WorkerErrorCode.INVALID_INPUT,
                                "Redirect contains an invalid URL",
                            ) from exc
                        redirect_count += 1
                        continue

                    content_length = response.headers.get("content-length")
                    if content_length is not None:
                        try:
                            declared_size = int(content_length)
                        except ValueError:
                            declared_size = 0
                        if declared_size > settings.max_download_bytes:
                            raise FetchError(
                                WorkerErrorCode.CONTENT_TOO_LARGE,
                                "Download exceeds MAX_DOWNLOAD_BYTES",
                            )

                    chunks: list[bytes] = []
                    downloaded_bytes = 0
                    async for chunk in response.aiter_bytes():
                        downloaded_bytes += len(chunk)
                        if downloaded_bytes > settings.max_download_bytes:
                            raise FetchError(
                                WorkerErrorCode.CONTENT_TOO_LARGE,
                                "Download exceeds MAX_DOWNLOAD_BYTES",
                            )
                        chunks.append(chunk)

                    return FetchedResource(
                        url=str(response.url),
                        status_code=response.status_code,
                        headers=dict(response.headers),
                        content=b"".join(chunks),
                    )
    except FetchError:
        raise
    except (InvalidUrlError, UnsafeTargetError) as exc:
        raise FetchError(WorkerErrorCode.INVALID_INPUT, str(exc)) from exc
    except NonexistentHostError as exc:
        raise FetchError(WorkerErrorCode.LINK_BROKEN, str(exc)) from exc
    except DnsResolutionError as exc:
        raise FetchError(WorkerErrorCode.FETCH_FAILED, str(exc)) from exc
    except httpx.TimeoutException as exc:
        raise FetchError(WorkerErrorCode.TIMEOUT, "Source request timed out") from exc
    except httpx.RequestError as exc:
        raise FetchError(WorkerErrorCode.FETCH_FAILED, "Source request failed") from exc
