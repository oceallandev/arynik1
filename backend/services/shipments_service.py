from __future__ import annotations

from datetime import datetime, timezone
import re
from typing import Any, Dict, List, Optional, Tuple

from sqlalchemy import text
from sqlalchemy.orm import Session

try:
    from .. import models
except ImportError:  # pragma: no cover
    import models  # type: ignore

try:
    from .phone_service import normalize_phone
except ImportError:  # pragma: no cover
    from phone_service import normalize_phone  # type: ignore


def _now_utc_naive() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _as_str(value: Any) -> str:
    if value is None:
        return ""
    return str(value).strip()


def _to_float(value: Any) -> Optional[float]:
    try:
        if value is None or value == "":
            return None
        return float(value)
    except Exception:
        return None


def _to_int(value: Any) -> Optional[int]:
    try:
        if value is None or value == "":
            return None
        return int(value)
    except Exception:
        return None


def _parse_dt(value: Any) -> Optional[datetime]:
    """Parse Postis timestamps into naive UTC datetimes for DB storage."""
    if not value:
        return None
    if isinstance(value, datetime):
        dt = value
    else:
        s = _as_str(value)
        if not s:
            return None
        try:
            if s.endswith("Z"):
                s = s[:-1] + "+00:00"
            dt = datetime.fromisoformat(s)
        except Exception:
            return None

    if dt.tzinfo is not None:
        dt = dt.astimezone(timezone.utc).replace(tzinfo=None)
    return dt


def ensure_shipments_schema(db: Session) -> None:
    """Add new columns to the shipments table if missing (lightweight runtime migration)."""
    try:
        dialect = db.bind.dialect.name  # type: ignore[union-attr]
    except Exception:
        dialect = ""

    columns = [
        ("recipient_phone_norm", "TEXT", "TEXT"),
        ("raw_data", "JSONB", "JSON"),
        ("shipping_cost", "DOUBLE PRECISION", "REAL"),
        ("estimated_shipping_cost", "DOUBLE PRECISION", "REAL"),
        ("currency", "TEXT", "TEXT"),
    ]

    if dialect == "postgresql":
        try:
            exists = db.execute(
                text("SELECT 1 FROM information_schema.tables WHERE table_name = 'shipments' LIMIT 1")
            ).fetchone()
        except Exception:
            exists = None
        if not exists:
            return

        for name, pg_type, _sqlite_type in columns:
            db.execute(text(f"ALTER TABLE shipments ADD COLUMN IF NOT EXISTS {name} {pg_type}"))
        db.commit()
        return

    if dialect == "sqlite":
        try:
            exists = db.execute(
                text("SELECT name FROM sqlite_master WHERE type='table' AND name='shipments' LIMIT 1")
            ).fetchone()
        except Exception:
            exists = None
        if not exists:
            return

        existing = [row[1] for row in db.execute(text("PRAGMA table_info(shipments)")).fetchall()]
        for name, _pg_type, sqlite_type in columns:
            if name in existing:
                continue
            db.execute(text(f"ALTER TABLE shipments ADD COLUMN {name} {sqlite_type}"))
            db.commit()
        return


def backfill_recipient_phone_norm(db: Session, *, batch_size: int = 2000, max_batches: int = 20) -> int:
    """
    Best-effort data hygiene: populate recipient_phone_norm for existing rows so we can
    filter shipments for recipient accounts efficiently.

    Returns the number of updated rows.
    """
    ensure_shipments_schema(db)

    total_changed = 0
    for _ in range(max_batches):
        rows = (
            db.query(models.Shipment)
            .filter(models.Shipment.recipient_phone.isnot(None))
            .filter((models.Shipment.recipient_phone_norm.is_(None)) | (models.Shipment.recipient_phone_norm == ""))
            .limit(max(1, int(batch_size or 2000)))
            .all()
        )
        if not rows:
            break

        changed = 0
        for ship in rows:
            norm = normalize_phone(ship.recipient_phone) if ship.recipient_phone else None
            if norm and ship.recipient_phone_norm != norm:
                ship.recipient_phone_norm = norm
                changed += 1

        if changed:
            db.commit()
            total_changed += changed
        else:
            break

    return total_changed


