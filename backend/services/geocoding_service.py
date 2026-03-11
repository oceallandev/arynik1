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

_ROMANIA_LAT_MIN = 43.70
_ROMANIA_LAT_MAX = 48.25
_ROMANIA_LON_MIN = 20.20
_ROMANIA_LON_MAX = 29.75


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


def _seed_fraction(seed: str, slot: int) -> float:
    key = f"{seed}:{slot}".encode("utf-8")
    digest = hashlib.sha1(key).hexdigest()
    # 56 bits are enough for stable deterministic spreading.
    numerator = int(digest[:14], 16)
    denominator = float((1 << 56) - 1)
    return numerator / denominator if denominator > 0 else 0.5


def _deterministic_ro_coord(seed: str) -> Tuple[float, float]:
    seed_text = str(seed or "").strip() or "romania-default"
    lat_u = _seed_fraction(seed_text, 1)
    lon_u = _seed_fraction(seed_text, 2)
    lat = _ROMANIA_LAT_MIN + ((_ROMANIA_LAT_MAX - _ROMANIA_LAT_MIN) * lat_u)
    lon = _ROMANIA_LON_MIN + ((_ROMANIA_LON_MAX - _ROMANIA_LON_MIN) * lon_u)
    return round(lat, 6), round(lon, 6)


def _accumulate_centroid(bucket: Dict[str, Tuple[float, float, int]], key: str, lat: float, lon: float) -> None:
    if not key:
        return
    sum_lat, sum_lon, count = bucket.get(key, (0.0, 0.0, 0))
    bucket[key] = (sum_lat + lat, sum_lon + lon, count + 1)


def _finalize_centroids(bucket: Dict[str, Tuple[float, float, int]]) -> Dict[str, Tuple[float, float]]:
    out: Dict[str, Tuple[float, float]] = {}
    for key, (sum_lat, sum_lon, count) in bucket.items():
        if count <= 0:
            continue
        out[key] = (sum_lat / count, sum_lon / count)
    return out


def _build_fallback_centroid_indexes(
    db: Session,
    *,
    sample_limit: int = 12000,
) -> Tuple[Dict[str, Tuple[float, float]], Dict[str, Tuple[float, float]]]:
    """
    Build centroid caches from recent shipments that already have coordinates.
    Used as fallback when external geocoding providers fail.
    """
    q = (
        db.query(models.Shipment)
        .filter(models.Shipment.latitude.isnot(None), models.Shipment.longitude.isnot(None))
        .order_by(models.Shipment.last_updated.desc())
    )
    if sample_limit > 0:
        q = q.limit(int(sample_limit))

    locality_acc: Dict[str, Tuple[float, float, int]] = {}
    county_acc: Dict[str, Tuple[float, float, int]] = {}

    for ship in q.all():
        lat = _safe_float(getattr(ship, "latitude", None))
        lon = _safe_float(getattr(ship, "longitude", None))
        if not _valid_coord(lat, lon):
            continue

        locality_key = _normalize_for_key(_shipment_locality(ship))
        county_key = _normalize_for_key(_shipment_county(ship))
        if locality_key:
            _accumulate_centroid(locality_acc, locality_key, float(lat), float(lon))
        if county_key:
            _accumulate_centroid(county_acc, county_key, float(lat), float(lon))

    return _finalize_centroids(locality_acc), _finalize_centroids(county_acc)


