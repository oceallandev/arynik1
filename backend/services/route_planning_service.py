from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import unicodedata
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from types import SimpleNamespace
from typing import Any, Dict, List, Optional, Tuple
from zoneinfo import ZoneInfo

from sqlalchemy import func, inspect as sa_inspect, text
from sqlalchemy.orm import Session

try:
    from .. import authz, database, models
    from . import fleet_service, postis_sync_service, shipments_service, vehicle_types_service
except ImportError:  # pragma: no cover
    import authz  # type: ignore
    import database, models  # type: ignore
    import fleet_service  # type: ignore
    import postis_sync_service  # type: ignore
    import shipments_service  # type: ignore
    import vehicle_types_service  # type: ignore


logger = logging.getLogger(__name__)

STATUS_DRAFT = "Draft"
STATUS_APPROVED = "Approved"
STATUS_ASSIGNED = "Assigned"
LOCKED_STATUSES = {STATUS_APPROVED, STATUS_ASSIGNED}

DEFAULT_PARCEL_WEIGHT_KG = 2.0
DEFAULT_PARCEL_VOLUME_M3 = 0.05
VOLUMETRIC_KG_PER_M3 = 250.0
DEFAULT_TIMEZONE = "Europe/Bucharest"

_MOLDOVA_COUNTIES: List[Dict[str, Any]] = [
    {"name": "Bacau", "code": "BC", "aliases": ["bacau", "bacău", "bc"]},
    {"name": "Iasi", "code": "IS", "aliases": ["iasi", "iași", "is"]},
    {"name": "Neamt", "code": "NT", "aliases": ["neamt", "neamț", "nt"]},
    {"name": "Vrancea", "code": "VN", "aliases": ["vrancea", "vn"]},
    {"name": "Botosani", "code": "BT", "aliases": ["botosani", "botoșani", "bt"]},
    {"name": "Suceava", "code": "SV", "aliases": ["suceava", "sv"]},
    {"name": "Vaslui", "code": "VS", "aliases": ["vaslui", "vs"]},
]

_COUNTY_BY_KEY = {
    str(c["name"]).strip().lower(): c for c in _MOLDOVA_COUNTIES
}

_ROUTING_ALLOWED_TOKENS = [
    "intrare in depozit",
    "in depozitul curierului",
    "courier warehouse",
    "in depot",
    "depozitul curierului",
    "depozit curier",
    "out for delivery",
    "in curs de livrare",
    "in livrare",
    "livrare reprogramata",
    "reprogramat",
    "reschedule",
]

_ROUTING_BLOCKING_TOKENS = [
    "finalizare pregatire depozit",
    "initial",
    "pending",
    "in asteptare",
    "expediere preluata de curier",
    "expeditie preluata de curier",
    "expedierea a fost preluata de curier",
    "preluata de curier",
    "picked up by courier",
    "shipment picked up",
    "incarcat la curier",
    "in transit",
    "in tranzit",
]

_ROUTING_TERMINAL_TOKENS = [
    "delivered",
    "livrat",
    "livrata",
    "expediere livrata",
    "anulata",
    "cancelled",
    "canceled",
    "expediere anulata",
]

_ROUTING_REFUSED_TOKENS = [
    "refuzare colet",
    "livrare refuzata",
    "refuzat",
    "refused",
]

_ROUTING_RESCHEDULED_TOKENS = [
    "livrare reprogramata",
    "reprogramat",
    "reschedule",
]

_TRUTHY = {"1", "true", "yes", "y", "on"}
_FALSY = {"0", "false", "no", "n", "off", ""}


def _route_planning_use_capacity() -> bool:
    raw = os.getenv("ROUTE_PLANNING_USE_CAPACITY")
    if raw is None:
        # Default OFF for reliability; can be enabled from env when needed.
        return False
    val = str(raw).strip().lower()
    if val in _TRUTHY:
        return True
    if val in _FALSY:
        return False
    return False


def _route_planning_max_stops_per_route() -> Optional[int]:
    """
    Max stops limit per route.

    - empty / 0 / negative => unlimited
    - positive integer => hard cap
    """
    raw = str(os.getenv("ROUTE_PLANNING_MAX_STOPS_PER_ROUTE", "0") or "0").strip()
    try:
        n = int(raw)
    except Exception:
        n = 0
    if n <= 0:
        return None
    return max(1, n)


_ROUTE_PLANNING_USE_CAPACITY = _route_planning_use_capacity()
_ROUTE_PLANNING_MAX_STOPS_PER_ROUTE = _route_planning_max_stops_per_route()


def ensure_route_plans_schema(db: Session) -> bool:
    required = {c.name for c in models.RoutePlan.__table__.columns}
    try:
        # Best effort create (first install). This may fail on restricted DB users.
        models.RoutePlan.__table__.create(bind=db.get_bind(), checkfirst=True)
    except Exception as e:
        logger.warning("Route plans table create skipped/failed: %s", str(e))

    try:
        # Best effort runtime migration. Do not hard-fail if ALTER is restricted.
        _ensure_route_plan_columns(db)
    except Exception as e:
        logger.warning("Route plans migration skipped/failed: %s", str(e))

    try:
        existing = _route_plan_existing_columns(db)
    except Exception:
        return False
    if not existing:
        return False

    missing = sorted(required.difference(existing))
    if missing:
        logger.error("Route plans schema missing columns: %s", ", ".join(missing))
        return False
    return True


def _route_plan_existing_columns(db: Session) -> set[str]:
    try:
        insp = sa_inspect(db.get_bind())
        names = [str(col.get("name") or "").strip() for col in insp.get_columns("route_plans")]
        return {n for n in names if n}
    except Exception:
        pass

    # Fallback for SQLite environments where inspector may be unavailable/limited.
    try:
        rows = db.execute(text("PRAGMA table_info(route_plans)")).fetchall()
        return {str(r[1]).strip() for r in rows if len(r) > 1 and str(r[1]).strip()}
    except Exception:
        return set()


def _ensure_route_plan_columns(db: Session) -> None:
    try:
        dialect = db.bind.dialect.name  # type: ignore[union-attr]
    except Exception:
        dialect = ""

    columns = [
        ("created_at", "TIMESTAMP", "TEXT"),
        ("updated_at", "TIMESTAMP", "TEXT"),
        ("plan_date", "TEXT", "TEXT"),
        ("county", "TEXT", "TEXT"),
        ("route_index", "INTEGER", "INTEGER"),
        ("name", "TEXT", "TEXT"),
        ("status", "TEXT", "TEXT"),
        ("generated_at", "TIMESTAMP", "TEXT"),
        ("generated_by_user_id", "TEXT", "TEXT"),
        ("generated_trigger", "TEXT", "TEXT"),
        ("approved_at", "TIMESTAMP", "TEXT"),
        ("approved_by_user_id", "TEXT", "TEXT"),
        ("assigned_at", "TIMESTAMP", "TEXT"),
        ("assigned_by_user_id", "TEXT", "TEXT"),
        ("assigned_vehicle_plate", "TEXT", "TEXT"),
        ("assigned_driver_id", "TEXT", "TEXT"),
        ("assigned_driver_name", "TEXT", "TEXT"),
        ("assigned_helper_name", "TEXT", "TEXT"),
        ("assigned_phone", "TEXT", "TEXT"),
        ("vehicle_type_code", "TEXT", "TEXT"),
        ("vehicle_has_lift", "BOOLEAN", "INTEGER"),
        ("max_volume_m3", "DOUBLE PRECISION", "REAL"),
        ("target_volume_m3", "DOUBLE PRECISION", "REAL"),
        ("max_weight_kg", "DOUBLE PRECISION", "REAL"),
        ("target_weight_kg", "DOUBLE PRECISION", "REAL"),
        ("awb_count", "INTEGER", "INTEGER"),
        ("awbs", "JSONB", "JSON"),
        ("over_capacity_awbs", "JSONB", "JSON"),
        ("issues", "JSONB", "JSON"),
        ("load_volume_m3", "DOUBLE PRECISION", "REAL"),
        ("load_weight_kg", "DOUBLE PRECISION", "REAL"),
        ("utilization_volume_pct", "DOUBLE PRECISION", "REAL"),
        ("utilization_weight_pct", "DOUBLE PRECISION", "REAL"),
        ("data", "JSONB", "JSON"),
    ]

    if dialect == "postgresql":
        try:
            exists = db.execute(
                text("SELECT 1 FROM information_schema.tables WHERE table_name = 'route_plans' LIMIT 1")
            ).fetchone()
        except Exception:
            exists = None
        if not exists:
            return
        for name, pg_type, _sqlite_type in columns:
            db.execute(text(f"ALTER TABLE route_plans ADD COLUMN IF NOT EXISTS {name} {pg_type}"))
        db.commit()
        return

    if dialect == "sqlite":
        try:
            exists = db.execute(
                text("SELECT name FROM sqlite_master WHERE type='table' AND name='route_plans' LIMIT 1")
            ).fetchone()
        except Exception:
            exists = None
        if not exists:
            return

        existing = [row[1] for row in db.execute(text("PRAGMA table_info(route_plans)")).fetchall()]
        for name, _pg_type, sqlite_type in columns:
            if name in existing:
                continue
            db.execute(text(f"ALTER TABLE route_plans ADD COLUMN {name} {sqlite_type}"))
        db.commit()


def _strip_diacritics(value: Any) -> str:
    text = str(value or "")
    try:
        text = unicodedata.normalize("NFD", text)
        text = "".join(ch for ch in text if unicodedata.category(ch) != "Mn")
    except Exception:
        pass
    return text


def _normalize_text(value: Any) -> str:
    text = _strip_diacritics(value).strip().lower()
    text = re.sub(r"[_-]+", " ", text)
    text = re.sub(r"\s+", " ", text)
    return text


def _normalize_awb(value: Any) -> str:
    return str(value or "").strip().upper()


def _coerce_int(value: Any, *, default: int = 0, minimum: Optional[int] = None) -> int:
    try:
        if value is None:
            return default
        if isinstance(value, bool):
            return default
        if isinstance(value, int):
            out = value
        elif isinstance(value, float):
            out = int(value)
        else:
            txt = str(value).strip()
            if not txt:
                return default
            if re.fullmatch(r"[+-]?\d+", txt):
                out = int(txt)
            else:
                out = int(float(txt))
    except Exception:
        return default
    if minimum is not None and out < minimum:
        return default
    return out


def _coerce_float(value: Any, *, default: float = 0.0) -> float:
    try:
        if value is None:
            return default
        if isinstance(value, bool):
            return default
        return float(value)
    except Exception:
        return default


def _safe_route_index(value: Any, *, default: int = 1) -> int:
    return _coerce_int(value, default=default, minimum=1)


