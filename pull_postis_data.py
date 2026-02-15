import asyncio
import argparse
import os
import sys
import json
from datetime import datetime, timezone
from pathlib import Path
from dotenv import load_dotenv
from typing import Any, Dict, Iterable, List, Optional, Tuple

import httpx
from sqlalchemy import text

# Load env early so `backend.database` picks up DATABASE_URL before creating the engine.
REPO_ROOT = Path(__file__).resolve().parent
env_path = REPO_ROOT / "backend" / ".env"
if env_path.exists():
    load_dotenv(dotenv_path=str(env_path), override=True)
else:
    # Fall back to process env (useful in CI/container deployments).
    load_dotenv(override=True)

# Ensure repo root is importable even if this script is executed from another CWD.
sys.path.insert(0, str(REPO_ROOT))

from backend.models import Base, Shipment, ShipmentEvent
from backend.database import engine, SessionLocal

POSTIS_BASE_URL = os.getenv("POSTIS_BASE_URL", "https://shipments.postisgate.com")
POSTIS_STATS_BASE_URL = os.getenv("POSTIS_STATS_BASE_URL", "https://stats.postisgate.com")
POSTIS_USER = os.getenv("POSTIS_USERNAME")
POSTIS_PASS = os.getenv("POSTIS_PASSWORD")

def _to_float(value):
    try:
        if value is None or value == "":
            return None
        return float(value)
    except Exception:
        return None


def _parse_dt(value):
    """Parse Postis timestamps into naive UTC datetimes for Postgres `timestamp without time zone`."""
    if not value:
        return None
    if isinstance(value, datetime):
        dt = value
    else:
        s = str(value).strip()
        if not s:
            return None
        try:
            # Postis returns RFC3339 with a trailing Z.
            if s.endswith("Z"):
                s = s[:-1] + "+00:00"
            dt = datetime.fromisoformat(s)
        except Exception:
            return None

    if dt.tzinfo is not None:
        dt = dt.astimezone(timezone.utc).replace(tzinfo=None)
    return dt


def _normalize_status(ship_data):
    raw = (
        ship_data.get("clientShipmentStatusDescription")
        or ship_data.get("processingStatus")
        or ship_data.get("status")
        or ship_data.get("currentStatus")
        or ship_data.get("defaultClientStatus")
    )

    text = str(raw) if raw is not None else ""
    lower = text.strip().lower()

    if lower in ("livrat", "delivered"):
        return "Delivered"
    if lower in ("initial", "routed", "in transit", "in_transit", "in tranzit", "in_tranzit"):
        return "In Transit"
    if lower in ("refuzat", "refused"):
        return "Refused"

    return text or "pending"

def _as_str(value: Any) -> str:
    if value is None:
        return ""
    return str(value).strip()


def _get_awb(ship_data: Dict[str, Any]) -> Optional[str]:
    awb = ship_data.get("awb") or ship_data.get("AWB") or ship_data.get("trackingNumber")
    awb = _as_str(awb).upper()
    return awb or None


def _extract_trace(ship_data: Dict[str, Any]) -> List[Dict[str, Any]]:
    trace = (
        ship_data.get("shipmentTrace")
        or ship_data.get("traceHistory")
        or ship_data.get("tracking")
        or ship_data.get("events")
        or []
    )

    # Some APIs wrap arrays in a dict like { items: [...] }
    if isinstance(trace, dict):
        trace = trace.get("items") or trace.get("events") or trace.get("trace") or []

    if not isinstance(trace, list):
        return []

    # Keep raw-ish objects for snapshot/UI, but ensure it's a list of dicts.
    return [ev for ev in trace if isinstance(ev, dict)]


