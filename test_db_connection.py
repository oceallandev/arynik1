import os
import psycopg2
import pytest
from dotenv import load_dotenv
from urllib.parse import urlsplit, urlunsplit

load_dotenv("backend/.env")

def _mask_db_url(value: str) -> str:
    if not value:
        return value
    try:
        parts = urlsplit(value)
        if not parts.scheme or not parts.netloc:
            return value

        hostname = parts.hostname or ""
        if parts.port:
            hostname = f"{hostname}:{parts.port}"

        user = parts.username or ""
        netloc = hostname
        if user:
            netloc = f"{user}:***@{hostname}"

        return urlunsplit((parts.scheme, netloc, parts.path, parts.query, parts.fragment))
    except Exception:
        return value

def _live_enabled() -> bool:
    return str(os.getenv("RUN_DB_LIVE_TESTS", "")).strip().lower() in {"1", "true", "yes", "on"}


def test_mask_db_url_hides_password():
    masked = _mask_db_url("postgresql://user:secret@example.com:5432/postgres")
    assert masked == "postgresql://user:***@example.com:5432/postgres"


@pytest.mark.integration
def test_postgres_connection():
    if not _live_enabled():
        pytest.skip("Set RUN_DB_LIVE_TESTS=1 to run live DB tests")

    url = os.getenv("DATABASE_URL", "")
    if not url.startswith("postgresql://"):
        pytest.skip("DATABASE_URL is not a PostgreSQL URL")

    conn = psycopg2.connect(url, connect_timeout=10)
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT 1;")
            assert cur.fetchone()[0] == 1
    finally:
        conn.close()
