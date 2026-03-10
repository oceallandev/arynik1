from __future__ import annotations

import asyncio
import logging
import os
import re
import unicodedata
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any, Dict, List, Optional, Tuple
from zoneinfo import ZoneInfo

from sqlalchemy.orm import Session

try:
    from .. import database, models
    from . import fleet_service, postis_sync_service, vehicle_types_service
except ImportError:  # pragma: no cover
    import database, models  # type: ignore
    import fleet_service  # type: ignore
    import postis_sync_service  # type: ignore
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
    "expediere preluata de curier",
    "expeditie preluata de curier",
    "expedierea a fost preluata de curier",
    "incarcat la curier",
    "refuzare colet",
    "livrare refuzata",
    "refuzat",
    "refused",
    "livrare reprogramata",
    "reprogramat",
    "reschedule",
]

_ROUTING_BLOCKING_TOKENS = [
    "finalizare pregatire depozit",
    "initial",
    "pending",
    "in asteptare",
]

_TRUTHY = {"1", "true", "yes", "y", "on"}
_FALSY = {"0", "false", "no", "n", "off", ""}


def ensure_route_plans_schema(db: Session) -> bool:
    try:
        models.RoutePlan.__table__.create(bind=db.get_bind(), checkfirst=True)
        return True
    except Exception:
        return False


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

    secondary: List[str] = []
    for value in (
        getattr(shipment, "processing_status", None),
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


def is_routing_eligible_shipment(shipment: models.Shipment) -> bool:
    primary, secondary = _collect_status_signals(shipment)
    if not primary:
        return False

    if not any(token in primary for token in _ROUTING_ALLOWED_TOKENS):
        return False

    for txt in secondary:
        if any(token in txt for token in _ROUTING_BLOCKING_TOKENS):
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
        l = float(nums[0])
        w = float(nums[1])
        h = float(nums[2])
    except Exception:
        return None
    if l <= 0 or w <= 0 or h <= 0:
        return None
    return (l * w * h) / 1_000_000.0


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
        pass

    for row in (
        db.query(models.FleetVehicle)
        .filter(models.FleetVehicle.active.is_(True))
        .order_by(models.FleetVehicle.updated_at.desc().nullslast(), models.FleetVehicle.id.asc())
        .all()
    ):
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
        role = str(getattr(row, "role", "") or "").strip().casefold()
        if role != "driver":
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
        cap_vol = _to_positive_number(state.get("target_volume_m3"))
        cap_kg = _to_positive_number(state.get("target_weight_kg"))
        state["load_volume_m3"] = _round(state.get("load_volume_m3"), 4)
        state["load_weight_kg"] = _round(state.get("load_weight_kg"), 3)
        state["utilization_volume_pct"] = _round((state["load_volume_m3"] / cap_vol) * 100.0, 1) if cap_vol else None
        state["utilization_weight_pct"] = _round((state["load_weight_kg"] / cap_kg) * 100.0, 1) if cap_kg else None

    return bins, over_capacity_items


def route_plan_to_dict(plan: models.RoutePlan) -> Dict[str, Any]:
    return {
        "id": int(plan.id),
        "plan_date": plan.plan_date,
        "county": plan.county,
        "route_index": int(plan.route_index or 1),
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
        "assigned_phone": plan.assigned_phone,
        "vehicle_type_code": plan.vehicle_type_code,
        "vehicle_has_lift": bool(plan.vehicle_has_lift) if plan.vehicle_has_lift is not None else None,
        "max_volume_m3": plan.max_volume_m3,
        "target_volume_m3": plan.target_volume_m3,
        "max_weight_kg": plan.max_weight_kg,
        "target_weight_kg": plan.target_weight_kg,
        "awb_count": int(plan.awb_count or 0),
        "awbs": list(plan.awbs or []),
        "over_capacity_awbs": list(plan.over_capacity_awbs or []),
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
) -> Dict[str, Any]:
    if not ensure_route_plans_schema(db):
        raise RuntimeError("Route plans schema unavailable")

    target_date = _normalize_plan_date(plan_date)
    now = datetime.utcnow()

    shipments = db.query(models.Shipment).all()
    county_candidates: Dict[str, List[Dict[str, Any]]] = {}

    deliverable_total = 0
    deliverable_in_moldova = 0
    missing_county_awbs: List[Dict[str, Any]] = []
    outside_region_awbs: List[Dict[str, Any]] = []
    missing_seen: set[str] = set()
    outside_seen: set[str] = set()

    for ship in shipments:
        if not is_routing_eligible_shipment(ship):
            continue

        awb = _normalize_awb(getattr(ship, "awb", None))
        if not awb:
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
    existing_rows = (
        db.query(models.RoutePlan)
        .filter(models.RoutePlan.plan_date == target_date)
        .all()
    )
    existing_by_key: Dict[Tuple[str, int], models.RoutePlan] = {}
    for row in existing_rows:
        key = (_normalize_county_key(row.county), int(row.route_index or 1))
        existing_by_key[key] = row

    desired_keys: set[Tuple[str, int]] = set()
    created_routes = 0
    updated_routes = 0
    locked_routes = 0
    over_capacity_awbs: List[Dict[str, Any]] = []

    for county_spec in _MOLDOVA_COUNTIES:
        county_name = str(county_spec.get("name"))
        county_key = _normalize_county_key(county_name)
        items = county_candidates.get(county_key) or []
        bins, overflow = _plan_county_routes(county=county_name, items=items, vehicle_pool=vehicle_pool)
        over_capacity_awbs.extend(overflow)

        for idx, bin_state in enumerate(bins, start=1):
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
            row.data = {
                "suggested_vehicle_plate": bin_state.get("vehicle_plate"),
            }

    # Remove outdated draft rows (same day) that no longer exist in the fresh plan.
    for row in existing_rows:
        key = (_normalize_county_key(row.county), int(row.route_index or 1))
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
        county_rows = [r for r in rows if _normalize_county_key(r.county) == _normalize_county_key(county_name)]
        county_plan.append(
            {
                "county": county_name,
                "routes": len(county_rows),
                "stops": int(sum(int(r.awb_count or 0) for r in county_rows)),
                "load_volume_m3": _round(sum(float(r.load_volume_m3 or 0.0) for r in county_rows), 3),
                "load_weight_kg": _round(sum(float(r.load_weight_kg or 0.0) for r in county_rows), 2),
            }
        )

    return {
        "date": target_date,
        "generated_at": now.isoformat() + "Z",
        "created_routes": created_routes,
        "updated_routes": updated_routes,
        "locked_routes": locked_routes,
        "allocated_awbs": int(sum(int(r.awb_count or 0) for r in rows)),
        "deliverable_total": deliverable_total,
        "deliverable_in_moldova": deliverable_in_moldova,
        "missing_county": len(missing_county_awbs),
        "outside_region": len(outside_region_awbs),
        "over_capacity": len(over_capacity_awbs),
        "missing_county_awbs": missing_county_awbs,
        "outside_region_awbs": outside_region_awbs,
        "over_capacity_awbs": over_capacity_awbs,
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


def _find_active_driver_by_plate(db: Session, plate: str) -> Optional[models.Driver]:
    plate_key = str(plate or "").strip().upper()
    if not plate_key:
        return None

    rows = db.query(models.Driver).filter(models.Driver.active.is_(True)).all()
    for d in rows:
        role = str(getattr(d, "role", "") or "").strip().casefold()
        if role != "driver":
            continue
        d_plate = str(getattr(d, "truck_plate", "") or "").strip().upper()
        if d_plate == plate_key:
            return d
    return None


def assign_route_plan(
    db: Session,
    *,
    plan: models.RoutePlan,
    vehicle_plate: str,
    assigned_by_user_id: str,
) -> Dict[str, Any]:
    if str(getattr(plan, "status", STATUS_DRAFT) or STATUS_DRAFT) not in (STATUS_APPROVED, STATUS_ASSIGNED):
        raise ValueError("Route must be approved before assignment.")

    plate = str(vehicle_plate or "").strip().upper()
    if not plate:
        raise ValueError("vehicle_plate is required.")

    target_driver = _find_active_driver_by_plate(db, plate)
    if not target_driver:
        raise ValueError(f"No active driver found for plate {plate}.")

    now = datetime.utcnow()
    plan.status = STATUS_ASSIGNED
    plan.assigned_at = now
    plan.assigned_by_user_id = str(assigned_by_user_id or "").strip().upper() or None
    plan.assigned_vehicle_plate = plate
    plan.assigned_driver_id = str(target_driver.driver_id or "").strip().upper() or None
    plan.assigned_driver_name = str(target_driver.name or "").strip() or None
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
        "assigned_vehicle_plate": plate,
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
    await postis_sync_service.run_sync_guarded(client, config=sync_cfg, trigger="auto-route-planning")

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
