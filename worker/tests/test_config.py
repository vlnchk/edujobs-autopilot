import pytest

from app.config import ConfigurationError, Settings


def test_settings_read_all_resource_limits_from_environment() -> None:
    settings = Settings.from_env(
        {
            "FETCH_TIMEOUT_SECONDS": "2.5",
            "MAX_REDIRECTS": "1",
            "MAX_DOWNLOAD_BYTES": "4096",
            "MAX_EXTRACTED_CHARS": "2048",
            "BROWSERLESS_URL": "http://renderer:3000/content",
        }
    )

    assert settings == Settings(
        fetch_timeout_seconds=2.5,
        max_redirects=1,
        max_download_bytes=4096,
        max_extracted_chars=2048,
        browserless_url="http://renderer:3000/content",
    )


@pytest.mark.parametrize(
    ("name", "value"),
    [
        ("FETCH_TIMEOUT_SECONDS", "0"),
        ("MAX_REDIRECTS", "-1"),
        ("MAX_DOWNLOAD_BYTES", "not-an-integer"),
        ("MAX_EXTRACTED_CHARS", "0"),
        ("BROWSERLESS_URL", " "),
    ],
)
def test_invalid_resource_limits_fail_configuration(name: str, value: str) -> None:
    with pytest.raises(ConfigurationError):
        Settings.from_env({name: value})