def _extract_lat_lon(ship_data: Dict[str, Any]) -> Tuple[Optional[float], Optional[float]]:
    # Try top-level first, then recipientLocation, then senderLocation.
    candidates = [
        ("latitude", "longitude"),
        ("lat", "lng"),
        ("lat", "lon"),
    ]

    for lat_key, lon_key in candidates:
        lat = _to_float(ship_data.get(lat_key))
        lon = _to_float(ship_data.get(lon_key))
        if lat is not None and lon is not None:
            return lat, lon

    for loc_key in ("recipientLocation", "recipient_location", "senderLocation", "sender_location"):
        loc = ship_data.get(loc_key) or {}
        if not isinstance(loc, dict):
            continue
        for lat_key, lon_key in candidates + [("latitude", "longitude")]:
            lat = _to_float(loc.get(lat_key))
            lon = _to_float(loc.get(lon_key))
            if lat is not None and lon is not None:
                return lat, lon

    return None, None


def _snapshot_row_from_postis(ship_data: Dict[str, Any], *, snapshot_full_raw: bool) -> Optional[Dict[str, Any]]:
    awb = _get_awb(ship_data)
    if not awb:
        return None

    recipient_loc = ship_data.get("recipientLocation") or {}
    if not isinstance(recipient_loc, dict):
        recipient_loc = {}

    sender_loc = ship_data.get("senderLocation") or {}
    if not isinstance(sender_loc, dict):
        sender_loc = {}

    status = _normalize_status(ship_data)
    lat, lon = _extract_lat_lon(ship_data)
    trace = _extract_trace(ship_data)

    raw_subset = {
        "courier": ship_data.get("courier"),
        "senderLocation": sender_loc,
        "recipientLocation": recipient_loc,
        "additionalServices": ship_data.get("additionalServices") or ship_data.get("cashOnDelivery"),
        "productCategory": ship_data.get("productCategory"),
        "clientShipmentStatus": ship_data.get("clientShipmentStatus"),
    }

    return {
        "awb": awb,
        "status": status,
        "recipient_name": _as_str(recipient_loc.get("name") or ship_data.get("recipientName") or ship_data.get("recipient") or "Unknown"),
        "recipient_phone": _as_str(recipient_loc.get("phoneNumber") or ship_data.get("recipientPhoneNumber") or ship_data.get("phone") or ""),
        "recipient_email": _as_str(recipient_loc.get("email") or ship_data.get("recipientEmail") or ""),
        "delivery_address": _as_str(recipient_loc.get("addressText") or ship_data.get("address") or ship_data.get("recipientAddress") or ""),
        "locality": _as_str(recipient_loc.get("locality") or ship_data.get("city") or ship_data.get("recipientLocality") or ""),
        "county": _as_str(recipient_loc.get("county") or recipient_loc.get("countyName") or ship_data.get("county") or ship_data.get("recipientCounty") or ""),
        "latitude": lat or 0.0,
        "longitude": lon or 0.0,
        "weight": _to_float(ship_data.get("brutWeight") or ship_data.get("weight")) or 0.0,
        "volumetric_weight": _to_float(ship_data.get("volumetricWeight") or ship_data.get("volumetric_weight")) or 0.0,
        "dimensions": _as_str(ship_data.get("dimensions") or ""),
        "content_description": _as_str(ship_data.get("contentDescription") or ship_data.get("contents") or ""),
        "cod_amount": _to_float(
            (ship_data.get("additionalServices") or {}).get("cashOnDelivery")
            or ship_data.get("cashOnDelivery")
            or ship_data.get("cod_amount")
            or ship_data.get("cod")
        )
        or 0.0,
        "delivery_instructions": _as_str(ship_data.get("shippingInstruction") or ship_data.get("instructions") or ""),
        "driver_id": "D002",  # Default to Demo Driver for snapshot
        "last_updated": datetime.utcnow().isoformat(),
        "tracking_history": trace,
        # Extended data
        "client_order_id": ship_data.get("clientOrderId"),
        "created_date": ship_data.get("createdDate"),
        "raw_data": ship_data if snapshot_full_raw else raw_subset,
    }


