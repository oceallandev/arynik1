import asyncio
import os
import httpx
from backend.postis_client import PostisClient
from dotenv import load_dotenv

load_dotenv("backend/.env")

POSTIS_BASE_URL = "https://shipments.postisgate.com"
POSTIS_USER = os.getenv("POSTIS_USERNAME")
POSTIS_PASS = os.getenv("POSTIS_PASSWORD")

async def test_fetch():
    client = PostisClient(POSTIS_BASE_URL, POSTIS_USER, POSTIS_PASS)
    print(f"Logging in as {POSTIS_USER}...")
    token = await client.login()
    print("Login successful")
    
    print("Fetching shipments (using GET v2)...")
    try:
        url = f"{client.base_url}/api/v2/clients/shipments"
        headers = {
            "Authorization": f"Bearer {token}",
            "accept": "application/json"
        }
        params = {
            "pageSize": 20,
            "pageNumber": 1
        }
        async with httpx.AsyncClient() as h_client:
            response = await h_client.get(url, headers=headers, params=params)
            print(f"GET v2 Response: {response.status_code}")
            if response.status_code == 200:
                shipments = response.json()
                print(f"Found {len(shipments)} shipments via v2")
            else:
                print(f"GET v2 failed: {response.text}")
                shipments = []
    except Exception as e:
        print(f"GET v2 error: {str(e)}")
        shipments = []
    
    for s in shipments:
        print(f"AWB: {s.get('awb')} - Status: {s.get('status')} - Recipient: {s.get('recipient_name')}")

if __name__ == "__main__":
    asyncio.run(test_fetch())
