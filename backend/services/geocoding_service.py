from __future__ import annotations

from datetime import datetime, timedelta, timezone
import hashlib
import logging
import os
import re
import sqlite3
import tempfile
import time
import unicodedata
from pathlib import Path
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

_GEOCODE_CACHE_TABLE = "geocode_cache_entries"
_GEOCODE_KEY_VERSION = "ro-address-v4"

_ROMANIA_LAT_MIN = 43.70
_ROMANIA_LAT_MAX = 48.25
_ROMANIA_LON_MIN = 20.20
_ROMANIA_LON_MAX = 29.75
_ROMANIA_CENTER_LAT = 45.9432
_ROMANIA_CENTER_LON = 24.9668

_GOOGLE_MAPS_API_KEY_ENV_NAMES: Tuple[str, ...] = (
    "GOOGLE_MAPS_API_KEY",
    "GOOGLE_MAPS_APIKEY",
    "GOOGLE_MAPS_KEY",
    "GOOGLE_API_KEY",
    "GOOGLE_CLOUD_API_KEY",
    "GMAPS_API_KEY",
    "MAPS_API_KEY",
    "MAPS_PLATFORM_API_KEY",
    "GOOGLE_GEOCODING_API_KEY",
    "GOOGLE_GEOCODE_API_KEY",
    "VITE_GOOGLE_MAPS_API_KEY",
)

_RO_COUNTY_CENTROIDS: Dict[str, Tuple[float, float]] = {
    "alba": (46.0680, 23.5800),
    "arad": (46.1700, 21.3160),
    "arges": (44.8560, 24.8690),
    "bacau": (46.5710, 26.9200),
    "bihor": (47.0460, 21.9190),
    "bistrita nasaud": (47.1300, 24.5000),
    "botosani": (47.7470, 26.6690),
    "braila": (45.2690, 27.9570),
    "brasov": (45.6570, 25.6010),
    "bucuresti": (44.4268, 26.1025),
    "bucuresti ilfov": (44.5350, 26.0800),
    "buzau": (45.1500, 26.8200),
    "calarasi": (44.2050, 27.3330),
    "caras severin": (45.3000, 21.8900),
    "cluj": (46.7700, 23.5900),
    "constanta": (44.1730, 28.6500),
    "covasna": (45.8660, 25.7900),
    "dambovita": (44.9280, 25.4570),
    "dolj": (44.3300, 23.7940),
    "galati": (45.4350, 28.0070),
    "giurgiu": (43.9030, 25.9690),
    "gorj": (45.0430, 23.2740),
    "harghita": (46.3630, 25.8020),
    "hunedoara": (45.7930, 22.9070),
    "ialomita": (44.5630, 27.3660),
    "iasi": (47.1580, 27.6010),
    "ilfov": (44.5350, 26.0800),
    "maramures": (47.6600, 23.5900),
    "mehedinti": (44.6360, 22.6590),
    "mures": (46.5420, 24.5570),
    "neamt": (46.9280, 26.3700),
    "olt": (44.4300, 24.3650),
    "prahova": (44.9450, 26.0220),
    "salaj": (47.1830, 23.0500),
    "satu mare": (47.7920, 22.8850),
    "sibiu": (45.7980, 24.1250),
    "suceava": (47.6510, 26.2550),
    "teleorman": (43.9730, 25.3330),
    "timis": (45.7530, 21.2250),
    "tulcea": (45.1710, 28.7910),
    "valcea": (45.0990, 24.3700),
    "vaslui": (46.6400, 27.7300),
    "vrancea": (45.7000, 27.1850),
}


def _clean_env_secret(value: Any) -> str:
    text = str(value or "").strip()
    if not text:
        return ""
    if (text.startswith('"') and text.endswith('"')) or (text.startswith("'") and text.endswith("'")):
        text = text[1:-1].strip()
    return text


def get_google_maps_api_key() -> str:
    """
    Resolve Google Maps API key from common env var names.
    This avoids outages when deployment config uses a different key name.
    """
    for env_name in _GOOGLE_MAPS_API_KEY_ENV_NAMES:
        value = _clean_env_secret(os.getenv(env_name, ""))
        if value:
            return value
    return ""


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


def _is_ro_coord(lat: Any, lon: Any) -> bool:
    la = _safe_float(lat)
    lo = _safe_float(lon)
    if la is None or lo is None:
        return False
    return (_ROMANIA_LAT_MIN <= la <= _ROMANIA_LAT_MAX) and (_ROMANIA_LON_MIN <= lo <= _ROMANIA_LON_MAX)


