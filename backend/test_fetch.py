import asyncio
import os
from dotenv import load_dotenv

load_dotenv("backend/.env")

from backend.postis_client import PostisClient

async def main():
    api = PostisClient(
        base_url=os.getenv("POSTIS_BASE_URL", "https://shipments.postisgate.com"),
        username=os.getenv("POSTIS_USERNAME", "localflnbc01"),
        password=os.getenv("POSTIS_PASSWORD", "trudimmult")
    )
    ship = await api.get_shipment_tracking_by_awb_or_client_order_id("313r003746001")
    if ship:
        print("STATUS:", ship.get("clientShipmentStatus", {}))
    else:
        print("Shipment not found on Postis")

asyncio.run(main())
