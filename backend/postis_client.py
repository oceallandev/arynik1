import httpx
import logging
import re
from typing import Optional, Dict, Any, List
from datetime import datetime

logger = logging.getLogger(__name__)

_NON_ALNUM_RE = re.compile(r"[^A-Z0-9]+")


def normalize_shipment_identifier(value: str) -> str:
    """Best-effort normalization for scanned barcodes / AWB / order ids."""
    raw = str(value or "").strip().upper()
    raw = re.sub(r"\s+", "", raw)
    raw = _NON_ALNUM_RE.sub("", raw)
    return raw


def candidates_with_optional_parcel_suffix_stripped(value: str) -> List[str]:
    """
    Return a list of candidate identifiers to try against Postis.

    Some parcel labels encode an extra 3-digit suffix (001, 002, ...).
    We try both the raw normalized value and the value with the suffix removed.
    """
    norm = normalize_shipment_identifier(value)
    if not norm:
        return []

    out = [norm]

    # Only strip if it looks like a parcel suffix (001, 002, ...). We bias to stripping only when
    # the identifier contains letters (typical for AWB formats) so we don't accidentally mangle
    # numeric order ids. Keep a minimum core length so we don't mangle short identifiers.
    if len(norm) >= 11 and any("A" <= ch <= "Z" for ch in norm) and norm[-3:].isdigit() and norm[-3:] != "000":
        core = norm[:-3]
        if len(core) >= 8 and core not in out:
            out.append(core)

    return out