def _normalize_status(ship_data: Dict[str, Any]) -> str:
    raw = (
        ship_data.get("clientShipmentStatusDescription")
        or ship_data.get("processingStatus")
        or ship_data.get("status")
        or ship_data.get("currentStatus")
        or ship_data.get("defaultClientStatus")
    )

    text_val = _as_str(raw)
    lower = text_val.strip().lower()

    if lower in ("livrat", "delivered"):
        return "Delivered"
    if lower in ("initial", "routed", "in transit", "in_transit", "in tranzit", "in_tranzit"):
        return "In Transit"
    if lower in ("refuzat", "refused"):
        return "Refused"

    return text_val or "pending"


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

    if isinstance(trace, dict):
        trace = trace.get("items") or trace.get("events") or trace.get("trace") or []

    if not isinstance(trace, list):
        return []

    return [ev for ev in trace if isinstance(ev, dict)]


def _extract_lat_lon(ship_data: Dict[str, Any]) -> Tuple[Optional[float], Optional[float]]:
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


def _compute_dimensions(ship_data: Dict[str, Any]) -> Optional[str]:
    l = _to_float(ship_data.get("length"))
    w = _to_float(ship_data.get("width"))
    h = _to_float(ship_data.get("height"))
    if l and w and h:
        # Postis uses cm (observed). Store a user-friendly string.
        return f"{int(l)}x{int(w)}x{int(h)} cm"
    dims = _as_str(ship_data.get("dimensions"))
    return dims or None


def _clip_text(value: str, *, max_len: int = 500) -> str:
    text_val = _as_str(value)
    if not text_val:
        return ""
    if len(text_val) <= max_len:
        return text_val
    return text_val[: max(0, max_len - 3)].rstrip() + "..."


def _extract_content_description(ship_data: Dict[str, Any]) -> Optional[str]:
    """
    Best-effort extraction of package content from Postis payloads.

    Postis payloads differ by endpoint/account; some return a single `contentDescription`,
    others include an items/products list. We normalize into a single user-facing string.
    """
    if not isinstance(ship_data, dict):
        return None

    def _render_items(items: Any) -> Optional[str]:
        if isinstance(items, dict):
            items = items.get("items") or items.get("products") or items.get("content") or items.get("goods")
        if isinstance(items, str):
            s = _as_str(items)
            return _clip_text(s) if s else None
        if not isinstance(items, list):
            return None

        parts: List[str] = []
        seen: set[str] = set()
        for it in items:
            if isinstance(it, str):
                name = _as_str(it)
                if not name:
                    continue
                if name not in seen:
                    parts.append(name)
                    seen.add(name)
                continue
            if not isinstance(it, dict):
                continue

            qty = _to_int(it.get("quantity") or it.get("qty") or it.get("count") or it.get("pieces") or it.get("no"))
            name = _as_str(
                it.get("name")
                or it.get("title")
                or it.get("description")
                or it.get("productName")
                or it.get("itemName")
                or it.get("articleName")
                or it.get("product")
                or it.get("item")
            )
            if not name:
                name = _as_str(it.get("sku") or it.get("code") or it.get("productCode") or it.get("articleCode"))
            if not name:
                continue

            rendered = f"{qty}x {name}" if qty and qty > 1 else name
            if rendered in seen:
                continue
            parts.append(rendered)
            seen.add(rendered)

            # Avoid giant strings.
            if len(parts) >= 12:
                break

        if parts:
            return _clip_text("; ".join(parts), max_len=500)
        return None

    # Common direct fields (observed + defensive aliases).
    direct_keys = (
        "contentDescription",
        "contents",
        "content",
        "content_description",
        "packageContent",
        "packageContents",
        "shipmentContent",
        "shipmentContents",
        "goodsDescription",
        "descriptionOfGoods",
        "parcelContent",
        "parcelContents",
        "descriere",
        "continut",
    )
    for key in direct_keys:
        s = _as_str(ship_data.get(key))
        if s:
            return _clip_text(s)

    # Some payloads embed it under `additionalServices` or nested "details" objects.
    for container_key in ("additionalServices", "shipment", "details", "clientOrder", "order"):
        obj = ship_data.get(container_key)
        if not isinstance(obj, dict):
            continue
        for key in direct_keys:
            s = _as_str(obj.get(key))
            if s:
                return _clip_text(s)

    # Itemized content.
    list_keys = (
        "items",
        "shipmentItems",
        "orderItems",
        "products",
        "productItems",
        "articles",
        "articleItems",
        "goods",
        "packages",
        "parcels",
    )
    for key in list_keys:
        rendered = _render_items(ship_data.get(key))
        if rendered:
            return rendered

    # Deep search (defensive): content might be nested under various keys. We only treat lists as item lists
    # when their parent key suggests "items/products/goods" to avoid false positives (e.g., trace history).
    content_key_re = re.compile(r"(content|continut|goodsdescription|descriptionofgoods)", re.IGNORECASE)
    items_key_re = re.compile(r"(items|products|articles|goods)", re.IGNORECASE)

    stack: List[Tuple[Any, int]] = [(ship_data, 0)]
    seen: set[int] = set()
    while stack:
        current, depth = stack.pop()
        if depth > 6:
            continue
        try:
            obj_id = id(current)
        except Exception:
            obj_id = 0
        if obj_id and obj_id in seen:
            continue
        if obj_id:
            seen.add(obj_id)

        if isinstance(current, dict):
            for k, v in current.items():
                key_name = str(k)
                if content_key_re.search(key_name) and isinstance(v, str) and v.strip():
                    return _clip_text(v)

                if isinstance(v, list) and items_key_re.search(key_name):
                    rendered = _render_items(v)
                    if rendered:
                        return rendered

                if isinstance(v, (dict, list)):
                    stack.append((v, depth + 1))
        elif isinstance(current, list):
            for v in current:
                if isinstance(v, (dict, list)):
                    stack.append((v, depth + 1))

    return None


