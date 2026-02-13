import httpx
import logging
from typing import Optional, Dict, Any, List
from datetime import datetime

logger = logging.getLogger(__name__)

class PostisClient:
    def __init__(self, base_url: str, username: str, password: str):
        self.base_url = base_url
        self.username = username
        self.password = password
        self.token: Optional[str] = None
        self.stats_base_url = "https://stats.postisgate.com" # v3 stats endpoint submodule

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
                if response.status_code == 204 or not response.text:
                    return {"status": "success", "message": "Updated successfully (no response body)"}
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
                data = response.json()
                if isinstance(data, list) and len(data) > 0:
                    return data[0]
                return data if isinstance(data, dict) else {}
            except Exception as e:
                logger.error(f"Postis fetch tracking failed for {awb}: {str(e)}")
                return {}

    async def get_shipments(self, limit: int = 100) -> List[Dict[str, Any]]:
        token = await self.get_token()
        # Official v3 List Endpoint (Found on stats subdomain)
        url = f"{self.stats_base_url}/api/v3/shipments"
        params = {
            "size": limit,
            "page": 1
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
                
                # v3 returns a dict with 'items' key
                if isinstance(data, dict):
                    return data.get("items", [])
                elif isinstance(data, list):
                    return data
                return []
            except Exception as e:
                logger.error(f"Postis fetch shipments failed: {str(e)}")
                return []

    async def get_shipment_label(self, awb: str) -> Optional[bytes]:
        """Fetch the shipment label PDF from Postis API v3."""
        token = await self.get_token()
        # Postis v3 Label endpoint
        url = f"https://shipments.postisgate.com/api/v3/shipments/labels/{awb}?type=PDF"
        headers = {
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json"
        }
        body = {"dpi": 203}
        
        async with httpx.AsyncClient() as client:
            try:
                # v3 uses POST for labels
                response = await client.post(url, headers=headers, json=body)
                if response.status_code == 406:
                    logger.warning(f"Label v3 failed (406) for {awb}, falling back to v1 GET")
                    # Fallback to v1 if v3 is not supported for this client
                    v1_url = f"https://shipments.postisgate.com/api/v1/clients/shipments/{awb}/label"
                    v1_headers = {"Authorization": f"Bearer {token}", "Accept": "application/pdf"}
                    response = await client.get(v1_url, headers=v1_headers)

                response.raise_for_status()
                return response.content
            except Exception as e:
                logger.error(f"Failed to fetch label for {awb}: {str(e)}")
                return None

    async def update_awb_status(self, awb: str, event_id: str, details: dict) -> dict:
        """Update shipment status using Postis API v1."""
        token = await self.get_token()
        # Postis v1 Status Update (PUT by AWB)
        url = f"https://shipments.postisgate.com/api/v1/clients/shipments/byawb/{awb}"
        headers = {
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json"
        }
        
        # eventDate must be ISO format
        event_date = details.get("eventDate") or datetime.utcnow().isoformat()
        
        payload = {
            "eventId": str(event_id),
            "eventDate": event_date,
            "eventDescription": details.get("eventDescription") or f"Status updated via AryNik App by {details.get('driverName', 'Driver')}"
        }
        
        async with httpx.AsyncClient() as client:
            try:
                response = await client.put(url, headers=headers, json=payload)
                response.raise_for_status()
                return response.json()
            except Exception as e:
                logger.error(f"Postis status update failed for {awb}: {str(e)}")
                raise