def _safe_json_list(value: Any) -> List[Any]:
    if value is None:
        return []
    if isinstance(value, list):
        return value
    if isinstance(value, tuple):
        return list(value)
    if isinstance(value, set):
        return list(value)
    if isinstance(value, str):
        txt = value.strip()
        if not txt:
            return []
        try:
            parsed = json.loads(txt)
            if isinstance(parsed, list):
                return parsed
            if parsed is None:
                return []
        except Exception:
            parsed = None
        if "," in txt:
            return [part.strip() for part in txt.split(",") if part.strip()]
        return [txt]
    return []


def _sanitize_existing_route_rows(rows: List[models.RoutePlan]) -> None:
    """
    Normalize legacy/malformed DB values in-memory before planning.
    """
    used_keys: set[Tuple[str, int]] = set()
    for row in rows or []:
        county_key = _normalize_county_key(getattr(row, "county", None))
        idx = _safe_route_index(getattr(row, "route_index", None), default=1)
        while (county_key, idx) in used_keys:
            idx += 1
        row.route_index = idx
        used_keys.add((county_key, idx))

        awbs = [_normalize_awb(a) for a in _safe_json_list(getattr(row, "awbs", None)) if _normalize_awb(a)]
        over = [_normalize_awb(a) for a in _safe_json_list(getattr(row, "over_capacity_awbs", None)) if _normalize_awb(a)]
        row.awbs = awbs
        row.over_capacity_awbs = over
        row.awb_count = _coerce_int(getattr(row, "awb_count", None), default=len(awbs), minimum=0)


def _decode_maybe_json(value: Any) -> Any:
    if isinstance(value, (dict, list)):
        return value
    if not isinstance(value, str):
        return value
    txt = value.strip()
    if not txt:
        return value
    if (txt.startswith("{") and txt.endswith("}")) or (txt.startswith("[") and txt.endswith("]")):
        try:
            return json.loads(txt)
        except Exception:
            return value
    return value


def _load_shipments_for_planning(db: Session) -> List[Any]:
    try:
        return db.query(models.Shipment).all()
    except Exception as first_error:
        logger.warning("Shipments ORM query failed, fallback to raw select: %s", str(first_error))

    existing: set[str] = set()
    try:
        insp = sa_inspect(db.get_bind())
        existing = {
            str(col.get("name") or "").strip()
            for col in insp.get_columns("shipments")
            if str(col.get("name") or "").strip()
        }
    except Exception:
        try:
            rows = db.execute(text("PRAGMA table_info(shipments)")).fetchall()
            existing = {str(r[1]).strip() for r in rows if len(r) > 1 and str(r[1]).strip()}
        except Exception:
            existing = set()

    wanted = [
        "awb",
        "status",
        "recipient_name",
        "locality",
        "delivery_address",
        "weight",
        "volumetric_weight",
        "dimensions",
        "processing_status",
        "recipient_location",
        "recipient_pin",
        "client_data",
        "raw_data",
    ]
    selected = [name for name in wanted if name in existing]
    if "awb" not in selected:
        return []

    stmt = text(f"SELECT {', '.join(selected)} FROM shipments")
    rows = db.execute(stmt).mappings().all()
    json_like = {"recipient_location", "recipient_pin", "client_data", "raw_data"}
    out: List[Any] = []
    for row in rows:
        payload: Dict[str, Any] = {}
        for name in wanted:
            if name not in selected:
                payload[name] = None
                continue
            val = row.get(name)
            payload[name] = _decode_maybe_json(val) if name in json_like else val
        out.append(SimpleNamespace(**payload))
    return out


def _to_positive_number(value: Any) -> Optional[float]:
    try:
        n = float(value)
    except Exception:
        return None
    if n <= 0:
        return None
    return n


def _round(value: Any, decimals: int = 2) -> float:
    try:
        n = float(value)
    except Exception:
        return 0.0
    if n != n:  # NaN
        return 0.0
    return round(n, int(decimals))


def _normalize_county_key(value: Any) -> str:
    return _normalize_text(value)


def _extract_place_name(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, (str, int, float)):
        return str(value)
    if isinstance(value, dict):
        for key in (
            "name",
            "label",
            "value",
            "countyName",
            "localityName",
            "cityName",
            "regionName",
            "county",
            "locality",
            "city",
            "region",
            "countyCode",
        ):
            if key in value and value.get(key) is not None:
                nested = _extract_place_name(value.get(key))
                if nested:
                    return nested
    return ""


def _county_match(source_text: str, alias_text: str) -> bool:
    if not source_text or not alias_text:
        return False
    if source_text == alias_text:
        return True
    if len(alias_text) <= 2:
        tokens = [x for x in re.split(r"[^a-z0-9]+", source_text) if x]
        return alias_text in tokens
    return alias_text in source_text


def _resolve_moldova_county(raw_value: Any) -> Optional[str]:
    source = _normalize_county_key(_extract_place_name(raw_value))
    if not source:
        return None

    for county in _MOLDOVA_COUNTIES:
        all_aliases = [county.get("name"), county.get("code"), *(county.get("aliases") or [])]
        for alias in all_aliases:
            key = _normalize_county_key(alias)
            if key and _county_match(source, key):
                return str(county.get("name"))
    return None


def infer_shipment_county(shipment: models.Shipment) -> Optional[str]:
    recipient_location = getattr(shipment, "recipient_location", None) or {}
    recipient_pin = getattr(shipment, "recipient_pin", None) or {}
    client_data = getattr(shipment, "client_data", None) or {}
    raw_data = getattr(shipment, "raw_data", None) or {}

    candidates = [
        recipient_location,
        recipient_pin,
        client_data,
        raw_data.get("recipientLocation") if isinstance(raw_data, dict) else None,
        raw_data.get("recipient_location") if isinstance(raw_data, dict) else None,
        raw_data.get("recipientPin") if isinstance(raw_data, dict) else None,
        raw_data.get("recipient_pin") if isinstance(raw_data, dict) else None,
        raw_data.get("county") if isinstance(raw_data, dict) else None,
        raw_data.get("countyName") if isinstance(raw_data, dict) else None,
        raw_data.get("destinationCounty") if isinstance(raw_data, dict) else None,
        raw_data.get("receiverCounty") if isinstance(raw_data, dict) else None,
        raw_data,
        getattr(shipment, "locality", None),
        getattr(shipment, "delivery_address", None),
        recipient_location.get("county") if isinstance(recipient_location, dict) else None,
        recipient_location.get("countyName") if isinstance(recipient_location, dict) else None,
        recipient_location.get("region") if isinstance(recipient_location, dict) else None,
        recipient_location.get("regionName") if isinstance(recipient_location, dict) else None,
        recipient_pin.get("county") if isinstance(recipient_pin, dict) else None,
        recipient_pin.get("countyName") if isinstance(recipient_pin, dict) else None,
        recipient_pin.get("region") if isinstance(recipient_pin, dict) else None,
        recipient_pin.get("regionName") if isinstance(recipient_pin, dict) else None,
        recipient_pin.get("countyCode") if isinstance(recipient_pin, dict) else None,
        client_data.get("county") if isinstance(client_data, dict) else None,
        client_data.get("countyName") if isinstance(client_data, dict) else None,
        client_data.get("region") if isinstance(client_data, dict) else None,
        client_data.get("regionName") if isinstance(client_data, dict) else None,
    ]

    for item in candidates:
        resolved = _resolve_moldova_county(item)
        if resolved:
            return resolved
    return None


def _normalize_status_text(value: Any) -> str:
    return _normalize_text(value)


def _collect_status_signals(shipment: models.Shipment) -> Tuple[str, List[str]]:
    raw_data = getattr(shipment, "raw_data", None) or {}
    client_status = None
    if isinstance(raw_data, dict):
        client_status = raw_data.get("clientShipmentStatus")

    latest_tracking_desc = None
    if isinstance(raw_data, dict):
        history = raw_data.get("trackingHistory")
        if isinstance(history, list) and history:
            last = history[-1]
            if isinstance(last, dict):
                latest_tracking_desc = (
                    last.get("eventDescription")
                    or last.get("description")
                    or last.get("statusDescription")
                )

    secondary: List[str] = []
    for value in (
        getattr(shipment, "processing_status", None),
        raw_data.get("statusDescription") if isinstance(raw_data, dict) else None,
        raw_data.get("eventDescription") if isinstance(raw_data, dict) else None,
        raw_data.get("lastEventDescription") if isinstance(raw_data, dict) else None,
        latest_tracking_desc,
        client_status if isinstance(client_status, str) else None,
        client_status.get("clientShipmentStatusDescription") if isinstance(client_status, dict) else None,
        client_status.get("statusDescription") if isinstance(client_status, dict) else None,
        client_status.get("defaultClientStatus") if isinstance(client_status, dict) else None,
        client_status.get("processingStatus") if isinstance(client_status, dict) else None,
        client_status.get("description") if isinstance(client_status, dict) else None,
    ):
        norm = _normalize_status_text(value)
        if norm:
            secondary.append(norm)

    primary = _normalize_status_text(getattr(shipment, "status", None))
    return primary, secondary


def _status_tokens_from_env(name: str, defaults: List[str]) -> List[str]:
    raw = str(os.getenv(name, "") or "").strip()
    if not raw:
        return list(defaults)

    out: List[str] = []
    seen: set[str] = set()
    for token in [*defaults, *re.split(r"[,\n;|]+", raw)]:
        norm = _normalize_status_text(token)
        if not norm or norm in seen:
            continue
        seen.add(norm)
        out.append(norm)
    return out


_ROUTING_ALLOWED_RUNTIME = _status_tokens_from_env("ROUTE_PLANNING_ALLOWED_TOKENS", _ROUTING_ALLOWED_TOKENS)
_ROUTING_BLOCKING_RUNTIME = _status_tokens_from_env("ROUTE_PLANNING_BLOCKING_TOKENS", _ROUTING_BLOCKING_TOKENS)
_ROUTING_TERMINAL_RUNTIME = _status_tokens_from_env("ROUTE_PLANNING_TERMINAL_TOKENS", _ROUTING_TERMINAL_TOKENS)
_ROUTING_REFUSED_RUNTIME = _status_tokens_from_env("ROUTE_PLANNING_REFUSED_TOKENS", _ROUTING_REFUSED_TOKENS)
_ROUTING_RESCHEDULED_RUNTIME = _status_tokens_from_env("ROUTE_PLANNING_RESCHEDULED_TOKENS", _ROUTING_RESCHEDULED_TOKENS)


def _split_csv_env(name: str, default: str = "") -> set[str]:
    raw = str(os.getenv(name, default) or "").strip()
    if not raw:
        return set()
    out: set[str] = set()
    for token in re.split(r"[,\n;|]+", raw):
        key = _normalize_text(token)
        if key:
            out.add(key)
    return out