def _extract_payment_fields(ship_data: Dict[str, Any]) -> Tuple[Optional[float], Optional[float], Optional[str]]:
    shipping_cost = _to_float(ship_data.get("shippingCost") or ship_data.get("shipping_cost"))
    estimated = _to_float(ship_data.get("estimatedShippingCost") or ship_data.get("estimated_shipping_cost"))
    currency = _as_str(ship_data.get("currency") or ship_data.get("paymentCurrency") or ship_data.get("currencyCode")) or None
    if not currency:
        # Default for Romania.
        currency = "RON"
    return shipping_cost, estimated, currency


def payment_amount(shipping_cost: Optional[float], estimated_shipping_cost: Optional[float]) -> Optional[float]:
    # Best-effort: prefer the carrier cost, fall back to estimated.
    if shipping_cost is not None and shipping_cost != 0:
        return shipping_cost
    if estimated_shipping_cost is not None and estimated_shipping_cost != 0:
        return estimated_shipping_cost
    return None


def build_upsert_payload(ship_data: Dict[str, Any]) -> Dict[str, Any]:
    awb = _get_awb(ship_data)
    if not awb:
        raise ValueError("Missing AWB")

    recipient_loc = ship_data.get("recipientLocation") or {}
    if not isinstance(recipient_loc, dict):
        recipient_loc = {}

    sender_loc = ship_data.get("senderLocation") or {}
    if not isinstance(sender_loc, dict):
        sender_loc = {}

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
    number_of_parcels = (
        ship_data.get("numberOfDistinctBarcodes")
        or ship_data.get("numberOfParcels")
        or ship_data.get("number_of_parcels")
        or 1
    )
    declared_value = _to_float(ship_data.get("declaredValue") or ship_data.get("declared_value")) or 0.0

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

    shipping_cost, estimated_shipping_cost, currency = _extract_payment_fields(ship_data)

    recipient_phone_raw = _as_str(recipient_loc.get("phoneNumber") or ship_data.get("recipientPhoneNumber") or ship_data.get("phone") or "") or None
    payload = {
        "awb": awb,
        "recipient_name": _as_str(recipient_loc.get("name") or ship_data.get("recipientName") or ship_data.get("recipient") or "Unknown"),
        "recipient_phone": recipient_phone_raw,
        "recipient_phone_norm": normalize_phone(recipient_phone_raw) if recipient_phone_raw else None,
        "recipient_email": _as_str(recipient_loc.get("email") or ship_data.get("recipientEmail") or "") or None,
        "delivery_address": _as_str(recipient_loc.get("addressText") or ship_data.get("address") or ship_data.get("recipientAddress") or ""),
        "locality": _as_str(recipient_loc.get("locality") or ship_data.get("city") or ship_data.get("recipientLocality") or ""),
        "latitude": lat,
        "longitude": lon,
        "status": status,
        "weight": weight,
        "volumetric_weight": volumetric_weight,
        "dimensions": _compute_dimensions(ship_data),
        "content_description": _extract_content_description(ship_data),
        "cod_amount": cod_amount,
        "shipping_cost": shipping_cost,
        "estimated_shipping_cost": estimated_shipping_cost,
        "currency": currency,
        "declared_value": declared_value,
        "number_of_parcels": int(number_of_parcels) if number_of_parcels else 1,
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
        "last_updated": _now_utc_naive(),
        "raw_data": ship_data,
    }

    return payload


