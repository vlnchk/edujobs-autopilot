import json
import socket

import httpx
import pytest

from app.browserless import BrowserlessError, fetch_browserless_html
from app.config import Settings
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
async def test_browserless_posts_one_public_target_and_returns_html() -> None:
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(200, content=b"<html>Rendered</html>", request=request)

    content = await fetch_browserless_html(
        "https://example.com/js-app",
        Settings(browserless_url="http://browserless:3000/content"),
        transport=httpx.MockTransport(handler),
    )

    assert content == b"<html>Rendered</html>"
    assert len(requests) == 1
    assert requests[0].method == "POST"
    assert requests[0].url == httpx.URL("http://browserless:3000/content")
    assert json.loads(requests[0].content) == {"url": "https://example.com/js-app"}


@pytest.mark.asyncio
async def test_browserless_output_is_bounded() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, content=b"12345", request=request)

    with pytest.raises(BrowserlessError) as error:
        await fetch_browserless_html(
            "https://example.com/js-app",
            Settings(max_download_bytes=4),
            transport=httpx.MockTransport(handler),
        )

    assert error.value.code is WorkerErrorCode.CONTENT_TOO_LARGE


@pytest.mark.asyncio
async def test_browserless_never_receives_private_target() -> None:
    requested = False

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal requested
        requested = True
        return httpx.Response(200, content=b"unused", request=request)

    with pytest.raises(BrowserlessError) as error:
        await fetch_browserless_html(
            "http://127.0.0.1/private",
            Settings(),
            transport=httpx.MockTransport(handler),
        )

    assert error.value.code is WorkerErrorCode.INVALID_INPUT
    assert requested is False
