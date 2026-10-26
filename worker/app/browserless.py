"""Single-call Browserless rendering fallback for HTML sources."""

from __future__ import annotations

import httpx

from .config import Settings
from .models import WorkerErrorCode
from .security import (
    DnsResolutionError,
    InvalidUrlError,
    UnsafeTargetError,
    validate_url_target,
)


class BrowserlessError(RuntimeError):
    def __init__(self, code: WorkerErrorCode, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


async def fetch_browserless_html(
    target_url: str,
    settings: Settings,
    *,
    transport: httpx.AsyncBaseTransport | None = None,
) -> bytes:
    """Render one already-supported public URL and bound the returned HTML."""

    try:
        await validate_url_target(target_url)
        async with httpx.AsyncClient(
            follow_redirects=False,
            timeout=httpx.Timeout(settings.fetch_timeout_seconds),
            transport=transport,
            trust_env=False,
        ) as client:
            async with client.stream(
                "POST", settings.browserless_url, json={"url": target_url}
            ) as response:
                if response.status_code >= 400:
                    raise BrowserlessError(
                        WorkerErrorCode.BROWSERLESS_FAILED,
                        f"Browserless returned HTTP {response.status_code}",
                    )
                chunks: list[bytes] = []
                downloaded_bytes = 0
                async for chunk in response.aiter_bytes():
                    downloaded_bytes += len(chunk)
                    if downloaded_bytes > settings.max_download_bytes:
                        raise BrowserlessError(
                            WorkerErrorCode.CONTENT_TOO_LARGE,
                            "Browserless output exceeds MAX_DOWNLOAD_BYTES",
                        )
                    chunks.append(chunk)
                return b"".join(chunks)
    except BrowserlessError:
        raise
    except (InvalidUrlError, UnsafeTargetError) as exc:
        raise BrowserlessError(WorkerErrorCode.INVALID_INPUT, str(exc)) from exc
    except DnsResolutionError as exc:
        raise BrowserlessError(WorkerErrorCode.FETCH_FAILED, str(exc)) from exc
    except httpx.TimeoutException as exc:
        raise BrowserlessError(
            WorkerErrorCode.BROWSERLESS_FAILED, "Browserless request timed out"
        ) from exc
    except httpx.RequestError as exc:
        raise BrowserlessError(
            WorkerErrorCode.BROWSERLESS_FAILED, "Browserless request failed"
        ) from exc
