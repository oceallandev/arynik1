from __future__ import annotations

from datetime import datetime, timedelta, timezone
import hashlib
import logging
import os
import time
import unicodedata
from typing import Any, Dict, Iterable, List, Optional, Tuple

import httpx
from sqlalchemy.orm import Session

try:
    from .. import models
except ImportError:  # pragma: no cover
    import models  # type: ignore

try:
    from . import shipments_service
except ImportError:  # pragma: no cover
    import shipments_service  # type: ignore


logger = logging.getLogger(__name__)


def _now_utc_naive() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _safe_float(value: Any) -> Optional[float]:
    if value is None:
        return None
    try:
        if isinstance(value, str):
            normalized = value.strip().replace(",", ".")
            if not normalized:
                return None
            return float(normalized)
        return float(value)
    except Exception:
        return None


def _valid_coord(lat: Any, lon: Any) -> bool:
    la = _safe_float(lat)
    lo = _safe_float(lon)
    if la is None or lo is None:
        return False
    if abs(la) < 0.0001 and abs(lo) < 0.0001:
        return False
    if la < -90 or la > 90:
        return False
    if lo < -180 or lo > 180:
        return False
    return True


def _extract_place_name(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        return value.strip()
    if isinstance(value, (int, float)):
        return str(value).strip()
    if isinstance(value, dict):
        for key in (
            "name",
            "label",
            "value",
            "text",
            "title",
            "addressText",
            "address_text",
            "localityName",
            "cityName",
            "countyName",
            "regionName",
        ):
            raw = value.get(key)
            if isinstance(raw, str) and raw.strip():
                return raw.strip()
        for key in ("locality", "city", "county", "region", "address"):
            raw = value.get(key)
            if isinstance(raw, str) and raw.strip():
                return raw.strip()
            if isinstance(raw, dict):
                nested = _extract_place_name(raw)
                if nested:
                    return nested
    return str(value).strip()


def _normalize_for_key(value: Any) -> str:
    text_val = _extract_place_name(value)
    if not text_val:
        return ""
    normalized = (
        unicodedata.normalize("NFD", text_val)
        .encode("ascii", "ignore")
        .decode("ascii")
        .strip()
        .casefold()
    )
    return " ".join(normalized.replace("_", " ").replace("-", " ").split())


def _shipment_county(ship: models.Shipment) -> str:
    recipient_loc = ship.recipient_location if isinstance(ship.recipient_location, dict) else {}
    return (
        _extract_place_name(recipient_loc.get("county"))
        or _extract_place_name(recipient_loc.get("countyName"))
        or _extract_place_name(recipient_loc.get("region"))
        or _extract_place_name(recipient_loc.get("regionName"))
    )


def build_geocode_query_for_shipment(ship: models.Shipment) -> str:
    recipient_loc = ship.recipient_location if isinstance(ship.recipient_location, dict) else {}
    parts = []

    address = (
        _extract_place_name(ship.delivery_address)
        or _extract_place_name(recipient_loc.get("addressText"))
        or _extract_place_name(recipient_loc.get("address"))
    )
    locality = (
        _extract_place_name(ship.locality)
        or _extract_place_name(recipient_loc.get("locality"))
        or _extract_place_name(recipient_loc.get("localityName"))
        or _extract_place_name(recipient_loc.get("city"))
        or _extract_place_name(recipient_loc.get("cityName"))
    )
    county = _shipment_county(ship)

    if address:
        parts.append(address)
    if locality:
        loc_norm = _normalize_for_key(locality)
        if not parts or loc_norm not in _normalize_for_key(parts[0]):
            parts.append(locality)
    if county:
        county_norm = _normalize_for_key(county)
        existing_norm = " ".join(_normalize_for_key(p) for p in parts)
        if county_norm and county_norm not in existing_norm:
            parts.append(county)
    parts.append("Romania")

    return ", ".join([p for p in parts if str(p).strip()])


def build_geocode_key(query: str) -> str:
    normalized = _normalize_for_key(query)
    if not normalized:
        return ""
    return hashlib.sha1(normalized.encode("utf-8")).hexdigest()


def _nominatim_geocode(client: httpx.Client, query: str, *, timeout_s: float) -> Optional[Tuple[float, float]]:
    params = {
        "format": "jsonv2",
        "addressdetails": 1,
        "countrycodes": "ro",
        "limit": 1,
        "q": query,
    }
    try:
        res = client.get(
            "https://nominatim.openstreetmap.org/search",
            params=params,
            timeout=timeout_s,
        )
        if res.status_code != 200:
            return None
        payload = res.json()
        rows = payload if isinstance(payload, list) else []
        if not rows:
            return None
        top = rows[0] if isinstance(rows[0], dict) else {}
        lat = _safe_float(top.get("lat"))
        lon = _safe_float(top.get("lon"))
        if not _valid_coord(lat, lon):
            return None
        return float(lat), float(lon)
    except Exception:
        return None


def refresh_shipments_geocoding(
    db: Session,
    *,
    awbs: Optional[Iterable[str]] = None,
    limit: int = 600,
) -> Dict[str, int]:
    """
    Refresh shipment coordinates in DB using stable geocode keys.

    Rules:
    - Keep existing coordinates when address/locality key did not change.
    - Recompute only when missing/invalid coordinates or when key changed.
    - Reuse coordinates from other DB shipments with the same key before network calls.
    """
    shipments_service.ensure_shipments_schema(db)

    awb_list = []
    seen = set()
    for raw in (awbs or []):
        key = str(raw or "").strip().upper()
        if not key or key in seen:
            continue
        seen.add(key)
        awb_list.append(key)

    query = db.query(models.Shipment).filter(models.Shipment.awb.isnot(None))
    if awb_list:
        query = query.filter(models.Shipment.awb.in_(awb_list))
    query = query.order_by(models.Shipment.last_updated.desc())
    if limit and limit > 0:
        query = query.limit(int(limit))

    rows = query.all()
    now = _now_utc_naive()
    retry_after = timedelta(hours=max(1, int(os.getenv("APP_GEOCODE_RETRY_HOURS", "24"))))

    stats = {
        "scanned": 0,
        "pending": 0,
        "reused": 0,
        "geocoded": 0,
        "failed": 0,
        "skipped": 0,
        "unchanged": 0,
    }

    pending_by_key: Dict[str, List[models.Shipment]] = {}
    query_by_key: Dict[str, str] = {}

    for ship in rows:
        stats["scanned"] += 1

        query_text = build_geocode_query_for_shipment(ship)
        key = build_geocode_key(query_text)
        if not query_text or not key:
            stats["skipped"] += 1
            continue

        old_key = str(getattr(ship, "geocode_key", "") or "")
        has_coords = _valid_coord(ship.latitude, ship.longitude)

        if str(getattr(ship, "geocode_query", "") or "") != query_text:
            ship.geocode_query = query_text
        if old_key != key:
            ship.geocode_key = key

        if has_coords:
            if old_key and old_key != key:
                # Stale coordinates from old address.
                ship.latitude = None
                ship.longitude = None
                has_coords = False
            else:
                if not getattr(ship, "geocoded_at", None):
                    ship.geocoded_at = now
                if not str(getattr(ship, "geocode_source", "") or "").strip():
                    ship.geocode_source = "postis"
                stats["unchanged"] += 1
                continue

        # Avoid hammering geocoder for known misses until retry window expires.
        source = str(getattr(ship, "geocode_source", "") or "").strip().lower()
        geocoded_at = getattr(ship, "geocoded_at", None)
        if source in {"not-found", "error"} and isinstance(geocoded_at, datetime):
            if (now - geocoded_at) < retry_after:
                stats["skipped"] += 1
                continue

        pending_by_key.setdefault(key, []).append(ship)
        query_by_key.setdefault(key, query_text)

    if not pending_by_key:
        db.commit()
        return stats

    stats["pending"] = int(sum(len(v) for v in pending_by_key.values()))
    keys = list(pending_by_key.keys())

    # First reuse coordinates already available in DB for the same geocode_key.
    cache_rows = (
        db.query(models.Shipment.geocode_key, models.Shipment.latitude, models.Shipment.longitude)
        .filter(models.Shipment.geocode_key.in_(keys))
        .filter(models.Shipment.latitude.isnot(None), models.Shipment.longitude.isnot(None))
        .all()
    )

    cached_by_key: Dict[str, Tuple[float, float]] = {}
    for key, lat, lon in cache_rows:
        if key in cached_by_key:
            continue
        if not _valid_coord(lat, lon):
            continue
        cached_by_key[str(key)] = (float(lat), float(lon))

    for key in list(pending_by_key.keys()):
        coords = cached_by_key.get(key)
        if not coords:
            continue
        lat, lon = coords
        for ship in pending_by_key[key]:
            ship.latitude = lat
            ship.longitude = lon
            ship.geocoded_at = now
            ship.geocode_source = "db-cache"
        stats["reused"] += len(pending_by_key[key])
        del pending_by_key[key]

    if not pending_by_key:
        db.commit()
        return stats

    user_agent = str(os.getenv("APP_GEOCODER_USER_AGENT", "arynik-sync/1.0") or "arynik-sync/1.0").strip()
    min_delay_ms = max(500, int(os.getenv("APP_GEOCODER_MIN_DELAY_MS", "900")))
    timeout_s = max(5.0, float(os.getenv("APP_GEOCODER_TIMEOUT_SECONDS", "12")))

    last_call_at = 0.0
    with httpx.Client(headers={"User-Agent": user_agent}) as client:
        for key, rows_for_key in pending_by_key.items():
            query_text = query_by_key.get(key, "")
            if not query_text:
                for ship in rows_for_key:
                    ship.geocoded_at = now
                    ship.geocode_source = "error"
                stats["failed"] += len(rows_for_key)
                continue

            elapsed_ms = (time.monotonic() - last_call_at) * 1000
            if elapsed_ms < min_delay_ms:
                time.sleep((min_delay_ms - elapsed_ms) / 1000.0)

            coords = _nominatim_geocode(client, query_text, timeout_s=timeout_s)
            last_call_at = time.monotonic()

            if coords:
                lat, lon = coords
                for ship in rows_for_key:
                    ship.latitude = lat
                    ship.longitude = lon
                    ship.geocoded_at = now
                    ship.geocode_source = "nominatim"
                stats["geocoded"] += len(rows_for_key)
            else:
                for ship in rows_for_key:
                    ship.geocoded_at = now
                    ship.geocode_source = "not-found"
                stats["failed"] += len(rows_for_key)

    db.commit()
    return stats