def fallback_coords_for_shipment(
    ship: Optional[models.Shipment],
    *,
    awb_hint: Optional[str] = None,
    locality_centroids: Optional[Dict[str, Tuple[float, float]]] = None,
    county_centroids: Optional[Dict[str, Tuple[float, float]]] = None,
) -> Tuple[float, float, str]:
    """
    Return deterministic best-effort coordinates so no shipment remains without map coordinates.
    Priority:
    1) locality centroid cache
    2) county centroid cache
    3) deterministic point inside Romania bounds (stable per AWB/query)
    """
    locality_key = ""
    county_key = ""
    awb = str(awb_hint or "").strip().upper()

    if ship is not None:
        locality_key = _normalize_for_key(_shipment_locality(ship))
        county_key = _normalize_for_key(_shipment_county(ship))
        if not awb:
            awb = str(getattr(ship, "awb", "") or "").strip().upper()

    if locality_key and isinstance(locality_centroids, dict):
        local_coords = locality_centroids.get(locality_key)
        if local_coords and _valid_coord(local_coords[0], local_coords[1]):
            return float(local_coords[0]), float(local_coords[1]), "fallback-locality-centroid"

    if county_key and isinstance(county_centroids, dict):
        county_coords = county_centroids.get(county_key)
        if county_coords and _valid_coord(county_coords[0], county_coords[1]):
            return float(county_coords[0]), float(county_coords[1]), "fallback-county-centroid"

    query_seed = ""
    if ship is not None:
        query_seed = str(getattr(ship, "geocode_query", "") or "").strip() or build_geocode_query_for_shipment(ship)

    seed = awb or query_seed or locality_key or county_key or "romania-default"
    lat, lon = _deterministic_ro_coord(seed)
    return lat, lon, "fallback-hash"


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


def _includes_token(text: Any, token: Any) -> bool:
    source = _normalize_for_key(text)
    needle = _normalize_for_key(token)
    if not source or not needle:
        return False
    if len(needle) <= 2:
        words = [w for w in source.split() if w]
        return needle in words
    return needle in source


def _shipment_county(ship: models.Shipment) -> str:
    recipient_loc = ship.recipient_location if isinstance(ship.recipient_location, dict) else {}
    return (
        _extract_place_name(recipient_loc.get("county"))
        or _extract_place_name(recipient_loc.get("countyName"))
        or _extract_place_name(recipient_loc.get("region"))
        or _extract_place_name(recipient_loc.get("regionName"))
    )


def _shipment_locality(ship: models.Shipment) -> str:
    recipient_loc = ship.recipient_location if isinstance(ship.recipient_location, dict) else {}
    return (
        _extract_place_name(ship.locality)
        or _extract_place_name(recipient_loc.get("locality"))
        or _extract_place_name(recipient_loc.get("localityName"))
        or _extract_place_name(recipient_loc.get("city"))
        or _extract_place_name(recipient_loc.get("cityName"))
    )


def build_geocode_query_for_shipment(ship: models.Shipment) -> str:
    recipient_loc = ship.recipient_location if isinstance(ship.recipient_location, dict) else {}
    parts = []

    address = (
        _extract_place_name(ship.delivery_address)
        or _extract_place_name(recipient_loc.get("addressText"))
        or _extract_place_name(recipient_loc.get("address"))
    )
    locality = _shipment_locality(ship)
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


def _google_extract_locality_values(result: Dict[str, Any]) -> List[str]:
    out: List[str] = []
    components = result.get("address_components") if isinstance(result.get("address_components"), list) else []
    for comp in components:
        if not isinstance(comp, dict):
            continue
        types = {str(t or "").strip() for t in (comp.get("types") or [])}
        if types.intersection({"locality", "postal_town", "administrative_area_level_3", "sublocality", "sublocality_level_1", "neighborhood"}):
            out.append(str(comp.get("long_name") or "").strip())
            out.append(str(comp.get("short_name") or "").strip())

    out.append(str(result.get("formatted_address") or "").strip())
    return [x for x in out if x]


def _google_extract_county_values(result: Dict[str, Any]) -> List[str]:
    out: List[str] = []
    components = result.get("address_components") if isinstance(result.get("address_components"), list) else []
    for comp in components:
        if not isinstance(comp, dict):
            continue
        types = {str(t or "").strip() for t in (comp.get("types") or [])}
        if types.intersection({"administrative_area_level_1", "administrative_area_level_2", "administrative_area_level_3"}):
            out.append(str(comp.get("long_name") or "").strip())
            out.append(str(comp.get("short_name") or "").strip())

    out.append(str(result.get("formatted_address") or "").strip())
    return [x for x in out if x]