def _snapshot_row_from_db(ship: Shipment, *, snapshot_full_raw: bool) -> Dict[str, Any]:
    # Best-effort: prefer existing normalized columns + stored JSON objects.
    raw_subset = {
        "courier": ship.courier_data,
        "senderLocation": ship.sender_location,
        "recipientLocation": ship.recipient_location,
        "additionalServices": ship.additional_services,
        "productCategory": ship.product_category_data,
        "clientShipmentStatus": ship.client_shipment_status_data,
    }

    raw_full = None
    if snapshot_full_raw:
        try:
            raw_full = ship.raw_data
        except Exception:
            raw_full = None

    recipient_loc = ship.recipient_location or {}
    if not isinstance(recipient_loc, dict):
        recipient_loc = {}

    return {
        "awb": ship.awb,
        "status": ship.status or "pending",
        "recipient_name": ship.recipient_name or "Unknown",
        "recipient_phone": ship.recipient_phone or "",
        "recipient_email": ship.recipient_email or "",
        "delivery_address": ship.delivery_address or "",
        "locality": ship.locality or "",
        "county": str(recipient_loc.get("county") or recipient_loc.get("countyName") or "").strip(),
        "latitude": ship.latitude or 0.0,
        "longitude": ship.longitude or 0.0,
        "weight": ship.weight or 0.0,
        "volumetric_weight": ship.volumetric_weight or 0.0,
        "dimensions": ship.dimensions or "",
        "content_description": ship.content_description or "",
        "cod_amount": ship.cod_amount or 0.0,
        "delivery_instructions": ship.delivery_instructions or "",
        "driver_id": ship.driver_id or "D002",
        "last_updated": ship.last_updated.isoformat() if ship.last_updated else datetime.utcnow().isoformat(),
        "tracking_history": [],
        "client_order_id": ship.client_order_id,
        "created_date": ship.created_date.isoformat() if ship.created_date else None,
        "raw_data": raw_full if (snapshot_full_raw and raw_full is not None) else raw_subset,
    }


async def _postis_login(http_client: httpx.AsyncClient) -> str:
    if not POSTIS_USER or not POSTIS_PASS:
        raise RuntimeError("POSTIS_USERNAME / POSTIS_PASSWORD not configured")

    base = POSTIS_BASE_URL.rstrip("/")
    # Official documented endpoint:
    #   POST /api/v3/users:login { name, password }
    # Keep compatibility with legacy /unauthenticated/login.
    url = f"{base}/api/v3/users:login"
    payload = {"name": POSTIS_USER, "password": POSTIS_PASS}
    resp = await http_client.post(url, json=payload, headers={"accept": "application/json"})
    if resp.status_code in (404, 405):
        resp = await http_client.post(f"{base}/unauthenticated/login", json=payload, headers={"accept": "*/*"})
    resp.raise_for_status()
    data = resp.json() if resp.content else {}
    token = data.get("token")
    if not token:
        raise RuntimeError("Postis login succeeded but no token returned")
    return token


async def _fetch_shipments_v3_page(http_client: httpx.AsyncClient, token: str, *, page: int, size: int) -> List[Dict[str, Any]]:
    url = f"{POSTIS_STATS_BASE_URL.rstrip('/')}/api/v3/shipments"
    headers = {"Authorization": f"Bearer {token}", "accept": "application/json"}
    resp = await http_client.get(url, headers=headers, params={"page": page, "size": size})
    if resp.status_code == 401:
        raise PermissionError("Unauthorized (token expired)")
    resp.raise_for_status()
    data = resp.json()
    if isinstance(data, dict):
        items = data.get("items") or []
        return items if isinstance(items, list) else []
    return data if isinstance(data, list) else []


