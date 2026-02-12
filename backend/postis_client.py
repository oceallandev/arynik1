import httpx
import logging
from typing import Optional, Dict, Any
from datetime import datetime

logger = logging.getLogger(__name__)

class PostisClient:
    def __init__(self, base_url: str, username: str, password: str):
        self.base_url = base_url
        self.username = username
        self.password = password
        self.token: Optional[str] = None

    async def login(self) -> str:
        # Verified Official Working Endpoint
        url = "https://shipments.postisgate.com/unauthenticated/login"
        payload = {
            "name": self.username, # Per verified spec
            "password": self.password
        }
        async with httpx.AsyncClient() as client:
            try:
                response = await client.post(url, json=payload, headers={"accept": "*/*"})
                response.raise_for_status()
                data = response.json()
                self.token = data.get("token")
                logger.info("Successfully authenticated with Postis")
                return self.token
            except httpx.HTTPStatusError as e:
                logger.error(f"Postis login failed: {e.response.text}")
                raise Exception(f"Postis authentication failed: {e.response.status_code}")
            except Exception as e:
                logger.error(f"Postis login error: {str(e)}")
                raise e

    async def get_token(self) -> str:
        if not self.token:
            return await self.login()
        return self.token

    async def update_awb_status(self, awb: str, event_id: str, details: Dict[str, Any]) -> Dict[str, Any]:
        token = await self.get_token()
        # Verified Official PUT Endpoint
        url = f"https://shipments.postisgate.com/api/v1/clients/shipments/byawb/{awb}"
        headers = {
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json"
        }
        
        # Verified Payload Structure
        update_payload = {
            "eventId": event_id,
            "eventDate": details.get("eventDate", datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S")),
            "eventDescription": details.get("eventDescription", "Status update from Driver App"),
            "localityName": details.get("localityName", "Unknown"),
            "courierAdditionalInformation": {
                "driverName": details.get("driverName", "Postis Driver"),
                "driverPhoneNumber": details.get("driverPhoneNumber", ""),
                "truckNumber": details.get("truckNumber", "")
            }
        }
        
        async with httpx.AsyncClient() as client:
            try:
                response = await client.put(url, json=update_payload, headers=headers)
                response.raise_for_status()
                return response.json()
            except httpx.HTTPStatusError as e:
                if e.response.status_code == 401:
                    logger.info("Postis token expired, retrying login")
                    await self.login()
                    return await self.update_awb_status(awb, event_id, details)
                logger.error(f"Postis update failed for AWB {awb}: {e.response.text}")
                raise e
            except Exception as e:
                logger.error(f"Postis update error: {str(e)}")
                raise e

    async def get_shipment_tracking(self, awb: str) -> Dict[str, Any]:
        token = await self.get_token()
        # Verified GET endpoint from user's Apps Script
        url = f"https://shipments.postisgate.com/api/v1/clients/shipments/byawb/{awb}"
        headers = {
            "Authorization": f"Bearer {token}",
            "accept": "application/json"
        }
        
        async with httpx.AsyncClient() as client:
            try:
                response = await client.get(url, headers=headers)
                response.raise_for_status()
                return response.json()
            except Exception as e:
                logger.error(f"Postis fetch tracking failed for {awb}: {str(e)}")
                return {}

    async def get_shipments(self, limit: int = 100) -> List[Dict[str, Any]]:
        token = await self.get_token()
        # Official List Endpoint
        url = "https://shipments.postisgate.com/api/v1/clients/shipments"
        params = {
            "pageSize": limit,
            "pageNumber": 1,
            "sortBy": "CreatedAt",
            "sortOrder": "Desc"
        }
        headers = {
            "Authorization": f"Bearer {token}",
            "accept": "application/json"
        }
        
        async with httpx.AsyncClient() as client:
            try:
                response = await client.get(url, headers=headers, params=params)
                response.raise_for_status()
                data = response.json()
                # Postis often returns a list directly or inside a 'shipments' key
                if isinstance(data, list):
                    return data
                return data.get("items", []) or data.get("shipments", [])
            except Exception as e:
                logger.error(f"Postis fetch shipments failed: {str(e)}")
                return []
from typing import List
