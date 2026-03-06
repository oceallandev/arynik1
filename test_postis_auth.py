import asyncio
import os

import httpx
import pytest
from dotenv import load_dotenv

load_dotenv("backend/.env")

pytestmark = pytest.mark.integration


def _live_enabled() -> bool:
    return str(os.getenv("RUN_POSTIS_LIVE_TESTS", "")).strip().lower() in {"1", "true", "yes", "on"}


def test_postis_login():
    if not _live_enabled():
        pytest.skip("Set RUN_POSTIS_LIVE_TESTS=1 to run live Postis tests")

    username = os.getenv("POSTIS_USERNAME")
    password = os.getenv("POSTIS_PASSWORD")
    if not username or not password:
        pytest.skip("POSTIS_USERNAME/POSTIS_PASSWORD not configured")

    async def _run() -> bool:
        auth_urls = [
            "https://shipments.postisgate.com/unauthenticated/login",
            "https://shipments.postisgate.com/api/v3/users:login",
        ]
        payloads = [
            {"name": username, "password": password},
            {"username": username, "password": password},
        ]

        async with httpx.AsyncClient(timeout=20.0) as client:
            for url in auth_urls:
                for payload in payloads:
                    response = await client.post(url, json=payload, headers={"accept": "application/json"})
                    if response.status_code != 200:
                        continue
                    try:
                        body = response.json()
                    except Exception:
                        body = {}
                    token = body.get("token") if isinstance(body, dict) else None
                    if token:
                        return True
        return False

    assert asyncio.run(_run()), "No Postis login endpoint returned a token"