def _normalize_ro_coord_pair(lat: Any, lon: Any) -> Optional[Tuple[float, float]]:
    la = _safe_float(lat)
    lo = _safe_float(lon)
    if la is None or lo is None:
        return None
    if _is_ro_coord(la, lo):
        return float(la), float(lo)
    # Recover swapped order pairs: lon,lat -> lat,lon
    if _is_ro_coord(lo, la):
        return float(lo), float(la)
    return None


def _is_fallback_source(value: Any) -> bool:
    src = str(value or "").strip().lower()
    if not src:
        return False
    return (
        src.startswith("fallback")
        or "fallback-" in src
        or src.endswith("-hash")
        or "locality-center" in src
    )


def _is_trusted_direct_source(value: Any) -> bool:
    src = str(value or "").strip().lower()
    return src in {
        "postis-pin",
        "postis-pin-raw",
        "postis-location",
        "postis-location-raw",
        "shipment-manual",
        "recipient-pin",
    }


def _valid_coord(lat: Any, lon: Any) -> bool:
    normalized = _normalize_ro_coord_pair(lat, lon)
    return normalized is not None


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


def _deterministic_coord_around(seed: str, *, base_lat: float, base_lon: float, lat_span: float, lon_span: float) -> Tuple[float, float]:
    lat_u = _seed_fraction(seed, 11)
    lon_u = _seed_fraction(seed, 12)
    lat = float(base_lat) + ((lat_u * 2.0 - 1.0) * max(0.01, float(lat_span)))
    lon = float(base_lon) + ((lon_u * 2.0 - 1.0) * max(0.01, float(lon_span)))
    lat = min(_ROMANIA_LAT_MAX, max(_ROMANIA_LAT_MIN, lat))
    lon = min(_ROMANIA_LON_MAX, max(_ROMANIA_LON_MIN, lon))
    return round(lat, 6), round(lon, 6)


def _county_centroid_from_text(value: Any) -> Optional[Tuple[float, float]]:
    key = _normalize_for_key(value)
    if not key:
        return None
    if key in _RO_COUNTY_CENTROIDS:
        return _RO_COUNTY_CENTROIDS[key]

    cleaned = (
        key.replace("judetul ", "")
        .replace("judet ", "")
        .replace("mun ", "")
        .strip()
    )
    if cleaned in _RO_COUNTY_CENTROIDS:
        return _RO_COUNTY_CENTROIDS[cleaned]

    for county_key, coords in _RO_COUNTY_CENTROIDS.items():
        if cleaned and (cleaned in county_key or county_key in cleaned):
            return coords
    return None


def fallback_coords_for_query(
    query: str,
    *,
    expected_locality: Optional[str] = None,
    expected_county: Optional[str] = None,
) -> Tuple[float, float, str]:
    """
    Deterministic fallback for free-text geocoding queries.
    Used when providers fail so the UI can still render all stops on map.
    """
    query_text = str(query or "").strip()
    locality_text = str(expected_locality or "").strip()
    county_text = str(expected_county or "").strip()
    county_centroid = (
        _county_centroid_from_text(county_text)
        or _county_centroid_from_text(locality_text)
        or _county_centroid_from_text(query_text)
    )

    seed = "|".join(
        [
            _normalize_for_key(query_text) or query_text,
            _normalize_for_key(locality_text),
            _normalize_for_key(county_text),
        ]
    ).strip("|") or "romania-default"

    if county_centroid:
        lat, lon = _deterministic_coord_around(
            seed,
            base_lat=float(county_centroid[0]),
            base_lon=float(county_centroid[1]),
            lat_span=0.11,
            lon_span=0.14,
        )
        return lat, lon, "fallback-query-county-hash"

    lat, lon = _deterministic_coord_around(
        seed,
        base_lat=_ROMANIA_CENTER_LAT,
        base_lon=_ROMANIA_CENTER_LON,
        lat_span=1.2,
        lon_span=1.8,
    )
    return lat, lon, "fallback-query-hash"


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
        normalized = _normalize_ro_coord_pair(getattr(ship, "latitude", None), getattr(ship, "longitude", None))
        if not normalized:
            continue
        lat, lon = normalized

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

    seed = awb or ""
    if ship is not None and not seed:
        seed = str(getattr(ship, "geocode_query", "") or "").strip() or build_geocode_query_for_shipment(ship)
    seed = seed or locality_key or county_key or "romania-default"

    if locality_key and isinstance(locality_centroids, dict):
        local_coords = locality_centroids.get(locality_key)
        if local_coords and _valid_coord(local_coords[0], local_coords[1]):
            lat, lon = _deterministic_coord_around(
                f"{seed}|{locality_key}",
                base_lat=float(local_coords[0]),
                base_lon=float(local_coords[1]),
                lat_span=0.025,
                lon_span=0.035,
            )
            return lat, lon, "fallback-locality-hash"

    if county_key and isinstance(county_centroids, dict):
        county_coords = county_centroids.get(county_key)
        if county_coords and _valid_coord(county_coords[0], county_coords[1]):
            lat, lon = _deterministic_coord_around(
                f"{seed}|{county_key}",
                base_lat=float(county_coords[0]),
                base_lon=float(county_coords[1]),
                lat_span=0.07,
                lon_span=0.09,
            )
            return lat, lon, "fallback-county-hash"

    lat, lon = _deterministic_ro_coord(seed)
    return lat, lon, "fallback-hash"