def _excluded_vehicle_type_codes() -> set[str]:
    raw = str(os.getenv("ROUTE_PLANNING_EXCLUDED_VEHICLE_TYPES", "TIR_40T") or "").strip()
    if not raw:
        return set()
    out: set[str] = set()
    for token in re.split(r"[,\n;|]+", raw):
        code = str(token or "").strip().upper()
        if code:
            out.add(code)
    return out


_ROUTE_PLANNING_EXCLUDED_VEHICLE_TYPES = _excluded_vehicle_type_codes()
_ROUTE_PLANNING_EXCLUDED_DRIVER_IDS = _split_csv_env("ROUTE_PLANNING_EXCLUDED_DRIVER_IDS", "D002")
_ROUTE_PLANNING_EXCLUDED_DRIVER_USERNAMES = _split_csv_env("ROUTE_PLANNING_EXCLUDED_DRIVER_USERNAMES", "demo")
_ROUTE_PLANNING_EXCLUDED_DRIVER_NAME_TOKENS = _split_csv_env("ROUTE_PLANNING_EXCLUDED_DRIVER_NAME_TOKENS", "demo")
_ROUTE_PLANNING_EXCLUDED_DRIVER_IDS_UPPER = {x.upper() for x in _ROUTE_PLANNING_EXCLUDED_DRIVER_IDS}


def _is_excluded_route_driver(
    *,
    driver_id: Any = None,
    username: Any = None,
    name: Any = None,
) -> bool:
    did = _normalize_text(driver_id).upper()
    user = _normalize_text(username)
    nm = _normalize_text(name)

    if did and did in _ROUTE_PLANNING_EXCLUDED_DRIVER_IDS_UPPER:
        return True
    if user and user in _ROUTE_PLANNING_EXCLUDED_DRIVER_USERNAMES:
        return True
    if nm and any(tok and tok in nm for tok in _ROUTE_PLANNING_EXCLUDED_DRIVER_NAME_TOKENS):
        return True
    return False


def _status_contains_any_token(statuses: List[str], tokens: List[str]) -> bool:
    if not statuses or not tokens:
        return False
    return any(any(tok in txt for tok in tokens) for txt in statuses if txt)


def _parse_date_candidate(value: Any) -> Optional[date]:
    if value is None:
        return None
    if isinstance(value, date) and not isinstance(value, datetime):
        return value
    if isinstance(value, datetime):
        return value.date()

    txt = str(value or "").strip()
    if not txt:
        return None
    if txt.endswith("Z"):
        txt = txt[:-1] + "+00:00"

    for parser in (
        lambda v: datetime.fromisoformat(v),
        lambda v: datetime.strptime(v, "%Y-%m-%d %H:%M:%S"),
        lambda v: datetime.strptime(v, "%Y-%m-%d %H:%M"),
        lambda v: datetime.strptime(v, "%Y-%m-%d"),
        lambda v: datetime.strptime(v, "%d.%m.%Y %H:%M"),
        lambda v: datetime.strptime(v, "%d.%m.%Y"),
        lambda v: datetime.strptime(v, "%Y/%m/%d"),
    ):
        try:
            return parser(txt).date()
        except Exception:
            continue
    return None


def _extract_reschedule_delivery_date(shipment: models.Shipment) -> Optional[date]:
    raw_data = getattr(shipment, "raw_data", None) or {}
    if not isinstance(raw_data, dict):
        raw_data = {}

    client_status = raw_data.get("clientShipmentStatus") if isinstance(raw_data.get("clientShipmentStatus"), dict) else {}
    ndr = raw_data.get("ndr") if isinstance(raw_data.get("ndr"), dict) else {}
    routing_meta = raw_data.get("routing") if isinstance(raw_data.get("routing"), dict) else {}
    additional_services = raw_data.get("additionalServices") if isinstance(raw_data.get("additionalServices"), dict) else {}
    client_data = getattr(shipment, "client_data", None) if isinstance(getattr(shipment, "client_data", None), dict) else {}

    candidates = [
        raw_data.get("reschedule_at"),
        raw_data.get("rescheduleAt"),
        raw_data.get("deliveryDate"),
        raw_data.get("delivery_date"),
        raw_data.get("nextDeliveryDate"),
        raw_data.get("next_delivery_date"),
        ndr.get("reschedule_at"),
        ndr.get("rescheduleAt"),
        ndr.get("desired_date"),
        ndr.get("delivery_date"),
        routing_meta.get("reschedule_at"),
        routing_meta.get("rescheduleAt"),
        routing_meta.get("delivery_date"),
        routing_meta.get("next_delivery_date"),
        client_status.get("rescheduleAt"),
        client_status.get("rescheduleDate"),
        client_status.get("deliveryDate"),
        client_status.get("nextDeliveryDate"),
        additional_services.get("rescheduleAt"),
        additional_services.get("rescheduleDate"),
        client_data.get("rescheduleAt"),
        client_data.get("rescheduleDate"),
    ]
    for cand in candidates:
        parsed = _parse_date_candidate(cand)
        if parsed:
            return parsed
    return None


def classify_shipment_for_routing(
    shipment: models.Shipment,
    *,
    plan_date: Optional[str] = None,
) -> Dict[str, Any]:
    primary, secondary = _collect_status_signals(shipment)
    primary_signals = [s for s in [primary] if s]
    secondary_signals = [s for s in (secondary or []) if s]
    signals = [*primary_signals, *secondary_signals]
    if not signals:
        return {"eligible": False, "refused_waiting": False, "rescheduled_future": False, "reason": "missing_status"}

    # Primary status has higher trust than secondary/legacy fields such as processing_status.
    if _status_contains_any_token(primary_signals, _ROUTING_TERMINAL_RUNTIME):
        return {"eligible": False, "refused_waiting": False, "rescheduled_future": False, "reason": "terminal"}
    if _status_contains_any_token(primary_signals, _ROUTING_REFUSED_RUNTIME):
        return {"eligible": False, "refused_waiting": True, "rescheduled_future": False, "reason": "refused_waiting"}
    if _status_contains_any_token(primary_signals, _ROUTING_ALLOWED_RUNTIME):
        is_rescheduled = _status_contains_any_token(signals, _ROUTING_RESCHEDULED_RUNTIME)
        if is_rescheduled:
            plan_day = _parse_date_candidate(plan_date)
            reschedule_day = _extract_reschedule_delivery_date(shipment)
            if plan_day and reschedule_day and reschedule_day > plan_day:
                return {
                    "eligible": False,
                    "refused_waiting": False,
                    "rescheduled_future": True,
                    "reason": "rescheduled_future",
                    "reschedule_for_date": reschedule_day.isoformat(),
                }
        out: Dict[str, Any] = {
            "eligible": True,
            "refused_waiting": False,
            "rescheduled_future": False,
            "reason": "allowed_status_primary",
        }
        if is_rescheduled:
            reschedule_day = _extract_reschedule_delivery_date(shipment)
            if reschedule_day:
                out["reschedule_for_date"] = reschedule_day.isoformat()
        return out

    if _status_contains_any_token(signals, _ROUTING_TERMINAL_RUNTIME):
        return {"eligible": False, "refused_waiting": False, "rescheduled_future": False, "reason": "terminal"}

    if _status_contains_any_token(signals, _ROUTING_REFUSED_RUNTIME):
        return {"eligible": False, "refused_waiting": True, "rescheduled_future": False, "reason": "refused_waiting"}

    if _status_contains_any_token(signals, _ROUTING_BLOCKING_RUNTIME):
        return {"eligible": False, "refused_waiting": False, "rescheduled_future": False, "reason": "blocked_status"}

    is_rescheduled = _status_contains_any_token(signals, _ROUTING_RESCHEDULED_RUNTIME)
    if is_rescheduled:
        plan_day = _parse_date_candidate(plan_date)
        reschedule_day = _extract_reschedule_delivery_date(shipment)
        if plan_day and reschedule_day and reschedule_day > plan_day:
            return {
                "eligible": False,
                "refused_waiting": False,
                "rescheduled_future": True,
                "reason": "rescheduled_future",
                "reschedule_for_date": reschedule_day.isoformat(),
            }

    if _status_contains_any_token(signals, _ROUTING_ALLOWED_RUNTIME):
        out: Dict[str, Any] = {
            "eligible": True,
            "refused_waiting": False,
            "rescheduled_future": False,
            "reason": "allowed_status",
        }
        if is_rescheduled:
            reschedule_day = _extract_reschedule_delivery_date(shipment)
            if reschedule_day:
                out["reschedule_for_date"] = reschedule_day.isoformat()
        return out

    return {"eligible": False, "refused_waiting": False, "rescheduled_future": False, "reason": "not_allowed"}


def is_routing_eligible_shipment(shipment: models.Shipment, *, plan_date: Optional[str] = None) -> bool:
    return bool(classify_shipment_for_routing(shipment, plan_date=plan_date).get("eligible"))


def is_routing_fallback_candidate(shipment: models.Shipment, *, plan_date: Optional[str] = None) -> bool:
    """
    Relaxed eligibility used only when strict planning produced zero candidates.
    """
    classification = classify_shipment_for_routing(shipment, plan_date=plan_date)
    if classification.get("refused_waiting") or classification.get("rescheduled_future"):
        return False

    primary, secondary = _collect_status_signals(shipment)
    signals = [s for s in [primary, *secondary] if s]
    if not signals:
        return False

    if any(any(token in sig for token in _ROUTING_TERMINAL_RUNTIME) for sig in signals):
        return False

    if any(any(token in sig for token in _ROUTING_BLOCKING_RUNTIME) for sig in signals):
        return False

    return True


def _parse_dimensions_volume_m3(raw_value: Any) -> Optional[float]:
    text = str(raw_value or "").strip().lower()
    if not text:
        return None
    cleaned = text.replace("cm", "").replace(",", ".")
    nums = re.findall(r"[-+]?[0-9]*\.?[0-9]+", cleaned)
    if len(nums) < 3:
        return None
    try:
        l, w, h = float(nums[0]), float(nums[1]), float(nums[2])
    except Exception:
        return None
    if l <= 0 or w <= 0 or h <= 0:
        return None

    # Heuristic: values above ~3.5m are usually provided in mm, not cm.
    divisor = 1_000_000_000.0 if max(l, w, h) > 350 else 1_000_000.0
    volume = (l * w * h) / divisor
    if volume <= 0:
        return None
    if volume > 25.0:
        return None
    return volume


