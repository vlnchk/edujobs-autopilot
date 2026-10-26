"""Deterministic URL and destination validation for SSRF protection."""

from __future__ import annotations

import asyncio
import ipaddress
import socket
from urllib.parse import urlsplit


class InvalidUrlError(ValueError):
    """Raised when a URL is malformed or uses a forbidden form."""


class UnsafeTargetError(ValueError):
    """Raised when any resolved destination is not publicly routable."""


class DnsResolutionError(RuntimeError):
    """Raised when the destination hostname cannot be resolved."""


class NonexistentHostError(DnsResolutionError):
    """Raised when DNS reports that the destination hostname does not exist."""


def _parsed_host_and_port(url: str) -> tuple[str, int]:
    if url != url.strip() or any(ord(character) < 32 for character in url):
        raise InvalidUrlError("URL contains whitespace or control characters")

    parsed = urlsplit(url)
    if parsed.scheme.lower() not in {"http", "https"}:
        raise InvalidUrlError("Only http and https URLs are allowed")
    if not parsed.netloc or parsed.hostname is None:
        raise InvalidUrlError("URL must include a hostname")
    if parsed.username is not None or parsed.password is not None:
        raise InvalidUrlError("Credentials in URLs are not allowed")

    try:
        port = parsed.port or (443 if parsed.scheme.lower() == "https" else 80)
    except ValueError as exc:
        raise InvalidUrlError("URL contains an invalid port") from exc

    try:
        hostname = parsed.hostname.encode("idna").decode("ascii").lower().rstrip(".")
    except UnicodeError as exc:
        raise InvalidUrlError("URL contains an invalid hostname") from exc

    if not hostname or hostname == "localhost" or hostname.endswith(".localhost"):
        raise UnsafeTargetError("Localhost destinations are not allowed")
    if "%" in hostname:
        raise InvalidUrlError("Scoped IP addresses are not allowed")
    return hostname, port


def _require_public_address(address: str) -> ipaddress.IPv4Address | ipaddress.IPv6Address:
    try:
        parsed_address = ipaddress.ip_address(address)
    except ValueError as exc:
        raise DnsResolutionError("DNS returned an invalid address") from exc
    if not parsed_address.is_global:
        raise UnsafeTargetError("Destination resolves to a non-public address")
    return parsed_address


def resolve_public_addresses(hostname: str, port: int) -> tuple[str, ...]:
    """Resolve a host and require every answer to be globally routable."""

    try:
        literal_address = ipaddress.ip_address(hostname)
    except ValueError:
        literal_address = None

    if literal_address is not None:
        return (str(_require_public_address(str(literal_address))),)

    try:
        answers = socket.getaddrinfo(hostname, port, type=socket.SOCK_STREAM)
    except socket.gaierror as exc:
        # Only a definitive "name not known" proves the link dead; transient
        # resolver failures stay ordinary fetch failures.
        if exc.errno == socket.EAI_NONAME:
            raise NonexistentHostError("Destination hostname does not exist") from exc
        raise DnsResolutionError("Destination hostname could not be resolved") from exc

    addresses = tuple(sorted({answer[4][0] for answer in answers}))
    if not addresses:
        raise DnsResolutionError("Destination hostname returned no addresses")
    for address in addresses:
        _require_public_address(address)
    return addresses


async def validate_url_target(url: str) -> tuple[str, ...]:
    """Validate URL syntax and resolve its destination before a request."""

    hostname, port = _parsed_host_and_port(url)
    return await asyncio.to_thread(resolve_public_addresses, hostname, port)
