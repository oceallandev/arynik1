import asyncio
import csv
import io
import json
import os
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional, Tuple

import httpx

# Fan Courier counties/cities list (Romania) published by besciualex.
FAN_CURIER_CSV_URL = os.getenv(
    "RO_LOCALITIES_FAN_CURIER_CSV_URL",
    "https://raw.githubusercontent.com/besciualex/judete-si-orase-romania-fan-curier/master/db.csv",
)

_CACHE_TTL = timedelta(hours=24)
_cache_lock = asyncio.Lock()
_cache: Optional[Dict[str, Any]] = None
_cache_ts: Optional[datetime] = None


def _now_utc() -> datetime:
    return datetime.now(timezone.utc)


def _pick_field(fieldnames: List[str], needles: List[str]) -> Optional[str]:
    lowered = [f.lower().strip() for f in fieldnames if f]
    for needle in needles:
        n = needle.lower()
        for idx, f in enumerate(lowered):
            if n in f:
                return fieldnames[idx]
    return None


def _to_float(value: Any) -> Optional[float]:
    try:
        if value is None:
            return None
        s = str(value).strip().replace(",", ".")
        if not s:
            return None
        return float(s)
    except Exception:
        return None


def _parse_fan_curier_csv(text: str) -> Dict[str, Any]:
    sample = text[:8192]
    sniffer = csv.Sniffer()
    try:
        dialect = sniffer.sniff(sample, delimiters=",;\t|")
    except Exception:
        dialect = csv.excel

    try:
        has_header = sniffer.has_header(sample)
    except Exception:
        has_header = True

    f = io.StringIO(text)

    counties: Dict[str, Dict[str, Any]] = {}

    def add_row(county: str, city: str, lat: Optional[float], lon: Optional[float]) -> None:
        county = str(county or "").strip()
        city = str(city or "").strip()
        if not county or not city:
            return
        bucket = counties.setdefault(county, {"cities": {}, "count": 0})
        bucket["count"] += 1
        entry = bucket["cities"].get(city) or {"name": city, "lat": None, "lon": None}
        # Prefer explicit coords if present.
        if lat is not None and lon is not None:
            entry["lat"] = lat
            entry["lon"] = lon
        bucket["cities"][city] = entry

    if has_header:
        reader = csv.DictReader(f, dialect=dialect)
        fieldnames = reader.fieldnames or []
        county_field = _pick_field(fieldnames, ["judet", "county"])
        city_field = _pick_field(fieldnames, ["oras", "localitate", "city", "locality"])
        lat_field = _pick_field(fieldnames, ["lat"])
        lon_field = _pick_field(fieldnames, ["lon", "lng", "long"])

        for row in reader:
            if not isinstance(row, dict):
                continue
            county = row.get(county_field) if county_field else None
            city = row.get(city_field) if city_field else None
            if county is None or city is None:
                # If headers are unexpected, fall back to first two values.
                vals = list(row.values())
                county = county if county is not None else (vals[0] if len(vals) > 0 else None)
                city = city if city is not None else (vals[1] if len(vals) > 1 else None)
            lat = _to_float(row.get(lat_field)) if lat_field else None
            lon = _to_float(row.get(lon_field)) if lon_field else None
            add_row(county, city, lat, lon)
    else:
        reader = csv.reader(f, dialect=dialect)
        for cols in reader:
            if not cols:
                continue
            county = cols[0] if len(cols) > 0 else None
            city = cols[1] if len(cols) > 1 else None
            lat = _to_float(cols[2]) if len(cols) > 3 else None
            lon = _to_float(cols[3]) if len(cols) > 3 else None
            add_row(county, city, lat, lon)

    out_counties = []
    for county, bucket in counties.items():
        cities_map = bucket.get("cities") or {}
        cities = sorted(cities_map.values(), key=lambda x: str(x.get("name", "")).casefold())
        out_counties.append(
            {
                "name": county,
                "cities": cities,
            }
        )

    out_counties.sort(key=lambda x: str(x.get("name", "")).casefold())

    return {
        "source": "fan_curier_csv",
        "csv_url": FAN_CURIER_CSV_URL,
        "generated_at": _now_utc().isoformat(),
        "counties": out_counties,
    }


async def _fetch_csv(url: str) -> str:
    timeout = httpx.Timeout(30.0, connect=15.0)
    async with httpx.AsyncClient(timeout=timeout) as client:
        resp = await client.get(url, headers={"accept": "text/csv,*/*"})
        resp.raise_for_status()
        return resp.text


async def get_ro_localities(force_refresh: bool = False) -> Dict[str, Any]:
    global _cache, _cache_ts

    async with _cache_lock:
        if not force_refresh and _cache and _cache_ts and (_now_utc() - _cache_ts) < _CACHE_TTL:
            return _cache

        text = await _fetch_csv(FAN_CURIER_CSV_URL)
        parsed = _parse_fan_curier_csv(text)

        _cache = parsed
        _cache_ts = _now_utc()
        return parsed


def list_counties(payload: Dict[str, Any]) -> List[str]:
    counties = payload.get("counties") or []
    out = []
    for c in counties:
        if isinstance(c, dict) and c.get("name"):
            out.append(str(c["name"]))
    return out


def list_cities(payload: Dict[str, Any], county: Optional[str] = None) -> List[str]:
    counties = payload.get("counties") or []
    out: List[str] = []

    def add_city_entry(entry: Any) -> None:
        if isinstance(entry, dict) and entry.get("name"):
            out.append(str(entry["name"]))
        elif isinstance(entry, str) and entry.strip():
            out.append(entry.strip())

    if county:
        target = str(county).strip().casefold()
        for c in counties:
            if not isinstance(c, dict):
                continue
            if str(c.get("name", "")).strip().casefold() != target:
                continue
            for city in (c.get("cities") or []):
                add_city_entry(city)
            break
    else:
        for c in counties:
            if not isinstance(c, dict):
                continue
            for city in (c.get("cities") or []):
                add_city_entry(city)

    # Deduplicate while preserving sort (case-insensitive).
    seen = set()
    deduped = []
    for name in out:
        key = name.casefold()
        if key in seen:
            continue
        seen.add(key)
        deduped.append(name)
    deduped.sort(key=lambda s: s.casefold())
    return deduped


def filter_names(values: List[str], q: Optional[str] = None, limit: int = 200) -> List[str]:
    if not q:
        return values[:limit]
    needle = str(q).strip().casefold()
    if not needle:
        return values[:limit]
    out = [v for v in values if needle in str(v).casefold()]
    return out[:limit]

