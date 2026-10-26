from unittest.mock import AsyncMock

import pytest

from app.browserless import BrowserlessError
from app.config import Settings
from app.fetch import FetchError, FetchedResource
from app.models import WorkerErrorCode
from app import service


def _resource(
    content: bytes,
    *,
    url: str = "https://example.com/vacancy",
    status_code: int = 200,
    content_type: str = "text/html; charset=utf-8",
) -> FetchedResource:
    return FetchedResource(
        url=url,
        status_code=status_code,
        headers={"content-type": content_type},
        content=content,
    )


@pytest.mark.asyncio
async def test_regular_html_succeeds_without_browserless(monkeypatch) -> None:
    monkeypatch.setattr(
        service,
        "fetch_url",
        AsyncMock(
            return_value=_resource(
                b"<html><head><title>Role</title></head><body><main><h1>Teacher</h1><p>Teach adults.</p></main></body></html>"
            )
        ),
    )
    browserless = AsyncMock()
    monkeypatch.setattr(service, "fetch_browserless_html", browserless)

    result = await service.extract_source("https://example.com/vacancy", Settings())

    assert result.status == "success"
    assert result.source_type == "html"
    assert result.extraction_method == "http"
    assert result.text == "# Teacher\n\nTeach adults."
    browserless.assert_not_awaited()


@pytest.mark.asyncio
async def test_notion_js_shell_uses_exactly_one_browserless_fallback(monkeypatch) -> None:
    monkeypatch.setattr(
        service,
        "fetch_url",
        AsyncMock(
            return_value=_resource(
                b"<html><body><main><p>Loading...</p></main></body></html>",
                url="https://team.notion.site/role",
            )
        ),
    )
    browserless = AsyncMock(
        return_value=b"<html><body><main><h1>Designer</h1><p>Build learning products.</p></main></body></html>"
    )
    monkeypatch.setattr(service, "fetch_browserless_html", browserless)

    result = await service.extract_source("https://team.notion.site/role", Settings())

    assert result.status == "success"
    assert result.source_type == "notion"
    assert result.extraction_method == "browserless"
    browserless.assert_awaited_once_with("https://team.notion.site/role", Settings())


@pytest.mark.asyncio
async def test_multilingual_loading_shell_fails_after_one_browserless_fallback(monkeypatch) -> None:
    monkeypatch.setattr(
        service,
        "fetch_url",
        AsyncMock(
            return_value=_resource(
                "<html><body><main><p>מתבצעת טעינה…</p></main></body></html>".encode(),
                url="https://drive.example/document",
            )
        ),
    )
    browserless = AsyncMock(
        return_value="<html><body><main><p>Подождите, пожалуйста...</p></main></body></html>".encode()
    )
    monkeypatch.setattr(service, "fetch_browserless_html", browserless)

    result = await service.extract_source("https://drive.example/document", Settings())

    assert result.status == "extraction_failed"
    assert result.error_code is WorkerErrorCode.EXTRACTION_FAILED
    browserless.assert_awaited_once_with("https://drive.example/document", Settings())


@pytest.mark.asyncio
async def test_empty_document_shell_fails_after_one_browserless_fallback(monkeypatch) -> None:
    empty_shell = b"<html><head><title>Document</title></head><body><main><div id='app'></div></main></body></html>"
    monkeypatch.setattr(
        service,
        "fetch_url",
        AsyncMock(return_value=_resource(empty_shell, url="https://example.com/document")),
    )
    browserless = AsyncMock(return_value=empty_shell)
    monkeypatch.setattr(service, "fetch_browserless_html", browserless)

    result = await service.extract_source("https://example.com/document", Settings())

    assert result.status == "extraction_failed"
    assert result.error_code is WorkerErrorCode.EXTRACTION_FAILED
    browserless.assert_awaited_once_with("https://example.com/document", Settings())


@pytest.mark.asyncio
async def test_short_normal_content_does_not_trigger_browserless(monkeypatch) -> None:
    monkeypatch.setattr(
        service,
        "fetch_url",
        AsyncMock(
            return_value=_resource(
                "<html><body><main><p>Ищем преподавателя.</p></main></body></html>".encode()
            )
        ),
    )
    browserless = AsyncMock()
    monkeypatch.setattr(service, "fetch_browserless_html", browserless)

    result = await service.extract_source("https://example.com/short-vacancy", Settings())

    assert result.status == "success"
    assert result.text == "Ищем преподавателя."
    browserless.assert_not_awaited()