def _coords_from_shipment_raw(ship: models.Shipment) -> Optional[Tuple[float, float, str]]:
    raw = getattr(ship, "raw_data", None)
    if not isinstance(raw, dict):
        return None

    pin = raw.get("recipientPin") or raw.get("recipient_pin") or {}
    if isinstance(pin, dict):
        normalized_pin = _normalize_ro_coord_pair(
            pin.get("latitude") if pin.get("latitude") is not None else pin.get("lat"),
            pin.get("longitude") if pin.get("longitude") is not None else (pin.get("lon") if pin.get("lon") is not None else pin.get("lng")),
        )
        if normalized_pin:
            return float(normalized_pin[0]), float(normalized_pin[1]), "postis-pin-raw"

    loc = raw.get("recipientLocation") or raw.get("recipient_location") or {}
    if isinstance(loc, dict):
        normalized_loc = _normalize_ro_coord_pair(
            loc.get("latitude") if loc.get("latitude") is not None else loc.get("lat"),
            loc.get("longitude") if loc.get("longitude") is not None else (loc.get("lon") if loc.get("lon") is not None else loc.get("lng")),
        )
        if normalized_loc:
            return float(normalized_loc[0]), float(normalized_loc[1]), "postis-location-raw"

    return None


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


def _sanitize_address_text(value: Any) -> str:
    text = _extract_place_name(value)
    if not text:
        return ""
    # Postis sometimes sends placeholder postal codes. Passing "00000" to
    # geocoders makes unrelated stops collapse onto the same postal/locality
    # result, so strip only the placeholder while keeping the real address.
    text = re.sub(r"\b(?:cod\s*postal|postal\s*code|postcode|zip)\s*[:#-]?\s*0{5}\b", " ", text, flags=re.IGNORECASE)
    text = re.sub(r"(?<!\d)0{5}(?!\d)", " ", text)
    text = re.sub(r"\s*[,;|/]\s*(?=[,;|/]|$)", ", ", text)
    text = re.sub(r"^[\s,;|/-]+|[\s,;|/-]+$", "", text)
    return re.sub(r"\s+", " ", text).strip()


def _street_address_variant(value: Any) -> str:
    text = _sanitize_address_text(value)
    if not text:
        return ""
    match = re.search(
        r"\b(strada|str\.?|bd\.?|bulevard(?:ul)?|calea|aleea|sos\.?|soseaua|drum(?:ul)?|dn|dj)\b",
        text,
        flags=re.IGNORECASE,
    )
    if not match:
        return text
    return text[match.start():].lstrip(" ,;-/").strip() or text


def _compact_address_query(value: Any) -> str:
    text = _sanitize_address_text(value)
    if not text:
        return ""
    text = re.sub(r"\s*,\s*,+", ", ", text)
    text = re.sub(r"\s+,", ",", text)
    text = re.sub(r",\s*", ", ", text)
    return re.sub(r"\s+", " ", text).strip(" ,")


def _expand_romanian_address_abbreviations(value: Any) -> str:
    text = _sanitize_address_text(value)
    if not text:
        return ""
    replacements = (
        (r"\bstr\.\s*", "Strada "),
        (r"\bbd\.\s*", "Bulevardul "),
        (r"\bblvd\.\s*", "Bulevardul "),
        (r"\bsos\.\s*", "Soseaua "),
        (r"\b(?:s|\u0219)os\.\s*", "Soseaua "),
        (r"\bnr\.\s*", ""),
        (r"\bnum(?:a|\u0103)r(?:ul)?\s*", ""),
    )
    for pattern, replacement in replacements:
        text = re.sub(pattern, replacement, text, flags=re.IGNORECASE)
    return _compact_address_query(text)


def _drop_explicit_house_number(value: Any) -> str:
    text = _sanitize_address_text(value)
    if not text:
        return ""
    text = re.sub(
        r"(\s*,\s*)?\b(?:nr|num(?:a|\u0103)r(?:ul)?)\.?\s*\d+[a-z]?\b",
        ", ",
        text,
        flags=re.IGNORECASE,
    )
    return _compact_address_query(text)