def upsert_shipment_and_events(db: Session, ship_data: Dict[str, Any]) -> models.Shipment:
    ensure_shipments_schema(db)

    payload = build_upsert_payload(ship_data)
    awb = payload["awb"]

    existing: Optional[models.Shipment] = db.query(models.Shipment).filter(models.Shipment.awb == awb).first()

    if existing:
        # Keep explicit assignment unless caller is implementing reassignment logic.
        driver_id = existing.driver_id
        for k, v in payload.items():
            if k == "awb":
                continue
            # Don't wipe existing data when an endpoint returns partial payloads.
            if v is None:
                continue
            if isinstance(v, str) and not v.strip():
                continue
            if isinstance(v, (dict, list)) and len(v) == 0:
                continue
            setattr(existing, k, v)
        existing.driver_id = driver_id
        ship = existing
    else:
        # New shipments are unassigned until a dispatcher/admin allocates them to a driver/truck.
        ship = models.Shipment(**payload, driver_id=None)
        db.add(ship)

    db.flush()  # ensure ship.id exists

    trace = _extract_trace(ship_data)
    if trace:
        db.query(models.ShipmentEvent).filter(models.ShipmentEvent.shipment_id == ship.id).delete(synchronize_session=False)
        for ev in trace:
            desc = _as_str(
                ev.get("eventDescription")
                or ev.get("statusDescription")
                or (ev.get("courierShipmentStatus") or {}).get("statusDescription")
            )
            when = _parse_dt(ev.get("eventDate") or ev.get("createdDate") or ev.get("date"))
            loc_name = _as_str(ev.get("localityName") or ev.get("locality") or "")
            if not desc and not when:
                continue
            db.add(
                models.ShipmentEvent(
                    shipment_id=ship.id,
                    event_description=desc or "Update",
                    event_date=when or _now_utc_naive(),
                    locality_name=loc_name,
                )
            )

    return ship


def shipment_to_dict(ship: models.Shipment, *, include_raw_data: bool = False, include_events: bool = False, db: Optional[Session] = None) -> Dict[str, Any]:
    recipient_loc = ship.recipient_location or {}
    if not isinstance(recipient_loc, dict):
        recipient_loc = {}

    county = _as_str(recipient_loc.get("county") or recipient_loc.get("countyName") or "")
    raw_data = None
    if include_raw_data:
        try:
            raw_data = ship.raw_data
        except Exception:
            raw_data = None

    events: List[Dict[str, Any]] = []
    if include_events:
        if db is not None:
            items = (
                db.query(models.ShipmentEvent)
                .filter(models.ShipmentEvent.shipment_id == ship.id)
                .order_by(models.ShipmentEvent.event_date.desc())
                .all()
            )
        else:
            items = list(ship.events or [])

        for ev in items:
            events.append(
                {
                    "eventDescription": ev.event_description,
                    "eventDate": ev.event_date.isoformat() if ev.event_date else None,
                    "localityName": ev.locality_name,
                }
            )

    shipping_cost = getattr(ship, "shipping_cost", None)
    estimated = getattr(ship, "estimated_shipping_cost", None)

    return {
        "awb": ship.awb,
        "status": ship.status or "pending",
        "recipient_name": ship.recipient_name or "Unknown",
        "recipient_phone": ship.recipient_phone,
        "recipient_email": ship.recipient_email,
        "delivery_address": ship.delivery_address or "",
        "locality": ship.locality or "",
        "county": county or None,
        "latitude": ship.latitude,
        "longitude": ship.longitude,
        "weight": ship.weight or 0.0,
        "volumetric_weight": ship.volumetric_weight or 0.0,
        "dimensions": ship.dimensions or "",
        "content_description": ship.content_description or "",
        "cod_amount": ship.cod_amount or 0.0,
        "declared_value": ship.declared_value or 0.0,
        "number_of_parcels": ship.number_of_parcels or 1,
        "shipping_cost": shipping_cost,
        "estimated_shipping_cost": estimated,
        "currency": ship.currency or "RON",
        "payment_amount": payment_amount(shipping_cost, estimated),
        "delivery_instructions": ship.delivery_instructions or "",
        "driver_id": ship.driver_id,
        "last_updated": ship.last_updated.isoformat() if ship.last_updated else None,
        "created_date": ship.created_date.isoformat() if ship.created_date else None,
        "awb_status_date": ship.awb_status_date.isoformat() if ship.awb_status_date else None,
        "shipment_reference": ship.shipment_reference,
        "client_order_id": ship.client_order_id,
        "postis_order_id": ship.postis_order_id,
        "source_channel": ship.source_channel,
        "send_type": ship.send_type,
        "sender_shop_name": ship.sender_shop_name,
        "processing_status": ship.processing_status,
        "tracking_history": events if include_events else [],
        "raw_data": raw_data,
    }