class PostisClient:
    def __init__(self, base_url: str, username: str, password: str):
        self.base_url = base_url
        self.username = username
        self.password = password
        self.token: Optional[str] = None
        self.stats_base_url = "https://stats.postisgate.com" # v3 stats endpoint submodule

    async def login(self) -> str:
        # Official documented endpoint (token valid ~24h):
        # POST /api/v3/users:login { name, password }
        # Keep compatibility with legacy /unauthenticated/login by falling back.
        base = (self.base_url or "https://shipments.postisgate.com").rstrip("/")
        url = f"{base}/api/v3/users:login"
        payload = {
            "name": self.username, # Per verified spec
            "password": self.password
        }
        async with httpx.AsyncClient() as client:
            try:
                response = await client.post(url, json=payload, headers={"accept": "application/json"})
                if response.status_code in (404, 405):
                    legacy_url = f"{base}/unauthenticated/login"
                    response = await client.post(legacy_url, json=payload, headers={"accept": "*/*"})

                response.raise_for_status()
                data = response.json() if response.content else {}
                self.token = data.get("token") if isinstance(data, dict) else None
                if not self.token:
                    raise Exception("Postis login returned no token")
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
        base = (self.base_url or "https://shipments.postisgate.com").rstrip("/")
        url = f"{base}/api/v1/clients/shipments/byawb/{normalize_shipment_identifier(awb)}"
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

    async def update_status_by_awb_or_client_order_id(self, identifier: str, event_id: str, details: Dict[str, Any]) -> Dict[str, Any]:
        """
        Update shipment status using Postis API v1 by AWB *or* clientOrderId.

        Endpoint:
          PUT /api/v1/clients/shipments/byawborclientorderid/{nr}
        Payload: same as byawb.
        """
        base = (self.base_url or "https://shipments.postisgate.com").rstrip("/")
        path_template = f"{base}/api/v1/clients/shipments/byawborclientorderid/{{value}}"

        last_exc: Optional[Exception] = None
        for candidate in candidates_with_optional_parcel_suffix_stripped(identifier):
            try:
                token = await self.get_token()
                url = path_template.format(value=candidate)
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
                    response = await client.put(url, json=update_payload, headers=headers)
                    if response.status_code == 401:
                        logger.info("Postis token expired, retrying login")
                        await self.login()
                        token = await self.get_token()
                        headers["Authorization"] = f"Bearer {token}"
                        response = await client.put(url, json=update_payload, headers=headers)

                    if response.status_code == 404:
                        # Try next candidate.
                        continue
                    if response.status_code in (405, 501):
                        # Endpoint not supported for this account; stop trying.
                        break

                    response.raise_for_status()
                    if response.status_code == 204 or not response.text:
                        return {"status": "success", "message": "Updated successfully (no response body)"}
                    return response.json()
            except Exception as e:
                last_exc = e
                continue

        # Fall back to the byawb endpoint (older accounts / narrower matching).
        last_fallback_exc: Optional[Exception] = None
        for candidate in candidates_with_optional_parcel_suffix_stripped(identifier):
            try:
                return await self.update_awb_status(candidate, event_id, details)
            except Exception as e:
                last_fallback_exc = e
                continue

        if last_exc:
            raise last_exc
        if last_fallback_exc:
            raise last_fallback_exc
        raise Exception("Postis update failed")

    async def get_shipment_tracking(self, awb: str) -> Dict[str, Any]:
        token = await self.get_token()
        # Verified GET endpoint from user's Apps Script
        base = (self.base_url or "https://shipments.postisgate.com").rstrip("/")
        url = f"{base}/api/v1/clients/shipments/byawb/{normalize_shipment_identifier(awb)}"
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

    async def get_shipment_tracking_by_awb_or_client_order_id(self, identifier: str) -> Dict[str, Any]:
        """
        Best-effort fetch shipment details by identifier.

        Tries:
          GET /api/v1/clients/shipments/byawborclientorderid/{nr} (if supported)
        Falls back to:
          GET /api/v1/clients/shipments/byawb/{awb}
        """
        def _as_dict(payload: Any) -> Dict[str, Any]:
            if isinstance(payload, list) and payload:
                first = payload[0]
                return first if isinstance(first, dict) else {}
            return payload if isinstance(payload, dict) else {}

        def _awb_from_payload(payload: Dict[str, Any]) -> Optional[str]:
            for k in ("awb", "AWB", "trackingNumber", "tracking_number", "shipmentId", "shipment_id"):
                v = payload.get(k)
                s = normalize_shipment_identifier(v) if v is not None else ""
                if s:
                    return s
            return None

        def _blank(v: Any) -> bool:
            if v is None:
                return True
            if isinstance(v, str):
                return not v.strip()
            if isinstance(v, (list, tuple, set, dict)):
                return len(v) == 0
            return False

        def _merge_fill_blanks(primary: Dict[str, Any], secondary: Dict[str, Any]) -> Dict[str, Any]:
            """
            Merge two payloads keeping `primary` as the source of truth, but filling blanks from `secondary`.
            This helps when `byawborclientorderid` resolves an ID but `byawb` has richer fields (or vice versa).
            """
            out = dict(primary or {})
            for k, v in (secondary or {}).items():
                if k not in out or _blank(out.get(k)):
                    out[k] = v
                elif isinstance(out.get(k), dict) and isinstance(v, dict):
                    # Shallow nested fill.
                    nested = dict(out.get(k) or {})
                    for nk, nv in v.items():
                        if nk not in nested or _blank(nested.get(nk)):
                            nested[nk] = nv
                    out[k] = nested
            return out

        base = (self.base_url or "https://shipments.postisgate.com").rstrip("/")
        path_template = f"{base}/api/v1/clients/shipments/byawborclientorderid/{{value}}"

        for candidate in candidates_with_optional_parcel_suffix_stripped(identifier):
            token = await self.get_token()
            url = path_template.format(value=candidate)
            headers = {"Authorization": f"Bearer {token}", "accept": "application/json"}
            async with httpx.AsyncClient(timeout=60.0) as client:
                try:
                    response = await client.get(url, headers=headers)
                    if response.status_code == 401:
                        await self.login()
                        token = await self.get_token()
                        headers["Authorization"] = f"Bearer {token}"
                        response = await client.get(url, headers=headers)

                    if response.status_code == 404:
                        continue
                    if response.status_code in (405, 501):
                        break

                    response.raise_for_status()
                    base_data = _as_dict(response.json())
                    if not base_data:
                        continue

                    # Some accounts/flows return a more complete payload on the by-AWB endpoint.
                    resolved_awb = _awb_from_payload(base_data) or candidate
                    try:
                        by_awb = await self.get_shipment_tracking(resolved_awb)
                    except Exception:
                        by_awb = {}

                    if by_awb:
                        # Prefer the by-AWB payload, but keep any extra fields from the resolver.
                        return _merge_fill_blanks(by_awb, base_data)

                    return base_data
                except httpx.HTTPStatusError:
                    continue
                except Exception:
                    continue

        # Fallback: try the by-AWB endpoint with the same candidates (important for parcel suffix scans).
        for candidate in candidates_with_optional_parcel_suffix_stripped(identifier):
            try:
                by_awb = await self.get_shipment_tracking(candidate)
            except Exception:
                by_awb = {}
            if by_awb:
                return by_awb

        return {}

    async def get_shipments(self, limit: int = 100, page: int = 1) -> List[Dict[str, Any]]:
        token = await self.get_token()
        # Official v3 List Endpoint (Found on stats subdomain)
        url = f"{self.stats_base_url}/api/v3/shipments"
        params = {
            "size": limit,
            "page": page
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
                    return await self.get_shipments(limit=limit, page=page)
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

        base = (self.base_url or "https://shipments.postisgate.com").rstrip("/")
        awb_norm = normalize_shipment_identifier(awb)
        v1_url = f"{base}/api/v1/clients/shipments/{awb_norm}/label"
        v3_url = f"{base}/api/v3/shipments/labels/{awb_norm}?type=PDF"

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
