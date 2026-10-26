from unittest.mock import AsyncMock

import httpx
import pytest

from app import main
from app.models import ExtractFailure, ExtractSuccess, WorkerErrorCode


@pytest.fixture
async def client():
    transport = httpx.ASGITransport(app=main.app)
    async with httpx.AsyncClient(
        transport=transport, base_url="http://testserver"
    ) as test_client:
        yield test_client


@pytest.mark.asyncio
async def test_extract_contract_is_exposed_in_openapi(client) -> None:
    operation = (await client.get("/openapi.json")).json()["paths"]["/extract"]["post"]

    assert "requestBody" in operation
    assert "200" in operation["responses"]


@pytest.mark.asyncio
async def test_health_is_available_without_exposing_worker_details(client) -> None:
    response = await client.get("/health")

    assert response.status_code == 200
    assert response.json() == {"status": "ok"}
    assert "/health" not in (await client.get("/openapi.json")).json()["paths"]


@pytest.mark.asyncio
async def test_extract_rejects_malformed_request_with_worker_contract(client) -> None:
    response = await client.post("/extract", json={"unexpected": "value"})

    assert response.status_code == 422
    assert response.json() == {
        "status": "extraction_failed",
        "source_type": "unknown",
        "error_code": "INVALID_INPUT",
        "error_message": "Request body must contain exactly one non-empty string field: url",
        "warnings": [],
    }


@pytest.mark.asyncio
async def test_extract_returns_success_contract(monkeypatch, client) -> None:
    monkeypatch.setattr(
        main,
        "extract_source",
        AsyncMock(
            return_value=ExtractSuccess(
                source_type="html",
                title="Methodologist",
                text="Vacancy text",
                links=["https://example.com/apply"],
                extraction_method="http",
                warnings=[],
            )
        ),
    )

    response = await client.post(
        "/extract", json={"url": "https://example.com/vacancy/123"}
    )

    assert response.status_code == 200
    assert response.json() == {
        "status": "success",
        "source_type": "html",
        "title": "Methodologist",
        "text": "Vacancy text",
        "links": ["https://example.com/apply"],
        "extraction_method": "http",
        "warnings": [],
    }


@pytest.mark.asyncio
async def test_extract_returns_structured_fetch_failure(monkeypatch, client) -> None:
    monkeypatch.setattr(
        main,
        "extract_source",
        AsyncMock(
            return_value=ExtractFailure(
                status="extraction_failed",
                source_type="html",
                error_code=WorkerErrorCode.TIMEOUT,
                error_message="Source request timed out",
                warnings=[],
            )
        ),
    )

    response = await client.post("/extract", json={"url": "https://example.com"})

    assert response.status_code == 200
    assert response.json()["error_code"] == "TIMEOUT"


@pytest.mark.asyncio
async def test_extract_blocks_private_ip_without_network_access(client) -> None:
    response = await client.post(
        "/extract", json={"url": "http://127.0.0.1/private"}
    )

    assert response.status_code == 200
    assert response.json()["error_code"] == "INVALID_INPUT"
