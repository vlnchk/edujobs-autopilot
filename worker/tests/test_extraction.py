import pytest

from app.extraction import (
    ExtractedContentTooLarge,
    extract_docx,
    extract_html,
    extract_pdf,
    has_usable_text,
)


def test_html_cleanup_preserves_structure_and_useful_links() -> None:
    content = b"""
    <html>
      <head><title>Methodologist</title><style>.hidden{}</style></head>
      <body>
        <header>Site chrome</header>
        <main>
          <h1>Learning Team</h1>
          <p>Build curricula and support instructors.</p>
          <ul><li>Remote</li><li>Full time</li></ul>
          <a href="/apply">Apply</a>
          <a href="javascript:alert(1)">Ignore</a>
          <script>ignore()</script>
        </main>
        <footer>Footer chrome</footer>
      </body>
    </html>
    """

    result = extract_html(content, "https://example.com/jobs/1", 1_000)

    assert result.title == "Methodologist"
    assert result.text == (
        "# Learning Team\n\n"
        "Build curricula and support instructors.\n\n"
        "- Remote\n\n"
        "- Full time"
    )
    assert result.links == ["https://example.com/apply"]
    assert "Site chrome" not in result.text
    assert "ignore" not in result.text


def test_html_raises_instead_of_truncating_oversized_text() -> None:
    with pytest.raises(ExtractedContentTooLarge):
        extract_html(b"<html><body><p>1234567890</p></body></html>", "https://example.com", 5)


def test_html_preserves_meaningful_header_inside_main() -> None:
    result = extract_html(
        b"<html><body><main><header><h1>Vacancy title</h1></header><p>Role details</p></main></body></html>",
        "https://example.com",
        1_000,
    )

    assert result.text == "# Vacancy title\n\nRole details"


def test_pdf_extracts_embedded_text(pdf_bytes) -> None:
    result = extract_pdf(pdf_bytes, 1_000)

    assert "Embedded vacancy text" in result.text


def test_pdf_raises_instead_of_truncating_oversized_text(pdf_bytes) -> None:
    with pytest.raises(ExtractedContentTooLarge):
        extract_pdf(pdf_bytes, 5)


def test_docx_preserves_heading_and_paragraphs(docx_bytes) -> None:
    result = extract_docx(docx_bytes, 1_000, 1_000_000)

    assert result.title == "Methodologist"
    assert result.text == "# Learning Team\n\nDevelop courses and support instructors."


def test_docx_raises_instead_of_truncating_oversized_text(docx_bytes) -> None:
    with pytest.raises(ExtractedContentTooLarge):
        extract_docx(docx_bytes, 5, 1_000_000)


@pytest.mark.parametrize(
    "placeholder",
    [
        "Loading...",
        "Please wait while the document loads…",
        "Подождите, пожалуйста...",
        "Идёт загрузка…",
        "מתבצעת טעינה…",
        "נא להמתין...",
    ],
)
def test_loading_placeholders_are_not_usable_content(placeholder: str) -> None:
    assert has_usable_text(placeholder) is False


@pytest.mark.parametrize(
    "content",
    [
        "Teacher",
        "Ищем преподавателя.",
        "Загрузка учебных материалов входит в обязанности.",
        "מתבצעת טעינה של חומרי לימוד במסגרת התפקיד.",
    ],
)
def test_short_substantive_content_remains_usable(content: str) -> None:
    assert has_usable_text(content) is True
