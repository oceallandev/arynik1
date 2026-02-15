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
    raw = str(value or "").strip().upper()
    if not raw:
        return []

    # Extract plausible tokens first (keeps separators like "-" and "/" meaningful).
    parts = [p for p in re.findall(r"[A-Z0-9]+", raw) if p]

    # Prefer longer identifiers (AWBs/clientOrderIds) and avoid very short noise tokens.
    candidates: List[str] = []
    for p in parts:
        if len(p) < 6:
            continue
        norm = normalize_shipment_identifier(p)
        if norm and norm not in candidates:
            candidates.append(norm)

    # Always include the fully-normalized input as a last resort.
    full_norm = normalize_shipment_identifier(raw)
    if full_norm and full_norm not in candidates:
        candidates.append(full_norm)

    out: List[str] = []
    for norm in candidates:
        if norm not in out:
            out.append(norm)

        # Only strip if it looks like a parcel suffix (001, 002, ...). We bias to stripping only when
        # the identifier contains letters (typical for AWB formats) so we don't accidentally mangle
        # numeric order ids. Keep a minimum core length so we don't mangle short identifiers.
        if len(norm) >= 13 and any("A" <= ch <= "Z" for ch in norm) and norm[-3:].isdigit() and norm[-3:] != "000":
            core = norm[:-3]
            if len(core) >= 8 and core not in out:
                out.append(core)

    # Keep result size bounded (defensive).
    return out[:12]


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

        def _as_boolish(v: Any) -> bool:
            if v is True:
                return True
            if v is False or v is None:
                return False
            if isinstance(v, (int, float)):
                return v != 0
            s = str(v).strip().lower()
            return s in ("1", "true", "yes", "y", "on")

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

        def _score_payload(payload: Dict[str, Any]) -> int:
            """
            Heuristic completeness score. We prefer richer payloads (by-AWB details) over thin resolver payloads.
            """
            if not isinstance(payload, dict) or not payload:
                return 0

            score = 0
            if _awb_from_payload(payload):
                score += 2

            # Recipient location/address completeness.
            recipient_loc = payload.get("recipientLocation") or payload.get("recipient_location") or {}
            if isinstance(recipient_loc, dict) and recipient_loc:
                score += 1
                if any(not _blank(recipient_loc.get(k)) for k in ("county", "countyName", "region", "regionName")):
                    score += 3
                if any(not _blank(recipient_loc.get(k)) for k in ("locality", "localityName", "city", "cityName")):
                    score += 2
                if any(not _blank(recipient_loc.get(k)) for k in ("addressText", "address", "addressText1", "address_text")):
                    score += 2
                if not _blank(recipient_loc.get("phoneNumber")):
                    score += 1

            # Cost/pricing fields.
            for k in (
                "carrierShippingCost",
                "courierShippingCost",
                "shippingCost",
                "estimatedShippingCost",
                "estimated_shipping_cost",
                "finalPrice",
                "weightPriceShipment",
                "weightPricePerShipment",
            ):
                v = payload.get(k)
                if v is None or v == "" or v == 0:
                    continue
                score += 2
                break

            # Content fields.
            for k in (
                "contentDescription",
                "contents",
                "content",
                "packingList",
                "packingListNumber",
                "packingListId",
            ):
                if not _blank(payload.get(k)):
                    score += 2
                    break

            # Parcels / package details.
            parcels = payload.get("parcels") or payload.get("Parcels") or payload.get("packages") or payload.get("Packages")
            if isinstance(parcels, list) and parcels:
                score += 3

            for k in ("declaredValue", "brutWeight", "weight", "volumetricWeight", "length", "width", "height"):
                v = payload.get(k)
                if v is None or v == "" or v == 0:
                    continue
                score += 1

            # Service flags.
            additional = payload.get("additionalServices") or payload.get("additional_services") or {}
            if isinstance(additional, dict) and additional:
                if any(_as_boolish(additional.get(k)) for k in ("openPackage", "priority", "insurance", "oversized")):
                    score += 1

            # History/trace.
            trace = payload.get("shipmentTrace") or payload.get("traceHistory") or payload.get("tracking") or payload.get("events")
            if isinstance(trace, list) and trace:
                score += 1

            return score

        base = (self.base_url or "https://shipments.postisgate.com").rstrip("/")
        path_template = f"{base}/api/v1/clients/shipments/byawborclientorderid/{{value}}"

        candidates = candidates_with_optional_parcel_suffix_stripped(identifier)
        if not candidates:
            return {}

        best: Dict[str, Any] = {}
        best_score = -1

        def _consider(payload: Dict[str, Any]) -> None:
            nonlocal best, best_score
            if not isinstance(payload, dict) or not payload:
                return
            s = _score_payload(payload)
            if s > best_score:
                best = payload
                best_score = s

        by_awb_cache: Dict[str, Dict[str, Any]] = {}

        async with httpx.AsyncClient(timeout=60.0) as client:
            # First pass: use the resolver endpoint (by awb or client order id), then re-fetch by AWB for details.
            for candidate in candidates:
                try:
                    token = await self.get_token()
                    url = path_template.format(value=candidate)
                    headers = {"Authorization": f"Bearer {token}", "accept": "application/json"}

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

                    _consider(base_data)

                    # Some accounts/flows return a more complete payload on the by-AWB endpoint.
                    resolved_awb = _awb_from_payload(base_data) or candidate

                    awb_candidates: List[str] = []
                    for token_val in (resolved_awb, candidate):
                        for awb_cand in candidates_with_optional_parcel_suffix_stripped(token_val):
                            if awb_cand not in awb_candidates:
                                awb_candidates.append(awb_cand)

                    for awb_cand in awb_candidates:
                        if awb_cand in by_awb_cache:
                            by_awb = by_awb_cache.get(awb_cand) or {}
                        else:
                            by_awb = await self.get_shipment_tracking(awb_cand)
                            by_awb_cache[awb_cand] = by_awb or {}

                        if not by_awb:
                            continue

                        merged = _merge_fill_blanks(by_awb, base_data)
                        _consider(merged)

                        # Early exit when we have a "good enough" payload (contains core ops fields).
                        if best_score >= 10:
                            return best
                except httpx.HTTPStatusError:
                    continue
                except Exception:
                    continue

        # Second pass: direct by-AWB calls (important for parcel suffix scans).
        for candidate in candidates:
            if candidate in by_awb_cache:
                by_awb = by_awb_cache.get(candidate) or {}
            else:
                by_awb = await self.get_shipment_tracking(candidate)
                by_awb_cache[candidate] = by_awb or {}
            if by_awb:
                _consider(by_awb)
                if best_score >= 10:
                    return best

        return best or {}

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

    async def get_shipments_v2(self, page_size: int = 100, page_number: int = 1) -> List[Dict[str, Any]]:
        """
        Legacy/alternate list endpoint used by some Postis accounts.

        Observed usage in earlier scripts:
          GET /api/v2/clients/shipments?pageSize=...&pageNumber=...
        """
        token = await self.get_token()
        base = (self.base_url or "https://shipments.postisgate.com").rstrip("/")
        url = f"{base}/api/v2/clients/shipments"
        params = {
            "pageSize": max(1, int(page_size or 100)),
            "pageNumber": max(1, int(page_number or 1)),
        }
        headers = {
            "Authorization": f"Bearer {token}",
            "accept": "application/json",
        }

        async with httpx.AsyncClient(timeout=60.0) as client:
            try:
                response = await client.get(url, headers=headers, params=params)
                if response.status_code == 401:
                    logger.info("Postis token expired while fetching shipments (v2), retrying login")
                    await self.login()
                    token = await self.get_token()
                    headers["Authorization"] = f"Bearer {token}"
                    response = await client.get(url, headers=headers, params=params)

                # Some accounts may not have this endpoint enabled.
                if response.status_code in (404, 405, 501):
                    return []

                response.raise_for_status()
                data = response.json()

                # v2 tends to return a list; but keep a few dict shapes just in case.
                if isinstance(data, list):
                    return [d for d in data if isinstance(d, dict)]
                if isinstance(data, dict):
                    items = data.get("items") or data.get("content") or data.get("shipments") or []
                    if isinstance(items, list):
                        return [d for d in items if isinstance(d, dict)]
                return []
            except httpx.HTTPStatusError as e:
                logger.error(f"Postis fetch shipments (v2) failed: {e.response.text}")
                return []
            except Exception as e:
                logger.error(f"Postis fetch shipments (v2) failed: {str(e)}")
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
