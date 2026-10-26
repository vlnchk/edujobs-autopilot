"""Source detection, extraction routing, and canonical worker result mapping."""

from __future__ import annotations

import re
from pathlib import PurePosixPath
from urllib.parse import urlsplit

from .browserless import BrowserlessError, fetch_browserless_html
from .config import Settings
from .extraction import (
    ExtractedContent,
    ExtractedContentTooLarge,
    ExtractionError,
    extract_docx,
    extract_html,
    extract_pdf,
    has_usable_text,
    is_docx,
)
from .fetch import FetchError, FetchedResource, fetch_url
from .models import ExtractFailure, ExtractResponse, ExtractSuccess, WorkerErrorCode


SOCIAL_HOSTS = {
    "facebook.com",
    "instagram.com",
    "linkedin.com",
    "t.me",
    "telegram.me",
    "twitter.com",
    "vk.com",
    "x.com",
}
HTML_CONTENT_TYPES = {"text/html", "application/xhtml+xml"}
DOCX_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"


def _hostname(url: str) -> str:
    return (urlsplit(url).hostname or "").lower().rstrip(".")


def _host_matches(hostname: str, domain: str) -> bool:
    return hostname == domain or hostname.endswith(f".{domain}")


def _is_social_url(url: str) -> bool:
    hostname = _hostname(url)
    return any(_host_matches(hostname, domain) for domain in SOCIAL_HOSTS)


def _is_google_doc(url: str) -> bool:
    parsed = urlsplit(url)
    return _host_matches((parsed.hostname or "").lower(), "docs.google.com") and parsed.path.startswith(
        "/document/"
    )


def _google_doc_export_url(url: str) -> str | None:
    parsed = urlsplit(url)
    match = re.match(r"^/document/(?:u/\d+/)?d/([A-Za-z0-9_-]+)(?:/|$)", parsed.path)
    if not match or match.group(1) == "e":
        return None
    document_id = match.group(1)
    return f"https://docs.google.com/document/d/{document_id}/export?format=docx"


def _google_drive_file_download_url(url: str) -> str | None:
    parsed = urlsplit(url)
    if _hostname(url) != "drive.google.com":
        return None
    match = re.fullmatch(r"/file/d/([A-Za-z0-9_-]+)/(?:view|preview)/?", parsed.path)
    if not match:
        return None
    return f"https://drive.google.com/uc?export=download&id={match.group(1)}"


def _is_notion_url(url: str) -> bool:
    hostname = _hostname(url)
    return _host_matches(hostname, "notion.so") or _host_matches(hostname, "notion.site")


def _source_hint(url: str) -> str:
    if _is_google_doc(url):
        return "google_doc"
    if _google_drive_file_download_url(url):
        return "google_drive_file"
    if _is_notion_url(url):
        return "notion"
    suffix = PurePosixPath(urlsplit(url).path).suffix.lower()
    if suffix == ".pdf":
        return "pdf"
    if suffix == ".docx":
        return "docx"
    return "html"


def _content_type(resource: FetchedResource) -> str:
    return resource.headers.get("content-type", "").split(";", 1)[0].strip().lower()


def _detected_source_type(resource: FetchedResource, url: str) -> str | None:
    content_type = _content_type(resource)
    content_start = resource.content.lstrip()[:32].lower()
    suffix = PurePosixPath(urlsplit(url).path).suffix.lower()
    if content_type == "application/pdf" or suffix == ".pdf" or resource.content.startswith(b"%PDF-"):
        return "pdf"
    if content_type == DOCX_CONTENT_TYPE or suffix == ".docx" or is_docx(resource.content):
        return "docx"
    if content_type in HTML_CONTENT_TYPES or content_start.startswith((b"<!doctype html", b"<html")):
        return "html"
    return None


def _failure(
    source_type: str,
    code: WorkerErrorCode,
    message: str,
    *,
    broken: bool = False,
) -> ExtractFailure:
    return ExtractFailure(
        status="broken" if broken else "extraction_failed",
        source_type=source_type,
        error_code=code,
        error_message=message,
        warnings=[],
    )


def _success(
    source_type: str, extracted: ExtractedContent, extraction_method: str
) -> ExtractSuccess:
    return ExtractSuccess(
        source_type=source_type,
        title=extracted.title,
        text=extracted.text,
        links=extracted.links,
        extraction_method=extraction_method,
        warnings=[],
    )


def _http_failure(resource: FetchedResource, source_type: str) -> ExtractFailure | None:
    if resource.status_code in {404, 410}:
        return _failure(
            source_type,
            WorkerErrorCode.LINK_BROKEN,
            f"Confirmed HTTP {resource.status_code}",
            broken=True,
        )
    if resource.status_code >= 400:
        return _failure(
            source_type,
            WorkerErrorCode.FETCH_FAILED,
            f"Source returned HTTP {resource.status_code}",
        )
    return None


