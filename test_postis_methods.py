import asyncio
import os
import httpx
from backend.postis_client import PostisClient
from dotenv import load_dotenv

load_dotenv("backend/.env")

POSTIS_BASE_URL = "https://shipments.postisgate.com"
POSTIS_USER = os.getenv("POSTIS_USERNAME")
POSTIS_PASS = os.getenv("POSTIS_PASSWORD")

async def test_methods():
    client = PostisClient(POSTIS_BASE_URL, POSTIS_USER, POSTIS_PASS)
    print(f"Logging in as {POSTIS_USER}...")
    token = await client.login()
    
    endpoints = [
        ("GET", "/api/v1/clients/shipments"),
        ("POST", "/api/v1/clients/shipments"),
        ("GET", "/api/v1/clients/shipments/search"),
        ("POST", "/api/v1/clients/shipments/search"),
        ("GET", "/api/v1/clients/shipments/filter"),
        ("POST", "/api/v1/clients/shipments/filter"),
        ("GET", "/api/v2/clients/shipments"),
        ("POST", "/api/v2/clients/shipments"),
        ("POST", "/api/v1/clients/shipments/trace")
    ]
    
    headers = {
        "Authorization": f"Bearer {token}",
        "accept": "application/json",
        "Content-Type": "application/json"
    }

    async with httpx.AsyncClient() as h_client:
        for method, path in endpoints:
            url = f"{POSTIS_BASE_URL}{path}"
            print(f"\nTesting {method} {path}...")
            try:
                if method == "GET":
                    response = await h_client.get(url, headers=headers, params={"pageSize": 10})
                else:
                    # Try with both empty dict and a simple filter if it's a search/filter endpoint
                    payload = {}
                    if "search" in path or "filter" in path or "shipments" in path:
                         payload = {"pageSize": 10, "pageNumber": 1}
                    
                    response = await h_client.post(url, headers=headers, json=payload)
                
                print(f"Response: {response.status_code}")
                if response.status_code == 200:
                    try:
                        data = response.json()
                        count = len(data) if isinstance(data, list) else (len(data.get("items", [])) if isinstance(data, dict) else "unknown")
                        print(f"SUCCESS! Found entries: {count}")
                        # print(f"Preview: {str(data)[:200]}")
                    except:
                        print("SUCCESS! (But response not JSON)")
                else:
                    print(f"Failed: {response.text[:200]}")
            except Exception as e:
                print(f"Error: {str(e)}")

if __name__ == "__main__":
    asyncio.run(test_methods())