def _google_candidate_score(result: Dict[str, Any], *, expected_locality: str, expected_county: str) -> Dict[str, Any]:
    locality_values = _google_extract_locality_values(result)
    county_values = _google_extract_county_values(result)

    locality_match = False
    county_match = False
    score = 0

    if expected_locality:
        locality_match = any(_includes_token(v, expected_locality) for v in locality_values)
        score += 140 if locality_match else -120

    if expected_county:
        county_match = any(_includes_token(v, expected_county) for v in county_values)
        score += 100 if county_match else -80

    types = {str(t or "").strip().lower() for t in (result.get("types") or [])}
    if "street_address" in types or "premise" in types or "subpremise" in types:
        score += 25
    elif "route" in types:
        score += 15
    elif "plus_code" in types:
        score -= 10

    geometry = result.get("geometry") if isinstance(result.get("geometry"), dict) else {}
    location_type = str(geometry.get("location_type") or "").strip().upper()
    if location_type == "ROOFTOP":
        score += 20
    elif location_type == "RANGE_INTERPOLATED":
        score += 12
    elif location_type == "GEOMETRIC_CENTER":
        score += 8

    partial_match = bool(result.get("partial_match"))
    if partial_match:
        score -= 25

    return {
        "score": score,
        "locality_match": locality_match,
        "county_match": county_match,
    }


def _google_pick_best(results: List[Dict[str, Any]], *, expected_locality: str, expected_county: str) -> Optional[Tuple[Dict[str, Any], Dict[str, Any]]]:
    if not results:
        return None

    best: Optional[Tuple[Dict[str, Any], Dict[str, Any]]] = None
    for row in results:
        if not isinstance(row, dict):
            continue
        info = _google_candidate_score(
            row,
            expected_locality=expected_locality,
            expected_county=expected_county,
        )
        if not best or int(info.get("score") or 0) > int(best[1].get("score") or 0):
            best = (row, info)

    if not best:
        return None

    info = best[1]
    if expected_locality and not bool(info.get("locality_match")):
        return None
    if expected_county and not bool(info.get("county_match")):
        return None

    return best


def _google_geocode(
    client: httpx.Client,
    query: str,
    *,
    timeout_s: float,
    api_key: str,
    expected_locality: str,
    expected_county: str,
) -> Optional[Dict[str, Any]]:
    if not api_key:
        return None

    params = {
        "address": query,
        "key": api_key,
        "language": "ro",
        "region": "ro",
        "components": "country:RO",
    }

    try:
        res = client.get("https://maps.googleapis.com/maps/api/geocode/json", params=params, timeout=timeout_s)
        if res.status_code != 200:
            return None

        payload = res.json() if callable(getattr(res, "json", None)) else {}
        status_val = str(payload.get("status") or "").strip().upper()
        if status_val == "OVER_QUERY_LIMIT":
            logger.warning("Google Geocoding quota exceeded.")
            return None
        if status_val not in {"OK", "ZERO_RESULTS"}:
            return None

        rows = payload.get("results") if isinstance(payload.get("results"), list) else []
        if not rows:
            return None

        picked = _google_pick_best(
            [r for r in rows if isinstance(r, dict)],
            expected_locality=expected_locality,
            expected_county=expected_county,
        )
        if not picked:
            return None

        row, info = picked
        geometry = row.get("geometry") if isinstance(row.get("geometry"), dict) else {}
        location = geometry.get("location") if isinstance(geometry.get("location"), dict) else {}
        lat = _safe_float(location.get("lat"))
        lon = _safe_float(location.get("lng"))
        if not _valid_coord(lat, lon):
            return None

        return {
            "lat": float(lat),
            "lon": float(lon),
            "display_name": str(row.get("formatted_address") or query).strip(),
            "provider": "google_geocoding",
            "accuracy": str(geometry.get("location_type") or "").strip().lower() or None,
            "partial_match": bool(row.get("partial_match")),
            "matched_locality": bool(info.get("locality_match")),
            "matched_county": bool(info.get("county_match")),
        }
    except Exception:
        return None