def _geocode_query_variants(query: Any) -> List[str]:
    """
    Provider-friendly variants for Romanian addresses.
    Postis/client data often includes store names before the street and
    abbreviations like "Str." / "Nr."; providers are much better with the
    clean street query while still constrained by locality/county hints.
    """
    variants: List[str] = []
    seen: set[str] = set()

    def add(value: Any) -> None:
        text = _compact_address_query(value)
        if not text:
            return
        key = _normalize_for_key(text)
        if not key or key in seen:
            return
        seen.add(key)
        variants.append(text)

    base = _sanitize_address_text(query)
    street = _street_address_variant(base)
    no_house = _drop_explicit_house_number(base)
    no_house_street = _street_address_variant(no_house)

    for item in (
        base,
        _expand_romanian_address_abbreviations(base),
        street,
        _expand_romanian_address_abbreviations(street),
        no_house,
        _expand_romanian_address_abbreviations(no_house),
        no_house_street,
        _expand_romanian_address_abbreviations(no_house_street),
    ):
        add(item)

    return variants


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
    recipient_pin = ship.recipient_pin if isinstance(ship.recipient_pin, dict) else {}
    raw = ship.raw_data if isinstance(ship.raw_data, dict) else {}
    return (
        _extract_place_name(recipient_loc.get("county"))
        or _extract_place_name(recipient_loc.get("countyName"))
        or _extract_place_name(recipient_loc.get("region"))
        or _extract_place_name(recipient_loc.get("regionName"))
        or _extract_place_name(recipient_pin.get("county"))
        or _extract_place_name(recipient_pin.get("countyName"))
        or _extract_place_name(recipient_pin.get("region"))
        or _extract_place_name(recipient_pin.get("regionName"))
        or _extract_place_name(raw.get("county"))
        or _extract_place_name(raw.get("countyName"))
        or _extract_place_name(raw.get("region"))
        or _extract_place_name(raw.get("regionName"))
    )


def _shipment_locality(ship: models.Shipment) -> str:
    recipient_loc = ship.recipient_location if isinstance(ship.recipient_location, dict) else {}
    recipient_pin = ship.recipient_pin if isinstance(ship.recipient_pin, dict) else {}
    raw = ship.raw_data if isinstance(ship.raw_data, dict) else {}
    return (
        _extract_place_name(ship.locality)
        or _extract_place_name(recipient_loc.get("locality"))
        or _extract_place_name(recipient_loc.get("localityName"))
        or _extract_place_name(recipient_loc.get("city"))
        or _extract_place_name(recipient_loc.get("cityName"))
        or _extract_place_name(recipient_pin.get("locality"))
        or _extract_place_name(recipient_pin.get("localityName"))
        or _extract_place_name(recipient_pin.get("city"))
        or _extract_place_name(recipient_pin.get("cityName"))
        or _extract_place_name(raw.get("recipientLocality"))
        or _extract_place_name(raw.get("locality"))
        or _extract_place_name(raw.get("city"))
    )


def _address_from_structured_location(*locations: Dict[str, Any]) -> str:
    street_keys = (
        "street",
        "streetName",
        "street_name",
        "route",
        "road",
        "thoroughfare",
    )
    number_keys = (
        "streetNumber",
        "street_number",
        "houseNumber",
        "house_number",
        "buildingNumber",
        "building_number",
        "number",
        "nr",
        "no",
    )
    extra_keys = ("block", "bloc", "building", "scara", "staircase", "floor", "etaj", "apartment", "ap")

    for loc in locations:
        if not isinstance(loc, dict):
            continue
        street = next((_sanitize_address_text(loc.get(k)) for k in street_keys if _sanitize_address_text(loc.get(k))), "")
        number = next((_sanitize_address_text(loc.get(k)) for k in number_keys if _sanitize_address_text(loc.get(k))), "")
        if not street:
            continue
        parts = [street]
        if number and number not in street:
            parts.append(f"nr. {number}")
        for key in extra_keys:
            val = _sanitize_address_text(loc.get(key))
            if val and val not in " ".join(parts):
                parts.append(val)
        return ", ".join(parts)
    return ""


def _shipment_address(ship: models.Shipment) -> str:
    recipient_loc = ship.recipient_location if isinstance(ship.recipient_location, dict) else {}
    recipient_pin = ship.recipient_pin if isinstance(ship.recipient_pin, dict) else {}
    raw = ship.raw_data if isinstance(ship.raw_data, dict) else {}
    raw_loc = raw.get("recipientLocation") if isinstance(raw.get("recipientLocation"), dict) else {}
    raw_pin = raw.get("recipientPin") if isinstance(raw.get("recipientPin"), dict) else {}
    for value in (
        getattr(ship, "delivery_address", None),
        recipient_loc.get("addressText"),
        recipient_loc.get("address"),
        recipient_pin.get("addressText"),
        recipient_pin.get("address"),
        raw.get("address"),
        raw.get("recipientAddress"),
    ):
        cleaned = _sanitize_address_text(value)
        if cleaned:
            return cleaned
    structured = _address_from_structured_location(recipient_loc, recipient_pin, raw_loc, raw_pin, raw)
    if structured:
        return structured
    return ""