@pytest.mark.asyncio
async def test_google_doc_uses_public_docx_export(monkeypatch, docx_bytes) -> None:
    fetcher = AsyncMock(
        return_value=_resource(
            docx_bytes,
            url="https://docs.google.com/document/d/document-id/export?format=docx",
            content_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        )
    )
    monkeypatch.setattr(service, "fetch_url", fetcher)

    result = await service.extract_source(
        "https://docs.google.com/document/d/document-id/edit", Settings()
    )

    assert result.status == "success"
    assert result.source_type == "google_doc"
    assert result.extraction_method == "google_docs_export"
    assert "Develop courses" in result.text
    fetcher.assert_awaited_once_with(
        "https://docs.google.com/document/d/document-id/export?format=docx",
        Settings(),
    )


DRIVE_VIEW = "https://drive.google.com/file/d/synthetic-id/view?usp=sharing"
DRIVE_DOWNLOAD = "https://drive.google.com/uc?export=download&id=synthetic-id"
DRIVE_SHELL = (
    b"<html><head><title>Example.pdf - Google Drive</title></head>"
    b"<body><main><p>Loading...</p></main></body></html>"
)


@pytest.mark.asyncio
async def test_google_drive_pdf_viewer_uses_bounded_download_and_pdf_extractor(
    monkeypatch, pdf_bytes
) -> None:
    fetcher = AsyncMock(side_effect=[
        _resource(DRIVE_SHELL, url=DRIVE_VIEW),
        _resource(pdf_bytes, url=DRIVE_DOWNLOAD, content_type="application/pdf"),
    ])
    monkeypatch.setattr(service, "fetch_url", fetcher)
    browserless = AsyncMock()
    monkeypatch.setattr(service, "fetch_browserless_html", browserless)

    result = await service.extract_source(DRIVE_VIEW, Settings())

    assert result.status == "success"
    assert result.source_type == "pdf"
    assert result.extraction_method == "pypdf"
    assert "Embedded vacancy text" in result.text
    assert [call.args[0] for call in fetcher.await_args_list] == [DRIVE_VIEW, DRIVE_DOWNLOAD]
    assert all(call.args[1] == Settings() for call in fetcher.await_args_list)
    browserless.assert_not_awaited()


@pytest.mark.asyncio
async def test_google_drive_docx_file_uses_existing_docx_extractor(monkeypatch, docx_bytes) -> None:
    fetcher = AsyncMock(side_effect=[
        _resource(DRIVE_SHELL, url=DRIVE_VIEW),
        _resource(docx_bytes, url=DRIVE_DOWNLOAD, content_type="application/octet-stream"),
    ])
    monkeypatch.setattr(service, "fetch_url", fetcher)

    result = await service.extract_source(DRIVE_VIEW, Settings())

    assert result.status == "success"
    assert result.source_type == "docx"
    assert result.extraction_method == "python-docx"
    assert "Develop courses" in result.text


@pytest.mark.asyncio
async def test_google_drive_download_html_shell_is_not_document_content(monkeypatch) -> None:
    fetcher = AsyncMock(side_effect=[
        _resource(DRIVE_SHELL, url=DRIVE_VIEW),
        _resource(
            b"<html><body><main><p>Sign in to request access.</p></main></body></html>",
            url=DRIVE_DOWNLOAD,
        ),
    ])
    monkeypatch.setattr(service, "fetch_url", fetcher)
    browserless = AsyncMock()
    monkeypatch.setattr(service, "fetch_browserless_html", browserless)

    result = await service.extract_source(DRIVE_VIEW, Settings())

    assert result.status == "extraction_failed"
    assert result.source_type == "google_drive_file"
    assert result.error_code is WorkerErrorCode.EXTRACTION_FAILED
    assert fetcher.await_count == 2
    browserless.assert_not_awaited()


@pytest.mark.asyncio
async def test_google_drive_closed_download_does_not_claim_broken_source(monkeypatch) -> None:
    fetcher = AsyncMock(side_effect=[
        _resource(DRIVE_SHELL, url=DRIVE_VIEW),
        _resource(b"forbidden", url=DRIVE_DOWNLOAD, status_code=403),
    ])
    monkeypatch.setattr(service, "fetch_url", fetcher)

    result = await service.extract_source(DRIVE_VIEW, Settings())

    assert result.status == "extraction_failed"
    assert result.error_code is WorkerErrorCode.FETCH_FAILED
    assert fetcher.await_count == 2


@pytest.mark.asyncio
async def test_google_drive_blank_pdf_stays_extraction_failed(monkeypatch, blank_pdf_bytes) -> None:
    monkeypatch.setattr(service, "fetch_url", AsyncMock(side_effect=[
        _resource(DRIVE_SHELL, url=DRIVE_VIEW),
        _resource(blank_pdf_bytes, url=DRIVE_DOWNLOAD, content_type="application/pdf"),
    ]))

    result = await service.extract_source(DRIVE_VIEW, Settings())

    assert result.status == "extraction_failed"
    assert result.source_type == "pdf"
    assert result.error_code is WorkerErrorCode.EXTRACTION_FAILED