async def _fetch_shipment_v1_by_awb(http_client: httpx.AsyncClient, token: str, awb: str) -> Optional[Dict[str, Any]]:
    url = f"{POSTIS_BASE_URL.rstrip('/')}/api/v1/clients/shipments/byawb/{awb}"
    headers = {"Authorization": f"Bearer {token}", "accept": "application/json"}
    resp = await http_client.get(url, headers=headers)

    if resp.status_code == 401:
        raise PermissionError("Unauthorized (token expired)")
    if resp.status_code == 404:
        return None
    if resp.status_code == 429:
        raise RuntimeError("Rate limited (429)")

    resp.raise_for_status()
    data = resp.json()
    if isinstance(data, list):
        return data[0] if data else None
    return data if isinstance(data, dict) else None


async def _enrich_by_awb(
    http_client: httpx.AsyncClient,
    token_ref: Dict[str, str],
    awbs: List[str],
    *,
    concurrency: int,
    max_items: Optional[int] = None,
) -> List[Dict[str, Any]]:
    sem = asyncio.Semaphore(max(1, int(concurrency or 1)))
    results: List[Dict[str, Any]] = []

    async def refresh_token() -> str:
        token_ref["token"] = await _postis_login(http_client)
        return token_ref["token"]

    async def fetch_one(awb: str) -> None:
        attempts = 0
        while attempts < 4:
            attempts += 1
            try:
                async with sem:
                    data = await _fetch_shipment_v1_by_awb(http_client, token_ref["token"], awb)
                if data:
                    results.append(data)
                return
            except PermissionError:
                # Token expired; refresh once for all tasks.
                await refresh_token()
            except RuntimeError as e:
                # 429 or transient issue; back off.
                msg = str(e)
                if "429" in msg and attempts < 4:
                    await asyncio.sleep(1.5 * attempts)
                    continue
                return
            except Exception:
                return

    todo = awbs[: max_items] if max_items else awbs
    await asyncio.gather(*(fetch_one(a) for a in todo))
    return results


def _ensure_shipments_columns(db) -> None:
    # SQLAlchemy create_all() does not add columns to existing tables.
    try:
        dialect = engine.dialect.name
    except Exception:
        dialect = ""

    if dialect == "postgresql":
        db.execute(text("ALTER TABLE shipments ADD COLUMN IF NOT EXISTS raw_data JSONB"))
        db.execute(text("ALTER TABLE shipments ADD COLUMN IF NOT EXISTS shipping_cost DOUBLE PRECISION"))
        db.execute(text("ALTER TABLE shipments ADD COLUMN IF NOT EXISTS estimated_shipping_cost DOUBLE PRECISION"))
        db.execute(text("ALTER TABLE shipments ADD COLUMN IF NOT EXISTS currency TEXT"))
        db.commit()
        return

    if dialect == "sqlite":
        cols = [row[1] for row in db.execute(text("PRAGMA table_info(shipments)")).fetchall()]
        if "raw_data" not in cols:
            db.execute(text("ALTER TABLE shipments ADD COLUMN raw_data JSON"))
            db.commit()
            cols.append("raw_data")
        if "shipping_cost" not in cols:
            db.execute(text("ALTER TABLE shipments ADD COLUMN shipping_cost REAL"))
            db.commit()
            cols.append("shipping_cost")
        if "estimated_shipping_cost" not in cols:
            db.execute(text("ALTER TABLE shipments ADD COLUMN estimated_shipping_cost REAL"))
            db.commit()
            cols.append("estimated_shipping_cost")
        if "currency" not in cols:
            db.execute(text("ALTER TABLE shipments ADD COLUMN currency TEXT"))
            db.commit()
        return


