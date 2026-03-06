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


def test_methods():
    if not _live_enabled():
        pytest.skip("Set RUN_POSTIS_LIVE_TESTS=1 to run live Postis tests")
    if not POSTIS_USER or not POSTIS_PASS:
        pytest.skip("POSTIS_USERNAME/POSTIS_PASSWORD not configured")

    async def _run() -> None:
        client = PostisClient(POSTIS_BASE_URL, POSTIS_USER, POSTIS_PASS)
        token = await client.login()
        assert token

        # Direct API smoke check with bearer token.
        async with httpx.AsyncClient(timeout=20.0) as h_client:
            response = await h_client.get(
                f"{POSTIS_BASE_URL}/api/v1/clients/shipments",
                headers={"Authorization": f"Bearer {token}", "accept": "application/json"},
                params={"pageSize": 5, "pageNumber": 1},
            )
            assert response.status_code in {200, 204}

        # Client helper smoke check.
        shipments = await client.get_shipments(limit=5, page=1)
        assert isinstance(shipments, list)
        if shipments:
            awb = str((shipments[0] or {}).get("awb") or "").strip()
            if awb:
                details = await client.get_shipment_tracking_by_awb_or_client_order_id(awb)
                assert isinstance(details, dict)

    asyncio.run(_run())