@pytest.mark.asyncio
async def test_google_drive_download_timeout_stays_timeout(monkeypatch) -> None:
    fetcher = AsyncMock(side_effect=[
        _resource(DRIVE_SHELL, url=DRIVE_VIEW),
        FetchError(WorkerErrorCode.TIMEOUT, "Source request timed out"),
    ])
    monkeypatch.setattr(service, "fetch_url", fetcher)

    result = await service.extract_source(DRIVE_VIEW, Settings())

    assert result.status == "extraction_failed"
    assert result.error_code is WorkerErrorCode.TIMEOUT
    assert fetcher.await_count == 2


@pytest.mark.asyncio
async def test_google_drive_viewer_404_is_broken_but_download_404_is_not(monkeypatch) -> None:
    fetcher = AsyncMock(return_value=_resource(b"missing", url=DRIVE_VIEW, status_code=404))
    monkeypatch.setattr(service, "fetch_url", fetcher)
    broken = await service.extract_source(DRIVE_VIEW, Settings())
    assert broken.status == "broken"
    assert broken.error_code is WorkerErrorCode.LINK_BROKEN
    assert fetcher.await_count == 1

    fetcher = AsyncMock(side_effect=[
        _resource(DRIVE_SHELL, url=DRIVE_VIEW),
        _resource(b"missing", url=DRIVE_DOWNLOAD, status_code=404),
    ])
    monkeypatch.setattr(service, "fetch_url", fetcher)
    unavailable = await service.extract_source(DRIVE_VIEW, Settings())
    assert unavailable.status == "extraction_failed"
    assert unavailable.error_code is WorkerErrorCode.FETCH_FAILED


@pytest.mark.asyncio
async def test_drive_host_spoof_does_not_use_google_download_path(monkeypatch) -> None:
    url = "https://drive.google.com.attacker.example/file/d/synthetic-id/view"
    fetcher = AsyncMock(return_value=_resource(
        b"<html><body><main><p>A substantive page.</p></main></body></html>", url=url,
    ))
    monkeypatch.setattr(service, "fetch_url", fetcher)

    result = await service.extract_source(url, Settings())

    assert result.status == "success"
    fetcher.assert_awaited_once_with(url, Settings())


@pytest.mark.asyncio
async def test_pdf_with_embedded_text_succeeds(monkeypatch, pdf_bytes) -> None:
    monkeypatch.setattr(
        service,
        "fetch_url",
        AsyncMock(
            return_value=_resource(
                pdf_bytes,
                url="https://example.com/vacancy.pdf",
                content_type="application/pdf",
            )
        ),
    )

    result = await service.extract_source("https://example.com/vacancy.pdf", Settings())

    assert result.status == "success"
    assert result.source_type == "pdf"
    assert result.extraction_method == "pypdf"
    assert "Embedded vacancy text" in result.text


@pytest.mark.asyncio
async def test_scanned_or_blank_pdf_fails_without_ocr(monkeypatch, blank_pdf_bytes) -> None:
    monkeypatch.setattr(
        service,
        "fetch_url",
        AsyncMock(
            return_value=_resource(
                blank_pdf_bytes,
                url="https://example.com/scanned.pdf",
                content_type="application/pdf",
            )
        ),
    )

    result = await service.extract_source("https://example.com/scanned.pdf", Settings())

    assert result.status == "extraction_failed"
    assert result.error_code is WorkerErrorCode.EXTRACTION_FAILED


@pytest.mark.asyncio
async def test_docx_succeeds(monkeypatch, docx_bytes) -> None:
    monkeypatch.setattr(
        service,
        "fetch_url",
        AsyncMock(
            return_value=_resource(
                docx_bytes,
                url="https://example.com/vacancy.docx",
                content_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            )
        ),
    )

    result = await service.extract_source("https://example.com/vacancy.docx", Settings())

    assert result.status == "success"
    assert result.source_type == "docx"
    assert result.extraction_method == "python-docx"


@pytest.mark.asyncio
async def test_confirmed_404_is_broken_link(monkeypatch) -> None:
    monkeypatch.setattr(
        service,
        "fetch_url",
        AsyncMock(return_value=_resource(b"not found", status_code=404)),
    )

    result = await service.extract_source("https://example.com/missing", Settings())

    assert result.status == "broken"
    assert result.error_code is WorkerErrorCode.LINK_BROKEN
    assert result.error_message == "Confirmed HTTP 404"


