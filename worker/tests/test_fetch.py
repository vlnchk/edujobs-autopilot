import socket

import httpx
import pytest

from app.config import Settings
from app.fetch import FetchError, fetch_url
from app.models import WorkerErrorCode


@pytest.fixture(autouse=True)
def public_dns(monkeypatch):
    monkeypatch.setattr(
        socket,
        "getaddrinfo",
        lambda *_args, **_kwargs: [
            (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("93.184.216.34", 443))
        ],
    )


@pytest.mark.asyncio
async def test_download_larger_than_declared_limit_is_rejected() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            headers={"content-length": "5"},
            content=b"12345",
            request=request,
        )

    with pytest.raises(FetchError) as error:
        await fetch_url(
            "https://example.com/file",
            Settings(max_download_bytes=4),
            transport=httpx.MockTransport(handler),
        )

    assert error.value.code is WorkerErrorCode.CONTENT_TOO_LARGE


@pytest.mark.asyncio
async def test_timeout_is_mapped_to_worker_error() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ReadTimeout("timed out", request=request)

    with pytest.raises(FetchError) as error:
        await fetch_url(
            "https://example.com/file",
            Settings(fetch_timeout_seconds=1),
            transport=httpx.MockTransport(handler),
        )

    assert error.value.code is WorkerErrorCode.TIMEOUT


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("errno", "code"),
    [(socket.EAI_NONAME, WorkerErrorCode.LINK_BROKEN), (socket.EAI_AGAIN, WorkerErrorCode.FETCH_FAILED)],
)
async def test_only_a_nonexistent_domain_is_a_broken_link(monkeypatch, errno, code) -> None:
    def resolver(*_args, **_kwargs):
        raise socket.gaierror(errno, "resolution failed")

    monkeypatch.setattr(socket, "getaddrinfo", resolver)

    with pytest.raises(FetchError) as error:
        await fetch_url("https://no-such-school.example/job", Settings())

    assert error.value.code is code


@pytest.mark.asyncio
async def test_bounded_fetch_returns_unparsed_content_for_m2() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            headers={"content-type": "text/html"},
            content=b"<html>raw source</html>",
            request=request,
        )

    result = await fetch_url(
        "https://example.com/file",
        Settings(max_download_bytes=1024),
        transport=httpx.MockTransport(handler),
    )

    assert result.status_code == 200
    assert result.content == b"<html>raw source</html>"