def _upsert_shipment_and_events(db, ship_data: Dict[str, Any]) -> Tuple[bool, bool]:
    """Return (created, updated)."""
    awb = _get_awb(ship_data)
    if not awb:
        return False, False

    existing: Optional[Shipment] = db.query(Shipment).filter(Shipment.awb == awb).first()

    recipient_loc = ship_data.get("recipientLocation") or {}
    recipient_loc = recipient_loc if isinstance(recipient_loc, dict) else {}
    sender_loc = ship_data.get("senderLocation") or {}
    sender_loc = sender_loc if isinstance(sender_loc, dict) else {}

    status = _normalize_status(ship_data)
    lat, lon = _extract_lat_lon(ship_data)

    weight = _to_float(ship_data.get("brutWeight") or ship_data.get("weight"))
    volumetric_weight = _to_float(ship_data.get("volumetricWeight") or ship_data.get("volumetric_weight"))
    cod_amount = _to_float(
        (ship_data.get("additionalServices") or {}).get("cashOnDelivery")
        or ship_data.get("cashOnDelivery")
        or ship_data.get("cod_amount")
        or ship_data.get("cod")
    ) or 0.0

    created_date = _parse_dt(ship_data.get("createdDate") or ship_data.get("created_date"))
    awb_status_date = _parse_dt(ship_data.get("awbStatusDate") or ship_data.get("awb_status_date"))

    has_borderou = ship_data.get("hasBorderou")
    processing_status = ship_data.get("processingStatus") or ship_data.get("processing_status")
    source_channel = ship_data.get("sourceChannel") or ship_data.get("source_channel")
    send_type = ship_data.get("sendType") or ship_data.get("send_type")
    sender_shop_name = ship_data.get("storeName") or ship_data.get("sender_shop_name")
    number_of_parcels = ship_data.get("numberOfDistinctBarcodes") or ship_data.get("number_of_parcels") or 1

    courier_data = ship_data.get("courier")
    if courier_data is None:
        courier_data = {
            "courierId": ship_data.get("courierId"),
            "courierName": ship_data.get("courierName"),
            "truckNumber": ship_data.get("truckNumber"),
            "tripId": ship_data.get("tripId"),
        }

    client_shipment_status_data = ship_data.get("clientShipmentStatus")
    if client_shipment_status_data is None:
        client_shipment_status_data = {
            "defaultClientStatus": ship_data.get("defaultClientStatus"),
            "clientShipmentStatusDescription": ship_data.get("clientShipmentStatusDescription"),
            "processingStatus": ship_data.get("processingStatus"),
        }

    product_category_data = ship_data.get("productCategory")
    if product_category_data is None and ship_data.get("productCategory"):
        product_category_data = {"name": ship_data.get("productCategory")}

    additional_services = ship_data.get("additionalServices") or {}
    shipping_cost = _to_float(ship_data.get("shippingCost") or ship_data.get("shipping_cost"))
    estimated_shipping_cost = _to_float(ship_data.get("estimatedShippingCost") or ship_data.get("estimated_shipping_cost"))
    currency = _as_str(ship_data.get("currency") or ship_data.get("paymentCurrency") or ship_data.get("currencyCode")) or "RON"
    declared_value = _to_float(ship_data.get("declaredValue") or ship_data.get("declared_value")) or 0.0

    payload = {
        "awb": awb,
        "recipient_name": _as_str(recipient_loc.get("name") or ship_data.get("recipientName") or ship_data.get("recipient") or "Unknown"),
        "recipient_phone": _as_str(recipient_loc.get("phoneNumber") or ship_data.get("recipientPhoneNumber") or ship_data.get("phone") or "") or None,
        "recipient_email": _as_str(recipient_loc.get("email") or ship_data.get("recipientEmail") or "") or None,
        "delivery_address": _as_str(recipient_loc.get("addressText") or ship_data.get("address") or ship_data.get("recipientAddress") or ""),
        "locality": _as_str(recipient_loc.get("locality") or ship_data.get("city") or ship_data.get("recipientLocality") or ""),
        "latitude": lat,
        "longitude": lon,
        "status": status,
        "weight": weight,
        "volumetric_weight": volumetric_weight,
        "dimensions": _as_str(ship_data.get("dimensions") or "") or None,
        "content_description": _as_str(ship_data.get("contentDescription") or ship_data.get("contents") or "") or None,
        "cod_amount": cod_amount,
        "shipping_cost": shipping_cost,
        "estimated_shipping_cost": estimated_shipping_cost,
        "currency": currency,
        "declared_value": declared_value,
        "delivery_instructions": _as_str(ship_data.get("shippingInstruction") or ship_data.get("instructions") or "") or None,
        "shipment_reference": ship_data.get("shipmentReference") or ship_data.get("shipment_reference"),
        "client_order_id": ship_data.get("clientOrderId") or ship_data.get("client_order_id"),
        "postis_order_id": ship_data.get("id") or ship_data.get("postisOrderId") or ship_data.get("postis_order_id"),
        "client_data": ship_data.get("client") or ship_data.get("clientData"),
        "courier_data": courier_data,
        "sender_location": sender_loc,
        "recipient_location": recipient_loc,
        "product_category_data": product_category_data,
        "client_shipment_status_data": client_shipment_status_data,
        "additional_services": additional_services,
        "created_date": created_date,
        "awb_status_date": awb_status_date,
        "has_borderou": has_borderou,
        "processing_status": processing_status,
        "source_channel": source_channel,
        "send_type": send_type,
        "sender_shop_name": sender_shop_name,
        "number_of_parcels": int(number_of_parcels) if number_of_parcels else 1,
        "last_updated": datetime.utcnow(),
        "raw_data": ship_data,
    }

    created = False
    updated = False

    if existing:
        # Keep any explicit assignment already made.
        driver_id = existing.driver_id or "D002"
        for k, v in payload.items():
            if k == "awb":
                continue
            setattr(existing, k, v)
        existing.driver_id = driver_id
        updated = True
        ship = existing
    else:
        ship = Shipment(**payload, driver_id="D002")
        db.add(ship)
        created = True

    db.flush()  # Ensure ship.id exists

    # Upsert events as a simple refresh (delete + insert) to avoid duplicates.
    trace = _extract_trace(ship_data)
    if trace:
        db.query(ShipmentEvent).filter(ShipmentEvent.shipment_id == ship.id).delete(synchronize_session=False)
        for ev in trace:
            desc = _as_str(ev.get("eventDescription") or ev.get("statusDescription") or (ev.get("courierShipmentStatus") or {}).get("statusDescription"))
            when = _parse_dt(ev.get("eventDate") or ev.get("createdDate") or ev.get("date"))
            loc_name = _as_str(ev.get("localityName") or ev.get("locality") or "")
            if not desc and not when:
                continue
            db.add(ShipmentEvent(shipment_id=ship.id, event_description=desc or "Update", event_date=when or datetime.utcnow(), locality_name=loc_name))

    return created, updated


