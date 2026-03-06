import requests
import pytest

sheet_url = "https://docs.google.com/spreadsheets/d/1jjX0Qdi9JEVs2wodFqK56yD5WqYVwL1KYjUrHMQBS0A/edit#gid=0"

def get_csv_url(url):
    if "edit#gid=" in url:
        return url.replace("edit#gid=", "export?format=csv&gid=")
    elif "/edit" in url:
        return url.replace("/edit", "/export?format=csv")
    return url

def _live_enabled() -> bool:
    import os
    return str(os.getenv("RUN_SHEETS_LIVE_TESTS", "")).strip().lower() in {"1", "true", "yes", "on"}


def test_get_csv_url_from_gid_url():
    converted = get_csv_url(sheet_url)
    assert converted.endswith("/export?format=csv&gid=0")


def test_get_csv_url_from_edit_url():
    src = "https://docs.google.com/spreadsheets/d/abc123/edit"
    assert get_csv_url(src) == "https://docs.google.com/spreadsheets/d/abc123/export?format=csv"


@pytest.mark.integration
def test_fetch_csv_url_live():
    if not _live_enabled():
        pytest.skip("Set RUN_SHEETS_LIVE_TESTS=1 to run live Google Sheets tests")

    csv_url = get_csv_url(sheet_url)
    response = requests.get(csv_url, timeout=20)
    assert response.status_code == 200
    assert "driver" in response.text.lower() or "," in response.text