async def _extract_html_with_fallback(
    resource: FetchedResource,
    source_type: str,
    settings: Settings,
) -> ExtractResponse:
    extracted = extract_html(resource.content, resource.url, settings.max_extracted_chars)
    if has_usable_text(extracted.text):
        return _success(source_type, extracted, "http")

    try:
        rendered_html = await fetch_browserless_html(resource.url, settings)
    except BrowserlessError as exc:
        return _failure(source_type, exc.code, exc.message)

    rendered = extract_html(rendered_html, resource.url, settings.max_extracted_chars)
    if not has_usable_text(rendered.text):
        return _failure(
            source_type,
            WorkerErrorCode.EXTRACTION_FAILED,
            "Unable to obtain usable HTML content after one Browserless fallback",
        )
    return _success(source_type, rendered, "browserless")


async def extract_source(url: str, settings: Settings) -> ExtractResponse:
    """Fetch and extract one supported source without applying business policy."""

    if _is_social_url(url):
        return _failure(
            "social",
            WorkerErrorCode.UNSUPPORTED_SOURCE,
            "Social-network sources are not supported",
        )

    source_hint = _source_hint(url)
    fetch_target = _google_doc_export_url(url) if source_hint == "google_doc" else None
    fetch_target = fetch_target or url

    try:
        resource = await fetch_url(fetch_target, settings)
    except FetchError as exc:
        # A non-existent domain is as dead as a confirmed 404.
        return _failure(
            source_hint, exc.code, exc.message, broken=exc.code is WorkerErrorCode.LINK_BROKEN
        )

    http_failure = _http_failure(resource, source_hint)
    if http_failure is not None:
        return http_failure

    drive_download_url = _google_drive_file_download_url(url)
    if drive_download_url and _detected_source_type(resource, url) not in {"pdf", "docx"}:
        # The /file/d/ viewer is HTML chrome, not the underlying file.
        try:
            resource = await fetch_url(drive_download_url, settings)
        except FetchError as exc:
            return _failure(source_hint, exc.code, exc.message)
        if resource.status_code >= 400:
            # A failure of the derived download URL does not prove the shared viewer is broken.
            return _failure(
                source_hint,
                WorkerErrorCode.FETCH_FAILED,
                f"Drive download returned HTTP {resource.status_code}",
            )
        if _detected_source_type(resource, url) not in {"pdf", "docx"}:
            return _failure(
                source_hint,
                WorkerErrorCode.EXTRACTION_FAILED,
                "Drive download did not return supported document content",
            )

    detected_type = None
    try:
        if source_hint == "google_doc" and fetch_target != url:
            if not is_docx(resource.content):
                return _failure(
                    "google_doc",
                    WorkerErrorCode.EXTRACTION_FAILED,
                    "Public Google Docs export did not return DOCX content",
                )
            extracted = extract_docx(
                resource.content,
                settings.max_extracted_chars,
                settings.max_download_bytes,
            )
            if not has_usable_text(extracted.text):
                raise ExtractionError("Google Docs export contained no usable text")
            return _success("google_doc", extracted, "google_docs_export")

        detected_type = _detected_source_type(resource, url)
        if detected_type is None:
            return _failure(
                source_hint,
                WorkerErrorCode.UNSUPPORTED_SOURCE,
                f"Unsupported content type: {_content_type(resource) or 'unknown'}",
            )

        if detected_type == "html":
            html_source_type = source_hint if source_hint in {"google_doc", "notion"} else "html"
            return await _extract_html_with_fallback(resource, html_source_type, settings)
        if detected_type == "pdf":
            extracted = extract_pdf(resource.content, settings.max_extracted_chars)
            if not has_usable_text(extracted.text):
                raise ExtractionError("PDF contains no embedded text")
            return _success("pdf", extracted, "pypdf")
        if detected_type == "docx":
            extracted = extract_docx(
                resource.content,
                settings.max_extracted_chars,
                settings.max_download_bytes,
            )
            if not has_usable_text(extracted.text):
                raise ExtractionError("DOCX contains no usable text")
            return _success("docx", extracted, "python-docx")
    except ExtractedContentTooLarge as exc:
        return _failure(detected_type or source_hint, WorkerErrorCode.CONTENT_TOO_LARGE, str(exc))
    except ExtractionError as exc:
        return _failure(detected_type or source_hint, WorkerErrorCode.EXTRACTION_FAILED, str(exc))
    except Exception:
        return _failure(
            source_hint,
            WorkerErrorCode.EXTRACTION_FAILED,
            "Unable to extract supported source content",
        )

    return _failure(
        source_hint,
        WorkerErrorCode.EXTRACTION_FAILED,
        "Unable to extract supported source content",
    )