def _nominatim_candidate_score(candidate: Dict[str, Any], *, expected_locality: str, expected_county: str) -> Dict[str, Any]:
    address = candidate.get("address") if isinstance(candidate.get("address"), dict) else {}

    locality_values = [
        address.get("city"),
        address.get("town"),
        address.get("village"),
        address.get("municipality"),
        address.get("suburb"),
        address.get("city_district"),
        address.get("hamlet"),
        candidate.get("display_name"),
    ]
    county_values = [
        address.get("county"),
        address.get("state_district"),
        address.get("state"),
        candidate.get("display_name"),
    ]

    locality_match = False
    county_match = False
    score = 0

    if expected_locality:
        locality_match = any(_includes_token(v, expected_locality) for v in locality_values)
        score += 120 if locality_match else -100

    if expected_county:
        county_match = any(_includes_token(v, expected_county) for v in county_values)
        score += 80 if county_match else -60

    ctype = str(candidate.get("type") or "").strip().lower()
    if ctype in {"house", "building"}:
        score += 15
    elif ctype in {"residential", "road"}:
        score += 8

    return {
        "score": score,
        "locality_match": locality_match,
        "county_match": county_match,
    }


def _nominatim_pick_best(rows: List[Dict[str, Any]], *, expected_locality: str, expected_county: str) -> Optional[Tuple[Dict[str, Any], Dict[str, Any]]]:
    if not rows:
        return None

    best: Optional[Tuple[Dict[str, Any], Dict[str, Any]]] = None
    for row in rows:
        if not isinstance(row, dict):
            continue
        info = _nominatim_candidate_score(
            row,
            expected_locality=expected_locality,
            expected_county=expected_county,
        )
        if not best or int(info.get("score") or 0) > int(best[1].get("score") or 0):
            best = (row, info)

    if not best:
        return None

    info = best[1]
    if expected_locality and not bool(info.get("locality_match")):
        return None
    if expected_county and not bool(info.get("county_match")):
        return None

    return best


