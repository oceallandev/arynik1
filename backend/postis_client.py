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
        """Update shipment status using Postis API v1 (by AWB)."""
        token = await self.get_token()
        url = f"https://shipments.postisgate.com/api/v1/clients/shipments/byawb/{awb}"
        headers = {
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
            "accept": "application/json",
        }

        update_payload: Dict[str, Any] = {
            "eventId": str(event_id),
            "eventDate": details.get("eventDate", datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S")),
            "eventDescription": details.get("eventDescription", "Status update from Driver App"),
        }

        # Optional fields (only include if present)
        if details.get("localityName"):
            update_payload["localityName"] = details.get("localityName")

        courier_info: Dict[str, Any] = {}
        if details.get("driverName"):
            courier_info["driverName"] = details.get("driverName")
        if details.get("driverPhoneNumber"):
            courier_info["driverPhoneNumber"] = details.get("driverPhoneNumber")
        if details.get("truckNumber"):
            courier_info["truckNumber"] = details.get("truckNumber")
        if courier_info:
            update_payload["courierAdditionalInformation"] = courier_info

        async with httpx.AsyncClient(timeout=60.0) as client:
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
        
        async with httpx.AsyncClient(timeout=60.0) as client:
            try:
                response = await client.get(url, headers=headers)
                response.raise_for_status()
                data = response.json()
                if isinstance(data, list) and len(data) > 0:
                    return data[0]
                return data if isinstance(data, dict) else {}
            except httpx.HTTPStatusError as e:
                if e.response.status_code == 401:
                    logger.info("Postis token expired while fetching tracking, retrying login")
                    await self.login()
                    return await self.get_shipment_tracking(awb)
                logger.error(f"Postis fetch tracking failed for {awb}: {e.response.text}")
                return {}
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
        
        async with httpx.AsyncClient(timeout=60.0) as client:
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
            except httpx.HTTPStatusError as e:
                if e.response.status_code == 401:
                    logger.info("Postis token expired while fetching shipments, retrying login")
                    await self.login()
                    return await self.get_shipments(limit=limit)
                logger.error(f"Postis fetch shipments failed: {e.response.text}")
                return []
            except Exception as e:
                logger.error(f"Postis fetch shipments failed: {str(e)}")
                return []

    async def get_shipment_label(self, awb: str) -> Optional[bytes]:
        """Fetch the shipment label PDF from Postis.

        Notes (observed behavior):
        - The v1 label endpoint returns the PDF when the client sends `accept: */*`.
        - Sending `accept: application/pdf` may return HTTP 406 even though the PDF exists.
        """
        token = await self.get_token()

        v1_url = f"https://shipments.postisgate.com/api/v1/clients/shipments/{awb}/label"
        v3_url = f"https://shipments.postisgate.com/api/v3/shipments/labels/{awb}?type=PDF"

        async with httpx.AsyncClient(timeout=60.0) as client:
            try:
                # Prefer v1 for compatibility (works for our client), with accept */* to avoid 406.
                v1_headers = {
                    "Authorization": f"Bearer {token}",
                    "accept": "*/*",
                }
                v1_response = await client.get(v1_url, headers=v1_headers)
                if v1_response.status_code == 401:
                    logger.info("Postis token expired while fetching label, retrying login")
                    await self.login()
                    token = await self.get_token()
                    v1_headers["Authorization"] = f"Bearer {token}"
                    v1_response = await client.get(v1_url, headers=v1_headers)

                if v1_response.status_code == 200 and v1_response.content.startswith(b"%PDF"):
                    return v1_response.content

                # Fall back to v3 for accounts that support it.
                v3_headers = {
                    "Authorization": f"Bearer {token}",
                    "Content-Type": "application/json",
                    "accept": "*/*",
                }
                v3_body = {"dpi": 203}
                v3_response = await client.post(v3_url, headers=v3_headers, json=v3_body)
                if v3_response.status_code == 401:
                    logger.info("Postis token expired while fetching label (v3), retrying login")
                    await self.login()
                    token = await self.get_token()
                    v3_headers["Authorization"] = f"Bearer {token}"
                    v3_response = await client.post(v3_url, headers=v3_headers, json=v3_body)

                if v3_response.status_code == 200 and v3_response.content.startswith(b"%PDF"):
                    return v3_response.content

                logger.warning(
                    f"Label fetch failed for {awb}: "
                    f"v1_status={v1_response.status_code} v1_ct={v1_response.headers.get('content-type')} "
                    f"v3_status={v3_response.status_code} v3_ct={v3_response.headers.get('content-type')}"
                )
                return None
            except Exception as e:
                logger.error(f"Failed to fetch label for {awb}: {str(e)}")
                return None

    # NOTE: update_awb_status is defined once above. Keep this section for future Postis methods.