def shipment_load(shipment: models.Shipment) -> Dict[str, float]:
    raw_data = getattr(shipment, "raw_data", None) or {}
    weight = _to_positive_number(getattr(shipment, "weight", None))
    volumetric_weight = _to_positive_number(getattr(shipment, "volumetric_weight", None))

    dims_volume = _parse_dimensions_volume_m3(getattr(shipment, "dimensions", None))
    if dims_volume is None and isinstance(raw_data, dict):
        dims_volume = _parse_dimensions_volume_m3(raw_data.get("dimensions"))

    volume_from_volumetric = None
    if volumetric_weight:
        volume_from_volumetric = volumetric_weight / VOLUMETRIC_KG_PER_M3

    volume = _to_positive_number(dims_volume) or _to_positive_number(volume_from_volumetric) or DEFAULT_PARCEL_VOLUME_M3
    physical_weight = weight or DEFAULT_PARCEL_WEIGHT_KG
    effective_weight = max(physical_weight, volumetric_weight or 0.0, DEFAULT_PARCEL_WEIGHT_KG)

    return {
        "volume_m3": _round(volume, 4),
        "weight_kg": _round(effective_weight, 3),
    }


def _coord_to_float(value: Any) -> Optional[float]:
    try:
        if value is None:
            return None
        if isinstance(value, str):
            txt = value.strip().replace(",", ".")
            if not txt:
                return None
            return float(txt)
        return float(value)
    except Exception:
        return None


def _valid_coord_pair(lat: Any, lon: Any) -> bool:
    la = _coord_to_float(lat)
    lo = _coord_to_float(lon)
    if la is None or lo is None:
        return False
    if la < -90 or la > 90 or lo < -180 or lo > 180:
        return False
    if abs(la) < 0.0001 and abs(lo) < 0.0001:
        return False
    return True


def _infer_shipment_locality(shipment: models.Shipment) -> str:
    recipient_location = getattr(shipment, "recipient_location", None) or {}
    recipient_pin = getattr(shipment, "recipient_pin", None) or {}
    raw_data = getattr(shipment, "raw_data", None) or {}

    candidates = [
        getattr(shipment, "locality", None),
        recipient_pin.get("localityName") if isinstance(recipient_pin, dict) else None,
        recipient_pin.get("locality") if isinstance(recipient_pin, dict) else None,
        recipient_pin.get("cityName") if isinstance(recipient_pin, dict) else None,
        recipient_pin.get("city") if isinstance(recipient_pin, dict) else None,
        recipient_location.get("localityName") if isinstance(recipient_location, dict) else None,
        recipient_location.get("locality") if isinstance(recipient_location, dict) else None,
        recipient_location.get("cityName") if isinstance(recipient_location, dict) else None,
        recipient_location.get("city") if isinstance(recipient_location, dict) else None,
        raw_data.get("locality") if isinstance(raw_data, dict) else None,
        raw_data.get("city") if isinstance(raw_data, dict) else None,
    ]
    for item in candidates:
        value = _extract_place_name(item)
        if value:
            return value
    return ""


def _shipment_stop_hint(shipment: models.Shipment, county: Optional[str] = None) -> Dict[str, Any]:
    recipient_location = getattr(shipment, "recipient_location", None) or {}
    recipient_pin = getattr(shipment, "recipient_pin", None) or {}

    lat_candidates = [
        getattr(shipment, "latitude", None),
        recipient_pin.get("latitude") if isinstance(recipient_pin, dict) else None,
        recipient_pin.get("lat") if isinstance(recipient_pin, dict) else None,
        recipient_location.get("latitude") if isinstance(recipient_location, dict) else None,
        recipient_location.get("lat") if isinstance(recipient_location, dict) else None,
    ]
    lon_candidates = [
        getattr(shipment, "longitude", None),
        recipient_pin.get("longitude") if isinstance(recipient_pin, dict) else None,
        recipient_pin.get("lon") if isinstance(recipient_pin, dict) else None,
        recipient_pin.get("lng") if isinstance(recipient_pin, dict) else None,
        recipient_location.get("longitude") if isinstance(recipient_location, dict) else None,
        recipient_location.get("lon") if isinstance(recipient_location, dict) else None,
        recipient_location.get("lng") if isinstance(recipient_location, dict) else None,
    ]

    lat = next((x for x in (_coord_to_float(v) for v in lat_candidates) if x is not None), None)
    lon = next((x for x in (_coord_to_float(v) for v in lon_candidates) if x is not None), None)
    if not _valid_coord_pair(lat, lon):
        lat = None
        lon = None

    county_name = str(county or infer_shipment_county(shipment) or "").strip()
    return {
        "awb": _normalize_awb(getattr(shipment, "awb", None)),
        "recipient_name": str(getattr(shipment, "recipient_name", "") or "").strip() or None,
        "delivery_address": str(getattr(shipment, "delivery_address", "") or "").strip() or None,
        "locality": _infer_shipment_locality(shipment) or None,
        "county": county_name or None,
        "latitude": float(lat) if lat is not None else None,
        "longitude": float(lon) if lon is not None else None,
        "status": str(getattr(shipment, "status", "") or "").strip() or None,
    }


def _resolve_vehicle_capacity(
    *,
    vehicle_type_code: Optional[str],
    max_volume_m3: Any = None,
    target_volume_m3: Any = None,
    max_weight_kg: Any = None,
    target_weight_kg: Any = None,
) -> Dict[str, Any]:
    code = vehicle_types_service.normalize_vehicle_type_code(vehicle_type_code) or "VAN_35T"
    defaults = vehicle_types_service.defaults_for_type(code)

    max_vol = _to_positive_number(max_volume_m3) or _to_positive_number(defaults.get("max_volume_m3"))
    target_vol = _to_positive_number(target_volume_m3) or _to_positive_number(defaults.get("target_volume_m3")) or max_vol
    max_kg = _to_positive_number(max_weight_kg) or _to_positive_number(defaults.get("max_weight_kg"))
    target_kg = _to_positive_number(target_weight_kg) or _to_positive_number(defaults.get("target_weight_kg")) or max_kg

    return {
        "vehicle_type_code": code,
        "max_volume_m3": max_vol,
        "target_volume_m3": target_vol,
        "max_weight_kg": max_kg,
        "target_weight_kg": target_kg,
    }


def _build_vehicle_pool(db: Session) -> List[Dict[str, Any]]:
    pool: List[Dict[str, Any]] = []
    seen_plates: set[str] = set()

    try:
        fleet_service.ensure_fleet_schema(db)
        fleet_service.sync_vehicles_from_drivers(db)
    except Exception:
        try:
            db.rollback()
        except Exception:
            pass

    for row in (
        db.query(models.FleetVehicle)
        .filter(models.FleetVehicle.active.is_(True))
        .order_by(models.FleetVehicle.updated_at.desc(), models.FleetVehicle.id.asc())
        .all()
    ):
        if _is_excluded_route_driver(
            driver_id=getattr(row, "assigned_driver_id", None),
            name=getattr(row, "assigned_driver_name", None),
        ):
            continue

        plate = str(getattr(row, "plate", "") or "").strip().upper() or None
        if plate and plate in seen_plates:
            continue
        if plate:
            seen_plates.add(plate)

        cap = _resolve_vehicle_capacity(
            vehicle_type_code=getattr(row, "vehicle_type_code", None),
            max_volume_m3=getattr(row, "max_volume_m3", None),
            target_volume_m3=getattr(row, "target_volume_m3", None),
            max_weight_kg=getattr(row, "max_weight_kg", None),
            target_weight_kg=getattr(row, "target_weight_kg", None),
        )
        if str(cap.get("vehicle_type_code") or "").strip().upper() in _ROUTE_PLANNING_EXCLUDED_VEHICLE_TYPES:
            continue
        pool.append(
            {
                "vehicle_plate": plate,
                "vehicle_has_lift": bool(getattr(row, "vehicle_has_lift", False)),
                **cap,
            }
        )

    for row in (
        db.query(models.Driver)
        .filter(models.Driver.active.is_(True))
        .all()
    ):
        role = authz.normalize_role(getattr(row, "role", None))
        if role != authz.ROLE_DRIVER:
            continue
        if _is_excluded_route_driver(
            driver_id=getattr(row, "driver_id", None),
            username=getattr(row, "username", None),
            name=getattr(row, "name", None),
        ):
            continue

        plate = str(getattr(row, "truck_plate", "") or "").strip().upper() or None
        if plate and plate in seen_plates:
            continue
        if plate:
            seen_plates.add(plate)

        cap = _resolve_vehicle_capacity(
            vehicle_type_code=getattr(row, "vehicle_type_code", None),
            max_volume_m3=getattr(row, "max_volume_m3", None),
            target_volume_m3=getattr(row, "target_volume_m3", None),
            max_weight_kg=getattr(row, "max_weight_kg", None),
            target_weight_kg=getattr(row, "target_weight_kg", None),
        )
        if str(cap.get("vehicle_type_code") or "").strip().upper() in _ROUTE_PLANNING_EXCLUDED_VEHICLE_TYPES:
            continue
        pool.append(
            {
                "vehicle_plate": plate,
                "vehicle_has_lift": bool(getattr(row, "vehicle_has_lift", False)),
                **cap,
            }
        )

    if not pool:
        pool.append(
            {
                "vehicle_plate": None,
                "vehicle_has_lift": False,
                **_resolve_vehicle_capacity(vehicle_type_code="VAN_35T"),
            }
        )

    pool.sort(
        key=lambda x: (
            -float(x.get("target_volume_m3") or 0.0),
            -float(x.get("target_weight_kg") or 0.0),
            str(x.get("vehicle_plate") or ""),
        )
    )
    return pool


def _fits_bin(bin_state: Dict[str, Any], item: Dict[str, Any]) -> bool:
    stop_count = len([x for x in (bin_state.get("awbs") or []) if _normalize_awb(x)])
    if isinstance(_ROUTE_PLANNING_MAX_STOPS_PER_ROUTE, int) and _ROUTE_PLANNING_MAX_STOPS_PER_ROUTE > 0 and stop_count >= _ROUTE_PLANNING_MAX_STOPS_PER_ROUTE:
        return False

    if not _ROUTE_PLANNING_USE_CAPACITY:
        return True

    cap_vol = _to_positive_number(bin_state.get("target_volume_m3"))
    cap_kg = _to_positive_number(bin_state.get("target_weight_kg"))
    next_vol = float(bin_state.get("load_volume_m3") or 0.0) + float(item.get("volume_m3") or 0.0)
    next_kg = float(bin_state.get("load_weight_kg") or 0.0) + float(item.get("weight_kg") or 0.0)
    if cap_vol is not None and next_vol > cap_vol + 1e-9:
        return False
    if cap_kg is not None and next_kg > cap_kg + 1e-9:
        return False
    return True


