import asyncio
import os
import httpx
import pytest
from backend.postis_client import PostisClient
from dotenv import load_dotenv

load_dotenv("backend/.env")

POSTIS_BASE_URL = "https://shipments.postisgate.com"
POSTIS_USER = os.getenv("POSTIS_USERNAME")
POSTIS_PASS = os.getenv("POSTIS_PASSWORD")

pytestmark = pytest.mark.integration


def _live_enabled() -> bool:
    return str(os.getenv("RUN_POSTIS_LIVE_TESTS", "")).strip().lower() in {"1", "true", "yes", "on"}


def test_v3_export():
    if not _live_enabled():
        pytest.skip("Set RUN_POSTIS_LIVE_TESTS=1 to run live Postis tests")
    if not POSTIS_USER or not POSTIS_PASS:
        pytest.skip("POSTIS_USERNAME/POSTIS_PASSWORD not configured")

    async def _run() -> None:
        client = PostisClient(POSTIS_BASE_URL, POSTIS_USER, POSTIS_PASS)
        token = await client.login()
        assert token

        # v3 shipments list is hosted on stats subdomain.
        url = "https://stats.postisgate.com/api/v3/shipments"
        async with httpx.AsyncClient(timeout=20.0) as h_client:
            response = await h_client.get(
                url,
                params={"size": 5, "page": 1},
                headers={"Authorization": f"Bearer {token}", "accept": "application/json"},
            )

        assert response.status_code == 200
        payload = response.json()
        assert isinstance(payload, dict)
        assert isinstance(payload.get("items"), list)

    asyncio.run(_run())