def _nominatim_geocode(
    client: httpx.Client,
    query: str,
    *,
    timeout_s: float,
    expected_locality: str,
    expected_county: str,
) -> Optional[Dict[str, Any]]:
    params = {
        "format": "jsonv2",
        "addressdetails": 1,
        "countrycodes": "ro",
        "limit": 5,
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

        picked = _nominatim_pick_best(
            [r for r in rows if isinstance(r, dict)],
            expected_locality=expected_locality,
            expected_county=expected_county,
        )
        if not picked:
            return None

        top, info = picked
        lat = _safe_float(top.get("lat"))
        lon = _safe_float(top.get("lon"))
        if not _valid_coord(lat, lon):
            return None

        return {
            "lat": float(lat),
            "lon": float(lon),
            "display_name": str(top.get("display_name") or query).strip(),
            "provider": "nominatim",
            "accuracy": str(top.get("type") or "").strip().lower() or None,
            "partial_match": None,
            "matched_locality": bool(info.get("locality_match")),
            "matched_county": bool(info.get("county_match")),
        }
    except Exception:
        return None


def _resolve_geocode_providers() -> List[str]:
    has_google_key = bool(str(os.getenv("GOOGLE_MAPS_API_KEY", "") or "").strip())
    raw = str(os.getenv("APP_GEOCODER_PROVIDER", "") or "").strip().lower()

    if not raw:
        raw = "google_then_nominatim" if has_google_key else "nominatim"

    expanded: List[str] = []
    if raw == "google_then_nominatim":
        expanded = ["google", "nominatim"]
    elif raw == "nominatim_then_google":
        expanded = ["nominatim", "google"]
    elif raw in {"google", "nominatim"}:
        expanded = [raw]
    else:
        for token in [x.strip().lower() for x in raw.replace(";", ",").split(",") if x.strip()]:
            if token in {"google", "nominatim"}:
                expanded.append(token)

    # Keep order, deduplicate.
    unique: List[str] = []
    seen = set()
    for item in expanded:
        if item in seen:
            continue
        seen.add(item)
        unique.append(item)

    if has_google_key:
        if not unique:
            unique = ["google", "nominatim"]
    else:
        unique = [x for x in unique if x != "google"]
        if not unique:
            unique = ["nominatim"]

    return unique


def _geocode_with_providers(
    client: httpx.Client,
    query: str,
    *,
    timeout_s: float,
    expected_locality: str,
    expected_county: str,
    providers: Optional[List[str]] = None,
) -> Optional[Dict[str, Any]]:
    chain = list(providers or _resolve_geocode_providers())
    api_key = str(os.getenv("GOOGLE_MAPS_API_KEY", "") or "").strip()
    strict_locality = str(expected_locality or "").strip()
    strict_county = str(expected_county or "").strip()

    def _run_chain(exp_locality: str, exp_county: str) -> Optional[Dict[str, Any]]:
        for provider in chain:
            if provider == "google":
                payload = _google_geocode(
                    client,
                    query,
                    timeout_s=timeout_s,
                    api_key=api_key,
                    expected_locality=exp_locality,
                    expected_county=exp_county,
                )
                if payload:
                    return payload
                continue

            if provider == "nominatim":
                payload = _nominatim_geocode(
                    client,
                    query,
                    timeout_s=timeout_s,
                    expected_locality=exp_locality,
                    expected_county=exp_county,
                )
                if payload:
                    return payload
                continue
        return None

    strict_payload = _run_chain(strict_locality, strict_county)
    if strict_payload:
        return strict_payload

    # Relaxed fallback: when locality/county hints are stale/noisy, still return a Romania candidate
    # instead of failing geocoding completely.
    if strict_locality or strict_county:
        return _run_chain("", "")

    return None


def geocode_query_live(
    query: str,
    *,
    expected_locality: Optional[str] = None,
    expected_county: Optional[str] = None,
) -> Optional[Dict[str, Any]]:
    text = str(query or "").strip()
    if not text:
        return None

    user_agent = str(os.getenv("APP_GEOCODER_USER_AGENT", "arynik-sync/1.0") or "arynik-sync/1.0").strip()
    timeout_s = max(5.0, float(os.getenv("APP_GEOCODER_TIMEOUT_SECONDS", "12")))

    norm_locality = _normalize_for_key(expected_locality)
    norm_county = _normalize_for_key(expected_county)

    with httpx.Client(headers={"User-Agent": user_agent}) as client:
        return _geocode_with_providers(
            client,
            text,
            timeout_s=timeout_s,
            expected_locality=norm_locality,
            expected_county=norm_county,
        )


def refresh_shipments_geocoding(
    db: Session,
    *,
    awbs: Optional[Iterable[str]] = None,
    limit: int = 600,
    force_retry: bool = False,
    fast_mode: bool = False,
) -> Dict[str, int]:
    """
    Refresh shipment coordinates in DB using stable geocode keys.

    Rules:
    - Keep existing coordinates when address/locality key did not change.
    - Recompute only when missing/invalid coordinates or when key changed.
    - Reuse coordinates from other DB shipments with the same key before network calls.
    - Final fallback guarantees coordinates for every scanned shipment.
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
        "fallback_locality": 0,
        "fallback_county": 0,
        "fallback_hash": 0,
        "failed": 0,
        "skipped": 0,
        "unchanged": 0,
    }

    pending_by_key: Dict[str, List[models.Shipment]] = {}
    query_by_key: Dict[str, str] = {}
    query_meta_by_key: Dict[str, Dict[str, str]] = {}

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
        if (not force_retry) and source in {"not-found", "error"} and isinstance(geocoded_at, datetime):
            if (now - geocoded_at) < retry_after:
                stats["skipped"] += 1
                continue

        pending_by_key.setdefault(key, []).append(ship)
        query_by_key.setdefault(key, query_text)
        query_meta_by_key.setdefault(
            key,
            {
                "expected_locality": _normalize_for_key(_shipment_locality(ship)),
                "expected_county": _normalize_for_key(_shipment_county(ship)),
            },
        )

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
    timeout_s = max(5.0, float(os.getenv("APP_GEOCODER_TIMEOUT_SECONDS", "12")))
    provider_chain = _resolve_geocode_providers()

    # Google can run at a higher request rate than Nominatim. Keep Nominatim-safe defaults by default,
    # but allow a faster bounded mode for interactive route geocoding requests.
    primary_provider = provider_chain[0] if provider_chain else "nominatim"
    if primary_provider == "google":
        min_delay_ms = max(
            20 if fast_mode else 50,
            int(os.getenv("APP_GOOGLE_GEOCODER_FAST_MIN_DELAY_MS" if fast_mode else "APP_GOOGLE_GEOCODER_MIN_DELAY_MS", "40" if fast_mode else "80")),
        )
    else:
        min_delay_ms = max(
            120 if fast_mode else 500,
            int(os.getenv("APP_GEOCODER_FAST_MIN_DELAY_MS" if fast_mode else "APP_GEOCODER_MIN_DELAY_MS", "220" if fast_mode else "900")),
        )

    last_call_at = 0.0
    with httpx.Client(headers={"User-Agent": user_agent}) as client:
        rows_needing_fallback: List[models.Shipment] = []
        for key, rows_for_key in pending_by_key.items():
            query_text = query_by_key.get(key, "")
            meta = query_meta_by_key.get(key, {})
            expected_locality = str(meta.get("expected_locality") or "")
            expected_county = str(meta.get("expected_county") or "")

            if not query_text:
                rows_needing_fallback.extend(rows_for_key)
                continue

            elapsed_ms = (time.monotonic() - last_call_at) * 1000
            if elapsed_ms < min_delay_ms:
                time.sleep((min_delay_ms - elapsed_ms) / 1000.0)

            payload = _geocode_with_providers(
                client,
                query_text,
                timeout_s=timeout_s,
                expected_locality=expected_locality,
                expected_county=expected_county,
                providers=provider_chain,
            )
            last_call_at = time.monotonic()

            if payload:
                lat = _safe_float(payload.get("lat"))
                lon = _safe_float(payload.get("lon"))
                provider = str(payload.get("provider") or "").strip() or "geocoder"
                if _valid_coord(lat, lon):
                    for ship in rows_for_key:
                        ship.latitude = float(lat)
                        ship.longitude = float(lon)
                        ship.geocoded_at = now
                        ship.geocode_source = provider
                    stats["geocoded"] += len(rows_for_key)
                    continue

            rows_needing_fallback.extend(rows_for_key)

    if rows_needing_fallback:
        fallback_sample_limit = max(
            1000,
            int(os.getenv("APP_GEOCODE_FALLBACK_SAMPLE_LIMIT", "12000")),
        )
        locality_centroids, county_centroids = _build_fallback_centroid_indexes(
            db,
            sample_limit=fallback_sample_limit,
        )
        for ship in rows_needing_fallback:
            lat, lon, source = fallback_coords_for_shipment(
                ship,
                locality_centroids=locality_centroids,
                county_centroids=county_centroids,
            )
            ship.latitude = float(lat)
            ship.longitude = float(lon)
            ship.geocoded_at = now
            ship.geocode_source = source
            if source == "fallback-locality-centroid":
                stats["fallback_locality"] += 1
            elif source == "fallback-county-centroid":
                stats["fallback_county"] += 1
            else:
                stats["fallback_hash"] += 1
            stats["geocoded"] += 1

    db.commit()
    return stats