def _fit_score(bin_state: Dict[str, Any], item: Dict[str, Any]) -> float:
    if not _ROUTE_PLANNING_USE_CAPACITY:
        # Keep bins balanced by number of stops when capacity planning is disabled.
        return float(len([x for x in (bin_state.get("awbs") or []) if _normalize_awb(x)]))

    cap_vol = _to_positive_number(bin_state.get("target_volume_m3"))
    cap_kg = _to_positive_number(bin_state.get("target_weight_kg"))
    next_vol = float(bin_state.get("load_volume_m3") or 0.0) + float(item.get("volume_m3") or 0.0)
    next_kg = float(bin_state.get("load_weight_kg") or 0.0) + float(item.get("weight_kg") or 0.0)
    vol_waste = ((cap_vol - next_vol) / cap_vol) if cap_vol else 0.0
    kg_waste = ((cap_kg - next_kg) / cap_kg) if cap_kg else 0.0
    return max(0.0, vol_waste) + max(0.0, kg_waste)


def _create_bin(vehicle: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "vehicle_type_code": vehicle.get("vehicle_type_code"),
        "vehicle_has_lift": bool(vehicle.get("vehicle_has_lift")),
        "max_volume_m3": _to_positive_number(vehicle.get("max_volume_m3")),
        "target_volume_m3": _to_positive_number(vehicle.get("target_volume_m3")),
        "max_weight_kg": _to_positive_number(vehicle.get("max_weight_kg")),
        "target_weight_kg": _to_positive_number(vehicle.get("target_weight_kg")),
        "vehicle_plate": vehicle.get("vehicle_plate"),
        "awbs": [],
        "load_volume_m3": 0.0,
        "load_weight_kg": 0.0,
        "over_capacity_awbs": [],
    }


def _plan_county_routes(
    *,
    county: str,
    items: List[Dict[str, Any]],
    vehicle_pool: List[Dict[str, Any]],
) -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]]]:
    if not items:
        return [], []

    if _ROUTE_PLANNING_USE_CAPACITY:
        ref = vehicle_pool[0] if vehicle_pool else _create_bin({"vehicle_type_code": "VAN_35T"})
        ref_vol = _to_positive_number(ref.get("target_volume_m3")) or 1.0
        ref_kg = _to_positive_number(ref.get("target_weight_kg")) or 1.0
        ranked = sorted(
            items,
            key=lambda it: max(
                float(it.get("volume_m3") or 0.0) / ref_vol,
                float(it.get("weight_kg") or 0.0) / ref_kg,
            ),
            reverse=True,
        )
    else:
        ranked = sorted(items, key=lambda it: str(it.get("awb") or ""))

    bins: List[Dict[str, Any]] = []
    over_capacity_items: List[Dict[str, Any]] = []

    for item in ranked:
        best_idx: Optional[int] = None
        best_score: Optional[float] = None

        for idx, state in enumerate(bins):
            if not _fits_bin(state, item):
                continue
            score = _fit_score(state, item)
            if best_idx is None or score < float(best_score or 0):
                best_idx = idx
                best_score = score

        if best_idx is None:
            vehicle_idx = min(len(bins), max(0, len(vehicle_pool) - 1))
            next_vehicle = vehicle_pool[vehicle_idx]
            next_bin = _create_bin(next_vehicle)
            bins.append(next_bin)
            if _fits_bin(next_bin, item):
                best_idx = len(bins) - 1

        if best_idx is None:
            # If one single AWB exceeds all available capacities, force it into the least-loaded bin.
            if not bins:
                bins.append(_create_bin(vehicle_pool[0]))
            best_idx = min(
                range(len(bins)),
                key=lambda i: (
                    float(bins[i].get("load_volume_m3") or 0.0),
                    float(bins[i].get("load_weight_kg") or 0.0),
                ),
            )
            bins[best_idx]["over_capacity_awbs"].append(item.get("awb"))
            over_capacity_items.append(
                {
                    "awb": item.get("awb"),
                    "county": county,
                    "reason": "shipment_exceeds_vehicle_capacity",
                }
            )

        target = bins[best_idx]
        target["awbs"].append(item.get("awb"))
        target["load_volume_m3"] = float(target.get("load_volume_m3") or 0.0) + float(item.get("volume_m3") or 0.0)
        target["load_weight_kg"] = float(target.get("load_weight_kg") or 0.0) + float(item.get("weight_kg") or 0.0)

    for state in bins:
        cap_vol = _to_positive_number(state.get("target_volume_m3")) if _ROUTE_PLANNING_USE_CAPACITY else None
        cap_kg = _to_positive_number(state.get("target_weight_kg")) if _ROUTE_PLANNING_USE_CAPACITY else None
        state["load_volume_m3"] = _round(state.get("load_volume_m3"), 4)
        state["load_weight_kg"] = _round(state.get("load_weight_kg"), 3)
        state["utilization_volume_pct"] = _round((state["load_volume_m3"] / cap_vol) * 100.0, 1) if cap_vol else None
        state["utilization_weight_pct"] = _round((state["load_weight_kg"] / cap_kg) * 100.0, 1) if cap_kg else None

    return bins, over_capacity_items


def route_plan_to_dict(plan: models.RoutePlan) -> Dict[str, Any]:
    awbs = [_normalize_awb(a) for a in _safe_json_list(getattr(plan, "awbs", None)) if _normalize_awb(a)]
    over_capacity_awbs = [
        _normalize_awb(a)
        for a in _safe_json_list(getattr(plan, "over_capacity_awbs", None))
        if _normalize_awb(a)
    ]
    return {
        "id": _coerce_int(plan.id, default=0),
        "plan_date": plan.plan_date,
        "county": plan.county,
        "route_index": _safe_route_index(plan.route_index, default=1),
        "name": plan.name,
        "status": plan.status,
        "generated_at": plan.generated_at,
        "generated_by_user_id": plan.generated_by_user_id,
        "generated_trigger": plan.generated_trigger,
        "approved_at": plan.approved_at,
        "approved_by_user_id": plan.approved_by_user_id,
        "assigned_at": plan.assigned_at,
        "assigned_by_user_id": plan.assigned_by_user_id,
        "assigned_vehicle_plate": plan.assigned_vehicle_plate,
        "assigned_driver_id": plan.assigned_driver_id,
        "assigned_driver_name": plan.assigned_driver_name,
        "assigned_helper_name": plan.assigned_helper_name,
        "assigned_phone": plan.assigned_phone,
        "vehicle_type_code": plan.vehicle_type_code,
        "vehicle_has_lift": bool(plan.vehicle_has_lift) if plan.vehicle_has_lift is not None else None,
        "max_volume_m3": plan.max_volume_m3,
        "target_volume_m3": plan.target_volume_m3,
        "max_weight_kg": plan.max_weight_kg,
        "target_weight_kg": plan.target_weight_kg,
        "awb_count": _coerce_int(plan.awb_count, default=len(awbs), minimum=0),
        "awbs": awbs,
        "over_capacity_awbs": over_capacity_awbs,
        "issues": plan.issues,
        "load_volume_m3": plan.load_volume_m3,
        "load_weight_kg": plan.load_weight_kg,
        "utilization_volume_pct": plan.utilization_volume_pct,
        "utilization_weight_pct": plan.utilization_weight_pct,
        "data": plan.data,
        "created_at": plan.created_at,
        "updated_at": plan.updated_at,
    }


def _default_plan_date() -> str:
    tz_name = str(os.getenv("AUTO_ROUTE_PLANNING_TZ", DEFAULT_TIMEZONE) or DEFAULT_TIMEZONE).strip() or DEFAULT_TIMEZONE
    try:
        tz = ZoneInfo(tz_name)
    except Exception:
        tz = ZoneInfo("UTC")
    return datetime.now(tz).date().isoformat()


def _normalize_plan_date(value: Optional[str]) -> str:
    raw = str(value or "").strip()
    if not raw:
        return _default_plan_date()
    try:
        return datetime.fromisoformat(raw).date().isoformat()
    except Exception:
        return _default_plan_date()