def _has_street_and_number(address: Any) -> bool:
    text = _sanitize_address_text(address)
    if not text:
        return False
    normalized = (
        unicodedata.normalize("NFD", text)
        .encode("ascii", "ignore")
        .decode("ascii")
        .casefold()
    )
    has_number = any(
        any(ch != "0" for ch in match.group(1))
        for match in re.finditer(r"\b(\d+)[a-z]?\b", normalized)
    )
    has_street_token = bool(
        re.search(r"\b(str|strada|bd|bulevard|calea|aleea|sos|soseaua|drum|dn|dj|nr)\b", normalized)
    )
    has_separator = ("," in normalized) or ("/" in normalized)
    return bool(has_number and (has_street_token or has_separator))


def _locality_center_query_for_shipment(ship: models.Shipment) -> str:
    locality = _shipment_locality(ship)
    county = _shipment_county(ship)
    locality_norm = _normalize_for_key(locality)
    county_norm = _normalize_for_key(county)

    parts: List[str] = []
    if locality:
        parts.append(locality)
    if county and county_norm and county_norm not in locality_norm:
        parts.append(county)
    parts.append("Romania")
    return ", ".join([p for p in parts if str(p).strip()])


def _shipment_has_precise_address(ship: models.Shipment) -> bool:
    return _has_street_and_number(_shipment_address(ship))


def build_geocode_query_for_shipment(ship: models.Shipment) -> str:
    recipient_loc = ship.recipient_location if isinstance(ship.recipient_location, dict) else {}
    parts: List[str] = []

    address = _shipment_address(ship)
    locality = _shipment_locality(ship)
    county = _shipment_county(ship)

    # Rural AWBs often only have locality+county (no street/number).
    # In that case we explicitly geocode locality center (Google-like query),
    # avoiding random/hash fallbacks.
    if not _has_street_and_number(address):
        locality_query = _locality_center_query_for_shipment(ship)
        if locality_query:
            return locality_query

    if address:
        parts.append(_street_address_variant(address))
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
    return hashlib.sha1(f"{_GEOCODE_KEY_VERSION}|{normalized}".encode("utf-8")).hexdigest()


def _geocode_cache_db_path() -> Path:
    raw = str(os.getenv("APP_GEOCODE_CACHE_DB_PATH", "") or "").strip()
    if raw:
        path = Path(raw).expanduser()
    else:
        # Keep default cache path in OS temp dir; safer for cloud runtimes where
        # app source folders may be read-only.
        path = Path(tempfile.gettempdir()) / "arynik-geocode-cache.db"
    if not path.is_absolute():
        path = (Path(__file__).resolve().parents[1] / path).resolve()
    return path


def _ensure_geocode_cache_schema(conn: sqlite3.Connection) -> None:
    conn.execute(
        f"""
        CREATE TABLE IF NOT EXISTS {_GEOCODE_CACHE_TABLE} (
            geocode_key TEXT PRIMARY KEY,
            geocode_query TEXT,
            latitude REAL NOT NULL,
            longitude REAL NOT NULL,
            provider TEXT,
            locality_hint TEXT,
            county_hint TEXT,
            locality_only INTEGER DEFAULT 0,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        )
        """
    )
    conn.execute(
        f"CREATE INDEX IF NOT EXISTS idx_{_GEOCODE_CACHE_TABLE}_updated_at ON {_GEOCODE_CACHE_TABLE}(updated_at DESC)"
    )


def _with_geocode_cache_conn() -> sqlite3.Connection:
    path = _geocode_cache_db_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(path), timeout=20.0)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode = WAL")
    conn.execute("PRAGMA synchronous = NORMAL")
    _ensure_geocode_cache_schema(conn)
    return conn


