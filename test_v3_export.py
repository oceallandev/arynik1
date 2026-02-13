import asyncio
import os
import httpx
from backend.postis_client import PostisClient
from dotenv import load_dotenv
from datetime import datetime, timedelta

load_dotenv("backend/.env")

POSTIS_BASE_URL = "https://shipments.postisgate.com"
POSTIS_USER = os.getenv("POSTIS_USERNAME")
POSTIS_PASS = os.getenv("POSTIS_PASSWORD")

async def test_v3_export():
    client = PostisClient(POSTIS_BASE_URL, POSTIS_USER, POSTIS_PASS)
    print(f"Logging in as {POSTIS_USER}...")
    token = await client.login()
    
    print(f"\nTesting GET /api/v3/shipments:exportCsv (broader headers)...")
    async with httpx.AsyncClient() as h_client:
        try:
            # Try without strict params first, just to see if it responds
            response = await h_client.get(url, headers={"Authorization": f"Bearer {token}", "accept": "*/*"})
            print(f"Response: {response.status_code}")
            if response.status_code == 200:
                print("SUCCESS! Received data.")
                print(f"Preview: {response.text[:200]}")
            else:
                print(f"Failed: {response.text[:500]}")
        except Exception as e:
            print(f"Error: {str(e)}")

if __name__ == "__main__":
    asyncio.run(test_v3_export())