def generate_daily_route_plans(
    db: Session,
    *,
    plan_date: Optional[str] = None,
    generated_by_user_id: Optional[str] = None,
    trigger: str = "manual",
    county_filter: Optional[str] = None,
) -> Dict[str, Any]:
    if not ensure_route_plans_schema(db):
        raise RuntimeError("Route plans schema unavailable")
    try:
        shipments_service.ensure_shipments_schema(db)
    except Exception as e:
        logger.warning("Shipments schema migration skipped/failed for route planning: %s", str(e))

    target_date = _normalize_plan_date(plan_date)
    county_filter_key = _normalize_county_key(county_filter) if county_filter else ""
    now = datetime.utcnow()
    existing_rows = (
        db.query(models.RoutePlan)
        .filter(models.RoutePlan.plan_date == target_date)
        .all()
    )
    _sanitize_existing_route_rows(existing_rows)

    # Keep approved/assigned routes immutable and avoid replanning their AWBs.
    locked_awbs: set[str] = set()
    for row in existing_rows:
        if str(getattr(row, "status", STATUS_DRAFT) or STATUS_DRAFT) not in LOCKED_STATUSES:
            continue
        for awb in _safe_json_list(getattr(row, "awbs", None)):
            key = _normalize_awb(awb)
            if key:
                locked_awbs.add(key)

    shipments = _load_shipments_for_planning(db)
    county_candidates: Dict[str, List[Dict[str, Any]]] = {}
    stop_hints_by_awb: Dict[str, Dict[str, Any]] = {}
    fallback_candidates: List[Dict[str, Any]] = []

    deliverable_total = 0
    deliverable_in_moldova = 0
    fallback_deliverable_total = 0
    fallback_deliverable_in_moldova = 0
    fallback_mode_used = False
    missing_county_awbs: List[Dict[str, Any]] = []
    outside_region_awbs: List[Dict[str, Any]] = []
    refused_waiting_awbs: List[Dict[str, Any]] = []
    rescheduled_future_awbs: List[Dict[str, Any]] = []
    missing_seen: set[str] = set()
    outside_seen: set[str] = set()
    refused_seen: set[str] = set()
    rescheduled_seen: set[str] = set()

    for ship in shipments:
        try:
            awb = _normalize_awb(getattr(ship, "awb", None))
            if not awb:
                continue

            classification = classify_shipment_for_routing(ship, plan_date=target_date)
            if classification.get("refused_waiting"):
                if awb not in refused_seen:
                    refused_seen.add(awb)
                    refused_waiting_awbs.append(
                        {
                            "awb": awb,
                            "recipient_name": getattr(ship, "recipient_name", None),
                            "locality": getattr(ship, "locality", None),
                            "county": infer_shipment_county(ship),
                            "status": getattr(ship, "status", None),
                        }
                    )
                continue

            if classification.get("rescheduled_future"):
                if awb not in rescheduled_seen:
                    rescheduled_seen.add(awb)
                    rescheduled_future_awbs.append(
                        {
                            "awb": awb,
                            "recipient_name": getattr(ship, "recipient_name", None),
                            "locality": getattr(ship, "locality", None),
                            "county": infer_shipment_county(ship),
                            "status": getattr(ship, "status", None),
                            "reschedule_for_date": classification.get("reschedule_for_date"),
                        }
                    )
                continue

            if not classification.get("eligible"):
                if is_routing_fallback_candidate(ship, plan_date=target_date):
                    fallback_candidates.append({"ship": ship, "awb": awb})
                continue

            deliverable_total += 1

            county = infer_shipment_county(ship)
            if not county:
                if awb not in missing_seen:
                    missing_seen.add(awb)
                    missing_county_awbs.append(
                        {
                            "awb": awb,
                            "recipient_name": getattr(ship, "recipient_name", None),
                            "locality": getattr(ship, "locality", None),
                            "status": getattr(ship, "status", None),
                        }
                    )
                continue

            county_key = _normalize_county_key(county)
            county_spec = _COUNTY_BY_KEY.get(county_key)
            if not county_spec:
                if awb not in outside_seen:
                    outside_seen.add(awb)
                    outside_region_awbs.append(
                        {
                            "awb": awb,
                            "county": county,
                            "recipient_name": getattr(ship, "recipient_name", None),
                            "locality": getattr(ship, "locality", None),
                            "status": getattr(ship, "status", None),
                        }
                    )
                continue

            deliverable_in_moldova += 1
            stop_hints_by_awb.setdefault(awb, _shipment_stop_hint(ship, county=county))
            if awb in locked_awbs:
                # This AWB is already part of an approved/assigned route for the same day.
                continue
            load = shipment_load(ship)
            arr = county_candidates.get(county_key) or []
            arr.append(
                {
                    "awb": awb,
                    "volume_m3": float(load.get("volume_m3") or 0.0),
                    "weight_kg": float(load.get("weight_kg") or 0.0),
                }
            )
            county_candidates[county_key] = arr
        except Exception as e:
            logger.warning(
                "Skipping malformed shipment during route planning: awb=%s err=%s",
                str(getattr(ship, "awb", "") or "").strip().upper() or "-",
                str(e),
            )
            continue

    if not any(len(arr or []) > 0 for arr in county_candidates.values()) and fallback_candidates:
        fallback_mode_used = True
        for item in fallback_candidates:
            ship = item.get("ship")
            awb = str(item.get("awb") or "").strip().upper()
            if not ship or not awb:
                continue

            classification = classify_shipment_for_routing(ship, plan_date=target_date)
            if classification.get("refused_waiting") or classification.get("rescheduled_future"):
                continue

            fallback_deliverable_total += 1

            county = infer_shipment_county(ship)
            if not county:
                if awb not in missing_seen:
                    missing_seen.add(awb)
                    missing_county_awbs.append(
                        {
                            "awb": awb,
                            "recipient_name": getattr(ship, "recipient_name", None),
                            "locality": getattr(ship, "locality", None),
                            "status": getattr(ship, "status", None),
                        }
                    )
                continue

            county_key = _normalize_county_key(county)
            county_spec = _COUNTY_BY_KEY.get(county_key)
            if not county_spec:
                if awb not in outside_seen:
                    outside_seen.add(awb)
                    outside_region_awbs.append(
                        {
                            "awb": awb,
                            "county": county,
                            "recipient_name": getattr(ship, "recipient_name", None),
                            "locality": getattr(ship, "locality", None),
                            "status": getattr(ship, "status", None),
                        }
                    )
                continue

            fallback_deliverable_in_moldova += 1
            stop_hints_by_awb.setdefault(awb, _shipment_stop_hint(ship, county=county))
            if awb in locked_awbs:
                continue
            load = shipment_load(ship)
            arr = county_candidates.get(county_key) or []
            arr.append(
                {
                    "awb": awb,
                    "volume_m3": float(load.get("volume_m3") or 0.0),
                    "weight_kg": float(load.get("weight_kg") or 0.0),
                }
            )
            county_candidates[county_key] = arr

    vehicle_pool = _build_vehicle_pool(db)
    existing_by_key: Dict[Tuple[str, int], models.RoutePlan] = {}
    for row in existing_rows:
        key = (_normalize_county_key(row.county), _safe_route_index(getattr(row, "route_index", None), default=1))
        existing_by_key[key] = row
    locked_keys: set[Tuple[str, int]] = {
        (_normalize_county_key(row.county), _safe_route_index(getattr(row, "route_index", None), default=1))
        for row in existing_rows
        if str(getattr(row, "status", STATUS_DRAFT) or STATUS_DRAFT) in LOCKED_STATUSES
    }

    desired_keys: set[Tuple[str, int]] = set()
    created_routes = 0
    updated_routes = 0
    locked_routes = 0
    over_capacity_awbs: List[Dict[str, Any]] = []

    for county_spec in _MOLDOVA_COUNTIES:
        county_name = str(county_spec.get("name"))
        county_key = _normalize_county_key(county_name)
        if county_filter_key and county_key != county_filter_key:
            continue
        items = county_candidates.get(county_key) or []
        bins, overflow = _plan_county_routes(county=county_name, items=items, vehicle_pool=vehicle_pool)
        over_capacity_awbs.extend(overflow)

        next_route_index = 1
        for bin_state in bins:
            while (county_key, next_route_index) in locked_keys:
                next_route_index += 1
            idx = next_route_index
            next_route_index += 1

            key = (county_key, idx)
            desired_keys.add(key)
            row = existing_by_key.get(key)

            if row and str(row.status or STATUS_DRAFT) in LOCKED_STATUSES:
                locked_routes += 1
                continue

            if not row:
                row = models.RoutePlan(
                    plan_date=target_date,
                    county=county_name,
                    route_index=idx,
                    status=STATUS_DRAFT,
                    created_at=now,
                )
                db.add(row)
                created_routes += 1
            else:
                updated_routes += 1

            row.updated_at = now
            row.plan_date = target_date
            row.county = county_name
            row.route_index = idx
            row.name = county_name if idx == 1 else f"{county_name} #{idx}"
            row.status = STATUS_DRAFT

            row.generated_at = now
            row.generated_by_user_id = (str(generated_by_user_id or "").strip().upper() or None)
            row.generated_trigger = str(trigger or "").strip() or "manual"

            row.approved_at = None
            row.approved_by_user_id = None
            row.assigned_at = None
            row.assigned_by_user_id = None
            row.assigned_vehicle_plate = None
            row.assigned_driver_id = None
            row.assigned_driver_name = None
            row.assigned_helper_name = None
            row.assigned_phone = None

            row.vehicle_type_code = bin_state.get("vehicle_type_code")
            row.vehicle_has_lift = bool(bin_state.get("vehicle_has_lift"))
            row.max_volume_m3 = _to_positive_number(bin_state.get("max_volume_m3"))
            row.target_volume_m3 = _to_positive_number(bin_state.get("target_volume_m3"))
            row.max_weight_kg = _to_positive_number(bin_state.get("max_weight_kg"))
            row.target_weight_kg = _to_positive_number(bin_state.get("target_weight_kg"))

            awbs = [_normalize_awb(a) for a in (bin_state.get("awbs") or []) if _normalize_awb(a)]
            row.awbs = awbs
            row.awb_count = len(awbs)
            row.over_capacity_awbs = [a for a in (bin_state.get("over_capacity_awbs") or []) if _normalize_awb(a)]

            row.load_volume_m3 = _round(bin_state.get("load_volume_m3"), 4)
            row.load_weight_kg = _round(bin_state.get("load_weight_kg"), 3)
            row.utilization_volume_pct = _to_positive_number(bin_state.get("utilization_volume_pct"))
            row.utilization_weight_pct = _to_positive_number(bin_state.get("utilization_weight_pct"))

            row.issues = {
                "over_capacity_awbs": list(row.over_capacity_awbs or []),
            }
            stop_payload = []
            for awb in awbs:
                hint = stop_hints_by_awb.get(awb) or {"awb": awb}
                stop_payload.append(hint)
            row.data = {
                "suggested_vehicle_plate": bin_state.get("vehicle_plate"),
                "stops": stop_payload,
            }

    # Remove outdated draft rows (same day) that no longer exist in the fresh plan.
    for row in existing_rows:
        key = (_normalize_county_key(row.county), _safe_route_index(getattr(row, "route_index", None), default=1))
        if county_filter_key and _normalize_county_key(getattr(row, "county", None)) != county_filter_key:
            continue
        if key in desired_keys:
            continue
        if str(row.status or STATUS_DRAFT) in LOCKED_STATUSES:
            continue
        db.delete(row)

    db.commit()

    rows = (
        db.query(models.RoutePlan)
        .filter(models.RoutePlan.plan_date == target_date)
        .order_by(models.RoutePlan.county.asc(), models.RoutePlan.route_index.asc())
        .all()
    )

    county_plan: List[Dict[str, Any]] = []
    for county_spec in _MOLDOVA_COUNTIES:
        county_name = str(county_spec.get("name"))
        county_key = _normalize_county_key(county_name)
        if county_filter_key and county_key != county_filter_key:
            continue
        county_rows = [r for r in rows if _normalize_county_key(r.county) == _normalize_county_key(county_name)]
        county_plan.append(
            {
                "county": county_name,
                "routes": len(county_rows),
                "stops": int(sum(_coerce_int(getattr(r, "awb_count", None), default=0, minimum=0) for r in county_rows)),
                "load_volume_m3": _round(sum(_coerce_float(getattr(r, "load_volume_m3", None), default=0.0) for r in county_rows), 3),
                "load_weight_kg": _round(sum(_coerce_float(getattr(r, "load_weight_kg", None), default=0.0) for r in county_rows), 2),
            }
        )

    return {
        "date": target_date,
        "generated_at": now.isoformat() + "Z",
        "created_routes": created_routes,
        "updated_routes": updated_routes,
        "locked_routes": locked_routes,
        "allocated_awbs": int(sum(_coerce_int(getattr(r, "awb_count", None), default=0, minimum=0) for r in rows)),
        "deliverable_total": deliverable_total,
        "deliverable_in_moldova": deliverable_in_moldova,
        "capacity_planning_enabled": bool(_ROUTE_PLANNING_USE_CAPACITY),
        "max_stops_per_route": int(_ROUTE_PLANNING_MAX_STOPS_PER_ROUTE) if isinstance(_ROUTE_PLANNING_MAX_STOPS_PER_ROUTE, int) else None,
        "county_filter": str(county_filter or "").strip() or None,
        "fallback_mode_used": fallback_mode_used,
        "fallback_deliverable_total": fallback_deliverable_total,
        "fallback_deliverable_in_moldova": fallback_deliverable_in_moldova,
        "locked_awbs": len(locked_awbs),
        "missing_county": len(missing_county_awbs),
        "outside_region": len(outside_region_awbs),
        "over_capacity": len(over_capacity_awbs),
        "refused_waiting": len(refused_waiting_awbs),
        "rescheduled_future": len(rescheduled_future_awbs),
        "missing_county_awbs": missing_county_awbs,
        "outside_region_awbs": outside_region_awbs,
        "over_capacity_awbs": over_capacity_awbs,
        "refused_waiting_awbs": refused_waiting_awbs,
        "rescheduled_future_awbs": rescheduled_future_awbs,
        "county_plan": county_plan,
        "plans": [route_plan_to_dict(r) for r in rows],
    }


