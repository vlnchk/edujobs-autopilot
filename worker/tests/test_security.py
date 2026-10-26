import socket

import httpx
import pytest

from app.config import Settings
from app.fetch import FetchError, fetch_url
from app.models import WorkerErrorCode
from app.security import (
    DnsResolutionError,
    InvalidUrlError,
    NonexistentHostError,
    UnsafeTargetError,
    validate_url_target,
)


def _dns_answers(*addresses: str):
    return [
        (socket.AF_INET6 if ":" in address else socket.AF_INET, socket.SOCK_STREAM, 6, "", (address, 443))
        for address in addresses
    ]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "url",
    [
        "file:///etc/passwd",
        "ftp://example.com/file",
        "https://user:password@example.com",
        " https://example.com",
    ],
)
async def test_invalid_url_forms_are_rejected(url: str) -> None:
    with pytest.raises(InvalidUrlError):
        await validate_url_target(url)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "url",
    [
        "http://localhost",
        "http://service.localhost",
        "http://127.0.0.1",
        "http://10.0.0.1",
        "http://172.16.0.1",
        "http://192.168.1.1",
        "http://169.254.169.254/latest/meta-data",
        "http://[::1]",
    ],
)
async def test_local_private_and_metadata_targets_are_rejected(url: str) -> None:
    with pytest.raises(UnsafeTargetError):
        await validate_url_target(url)


@pytest.mark.asyncio
async def test_dns_is_resolved_and_public_answers_are_accepted(monkeypatch) -> None:
    monkeypatch.setattr(
        socket, "getaddrinfo", lambda *_args, **_kwargs: _dns_answers("93.184.216.34")
    )

    assert await validate_url_target("https://example.com") == ("93.184.216.34",)


@pytest.mark.asyncio
async def test_nonexistent_hostname_is_distinguished_from_transient_dns_failure(monkeypatch) -> None:
    def fail(errno):
        def resolver(*_args, **_kwargs):
            raise socket.gaierror(errno, "resolution failed")
        return resolver

    monkeypatch.setattr(socket, "getaddrinfo", fail(socket.EAI_NONAME))
    with pytest.raises(NonexistentHostError):
        await validate_url_target("https://no-such-school.example")

    monkeypatch.setattr(socket, "getaddrinfo", fail(socket.EAI_AGAIN))
    with pytest.raises(DnsResolutionError) as raised:
        await validate_url_target("https://example.com")
    assert not isinstance(raised.value, NonexistentHostError)


@pytest.mark.asyncio
async def test_mixed_public_and_private_dns_answers_are_rejected(monkeypatch) -> None:
    monkeypatch.setattr(
        socket,
        "getaddrinfo",
        lambda *_args, **_kwargs: _dns_answers("93.184.216.34", "10.0.0.2"),
    )

    with pytest.raises(UnsafeTargetError):
        await validate_url_target("https://example.com")


@pytest.mark.asyncio
async def test_redirect_target_is_revalidated_before_second_request(monkeypatch) -> None:
    requested_hosts: list[str] = []

    monkeypatch.setattr(
        socket, "getaddrinfo", lambda *_args, **_kwargs: _dns_answers("93.184.216.34")
    )

    def handler(request: httpx.Request) -> httpx.Response:
        requested_hosts.append(request.url.host)
        return httpx.Response(302, headers={"location": "http://127.0.0.1/private"})

    with pytest.raises(FetchError) as error:
        await fetch_url(
            "https://public.example/start",
            Settings(),
            transport=httpx.MockTransport(handler),
        )

    assert error.value.code is WorkerErrorCode.INVALID_INPUT
    assert requested_hosts == ["public.example"]


@pytest.mark.asyncio
async def test_configured_redirect_limit_is_enforced(monkeypatch) -> None:
    monkeypatch.setattr(
        socket, "getaddrinfo", lambda *_args, **_kwargs: _dns_answers("93.184.216.34")
    )

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(302, headers={"location": "/again"}, request=request)

    with pytest.raises(FetchError) as error:
        await fetch_url(
            "https://public.example/start",
            Settings(max_redirects=0),
            transport=httpx.MockTransport(handler),
        )

    assert error.value.code is WorkerErrorCode.FETCH_FAILED