def _load_awbs_from_snapshot(paths: Iterable[Path]) -> List[str]:
    for p in paths:
        try:
            if not p.exists():
                continue
            data = json.loads(p.read_text())
            if not isinstance(data, list):
                continue
            awbs: List[str] = []
            seen = set()
            for row in data:
                if not isinstance(row, dict):
                    continue
                awb = _as_str(row.get("awb")).upper()
                if not awb or awb in seen:
                    continue
                seen.add(awb)
                awbs.append(awb)
            if awbs:
                return awbs
        except Exception:
            continue
    return []


def export_snapshot_from_db(*, snapshot_full_raw: bool, awb_limit: Optional[int]) -> int:
    """Export `shipments.json` from the current DB (useful when Postis is unreachable)."""
    paths = ["frontend/public/data/shipments.json", "data/shipments.json"]
    export_data: List[Dict[str, Any]] = []

    try:
        Base.metadata.create_all(bind=engine)
        db = SessionLocal()
        try:
            q = db.query(Shipment).order_by(Shipment.awb.asc())
            if awb_limit:
                q = q.limit(int(awb_limit))
            for ship in q.all():
                export_data.append(_snapshot_row_from_db(ship, snapshot_full_raw=snapshot_full_raw))
        finally:
            db.close()

        for output_path in paths:
            os.makedirs(os.path.dirname(output_path), exist_ok=True)
            with open(output_path, "w") as f:
                json.dump(export_data, f, indent=2)
            print(f"Snapshot saved to {output_path}")

        return len(export_data)
    except Exception as e:
        print(f"DB snapshot export failed: {e}")
        return 0