def generate_daily_route_plans_task(
    *,
    plan_date: Optional[str] = None,
    generated_by_user_id: Optional[str] = None,
    trigger: str = "manual",
) -> Dict[str, Any]:
    db = database.SessionLocal()
    try:
        return generate_daily_route_plans(
            db,
            plan_date=plan_date,
            generated_by_user_id=generated_by_user_id,
            trigger=trigger,
        )
    finally:
        db.close()


def list_route_plans(db: Session, *, plan_date: Optional[str] = None) -> List[models.RoutePlan]:
    if not ensure_route_plans_schema(db):
        return []
    query = db.query(models.RoutePlan)
    if plan_date:
        query = query.filter(models.RoutePlan.plan_date == _normalize_plan_date(plan_date))
    return query.order_by(models.RoutePlan.plan_date.desc(), models.RoutePlan.county.asc(), models.RoutePlan.route_index.asc()).all()


def get_route_plan(db: Session, plan_id: int) -> Optional[models.RoutePlan]:
    if not ensure_route_plans_schema(db):
        return None
    try:
        pid = int(plan_id)
    except Exception:
        return None
    return db.query(models.RoutePlan).filter(models.RoutePlan.id == pid).first()


def delete_route_plan_and_replan_county(
    db: Session,
    *,
    plan_id: int,
    deleted_by_user_id: Optional[str] = None,
) -> Dict[str, Any]:
    if not ensure_route_plans_schema(db):
        raise RuntimeError("Route plans schema unavailable")
    shipments_service.ensure_shipments_schema(db)

    row = get_route_plan(db, plan_id)
    if not row:
        raise ValueError("Route plan not found")

    target_date = _normalize_plan_date(getattr(row, "plan_date", None))
    county_name = str(getattr(row, "county", "") or "").strip() or None
    assigned_driver_id = str(getattr(row, "assigned_driver_id", "") or "").strip().upper() or None
    status_before = str(getattr(row, "status", "") or STATUS_DRAFT)
    awbs = [_normalize_awb(a) for a in _safe_json_list(getattr(row, "awbs", None)) if _normalize_awb(a)]
    deleted_route_id = int(getattr(row, "id", 0) or 0)

    db.delete(row)

    reset_assignment_count = 0
    if awbs:
        shipments = db.query(models.Shipment).filter(models.Shipment.awb.in_(awbs)).all()
        for ship in shipments:
            ship_driver_id = str(getattr(ship, "driver_id", "") or "").strip().upper() or None
            should_reset_driver = (assigned_driver_id is None) or (ship_driver_id == assigned_driver_id)
            if should_reset_driver and getattr(ship, "driver_id", None):
                ship.driver_id = None
                reset_assignment_count += 1
            ship.last_updated = datetime.utcnow()

            raw_data = getattr(ship, "raw_data", None)
            if isinstance(raw_data, dict):
                routing = raw_data.get("routing")
                if isinstance(routing, dict):
                    if str(routing.get("route_plan_id", "")).strip() == str(deleted_route_id):
                        routing["route_plan_id"] = None
                        routing["route_deleted_at"] = datetime.utcnow().isoformat() + "Z"
                        routing["route_deleted_by"] = str(deleted_by_user_id or "").strip().upper() or None
                        ship.raw_data = raw_data

    db.commit()

    summary = generate_daily_route_plans(
        db,
        plan_date=target_date,
        generated_by_user_id=deleted_by_user_id,
        trigger="route_delete_replan",
        county_filter=county_name,
    )

    return {
        "deleted_plan_id": deleted_route_id,
        "deleted_plan_status": status_before,
        "deleted_plan_date": target_date,
        "deleted_county": county_name,
        "deleted_awbs": awbs,
        "reset_assignment_count": int(reset_assignment_count),
        "replanned_summary": summary,
    }


def _next_manual_route_index(db: Session, *, plan_date: str, county: str) -> int:
    rows = (
        db.query(models.RoutePlan.route_index)
        .filter(models.RoutePlan.plan_date == str(plan_date))
        .filter(models.RoutePlan.county == str(county))
        .all()
    )
    max_idx = 0
    for row in rows:
        try:
            val = int(getattr(row, "route_index", None) if hasattr(row, "route_index") else row[0])
        except Exception:
            val = 0
        if val > max_idx:
            max_idx = val
    return max(1, max_idx + 1)


def create_manual_route_plan(
    db: Session,
    *,
    plan_date: Optional[str] = None,
    county: Optional[str] = None,
    route_index: Optional[int] = None,
    name: Optional[str] = None,
    awbs: Optional[List[str]] = None,
    assigned_driver_id: Optional[str] = None,
    assigned_driver_name: Optional[str] = None,
    assigned_helper_name: Optional[str] = None,
    assigned_phone: Optional[str] = None,
    assigned_vehicle_plate: Optional[str] = None,
    vehicle_type_code: Optional[str] = None,
    vehicle_has_lift: Optional[bool] = None,
    max_volume_m3: Any = None,
    target_volume_m3: Any = None,
    max_weight_kg: Any = None,
    target_weight_kg: Any = None,
    generated_by_user_id: Optional[str] = None,
    data: Any = None,
) -> models.RoutePlan:
    if not ensure_route_plans_schema(db):
        raise RuntimeError("Route plans schema unavailable")
    shipments_service.ensure_shipments_schema(db)

    target_date = _normalize_plan_date(plan_date)
    county_name = str(county or "").strip() or "Manual"
    route_name = str(name or "").strip() or f"{county_name} Manual"

    normalized_awbs: List[str] = []
    seen_awbs: set[str] = set()
    for raw in (awbs or []):
        awb = _normalize_awb(raw)
        if not awb or awb in seen_awbs:
            continue
        seen_awbs.add(awb)
        normalized_awbs.append(awb)
    if not normalized_awbs:
        raise ValueError("Route must include at least one AWB.")

    requested_index = None
    try:
        requested_index = int(route_index) if route_index is not None else None
    except Exception:
        requested_index = None
    if requested_index is not None and requested_index <= 0:
        requested_index = None

    if requested_index is not None:
        conflict = (
            db.query(models.RoutePlan.id)
            .filter(models.RoutePlan.plan_date == target_date)
            .filter(models.RoutePlan.county == county_name)
            .filter(models.RoutePlan.route_index == int(requested_index))
            .first()
        )
        if conflict:
            requested_index = None

    next_index = int(requested_index or _next_manual_route_index(db, plan_date=target_date, county=county_name))

    did = str(assigned_driver_id or "").strip() or None
    dname = str(assigned_driver_name or "").strip() or None
    hname = str(assigned_helper_name or "").strip() or None
    dphone = str(assigned_phone or "").strip() or None
    plate = str(assigned_vehicle_plate or "").strip().upper() or None

    target_driver = None
    if did:
        target_driver = (
            db.query(models.Driver)
            .filter(func.upper(models.Driver.driver_id) == did.upper())
            .filter(models.Driver.active.is_(True))
            .first()
        )
        if not target_driver:
            raise ValueError(f"Driver {did} not found or inactive.")
    elif plate:
        target_driver = _find_active_driver_by_plate(db, plate)

    if target_driver:
        did = str(target_driver.driver_id or "").strip() or did
        dname = dname or (str(target_driver.name or "").strip() or None)
        hname = hname or (str(target_driver.helper_name or "").strip() or None)
        dphone = dphone or (str(target_driver.phone_number or "").strip() or None)
        if not plate:
            plate = str(target_driver.truck_plate or "").strip().upper() or None

    cap = _resolve_vehicle_capacity(
        vehicle_type_code=vehicle_type_code,
        max_volume_m3=max_volume_m3,
        target_volume_m3=target_volume_m3,
        max_weight_kg=max_weight_kg,
        target_weight_kg=target_weight_kg,
    )

    shipments_by_awb: Dict[str, models.Shipment] = {}
    for ship in db.query(models.Shipment).filter(models.Shipment.awb.in_(normalized_awbs)).all():
        key = _normalize_awb(getattr(ship, "awb", None))
        if key:
            shipments_by_awb[key] = ship

    load_volume = 0.0
    load_weight = 0.0
    for awb in normalized_awbs:
        ship = shipments_by_awb.get(awb)
        if not ship:
            continue
        load = shipment_load(ship)
        load_volume += float(load.get("volume_m3") or 0.0)
        load_weight += float(load.get("weight_kg") or 0.0)

    load_volume = _round(load_volume, 4)
    load_weight = _round(load_weight, 3)
    cap_vol = _to_positive_number(cap.get("target_volume_m3"))
    cap_kg = _to_positive_number(cap.get("target_weight_kg"))
    utilization_volume_pct = _round((load_volume / cap_vol) * 100.0, 1) if cap_vol else None
    utilization_weight_pct = _round((load_weight / cap_kg) * 100.0, 1) if cap_kg else None

    now = datetime.utcnow()
    payload_data = {"source": "manual_local"}
    if isinstance(data, dict):
        payload_data.update(data)
    elif data is not None:
        payload_data["value"] = data
    if "stops" not in payload_data:
        stop_payload = []
        for awb in normalized_awbs:
            ship = shipments_by_awb.get(awb)
            if ship:
                stop_payload.append(_shipment_stop_hint(ship, county=infer_shipment_county(ship)))
            else:
                stop_payload.append({"awb": awb})
        payload_data["stops"] = stop_payload

    row = models.RoutePlan(
        plan_date=target_date,
        county=county_name,
        route_index=next_index,
        name=route_name,
        status=STATUS_DRAFT,
        generated_at=now,
        generated_by_user_id=str(generated_by_user_id or "").strip().upper() or None,
        generated_trigger="manual-local",
        assigned_vehicle_plate=plate,
        assigned_driver_id=did,
        assigned_driver_name=dname,
        assigned_helper_name=hname,
        assigned_phone=dphone,
        vehicle_type_code=cap.get("vehicle_type_code"),
        vehicle_has_lift=bool(vehicle_has_lift),
        max_volume_m3=cap.get("max_volume_m3"),
        target_volume_m3=cap.get("target_volume_m3"),
        max_weight_kg=cap.get("max_weight_kg"),
        target_weight_kg=cap.get("target_weight_kg"),
        awb_count=len(normalized_awbs),
        awbs=normalized_awbs,
        over_capacity_awbs=[],
        issues={},
        load_volume_m3=load_volume,
        load_weight_kg=load_weight,
        utilization_volume_pct=utilization_volume_pct,
        utilization_weight_pct=utilization_weight_pct,
        data=payload_data,
        created_at=now,
        updated_at=now,
    )
    db.add(row)
    return row