@pytest.mark.asyncio
async def test_nonexistent_domain_is_broken_link(monkeypatch) -> None:
    monkeypatch.setattr(
        service,
        "fetch_url",
        AsyncMock(side_effect=FetchError(WorkerErrorCode.LINK_BROKEN, "Destination hostname does not exist")),
    )

    result = await service.extract_source("https://no-such-school.example/job", Settings())

    assert result.status == "broken"
    assert result.error_code is WorkerErrorCode.LINK_BROKEN


@pytest.mark.asyncio
@pytest.mark.parametrize("status_code", [401, 403])
async def test_access_denied_is_fetch_failure_not_broken_link(monkeypatch, status_code) -> None:
    fetcher = AsyncMock(return_value=_resource(b"access denied", status_code=status_code))
    monkeypatch.setattr(service, "fetch_url", fetcher)
    browserless = AsyncMock()
    monkeypatch.setattr(service, "fetch_browserless_html", browserless)

    result = await service.extract_source("https://example.com/private", Settings())

    assert result.status == "extraction_failed"
    assert result.error_code is WorkerErrorCode.FETCH_FAILED
    fetcher.assert_awaited_once()
    browserless.assert_not_awaited()


@pytest.mark.asyncio
async def test_unsupported_social_source_is_not_fetched(monkeypatch) -> None:
    fetcher = AsyncMock()
    monkeypatch.setattr(service, "fetch_url", fetcher)

    result = await service.extract_source("https://t.me/example", Settings())

    assert result.status == "extraction_failed"
    assert result.error_code is WorkerErrorCode.UNSUPPORTED_SOURCE
    fetcher.assert_not_awaited()


@pytest.mark.asyncio
async def test_unsupported_content_type_is_reported(monkeypatch) -> None:
    monkeypatch.setattr(
        service,
        "fetch_url",
        AsyncMock(
            return_value=_resource(
                b"image bytes", content_type="image/png", url="https://example.com/image.png"
            )
        ),
    )

    result = await service.extract_source("https://example.com/image.png", Settings())

    assert result.status == "extraction_failed"
    assert result.error_code is WorkerErrorCode.UNSUPPORTED_SOURCE


@pytest.mark.asyncio
async def test_malformed_supported_document_is_extraction_failure(monkeypatch) -> None:
    monkeypatch.setattr(
        service,
        "fetch_url",
        AsyncMock(
            return_value=_resource(
                b"not a docx",
                content_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                url="https://example.com/broken.docx",
            )
        ),
    )

    result = await service.extract_source("https://example.com/broken.docx", Settings())

    assert result.status == "extraction_failed"
    assert result.error_code is WorkerErrorCode.EXTRACTION_FAILED


@pytest.mark.asyncio
async def test_timeout_mapping_is_preserved(monkeypatch) -> None:
    monkeypatch.setattr(
        service,
        "fetch_url",
        AsyncMock(side_effect=FetchError(WorkerErrorCode.TIMEOUT, "Source request timed out")),
    )

    result = await service.extract_source("https://example.com/slow", Settings())

    assert result.status == "extraction_failed"
    assert result.error_code is WorkerErrorCode.TIMEOUT


@pytest.mark.asyncio
async def test_oversized_extracted_content_is_not_truncated(monkeypatch) -> None:
    monkeypatch.setattr(
        service,
        "fetch_url",
        AsyncMock(return_value=_resource(b"<html><body><p>1234567890</p></body></html>")),
    )
    browserless = AsyncMock()
    monkeypatch.setattr(service, "fetch_browserless_html", browserless)

    result = await service.extract_source(
        "https://example.com/large", Settings(max_extracted_chars=5)
    )

    assert result.status == "extraction_failed"
    assert result.error_code is WorkerErrorCode.CONTENT_TOO_LARGE
    browserless.assert_not_awaited()


@pytest.mark.asyncio
async def test_browserless_integration_failure_is_conservative(monkeypatch) -> None:
    monkeypatch.setattr(
        service,
        "fetch_url",
        AsyncMock(return_value=_resource(b"<html><body>Loading...</body></html>")),
    )
    monkeypatch.setattr(
        service,
        "fetch_browserless_html",
        AsyncMock(
            side_effect=BrowserlessError(
                WorkerErrorCode.BROWSERLESS_FAILED, "Browserless request failed"
            )
        ),
    )

    result = await service.extract_source("https://example.com/js-app", Settings())

    assert result.status == "extraction_failed"
    assert result.error_code is WorkerErrorCode.BROWSERLESS_FAILED