def load_geocode_cache_entries(
    keys: Iterable[str],
    *,
    allow_fallback: bool = True,
) -> Dict[str, Dict[str, Any]]:
    unique_keys: List[str] = []
    seen: set[str] = set()
    for raw in keys or []:
        key = str(raw or "").strip()
        if not key or key in seen:
            continue
        seen.add(key)
        unique_keys.append(key)
    if not unique_keys:
        return {}

    placeholders = ",".join("?" for _ in unique_keys)
    query = (
        f"SELECT geocode_key, geocode_query, latitude, longitude, provider, locality_hint, county_hint, locality_only "
        f"FROM {_GEOCODE_CACHE_TABLE} WHERE geocode_key IN ({placeholders})"
    )

    out: Dict[str, Dict[str, Any]] = {}
    try:
        conn = _with_geocode_cache_conn()
        try:
            rows = conn.execute(query, unique_keys).fetchall()
        finally:
            conn.close()
    except Exception:
        return out

    for row in rows:
        key = str(row["geocode_key"] or "").strip()
        if not key:
            continue
        normalized = _normalize_ro_coord_pair(row["latitude"], row["longitude"])
        if not normalized:
            continue
        provider = str(row["provider"] or "").strip() or "cache"
        if (not allow_fallback) and _is_fallback_source(provider):
            continue
        out[key] = {
            "geocode_key": key,
            "geocode_query": str(row["geocode_query"] or "").strip(),
            "latitude": float(normalized[0]),
            "longitude": float(normalized[1]),
            "provider": provider,
            "locality_hint": str(row["locality_hint"] or "").strip() or None,
            "county_hint": str(row["county_hint"] or "").strip() or None,
            "locality_only": bool(int(row["locality_only"] or 0)),
        }
    return out


def upsert_geocode_cache_entries(entries: Iterable[Dict[str, Any]]) -> int:
    payloads: List[Tuple[Any, ...]] = []
    now_iso = _now_utc_naive().isoformat()

    for row in entries or []:
        if not isinstance(row, dict):
            continue
        key = str(row.get("geocode_key") or "").strip()
        query_text = str(row.get("geocode_query") or "").strip()
        provider = str(row.get("provider") or "").strip() or "cache"
        normalized = _normalize_ro_coord_pair(row.get("latitude"), row.get("longitude"))
        if not key or not query_text or not normalized:
            continue
        locality_hint = str(row.get("locality_hint") or "").strip() or None
        county_hint = str(row.get("county_hint") or "").strip() or None
        locality_only = 1 if bool(row.get("locality_only")) else 0
        payloads.append(
            (
                key,
                query_text,
                float(normalized[0]),
                float(normalized[1]),
                provider,
                locality_hint,
                county_hint,
                locality_only,
                now_iso,
                now_iso,
            )
        )

    if not payloads:
        return 0

    with _with_geocode_cache_conn() as conn:
        conn.executemany(
            f"""
            INSERT INTO {_GEOCODE_CACHE_TABLE}
                (geocode_key, geocode_query, latitude, longitude, provider, locality_hint, county_hint, locality_only, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(geocode_key) DO UPDATE SET
                geocode_query = excluded.geocode_query,
                latitude = excluded.latitude,
                longitude = excluded.longitude,
                provider = excluded.provider,
                locality_hint = excluded.locality_hint,
                county_hint = excluded.county_hint,
                locality_only = excluded.locality_only,
                updated_at = excluded.updated_at
            """,
            payloads,
        )
        conn.commit()
    return len(payloads)


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
        normalized = _normalize_ro_coord_pair(location.get("lat"), location.get("lng"))
        if not normalized:
            return None
        lat, lon = normalized

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
    ]
    locality_values = [v for v in locality_values if v]
    if not locality_values:
        locality_values.append(candidate.get("display_name"))
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
        normalized = _normalize_ro_coord_pair(top.get("lat"), top.get("lon"))
        if not normalized:
            return None
        lat, lon = normalized

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
    has_google_key = bool(get_google_maps_api_key())
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
    google_api_key: Optional[str] = None,
) -> Optional[Dict[str, Any]]:
    chain = list(providers or _resolve_geocode_providers())
    api_key = str(google_api_key or "").strip() or get_google_maps_api_key()
    if api_key and "google" not in chain:
        chain.insert(0, "google")
    if not api_key:
        chain = [p for p in chain if p != "google"]
    strict_locality = str(expected_locality or "").strip()
    strict_county = str(expected_county or "").strip()
    query_variants = _geocode_query_variants(query) or [str(query or "").strip()]

    def _run_chain(active_query: str, exp_locality: str, exp_county: str) -> Optional[Dict[str, Any]]:
        for provider in chain:
            if provider == "google":
                if not api_key:
                    continue
                payload = _google_geocode(
                    client,
                    active_query,
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
                    active_query,
                    timeout_s=timeout_s,
                    expected_locality=exp_locality,
                    expected_county=exp_county,
                )
                if payload:
                    return payload
                continue
        return None

    for active_query in query_variants:
        strict_payload = _run_chain(active_query, strict_locality, strict_county)
        if strict_payload:
            return strict_payload

    return None