def approve_route_plan(db: Session, *, plan: models.RoutePlan, approved_by_user_id: str) -> models.RoutePlan:
    status = str(getattr(plan, "status", STATUS_DRAFT) or STATUS_DRAFT)
    if status == STATUS_ASSIGNED:
        raise ValueError("Route is already assigned.")
    if status not in (STATUS_DRAFT, STATUS_APPROVED):
        raise ValueError("Only Draft routes can be approved.")

    now = datetime.utcnow()
    plan.status = STATUS_APPROVED
    plan.approved_at = now
    plan.approved_by_user_id = str(approved_by_user_id or "").strip().upper() or None
    plan.updated_at = now
    return plan


def _driver_id_preference_rank(driver_id: Any) -> int:
    did = str(driver_id or "").strip().upper()
    if not did:
        return 9
    if did.startswith("DRV"):
        return 0
    if did.startswith("TIR"):
        return 1
    if did.startswith("D"):
        return 3
    return 2


def _driver_last_login_ts(value: Any) -> float:
    if not isinstance(value, datetime):
        return 0.0
    try:
        return float(value.timestamp())
    except Exception:
        return 0.0


def _driver_plate_candidate_sort_key(row: models.Driver) -> Tuple[int, int, float, str]:
    did = str(getattr(row, "driver_id", "") or "").strip().upper()
    username = str(getattr(row, "username", "") or "").strip()
    # Lower tuple wins:
    # 1) prefer standardized fleet ids (DRV*/TIR*), then generic legacy ids;
    # 2) prefer drivers with usernames;
    # 3) prefer most recently active accounts;
    # 4) stable tie-breaker by driver_id.
    return (
        _driver_id_preference_rank(did),
        0 if username else 1,
        -_driver_last_login_ts(getattr(row, "last_login", None)),
        did,
    )


def _find_active_driver_by_plate(db: Session, plate: str) -> Optional[models.Driver]:
    plate_key = str(plate or "").strip().upper()
    if not plate_key:
        return None

    candidates: List[models.Driver] = []
    rows = db.query(models.Driver).filter(models.Driver.active.is_(True)).all()
    for d in rows:
        role = authz.normalize_role(getattr(d, "role", None))
        if role != authz.ROLE_DRIVER:
            continue
        if _is_excluded_route_driver(
            driver_id=getattr(d, "driver_id", None),
            username=getattr(d, "username", None),
            name=getattr(d, "name", None),
        ):
            continue
        d_plate = str(getattr(d, "truck_plate", "") or "").strip().upper()
        if d_plate == plate_key:
            candidates.append(d)

    if not candidates:
        return None

    candidates.sort(key=_driver_plate_candidate_sort_key)
    return candidates[0]


def _find_active_driver_by_id(db: Session, driver_id: str) -> Optional[models.Driver]:
    did = str(driver_id or "").strip()
    if not did:
        return None
    row = (
        db.query(models.Driver)
        .filter(func.upper(models.Driver.driver_id) == did.upper())
        .filter(models.Driver.active.is_(True))
        .first()
    )
    if not row:
        return None
    role = authz.normalize_role(getattr(row, "role", None))
    if role != authz.ROLE_DRIVER:
        return None
    if _is_excluded_route_driver(
        driver_id=getattr(row, "driver_id", None),
        username=getattr(row, "username", None),
        name=getattr(row, "name", None),
    ):
        return None
    return row


def assign_route_plan(
    db: Session,
    *,
    plan: models.RoutePlan,
    vehicle_plate: Optional[str],
    assigned_by_user_id: str,
    assigned_driver_id: Optional[str] = None,
    assigned_helper_name: Optional[str] = None,
) -> Dict[str, Any]:
    if str(getattr(plan, "status", STATUS_DRAFT) or STATUS_DRAFT) not in (STATUS_APPROVED, STATUS_ASSIGNED):
        raise ValueError("Route must be approved before assignment.")

    plate = str(vehicle_plate or "").strip().upper() or None
    requested_driver_id = str(assigned_driver_id or "").strip() or None
    explicit_helper = str(assigned_helper_name or "").strip() or None

    target_driver = None
    if requested_driver_id:
        target_driver = _find_active_driver_by_id(db, requested_driver_id)
        if not target_driver:
            raise ValueError(f"No active driver found for id {requested_driver_id}.")
        driver_plate = str(getattr(target_driver, "truck_plate", "") or "").strip().upper() or None
        if plate and driver_plate and driver_plate != plate:
            raise ValueError(f"Driver {requested_driver_id} is linked to plate {driver_plate}, not {plate}.")
        if not plate:
            plate = driver_plate
    elif plate:
        target_driver = _find_active_driver_by_plate(db, plate)
        if not target_driver:
            raise ValueError(f"No active driver found for plate {plate}.")

    if not plate:
        raise ValueError("vehicle_plate is required (or provide a driver with an assigned truck plate).")

    if not target_driver and plate:
        target_driver = _find_active_driver_by_plate(db, plate)
        if not target_driver:
            raise ValueError(f"No active driver found for plate {plate}.")

    now = datetime.utcnow()
    plan.status = STATUS_ASSIGNED
    plan.assigned_at = now
    plan.assigned_by_user_id = str(assigned_by_user_id or "").strip().upper() or None
    plan.assigned_vehicle_plate = str(plate).upper()
    plan.assigned_driver_id = str(target_driver.driver_id or "").strip() or None
    plan.assigned_driver_name = str(target_driver.name or "").strip() or None
    plan.assigned_helper_name = explicit_helper or (str(target_driver.helper_name or "").strip() or None)
    plan.assigned_phone = str(target_driver.phone_number or "").strip() or None
    plan.updated_at = now

    awbs = [_normalize_awb(a) for a in (plan.awbs or []) if _normalize_awb(a)]
    allocated = 0
    missing: List[str] = []
    for awb in awbs:
        ship = db.query(models.Shipment).filter(models.Shipment.awb == awb).first()
        if not ship:
            missing.append(awb)
            continue
        ship.driver_id = plan.assigned_driver_id
        ship.last_updated = now
        allocated += 1

    return {
        "allocated_awbs": allocated,
        "missing_awbs": missing,
        "assigned_driver_id": plan.assigned_driver_id,
        "assigned_vehicle_plate": plan.assigned_vehicle_plate,
        "assigned_helper_name": plan.assigned_helper_name,
    }


@dataclass(frozen=True)
class AutoRoutePlanningConfig:
    enabled: bool
    daily_hour: int
    daily_minute: int
    timezone_name: str
    run_on_startup: bool


def _env_bool(name: str, default: bool = False) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    val = str(raw).strip().lower()
    if val in _TRUTHY:
        return True
    if val in _FALSY:
        return False
    return default


def _env_int(name: str, default: int) -> int:
    raw = os.getenv(name)
    if raw is None:
        return default
    try:
        return int(str(raw).strip())
    except Exception:
        return default


def load_auto_route_planning_config_from_env() -> AutoRoutePlanningConfig:
    raw_enabled = os.getenv("AUTO_ROUTE_PLANNING_ENABLED")
    if raw_enabled is None:
        enabled = bool(os.getenv("POSTIS_USERNAME") and os.getenv("POSTIS_PASSWORD"))
    else:
        enabled = _env_bool("AUTO_ROUTE_PLANNING_ENABLED", default=False)

    hour = max(0, min(_env_int("AUTO_ROUTE_PLANNING_HOUR", 4), 23))
    minute = max(0, min(_env_int("AUTO_ROUTE_PLANNING_MINUTE", 0), 59))
    timezone_name = str(os.getenv("AUTO_ROUTE_PLANNING_TZ", DEFAULT_TIMEZONE) or DEFAULT_TIMEZONE).strip() or DEFAULT_TIMEZONE
    run_on_startup = _env_bool("AUTO_ROUTE_PLANNING_RUN_ON_STARTUP", default=False)

    return AutoRoutePlanningConfig(
        enabled=enabled,
        daily_hour=hour,
        daily_minute=minute,
        timezone_name=timezone_name,
        run_on_startup=run_on_startup,
    )


def _seconds_until_next_run(*, now_local: datetime, hour: int, minute: int) -> float:
    next_run = now_local.replace(hour=hour, minute=minute, second=0, microsecond=0)
    if next_run <= now_local:
        next_run = next_run + timedelta(days=1)
    delta = next_run - now_local
    return max(0.0, float(delta.total_seconds()))


async def _run_auto_planning_once(
    *,
    client: Any,
    cfg: AutoRoutePlanningConfig,
) -> None:
    sync_cfg = postis_sync_service.load_config_from_env()
    sync_ok = True
    try:
        await postis_sync_service.run_sync_guarded(client, config=sync_cfg, trigger="auto-route-planning")
    except Exception as e:
        sync_ok = False
        logger.warning(
            "Auto route planning: Postis sync failed, continuing with cached shipments: %s",
            str(e),
        )

    try:
        tz = ZoneInfo(cfg.timezone_name)
    except Exception:
        tz = ZoneInfo("UTC")
    target_date = datetime.now(tz).date().isoformat()

    summary = await asyncio.to_thread(
        generate_daily_route_plans_task,
        plan_date=target_date,
        generated_by_user_id="SYSTEM",
        trigger="auto-04",
    )
    logger.info(
        "Auto route planning done: date=%s routes=%s awbs=%s deliverable=%s",
        target_date,
        summary.get("created_routes", 0) + summary.get("updated_routes", 0),
        summary.get("allocated_awbs", 0),
        summary.get("deliverable_in_moldova", 0),
    )
    if not sync_ok:
        logger.info(
            "Auto route planning for %s completed without fresh Postis sync (used cached DB data).",
            target_date,
        )


async def auto_route_planning_loop(client: Any, *, config: Optional[AutoRoutePlanningConfig] = None) -> None:
    cfg = config or load_auto_route_planning_config_from_env()
    if not cfg.enabled:
        logger.info("AUTO_ROUTE_PLANNING not enabled; planner loop will not start")
        return

    if cfg.run_on_startup:
        try:
            await _run_auto_planning_once(client=client, cfg=cfg)
        except Exception as e:
            logger.error("Initial auto route planning failed: %s", str(e), exc_info=True)

    while True:
        try:
            tz = ZoneInfo(cfg.timezone_name)
        except Exception:
            tz = ZoneInfo("UTC")
        now_local = datetime.now(tz)
        sleep_s = _seconds_until_next_run(now_local=now_local, hour=cfg.daily_hour, minute=cfg.daily_minute)
        await asyncio.sleep(sleep_s)

        try:
            await _run_auto_planning_once(client=client, cfg=cfg)
        except asyncio.CancelledError:
            raise
        except Exception as e:
            logger.error("Auto route planning failed: %s", str(e), exc_info=True)