async def pull_all_data(
    *,
    enrich_by_awb: bool,
    concurrency: int,
    awb_limit: Optional[int],
    snapshot_full_raw: bool,
) -> None:
    """Pull shipments from Postis v3 list, then enrich each AWB via Postis v1 by-AWB endpoint."""

    print("=" * 80)
    print("PULLING ALL DATA FROM POSTIS")
    print("=" * 80)

    timeout = httpx.Timeout(60.0, connect=30.0)
    async with httpx.AsyncClient(timeout=timeout) as http_client:
        print(f"\nAuthenticating as: {POSTIS_USER}")
        try:
            token = await _postis_login(http_client)
            print("Authentication successful\n")
        except Exception as e:
            print(f"Authentication failed: {str(e)}")
            export_snapshot_from_db(snapshot_full_raw=snapshot_full_raw, awb_limit=awb_limit)
            return

        token_ref = {"token": token}

        # --- FETCH FROM API (V3 LIST) ---
        print("Fetching all shipments from Postis (v3 list)...")
        shipments_v3: List[Dict[str, Any]] = []
        page = 1
        page_size = 100

        while True:
            print(f"  Fetching page {page} (size {page_size})...", end="", flush=True)
            try:
                batch = await _fetch_shipments_v3_page(http_client, token_ref["token"], page=page, size=page_size)
            except PermissionError:
                token_ref["token"] = await _postis_login(http_client)
                print(" retry (token refreshed)")
                continue
            except Exception as e:
                print(f" error: {e}")
                break

            if not batch:
                print(" done. (no more data)")
                break

            shipments_v3.extend(batch)
            print(f" got {len(batch)}")

            if len(batch) < page_size:
                break
            page += 1

        # Extract AWBs from v3 list (fallback to DB/snapshot if list fails).
        awbs: List[str] = []
        seen = set()
        for s in shipments_v3:
            awb = _get_awb(s)
            if not awb or awb in seen:
                continue
            seen.add(awb)
            awbs.append(awb)

        if not awbs:
            print("\nNo AWBs from v3 list; falling back to DB/snapshot...")
            # DB fallback
            try:
                Base.metadata.create_all(bind=engine)
                db = SessionLocal()
                try:
                    rows = db.query(Shipment.awb).filter(Shipment.awb.isnot(None)).all()
                    awbs = [r[0] for r in rows if r and r[0]]
                finally:
                    db.close()
            except Exception:
                awbs = []

            # Snapshot fallback
            if not awbs:
                awbs = _load_awbs_from_snapshot(
                    [
                        REPO_ROOT / "data" / "shipments.json",
                        REPO_ROOT / "frontend" / "public" / "data" / "shipments.json",
                    ]
                )

        print(f"\nAWBs discovered: {len(awbs)}")
        if not awbs:
            print("No shipments available to import/enrich.")
            return

        # --- ENRICH VIA V1 BY-AWB ---
        shipments: List[Dict[str, Any]] = shipments_v3
        if enrich_by_awb:
            print(f"\nEnriching via v1 by-AWB (concurrency={concurrency}, limit={awb_limit or 'none'})...")
            enriched = await _enrich_by_awb(
                http_client,
                token_ref,
                awbs,
                concurrency=concurrency,
                max_items=awb_limit,
            )
            print(f"Enriched records fetched: {len(enriched)}")
            shipments = enriched or shipments_v3

        # Deduplicate by AWB
        by_awb: Dict[str, Dict[str, Any]] = {}
        for s in shipments:
            awb = _get_awb(s or {})
            if not awb or awb in by_awb:
                continue
            by_awb[awb] = s
        shipments = list(by_awb.values())

        # --- EXPORT TO JSON FOR FRONTEND SNAPSHOT (OFFLINE RESILIENCE) ---
        print("\nCreating data snapshot for frontend (offline fallback)...")
        export_data: List[Dict[str, Any]] = []
        if shipments:
            for s in shipments:
                row = _snapshot_row_from_postis(s, snapshot_full_raw=snapshot_full_raw)
                if row:
                    export_data.append(row)
        else:
            # No API data available (e.g. network outage). Export from DB so the frontend still works offline.
            try:
                Base.metadata.create_all(bind=engine)
                db_snap = SessionLocal()
                try:
                    q = db_snap.query(Shipment).order_by(Shipment.awb.asc())
                    if awb_limit:
                        q = q.limit(int(awb_limit))
                    for ship in q.all():
                        export_data.append(_snapshot_row_from_db(ship, snapshot_full_raw=snapshot_full_raw))
                finally:
                    db_snap.close()
                print(f"Snapshot exported from DB rows: {len(export_data)}")
            except Exception as e:
                print(f"DB snapshot export failed: {e}")

        paths = ["frontend/public/data/shipments.json", "data/shipments.json"]
        for output_path in paths:
            try:
                os.makedirs(os.path.dirname(output_path), exist_ok=True)
                with open(output_path, "w") as f:
                    json.dump(export_data, f, indent=2)
                print(f"Snapshot saved to {output_path}")
            except Exception as e:
                print(f"Failed to save snapshot to {output_path}: {e}")

        # --- DB IMPORT (ATTEMPT) ---
        print("\nAttempting DB import...")
        db = None
        try:
            Base.metadata.create_all(bind=engine)
            db = SessionLocal()
            _ensure_shipments_columns(db)
            print("Connected to database")

            created_count = 0
            updated_count = 0
            skipped_count = 0

            for idx, ship_data in enumerate(shipments, 1):
                try:
                    created, updated = _upsert_shipment_and_events(db, ship_data)
                    if created:
                        created_count += 1
                    elif updated:
                        updated_count += 1
                    else:
                        skipped_count += 1

                    if idx % 50 == 0:
                        db.commit()
                        print(f"  committed {idx}/{len(shipments)}")
                except Exception as e:
                    awb = _get_awb(ship_data or {})
                    print(f"Row error (awb={awb}): {e}")
                    db.rollback()

            db.commit()
            print(f"DB import success: {created_count} new, {updated_count} updated (skipped: {skipped_count})")
        except Exception as db_err:
            print(f"Database import failed (connection/schema issue?): {db_err}")
            print("Running in snapshot mode only. App will use JSON fallbacks.")
        finally:
            if db:
                db.close()

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Pull shipments from Postis and populate DB + offline snapshot.")
    parser.add_argument(
        "--no-enrich-by-awb",
        action="store_true",
        help="Skip v1 by-AWB enrichment (faster, but less detailed).",
    )
    parser.add_argument(
        "--concurrency",
        type=int,
        default=int(os.getenv("POSTIS_CONCURRENCY", "6")),
        help="Concurrent v1 by-AWB requests (default: 6).",
    )
    parser.add_argument(
        "--awb-limit",
        type=int,
        default=None,
        help="Limit number of AWBs to enrich/import (useful for testing).",
    )
    parser.add_argument(
        "--snapshot-full-raw",
        action="store_true",
        help="Store the full Postis payload under raw_data in shipments.json (can be large).",
    )
    parser.add_argument(
        "--snapshot-db-only",
        action="store_true",
        help="Skip Postis calls and only export shipments.json from the current DB.",
    )

    args = parser.parse_args()

    if args.snapshot_db_only:
        export_snapshot_from_db(snapshot_full_raw=args.snapshot_full_raw, awb_limit=args.awb_limit)
        raise SystemExit(0)

    asyncio.run(
        pull_all_data(
            enrich_by_awb=not args.no_enrich_by_awb,
            concurrency=args.concurrency,
            awb_limit=args.awb_limit,
            snapshot_full_raw=args.snapshot_full_raw,
        )
    )