def geocode_query_live(
    query: str,
    *,
    expected_locality: Optional[str] = None,
    expected_county: Optional[str] = None,
    google_api_key: Optional[str] = None,
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
            google_api_key=google_api_key,
        )


def refresh_shipments_geocoding(
    db: Session,
    *,
    awbs: Optional[Iterable[str]] = None,
    limit: int = 600,
    force_retry: bool = False,
    fast_mode: bool = False,
    google_api_key: Optional[str] = None,
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
    cache_upserts: Dict[str, Dict[str, Any]] = {}
    cache_rank_by_key: Dict[str, int] = {}

    def _remember_cache_entry(
        geocode_key: str,
        geocode_query: str,
        lat: Any,
        lon: Any,
        *,
        provider: str,
        locality_hint: str = "",
        county_hint: str = "",
        locality_only: bool = False,
    ) -> None:
        key_s = str(geocode_key or "").strip()
        query_s = str(geocode_query or "").strip()
        if not key_s or not query_s:
            return
        normalized = _normalize_ro_coord_pair(lat, lon)
        if not normalized:
            return
        provider_s = str(provider or "").strip() or "cache"
        rank = 0 if _is_fallback_source(provider_s) else 1
        if rank < cache_rank_by_key.get(key_s, -1):
            return
        cache_upserts[key_s] = {
            "geocode_key": key_s,
            "geocode_query": query_s,
            "latitude": float(normalized[0]),
            "longitude": float(normalized[1]),
            "provider": provider_s,
            "locality_hint": str(locality_hint or "").strip() or None,
            "county_hint": str(county_hint or "").strip() or None,
            "locality_only": bool(locality_only),
        }
        cache_rank_by_key[key_s] = rank

    def _flush_cache_upserts() -> None:
        if not cache_upserts:
            return
        try:
            upsert_geocode_cache_entries(cache_upserts.values())
        except Exception as exc:
            logger.warning("Failed to update geocode cache DB: %s", str(exc))

    for ship in rows:
        stats["scanned"] += 1

        query_text = build_geocode_query_for_shipment(ship)
        key = build_geocode_key(query_text)
        if not query_text or not key:
            stats["skipped"] += 1
            continue
        expected_locality = _normalize_for_key(_shipment_locality(ship))
        expected_county = _normalize_for_key(_shipment_county(ship))
        locality_only = not _shipment_has_precise_address(ship)

        old_key = str(getattr(ship, "geocode_key", "") or "")
        has_coords = _valid_coord(ship.latitude, ship.longitude)
        source = str(getattr(ship, "geocode_source", "") or "").strip().lower()
        geocoded_at = getattr(ship, "geocoded_at", None)

        if str(getattr(ship, "geocode_query", "") or "") != query_text:
            ship.geocode_query = query_text
        if old_key != key:
            ship.geocode_key = key

        # Fast local recovery from stored Postis payload.
        # This avoids unnecessary network geocoding when raw payload already has coordinates.
        if not has_coords:
            raw_coords = _coords_from_shipment_raw(ship)
            if raw_coords:
                lat_raw, lon_raw, raw_source = raw_coords
                ship.latitude = float(lat_raw)
                ship.longitude = float(lon_raw)
                ship.geocoded_at = now
                ship.geocode_source = raw_source
                _remember_cache_entry(
                    key,
                    query_text,
                    lat_raw,
                    lon_raw,
                    provider=raw_source,
                    locality_hint=expected_locality,
                    county_hint=expected_county,
                    locality_only=locality_only,
                )
                stats["reused"] += 1
                stats["geocoded"] += 1
                continue

        # Fallback points are usable for map rendering but should be replaced by real geocoding
        # whenever an explicit refresh is requested.
        if has_coords and _is_fallback_source(source) and (force_retry or fast_mode):
            has_coords = False

        if has_coords:
            if old_key and old_key != key and not _is_trusted_direct_source(source):
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
        if (not force_retry) and source in {"not-found", "error"} and isinstance(geocoded_at, datetime):
            if (now - geocoded_at) < retry_after:
                stats["skipped"] += 1
                continue

        pending_by_key.setdefault(key, []).append(ship)
        query_by_key.setdefault(key, query_text)
        query_meta_by_key.setdefault(
            key,
            {
                "expected_locality": expected_locality,
                "expected_county": expected_county,
                "locality_only": "1" if locality_only else "0",
            },
        )

    if not pending_by_key:
        db.commit()
        _flush_cache_upserts()
        return stats

    stats["pending"] = int(sum(len(v) for v in pending_by_key.values()))
    keys = list(pending_by_key.keys())

    separate_cache_rows = load_geocode_cache_entries(
        keys,
        allow_fallback=not (force_retry or fast_mode),
    )
    for key in list(pending_by_key.keys()):
        cached = separate_cache_rows.get(key)
        if not cached:
            continue
        lat = float(cached["latitude"])
        lon = float(cached["longitude"])
        provider = str(cached.get("provider") or "cache")
        for ship in pending_by_key[key]:
            ship.latitude = lat
            ship.longitude = lon
            ship.geocoded_at = now
            ship.geocode_source = f"cache-db:{provider}"
        stats["reused"] += len(pending_by_key[key])
        del pending_by_key[key]

    # First reuse coordinates already available in DB for the same geocode_key.
    cache_rows = (
        db.query(models.Shipment.geocode_key, models.Shipment.latitude, models.Shipment.longitude, models.Shipment.geocode_source)
        .filter(models.Shipment.geocode_key.in_(keys))
        .filter(models.Shipment.latitude.isnot(None), models.Shipment.longitude.isnot(None))
        .all()
    )

    cached_by_key: Dict[str, Tuple[float, float]] = {}
    cached_rank_by_key: Dict[str, int] = {}
    cached_source_by_key: Dict[str, str] = {}
    for key, lat, lon, source in cache_rows:
        key_s = str(key or "").strip()
        if not key_s:
            continue
        normalized = _normalize_ro_coord_pair(lat, lon)
        if not normalized:
            continue
        rank = 0 if _is_fallback_source(source) else 1
        prev_rank = cached_rank_by_key.get(key_s, -1)
        # Prefer non-fallback cached coordinates over fallback ones.
        if rank < prev_rank:
            continue
        # During refresh retries, don't reuse fallback cache; force provider geocoding first.
        if rank == 0 and (force_retry or fast_mode):
            continue
        cached_by_key[key_s] = (float(normalized[0]), float(normalized[1]))
        cached_rank_by_key[key_s] = rank
        cached_source_by_key[key_s] = str(source or "").strip() or "db-cache"

    for key in list(pending_by_key.keys()):
        coords = cached_by_key.get(key)
        if not coords:
            continue
        lat, lon = coords
        cached_source = cached_source_by_key.get(key, "db-cache")
        for ship in pending_by_key[key]:
            ship.latitude = lat
            ship.longitude = lon
            ship.geocoded_at = now
            ship.geocode_source = "db-cache"
        meta = query_meta_by_key.get(key, {})
        _remember_cache_entry(
            key,
            query_by_key.get(key, ""),
            lat,
            lon,
            provider=cached_source,
            locality_hint=str(meta.get("expected_locality") or ""),
            county_hint=str(meta.get("expected_county") or ""),
            locality_only=str(meta.get("locality_only") or "") == "1",
        )
        stats["reused"] += len(pending_by_key[key])
        del pending_by_key[key]

    if not pending_by_key:
        db.commit()
        _flush_cache_upserts()
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
            locality_only = str(meta.get("locality_only") or "") == "1"

            if not query_text:
                rows_needing_fallback.extend(rows_for_key)
                continue
            if locality_only:
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
                google_api_key=google_api_key,
            )
            last_call_at = time.monotonic()

            if payload:
                normalized = _normalize_ro_coord_pair(payload.get("lat"), payload.get("lon"))
                provider = str(payload.get("provider") or "").strip() or "geocoder"
                if locality_only and provider in {"google_geocoding", "nominatim"}:
                    provider = f"{provider}-locality-center"
                if normalized:
                    lat, lon = normalized
                    for ship in rows_for_key:
                        ship.latitude = float(lat)
                        ship.longitude = float(lon)
                        ship.geocoded_at = now
                        ship.geocode_source = provider
                    _remember_cache_entry(
                        key,
                        query_text,
                        lat,
                        lon,
                        provider=provider,
                        locality_hint=expected_locality,
                        county_hint=expected_county,
                        locality_only=locality_only,
                    )
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
            query_text = build_geocode_query_for_shipment(ship)
            geocode_key = build_geocode_key(query_text)
            if geocode_key and query_text:
                _remember_cache_entry(
                    geocode_key,
                    query_text,
                    lat,
                    lon,
                    provider=source,
                    locality_hint=_normalize_for_key(_shipment_locality(ship)),
                    county_hint=_normalize_for_key(_shipment_county(ship)),
                    locality_only=not _shipment_has_precise_address(ship),
                )
            if source == "fallback-locality-centroid":
                stats["fallback_locality"] += 1
            elif source in {"fallback-locality-hash", "fallback-query-county-hash"}:
                stats["fallback_locality"] += 1
            elif source in {"fallback-county-centroid", "fallback-county-hash"}:
                stats["fallback_county"] += 1
            else:
                stats["fallback_hash"] += 1
            stats["geocoded"] += 1

    db.commit()
    _flush_cache_upserts()
    return stats
