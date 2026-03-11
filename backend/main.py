import warnings

# macOS system Python can ship LibreSSL; ignore urllib3's compatibility warning noise in logs.
warnings.filterwarnings("ignore", message="urllib3 v2 only supports OpenSSL 1.1.1+.*")

import io
from fastapi import FastAPI, Depends, HTTPException, status, APIRouter, Response
from fastapi.responses import StreamingResponse, FileResponse, JSONResponse
from fastapi.security import OAuth2PasswordBearer, OAuth2PasswordRequestForm
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import and_, false, or_, func
from sqlalchemy.orm import Session
from sqlalchemy.exc import OperationalError
from datetime import datetime, timedelta, timezone
from dataclasses import replace
import jwt
import os
import logging
import secrets
import hashlib
import sys
import unicodedata
import httpx
from collections import defaultdict
from typing import Any, List, Set, Optional, Dict, Tuple
from zoneinfo import ZoneInfo
from dotenv import load_dotenv
import asyncio

# Load environment variables from the backend directory
env_path = os.path.join(os.path.dirname(__file__), '.env')
load_dotenv(dotenv_path=env_path, override=False)

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))

# Support running as a package (`uvicorn backend.main:app` from repo root)
# and as a module file (`uvicorn main:app` from within `backend/`).
try:
    from . import models, schemas, database, postis_client, driver_manager, authz, postis_statuses
    from .services import (
        routing_service,
        ro_localities_service,
        shipments_service,
        drivers_service,
        vehicle_types_service,
        fleet_service,
        notifications_service,
        whatsapp_service,
        phone_service,
        tracking_service,
        chat_service,
        postis_sync_service,
        manifests_service,
        contacts_service,
        route_runs_service,
        route_planning_service,
        cod_service,
        geocoding_service,
    )
except ImportError:  # pragma: no cover
    import models, schemas, database, postis_client, driver_manager, authz, postis_statuses
    from services import (
        routing_service,
        ro_localities_service,
        shipments_service,
        drivers_service,
        vehicle_types_service,
        fleet_service,
        notifications_service,
        whatsapp_service,
        phone_service,
        tracking_service,
        chat_service,
        postis_sync_service,
        manifests_service,
        contacts_service,
        route_runs_service,
        route_planning_service,
        cod_service,
        geocoding_service,
    )

# Setup logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Config
def _load_secret_key() -> str:
    configured = str(os.getenv("JWT_SECRET", "supersecretkey") or "")
    if len(configured.encode("utf-8")) >= 32:
        return configured

    # Keep compatibility with existing short secrets by deriving a stable stronger key.
    derived = hashlib.sha256(configured.encode("utf-8")).hexdigest()
    logger.warning("JWT_SECRET is shorter than 32 bytes; deriving a hardened key via SHA-256.")
    return derived


SECRET_KEY = _load_secret_key()
ALGORITHM = "HS256"
ACCESS_TOKEN_EXPIRE_MINUTES = 60 * 24 # 1 day

POSTIS_BASE_URL = os.getenv("POSTIS_BASE_URL", "https://shipments.postisgate.com")
POSTIS_USER = os.getenv("POSTIS_USERNAME")
POSTIS_PASS = os.getenv("POSTIS_PASSWORD")


def _cors_origins_from_env() -> List[str]:
    """
    Parse CORS origins from env:
      CORS_ALLOWED_ORIGINS=https://app.example.com,https://www.app.example.com
    If empty/unset, keep permissive fallback for local/dev compatibility.
    """
    raw = str(os.getenv("CORS_ALLOWED_ORIGINS", "") or "").strip()
    if not raw:
        return ["*"]
    origins = [o.strip().rstrip("/") for o in raw.split(",") if o.strip()]
    return origins or ["*"]

# Create tables
# models.Base.metadata.create_all(bind=database.engine)

app = FastAPI(title="Postis Shipment Update API")

_CORS_ORIGINS = _cors_origins_from_env()
_CORS_IS_WILDCARD = len(_CORS_ORIGINS) == 1 and _CORS_ORIGINS[0] == "*"

app.add_middleware(
    CORSMiddleware,
    allow_origins=_CORS_ORIGINS,
    allow_credentials=not _CORS_IS_WILDCARD,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=[
        "Content-Disposition",
        "X-Labels-Requested",
        "X-Labels-Found",
        "X-Labels-Missing",
        "X-Labels-Missing-AWBS",
    ],
)

oauth2_scheme = OAuth2PasswordBearer(tokenUrl="login")
p_client = postis_client.PostisClient(POSTIS_BASE_URL, POSTIS_USER, POSTIS_PASS)


@app.exception_handler(OperationalError)
async def handle_operational_error(_request, exc: OperationalError):
    logger.error("Database operational error: %s", str(exc), exc_info=True)
    return JSONResponse(
        status_code=503,
        content={"detail": "Baza de date este temporar indisponibila. Reincercati in cateva secunde."},
    )

_EVENT_TO_STATUS = postis_statuses.event_id_to_description()

def _ensure_status_options(db: Session):
    # Postis status options (eventId -> eventDescription). Keep the strings exactly as in Postis.
    desired = list(postis_statuses.STATUS_OPTIONS)

    desired_ids = {opt["event_id"] for opt in desired}
    existing = {opt.event_id: opt for opt in db.query(models.StatusOption).all()}

    changed = False
    for spec in desired:
        event_id = spec["event_id"]
        opt = existing.get(event_id)
        if opt:
            desired_requirements = spec.get("requirements")
            if (
                opt.label != spec["label"]
                or opt.description != spec["description"]
                or (opt.requirements or None) != (desired_requirements or None)
            ):
                opt.label = spec["label"]
                opt.description = spec["description"]
                opt.requirements = desired_requirements
                changed = True
        else:
            db.add(models.StatusOption(**spec))
            changed = True

    # Remove legacy/demo options so the UI doesn't show invalid choices.
    for event_id, opt in existing.items():
        if event_id not in desired_ids:
            db.delete(opt)
            changed = True

    if changed:
        db.commit()

    options = db.query(models.StatusOption).all()
    # Keep deterministic ordering: 1..7.
    order = {opt["event_id"]: idx for idx, opt in enumerate(desired)}
    return sorted(options, key=lambda o: order.get(o.event_id, 999))

def create_access_token(data: dict):
    to_encode = data.copy()
    expire = datetime.utcnow() + timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES)
    to_encode.update({"exp": expire})
    encoded_jwt = jwt.encode(to_encode, SECRET_KEY, algorithm=ALGORITHM)
    return encoded_jwt

async def get_current_driver(token: str = Depends(oauth2_scheme), db: Session = Depends(database.get_db)):
    credentials_exception = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Could not validate credentials",
        headers={"WWW-Authenticate": "Bearer"},
    )
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
        username: str = payload.get("sub")
        if username is None:
            raise credentials_exception
    except jwt.PyJWTError:
        raise credentials_exception
    driver = db.query(models.Driver).filter(models.Driver.username == username).first()
    if driver is None:
        raise credentials_exception
    return driver

def role_required(allowed_roles: List[str]):
    async def role_checker(current_driver: models.Driver = Depends(get_current_driver)):
        role = authz.normalize_role(current_driver.role)
        if role not in allowed_roles:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Not enough permissions"
            )
        return current_driver
    return role_checker


def permission_required(permission: str):
    async def permission_checker(current_driver: models.Driver = Depends(get_current_driver)):
        if not authz.role_has_permission(current_driver.role, permission):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Not enough permissions"
            )
        return current_driver

    return permission_checker


def _permissions_for_role(role: str) -> List[str]:
    role_norm = authz.normalize_role(role)
    perms: Set[str] = set(authz.ROLE_PERMISSIONS.get(role_norm, set()))
    # Keep the implicit rule explicit in listings.
    if authz.PERM_LOGS_READ_ALL in perms:
        perms.add(authz.PERM_LOGS_READ_SELF)
    return sorted(perms)


def _is_delivered_status(*values: Optional[str]) -> bool:
    """Best-effort delivered matcher across Postis status variants/codes."""
    for raw in values:
        if raw is None:
            continue
        normalized = postis_statuses.normalize_shipment_status(raw)
        folded = str(normalized or "").strip().casefold()
        if not folded:
            continue
        if "livrat" in folded or "deliver" in folded:
            return True
    return False


def _is_driver_pool_status(*values: Optional[str]) -> bool:
    """
    Statuses that drivers can see/pull for self-assignment when shipment has no driver yet.
    """
    for raw in values:
        if raw is None:
            continue
        normalized = postis_statuses.normalize_shipment_status(raw)
        folded = str(normalized or "").strip().casefold()
        if not folded:
            continue
        if (
            "finalizare pregatire depozit" in folded
            or "initial" in folded
            or "expediere preluata de curier" in folded
            or "expedierea a fost preluata de curier" in folded
            or "intrare in depozit" in folded
            or "livrare reprogramata" in folded
            or "refuzare colet" in folded
        ):
            return True
    return False


def _extract_signature_data_url(payload: Optional[dict]) -> str:
    if not isinstance(payload, dict):
        return ""
    pod = payload.get("pod")
    if not isinstance(pod, dict):
        return ""
    signature = pod.get("signature")
    if isinstance(signature, dict):
        return str(signature.get("data_url") or "").strip()
    if isinstance(signature, str):
        return str(signature).strip()
    return ""


def _has_valid_signature_payload(payload: Optional[dict]) -> bool:
    data_url = _extract_signature_data_url(payload)
    return data_url.startswith("data:image/")

BUY_BACK_INSTRUCTION_MARKER = "retur deseu la greenwee buzau"


def _extract_image_data_url(value: Any) -> str:
    if isinstance(value, dict):
        return str(value.get("data_url") or "").strip()
    if isinstance(value, str):
        return str(value).strip()
    return ""


def _extract_payload_image(payload: Optional[dict], *keys: str) -> str:
    if not isinstance(payload, dict):
        return ""
    current: Any = payload
    for key in keys:
        if not isinstance(current, dict):
            return ""
        current = current.get(key)
    return _extract_image_data_url(current)


def _shipment_delivery_instructions_text(ship: Optional[models.Shipment]) -> str:
    if not ship:
        return ""
    raw = getattr(ship, "raw_data", None)
    if not isinstance(raw, dict):
        raw = {}
    additional = raw.get("additionalServices") if isinstance(raw.get("additionalServices"), dict) else {}
    info = raw.get("info") if isinstance(raw.get("info"), dict) else {}
    candidates = [
        getattr(ship, "delivery_instructions", None),
        raw.get("shippingInstruction"),
        raw.get("shipping_instruction"),
        info.get("shippingInstruction"),
        info.get("shipping_instruction"),
        additional.get("shippingInstruction"),
        additional.get("shipping_instruction"),
    ]
    for value in candidates:
        text = str(value or "").strip()
        if text:
            return text
    return ""


def _shipment_requires_buy_back_photo(ship: Optional[models.Shipment]) -> bool:
    text = _shipment_delivery_instructions_text(ship)
    folded = (
        unicodedata.normalize("NFD", str(text or ""))
        .encode("ascii", "ignore")
        .decode("ascii")
        .strip()
        .casefold()
    )
    return BUY_BACK_INSTRUCTION_MARKER in folded


def _business_day_utc_bounds() -> tuple[datetime, datetime, str]:
    """
    Compute today's [start, end) in business timezone, then convert to UTC-naive
    for comparison with DB datetimes (stored as naive UTC).
    """
    tz_name = str(os.getenv("APP_BUSINESS_TIMEZONE", "Europe/Bucharest") or "").strip() or "Europe/Bucharest"
    try:
        tz = ZoneInfo(tz_name)
    except Exception:
        tz = timezone.utc
        tz_name = "UTC"

    now_local = datetime.now(timezone.utc).astimezone(tz)
    start_local = now_local.replace(hour=0, minute=0, second=0, microsecond=0)
    end_local = start_local + timedelta(days=1)
    start_utc = start_local.astimezone(timezone.utc).replace(tzinfo=None)
    end_utc = end_local.astimezone(timezone.utc).replace(tzinfo=None)
    return start_utc, end_utc, tz_name


def _business_timezone() -> tuple[timezone, str]:
    tz_name = str(os.getenv("APP_BUSINESS_TIMEZONE", "Europe/Bucharest") or "").strip() or "Europe/Bucharest"
    try:
        tz = ZoneInfo(tz_name)
    except Exception:
        tz = timezone.utc
        tz_name = "UTC"
    return tz, tz_name


def _as_utc_naive(dt: Optional[datetime]) -> Optional[datetime]:
    if not isinstance(dt, datetime):
        return None
    if dt.tzinfo is None:
        return dt
    try:
        return dt.astimezone(timezone.utc).replace(tzinfo=None)
    except Exception:
        return dt.replace(tzinfo=None)


def _period_bounds_utc(period: str, *, now_utc: Optional[datetime] = None) -> tuple[datetime, datetime, str]:
    tz, tz_name = _business_timezone()
    now_local = (now_utc or datetime.now(timezone.utc)).astimezone(tz)
    start_today_local = now_local.replace(hour=0, minute=0, second=0, microsecond=0)

    period_key = str(period or "today").strip().lower()
    if period_key == "week":
        # ISO week start (Monday)
        start_local = start_today_local - timedelta(days=start_today_local.weekday())
        end_local = start_local + timedelta(days=7)
    elif period_key == "month":
        start_local = start_today_local.replace(day=1)
        if start_local.month == 12:
            end_local = start_local.replace(year=start_local.year + 1, month=1, day=1)
        else:
            end_local = start_local.replace(month=start_local.month + 1, day=1)
    else:
        start_local = start_today_local
        end_local = start_local + timedelta(days=1)

    start_utc = start_local.astimezone(timezone.utc).replace(tzinfo=None)
    end_utc = end_local.astimezone(timezone.utc).replace(tzinfo=None)
    return start_utc, end_utc, tz_name


def _iso_z(dt: Optional[datetime]) -> Optional[str]:
    if not dt:
        return None
    n = _as_utc_naive(dt)
    if not n:
        return None
    return n.isoformat() + "Z"


def _safe_float(value: Optional[float]) -> float:
    try:
        num = float(value or 0)
        if num != num:  # NaN
            return 0.0
        return num
    except Exception:
        return 0.0


def _decode_google_polyline(encoded: str) -> List[List[float]]:
    """
    Decode Google encoded polyline into GeoJSON coordinates [[lon, lat], ...].
    """
    text_val = str(encoded or "").strip()
    if not text_val:
        return []

    out: List[List[float]] = []
    index = 0
    lat = 0
    lon = 0

    while index < len(text_val):
        shift = 0
        result = 0
        while True:
            b = ord(text_val[index]) - 63
            index += 1
            result |= (b & 0x1F) << shift
            shift += 5
            if b < 0x20:
                break
        dlat = ~(result >> 1) if (result & 1) else (result >> 1)
        lat += dlat

        shift = 0
        result = 0
        while True:
            b = ord(text_val[index]) - 63
            index += 1
            result |= (b & 0x1F) << shift
            shift += 5
            if b < 0x20:
                break
        dlon = ~(result >> 1) if (result & 1) else (result >> 1)
        lon += dlon

        out.append([lon / 1e5, lat / 1e5])

    return out


def _split_google_route_points(points: List[schemas.RouteMetricPoint], *, max_points: int = 25) -> List[List[schemas.RouteMetricPoint]]:
    out: List[List[schemas.RouteMetricPoint]] = []
    arr = list(points or [])
    if len(arr) < 2:
        return out
    if len(arr) <= max_points:
        return [arr]

    idx = 0
    last = len(arr) - 1
    while idx < last:
        end_idx = min(idx + max_points - 1, last)
        segment = arr[idx : end_idx + 1]
        if len(segment) >= 2:
            out.append(segment)
        if end_idx >= last:
            break
        # Overlap one point between segments to keep continuous path.
        idx = end_idx
    return out


async def _google_route_metrics_segment(
    client: httpx.AsyncClient,
    *,
    api_key: str,
    points: List[schemas.RouteMetricPoint],
) -> Optional[Dict[str, Any]]:
    list_points = list(points or [])
    if len(list_points) < 2 or len(list_points) > 25:
        return None

    origin = f"{float(list_points[0].lat)},{float(list_points[0].lon)}"
    destination = f"{float(list_points[-1].lat)},{float(list_points[-1].lon)}"
    waypoints = [f"{float(p.lat)},{float(p.lon)}" for p in list_points[1:-1]]
    traffic_model = str(os.getenv("GOOGLE_ROUTE_TRAFFIC_MODEL", "best_guess") or "best_guess").strip().lower()
    if traffic_model not in {"best_guess", "optimistic", "pessimistic"}:
        traffic_model = "best_guess"
    departure_mode = str(os.getenv("GOOGLE_ROUTE_DEPARTURE_MODE", "now") or "now").strip().lower()
    departure_param: Any = "now"
    if departure_mode not in {"", "now"}:
        try:
            departure_ts = int(float(departure_mode))
            departure_param = departure_ts if departure_ts > 0 else "now"
        except Exception:
            departure_param = "now"

    params: Dict[str, Any] = {
        "key": api_key,
        "origin": origin,
        "destination": destination,
        "mode": "driving",
        "departure_time": departure_param,
        "traffic_model": traffic_model,
    }
    if waypoints:
        params["waypoints"] = "|".join(waypoints)

    res = await client.get("https://maps.googleapis.com/maps/api/directions/json", params=params)
    if res.status_code != 200:
        return None

    payload = res.json() if callable(getattr(res, "json", None)) else {}
    if str(payload.get("status") or "").strip().upper() != "OK":
        return None

    routes = payload.get("routes") if isinstance(payload, dict) else None
    route = routes[0] if isinstance(routes, list) and routes else None
    if not isinstance(route, dict):
        return None

    poly = ((route.get("overview_polyline") or {}) if isinstance(route.get("overview_polyline"), dict) else {}).get("points")
    coords = _decode_google_polyline(str(poly or ""))
    geometry = {"type": "LineString", "coordinates": coords} if len(coords) > 1 else None

    distance_m = 0.0
    duration_s = 0.0
    duration_no_traffic_s = 0.0
    legs = route.get("legs") if isinstance(route.get("legs"), list) else []
    for leg in legs:
        if not isinstance(leg, dict):
            continue
        distance_m += _safe_float(((leg.get("distance") or {}) if isinstance(leg.get("distance"), dict) else {}).get("value"))
        duration_traffic = ((leg.get("duration_in_traffic") or {}) if isinstance(leg.get("duration_in_traffic"), dict) else {}).get("value")
        duration_normal = ((leg.get("duration") or {}) if isinstance(leg.get("duration"), dict) else {}).get("value")
        normal_s = _safe_float(duration_normal)
        duration_no_traffic_s += normal_s
        if duration_traffic is not None:
            duration_s += _safe_float(duration_traffic)
        else:
            duration_s += normal_s

    delay_s = max(0.0, float(duration_s) - float(duration_no_traffic_s))

    return {
        "geometry": geometry,
        "distance_m": float(distance_m),
        "duration_s": float(duration_s),
        "duration_no_traffic_s": float(duration_no_traffic_s),
        "delay_s": float(delay_s),
        "provider": "google_traffic",
    }


async def _google_route_metrics(points: List[schemas.RouteMetricPoint]) -> Optional[Dict[str, Any]]:
    api_key = str(os.getenv("GOOGLE_MAPS_API_KEY", "") or "").strip()
    if not api_key:
        return None

    list_points = list(points or [])
    if len(list_points) < 2:
        return None

    segments = _split_google_route_points(list_points, max_points=25)
    if not segments:
        return None

    try:
        async with httpx.AsyncClient(timeout=20.0) as client:
            merged_coords: List[List[float]] = []
            total_distance = 0.0
            total_duration = 0.0
            total_duration_no_traffic = 0.0

            for segment in segments:
                part = await _google_route_metrics_segment(client, api_key=api_key, points=segment)
                if not part:
                    return None

                total_distance += _safe_float(part.get("distance_m"))
                total_duration += _safe_float(part.get("duration_s"))
                total_duration_no_traffic += _safe_float(part.get("duration_no_traffic_s"))
                part_coords = (((part.get("geometry") or {}) if isinstance(part.get("geometry"), dict) else {}).get("coordinates") or [])
                if isinstance(part_coords, list) and part_coords:
                    if merged_coords and part_coords[0] == merged_coords[-1]:
                        merged_coords.extend(part_coords[1:])
                    else:
                        merged_coords.extend(part_coords)

            geometry = {"type": "LineString", "coordinates": merged_coords} if len(merged_coords) > 1 else None
            delay_s = max(0.0, float(total_duration) - float(total_duration_no_traffic))
            return {
                "geometry": geometry,
                "distance_m": float(total_distance),
                "duration_s": float(total_duration),
                "duration_no_traffic_s": float(total_duration_no_traffic),
                "delay_s": float(delay_s),
                "provider": "google_traffic",
            }
    except Exception:
        return None

@app.post("/login", response_model=schemas.Token)
async def login(form_data: OAuth2PasswordRequestForm = Depends(), db: Session = Depends(database.get_db)):
    username_in = str(form_data.username or "").strip()
    driver = db.query(models.Driver).filter(models.Driver.username == username_in).first()
    if not driver:
        # Recipient convenience login: allow using phone number in various formats.
        phone_norm = phone_service.normalize_phone(username_in)
        if phone_norm:
            driver = (
                db.query(models.Driver)
                .filter(models.Driver.role == authz.ROLE_RECIPIENT, models.Driver.phone_norm == phone_norm)
                .first()
            )
    if not driver or not driver_manager.verify_password(form_data.password, driver.password_hash):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Incorrect username or password",
            headers={"WWW-Authenticate": "Bearer"},
        )
    if not driver.active:
        raise HTTPException(status_code=403, detail="Account is inactive")

    # Normalize role (accept aliases like "Curier", "Depozit", etc.)
    driver.role = authz.normalize_role(driver.role)
    
    access_token = create_access_token(data={
        "sub": driver.username, 
        "driver_id": driver.driver_id,
        "role": driver.role
    })
    # Best-effort audit update; login should still work if DB commit is temporarily unavailable.
    try:
        driver.last_login = datetime.utcnow()
        db.commit()
    except Exception as e:
        db.rollback()
        logger.warning("Failed to persist last_login for %s: %s", str(driver.username or ""), str(e))
    return {"access_token": access_token, "token_type": "bearer", "role": driver.role}


def _find_shipment_by_awb(db: Session, awb: str) -> Optional[models.Shipment]:
    candidates = postis_client.candidates_with_optional_parcel_suffix_stripped(awb)
    for cand in candidates:
        ship = db.query(models.Shipment).filter(models.Shipment.awb == cand).first()
        if ship:
            return ship
    return None


def _resolve_user_phone_norm(db: Session, current_driver: models.Driver) -> str:
    """
    Resolve recipient phone in a robust way.

    Some legacy recipient users were created with username=phone but no phone_number,
    so we must also fallback to username normalization.
    """
    phone_norm = (
        str(current_driver.phone_norm or "").strip()
        or phone_service.normalize_phone(current_driver.phone_number or "")
        or phone_service.normalize_phone(current_driver.username or "")
    )
    if phone_norm and current_driver.phone_norm != phone_norm:
        current_driver.phone_norm = phone_norm
        db.commit()
    return phone_norm


def _ensure_admin_notes_schema(db: Session) -> bool:
    try:
        models.AdminNote.__table__.create(bind=db.get_bind(), checkfirst=True)
        return True
    except Exception:
        return False


def _normalized_unique_awbs(values: Optional[List[str]]) -> List[str]:
    out: List[str] = []
    seen: Set[str] = set()
    for raw in values or []:
        v = postis_client.normalize_shipment_identifier(raw) or str(raw or "").strip().upper()
        v = str(v or "").strip().upper()
        if not v or v in seen:
            continue
        seen.add(v)
        out.append(v)
    return out


def _unique_driver_id(db: Session, base: str) -> str:
    """Generate a unique drivers.driver_id based on a preferred base value."""
    candidate = str(base or "").strip()
    if not candidate:
        candidate = "R" + secrets.token_hex(4).upper()

    existing = db.query(models.Driver).filter(models.Driver.driver_id == candidate).first()
    if not existing:
        return candidate

    for _ in range(20):
        alt = f"{candidate}-{secrets.token_hex(2).upper()}"
        if not db.query(models.Driver).filter(models.Driver.driver_id == alt).first():
            return alt

    # Last resort: random.
    return "R" + secrets.token_hex(8).upper()


def _clean_positive_float(field: str, value: Optional[float]) -> Optional[float]:
    if value is None:
        return None
    try:
        num = float(value)
    except Exception:
        raise HTTPException(status_code=400, detail=f"{field} must be a number")
    if num <= 0:
        raise HTTPException(status_code=400, detail=f"{field} must be > 0")
    return num


def _normalize_vehicle_type_or_raise(raw_value: Optional[str]) -> Optional[str]:
    raw = str(raw_value or "").strip()
    if not raw:
        return None
    code = vehicle_types_service.normalize_vehicle_type_code(raw)
    if not code:
        valid = [str(v.get("code") or "") for v in vehicle_types_service.list_vehicle_types() if v.get("code")]
        raise HTTPException(status_code=400, detail=f"Invalid vehicle_type_code. Valid values: {', '.join(valid)}")
    return code


def _validate_vehicle_capacity_pair(*, max_value: Optional[float], target_value: Optional[float], max_field: str, target_field: str) -> None:
    if max_value is None or target_value is None:
        return
    if target_value > max_value:
        raise HTTPException(status_code=400, detail=f"{target_field} cannot be greater than {max_field}")


def _schema_dump_exclude_unset(obj: Any) -> Dict[str, Any]:
    try:
        return obj.model_dump(exclude_unset=True)  # pydantic v2
    except Exception:
        try:
            return obj.dict(exclude_unset=True)  # pydantic v1 fallback
        except Exception:
            return {}


def _fleet_clean_str(value: Any) -> Optional[str]:
    s = str(value or "").strip()
    return s or None


def _fleet_clean_plate(value: Any) -> Optional[str]:
    s = str(value or "").strip().upper()
    return s or None


def _fleet_clean_non_negative_float(field: str, value: Optional[float]) -> Optional[float]:
    if value is None:
        return None
    try:
        num = float(value)
    except Exception:
        raise HTTPException(status_code=400, detail=f"{field} must be a number")
    if num < 0:
        raise HTTPException(status_code=400, detail=f"{field} must be >= 0")
    return num


def _fleet_resolve_driver_id_or_raise(db: Session, raw_driver_id: Any) -> Optional[str]:
    cleaned = _fleet_clean_str(raw_driver_id)
    if not cleaned:
        return None

    exact = db.query(models.Driver).filter(models.Driver.driver_id == cleaned).first()
    if exact:
        return str(getattr(exact, "driver_id", "") or "").strip() or None

    ci = (
        db.query(models.Driver)
        .filter(func.upper(models.Driver.driver_id) == str(cleaned).upper())
        .first()
    )
    if ci:
        return str(getattr(ci, "driver_id", "") or "").strip() or None

    raise HTTPException(status_code=400, detail=f"assigned_driver_id '{cleaned}' was not found in users")


@app.post("/recipient/signup", response_model=schemas.Token)
async def recipient_signup(request: schemas.RecipientSignupRequest, db: Session = Depends(database.get_db)):
    """
    Recipient self-signup: validates the recipient owns the AWB (by phone match),
    then creates/updates a Recipient account and returns a JWT.
    """
    drivers_service.ensure_drivers_schema(db)
    shipments_service.ensure_shipments_schema(db)

    awb = postis_client.normalize_shipment_identifier(request.awb)
    if not awb:
        raise HTTPException(status_code=400, detail="awb is required")

    phone_norm = phone_service.normalize_phone(request.phone)
    if not phone_norm:
        raise HTTPException(status_code=400, detail="phone is required")

    ship = _find_shipment_by_awb(db, awb)
    if not ship:
        # Best-effort: if the DB hasn't been synced yet, try to pull from Postis.
        try:
            data = await p_client.get_shipment_tracking_by_awb_or_client_order_id(awb)
            if data:
                ship = shipments_service.upsert_shipment_and_events(db, data)
                db.commit()
        except Exception:
            ship = None
    if not ship:
        raise HTTPException(status_code=404, detail="Shipment not found")

    ship_phone_norm = ship.recipient_phone_norm or phone_service.normalize_phone(ship.recipient_phone or "")
    if not ship_phone_norm or ship_phone_norm != phone_norm:
        raise HTTPException(status_code=403, detail="Phone number does not match the shipment recipient")

    username = phone_norm
    existing = (
        db.query(models.Driver)
        .filter(models.Driver.role == authz.ROLE_RECIPIENT, models.Driver.phone_norm == phone_norm)
        .first()
    )
    if not existing:
        existing = db.query(models.Driver).filter(models.Driver.username == username).first()
    if existing and authz.normalize_role(existing.role) != authz.ROLE_RECIPIENT:
        raise HTTPException(status_code=409, detail="An account already exists for this username")

    if existing:
        user = existing
        user.role = authz.ROLE_RECIPIENT
        user.active = True
        user.password_hash = driver_manager.get_password_hash(request.password)
        user.phone_number = user.phone_number or request.phone or ship.recipient_phone
        user.phone_norm = phone_norm
        if request.name:
            user.name = request.name
        elif ship.recipient_name and (not user.name or user.name.strip().lower() in ("recipient", "customer", "client")):
            user.name = ship.recipient_name
    else:
        user = models.Driver(
            driver_id=_unique_driver_id(db, f"R{phone_norm}"),
            name=(request.name or ship.recipient_name or "Recipient"),
            username=username,
            password_hash=driver_manager.get_password_hash(request.password),
            role=authz.ROLE_RECIPIENT,
            active=True,
            phone_number=request.phone or ship.recipient_phone,
            phone_norm=phone_norm,
        )
        db.add(user)

    user.last_login = datetime.utcnow()
    db.commit()

    access_token = create_access_token(
        data={
            "sub": user.username,
            "driver_id": user.driver_id,
            "role": authz.normalize_role(user.role),
        }
    )
    return {"access_token": access_token, "token_type": "bearer", "role": authz.normalize_role(user.role)}

@app.get("/health")
async def health():
    return {
        "ok": True,
        "time": datetime.utcnow().isoformat() + "Z",
        "postis_base_url": POSTIS_BASE_URL,
        "postis_configured": bool(POSTIS_USER and POSTIS_PASS),
    }

@app.get("/ro/counties", response_model=List[str])
async def ro_counties(
    refresh: bool = False,
    current_driver: models.Driver = Depends(get_current_driver),
):
    payload = await ro_localities_service.get_ro_localities(force_refresh=refresh)
    return ro_localities_service.list_counties(payload)


@app.get("/ro/cities", response_model=List[str])
async def ro_cities(
    county: str = None,
    q: str = None,
    refresh: bool = False,
    current_driver: models.Driver = Depends(get_current_driver),
):
    payload = await ro_localities_service.get_ro_localities(force_refresh=refresh)
    cities = ro_localities_service.list_cities(payload, county=county)
    return ro_localities_service.filter_names(cities, q=q, limit=500)


@app.get("/ro/localities")
async def ro_localities(
    county: str = None,
    q: str = None,
    refresh: bool = False,
    current_driver: models.Driver = Depends(get_current_driver),
):
    payload = await ro_localities_service.get_ro_localities(force_refresh=refresh)
    if not county and not q:
        return payload

    # Filter counties/cities server-side to keep payload smaller when used for autocomplete.
    counties = payload.get("counties") or []
    out = {k: v for k, v in payload.items() if k != "counties"}
    out_counties = []
    needle = str(q).strip().casefold() if q else ""
    county_match = str(county).strip().casefold() if county else ""

    for c in counties:
        if not isinstance(c, dict):
            continue
        name = str(c.get("name") or "").strip()
        if county_match and name.casefold() != county_match:
            continue
        cities = c.get("cities") or []
        if needle:
            cities = [city for city in cities if needle in str((city or {}).get("name") if isinstance(city, dict) else city).casefold()]
        out_counties.append({"name": name, "cities": cities[:500]})

    out["counties"] = out_counties
    return out

@app.get("/me", response_model=schemas.MeSchema)
async def get_me(current_driver: models.Driver = Depends(get_current_driver)):
    role = authz.normalize_role(current_driver.role)
    return {
        "driver_id": current_driver.driver_id,
        "name": current_driver.name,
        "username": current_driver.username,
        "role": role,
        "active": current_driver.active,
        # These are stored on the driver record today, but conceptually represent the
        # allocated truck (plate + phone attached to the truck).
        "truck_plate": current_driver.truck_plate,
        "truck_phone": current_driver.phone_number,
        "helper_name": current_driver.helper_name,
        "vehicle_type_code": current_driver.vehicle_type_code,
        "vehicle_has_lift": current_driver.vehicle_has_lift,
        "max_volume_m3": current_driver.max_volume_m3,
        "target_volume_m3": current_driver.target_volume_m3,
        "max_weight_kg": current_driver.max_weight_kg,
        "target_weight_kg": current_driver.target_weight_kg,
        "last_login": current_driver.last_login,
        "permissions": _permissions_for_role(role),
    }

@app.get("/notifications", response_model=List[schemas.NotificationSchema])
async def list_notifications(
    limit: int = 50,
    unread_only: bool = False,
    db: Session = Depends(database.get_db),
    current_driver: models.Driver = Depends(permission_required(authz.PERM_NOTIFICATIONS_READ)),
):
    if not notifications_service.ensure_notifications_schema(db):
        return []
    try:
        limit_n = int(limit or 50)
    except Exception:
        limit_n = 50
    limit_n = max(1, min(limit_n, 200))

    q = db.query(models.Notification).filter(models.Notification.user_id == current_driver.driver_id)
    if unread_only:
        q = q.filter(models.Notification.read_at.is_(None))

    return q.order_by(models.Notification.created_at.desc()).limit(limit_n).all()


@app.post("/notifications/{notification_id}/read", response_model=schemas.NotificationSchema)
async def mark_notification_read(
    notification_id: int,
    db: Session = Depends(database.get_db),
    current_driver: models.Driver = Depends(permission_required(authz.PERM_NOTIFICATIONS_READ)),
):
    if not notifications_service.ensure_notifications_schema(db):
        raise HTTPException(status_code=503, detail="Notifications unavailable")
    notif = db.query(models.Notification).filter(models.Notification.id == notification_id).first()
    if not notif or notif.user_id != current_driver.driver_id:
        # Avoid leaking IDs across users.
        raise HTTPException(status_code=404, detail="Notification not found")

    if notif.read_at is None:
        notif.read_at = datetime.utcnow()
        db.commit()
        db.refresh(notif)

    return notif


# [NEW] Admin improvement notes (home-screen backlog capture)
@app.get("/admin/notes", response_model=List[schemas.AdminNoteSchema])
async def list_admin_notes(
    limit: int = 100,
    db: Session = Depends(database.get_db),
    current_driver: models.Driver = Depends(permission_required(authz.PERM_USERS_WRITE)),
):
    role = authz.normalize_role(current_driver.role)
    if role != authz.ROLE_ADMIN:
        raise HTTPException(status_code=403, detail="Only admins can read improvement notes")
    if not _ensure_admin_notes_schema(db):
        return []
    try:
        limit_n = int(limit or 100)
    except Exception:
        limit_n = 100
    limit_n = max(1, min(limit_n, 300))

    return (
        db.query(models.AdminNote)
        .order_by(models.AdminNote.created_at.desc(), models.AdminNote.id.desc())
        .limit(limit_n)
        .all()
    )


@app.post("/admin/notes", response_model=schemas.AdminNoteSchema, status_code=201)
async def create_admin_note(
    request: schemas.AdminNoteCreate,
    db: Session = Depends(database.get_db),
    current_driver: models.Driver = Depends(permission_required(authz.PERM_USERS_WRITE)),
):
    role = authz.normalize_role(current_driver.role)
    if role != authz.ROLE_ADMIN:
        raise HTTPException(status_code=403, detail="Only admins can create improvement notes")
    if not _ensure_admin_notes_schema(db):
        raise HTTPException(status_code=503, detail="Notes unavailable")

    text = str(request.text or "").strip()
    if not text:
        raise HTTPException(status_code=400, detail="text is required")

    note = models.AdminNote(
        created_at=datetime.utcnow(),
        created_by_user_id=current_driver.driver_id,
        created_by_name=(str(current_driver.name or current_driver.username or "").strip() or None),
        text=text[:4000],
    )
    db.add(note)
    db.commit()
    db.refresh(note)
    return note


# [NEW] Contact attempts (call / WhatsApp / SMS outcomes)
@app.post("/contacts/attempts", response_model=schemas.ContactAttemptSchema, status_code=201)
async def create_contact_attempt(
    request: schemas.ContactAttemptCreate,
    db: Session = Depends(database.get_db),
    current_driver: models.Driver = Depends(permission_required(authz.PERM_CONTACTS_WRITE)),
):
    contacts_service.ensure_contacts_schema(db)
    attempt = contacts_service.log_contact_attempt(
        db,
        created_by_user_id=current_driver.driver_id,
        created_by_role=authz.normalize_role(current_driver.role),
        awb=request.awb,
        channel=request.channel,
        to_phone=request.to_phone,
        outcome=request.outcome,
        notes=request.notes,
        data=request.data if isinstance(request.data, dict) else None,
    )
    if not attempt:
        raise HTTPException(status_code=503, detail="Contacts logging unavailable")

    db.commit()
    db.refresh(attempt)
    return attempt


# [NEW] In-app Chat
def _chat_thread_authorized(db: Session, *, current_driver: models.Driver, thread: models.ChatThread) -> bool:
    """
    Authorization for shipment-linked threads.

    - Recipient: must own the AWB (phone match).
    - Driver: must be the allocated driver for the AWB.
    - Internal roles: allowed.
    """
    role = authz.normalize_role(current_driver.role)
    awb = str(getattr(thread, "awb", "") or "").strip().upper() or None
    if not awb:
        part = (
            db.query(models.ChatParticipant)
            .filter(models.ChatParticipant.thread_id == thread.id, models.ChatParticipant.user_id == current_driver.driver_id)
            .first()
        )
        return bool(part)

    shipments_service.ensure_shipments_schema(db)
    ship = _find_shipment_by_awb(db, awb)
    if not ship:
        # Internal roles can still see the thread even if the shipment row is missing.
        return role != authz.ROLE_RECIPIENT and role != authz.ROLE_DRIVER

    if role == authz.ROLE_RECIPIENT:
        return _shipment_recipient_authorized(db, current_driver=current_driver, ship=ship)
    if role == authz.ROLE_DRIVER:
        return str(ship.driver_id or "").strip().upper() == str(current_driver.driver_id or "").strip().upper()
    return True


def _chat_preview(msg: Optional[models.ChatMessage]) -> str:
    if not msg:
        return ""
    mtype = str(getattr(msg, "message_type", "") or "").strip().lower()
    if mtype == "location":
        return "Location pin"
    if mtype == "system":
        return str(getattr(msg, "text", "") or "").strip()
    return str(getattr(msg, "text", "") or "").strip()


@app.get("/chat/threads", response_model=List[schemas.ChatThreadSchema])
async def list_chat_threads(
    limit: int = 50,
    awb: Optional[str] = None,
    db: Session = Depends(database.get_db),
    current_driver: models.Driver = Depends(permission_required(authz.PERM_CHAT_READ)),
):
    if not chat_service.ensure_chat_schema(db):
        return []

    try:
        limit_n = int(limit or 50)
    except Exception:
        limit_n = 50
    limit_n = max(1, min(limit_n, 200))

    role = authz.normalize_role(current_driver.role)
    awb_key = postis_client.normalize_shipment_identifier(awb) if awb else None
    awb_key = (str(awb_key or "").strip().upper() or None)

    q = db.query(models.ChatThread)
    if awb_key:
        q = q.filter(models.ChatThread.awb == awb_key)

    added_participant = False

    # Recipients see threads where they are participant OR where AWB belongs to their phone.
    if role == authz.ROLE_RECIPIENT:
        shipments_service.ensure_shipments_schema(db)
        phone_norm = _resolve_user_phone_norm(db, current_driver)

        participant_ids = [
            int(row[0])
            for row in (
                db.query(models.ChatParticipant.thread_id)
                .filter(models.ChatParticipant.user_id == current_driver.driver_id)
                .all()
            )
            if row and row[0] is not None
        ]

        recipient_awbs = []
        if phone_norm:
            recipient_awbs = [
                str(row[0]).strip().upper()
                for row in (
                    db.query(models.Shipment.awb)
                    .filter(models.Shipment.recipient_phone_norm == phone_norm)
                    .all()
                )
                if row and row[0]
            ]

        conditions = []
        if participant_ids:
            conditions.append(models.ChatThread.id.in_(participant_ids))
        if recipient_awbs:
            conditions.append(models.ChatThread.awb.in_(recipient_awbs))

        if conditions:
            q = q.filter(or_(*conditions))
        else:
            q = q.filter(false())

    # Drivers see only threads they participate in.
    if role == authz.ROLE_DRIVER:
        q = (
            q.join(models.ChatParticipant, models.ChatParticipant.thread_id == models.ChatThread.id)
            .filter(models.ChatParticipant.user_id == current_driver.driver_id)
        )

    threads = (
        q.order_by(models.ChatThread.last_message_at.desc(), models.ChatThread.created_at.desc())
        .limit(limit_n)
        .all()
    )

    out = []
    for t in threads:
        # Auto-enroll recipient/driver participants so unread counters and notifications remain consistent.
        part = chat_service.ensure_participant(db, thread_id=t.id, user_id=current_driver.driver_id, role=role)
        if part and part.id is None:
            added_participant = True

        last_msg = (
            db.query(models.ChatMessage)
            .filter(models.ChatMessage.thread_id == t.id)
            .order_by(models.ChatMessage.id.desc())
            .first()
        )
        last_read = int(part.last_read_message_id or 0) if part else 0
        unread = 0
        if part:
            unread = (
                db.query(models.ChatMessage)
                .filter(models.ChatMessage.thread_id == t.id)
                .filter(models.ChatMessage.id > last_read)
                .filter(models.ChatMessage.sender_user_id != current_driver.driver_id)
                .count()
            )

        out.append(
            {
                "id": t.id,
                "created_at": t.created_at,
                "awb": t.awb,
                "subject": t.subject,
                "last_message_at": t.last_message_at,
                "last_message_preview": _chat_preview(last_msg),
                "unread_count": int(unread or 0),
            }
        )
    if added_participant:
        db.commit()
    return out


@app.post("/chat/threads", response_model=schemas.ChatThreadSchema, status_code=201)
async def ensure_chat_thread(
    request: schemas.ChatThreadCreate,
    db: Session = Depends(database.get_db),
    current_driver: models.Driver = Depends(permission_required(authz.PERM_CHAT_WRITE)),
):
    if not chat_service.ensure_chat_schema(db):
        raise HTTPException(status_code=503, detail="Chat unavailable")

    drivers_service.ensure_drivers_schema(db)
    shipments_service.ensure_shipments_schema(db)

    role = authz.normalize_role(current_driver.role)
    awb_key = postis_client.normalize_shipment_identifier(request.awb) or request.awb
    awb_key = str(awb_key or "").strip().upper()
    if not awb_key:
        raise HTTPException(status_code=400, detail="awb is required")

    ship = _find_shipment_by_awb(db, awb_key)
    if not ship:
        raise HTTPException(status_code=404, detail="Shipment not found")

    # Role-based access to the shipment thread.
    if role == authz.ROLE_RECIPIENT and not _shipment_recipient_authorized(db, current_driver=current_driver, ship=ship):
        raise HTTPException(status_code=403, detail="Not authorized for this AWB")
    if role == authz.ROLE_DRIVER and str(ship.driver_id or "").strip().upper() != str(current_driver.driver_id or "").strip().upper():
        raise HTTPException(status_code=403, detail="Not authorized for this AWB")

    thread = chat_service.get_or_create_awb_thread(
        db,
        awb=awb_key,
        created_by_user_id=current_driver.driver_id,
        created_by_role=role,
    )
    if not thread:
        raise HTTPException(status_code=503, detail="Chat unavailable")

    # Always include the creator.
    chat_service.ensure_participant(db, thread_id=thread.id, user_id=current_driver.driver_id, role=role)

    # Recipient participant (if an account exists).
    phone_norm = ship.recipient_phone_norm or phone_service.normalize_phone(ship.recipient_phone or "")
    if phone_norm:
        rec_user = (
            db.query(models.Driver)
            .filter(models.Driver.role == authz.ROLE_RECIPIENT, models.Driver.phone_norm == phone_norm)
            .first()
        )
        if rec_user:
            chat_service.ensure_participant(db, thread_id=thread.id, user_id=rec_user.driver_id, role=authz.ROLE_RECIPIENT)

    # Allocated driver participant (if any).
    target_driver_id = str(ship.driver_id or "").strip().upper() or None
    if target_driver_id:
        target = db.query(models.Driver).filter(models.Driver.driver_id == target_driver_id).first()
        if target:
            chat_service.ensure_participant(db, thread_id=thread.id, user_id=target.driver_id, role=authz.normalize_role(target.role))

    db.commit()
    db.refresh(thread)

    return {
        "id": thread.id,
        "created_at": thread.created_at,
        "awb": thread.awb,
        "subject": thread.subject,
        "last_message_at": thread.last_message_at,
        "last_message_preview": "",
        "unread_count": 0,
    }


@app.get("/chat/threads/{thread_id}", response_model=schemas.ChatThreadSchema)
async def get_chat_thread(
    thread_id: int,
    db: Session = Depends(database.get_db),
    current_driver: models.Driver = Depends(permission_required(authz.PERM_CHAT_READ)),
):
    if not chat_service.ensure_chat_schema(db):
        raise HTTPException(status_code=503, detail="Chat unavailable")

    thread = db.query(models.ChatThread).filter(models.ChatThread.id == int(thread_id)).first()
    if not thread:
        raise HTTPException(status_code=404, detail="Thread not found")

    if not _chat_thread_authorized(db, current_driver=current_driver, thread=thread):
        raise HTTPException(status_code=403, detail="Not authorized")

    role = authz.normalize_role(current_driver.role)
    chat_service.ensure_participant(db, thread_id=thread.id, user_id=current_driver.driver_id, role=role)
    db.commit()

    last_msg = (
        db.query(models.ChatMessage)
        .filter(models.ChatMessage.thread_id == thread.id)
        .order_by(models.ChatMessage.id.desc())
        .first()
    )
    part = (
        db.query(models.ChatParticipant)
        .filter(models.ChatParticipant.thread_id == thread.id, models.ChatParticipant.user_id == current_driver.driver_id)
        .first()
    )
    last_read = int(part.last_read_message_id or 0) if part else 0
    unread = (
        db.query(models.ChatMessage)
        .filter(models.ChatMessage.thread_id == thread.id)
        .filter(models.ChatMessage.id > last_read)
        .filter(models.ChatMessage.sender_user_id != current_driver.driver_id)
        .count()
    ) if part else 0

    return {
        "id": thread.id,
        "created_at": thread.created_at,
        "awb": thread.awb,
        "subject": thread.subject,
        "last_message_at": thread.last_message_at,
        "last_message_preview": _chat_preview(last_msg),
        "unread_count": int(unread or 0),
    }


@app.get("/chat/threads/{thread_id}/messages", response_model=List[schemas.ChatMessageSchema])
async def list_chat_messages(
    thread_id: int,
    limit: int = 50,
    before_id: Optional[int] = None,
    db: Session = Depends(database.get_db),
    current_driver: models.Driver = Depends(permission_required(authz.PERM_CHAT_READ)),
):
    if not chat_service.ensure_chat_schema(db):
        return []

    thread = db.query(models.ChatThread).filter(models.ChatThread.id == int(thread_id)).first()
    if not thread:
        raise HTTPException(status_code=404, detail="Thread not found")

    if not _chat_thread_authorized(db, current_driver=current_driver, thread=thread):
        raise HTTPException(status_code=403, detail="Not authorized")

    role = authz.normalize_role(current_driver.role)
    # Auto-enroll authorized users so they receive notifications/unread counts.
    chat_service.ensure_participant(db, thread_id=thread.id, user_id=current_driver.driver_id, role=role)
    db.commit()

    try:
        limit_n = int(limit or 50)
    except Exception:
        limit_n = 50
    limit_n = max(1, min(limit_n, 200))

    q = db.query(models.ChatMessage).filter(models.ChatMessage.thread_id == thread.id)
    if before_id is not None:
        try:
            q = q.filter(models.ChatMessage.id < int(before_id))
        except Exception:
            pass

    items = q.order_by(models.ChatMessage.id.desc()).limit(limit_n).all()
    items = list(reversed(items))

    sender_ids = sorted(
        {
            str(m.sender_user_id or "").strip().upper()
            for m in items
            if str(m.sender_user_id or "").strip()
        }
    )
    sender_name_by_id: Dict[str, str] = {}
    if sender_ids:
        rows = (
            db.query(models.Driver.driver_id, models.Driver.name, models.Driver.username)
            .filter(models.Driver.driver_id.in_(sender_ids))
            .all()
        )
        for driver_id, name, username in rows:
            key = str(driver_id or "").strip().upper()
            if not key:
                continue
            display = str(name or "").strip() or str(username or "").strip()
            if display:
                sender_name_by_id[key] = display

    out: List[Dict[str, object]] = []
    for m in items:
        sender_id = str(m.sender_user_id or "").strip().upper()
        out.append(
            {
                "id": m.id,
                "thread_id": m.thread_id,
                "created_at": m.created_at,
                "sender_user_id": sender_id,
                "sender_role": m.sender_role,
                "sender_name": sender_name_by_id.get(sender_id),
                "message_type": m.message_type,
                "text": m.text,
                "data": m.data,
            }
        )
    return out


@app.post("/chat/threads/{thread_id}/messages", response_model=schemas.ChatMessageSchema, status_code=201)
async def send_chat_message(
    thread_id: int,
    request: schemas.ChatMessageCreate,
    db: Session = Depends(database.get_db),
    current_driver: models.Driver = Depends(permission_required(authz.PERM_CHAT_WRITE)),
):
    if not chat_service.ensure_chat_schema(db):
        raise HTTPException(status_code=503, detail="Chat unavailable")

    drivers_service.ensure_drivers_schema(db)
    shipments_service.ensure_shipments_schema(db)
    notifications_service.ensure_notifications_schema(db)

    thread = db.query(models.ChatThread).filter(models.ChatThread.id == int(thread_id)).first()
    if not thread:
        raise HTTPException(status_code=404, detail="Thread not found")

    if not _chat_thread_authorized(db, current_driver=current_driver, thread=thread):
        raise HTTPException(status_code=403, detail="Not authorized")

    role = authz.normalize_role(current_driver.role)
    chat_service.ensure_participant(db, thread_id=thread.id, user_id=current_driver.driver_id, role=role)

    mtype = str(request.message_type or "text").strip().lower()
    if mtype not in ("text", "location", "system"):
        raise HTTPException(status_code=400, detail="Invalid message_type")

    text = str(request.text or "").strip() or None
    data = request.data if isinstance(request.data, (dict, list)) else request.data

    if mtype == "text" and not text:
        raise HTTPException(status_code=400, detail="text is required")
    if mtype == "location":
        if not isinstance(data, dict):
            raise HTTPException(status_code=400, detail="data is required for location messages")
        lat_raw = data.get("latitude") if data.get("latitude") is not None else data.get("lat")
        lon_raw = data.get("longitude") if data.get("longitude") is not None else (data.get("lon") if data.get("lon") is not None else data.get("lng"))
        try:
            lat = float(lat_raw)
            lon = float(lon_raw)
        except Exception:
            raise HTTPException(status_code=400, detail="Invalid latitude/longitude")
        if not (-90 <= lat <= 90 and -180 <= lon <= 180):
            raise HTTPException(status_code=400, detail="Invalid latitude/longitude")

    now = datetime.utcnow()
    msg = models.ChatMessage(
        thread_id=thread.id,
        created_at=now,
        sender_user_id=current_driver.driver_id,
        sender_role=role,
        message_type=mtype,
        text=text,
        data=data if data is not None else None,
    )
    db.add(msg)
    db.flush()

    # Update thread activity.
    thread.last_message_at = now

    # If the recipient sends a location pin, persist it onto the shipment.
    if mtype == "location" and thread.awb and role == authz.ROLE_RECIPIENT and isinstance(data, dict):
        ship = _find_shipment_by_awb(db, thread.awb)
        if ship and _shipment_recipient_authorized(db, current_driver=current_driver, ship=ship):
            lat_raw = data.get("latitude") if data.get("latitude") is not None else data.get("lat")
            lon_raw = data.get("longitude") if data.get("longitude") is not None else (data.get("lon") if data.get("lon") is not None else data.get("lng"))
            try:
                lat = float(lat_raw)
                lon = float(lon_raw)
            except Exception:
                lat = None
                lon = None
            if lat is not None and lon is not None and (-90 <= lat <= 90) and (-180 <= lon <= 180):
                pin = {
                    "latitude": lat,
                    "longitude": lon,
                    "accuracy_m": data.get("accuracy_m") if isinstance(data.get("accuracy_m"), (int, float)) else data.get("accuracy"),
                    "source": str(data.get("source") or "gps").strip() or "gps",
                    "address": str(data.get("address") or "").strip() or None,
                    "note": str(data.get("note") or "").strip() or None,
                    "updated_at": now.isoformat() + "Z",
                    "updated_by": current_driver.driver_id,
                    "thread_id": thread.id,
                    "message_id": msg.id,
                }
                ship.recipient_pin = pin
                ship.last_updated = now

    # Notify other participants.
    participants = (
        db.query(models.ChatParticipant)
        .filter(models.ChatParticipant.thread_id == thread.id)
        .all()
    )
    preview = _chat_preview(msg) or "New message"
    for p in participants:
        if str(p.user_id) == str(current_driver.driver_id):
            continue
        notifications_service.create_notification(
            db,
            user_id=p.user_id,
            title=f"Chat: {thread.awb or 'Thread'}",
            body=preview[:200],
            awb=thread.awb,
            data={
                "type": "chat_message",
                "thread_id": thread.id,
                "message_id": msg.id,
                "awb": thread.awb,
                "from_user_id": current_driver.driver_id,
                "from_role": role,
                "message_type": mtype,
            },
        )

    db.commit()
    db.refresh(msg)
    return msg


@app.post("/chat/threads/{thread_id}/read")
async def mark_chat_read(
    thread_id: int,
    request: schemas.ChatReadRequest,
    db: Session = Depends(database.get_db),
    current_driver: models.Driver = Depends(permission_required(authz.PERM_CHAT_READ)),
):
    if not chat_service.ensure_chat_schema(db):
        raise HTTPException(status_code=503, detail="Chat unavailable")

    thread = db.query(models.ChatThread).filter(models.ChatThread.id == int(thread_id)).first()
    if not thread:
        raise HTTPException(status_code=404, detail="Thread not found")

    if not _chat_thread_authorized(db, current_driver=current_driver, thread=thread):
        raise HTTPException(status_code=403, detail="Not authorized")

    role = authz.normalize_role(current_driver.role)
    part = chat_service.ensure_participant(db, thread_id=thread.id, user_id=current_driver.driver_id, role=role)
    if not part:
        raise HTTPException(status_code=503, detail="Chat unavailable")

    last_id = request.last_read_message_id
    if last_id is None:
        last = (
            db.query(models.ChatMessage)
            .filter(models.ChatMessage.thread_id == thread.id)
            .order_by(models.ChatMessage.id.desc())
            .first()
        )
        last_id = last.id if last else 0

    try:
        last_id_int = int(last_id or 0)
    except Exception:
        last_id_int = 0

    prev = int(part.last_read_message_id or 0)
    if last_id_int > prev:
        part.last_read_message_id = last_id_int
        db.commit()

    return {"ok": True, "thread_id": thread.id, "last_read_message_id": int(part.last_read_message_id or 0)}


_TRACKING_REQUESTER_ROLES = {
    authz.ROLE_ADMIN,
    authz.ROLE_MANAGER,
    authz.ROLE_DISPATCHER,
    authz.ROLE_SUPPORT,
}


def _clamp_int(value: Optional[int], *, default: int, min_v: int, max_v: int) -> int:
    try:
        n = int(value) if value is not None else int(default)
    except Exception:
        n = int(default)
    return max(int(min_v), min(int(max_v), n))


def _shipment_recipient_authorized(db: Session, *, current_driver: models.Driver, ship: models.Shipment) -> bool:
    """
    Reuse the same phone-normalization logic as the shipment read endpoints.
    """
    phone_norm = _resolve_user_phone_norm(db, current_driver)
    ship_phone_norm = ship.recipient_phone_norm or phone_service.normalize_phone(ship.recipient_phone or "")
    if ship.recipient_phone_norm != ship_phone_norm:
        ship.recipient_phone_norm = ship_phone_norm
        db.commit()
    if not phone_norm or not ship_phone_norm:
        return False
    return ship_phone_norm == phone_norm


def _tracking_authorized(db: Session, *, current_driver: models.Driver, req: models.TrackingRequest) -> bool:
    if not req:
        return False
    if req.created_by_user_id == current_driver.driver_id:
        return True
    if req.target_driver_id == current_driver.driver_id:
        return True
    if req.awb and authz.normalize_role(current_driver.role) == authz.ROLE_RECIPIENT:
        shipments_service.ensure_shipments_schema(db)
        ship = _find_shipment_by_awb(db, req.awb)
        if ship and _shipment_recipient_authorized(db, current_driver=current_driver, ship=ship):
            return True
    return False


def _auto_activate_tracking_request(
    db: Session,
    req: Optional[models.TrackingRequest],
    *,
    now: Optional[datetime] = None,
    extend_expired: bool = True,
) -> bool:
    """
    Enforce company policy: tracking requests do not require driver confirmation.

    Legacy rows may still be Pending; auto-promote them to Accepted when seen.
    Returns True when the row changed.
    """
    if not req:
        return False
    if str(getattr(req, "status", "") or "").strip().lower() != "pending":
        return False

    now_dt = now or datetime.utcnow()
    duration = _clamp_int(getattr(req, "duration_sec", None), default=900, min_v=60, max_v=6 * 60 * 60)

    req.status = "Accepted"
    req.accepted_at = now_dt
    if extend_expired and (req.expires_at is None or req.expires_at <= now_dt):
        req.expires_at = now_dt + timedelta(seconds=duration)
    return True


@app.post("/tracking/requests", response_model=schemas.TrackingRequestSchema, status_code=201)
async def create_tracking_request(
    request: schemas.TrackingRequestCreate,
    db: Session = Depends(database.get_db),
    current_driver: models.Driver = Depends(get_current_driver),
):
    """
    Create a tracking request.

    - Admin/Manager/Dispatcher/Support can request tracking for a driver OR an AWB.
    - Recipients can request tracking only for their own AWB (phone match).
    """
    if not tracking_service.ensure_tracking_schema(db):
        raise HTTPException(status_code=503, detail="Tracking unavailable")

    drivers_service.ensure_drivers_schema(db)
    shipments_service.ensure_shipments_schema(db)
    notifications_service.ensure_notifications_schema(db)

    role = authz.normalize_role(current_driver.role)
    duration_sec = _clamp_int(request.duration_sec, default=900, min_v=60, max_v=6 * 60 * 60)

    awb = (str(request.awb or "").strip().upper() or None)
    driver_id_in = (str(request.driver_id or "").strip().upper() or None)

    if awb and driver_id_in:
        raise HTTPException(status_code=400, detail="Provide only one: awb or driver_id")
    if not awb and not driver_id_in:
        raise HTTPException(status_code=400, detail="awb or driver_id is required")

    target_driver_id = None
    if awb:
        ship = _find_shipment_by_awb(db, awb)
        if not ship:
            raise HTTPException(status_code=404, detail="Shipment not found")

        if role == authz.ROLE_RECIPIENT:
            if not _shipment_recipient_authorized(db, current_driver=current_driver, ship=ship):
                raise HTTPException(status_code=403, detail="Not authorized to track this shipment")
        elif role not in _TRACKING_REQUESTER_ROLES:
            raise HTTPException(status_code=403, detail="Not authorized to request tracking")

        target_driver_id = str(ship.driver_id or "").strip().upper() or None
        if not target_driver_id:
            raise HTTPException(status_code=400, detail="Shipment has no driver allocated yet")
    else:
        if role not in _TRACKING_REQUESTER_ROLES:
            raise HTTPException(status_code=403, detail="Not authorized to request tracking")
        target_driver_id = driver_id_in

    target = db.query(models.Driver).filter(models.Driver.driver_id == target_driver_id).first()
    if not target:
        raise HTTPException(status_code=404, detail="Target driver not found")
    if not target.active:
        raise HTTPException(status_code=400, detail="Target driver is inactive")
    if authz.normalize_role(target.role) == authz.ROLE_RECIPIENT:
        raise HTTPException(status_code=400, detail="Target is not a driver account")

    now = datetime.utcnow()
    req = models.TrackingRequest(
        created_at=now,
        created_by_user_id=current_driver.driver_id,
        created_by_role=role,
        target_driver_id=target.driver_id,
        awb=awb,
        status="Accepted",
        duration_sec=duration_sec,
        expires_at=now + timedelta(seconds=duration_sec),
        accepted_at=now,
        denied_at=None,
        stopped_at=None,
        last_location_at=None,
    )
    db.add(req)
    db.commit()
    db.refresh(req)

    # Best-effort in-app notification for the driver.
    who = str(current_driver.name or current_driver.username or current_driver.driver_id or "Admin").strip()
    title = "Live tracking active"
    body = f"{who} started automatic live tracking"
    if awb:
        body += f" for AWB {awb}."
    else:
        body += "."
    notifications_service.create_notification(
        db,
        user_id=target.driver_id,
        title=title,
        body=body,
        awb=awb,
        data={
            "type": "tracking_started",
            "request_id": req.id,
            "awb": awb,
            "requested_by": current_driver.driver_id,
            "expires_at": req.expires_at.isoformat() if req.expires_at else None,
            "duration_sec": duration_sec,
        },
    )
    db.commit()

    return req


@app.get("/tracking/requests/inbox", response_model=List[schemas.TrackingRequestSchema])
async def list_tracking_inbox(
    limit: int = 20,
    db: Session = Depends(database.get_db),
    current_driver: models.Driver = Depends(get_current_driver),
):
    """
    Driver inbox: pending tracking requests targeted to the current driver.
    """
    if not tracking_service.ensure_tracking_schema(db):
        return []

    try:
        limit_n = int(limit or 20)
    except Exception:
        limit_n = 20
    limit_n = max(1, min(limit_n, 100))

    now = datetime.utcnow()
    return (
        db.query(models.TrackingRequest)
        .filter(models.TrackingRequest.target_driver_id == current_driver.driver_id)
        .filter(models.TrackingRequest.status == "Pending")
        .filter(models.TrackingRequest.expires_at.isnot(None), models.TrackingRequest.expires_at > now)
        .order_by(models.TrackingRequest.created_at.desc())
        .limit(limit_n)
        .all()
    )


@app.get("/tracking/requests/active", response_model=List[schemas.TrackingRequestSchema])
async def list_active_tracking_requests(
    limit: int = 10,
    db: Session = Depends(database.get_db),
    current_driver: models.Driver = Depends(get_current_driver),
):
    """
    Active tracking requests for the current (target) driver.

    This allows the driver app to resume location sharing after a refresh.
    """
    if not tracking_service.ensure_tracking_schema(db):
        return []

    try:
        limit_n = int(limit or 10)
    except Exception:
        limit_n = 10
    limit_n = max(1, min(limit_n, 50))

    now = datetime.utcnow()
    rows = (
        db.query(models.TrackingRequest)
        .filter(models.TrackingRequest.target_driver_id == current_driver.driver_id)
        .filter(models.TrackingRequest.status.in_(("Accepted", "Pending")))
        .filter(models.TrackingRequest.stopped_at.is_(None))
        .filter(models.TrackingRequest.expires_at.isnot(None), models.TrackingRequest.expires_at > now)
        .order_by(models.TrackingRequest.accepted_at.desc())
        .limit(limit_n)
        .all()
    )
    changed = False
    for req in rows:
        changed = _auto_activate_tracking_request(db, req, now=now) or changed
    if changed:
        db.commit()
    return rows


@app.get("/tracking/requests/{request_id}", response_model=schemas.TrackingRequestDetailSchema)
async def get_tracking_request(
    request_id: int,
    db: Session = Depends(database.get_db),
    current_driver: models.Driver = Depends(get_current_driver),
):
    if not tracking_service.ensure_tracking_schema(db):
        raise HTTPException(status_code=503, detail="Tracking unavailable")

    req = db.query(models.TrackingRequest).filter(models.TrackingRequest.id == int(request_id)).first()
    if not req:
        raise HTTPException(status_code=404, detail="Tracking request not found")

    if not _tracking_authorized(db, current_driver=current_driver, req=req):
        raise HTTPException(status_code=403, detail="Not authorized")

    if _auto_activate_tracking_request(db, req):
        db.commit()
        db.refresh(req)

    target = db.query(models.Driver).filter(models.Driver.driver_id == req.target_driver_id).first()
    return {
        **schemas.TrackingRequestSchema.model_validate(req).model_dump(),
        "target_driver_name": str(getattr(target, "name", "") or "").strip() or None,
        "target_truck_plate": str(getattr(target, "truck_plate", "") or "").strip().upper() or None,
        "target_truck_phone": str(getattr(target, "phone_number", "") or "").strip() or None,
    }


@app.post("/tracking/requests/{request_id}/accept", response_model=schemas.TrackingRequestSchema)
async def accept_tracking_request(
    request_id: int,
    db: Session = Depends(database.get_db),
    current_driver: models.Driver = Depends(get_current_driver),
):
    if not tracking_service.ensure_tracking_schema(db):
        raise HTTPException(status_code=503, detail="Tracking unavailable")

    req = db.query(models.TrackingRequest).filter(models.TrackingRequest.id == int(request_id)).first()
    if not req:
        raise HTTPException(status_code=404, detail="Tracking request not found")

    if req.target_driver_id != current_driver.driver_id:
        raise HTTPException(status_code=403, detail="Not authorized")

    now = datetime.utcnow()
    if req.expires_at and req.expires_at <= now:
        raise HTTPException(status_code=409, detail="Tracking request expired")

    if str(req.status or "").strip().lower() == "accepted" and tracking_service.is_request_active(req, now=now):
        return req

    if str(req.status or "").strip().lower() in ("denied", "stopped"):
        raise HTTPException(status_code=409, detail=f"Tracking request is {req.status}")

    req.status = "Accepted"
    req.accepted_at = now
    req.expires_at = now + timedelta(seconds=int(req.duration_sec or 900))
    db.commit()
    db.refresh(req)

    # Notify requester (best-effort).
    notifications_service.ensure_notifications_schema(db)
    title = "Tracking started"
    body = f"{current_driver.name or current_driver.driver_id} started sharing live location."
    if req.awb:
        body += f" (AWB {req.awb})"
    notifications_service.create_notification(
        db,
        user_id=req.created_by_user_id,
        title=title,
        body=body,
        awb=req.awb,
        data={
            "type": "tracking_started",
            "request_id": req.id,
            "driver_id": req.target_driver_id,
            "awb": req.awb,
            "expires_at": req.expires_at.isoformat() if req.expires_at else None,
        },
    )
    db.commit()

    return req


@app.post("/tracking/requests/{request_id}/deny", response_model=schemas.TrackingRequestSchema)
async def deny_tracking_request(
    request_id: int,
    db: Session = Depends(database.get_db),
    current_driver: models.Driver = Depends(get_current_driver),
):
    if not tracking_service.ensure_tracking_schema(db):
        raise HTTPException(status_code=503, detail="Tracking unavailable")

    req = db.query(models.TrackingRequest).filter(models.TrackingRequest.id == int(request_id)).first()
    if not req:
        raise HTTPException(status_code=404, detail="Tracking request not found")

    if req.target_driver_id != current_driver.driver_id:
        raise HTTPException(status_code=403, detail="Not authorized")

    role = authz.normalize_role(current_driver.role)
    if role == authz.ROLE_DRIVER:
        raise HTTPException(status_code=403, detail="Drivers cannot deny location tracking")

    now = datetime.utcnow()
    if str(req.status or "").strip().lower() in ("accepted", "denied", "stopped"):
        return req

    req.status = "Denied"
    req.denied_at = now
    db.commit()
    db.refresh(req)

    notifications_service.ensure_notifications_schema(db)
    title = "Tracking denied"
    body = f"{current_driver.name or current_driver.driver_id} denied the location request."
    if req.awb:
        body += f" (AWB {req.awb})"
    notifications_service.create_notification(
        db,
        user_id=req.created_by_user_id,
        title=title,
        body=body,
        awb=req.awb,
        data={"type": "tracking_denied", "request_id": req.id, "driver_id": req.target_driver_id, "awb": req.awb},
    )
    db.commit()

    return req


@app.post("/tracking/requests/{request_id}/stop", response_model=schemas.TrackingRequestSchema)
async def stop_tracking_request(
    request_id: int,
    db: Session = Depends(database.get_db),
    current_driver: models.Driver = Depends(get_current_driver),
):
    if not tracking_service.ensure_tracking_schema(db):
        raise HTTPException(status_code=503, detail="Tracking unavailable")

    req = db.query(models.TrackingRequest).filter(models.TrackingRequest.id == int(request_id)).first()
    if not req:
        raise HTTPException(status_code=404, detail="Tracking request not found")

    if current_driver.driver_id not in (req.created_by_user_id, req.target_driver_id):
        raise HTTPException(status_code=403, detail="Not authorized")

    role = authz.normalize_role(current_driver.role)
    if current_driver.driver_id == req.target_driver_id and role == authz.ROLE_DRIVER:
        raise HTTPException(status_code=403, detail="Drivers cannot stop location tracking")

    now = datetime.utcnow()
    if str(req.status or "").strip().lower() == "stopped":
        return req

    req.status = "Stopped"
    req.stopped_at = now
    db.commit()
    db.refresh(req)

    notifications_service.ensure_notifications_schema(db)
    title = "Tracking stopped"
    body = "Live location sharing was stopped."
    if req.awb:
        body += f" (AWB {req.awb})"

    for uid in {req.created_by_user_id, req.target_driver_id}:
        if not uid:
            continue
        notifications_service.create_notification(
            db,
            user_id=uid,
            title=title,
            body=body,
            awb=req.awb,
            data={"type": "tracking_stopped", "request_id": req.id, "driver_id": req.target_driver_id, "awb": req.awb},
        )
    db.commit()

    return req


@app.get("/tracking/requests/{request_id}/latest", response_model=schemas.TrackingLocationSchema)
async def get_tracking_latest(
    request_id: int,
    db: Session = Depends(database.get_db),
    current_driver: models.Driver = Depends(get_current_driver),
):
    if not tracking_service.ensure_tracking_schema(db):
        raise HTTPException(status_code=503, detail="Tracking unavailable")

    req = db.query(models.TrackingRequest).filter(models.TrackingRequest.id == int(request_id)).first()
    if not req:
        raise HTTPException(status_code=404, detail="Tracking request not found")

    if not _tracking_authorized(db, current_driver=current_driver, req=req):
        raise HTTPException(status_code=403, detail="Not authorized")

    now = datetime.utcnow()
    if _auto_activate_tracking_request(db, req, now=now):
        db.commit()
        db.refresh(req)

    if not tracking_service.is_request_active(req, now=now):
        raise HTTPException(status_code=409, detail="Tracking is not active")

    loc = (
        db.query(models.DriverLocation)
        .filter(models.DriverLocation.driver_id == req.target_driver_id)
        .order_by(models.DriverLocation.timestamp.desc())
        .first()
    )
    if not loc or (req.accepted_at and loc.timestamp and loc.timestamp < req.accepted_at):
        raise HTTPException(status_code=404, detail="No location yet")

    return {
        "request_id": req.id,
        "driver_id": req.target_driver_id,
        "latitude": float(loc.latitude),
        "longitude": float(loc.longitude),
        "timestamp": loc.timestamp,
    }


@app.get("/roles", response_model=List[schemas.RoleInfoSchema])
async def list_roles(current_driver: models.Driver = Depends(get_current_driver)):
    role_descriptions = {
        authz.ROLE_ADMIN: "Full access (users, drivers, shipments, labels, logs).",
        authz.ROLE_MANAGER: "Operations manager (shipments, labels, updates, read users, all logs).",
        authz.ROLE_DISPATCHER: "Dispatcher (shipments, labels, updates, all logs).",
        authz.ROLE_WAREHOUSE: "Warehouse (shipments, labels, updates, own logs).",
        authz.ROLE_DRIVER: "Driver (update AWB, single shipment, labels, own logs).",
        authz.ROLE_SUPPORT: "Support (shipments, labels, read all logs).",
        authz.ROLE_FINANCE: "Finance (shipments, read all logs).",
        authz.ROLE_VIEWER: "Read-only (shipments, labels, own logs).",
        authz.ROLE_RECIPIENT: "Recipient/customer (track your own shipments and receive notifications).",
    }

    # Reverse aliases: canonical role -> list of acceptable alias strings.
    aliases_by_role = {role: [] for role in authz.VALID_ROLES}
    for alias, role in getattr(authz, "_ROLE_ALIASES", {}).items():
        # Skip the obvious uppercase canonical alias (e.g. ADMIN -> Admin)
        if alias.upper() == role.upper():
            continue
        aliases_by_role.setdefault(role, []).append(alias)

    result = []
    for role in sorted(authz.VALID_ROLES):
        result.append(
            {
                "role": role,
                "description": role_descriptions.get(role),
                "permissions": _permissions_for_role(role),
                "aliases": sorted(set(aliases_by_role.get(role, []))),
            }
        )

    return result


@app.get("/vehicle-types", response_model=List[schemas.VehicleTypeSchema])
async def list_vehicle_types(
    current_driver: models.Driver = Depends(permission_required(authz.PERM_SHIPMENTS_READ)),
):
    return vehicle_types_service.list_vehicle_types()


def _fleet_vehicle_or_404(db: Session, vehicle_id: int) -> models.FleetVehicle:
    row = db.query(models.FleetVehicle).filter(models.FleetVehicle.id == int(vehicle_id)).first()
    if not row:
        raise HTTPException(status_code=404, detail="Fleet vehicle not found")
    return row


def _fleet_doc_or_404(db: Session, vehicle_id: int, doc_id: int) -> models.FleetDocument:
    row = (
        db.query(models.FleetDocument)
        .filter(models.FleetDocument.id == int(doc_id), models.FleetDocument.vehicle_id == int(vehicle_id))
        .first()
    )
    if not row:
        raise HTTPException(status_code=404, detail="Fleet document not found")
    return row


def _fleet_service_or_404(db: Session, vehicle_id: int, service_id: int) -> models.FleetServiceRecord:
    row = (
        db.query(models.FleetServiceRecord)
        .filter(models.FleetServiceRecord.id == int(service_id), models.FleetServiceRecord.vehicle_id == int(vehicle_id))
        .first()
    )
    if not row:
        raise HTTPException(status_code=404, detail="Fleet service record not found")
    return row


def _fleet_insurance_or_404(db: Session, vehicle_id: int, insurance_id: int) -> models.FleetInsurancePolicy:
    row = (
        db.query(models.FleetInsurancePolicy)
        .filter(models.FleetInsurancePolicy.id == int(insurance_id), models.FleetInsurancePolicy.vehicle_id == int(vehicle_id))
        .first()
    )
    if not row:
        raise HTTPException(status_code=404, detail="Fleet insurance record not found")
    return row


def _fleet_days(value: Optional[int], *, default: int = 30) -> int:
    if value is None:
        return int(default)
    try:
        n = int(value)
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid reminder_days_before")
    if n < 0:
        raise HTTPException(status_code=400, detail="reminder_days_before must be >= 0")
    return n


def _ensure_standard_fleet_defaults(db: Session) -> bool:
    """
    Ensure standard fleet rows exist when deployment DB is empty or missing known plates.
    Uses non-destructive upsert (no forced password reset).
    """
    try:
        try:
            from .scripts import import_fleet_accounts as fleet_accounts_seed
        except ImportError:  # pragma: no cover
            from scripts import import_fleet_accounts as fleet_accounts_seed
    except Exception:
        return False

    expected_plates: set[str] = set()
    for spec in getattr(fleet_accounts_seed, "STANDARD_ROWS", []) or []:
        for key in ("plate", "tir_plate"):
            p = _fleet_clean_plate((spec or {}).get(key))
            if p:
                expected_plates.add(p)

    existing_plates: set[str] = set()
    for row in db.query(models.Driver).filter(models.Driver.active.is_(True)).all():
        p = _fleet_clean_plate(getattr(row, "truck_plate", None))
        if p:
            existing_plates.add(p)

    needs_seed = (not existing_plates) or (bool(expected_plates) and not bool(expected_plates & existing_plates))
    if not needs_seed:
        return False

    try:
        fleet_accounts_seed.upsert_standard_fleet_accounts(db, reset_passwords=False)
        db.commit()
        fleet_service.sync_vehicles_from_drivers(db)
        return True
    except Exception as exc:
        db.rollback()
        logger.warning("Fleet standard seed fallback failed: %s", str(exc), exc_info=True)
        return False


@app.get("/fleet/overview", response_model=schemas.FleetOverviewSchema)
async def get_fleet_overview(
    days: int = 30,
    include_inactive: bool = False,
    db: Session = Depends(database.get_db),
    current_driver: models.Driver = Depends(permission_required(authz.PERM_SHIPMENTS_READ)),
):
    drivers_service.ensure_drivers_schema(db)
    if not fleet_service.ensure_fleet_schema(db):
        raise HTTPException(status_code=503, detail="Fleet unavailable")
    _ensure_standard_fleet_defaults(db)
    fleet_service.sync_vehicles_from_drivers(db)
    fleet_service.refresh_compliance_statuses(db)
    return fleet_service.fleet_overview(db, days=days, include_inactive=include_inactive)


@app.get("/fleet/vehicles", response_model=List[schemas.FleetVehicleSchema])
async def list_fleet_vehicles(
    include_inactive: bool = False,
    sync_from_drivers: bool = True,
    db: Session = Depends(database.get_db),
    current_driver: models.Driver = Depends(permission_required(authz.PERM_SHIPMENTS_READ)),
):
    drivers_service.ensure_drivers_schema(db)
    if not fleet_service.ensure_fleet_schema(db):
        raise HTTPException(status_code=503, detail="Fleet unavailable")
    _ensure_standard_fleet_defaults(db)
    if sync_from_drivers:
        fleet_service.sync_vehicles_from_drivers(db)
    fleet_service.refresh_compliance_statuses(db)
    return fleet_service.list_vehicles(db, include_inactive=include_inactive)


@app.post("/fleet/vehicles", response_model=schemas.FleetVehicleSchema, status_code=201)
async def create_fleet_vehicle(
    request: schemas.FleetVehicleCreate,
    db: Session = Depends(database.get_db),
    current_driver: models.Driver = Depends(permission_required(authz.PERM_USERS_WRITE)),
):
    if not fleet_service.ensure_fleet_schema(db):
        raise HTTPException(status_code=503, detail="Fleet unavailable")

    vehicle_type_code = _normalize_vehicle_type_or_raise(request.vehicle_type_code)
    defaults = vehicle_types_service.defaults_for_type(vehicle_type_code)

    plate = _fleet_clean_plate(request.plate)
    if plate:
        existing_plate = db.query(models.FleetVehicle).filter(models.FleetVehicle.plate == plate).first()
        if existing_plate:
            raise HTTPException(status_code=409, detail="Vehicle plate already exists")

    row = models.FleetVehicle(
        plate=plate,
        label=_fleet_clean_str(request.label),
        active=bool(request.active) if request.active is not None else True,
        assigned_driver_id=_fleet_resolve_driver_id_or_raise(db, request.assigned_driver_id),
        assigned_driver_name=_fleet_clean_str(request.assigned_driver_name),
        assigned_phone=_fleet_clean_str(request.assigned_phone),
        helper_name=_fleet_clean_str(request.helper_name),
        vehicle_type_code=vehicle_type_code,
        vehicle_has_lift=bool(request.vehicle_has_lift) if request.vehicle_has_lift is not None else False if vehicle_type_code else None,
        max_volume_m3=_clean_positive_float("max_volume_m3", request.max_volume_m3) or defaults.get("max_volume_m3"),
        target_volume_m3=_clean_positive_float("target_volume_m3", request.target_volume_m3) or defaults.get("target_volume_m3"),
        max_weight_kg=_clean_positive_float("max_weight_kg", request.max_weight_kg) or defaults.get("max_weight_kg"),
        target_weight_kg=_clean_positive_float("target_weight_kg", request.target_weight_kg) or defaults.get("target_weight_kg"),
        odometer_km=_fleet_clean_non_negative_float("odometer_km", request.odometer_km),
        purchase_date=request.purchase_date,
        notes=_fleet_clean_str(request.notes),
        admin_data=request.admin_data,
    )
    _validate_vehicle_capacity_pair(
        max_value=row.max_volume_m3,
        target_value=row.target_volume_m3,
        max_field="max_volume_m3",
        target_field="target_volume_m3",
    )
    _validate_vehicle_capacity_pair(
        max_value=row.max_weight_kg,
        target_value=row.target_weight_kg,
        max_field="max_weight_kg",
        target_field="target_weight_kg",
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


@app.patch("/fleet/vehicles/{vehicle_id}", response_model=schemas.FleetVehicleSchema)
async def update_fleet_vehicle(
    vehicle_id: int,
    request: schemas.FleetVehicleUpdate,
    db: Session = Depends(database.get_db),
    current_driver: models.Driver = Depends(permission_required(authz.PERM_USERS_WRITE)),
):
    if not fleet_service.ensure_fleet_schema(db):
        raise HTTPException(status_code=503, detail="Fleet unavailable")
    row = _fleet_vehicle_or_404(db, vehicle_id)
    patch = _schema_dump_exclude_unset(request)

    if "plate" in patch:
        plate = _fleet_clean_plate(patch.get("plate"))
        if plate:
            clash = (
                db.query(models.FleetVehicle)
                .filter(models.FleetVehicle.plate == plate, models.FleetVehicle.id != int(vehicle_id))
                .first()
            )
            if clash:
                raise HTTPException(status_code=409, detail="Vehicle plate already exists")
        row.plate = plate
    if "label" in patch:
        row.label = _fleet_clean_str(patch.get("label"))
    if "active" in patch:
        row.active = bool(patch.get("active"))
    if "assigned_driver_id" in patch:
        row.assigned_driver_id = _fleet_resolve_driver_id_or_raise(db, patch.get("assigned_driver_id"))
    if "assigned_driver_name" in patch:
        row.assigned_driver_name = _fleet_clean_str(patch.get("assigned_driver_name"))
    if "assigned_phone" in patch:
        row.assigned_phone = _fleet_clean_str(patch.get("assigned_phone"))
    if "helper_name" in patch:
        row.helper_name = _fleet_clean_str(patch.get("helper_name"))
    if "vehicle_type_code" in patch:
        row.vehicle_type_code = _normalize_vehicle_type_or_raise(patch.get("vehicle_type_code"))
    if "vehicle_has_lift" in patch:
        row.vehicle_has_lift = bool(patch.get("vehicle_has_lift")) if patch.get("vehicle_has_lift") is not None else None
    if "max_volume_m3" in patch:
        row.max_volume_m3 = _clean_positive_float("max_volume_m3", patch.get("max_volume_m3"))
    if "target_volume_m3" in patch:
        row.target_volume_m3 = _clean_positive_float("target_volume_m3", patch.get("target_volume_m3"))
    if "max_weight_kg" in patch:
        row.max_weight_kg = _clean_positive_float("max_weight_kg", patch.get("max_weight_kg"))
    if "target_weight_kg" in patch:
        row.target_weight_kg = _clean_positive_float("target_weight_kg", patch.get("target_weight_kg"))
    if "odometer_km" in patch:
        row.odometer_km = _fleet_clean_non_negative_float("odometer_km", patch.get("odometer_km"))
    if "purchase_date" in patch:
        row.purchase_date = patch.get("purchase_date")
    if "notes" in patch:
        row.notes = _fleet_clean_str(patch.get("notes"))
    if "admin_data" in patch:
        row.admin_data = patch.get("admin_data")

    if row.vehicle_type_code:
        defaults = vehicle_types_service.defaults_for_type(row.vehicle_type_code)
        if row.max_volume_m3 is None:
            row.max_volume_m3 = defaults.get("max_volume_m3")
        if row.target_volume_m3 is None:
            row.target_volume_m3 = defaults.get("target_volume_m3")
        if row.max_weight_kg is None:
            row.max_weight_kg = defaults.get("max_weight_kg")
        if row.target_weight_kg is None:
            row.target_weight_kg = defaults.get("target_weight_kg")

    _validate_vehicle_capacity_pair(
        max_value=row.max_volume_m3,
        target_value=row.target_volume_m3,
        max_field="max_volume_m3",
        target_field="target_volume_m3",
    )
    _validate_vehicle_capacity_pair(
        max_value=row.max_weight_kg,
        target_value=row.target_weight_kg,
        max_field="max_weight_kg",
        target_field="target_weight_kg",
    )

    db.commit()
    db.refresh(row)
    return row


@app.get("/fleet/vehicles/{vehicle_id}/documents", response_model=List[schemas.FleetDocumentSchema])
async def list_fleet_documents(
    vehicle_id: int,
    db: Session = Depends(database.get_db),
    current_driver: models.Driver = Depends(permission_required(authz.PERM_SHIPMENTS_READ)),
):
    if not fleet_service.ensure_fleet_schema(db):
        raise HTTPException(status_code=503, detail="Fleet unavailable")
    _fleet_vehicle_or_404(db, vehicle_id)
    fleet_service.refresh_compliance_statuses(db)
    return (
        db.query(models.FleetDocument)
        .filter(models.FleetDocument.vehicle_id == int(vehicle_id))
        .order_by(models.FleetDocument.expiry_date.asc().nullslast(), models.FleetDocument.id.desc())
        .all()
    )


@app.post("/fleet/vehicles/{vehicle_id}/documents", response_model=schemas.FleetDocumentSchema, status_code=201)
async def create_fleet_document(
    vehicle_id: int,
    request: schemas.FleetDocumentCreate,
    db: Session = Depends(database.get_db),
    current_driver: models.Driver = Depends(permission_required(authz.PERM_USERS_WRITE)),
):
    if not fleet_service.ensure_fleet_schema(db):
        raise HTTPException(status_code=503, detail="Fleet unavailable")
    _fleet_vehicle_or_404(db, vehicle_id)

    reminder_days = _fleet_days(request.reminder_days_before, default=30)
    row = models.FleetDocument(
        vehicle_id=int(vehicle_id),
        category=_fleet_clean_str(request.category),
        title=_fleet_clean_str(request.title) or "Document",
        issuer=_fleet_clean_str(request.issuer),
        status=_fleet_clean_str(request.status) or "Valid",
        issue_date=request.issue_date,
        expiry_date=request.expiry_date,
        reminder_days_before=reminder_days,
        remind_at=fleet_service._calc_remind_at(request.expiry_date, reminder_days),
        file_url=_fleet_clean_str(request.file_url),
        notes=_fleet_clean_str(request.notes),
        data=request.data,
    )
    row.status = fleet_service._doc_status(row.expiry_date, datetime.utcnow())
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


@app.patch("/fleet/vehicles/{vehicle_id}/documents/{doc_id}", response_model=schemas.FleetDocumentSchema)
async def update_fleet_document(
    vehicle_id: int,
    doc_id: int,
    request: schemas.FleetDocumentUpdate,
    db: Session = Depends(database.get_db),
    current_driver: models.Driver = Depends(permission_required(authz.PERM_USERS_WRITE)),
):
    if not fleet_service.ensure_fleet_schema(db):
        raise HTTPException(status_code=503, detail="Fleet unavailable")
    row = _fleet_doc_or_404(db, vehicle_id, doc_id)
    patch = _schema_dump_exclude_unset(request)

    if "category" in patch:
        row.category = _fleet_clean_str(patch.get("category"))
    if "title" in patch and _fleet_clean_str(patch.get("title")):
        row.title = _fleet_clean_str(patch.get("title"))
    if "issuer" in patch:
        row.issuer = _fleet_clean_str(patch.get("issuer"))
    if "status" in patch and _fleet_clean_str(patch.get("status")):
        row.status = _fleet_clean_str(patch.get("status"))
    if "issue_date" in patch:
        row.issue_date = patch.get("issue_date")
    if "expiry_date" in patch:
        row.expiry_date = patch.get("expiry_date")
    if "reminder_days_before" in patch:
        row.reminder_days_before = _fleet_days(patch.get("reminder_days_before"), default=30)
    if "file_url" in patch:
        row.file_url = _fleet_clean_str(patch.get("file_url"))
    if "notes" in patch:
        row.notes = _fleet_clean_str(patch.get("notes"))
    if "data" in patch:
        row.data = patch.get("data")

    row.remind_at = fleet_service._calc_remind_at(row.expiry_date, row.reminder_days_before)
    row.status = fleet_service._doc_status(row.expiry_date, datetime.utcnow())

    db.commit()
    db.refresh(row)
    return row


@app.get("/fleet/vehicles/{vehicle_id}/services", response_model=List[schemas.FleetServiceSchema])
async def list_fleet_services(
    vehicle_id: int,
    db: Session = Depends(database.get_db),
    current_driver: models.Driver = Depends(permission_required(authz.PERM_SHIPMENTS_READ)),
):
    if not fleet_service.ensure_fleet_schema(db):
        raise HTTPException(status_code=503, detail="Fleet unavailable")
    _fleet_vehicle_or_404(db, vehicle_id)
    fleet_service.refresh_compliance_statuses(db)
    return (
        db.query(models.FleetServiceRecord)
        .filter(models.FleetServiceRecord.vehicle_id == int(vehicle_id))
        .order_by(models.FleetServiceRecord.due_date.asc().nullslast(), models.FleetServiceRecord.id.desc())
        .all()
    )


@app.post("/fleet/vehicles/{vehicle_id}/services", response_model=schemas.FleetServiceSchema, status_code=201)
async def create_fleet_service(
    vehicle_id: int,
    request: schemas.FleetServiceCreate,
    db: Session = Depends(database.get_db),
    current_driver: models.Driver = Depends(permission_required(authz.PERM_USERS_WRITE)),
):
    if not fleet_service.ensure_fleet_schema(db):
        raise HTTPException(status_code=503, detail="Fleet unavailable")
    vehicle = _fleet_vehicle_or_404(db, vehicle_id)
    reminder_days = _fleet_days(request.reminder_days_before, default=14)

    row = models.FleetServiceRecord(
        vehicle_id=int(vehicle_id),
        service_type=_fleet_clean_str(request.service_type),
        title=_fleet_clean_str(request.title) or "Service",
        provider=_fleet_clean_str(request.provider),
        status=_fleet_clean_str(request.status) or "Planned",
        performed_at=request.performed_at,
        due_date=request.due_date,
        odometer_km=_fleet_clean_non_negative_float("odometer_km", request.odometer_km),
        due_km=_fleet_clean_non_negative_float("due_km", request.due_km),
        next_due_km=_fleet_clean_non_negative_float("next_due_km", request.next_due_km),
        estimated_cost=_fleet_clean_non_negative_float("estimated_cost", request.estimated_cost),
        actual_cost=_fleet_clean_non_negative_float("actual_cost", request.actual_cost),
        currency=_fleet_clean_str(request.currency),
        reminder_days_before=reminder_days,
        remind_at=fleet_service._calc_remind_at(request.due_date, reminder_days),
        notes=_fleet_clean_str(request.notes),
        data=request.data,
    )
    row.status = fleet_service._service_status(
        due_date=row.due_date,
        due_km=row.due_km,
        now=datetime.utcnow(),
        odometer_km=_fleet_clean_non_negative_float("vehicle_odometer_km", vehicle.odometer_km),
        current_status=row.status,
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


@app.patch("/fleet/vehicles/{vehicle_id}/services/{service_id}", response_model=schemas.FleetServiceSchema)
async def update_fleet_service(
    vehicle_id: int,
    service_id: int,
    request: schemas.FleetServiceUpdate,
    db: Session = Depends(database.get_db),
    current_driver: models.Driver = Depends(permission_required(authz.PERM_USERS_WRITE)),
):
    if not fleet_service.ensure_fleet_schema(db):
        raise HTTPException(status_code=503, detail="Fleet unavailable")
    vehicle = _fleet_vehicle_or_404(db, vehicle_id)
    row = _fleet_service_or_404(db, vehicle_id, service_id)
    patch = _schema_dump_exclude_unset(request)

    if "service_type" in patch:
        row.service_type = _fleet_clean_str(patch.get("service_type"))
    if "title" in patch and _fleet_clean_str(patch.get("title")):
        row.title = _fleet_clean_str(patch.get("title"))
    if "provider" in patch:
        row.provider = _fleet_clean_str(patch.get("provider"))
    if "status" in patch and _fleet_clean_str(patch.get("status")):
        row.status = _fleet_clean_str(patch.get("status"))
    if "performed_at" in patch:
        row.performed_at = patch.get("performed_at")
    if "due_date" in patch:
        row.due_date = patch.get("due_date")
    if "odometer_km" in patch:
        row.odometer_km = _fleet_clean_non_negative_float("odometer_km", patch.get("odometer_km"))
    if "due_km" in patch:
        row.due_km = _fleet_clean_non_negative_float("due_km", patch.get("due_km"))
    if "next_due_km" in patch:
        row.next_due_km = _fleet_clean_non_negative_float("next_due_km", patch.get("next_due_km"))
    if "estimated_cost" in patch:
        row.estimated_cost = _fleet_clean_non_negative_float("estimated_cost", patch.get("estimated_cost"))
    if "actual_cost" in patch:
        row.actual_cost = _fleet_clean_non_negative_float("actual_cost", patch.get("actual_cost"))
    if "currency" in patch:
        row.currency = _fleet_clean_str(patch.get("currency"))
    if "reminder_days_before" in patch:
        row.reminder_days_before = _fleet_days(patch.get("reminder_days_before"), default=14)
    if "notes" in patch:
        row.notes = _fleet_clean_str(patch.get("notes"))
    if "data" in patch:
        row.data = patch.get("data")

    row.remind_at = fleet_service._calc_remind_at(row.due_date, row.reminder_days_before)
    row.status = fleet_service._service_status(
        due_date=row.due_date,
        due_km=row.due_km,
        now=datetime.utcnow(),
        odometer_km=_fleet_clean_non_negative_float("vehicle_odometer_km", vehicle.odometer_km),
        current_status=row.status,
    )

    db.commit()
    db.refresh(row)
    return row


@app.get("/fleet/vehicles/{vehicle_id}/insurances", response_model=List[schemas.FleetInsuranceSchema])
async def list_fleet_insurances(
    vehicle_id: int,
    db: Session = Depends(database.get_db),
    current_driver: models.Driver = Depends(permission_required(authz.PERM_SHIPMENTS_READ)),
):
    if not fleet_service.ensure_fleet_schema(db):
        raise HTTPException(status_code=503, detail="Fleet unavailable")
    _fleet_vehicle_or_404(db, vehicle_id)
    fleet_service.refresh_compliance_statuses(db)
    return (
        db.query(models.FleetInsurancePolicy)
        .filter(models.FleetInsurancePolicy.vehicle_id == int(vehicle_id))
        .order_by(models.FleetInsurancePolicy.expiry_date.asc().nullslast(), models.FleetInsurancePolicy.id.desc())
        .all()
    )


@app.post("/fleet/vehicles/{vehicle_id}/insurances", response_model=schemas.FleetInsuranceSchema, status_code=201)
async def create_fleet_insurance(
    vehicle_id: int,
    request: schemas.FleetInsuranceCreate,
    db: Session = Depends(database.get_db),
    current_driver: models.Driver = Depends(permission_required(authz.PERM_USERS_WRITE)),
):
    if not fleet_service.ensure_fleet_schema(db):
        raise HTTPException(status_code=503, detail="Fleet unavailable")
    _fleet_vehicle_or_404(db, vehicle_id)
    reminder_days = _fleet_days(request.reminder_days_before, default=30)
    row = models.FleetInsurancePolicy(
        vehicle_id=int(vehicle_id),
        insurance_type=_fleet_clean_str(request.insurance_type),
        provider=_fleet_clean_str(request.provider),
        policy_number=_fleet_clean_str(request.policy_number),
        status=_fleet_clean_str(request.status) or "Active",
        start_date=request.start_date,
        expiry_date=request.expiry_date,
        premium_amount=_fleet_clean_non_negative_float("premium_amount", request.premium_amount),
        currency=_fleet_clean_str(request.currency),
        deductible=_fleet_clean_non_negative_float("deductible", request.deductible),
        reminder_days_before=reminder_days,
        remind_at=fleet_service._calc_remind_at(request.expiry_date, reminder_days),
        notes=_fleet_clean_str(request.notes),
        data=request.data,
    )
    row.status = fleet_service._doc_status(row.expiry_date, datetime.utcnow(), active_label="Active")
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


@app.patch("/fleet/vehicles/{vehicle_id}/insurances/{insurance_id}", response_model=schemas.FleetInsuranceSchema)
async def update_fleet_insurance(
    vehicle_id: int,
    insurance_id: int,
    request: schemas.FleetInsuranceUpdate,
    db: Session = Depends(database.get_db),
    current_driver: models.Driver = Depends(permission_required(authz.PERM_USERS_WRITE)),
):
    if not fleet_service.ensure_fleet_schema(db):
        raise HTTPException(status_code=503, detail="Fleet unavailable")
    row = _fleet_insurance_or_404(db, vehicle_id, insurance_id)
    patch = _schema_dump_exclude_unset(request)

    if "insurance_type" in patch:
        row.insurance_type = _fleet_clean_str(patch.get("insurance_type"))
    if "provider" in patch:
        row.provider = _fleet_clean_str(patch.get("provider"))
    if "policy_number" in patch:
        row.policy_number = _fleet_clean_str(patch.get("policy_number"))
    if "status" in patch and _fleet_clean_str(patch.get("status")):
        row.status = _fleet_clean_str(patch.get("status"))
    if "start_date" in patch:
        row.start_date = patch.get("start_date")
    if "expiry_date" in patch:
        row.expiry_date = patch.get("expiry_date")
    if "premium_amount" in patch:
        row.premium_amount = _fleet_clean_non_negative_float("premium_amount", patch.get("premium_amount"))
    if "currency" in patch:
        row.currency = _fleet_clean_str(patch.get("currency"))
    if "deductible" in patch:
        row.deductible = _fleet_clean_non_negative_float("deductible", patch.get("deductible"))
    if "reminder_days_before" in patch:
        row.reminder_days_before = _fleet_days(patch.get("reminder_days_before"), default=30)
    if "notes" in patch:
        row.notes = _fleet_clean_str(patch.get("notes"))
    if "data" in patch:
        row.data = patch.get("data")

    row.remind_at = fleet_service._calc_remind_at(row.expiry_date, row.reminder_days_before)
    row.status = fleet_service._doc_status(row.expiry_date, datetime.utcnow(), active_label="Active")

    db.commit()
    db.refresh(row)
    return row


@app.get("/users", response_model=List[schemas.Driver])
async def list_users(
    db: Session = Depends(database.get_db),
    current_driver: models.Driver = Depends(permission_required(authz.PERM_USERS_READ)),
):
    return db.query(models.Driver).order_by(models.Driver.driver_id.asc()).all()


@app.post("/users/seed-fleet-accounts", response_model=List[schemas.FleetAccountCredentialSchema])
async def seed_fleet_accounts(
    reset_passwords: bool = True,
    db: Session = Depends(database.get_db),
    current_driver: models.Driver = Depends(permission_required(authz.PERM_USERS_WRITE)),
):
    drivers_service.ensure_drivers_schema(db)
    try:
        try:
            from .scripts import import_fleet_accounts as fleet_accounts_seed
        except ImportError:  # pragma: no cover
            from scripts import import_fleet_accounts as fleet_accounts_seed
        rows = fleet_accounts_seed.upsert_standard_fleet_accounts(db, reset_passwords=bool(reset_passwords))
        db.commit()
        # Keep fleet vehicle table aligned with seeded/updated drivers.
        fleet_service.ensure_fleet_schema(db)
        fleet_service.sync_vehicles_from_drivers(db)
        return rows
    except Exception as exc:
        db.rollback()
        raise HTTPException(status_code=500, detail=f"Failed to seed fleet accounts: {str(exc)}")


@app.post("/users", response_model=schemas.Driver, status_code=201)
async def create_user(
    request: schemas.DriverCreate,
    db: Session = Depends(database.get_db),
    current_driver: models.Driver = Depends(permission_required(authz.PERM_USERS_WRITE)),
):
    drivers_service.ensure_drivers_schema(db)

    role = authz.normalize_role(request.role)
    if role not in authz.VALID_ROLES:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid role. Valid roles: {', '.join(sorted(authz.VALID_ROLES))}",
        )

    if db.query(models.Driver).filter(models.Driver.driver_id == request.driver_id).first():
        raise HTTPException(status_code=409, detail="driver_id already exists")

    if db.query(models.Driver).filter(models.Driver.username == request.username).first():
        raise HTTPException(status_code=409, detail="username already exists")

    vehicle_type_code = _normalize_vehicle_type_or_raise(request.vehicle_type_code)
    vehicle_has_lift = request.vehicle_has_lift

    profile = vehicle_types_service.get_vehicle_type_profile(vehicle_type_code)
    if profile:
        supports_lift = bool(profile.get("supports_liftgate"))
        if vehicle_has_lift and not supports_lift:
            raise HTTPException(status_code=400, detail="Selected vehicle type does not support liftgate")
        if vehicle_has_lift is None:
            vehicle_has_lift = False

    max_volume_m3 = _clean_positive_float("max_volume_m3", request.max_volume_m3)
    target_volume_m3 = _clean_positive_float("target_volume_m3", request.target_volume_m3)
    max_weight_kg = _clean_positive_float("max_weight_kg", request.max_weight_kg)
    target_weight_kg = _clean_positive_float("target_weight_kg", request.target_weight_kg)

    defaults = vehicle_types_service.defaults_for_type(vehicle_type_code)
    if max_volume_m3 is None:
        max_volume_m3 = defaults.get("max_volume_m3")
    if target_volume_m3 is None:
        target_volume_m3 = defaults.get("target_volume_m3")
    if max_weight_kg is None:
        max_weight_kg = defaults.get("max_weight_kg")
    if target_weight_kg is None:
        target_weight_kg = defaults.get("target_weight_kg")

    _validate_vehicle_capacity_pair(
        max_value=max_volume_m3,
        target_value=target_volume_m3,
        max_field="max_volume_m3",
        target_field="target_volume_m3",
    )
    _validate_vehicle_capacity_pair(
        max_value=max_weight_kg,
        target_value=target_weight_kg,
        max_field="max_weight_kg",
        target_field="target_weight_kg",
    )

    driver = models.Driver(
        driver_id=request.driver_id,
        name=request.name,
        username=request.username,
        password_hash=driver_manager.get_password_hash(request.password),
        role=role,
        active=request.active,
        truck_plate=(str(request.truck_plate).strip().upper() if request.truck_plate else None),
        phone_number=(str(request.phone_number).strip() if request.phone_number else None),
        helper_name=(str(request.helper_name).strip() if request.helper_name else None),
        vehicle_type_code=vehicle_type_code,
        vehicle_has_lift=vehicle_has_lift,
        max_volume_m3=max_volume_m3,
        target_volume_m3=target_volume_m3,
        max_weight_kg=max_weight_kg,
        target_weight_kg=target_weight_kg,
    )

    # Maintain normalization used for recipient RBAC / WhatsApp routing.
    try:
        phone_norm = phone_service.normalize_phone(driver.phone_number or "")
        driver.phone_norm = phone_norm or None
    except Exception:
        driver.phone_norm = None

    db.add(driver)
    db.commit()
    db.refresh(driver)
    return driver


@app.patch("/users/{driver_id}", response_model=schemas.Driver)
async def update_user(
    driver_id: str,
    request: schemas.DriverUpdate,
    db: Session = Depends(database.get_db),
    current_driver: models.Driver = Depends(permission_required(authz.PERM_USERS_WRITE)),
):
    drivers_service.ensure_drivers_schema(db)
    try:
        patch_fields = request.model_dump(exclude_unset=True)  # pydantic v2
    except Exception:
        patch_fields = request.dict(exclude_unset=True)  # pydantic v1 fallback

    driver = db.query(models.Driver).filter(models.Driver.driver_id == driver_id).first()
    if not driver:
        raise HTTPException(status_code=404, detail="User not found")

    if "name" in patch_fields:
        driver.name = request.name

    if "username" in patch_fields:
        existing = (
            db.query(models.Driver)
            .filter(models.Driver.username == request.username, models.Driver.driver_id != driver_id)
            .first()
        )
        if existing:
            raise HTTPException(status_code=409, detail="username already exists")
        driver.username = request.username

    if "password" in patch_fields and request.password is not None:
        driver.password_hash = driver_manager.get_password_hash(request.password)

    if "role" in patch_fields and request.role is not None:
        role = authz.normalize_role(request.role)
        if role not in authz.VALID_ROLES:
            raise HTTPException(
                status_code=400,
                detail=f"Invalid role. Valid roles: {', '.join(sorted(authz.VALID_ROLES))}",
            )
        driver.role = role

    if "active" in patch_fields and request.active is not None:
        driver.active = request.active

    if "truck_plate" in patch_fields:
        truck_plate = str(request.truck_plate or "").strip().upper()
        driver.truck_plate = truck_plate or None

    if "phone_number" in patch_fields:
        phone_number = str(request.phone_number or "").strip()
        driver.phone_number = phone_number or None
        try:
            phone_norm = phone_service.normalize_phone(phone_number)
            driver.phone_norm = phone_norm or None
        except Exception:
            driver.phone_norm = None

    if "helper_name" in patch_fields:
        helper_name = str(request.helper_name or "").strip()
        driver.helper_name = helper_name or None

    type_changed = False
    if "vehicle_type_code" in patch_fields:
        driver.vehicle_type_code = _normalize_vehicle_type_or_raise(request.vehicle_type_code)
        type_changed = True

    if "vehicle_has_lift" in patch_fields:
        driver.vehicle_has_lift = bool(request.vehicle_has_lift) if request.vehicle_has_lift is not None else None

    for field in ("max_volume_m3", "target_volume_m3", "max_weight_kg", "target_weight_kg"):
        if field not in patch_fields:
            continue
        setattr(driver, field, _clean_positive_float(field, patch_fields.get(field)))

    profile = vehicle_types_service.get_vehicle_type_profile(driver.vehicle_type_code)
    if profile:
        supports_lift = bool(profile.get("supports_liftgate"))
        if driver.vehicle_has_lift and not supports_lift:
            raise HTTPException(status_code=400, detail="Selected vehicle type does not support liftgate")
        if type_changed and "vehicle_has_lift" not in patch_fields:
            driver.vehicle_has_lift = False

    if type_changed and driver.vehicle_type_code:
        defaults = vehicle_types_service.defaults_for_type(driver.vehicle_type_code)
        for field in ("max_volume_m3", "target_volume_m3", "max_weight_kg", "target_weight_kg"):
            if field in patch_fields:
                continue
            default_val = defaults.get(field)
            if default_val is not None:
                setattr(driver, field, default_val)

    _validate_vehicle_capacity_pair(
        max_value=driver.max_volume_m3,
        target_value=driver.target_volume_m3,
        max_field="max_volume_m3",
        target_field="target_volume_m3",
    )
    _validate_vehicle_capacity_pair(
        max_value=driver.max_weight_kg,
        target_value=driver.target_weight_kg,
        max_field="max_weight_kg",
        target_field="target_weight_kg",
    )

    db.commit()
    db.refresh(driver)
    return driver

@app.get("/status-options", response_model=List[schemas.StatusOptionSchema])
async def get_status_options(
    db: Session = Depends(database.get_db),
    current_driver: models.Driver = Depends(permission_required(authz.PERM_STATUS_OPTIONS_READ)),
):
    return _ensure_status_options(db)


_NDR_REASONS = [
    {"code": "NO_ANSWER", "label": "No answer", "kind": "contact"},
    {"code": "PHONE_OFF", "label": "Phone off / unreachable", "kind": "contact"},
    {"code": "WRONG_NUMBER", "label": "Wrong number", "kind": "contact"},
    {"code": "ADDRESS_NOT_FOUND", "label": "Address not found", "kind": "address"},
    {"code": "RECIPIENT_NOT_HOME", "label": "Recipient not home", "kind": "availability"},
    {"code": "RECIPIENT_REFUSED", "label": "Recipient refused", "kind": "refusal"},
    {"code": "NO_CASH", "label": "No cash / cannot pay", "kind": "payment"},
    {"code": "DAMAGED", "label": "Damaged package", "kind": "package"},
    {"code": "OTHER", "label": "Other", "kind": "other"},
]


@app.get("/ndr/reasons")
async def list_ndr_reasons(current_driver: models.Driver = Depends(get_current_driver)):
    return {"reasons": _NDR_REASONS}


@app.on_event("startup")
async def startup_event():
    # Keep startup fast and robust. Drivers are managed in DB (no external sheet sync).
    db = database.SessionLocal()
    try:
        auto_seed_fleet_accounts = str(os.getenv("AUTO_SEED_FLEET_ACCOUNTS", "1") or "").strip().lower() not in {
            "0",
            "false",
            "no",
            "off",
        }
        drivers_service.ensure_drivers_schema(db)
        if auto_seed_fleet_accounts:
            try:
                reset_passwords_on_seed = str(os.getenv("AUTO_SEED_FLEET_RESETPASSWORDS", "1") or "").strip().lower() not in {
                    "0",
                    "false",
                    "no",
                    "off",
                }
                try:
                    from .scripts import import_fleet_accounts as fleet_accounts_seed
                except ImportError:  # pragma: no cover
                    from scripts import import_fleet_accounts as fleet_accounts_seed
                seeded_accounts = fleet_accounts_seed.upsert_standard_fleet_accounts(db, reset_passwords=reset_passwords_on_seed)
                db.commit()
                logger.info("Fleet startup seed ensured %s accounts", len(seeded_accounts))
            except Exception as seed_exc:
                db.rollback()
                logger.error("Fleet startup seed failed: %s", str(seed_exc), exc_info=True)
        shipments_service.ensure_shipments_schema(db)
        notifications_service.ensure_notifications_schema(db)
        contacts_service.ensure_contacts_schema(db)
        fleet_service.ensure_fleet_schema(db)
        fleet_service.sync_vehicles_from_drivers(db)
        fleet_service.refresh_compliance_statuses(db)
        manifests_service.ensure_manifests_schema(db)
        route_runs_service.ensure_route_runs_schema(db)
        route_planning_service.ensure_route_plans_schema(db)
        if not tracking_service.ensure_tracking_schema(db):
            logger.warning("Tracking schema unavailable (cannot create tracking_requests table).")
        if not chat_service.ensure_chat_schema(db):
            logger.warning("Chat schema unavailable (cannot create chat tables).")
        _ensure_status_options(db)
        # Backfill normalization fields used for recipient RBAC.
        drivers_service.backfill_phone_norm(db)
        shipments_service.backfill_recipient_phone_norm(db)
    except Exception as e:
        logger.error(f"Startup migrations/seed failed: {str(e)}")
    finally:
        db.close()

    if os.getenv("AUTO_SYNC_DRIVERS_ON_STARTUP") or os.getenv("GOOGLE_SHEETS_URL"):
        logger.info("Google Sheets driver sync is disabled. Drivers are managed directly in the database.")

    # Background Postis polling to keep the DB fresh for dashboards/allocations.
    # Enabled when AUTO_SYNC_POSTIS=1 (and also auto-enabled when POSTIS credentials exist and
    # AUTO_SYNC_POSTIS is unset).
    try:
        if "pytest" in sys.modules:
            logger.info("Pytest detected; skipping background Postis polling")
        else:
            cfg = postis_sync_service.load_config_from_env()
            if not cfg.enabled:
                logger.info("AUTO_SYNC_POSTIS not enabled; skipping background Postis polling")
            else:
                task = getattr(app.state, "postis_sync_task", None)
                if task and not task.done():
                    logger.info("Postis polling task already running; not starting another")
                else:
                    app.state.postis_sync_task = asyncio.create_task(
                        postis_sync_service.postis_poll_loop(p_client, config=cfg)
                    )
                    logger.info(
                        "Started background Postis polling (interval_seconds=%s)",
                        cfg.interval_seconds,
                    )
    except Exception as e:
        logger.error(f"Failed to start background Postis polling: {str(e)}", exc_info=True)

    # Background daily route planning:
    # at 04:00 local timezone it runs Postis sync + route plan generation.
    try:
        if "pytest" in sys.modules:
            logger.info("Pytest detected; skipping background auto route planning")
        else:
            planner_cfg = route_planning_service.load_auto_route_planning_config_from_env()
            if not planner_cfg.enabled:
                logger.info("AUTO_ROUTE_PLANNING not enabled; skipping daily planner loop")
            else:
                task = getattr(app.state, "route_planning_task", None)
                if task and not task.done():
                    logger.info("Route planning task already running; not starting another")
                else:
                    app.state.route_planning_task = asyncio.create_task(
                        route_planning_service.auto_route_planning_loop(p_client, config=planner_cfg)
                    )
                    logger.info(
                        "Started daily route planning loop (hour=%s minute=%s tz=%s)",
                        planner_cfg.daily_hour,
                        planner_cfg.daily_minute,
                        planner_cfg.timezone_name,
                    )
    except Exception as e:
        logger.error(f"Failed to start daily route planning loop: {str(e)}", exc_info=True)


@app.on_event("shutdown")
async def shutdown_event():
    for task_name in ("postis_sync_task", "route_planning_task"):
        task = getattr(app.state, task_name, None)
        if not task:
            continue
        try:
            task.cancel()
            await task
        except asyncio.CancelledError:
            pass
        except Exception:
            pass

@app.post("/update-awb")
async def update_awb(
    request: schemas.AWBUpdateRequest,
    db: Session = Depends(database.get_db),
    current_driver: models.Driver = Depends(permission_required(authz.PERM_AWB_UPDATE)),
):
    identifier = postis_client.normalize_shipment_identifier(request.awb)
    if not identifier:
        raise HTTPException(status_code=400, detail="awb is required")

    timestamp = request.timestamp or datetime.utcnow()
    idempotency_key = f"{identifier}:{request.event_id}:{current_driver.driver_id}:{timestamp.isoformat()}"

    log_entry = models.LogEntry(
        driver_id=current_driver.driver_id,
        timestamp=timestamp,
        awb=identifier,
        event_id=request.event_id,
        payload=request.payload,
        idempotency_key=idempotency_key
    )

    try:
        # Idempotency is best-effort; if DB is transiently unavailable we still try Postis update.
        try:
            existing_log = db.query(models.LogEntry).filter(models.LogEntry.idempotency_key == idempotency_key).first()
        except Exception as e:
            existing_log = None
            logger.warning("Idempotency check skipped for %s: %s", identifier, str(e))

        if existing_log:
            return {"status": "already_processed", "outcome": existing_log.outcome, "reference": existing_log.postis_reference}

        opt = db.query(models.StatusOption).filter(models.StatusOption.event_id == request.event_id).first()
        requirements = list(opt.requirements or []) if (opt and isinstance(opt.requirements, list)) else []
        requires_signature = str(request.event_id) == "2" or ("signature" in requirements)
        if requires_signature and not _has_valid_signature_payload(request.payload):
            raise HTTPException(status_code=400, detail="Client signature is required for delivered status")

        # Extra delivery safeguards:
        # - COD delivery: require receipt photo proof.
        # - Buy-back shipments: require recovered item photo proof.
        if str(request.event_id) == "2":
            ship = _find_shipment_by_awb(db, identifier)
            payload = request.payload if isinstance(request.payload, dict) else {}

            cod_expected = 0.0
            if ship is not None:
                cod_expected = _safe_float(getattr(ship, "cod_amount", 0.0))
            if cod_expected <= 0:
                cod_block = payload.get("cod")
                if isinstance(cod_block, dict):
                    cod_expected = _safe_float(cod_block.get("expected_amount"))

            if cod_expected > 0:
                receipt_photo_data_url = _extract_payload_image(payload, "cod", "receipt_photo")
                if not receipt_photo_data_url.startswith("data:image/"):
                    raise HTTPException(status_code=400, detail="Receipt photo is required for COD delivered status")

            buy_back_required = _shipment_requires_buy_back_photo(ship)
            buy_back_block = payload.get("buy_back") if isinstance(payload.get("buy_back"), dict) else {}
            if buy_back_required or bool(buy_back_block.get("required")):
                buy_back_photo_data_url = _extract_payload_image(payload, "buy_back", "photo")
                if not buy_back_photo_data_url.startswith("data:image/"):
                    raise HTTPException(status_code=400, detail="Buy-back photo is required for this delivered shipment")

        event_description = None
        if request.payload and request.payload.get("eventDescription"):
            event_description = str(request.payload.get("eventDescription"))
        elif opt and opt.label:
            # Use the stored label as the Postis-facing eventDescription (can be configured to match Postis codes).
            event_description = opt.label
        else:
            event_description = f"Status update ({request.event_id})"

        # Prepare metadata for Postis per verified spec
        details = {
            "eventDate": timestamp.strftime("%Y-%m-%d %H:%M:%S"),
            "eventDescription": event_description,
            "localityName": request.payload.get("locality", "Unknown") if request.payload else "Unknown",
            "driverName": current_driver.name,
            "driverPhoneNumber": current_driver.phone_number or "",
            "truckNumber": current_driver.truck_plate or ""
        }
        
        response = await p_client.update_status_by_awb_or_client_order_id(identifier, request.event_id, details)
        log_entry.outcome = "SUCCESS"
        log_entry.postis_reference = str(response.get("reference") or response.get("id") or "")

        # Best-effort: keep our local DB in sync for dashboards/reconciliation.
        try:
            shipments_service.ensure_shipments_schema(db)
            ship = db.query(models.Shipment).filter(models.Shipment.awb == identifier).first()
            if ship:
                next_status = _EVENT_TO_STATUS.get(str(request.event_id))
                if not next_status:
                    next_status = postis_statuses.normalize_shipment_status(ship.status or event_description)
                ship.status = next_status
                ship.awb_status_date = timestamp
                ship.last_updated = datetime.utcnow()
                db.add(
                    models.ShipmentEvent(
                        shipment_id=ship.id,
                        event_description=event_description,
                        event_date=timestamp,
                        locality_name=details.get("localityName") or "",
                    )
                )
        except Exception as e:
            logger.warning(f"Local shipment sync skipped for {identifier}: {str(e)}")

        try:
            db.add(log_entry)
            db.commit()
        except Exception as e:
            db.rollback()
            logger.warning("Failed to persist update log for %s: %s", identifier, str(e))
        return {"status": "ok", "outcome": "SUCCESS", "reference": log_entry.postis_reference}
    except HTTPException as e:
        try:
            db.rollback()
        except Exception:
            pass
        try:
            log_entry.outcome = "FAILED"
            log_entry.error_message = str(e.detail)
            db.add(log_entry)
            db.commit()
        except Exception:
            try:
                db.rollback()
            except Exception:
                pass
        raise
    except Exception as e:
        try:
            db.rollback()
        except Exception:
            pass
        try:
            log_entry.outcome = "FAILED"
            log_entry.error_message = str(e)
            db.add(log_entry)
            db.commit()
        except Exception:
            try:
                db.rollback()
            except Exception:
                pass
        raise HTTPException(status_code=502, detail=f"Postis update failed: {str(e)}")

@app.get("/stats")
async def get_stats(
    db: Session = Depends(database.get_db),
    current_driver: models.Driver = Depends(permission_required(authz.PERM_STATS_READ)),
):
    today_start, today_end, stats_tz = _business_day_utc_bounds()
    role = authz.normalize_role(current_driver.role)

    rows_q = db.query(
        models.Shipment.status,
        models.Shipment.processing_status,
        models.Shipment.awb_status_date,
        models.Shipment.last_updated,
    )

    # Scope metrics to the caller's visibility:
    # - Driver: own shipments
    # - Recipient: own phone-matched shipments
    # - Internal roles with stats: all shipments
    if role == authz.ROLE_DRIVER:
        rows_q = rows_q.filter(models.Shipment.driver_id == current_driver.driver_id)
    elif role == authz.ROLE_RECIPIENT:
        phone_norm = _resolve_user_phone_norm(db, current_driver)
        if phone_norm:
            rows_q = rows_q.filter(models.Shipment.recipient_phone_norm == phone_norm)
        else:
            rows_q = rows_q.filter(models.Shipment.id == -1)

    today_delivered = 0
    total_delivered = 0

    for status, processing_status, awb_status_date, last_updated in rows_q.all():
        if not _is_delivered_status(status, processing_status):
            continue
        total_delivered += 1

        # Use status timestamp first; fallback to last_updated.
        delivered_at = awb_status_date or last_updated
        if delivered_at and today_start <= delivered_at < today_end:
            today_delivered += 1

    return {
        "today_count": today_delivered,
        "total_count": total_delivered,
        "driver_name": current_driver.name,
        "stats_timezone": stats_tz,
        "last_sync": datetime.utcnow(),
    }


@app.get("/dashboard/overview")
async def get_dashboard_overview(
    period: str = "today",
    scope: str = "auto",
    anchor_date: Optional[str] = None,  # YYYY-MM-DD in business timezone
    awb_limit: int = 500,
    db: Session = Depends(database.get_db),
    current_driver: models.Driver = Depends(permission_required(authz.PERM_STATS_READ)),
):
    """
    Unified dashboard payload for Home/Calendar:
    - Delivered counts for today/week/month
    - Money totals (COD / shipping proxy)
    - Distance (km) from driver location history
    - Per-driver performance rows
    """
    role = authz.normalize_role(current_driver.role)
    period_key = str(period or "today").strip().lower()
    if period_key not in ("today", "week", "month"):
        raise HTTPException(status_code=400, detail="Invalid period. Use today|week|month")

    scope_key = str(scope or "auto").strip().lower()
    if scope_key not in ("auto", "self", "all"):
        raise HTTPException(status_code=400, detail="Invalid scope. Use auto|self|all")
    if scope_key == "auto":
        scope_key = "all" if authz.can_view_all_logs(role) else "self"
    if scope_key == "all" and not authz.can_view_all_logs(role):
        raise HTTPException(status_code=403, detail="Not enough permissions for scope=all")

    try:
        awb_limit_n = int(awb_limit or 500)
    except Exception:
        awb_limit_n = 500
    awb_limit_n = max(50, min(awb_limit_n, 3000))

    shipments_service.ensure_shipments_schema(db)

    now_utc = datetime.now(timezone.utc)
    if anchor_date:
        try:
            y, m, d = [int(x) for x in str(anchor_date).strip().split("-")]
            tz, _ = _business_timezone()
            anchor_local = datetime(y, m, d, 12, 0, 0, tzinfo=tz)
            now_utc = anchor_local.astimezone(timezone.utc)
        except Exception:
            raise HTTPException(status_code=400, detail="Invalid anchor_date. Use YYYY-MM-DD")
    today_start, today_end, tz_name = _period_bounds_utc("today", now_utc=now_utc)
    week_start, week_end, _ = _period_bounds_utc("week", now_utc=now_utc)
    month_start, month_end, _ = _period_bounds_utc("month", now_utc=now_utc)
    selected_start, selected_end, _ = _period_bounds_utc(period_key, now_utc=now_utc)

    ranges = {
        "today": {"start_utc": _iso_z(today_start), "end_utc": _iso_z(today_end)},
        "week": {"start_utc": _iso_z(week_start), "end_utc": _iso_z(week_end)},
        "month": {"start_utc": _iso_z(month_start), "end_utc": _iso_z(month_end)},
    }

    # Driver metadata map for labels/truck in dashboard rows.
    drivers_q = db.query(
        models.Driver.driver_id,
        models.Driver.name,
        models.Driver.role,
        models.Driver.truck_plate,
    )
    if scope_key == "self":
        drivers_q = drivers_q.filter(models.Driver.driver_id == current_driver.driver_id)
    driver_meta = {}
    for did, name, drole, plate in drivers_q.all():
        key = str(did or "").strip()
        if not key:
            continue
        driver_meta[key] = {
            "driver_id": key,
            "name": str(name or "").strip() or key,
            "role": authz.normalize_role(str(drole or "").strip()),
            "truck_plate": (str(plate or "").strip().upper() or None),
        }

    shipments_q = db.query(
        models.Shipment.awb,
        models.Shipment.status,
        models.Shipment.processing_status,
        models.Shipment.awb_status_date,
        models.Shipment.last_updated,
        models.Shipment.driver_id,
        models.Shipment.cod_amount,
        models.Shipment.shipping_cost,
        models.Shipment.estimated_shipping_cost,
    )
    if scope_key == "self":
        shipments_q = shipments_q.filter(models.Shipment.driver_id == current_driver.driver_id)

    counts = {"today": 0, "week": 0, "month": 0, "total": 0}
    selected_awbs = []
    driver_perf: Dict[str, Dict[str, object]] = {}
    daily_counts: Dict[str, int] = defaultdict(int)

    cod_total = 0.0
    shipping_total = 0.0
    estimated_total = 0.0
    payment_total = 0.0

    tz, _ = _business_timezone()
    for awb, status, processing_status, awb_status_date, last_updated, driver_id, cod_amount, shipping_cost, estimated_shipping_cost in shipments_q.all():
        if not _is_delivered_status(status, processing_status):
            continue
        delivered_at = _as_utc_naive(awb_status_date or last_updated)
        if not delivered_at:
            continue

        counts["total"] += 1
        if today_start <= delivered_at < today_end:
            counts["today"] += 1
        if week_start <= delivered_at < week_end:
            counts["week"] += 1
        if month_start <= delivered_at < month_end:
            counts["month"] += 1

        if not (selected_start <= delivered_at < selected_end):
            continue

        awb_key = str(awb or "").strip().upper()
        did = str(driver_id or "").strip() or None

        cod_val = _safe_float(cod_amount)
        ship_val = _safe_float(shipping_cost)
        est_val = _safe_float(estimated_shipping_cost)
        pay_val = ship_val if ship_val > 0 else est_val

        cod_total += cod_val
        shipping_total += ship_val
        estimated_total += est_val
        payment_total += pay_val

        selected_awbs.append(
            {
                "awb": awb_key,
                "driver_id": did,
                "status": postis_statuses.normalize_shipment_status(status),
                "delivered_at": _iso_z(delivered_at),
                "cod_amount": round(cod_val, 2),
                "payment_amount": round(pay_val, 2),
            }
        )

        local_date = delivered_at.replace(tzinfo=timezone.utc).astimezone(tz).date().isoformat()
        daily_counts[local_date] = int(daily_counts.get(local_date, 0)) + 1

        perf_key = did or "UNASSIGNED"
        entry = driver_perf.get(perf_key)
        if not entry:
            meta = driver_meta.get(did or "", {})
            entry = {
                "driver_id": did,
                "name": meta.get("name") or (did or "Unassigned"),
                "truck_plate": meta.get("truck_plate"),
                "deliveries": 0,
                "cod_total": 0.0,
                "payment_total": 0.0,
                "km_total": 0.0,
            }
            driver_perf[perf_key] = entry
        entry["deliveries"] = int(entry.get("deliveries") or 0) + 1
        entry["cod_total"] = _safe_float(entry.get("cod_total")) + cod_val
        entry["payment_total"] = _safe_float(entry.get("payment_total")) + pay_val

    selected_awbs.sort(key=lambda x: str(x.get("delivered_at") or ""), reverse=True)
    if len(selected_awbs) > awb_limit_n:
        selected_awbs = selected_awbs[:awb_limit_n]

    # Distance from location pings during selected window.
    loc_q = db.query(
        models.DriverLocation.driver_id,
        models.DriverLocation.latitude,
        models.DriverLocation.longitude,
        models.DriverLocation.timestamp,
    ).filter(
        models.DriverLocation.timestamp >= selected_start,
        models.DriverLocation.timestamp < selected_end,
    ).order_by(models.DriverLocation.driver_id.asc(), models.DriverLocation.timestamp.asc())
    if scope_key == "self":
        loc_q = loc_q.filter(models.DriverLocation.driver_id == current_driver.driver_id)

    prev_by_driver: Dict[str, Tuple[float, float]] = {}
    km_by_driver: Dict[str, float] = defaultdict(float)
    for did, lat, lon, _ts in loc_q.all():
        key = str(did or "").strip()
        if not key:
            continue
        try:
            la = float(lat)
            lo = float(lon)
        except Exception:
            continue
        if not (-90 <= la <= 90 and -180 <= lo <= 180):
            continue
        prev = prev_by_driver.get(key)
        if prev:
            seg = routing_service.calculate_haversine_distance(prev[0], prev[1], la, lo)
            if seg and seg > 0:
                km_by_driver[key] += float(seg)
        prev_by_driver[key] = (la, lo)

    total_km = 0.0
    for key, km in km_by_driver.items():
        total_km += km
        perf = driver_perf.get(key)
        if not perf:
            meta = driver_meta.get(key, {})
            perf = {
                "driver_id": key,
                "name": meta.get("name") or key,
                "truck_plate": meta.get("truck_plate"),
                "deliveries": 0,
                "cod_total": 0.0,
                "payment_total": 0.0,
                "km_total": 0.0,
            }
            driver_perf[key] = perf
        perf["km_total"] = _safe_float(perf.get("km_total")) + km

    drivers_out = list(driver_perf.values())
    for d in drivers_out:
        d["cod_total"] = round(_safe_float(d.get("cod_total")), 2)
        d["payment_total"] = round(_safe_float(d.get("payment_total")), 2)
        d["km_total"] = round(_safe_float(d.get("km_total")), 2)
    drivers_out.sort(
        key=lambda d: (
            -int(d.get("deliveries") or 0),
            -_safe_float(d.get("km_total")),
            str(d.get("driver_id") or ""),
        )
    )

    daily_out = [
        {"date": day, "delivered_count": int(cnt)}
        for day, cnt in sorted(daily_counts.items())
    ]

    return {
        "generated_at": datetime.utcnow().isoformat() + "Z",
        "timezone": tz_name,
        "scope": scope_key,
        "period": period_key,
        "ranges": ranges,
        "counts": counts,
        "selected": {
            "period": period_key,
            "start_utc": _iso_z(selected_start),
            "end_utc": _iso_z(selected_end),
            "delivered_count": int(len(selected_awbs)),
            "cod_total": round(cod_total, 2),
            "shipping_total": round(shipping_total, 2),
            "estimated_shipping_total": round(estimated_total, 2),
            "payment_total": round(payment_total, 2),
            "km_total": round(total_km, 2),
            "drivers": drivers_out,
            "daily": daily_out,
            "awbs": selected_awbs,
        },
    }


def _shipment_bucket(status: Optional[str]) -> str:
    s = str(status or "").strip().casefold()
    if not s:
        return "unknown"
    if "delivered" in s or "livrat" in s:
        return "delivered"
    if "return" in s or "returnat" in s or "returnata" in s:
        return "returned"
    if "cancel" in s or "anulat" in s or "anulata" in s:
        return "cancelled"
    if "refuz" in s or "refus" in s:
        return "refused"
    return "active"


def _iso(dt: Optional[datetime]) -> Optional[str]:
    return dt.isoformat() if dt else None


@app.get("/analytics")
async def get_analytics(
    scope: str = "self",
    awb_limit: int = 200,
    db: Session = Depends(database.get_db),
    current_driver: models.Driver = Depends(permission_required(authz.PERM_STATS_READ)),
):
    """
    Mobile-friendly analytics for trucks, drivers, AWBs and event IDs.

    - scope=self: only the current driver's records
    - scope=all: requires a role that can view all logs (Admin/Manager/Dispatcher/Support/Finance)
    """
    role = authz.normalize_role(current_driver.role)
    scope_norm = (scope or "self").strip().lower()
    if scope_norm not in ("self", "all"):
        raise HTTPException(status_code=400, detail="Invalid scope. Use scope=self or scope=all")
    if scope_norm == "all" and not authz.can_view_all_logs(role):
        raise HTTPException(status_code=403, detail="Not enough permissions for scope=all")

    try:
        awb_limit_n = int(awb_limit or 200)
    except Exception:
        awb_limit_n = 200
    awb_limit_n = max(10, min(awb_limit_n, 2000))

    # Ensure any runtime migrations for shipments have been applied.
    shipments_service.ensure_shipments_schema(db)

    if scope_norm == "all":
        drivers = db.query(models.Driver).order_by(models.Driver.driver_id.asc()).all()
        driver_ids = {d.driver_id for d in drivers if d and d.driver_id}
    else:
        drivers = [current_driver]
        driver_ids = {current_driver.driver_id}

    # Map drivers -> base stats row (even if they have 0 activity).
    driver_stats = {}
    for d in drivers:
        driver_stats[d.driver_id] = {
            "driver_id": d.driver_id,
            "name": d.name,
            "username": d.username,
            "role": authz.normalize_role(d.role),
            "active": bool(d.active),
            "last_login": _iso(d.last_login),
            "truck_plate": (d.truck_plate or "").strip() or None,
            "truck_phone": (d.phone_number or "").strip() or None,
            "helper_name": (d.helper_name or "").strip() or None,
            "updates_total": 0,
            "updates_success": 0,
            "updates_failed": 0,
            "last_update": None,
            "shipments_total": 0,
            "shipments_by_status": {},
            "shipments_by_bucket": {
                "active": 0,
                "delivered": 0,
                "returned": 0,
                "cancelled": 0,
                "refused": 0,
                "unknown": 0,
            },
        }

    shipments_query = db.query(models.Shipment.awb, models.Shipment.status, models.Shipment.driver_id)
    logs_query = db.query(
        models.LogEntry.driver_id,
        models.LogEntry.awb,
        models.LogEntry.event_id,
        models.LogEntry.outcome,
        models.LogEntry.timestamp,
    )

    if scope_norm == "self":
        shipments_query = shipments_query.filter(models.Shipment.driver_id == current_driver.driver_id)
        logs_query = logs_query.filter(models.LogEntry.driver_id == current_driver.driver_id)

    shipment_rows = shipments_query.all()
    log_rows = logs_query.all()

    # Preload status option labels for event charts.
    options = _ensure_status_options(db)
    option_by_id = {opt.event_id: opt for opt in options}

    totals = {
        "shipments_total": 0,
        "updates_total": 0,
        "updates_success": 0,
        "updates_failed": 0,
        "unique_awbs": 0,
    }

    awb_stats = {}

    for awb, status, driver_id in shipment_rows:
        key = str(awb or "").strip().upper()
        if not key:
            continue

        did = str(driver_id or "").strip() or None
        if scope_norm == "all" and did and did not in driver_ids:
            # Keep unknown driver_ids in the AWB list but don't attribute them to a driver card.
            did = did

        status_txt = postis_statuses.normalize_shipment_status(status)
        bucket = _shipment_bucket(status_txt)

        if did and did in driver_stats:
            ds = driver_stats[did]
            ds["shipments_total"] += 1
            ds["shipments_by_status"][status_txt] = int(ds["shipments_by_status"].get(status_txt, 0)) + 1
            ds["shipments_by_bucket"][bucket] = int(ds["shipments_by_bucket"].get(bucket, 0)) + 1

        totals["shipments_total"] += 1

        entry = awb_stats.get(key)
        if not entry:
            entry = {
                "awb": key,
                "status": status_txt,
                "driver_id": did,
                "updates_total": 0,
                "updates_success": 0,
                "updates_failed": 0,
                "last_update": None,
                "last_event_id": None,
                "last_outcome": None,
            }
            awb_stats[key] = entry
        else:
            # Prefer shipment view as the authoritative status for listing.
            entry["status"] = status_txt
            if did and not entry.get("driver_id"):
                entry["driver_id"] = did

    event_stats = {}

    for did, awb, event_id, outcome, timestamp in log_rows:
        did_norm = str(did or "").strip() or None
        awb_key = str(awb or "").strip().upper()
        eid = str(event_id or "").strip() or "Unknown"
        out = str(outcome or "").strip().upper() or "UNKNOWN"
        ts = timestamp if isinstance(timestamp, datetime) else None

        totals["updates_total"] += 1
        if out == "SUCCESS":
            totals["updates_success"] += 1
        elif out:
            totals["updates_failed"] += 1

        if did_norm and did_norm in driver_stats:
            ds = driver_stats[did_norm]
            ds["updates_total"] += 1
            if out == "SUCCESS":
                ds["updates_success"] += 1
            else:
                ds["updates_failed"] += 1
            if ts and (ds["last_update"] is None or ts > ds["last_update"]):
                ds["last_update"] = ts

        if awb_key:
            entry = awb_stats.get(awb_key)
            if not entry:
                entry = {
                    "awb": awb_key,
                    "status": None,
                    "driver_id": did_norm,
                    "updates_total": 0,
                    "updates_success": 0,
                    "updates_failed": 0,
                    "last_update": None,
                    "last_event_id": None,
                    "last_outcome": None,
                }
                awb_stats[awb_key] = entry

            entry["updates_total"] += 1
            if out == "SUCCESS":
                entry["updates_success"] += 1
            else:
                entry["updates_failed"] += 1

            if ts and (entry["last_update"] is None or ts > entry["last_update"]):
                entry["last_update"] = ts
                entry["last_event_id"] = eid
                entry["last_outcome"] = out

        ev = event_stats.get(eid)
        if not ev:
            opt = option_by_id.get(eid)
            ev = {
                "event_id": eid,
                "label": getattr(opt, "label", None),
                "description": getattr(opt, "description", None),
                "total": 0,
                "success": 0,
                "failed": 0,
            }
            event_stats[eid] = ev
        ev["total"] += 1
        if out == "SUCCESS":
            ev["success"] += 1
        else:
            ev["failed"] += 1

    # Finalize driver rows (serialize last_update).
    drivers_out = []
    for ds in driver_stats.values():
        ds["last_update"] = _iso(ds["last_update"])
        drivers_out.append(ds)

    drivers_out.sort(key=lambda d: (d.get("driver_id") or ""))

    # Build truck rollups (truck_plate -> aggregated counts).
    trucks = {}
    for ds in drivers_out:
        plate = str(ds.get("truck_plate") or "").strip().upper()
        if not plate:
            plate = "UNASSIGNED"

        t = trucks.get(plate)
        if not t:
            t = {
                "truck_plate": plate if plate != "UNASSIGNED" else None,
                "truck_phone": ds.get("truck_phone"),
                "drivers": [],
                "shipments_total": 0,
                "shipments_by_bucket": {
                    "active": 0,
                    "delivered": 0,
                    "returned": 0,
                    "cancelled": 0,
                    "refused": 0,
                    "unknown": 0,
                },
                "updates_total": 0,
                "updates_success": 0,
                "updates_failed": 0,
                "last_update": None,
            }
            trucks[plate] = t

        if not t.get("truck_phone"):
            t["truck_phone"] = ds.get("truck_phone")

        t["drivers"].append(
            {
                "driver_id": ds.get("driver_id"),
                "name": ds.get("name"),
                "role": ds.get("role"),
            }
        )

        t["shipments_total"] += int(ds.get("shipments_total") or 0)
        for k, v in (ds.get("shipments_by_bucket") or {}).items():
            if k in t["shipments_by_bucket"]:
                t["shipments_by_bucket"][k] += int(v or 0)

        t["updates_total"] += int(ds.get("updates_total") or 0)
        t["updates_success"] += int(ds.get("updates_success") or 0)
        t["updates_failed"] += int(ds.get("updates_failed") or 0)

        last_u = ds.get("last_update")
        if last_u:
            try:
                last_dt = datetime.fromisoformat(str(last_u))
            except Exception:
                last_dt = None
            if last_dt and (t["last_update"] is None or last_dt > t["last_update"]):
                t["last_update"] = last_dt

    trucks_out = []
    for t in trucks.values():
        t["last_update"] = _iso(t["last_update"])
        # Sort drivers within truck for a stable list.
        t["drivers"] = sorted(t["drivers"], key=lambda d: str(d.get("driver_id") or ""))
        trucks_out.append(t)
    trucks_out.sort(key=lambda t: str(t.get("truck_plate") or "ZZZ"))

    # AWB list: sort by last update (desc), then awb. Convert last_update to ISO.
    awbs_out = list(awb_stats.values())
    for a in awbs_out:
        a["last_update"] = _iso(a.get("last_update"))
    awbs_out.sort(key=lambda a: (a.get("last_update") or "", a.get("awb") or ""), reverse=True)
    awbs_out = awbs_out[:awb_limit_n]

    events_out = list(event_stats.values())
    events_out.sort(key=lambda e: str(e.get("event_id") or ""))

    totals["unique_awbs"] = len(awb_stats)

    return {
        "generated_at": datetime.utcnow().isoformat() + "Z",
        "scope": scope_norm,
        "role": role,
        "drivers": drivers_out,
        "trucks": trucks_out,
        "awbs": awbs_out,
        "events": events_out,
        "totals": totals,
    }


@app.get("/cod/report")
async def cod_report(
    start_date: Optional[str] = None,
    end_date: Optional[str] = None,
    driver_id: Optional[str] = None,
    limit: int = 2000,
    db: Session = Depends(database.get_db),
    current_driver: models.Driver = Depends(permission_required(authz.PERM_COD_READ)),
):
    """
    COD reconciliation report.
    """
    role = authz.normalize_role(current_driver.role)
    did = str(driver_id or "").strip().upper() or None

    # Drivers can only request their own report.
    if role == authz.ROLE_DRIVER and did and did != str(current_driver.driver_id or "").strip().upper():
        raise HTTPException(status_code=403, detail="Not enough permissions")
    if role == authz.ROLE_DRIVER and not did:
        did = str(current_driver.driver_id or "").strip().upper() or None

    start_dt = None
    end_dt = None
    if start_date:
        try:
            start_dt = datetime.fromisoformat(str(start_date))
        except Exception:
            start_dt = None
    if end_date:
        try:
            end_dt = datetime.fromisoformat(str(end_date))
        except Exception:
            end_dt = None

    return cod_service.compute_cod_report(db, date_from=start_dt, date_to=end_dt, driver_id=did, limit=limit)


@app.get("/logs", response_model=List[schemas.LogEntrySchema])
async def get_logs(
    awb: str = None, 
    start_date: str = None, 
    end_date: str = None, 
    limit: int = 100,
    db: Session = Depends(database.get_db), 
    current_driver: models.Driver = Depends(permission_required(authz.PERM_LOGS_READ_SELF))
):
    query = db.query(models.LogEntry)
    
    # Only some roles can view all logs. Everyone else sees only their own activity.
    if not authz.can_view_all_logs(current_driver.role):
        query = query.filter(models.LogEntry.driver_id == current_driver.driver_id)
    
    if awb:
        query = query.filter(models.LogEntry.awb == awb)
        
    if start_date:
        try:
            start_dt = datetime.fromisoformat(start_date)
            query = query.filter(models.LogEntry.timestamp >= start_dt)
        except ValueError:
            pass
            
    if end_date:
        try:
            end_dt = datetime.fromisoformat(end_date)
            query = query.filter(models.LogEntry.timestamp <= end_dt)
        except ValueError:
            pass
            
    try:
        limit_n = int(limit or 100)
    except Exception:
        limit_n = 100
    limit_n = max(1, min(limit_n, 2000))

    return query.order_by(models.LogEntry.timestamp.desc()).limit(limit_n).all()

@app.get("/shipments", response_model=List[schemas.ShipmentSchema])
async def get_shipments(
    db: Session = Depends(database.get_db),
    current_driver: models.Driver = Depends(permission_required(authz.PERM_SHIPMENTS_READ))
):
    """
    Get all shipments from the database.
    This endpoint now serves shipments that have been imported from Postis.
    """
    try:
        shipments_service.ensure_shipments_schema(db)
        # RBAC: Filter by driver_id if rule is Driver
        role = authz.normalize_role(current_driver.role)
        query = db.query(models.Shipment)
        
        if role == authz.ROLE_DRIVER:
            my_driver_id = str(current_driver.driver_id or "").strip().upper()
            candidate_shipments = query.all()
            shipments = []
            for ship in candidate_shipments:
                ship_driver_id = str(getattr(ship, "driver_id", "") or "").strip().upper()
                if ship_driver_id and ship_driver_id == my_driver_id:
                    shipments.append(ship)
                    continue
                # Also expose unassigned AWBs in actionable statuses so drivers can add them to their route.
                if not ship_driver_id and _is_driver_pool_status(getattr(ship, "status", None), getattr(ship, "processing_status", None)):
                    shipments.append(ship)
        elif role == authz.ROLE_RECIPIENT:
            # Recipients can only see shipments where they are the recipient (phone match).
            phone_norm = _resolve_user_phone_norm(db, current_driver)

            if phone_norm:
                query = query.filter(models.Shipment.recipient_phone_norm == phone_norm)
            else:
                query = query.filter(models.Shipment.id == -1)
            shipments = query.all()
        else:
            shipments = query.all()
        
        results = []
        for ship in shipments:
            base = shipments_service.shipment_to_dict(ship, include_raw_data=False, include_events=False, db=db)
            pin = base.get("recipient_pin") or {}
            if not isinstance(pin, dict):
                pin = {}

            # Keep list payload light, but include enough nested data for map/county fallbacks.
            base["raw_data"] = {
                "client": ship.client_data,
                "recipientLocation": ship.recipient_location,
                "recipientPin": pin or None,
                "senderLocation": ship.sender_location,
                "courier": ship.courier_data,
                "additionalServices": ship.additional_services,
                "productCategory": ship.product_category_data,
                "clientShipmentStatus": ship.client_shipment_status_data,
            }
            results.append(base)
        
        logger.info(f"Returning {len(results)} shipments from database")
        return results
    
    except Exception as e:
        logger.error(f"Error fetching shipments from database: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Failed to fetch shipments: {str(e)}")

@app.get("/shipments/{awb}", response_model=schemas.ShipmentSchema)
async def get_shipment(
    awb: str,
    refresh: bool = False,
    db: Session = Depends(database.get_db),
    current_driver: models.Driver = Depends(permission_required(authz.PERM_SHIPMENT_READ)),
):
    try:
        shipments_service.ensure_shipments_schema(db)
        role = authz.normalize_role(current_driver.role)

        candidates = postis_client.candidates_with_optional_parcel_suffix_stripped(awb)
        if not candidates:
            fallback = postis_client.normalize_shipment_identifier(awb) or str(awb or "").strip().upper()
            if fallback:
                candidates = [fallback]
        ship = None
        for cand in candidates:
            ship = db.query(models.Shipment).filter(models.Shipment.awb == cand).first()
            if ship:
                break

        if ship and not refresh:
            if role == authz.ROLE_RECIPIENT:
                phone_norm = _resolve_user_phone_norm(db, current_driver)
                ship_phone_norm = ship.recipient_phone_norm or phone_service.normalize_phone(ship.recipient_phone or "")
                if not phone_norm or not ship_phone_norm or ship_phone_norm != phone_norm:
                    raise HTTPException(status_code=403, detail="Not enough permissions")
            return shipments_service.shipment_to_dict(ship, include_raw_data=True, include_events=True, db=db)

        data = {}
        for cand in candidates:
            data = await p_client.get_shipment_tracking_by_awb_or_client_order_id(cand)
            if data:
                break

        # If a forced refresh was requested but Postis lookup fails, return cached DB data
        # instead of a hard 404 so drivers can still operate with known shipment details.
        if not data and ship:
            if role == authz.ROLE_RECIPIENT:
                phone_norm = _resolve_user_phone_norm(db, current_driver)
                ship_phone_norm = ship.recipient_phone_norm or phone_service.normalize_phone(ship.recipient_phone or "")
                if not phone_norm or not ship_phone_norm or ship_phone_norm != phone_norm:
                    raise HTTPException(status_code=403, detail="Not enough permissions")
            return shipments_service.shipment_to_dict(ship, include_raw_data=True, include_events=True, db=db)

        if not data:
            raise HTTPException(status_code=404, detail="Shipment not found")

        ship = shipments_service.upsert_shipment_and_events(db, data)
        db.commit()
        if role == authz.ROLE_RECIPIENT:
            phone_norm = _resolve_user_phone_norm(db, current_driver)
            ship_phone_norm = ship.recipient_phone_norm or phone_service.normalize_phone(ship.recipient_phone or "")
            if not phone_norm or not ship_phone_norm or ship_phone_norm != phone_norm:
                raise HTTPException(status_code=403, detail="Not enough permissions")
        return shipments_service.shipment_to_dict(ship, include_raw_data=True, include_events=True, db=db)
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error in get_shipment({awb}): {str(e)}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/shipments/{awb}/allocate")
async def allocate_shipment(
    awb: str,
    request: schemas.ShipmentAllocateRequest,
    db: Session = Depends(database.get_db),
    current_driver: models.Driver = Depends(permission_required(authz.PERM_SHIPMENTS_ASSIGN)),
):
    """
    Allocate a shipment to a driver/truck.

    Side-effects:
    - Auto-create a Recipient account (if missing) based on shipment recipient phone.
    - Create an in-app notification for the recipient.
    - Send a WhatsApp message to the recipient (best-effort, if configured).
    """
    drivers_service.ensure_drivers_schema(db)
    shipments_service.ensure_shipments_schema(db)
    notifications_service.ensure_notifications_schema(db)

    identifier = postis_client.normalize_shipment_identifier(awb) or awb
    ship = _find_shipment_by_awb(db, identifier)
    if not ship:
        raise HTTPException(status_code=404, detail="Shipment not found")

    target_id = str(request.driver_id or "").strip().upper()
    if not target_id:
        raise HTTPException(status_code=400, detail="driver_id is required")

    target = db.query(models.Driver).filter(models.Driver.driver_id == target_id).first()
    if not target:
        raise HTTPException(status_code=404, detail="Target driver not found")
    if not target.active:
        raise HTTPException(status_code=400, detail="Target driver is inactive")

    target_role = authz.normalize_role(target.role)
    if target_role == authz.ROLE_RECIPIENT:
        raise HTTPException(status_code=400, detail="Cannot allocate shipments to Recipient accounts")

    # Keep allocations tied to real trucks when possible.
    if not (str(target.truck_plate or "").strip() or target_role == authz.ROLE_DRIVER):
        raise HTTPException(status_code=400, detail="Target user has no truck allocation")

    prev_driver_id = ship.driver_id
    ship.driver_id = target.driver_id
    ship.last_updated = datetime.utcnow()

    # Ensure phone normalization for shipment (older DB rows may lack it).
    if ship.recipient_phone and not ship.recipient_phone_norm:
        ship.recipient_phone_norm = phone_service.normalize_phone(ship.recipient_phone)

    recipient_user = None
    recipient_username = None
    temp_password = None

    phone_norm = ship.recipient_phone_norm or phone_service.normalize_phone(ship.recipient_phone or "")
    if phone_norm:
        recipient_user = (
            db.query(models.Driver)
            .filter(models.Driver.role == authz.ROLE_RECIPIENT, models.Driver.phone_norm == phone_norm)
            .first()
        )
        if not recipient_user:
            temp_password = f"{secrets.randbelow(1000000):06d}"
            recipient_username = phone_norm
            recipient_user = models.Driver(
                driver_id=_unique_driver_id(db, f"R{phone_norm}"),
                name=ship.recipient_name or "Recipient",
                username=recipient_username,
                password_hash=driver_manager.get_password_hash(temp_password),
                role=authz.ROLE_RECIPIENT,
                active=True,
                phone_number=ship.recipient_phone,
                phone_norm=phone_norm,
            )
            db.add(recipient_user)
        else:
            recipient_username = recipient_user.username
            recipient_user.active = True
            recipient_user.role = authz.ROLE_RECIPIENT
            if not recipient_user.phone_norm:
                recipient_user.phone_norm = phone_norm
            if not recipient_user.phone_number and ship.recipient_phone:
                recipient_user.phone_number = ship.recipient_phone
            if ship.recipient_name and (not recipient_user.name or recipient_user.name.strip().lower() in ("recipient", "customer", "client")):
                recipient_user.name = ship.recipient_name

        plate = str(target.truck_plate or "").strip().upper() or "Unassigned"
        truck_phone = str(target.phone_number or "").strip() or None

        title = "Delivery allocated"
        body = f"AWB {ship.awb} was allocated to truck {plate}."
        if truck_phone:
            body += f" Truck phone: {truck_phone}."

        # Best-effort: ensure a shipment-linked chat thread exists and enroll the key participants.
        chat_thread_id = None
        try:
            if chat_service.ensure_chat_schema(db):
                t = chat_service.get_or_create_awb_thread(
                    db,
                    awb=ship.awb,
                    created_by_user_id=current_driver.driver_id,
                    created_by_role=authz.normalize_role(current_driver.role),
                )
                if t:
                    chat_thread_id = t.id
                    chat_service.ensure_participant(db, thread_id=t.id, user_id=current_driver.driver_id, role=authz.normalize_role(current_driver.role))
                    chat_service.ensure_participant(db, thread_id=t.id, user_id=target.driver_id, role=target_role)
                    chat_service.ensure_participant(db, thread_id=t.id, user_id=recipient_user.driver_id, role=authz.ROLE_RECIPIENT)
        except Exception:
            chat_thread_id = None

        notifications_service.create_notification(
            db,
            user_id=recipient_user.driver_id,
            title=title,
            body=body,
            awb=ship.awb,
            data={
                "awb": ship.awb,
                "truck_plate": plate if plate != "Unassigned" else None,
                "truck_phone": truck_phone,
                "driver_id": target.driver_id,
                "driver_name": target.name,
                "chat_thread_id": chat_thread_id,
            },
        )

    db.commit()

    # Best-effort WhatsApp notification (do after commit).
    if ship.recipient_phone and phone_norm:
        plate = str(target.truck_plate or "").strip().upper() or "Unassigned"
        truck_phone = str(target.phone_number or "").strip() or ""
        msg = f"Delivery allocated\\nAWB: {ship.awb}\\nTruck: {plate}"
        if truck_phone:
            msg += f"\\nTruck phone: {truck_phone}"
        if temp_password:
            msg += f"\\n\\nTrack in app\\nLogin: your phone number\\nPassword: {temp_password}"
        whatsapp_service.send_whatsapp_message(ship.recipient_phone, msg)

    return {
        "status": "ok",
        "awb": ship.awb,
        "previous_driver_id": prev_driver_id,
        "allocated_driver_id": ship.driver_id,
        "recipient_user_id": getattr(recipient_user, "driver_id", None) if recipient_user else None,
        "recipient_username": recipient_username,
        "recipient_temp_password": temp_password,
    }

@app.post("/shipments/labels/batch")
async def get_shipments_labels_batch(
    request: schemas.ShipmentLabelsBatchRequest,
    current_driver: models.Driver = Depends(permission_required(authz.PERM_LABEL_READ)),
):
    """
    Fetch and merge multiple Postis shipment label PDFs into a single printable PDF.

    Used by dispatchers for morning batch printing.
    """
    awbs = _normalized_unique_awbs(request.awbs)
    if not awbs:
        raise HTTPException(status_code=400, detail="No AWBs provided")
    if len(awbs) > 200:
        raise HTTPException(status_code=400, detail="Too many AWBs (max 200 per batch)")

    semaphore = asyncio.Semaphore(8)

    async def _fetch_label_for_awb(awb_key: str):
        async with semaphore:
            candidates = postis_client.candidates_with_optional_parcel_suffix_stripped(awb_key)
            if not candidates:
                fallback = postis_client.normalize_shipment_identifier(awb_key) or awb_key
                if fallback:
                    candidates = [fallback]

            for cand in candidates:
                try:
                    label_bytes = await p_client.get_shipment_label(cand)
                except Exception:
                    label_bytes = None
                if label_bytes:
                    return awb_key, cand, label_bytes

            return awb_key, None, None

    results = await asyncio.gather(*[_fetch_label_for_awb(awb) for awb in awbs])

    # Lazy import so the app can still boot if pypdf is temporarily unavailable.
    try:
        from pypdf import PdfReader, PdfWriter
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"PDF merge library unavailable: {str(e)}")

    writer = PdfWriter()
    merged_awbs: List[str] = []
    missing_awbs: List[str] = []

    for requested_awb, resolved_awb, label_bytes in results:
        if not label_bytes:
            missing_awbs.append(requested_awb)
            continue
        try:
            reader = PdfReader(io.BytesIO(label_bytes))
            page_count = len(reader.pages or [])
            if page_count <= 0:
                missing_awbs.append(requested_awb)
                continue
            for page in reader.pages:
                writer.add_page(page)
            merged_awbs.append(resolved_awb or requested_awb)
        except Exception:
            missing_awbs.append(requested_awb)

    if not merged_awbs:
        raise HTTPException(status_code=404, detail="No labels found for requested AWBs")

    out = io.BytesIO()
    writer.write(out)
    merged_pdf = out.getvalue()

    ts = datetime.utcnow().strftime("%Y%m%d_%H%M%S")
    missing_preview = ",".join(missing_awbs[:25]) if missing_awbs else ""

    headers = {
        "Content-Disposition": f'inline; filename="labels_batch_{ts}.pdf"',
        "X-Labels-Requested": str(len(awbs)),
        "X-Labels-Found": str(len(merged_awbs)),
        "X-Labels-Missing": str(len(missing_awbs)),
        "X-Labels-Missing-AWBS": missing_preview,
    }

    return Response(
        content=merged_pdf,
        media_type="application/pdf",
        headers=headers,
    )


@app.get("/shipments/{awb}/label")
async def get_shipment_label(
    awb: str,
    current_driver: models.Driver = Depends(permission_required(authz.PERM_LABEL_READ)),
):
    candidates = postis_client.candidates_with_optional_parcel_suffix_stripped(awb)
    if not candidates:
        fallback = postis_client.normalize_shipment_identifier(awb) or str(awb or "").strip().upper()
        if fallback:
            candidates = [fallback]

    label_bytes = None
    label_awb = str(awb or "").strip().upper()
    for cand in candidates:
        label_bytes = await p_client.get_shipment_label(cand)
        if label_bytes:
            label_awb = cand
            break

    if not label_bytes:
        raise HTTPException(status_code=404, detail="Label not found")
    return Response(
        content=label_bytes,
        media_type="application/pdf",
        headers={
            "Content-Disposition": f'inline; filename="label_{label_awb}.pdf"'
        },
    )


@app.get("/shipments/{awb}/pod")
async def get_shipment_pod(
    awb: str,
    db: Session = Depends(database.get_db),
    current_driver: models.Driver = Depends(permission_required(authz.PERM_POD_READ)),
):
    """
    Return the latest proof-of-delivery payload we stored alongside the Delivered update.

    POD is stored inside log_entries.payload (JSON) to keep the system deployable
    without object storage.
    """
    candidates = postis_client.candidates_with_optional_parcel_suffix_stripped(awb)
    if not candidates:
        fallback = postis_client.normalize_shipment_identifier(awb) or str(awb or "").strip().upper()
        if fallback:
            candidates = [fallback]
    if not candidates:
        raise HTTPException(status_code=400, detail="awb is required")

    key = ""
    log = None
    for cand in candidates:
        q = (
            db.query(models.LogEntry)
            .filter(models.LogEntry.awb == cand, models.LogEntry.event_id == "2", models.LogEntry.outcome == "SUCCESS")
            .order_by(models.LogEntry.timestamp.desc())
        )
        log = q.first()
        if log:
            key = cand
            break

    if not log:
        raise HTTPException(status_code=404, detail="POD not found")

    payload = log.payload if isinstance(log.payload, dict) else {}
    pod = payload.get("pod") if isinstance(payload, dict) else None
    return {
        "awb": key,
        "log_id": log.id,
        "timestamp": log.timestamp.isoformat() if log.timestamp else None,
        "driver_id": log.driver_id,
        "pod": pod,
    }


@app.patch("/shipments/{awb}/instructions")
async def update_shipment_instructions(
    awb: str,
    request: schemas.ShipmentInstructionsUpdate,
    db: Session = Depends(database.get_db),
    current_driver: models.Driver = Depends(permission_required(authz.PERM_SHIPMENT_READ)),
):
    """
    Update delivery instructions stored in our DB (not pushed to Postis).

    RBAC:
    - Recipient: only for shipments they own (phone match)
    - Driver: only for shipments allocated to them
    - Internal roles: allowed
    """
    shipments_service.ensure_shipments_schema(db)
    notifications_service.ensure_notifications_schema(db)

    identifier = postis_client.normalize_shipment_identifier(awb) or awb
    ship = _find_shipment_by_awb(db, identifier)
    if not ship:
        raise HTTPException(status_code=404, detail="Shipment not found")

    role = authz.normalize_role(current_driver.role)
    if role == authz.ROLE_RECIPIENT:
        if not _shipment_recipient_authorized(db, current_driver=current_driver, ship=ship):
            raise HTTPException(status_code=403, detail="Not enough permissions")
    elif role == authz.ROLE_DRIVER:
        if str(ship.driver_id or "").strip().upper() != str(current_driver.driver_id or "").strip().upper():
            raise HTTPException(status_code=403, detail="Not enough permissions")

    instructions = str(request.instructions or "").strip()
    if not instructions:
        ship.recipient_instructions = None
    else:
        ship.recipient_instructions = instructions[:2000]
    ship.last_updated = datetime.utcnow()
    db.commit()

    # Notify the allocated driver (if recipient changed instructions).
    if role == authz.ROLE_RECIPIENT and ship.driver_id:
        notifications_service.create_notification(
            db,
            user_id=ship.driver_id,
            title="Recipient updated instructions",
            body=f"AWB {ship.awb}: {instructions[:180] if instructions else '(cleared)'}",
            awb=ship.awb,
            data={"type": "instructions_update", "awb": ship.awb},
        )
        db.commit()

    return {
        "status": "ok",
        "awb": ship.awb,
        "delivery_instructions": ship.delivery_instructions,
        "recipient_instructions": ship.recipient_instructions,
    }


@app.post("/shipments/{awb}/reschedule-request")
async def request_reschedule(
    awb: str,
    request: schemas.ShipmentRescheduleRequest,
    db: Session = Depends(database.get_db),
    current_driver: models.Driver = Depends(permission_required(authz.PERM_SHIPMENT_READ)),
):
    """
    Recipient self-service: request a reschedule.

    This does NOT push event_id=7 to Postis automatically (that is an ops decision),
    but it notifies dispatch/support and adds a system message into the shipment chat thread.
    """
    drivers_service.ensure_drivers_schema(db)
    shipments_service.ensure_shipments_schema(db)
    notifications_service.ensure_notifications_schema(db)

    identifier = postis_client.normalize_shipment_identifier(awb) or awb
    ship = _find_shipment_by_awb(db, identifier)
    if not ship:
        raise HTTPException(status_code=404, detail="Shipment not found")

    role = authz.normalize_role(current_driver.role)
    if role == authz.ROLE_RECIPIENT and not _shipment_recipient_authorized(db, current_driver=current_driver, ship=ship):
        raise HTTPException(status_code=403, detail="Not enough permissions")

    desired_at = str(request.desired_at or "").strip() or None
    reason_code = str(request.reason_code or "").strip() or None
    note = str(request.note or "").strip() or None

    title = "Reschedule requested"
    who = current_driver.name or current_driver.username or current_driver.driver_id
    body = f"AWB {ship.awb}: {who} requested reschedule."
    if desired_at:
        body += f" Desired: {desired_at}."
    if reason_code:
        body += f" Reason: {reason_code}."
    if note:
        body += f" Note: {note[:120]}."

    # Notify internal ops roles (best-effort broadcast).
    internal_roles = {authz.ROLE_ADMIN, authz.ROLE_MANAGER, authz.ROLE_DISPATCHER, authz.ROLE_SUPPORT}
    users = db.query(models.Driver).filter(models.Driver.active.is_(True)).all()
    for u in users:
        if authz.normalize_role(u.role) in internal_roles:
            notifications_service.create_notification(
                db,
                user_id=u.driver_id,
                title=title,
                body=body,
                awb=ship.awb,
                data={
                    "type": "reschedule_request",
                    "awb": ship.awb,
                    "desired_at": desired_at,
                    "reason_code": reason_code,
                },
            )

    # Also notify the allocated driver (if any).
    if ship.driver_id:
        notifications_service.create_notification(
            db,
            user_id=ship.driver_id,
            title=title,
            body=body,
            awb=ship.awb,
            data={
                "type": "reschedule_request",
                "awb": ship.awb,
                "desired_at": desired_at,
                "reason_code": reason_code,
            },
        )

    # Add a chat system message so the conversation stays linked to the shipment.
    try:
        if chat_service.ensure_chat_schema(db):
            t = chat_service.get_or_create_awb_thread(
                db,
                awb=ship.awb,
                created_by_user_id=current_driver.driver_id,
                created_by_role=role,
            )
            if t:
                chat_service.ensure_participant(db, thread_id=t.id, user_id=current_driver.driver_id, role=role)
                if ship.driver_id:
                    driver = db.query(models.Driver).filter(models.Driver.driver_id == ship.driver_id).first()
                    if driver:
                        chat_service.ensure_participant(db, thread_id=t.id, user_id=driver.driver_id, role=authz.normalize_role(driver.role))

                msg_text = body
                db.add(
                    models.ChatMessage(
                        thread_id=t.id,
                        created_at=datetime.utcnow(),
                        sender_user_id=current_driver.driver_id,
                        sender_role=role,
                        message_type="system",
                        text=msg_text[:500],
                        data={
                            "type": "reschedule_request",
                            "desired_at": desired_at,
                            "reason_code": reason_code,
                            "note": note,
                        },
                    )
                )
                t.last_message_at = datetime.utcnow()
    except Exception:
        pass

    db.commit()
    return {"status": "ok", "awb": ship.awb}


@app.post("/shipments/{awb}/pay-link")
async def get_payment_link(
    awb: str,
    db: Session = Depends(database.get_db),
    current_driver: models.Driver = Depends(permission_required(authz.PERM_SHIPMENT_READ)),
):
    """
    Recipient self-service: return a payment link for COD (if configured).

    This endpoint is intentionally provider-agnostic; set PAYMENT_LINK_BASE_URL
    and the app can deep-link into a payment page you host.
    """
    shipments_service.ensure_shipments_schema(db)
    identifier = postis_client.normalize_shipment_identifier(awb) or awb
    ship = _find_shipment_by_awb(db, identifier)
    if not ship:
        raise HTTPException(status_code=404, detail="Shipment not found")

    role = authz.normalize_role(current_driver.role)
    if role == authz.ROLE_RECIPIENT and not _shipment_recipient_authorized(db, current_driver=current_driver, ship=ship):
        raise HTTPException(status_code=403, detail="Not enough permissions")

    base = str(os.getenv("PAYMENT_LINK_BASE_URL") or "").strip().rstrip("/")
    if not base:
        raise HTTPException(status_code=503, detail="Payment links not configured")

    cod_amount = getattr(ship, "cod_amount", None) or 0
    url = f"{base}?awb={ship.awb}&amount={cod_amount}"
    return {"status": "ok", "awb": ship.awb, "amount": cod_amount, "url": url}


# [NEW] Warehouse manifests (load-out / return scans)
@app.post("/manifests", response_model=schemas.ManifestSchema, status_code=201)
async def create_manifest(
    request: schemas.ManifestCreate,
    db: Session = Depends(database.get_db),
    current_driver: models.Driver = Depends(permission_required(authz.PERM_MANIFESTS_WRITE)),
):
    drivers_service.ensure_drivers_schema(db)
    if not manifests_service.ensure_manifests_schema(db):
        raise HTTPException(status_code=503, detail="Manifests unavailable")

    m = manifests_service.create_manifest(
        db,
        created_by_user_id=current_driver.driver_id,
        created_by_role=authz.normalize_role(current_driver.role),
        truck_plate=request.truck_plate,
        date=request.date,
        kind=request.kind or "loadout",
        notes=request.notes,
    )
    if not m:
        raise HTTPException(status_code=503, detail="Manifests unavailable")
    db.commit()
    db.refresh(m)
    return m


@app.get("/manifests", response_model=List[schemas.ManifestSchema])
async def list_manifests(
    limit: int = 50,
    db: Session = Depends(database.get_db),
    current_driver: models.Driver = Depends(permission_required(authz.PERM_MANIFESTS_READ)),
):
    if not manifests_service.ensure_manifests_schema(db):
        return []
    return manifests_service.list_manifests(db, limit=limit)


@app.get("/manifests/{manifest_id}", response_model=schemas.ManifestSchema)
async def get_manifest(
    manifest_id: int,
    db: Session = Depends(database.get_db),
    current_driver: models.Driver = Depends(permission_required(authz.PERM_MANIFESTS_READ)),
):
    if not manifests_service.ensure_manifests_schema(db):
        raise HTTPException(status_code=503, detail="Manifests unavailable")
    m = manifests_service.get_manifest(db, manifest_id)
    if not m:
        raise HTTPException(status_code=404, detail="Manifest not found")
    # Load items (relationship may be lazy; accessing triggers load).
    _ = m.items
    return m


@app.post("/manifests/{manifest_id}/scan", response_model=schemas.ManifestItemSchema, status_code=201)
async def scan_manifest(
    manifest_id: int,
    request: schemas.ManifestScanRequest,
    db: Session = Depends(database.get_db),
    current_driver: models.Driver = Depends(permission_required(authz.PERM_MANIFESTS_WRITE)),
):
    if not manifests_service.ensure_manifests_schema(db):
        raise HTTPException(status_code=503, detail="Manifests unavailable")
    m = manifests_service.get_manifest(db, manifest_id)
    if not m:
        raise HTTPException(status_code=404, detail="Manifest not found")

    item = manifests_service.scan_into_manifest(
        db,
        manifest=m,
        identifier=request.identifier,
        scanned_by_user_id=current_driver.driver_id,
        parcels_total=request.parcels_total,
        data=request.data if isinstance(request.data, dict) else None,
    )
    if not item:
        raise HTTPException(status_code=400, detail="Invalid scan or manifest closed")
    db.commit()
    db.refresh(item)
    return item


@app.post("/manifests/{manifest_id}/close", response_model=schemas.ManifestSchema)
async def close_manifest(
    manifest_id: int,
    request: schemas.ManifestCreate = None,
    db: Session = Depends(database.get_db),
    current_driver: models.Driver = Depends(permission_required(authz.PERM_MANIFESTS_WRITE)),
):
    if not manifests_service.ensure_manifests_schema(db):
        raise HTTPException(status_code=503, detail="Manifests unavailable")
    m = manifests_service.get_manifest(db, manifest_id)
    if not m:
        raise HTTPException(status_code=404, detail="Manifest not found")
    manifests_service.close_manifest(db, manifest=m, notes=(request.notes if request else None))
    db.commit()
    db.refresh(m)
    _ = m.items
    return m

@app.post("/shipments/update-status")
async def update_shipment_status(
    request: schemas.AWBUpdateRequest,
    db: Session = Depends(database.get_db),
    current_driver: models.Driver = Depends(permission_required(authz.PERM_AWB_UPDATE))
):
    try:
        identifier = postis_client.normalize_shipment_identifier(request.awb)
        if not identifier:
            raise HTTPException(status_code=400, detail="awb is required")

        if str(request.event_id) == "2":
            if not _has_valid_signature_payload(request.payload):
                raise HTTPException(status_code=400, detail="Client signature is required for delivered status")
            ship = _find_shipment_by_awb(db, identifier)
            payload = request.payload if isinstance(request.payload, dict) else {}

            cod_expected = _safe_float(getattr(ship, "cod_amount", 0.0)) if ship is not None else 0.0
            if cod_expected <= 0:
                cod_block = payload.get("cod")
                if isinstance(cod_block, dict):
                    cod_expected = _safe_float(cod_block.get("expected_amount"))

            if cod_expected > 0:
                receipt_photo_data_url = _extract_payload_image(payload, "cod", "receipt_photo")
                if not receipt_photo_data_url.startswith("data:image/"):
                    raise HTTPException(status_code=400, detail="Receipt photo is required for COD delivered status")

            buy_back_required = _shipment_requires_buy_back_photo(ship)
            buy_back_block = payload.get("buy_back") if isinstance(payload.get("buy_back"), dict) else {}
            if buy_back_required or bool(buy_back_block.get("required")):
                buy_back_photo_data_url = _extract_payload_image(payload, "buy_back", "photo")
                if not buy_back_photo_data_url.startswith("data:image/"):
                    raise HTTPException(status_code=400, detail="Buy-back photo is required for this delivered shipment")

        # Standard locality for driver app updates
        details = {
            "localityName": "Driver App Location",
            "driverName": current_driver.name,
            "eventDate": datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S")
        }
        
        # Merge extra payload if provided
        if request.payload:
            details.update(request.payload)

        result = await p_client.update_status_by_awb_or_client_order_id(identifier, request.event_id, details)
        return {"status": "success", "postis_response": result}
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Status update failed for {request.awb}: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/sync-drivers")
async def sync_drivers(
    db: Session = Depends(database.get_db),
    current_driver: models.Driver = Depends(permission_required(authz.PERM_DRIVERS_SYNC)),
):
    drivers_service.ensure_drivers_schema(db)
    backfilled_phone_norm = drivers_service.backfill_phone_norm(db)
    rows = db.query(models.Driver.role, models.Driver.active).all()
    users_total = len(rows or [])
    users_active = 0
    drivers_total = 0
    drivers_active = 0
    recipients_total = 0
    recipients_active = 0

    for role_raw, active_raw in rows or []:
        role = authz.normalize_role(str(role_raw or "").strip())
        is_active = bool(active_raw)
        if is_active:
            users_active += 1

        if role == authz.ROLE_DRIVER:
            drivers_total += 1
            if is_active:
                drivers_active += 1
        elif role == authz.ROLE_RECIPIENT:
            recipients_total += 1
            if is_active:
                recipients_active += 1

    return {
        "status": "ok",
        "source": "database",
        "message": "Users/drivers are managed directly in database.",
        "users_total": int(users_total or 0),
        "users_active": int(users_active or 0),
        "drivers_total": int(drivers_total or 0),
        "drivers_active": int(drivers_active or 0),
        "recipients_total": int(recipients_total or 0),
        "recipients_active": int(recipients_active or 0),
        "phone_norm_backfilled": int(backfilled_phone_norm or 0),
    }


@app.get("/postis/sync/status", response_model=schemas.PostisSyncStatusSchema)
async def postis_sync_status(
    current_driver: models.Driver = Depends(permission_required(authz.PERM_POSTIS_SYNC)),
):
    return postis_sync_service.get_sync_status()


@app.post("/postis/sync", response_model=schemas.PostisSyncTriggerResponseSchema)
async def postis_sync_trigger(
    wait: bool = False,
    mode: str = "quick",
    missing_fields_limit: Optional[int] = None,
    current_driver: models.Driver = Depends(permission_required(authz.PERM_POSTIS_SYNC)),
):
    if not (p_client.username and p_client.password):
        raise HTTPException(status_code=400, detail="POSTIS_USERNAME/POSTIS_PASSWORD not configured")

    cfg = postis_sync_service.load_config_from_env()
    mode_norm = str(mode or "quick").strip().lower()

    # Manual backfill mode: pull v3+v2 lists, then fetch v1-by-AWB details for anything missing
    # key fields (cost/content/address/raw_data) so the app can display full shipment info.
    if mode_norm in ("full", "backfill", "deep"):
        limit = None
        if missing_fields_limit is not None:
            try:
                limit = int(missing_fields_limit)
            except Exception:
                limit = None
        if limit is None or limit <= 0:
            limit = 5000

        cfg = replace(
            cfg,
            use_v2_list=True,
            enrich_missing_fields=True,
            missing_fields_limit=limit,
            # Don't cap manual runs unless explicitly set via env.
            max_awbs_per_run=cfg.max_awbs_per_run,
        )
    elif missing_fields_limit is not None:
        try:
            limit = int(missing_fields_limit)
        except Exception:
            limit = None
        if limit is not None and limit > 0:
            cfg = replace(cfg, missing_fields_limit=limit)

    started, _stats = await postis_sync_service.trigger_manual_sync(p_client, config=cfg, wait=bool(wait))
    status_payload = postis_sync_service.get_sync_status()
    return {"started": bool(started), **status_payload}


@app.get("/routes/plans", response_model=List[schemas.RoutePlanSchema])
async def list_route_plans(
    plan_date: Optional[str] = None,
    db: Session = Depends(database.get_db),
    current_driver: models.Driver = Depends(permission_required(authz.PERM_ROUTE_PLANS_READ)),
):
    if not route_planning_service.ensure_route_plans_schema(db):
        return []

    rows = route_planning_service.list_route_plans(db, plan_date=plan_date)
    role = authz.normalize_role(current_driver.role)

    if role == authz.ROLE_DRIVER:
        my_id = str(current_driver.driver_id or "").strip().upper()
        rows = [
            r
            for r in rows
            if str(getattr(r, "status", "") or "") in {route_planning_service.STATUS_ASSIGNED, route_planning_service.STATUS_APPROVED}
            and str(getattr(r, "assigned_driver_id", "") or "").strip().upper() == my_id
        ]

    return [route_planning_service.route_plan_to_dict(r) for r in rows]


@app.get("/routes/plans/{plan_id}", response_model=schemas.RoutePlanSchema)
async def get_route_plan(
    plan_id: int,
    db: Session = Depends(database.get_db),
    current_driver: models.Driver = Depends(permission_required(authz.PERM_ROUTE_PLANS_READ)),
):
    if not route_planning_service.ensure_route_plans_schema(db):
        raise HTTPException(status_code=503, detail="Route plans unavailable")

    row = route_planning_service.get_route_plan(db, plan_id)
    if not row:
        raise HTTPException(status_code=404, detail="Route plan not found")

    role = authz.normalize_role(current_driver.role)
    if role == authz.ROLE_DRIVER:
        my_id = str(current_driver.driver_id or "").strip().upper()
        is_assigned = str(getattr(row, "status", "") or "") in {route_planning_service.STATUS_ASSIGNED, route_planning_service.STATUS_APPROVED}
        assigned_to_me = str(getattr(row, "assigned_driver_id", "") or "").strip().upper() == my_id
        if not (is_assigned and assigned_to_me):
            raise HTTPException(status_code=403, detail="Route is not assigned to this driver")

    return route_planning_service.route_plan_to_dict(row)


@app.post("/routes/plans/generate")
async def generate_route_plans(
    request: schemas.RoutePlanGenerateRequest,
    db: Session = Depends(database.get_db),
    current_driver: models.Driver = Depends(permission_required(authz.PERM_ROUTE_PLANS_WRITE)),
):
    if not route_planning_service.ensure_route_plans_schema(db):
        raise HTTPException(status_code=503, detail="Route plans unavailable")

    role = authz.normalize_role(current_driver.role)
    if role not in {authz.ROLE_ADMIN, authz.ROLE_MANAGER, authz.ROLE_DISPATCHER}:
        raise HTTPException(status_code=403, detail="Only admin/manager/dispatcher can generate route plans")

    sync_meta: Dict[str, Any] = {
        "sync_attempted": bool(request.sync_postis),
        "sync_ok": None,
        "sync_error": None,
        "sync_stats": None,
    }

    if request.sync_postis:
        cfg = postis_sync_service.load_config_from_env()
        # Route generation needs rich county/content data. Force a deeper backfill-like sync here
        # so planning can still work even when cached rows are partial.
        cfg = replace(
            cfg,
            use_v2_list=True,
            enrich_missing_fields=True,
            missing_fields_limit=max(1000, int(getattr(cfg, "missing_fields_limit", 0) or 0)),
        )
        try:
            stats = await postis_sync_service.run_sync_guarded(p_client, config=cfg, trigger="manual-route-planning")
            sync_meta["sync_ok"] = True
            sync_meta["sync_stats"] = postis_sync_service.get_sync_status().get("last_stats")
        except Exception as e:
            # Do not block route generation when Postis sync is temporarily unavailable.
            # We still generate plans from existing DB shipments and expose sync error to UI.
            logger.warning("Postis sync failed before route generation; continuing with cached shipments: %s", str(e))
            sync_meta["sync_ok"] = False
            sync_meta["sync_error"] = str(e)

    try:
        summary = route_planning_service.generate_daily_route_plans(
            db,
            plan_date=request.plan_date,
            generated_by_user_id=current_driver.driver_id,
            trigger="manual",
        )
    except RuntimeError as e:
        raise HTTPException(status_code=503, detail=str(e))
    except Exception as e:
        logger.error("Generate route plans failed: %s", str(e), exc_info=True)
        detail = str(e).strip() or "unknown error"
        raise HTTPException(status_code=500, detail=f"Failed to generate route plans: {detail[:500]}")

    if sync_meta["sync_attempted"]:
        summary["sync_attempted"] = True
        summary["sync_ok"] = bool(sync_meta["sync_ok"])
        summary["sync_error"] = sync_meta["sync_error"]
        summary["sync_stats"] = sync_meta["sync_stats"]

        if sync_meta["sync_ok"] is False and sync_meta["sync_error"]:
            warning = (
                "Postis sync failed before route generation. "
                "Routes were generated from existing DB shipments."
            )
            summary["warning"] = warning

    return summary


@app.post("/routes/plans/manual", response_model=schemas.RoutePlanSchema)
async def create_manual_route_plan(
    request: schemas.RoutePlanManualCreateRequest,
    db: Session = Depends(database.get_db),
    current_driver: models.Driver = Depends(permission_required(authz.PERM_ROUTE_PLANS_WRITE)),
):
    if not route_planning_service.ensure_route_plans_schema(db):
        raise HTTPException(status_code=503, detail="Route plans unavailable")

    role = authz.normalize_role(current_driver.role)
    if role not in {authz.ROLE_ADMIN, authz.ROLE_MANAGER, authz.ROLE_DISPATCHER}:
        raise HTTPException(status_code=403, detail="Only admin/manager/dispatcher can create manual route plans")

    try:
        row = route_planning_service.create_manual_route_plan(
            db,
            plan_date=request.plan_date,
            county=request.county,
            route_index=request.route_index,
            name=request.name,
            awbs=list(request.awbs or []),
            assigned_driver_id=request.assigned_driver_id,
            assigned_driver_name=request.assigned_driver_name,
            assigned_helper_name=request.assigned_helper_name,
            assigned_phone=request.assigned_phone,
            assigned_vehicle_plate=request.assigned_vehicle_plate,
            vehicle_type_code=request.vehicle_type_code,
            vehicle_has_lift=request.vehicle_has_lift,
            max_volume_m3=request.max_volume_m3,
            target_volume_m3=request.target_volume_m3,
            max_weight_kg=request.max_weight_kg,
            target_weight_kg=request.target_weight_kg,
            generated_by_user_id=current_driver.driver_id,
            data=request.data,
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except RuntimeError as e:
        raise HTTPException(status_code=503, detail=str(e))
    except Exception as e:
        logger.error("Create manual route plan failed: %s", str(e), exc_info=True)
        raise HTTPException(status_code=500, detail="Failed to create manual route plan")

    db.commit()
    db.refresh(row)
    return route_planning_service.route_plan_to_dict(row)


@app.post("/routes/plans/{plan_id}/approve", response_model=schemas.RoutePlanSchema)
async def approve_route_plan(
    plan_id: int,
    db: Session = Depends(database.get_db),
    current_driver: models.Driver = Depends(permission_required(authz.PERM_ROUTE_PLANS_WRITE)),
):
    if not route_planning_service.ensure_route_plans_schema(db):
        raise HTTPException(status_code=503, detail="Route plans unavailable")

    role = authz.normalize_role(current_driver.role)
    if role not in {authz.ROLE_ADMIN, authz.ROLE_MANAGER, authz.ROLE_DISPATCHER}:
        raise HTTPException(status_code=403, detail="Only admin/manager/dispatcher can approve route plans")

    row = route_planning_service.get_route_plan(db, plan_id)
    if not row:
        raise HTTPException(status_code=404, detail="Route plan not found")

    try:
        route_planning_service.approve_route_plan(
            db,
            plan=row,
            approved_by_user_id=current_driver.driver_id,
        )
    except ValueError as e:
        raise HTTPException(status_code=409, detail=str(e))

    db.commit()
    db.refresh(row)
    return route_planning_service.route_plan_to_dict(row)


@app.post("/routes/plans/{plan_id}/assign", response_model=schemas.RoutePlanAssignResponse)
async def assign_route_plan(
    plan_id: int,
    request: schemas.RoutePlanAssignRequest,
    db: Session = Depends(database.get_db),
    current_driver: models.Driver = Depends(permission_required(authz.PERM_ROUTE_PLANS_WRITE)),
):
    if not route_planning_service.ensure_route_plans_schema(db):
        raise HTTPException(status_code=503, detail="Route plans unavailable")

    role = authz.normalize_role(current_driver.role)
    if role not in {authz.ROLE_ADMIN, authz.ROLE_MANAGER, authz.ROLE_DISPATCHER}:
        raise HTTPException(status_code=403, detail="Only admin/manager/dispatcher can assign route plans")

    row = route_planning_service.get_route_plan(db, plan_id)
    if not row:
        raise HTTPException(status_code=404, detail="Route plan not found")

    try:
        assignment = route_planning_service.assign_route_plan(
            db,
            plan=row,
            vehicle_plate=request.vehicle_plate,
            assigned_by_user_id=current_driver.driver_id,
            assigned_driver_id=request.driver_id,
            assigned_helper_name=request.helper_name,
        )
    except ValueError as e:
        raise HTTPException(status_code=409, detail=str(e))
    except Exception as e:
        logger.error("Assign route plan failed: %s", str(e), exc_info=True)
        raise HTTPException(status_code=500, detail="Failed to assign route")

    db.commit()
    db.refresh(row)
    return {
        "plan": route_planning_service.route_plan_to_dict(row),
        "allocated_awbs": int(assignment.get("allocated_awbs") or 0),
        "missing_awbs": list(assignment.get("missing_awbs") or []),
        "assigned_driver_id": assignment.get("assigned_driver_id"),
        "assigned_vehicle_plate": assignment.get("assigned_vehicle_plate"),
        "assigned_helper_name": assignment.get("assigned_helper_name"),
    }

@app.post("/update-location")
async def update_location(
    location: schemas.LocationUpdate,
    db: Session = Depends(database.get_db),
    current_driver: models.Driver = Depends(get_current_driver)
):
    """
    Update driver's current location and save to history.
    """
    now = datetime.utcnow()

    # Create history entry
    loc_entry = models.DriverLocation(
        driver_id=current_driver.driver_id,
        latitude=location.latitude,
        longitude=location.longitude,
        timestamp=now
    )
    db.add(loc_entry)

    # If the driver is actively sharing live tracking, keep a heartbeat on the requests.
    if tracking_service.ensure_tracking_schema(db):
        active = (
            db.query(models.TrackingRequest)
            .filter(models.TrackingRequest.target_driver_id == current_driver.driver_id)
            .filter(models.TrackingRequest.status == "Accepted")
            .filter(models.TrackingRequest.stopped_at.is_(None))
            .filter(models.TrackingRequest.expires_at.isnot(None), models.TrackingRequest.expires_at > now)
            .all()
        )
        for req in active:
            req.last_location_at = now

    db.commit()
    return {"status": "updated", "timestamp": loc_entry.timestamp}


# [NEW] Live ops: latest driver locations (dispatcher dashboard)
@app.get("/live/drivers")
async def live_drivers(
    limit: int = 100,
    db: Session = Depends(database.get_db),
    current_driver: models.Driver = Depends(permission_required(authz.PERM_LIVEOPS_READ)),
):
    drivers_service.ensure_drivers_schema(db)
    try:
        limit_n = int(limit or 100)
    except Exception:
        limit_n = 100
    limit_n = max(1, min(limit_n, 500))

    # For SQLite portability, compute latest location in Python.
    now = datetime.utcnow()
    drivers = (
        db.query(models.Driver)
        .filter(models.Driver.active.is_(True))
        .order_by(models.Driver.driver_id.asc())
        .limit(limit_n)
        .all()
    )

    driver_ids = [
        str(getattr(d, "driver_id", "") or "").strip()
        for d in drivers
        if str(getattr(d, "driver_id", "") or "").strip()
    ]

    latest_by_driver: Dict[str, models.DriverLocation] = {}
    if driver_ids:
        latest_ts_subq = (
            db.query(
                models.DriverLocation.driver_id.label("driver_id"),
                func.max(models.DriverLocation.timestamp).label("max_ts"),
            )
            .filter(models.DriverLocation.driver_id.in_(driver_ids))
            .group_by(models.DriverLocation.driver_id)
            .subquery()
        )

        latest_rows = (
            db.query(models.DriverLocation)
            .join(
                latest_ts_subq,
                and_(
                    models.DriverLocation.driver_id == latest_ts_subq.c.driver_id,
                    models.DriverLocation.timestamp == latest_ts_subq.c.max_ts,
                ),
            )
            .order_by(
                models.DriverLocation.driver_id.asc(),
                models.DriverLocation.timestamp.desc(),
                models.DriverLocation.id.desc(),
            )
            .all()
        )

        # In rare cases with identical timestamps, keep only the newest row by id.
        for loc in latest_rows:
            did = str(getattr(loc, "driver_id", "") or "").strip()
            if did and did not in latest_by_driver:
                latest_by_driver[did] = loc

    out = []
    for d in drivers:
        did = str(d.driver_id or "").strip()
        if not did:
            continue
        loc = latest_by_driver.get(did)
        ts = getattr(loc, "timestamp", None) if loc else None
        age_sec = None
        if ts:
            try:
                age_sec = int((now - ts).total_seconds())
            except Exception:
                age_sec = None

        out.append(
            {
                "driver_id": did,
                "name": d.name,
                "role": authz.normalize_role(d.role),
                "truck_plate": d.truck_plate,
                "truck_phone": d.phone_number,
                "helper_name": d.helper_name,
                "latitude": getattr(loc, "latitude", None) if loc else None,
                "longitude": getattr(loc, "longitude", None) if loc else None,
                "timestamp": ts.isoformat() if ts else None,
                "age_sec": age_sec,
            }
        )
    return {"generated_at": now.isoformat() + "Z", "drivers": out}


# [NEW] Route runs: execution tracking
@app.post("/route-runs/start", response_model=schemas.RouteRunSchema, status_code=201)
async def start_route_run(
    request: schemas.RouteRunStartRequest,
    db: Session = Depends(database.get_db),
    current_driver: models.Driver = Depends(permission_required(authz.PERM_ROUTE_RUNS_WRITE)),
):
    drivers_service.ensure_drivers_schema(db)
    if not route_runs_service.ensure_route_runs_schema(db):
        raise HTTPException(status_code=503, detail="Route runs unavailable")

    run = route_runs_service.start_run(
        db,
        route_id=request.route_id,
        route_name=request.route_name,
        awbs=request.awbs,
        driver_id=current_driver.driver_id,
        truck_plate=request.truck_plate or current_driver.truck_plate,
        helper_name=request.helper_name or current_driver.helper_name,
        created_by_role=authz.normalize_role(current_driver.role),
        data=request.data if isinstance(request.data, dict) else None,
    )
    if not run:
        raise HTTPException(status_code=503, detail="Route runs unavailable")
    db.commit()
    db.refresh(run)
    _ = run.stops
    return run


@app.get("/route-runs/active", response_model=List[schemas.RouteRunSchema])
async def list_active_route_runs(
    limit: int = 50,
    db: Session = Depends(database.get_db),
    current_driver: models.Driver = Depends(permission_required(authz.PERM_ROUTE_RUNS_READ)),
):
    if not route_runs_service.ensure_route_runs_schema(db):
        return []
    runs = route_runs_service.list_active_runs(db, limit=limit)
    # Ensure stops are present for UI progress.
    for r in runs:
        _ = r.stops
    return runs


@app.get("/route-runs/{run_id}", response_model=schemas.RouteRunSchema)
async def get_route_run(
    run_id: int,
    db: Session = Depends(database.get_db),
    current_driver: models.Driver = Depends(permission_required(authz.PERM_ROUTE_RUNS_READ)),
):
    if not route_runs_service.ensure_route_runs_schema(db):
        raise HTTPException(status_code=503, detail="Route runs unavailable")
    run = route_runs_service.get_run(db, run_id)
    if not run:
        raise HTTPException(status_code=404, detail="Route run not found")
    _ = run.stops
    return run


def _route_run_write_allowed(current_driver: models.Driver, run: models.RouteRun) -> bool:
    role = authz.normalize_role(current_driver.role)
    if role == authz.ROLE_DRIVER:
        return str(run.driver_id or "").strip().upper() == str(current_driver.driver_id or "").strip().upper()
    return True


@app.post("/route-runs/{run_id}/stops/{awb}/arrive", response_model=schemas.RouteRunStopSchema)
async def route_run_arrive(
    run_id: int,
    awb: str,
    request: schemas.RouteRunStopUpdate,
    db: Session = Depends(database.get_db),
    current_driver: models.Driver = Depends(permission_required(authz.PERM_ROUTE_RUNS_WRITE)),
):
    if not route_runs_service.ensure_route_runs_schema(db):
        raise HTTPException(status_code=503, detail="Route runs unavailable")
    run = route_runs_service.get_run(db, run_id)
    if not run:
        raise HTTPException(status_code=404, detail="Route run not found")
    if not _route_run_write_allowed(current_driver, run):
        raise HTTPException(status_code=403, detail="Not enough permissions")

    stop = route_runs_service.mark_arrived(
        db,
        run_id=run_id,
        awb=awb,
        latitude=request.latitude,
        longitude=request.longitude,
        notes=request.notes,
        data=request.data if isinstance(request.data, dict) else None,
    )
    if not stop:
        raise HTTPException(status_code=404, detail="Stop not found")
    db.commit()
    db.refresh(stop)
    return stop


@app.post("/route-runs/{run_id}/stops/{awb}/complete", response_model=schemas.RouteRunStopSchema)
async def route_run_complete(
    run_id: int,
    awb: str,
    request: schemas.RouteRunStopUpdate,
    db: Session = Depends(database.get_db),
    current_driver: models.Driver = Depends(permission_required(authz.PERM_ROUTE_RUNS_WRITE)),
):
    if not route_runs_service.ensure_route_runs_schema(db):
        raise HTTPException(status_code=503, detail="Route runs unavailable")
    run = route_runs_service.get_run(db, run_id)
    if not run:
        raise HTTPException(status_code=404, detail="Route run not found")
    if not _route_run_write_allowed(current_driver, run):
        raise HTTPException(status_code=403, detail="Not enough permissions")

    stop = route_runs_service.mark_completed(
        db,
        run_id=run_id,
        awb=awb,
        completion_event_id=request.completion_event_id,
        latitude=request.latitude,
        longitude=request.longitude,
        notes=request.notes,
        data=request.data if isinstance(request.data, dict) else None,
    )
    if not stop:
        raise HTTPException(status_code=404, detail="Stop not found")
    db.commit()
    db.refresh(stop)
    return stop


@app.post("/route-runs/{run_id}/stops/{awb}/skip", response_model=schemas.RouteRunStopSchema)
async def route_run_skip(
    run_id: int,
    awb: str,
    request: schemas.RouteRunStopUpdate,
    db: Session = Depends(database.get_db),
    current_driver: models.Driver = Depends(permission_required(authz.PERM_ROUTE_RUNS_WRITE)),
):
    if not route_runs_service.ensure_route_runs_schema(db):
        raise HTTPException(status_code=503, detail="Route runs unavailable")
    run = route_runs_service.get_run(db, run_id)
    if not run:
        raise HTTPException(status_code=404, detail="Route run not found")
    if not _route_run_write_allowed(current_driver, run):
        raise HTTPException(status_code=403, detail="Not enough permissions")

    stop = route_runs_service.mark_skipped(
        db,
        run_id=run_id,
        awb=awb,
        latitude=request.latitude,
        longitude=request.longitude,
        notes=request.notes,
        data=request.data if isinstance(request.data, dict) else None,
    )
    if not stop:
        raise HTTPException(status_code=404, detail="Stop not found")
    db.commit()
    db.refresh(stop)
    return stop


@app.post("/route-runs/{run_id}/finish", response_model=schemas.RouteRunSchema)
async def finish_route_run(
    run_id: int,
    db: Session = Depends(database.get_db),
    current_driver: models.Driver = Depends(permission_required(authz.PERM_ROUTE_RUNS_WRITE)),
):
    if not route_runs_service.ensure_route_runs_schema(db):
        raise HTTPException(status_code=503, detail="Route runs unavailable")
    run = route_runs_service.get_run(db, run_id)
    if not run:
        raise HTTPException(status_code=404, detail="Route run not found")
    if not _route_run_write_allowed(current_driver, run):
        raise HTTPException(status_code=403, detail="Not enough permissions")

    route_runs_service.finish_run(db, run=run)
    db.commit()
    db.refresh(run)
    _ = run.stops
    return run


@app.post("/maps/route-metrics", response_model=schemas.RouteMetricsResponse)
async def maps_route_metrics(
    request: schemas.RouteMetricsRequest,
    current_driver: models.Driver = Depends(get_current_driver),
):
    _ = current_driver
    points = list(request.points or [])
    if len(points) < 2:
        raise HTTPException(status_code=400, detail="At least 2 points are required.")

    metrics = await _google_route_metrics(points)
    if not metrics:
        raise HTTPException(status_code=503, detail="Traffic-aware route metrics unavailable.")

    return metrics


@app.post("/maps/geocode", response_model=schemas.GeocodeResponse)
async def maps_geocode(
    request: schemas.GeocodeRequest,
    current_driver: models.Driver = Depends(get_current_driver),
):
    _ = current_driver
    query_text = str(request.query or "").strip()
    if not query_text:
        raise HTTPException(status_code=400, detail="query is required")

    payload = await asyncio.to_thread(
        geocoding_service.geocode_query_live,
        query_text,
        expected_locality=request.expected_locality,
        expected_county=request.expected_county,
    )

    if not payload:
        return {
            "found": False,
            "formatted_address": query_text,
        }

    lat = float(payload.get("lat")) if payload.get("lat") is not None else None
    lon = float(payload.get("lon")) if payload.get("lon") is not None else None
    if lat is None or lon is None:
        return {
            "found": False,
            "formatted_address": str(payload.get("display_name") or query_text),
            "provider": str(payload.get("provider") or "") or None,
        }

    return {
        "found": True,
        "lat": lat,
        "lon": lon,
        "formatted_address": str(payload.get("display_name") or query_text),
        "provider": str(payload.get("provider") or "") or None,
        "accuracy": str(payload.get("accuracy") or "") or None,
        "partial_match": bool(payload.get("partial_match")) if payload.get("partial_match") is not None else None,
        "matched_locality": bool(payload.get("matched_locality")) if payload.get("matched_locality") is not None else None,
        "matched_county": bool(payload.get("matched_county")) if payload.get("matched_county") is not None else None,
    }


@app.post("/optimize-route")
async def optimize_route(
    request: schemas.RouteRequest,
    db: Session = Depends(database.get_db),
    current_driver: models.Driver = Depends(get_current_driver)
):
    """
    Optimize list of shipments based on current location.
    """
    # Fetch shipments from DB (assuming they adhere to local DB for now)
    # If not in DB, we'd need to fetch from Postis/Sheet or pass full details
    # For MVP, let's assume we pass AWBs and lookup coordinates if available
    # OR we just rely on lat/lon being present in the Shipment table.
    
    shipments = db.query(models.Shipment).filter(models.Shipment.awb.in_(request.shipments)).all()
    
    destinations = []
    for s in shipments:
        # Mock geocoding if lat/lon missing (Real app would geocode 'locality'/'delivery_address')
        if s.latitude is None or s.longitude is None:
             # Just a placeholder log or mock for demo
             pass 
        else:
            destinations.append({
                "id": s.awb,
                "lat": s.latitude,
                "lon": s.longitude,
                "address": s.delivery_address
            })
            
    # Add dummy coordinates for demo purposes if list is empty or coordinates missing
    if not destinations and request.shipments:
         # Demo: Add random offsets from Bucharest center
         import random
         base_lat, base_lon = 44.4268, 26.1025
         for awb in request.shipments:
             destinations.append({
                 "id": awb,
                 "lat": base_lat + random.uniform(-0.05, 0.05),
                 "lon": base_lon + random.uniform(-0.05, 0.05),
                 "address": "Simulated Address"
             })
             
    optimized_order = routing_service.optimize_route_order(
        (request.current_location.latitude, request.current_location.longitude),
        destinations
    )
    
    # Get OSRM geometry for the full route
    route_coords = [(request.current_location.longitude, request.current_location.latitude)]
    for dest in optimized_order:
        route_coords.append((dest['lon'], dest['lat']))
        
    osrm_data = routing_service.get_osrm_route(route_coords)
    
    return {
        "optimized_order": optimized_order,
        "route_geometry": osrm_data.get("routes", [{}])[0].get("geometry") if osrm_data else None,
        "total_distance": osrm_data.get("routes", [{}])[0].get("distance") if osrm_data else 0
    }

@app.get("/history", response_model=List[schemas.DriverHistorySchema])
async def get_driver_history(
    date: str = None,
    driver_id: str = None,
    db: Session = Depends(database.get_db),
    current_driver: models.Driver = Depends(get_current_driver) # permissions check could go here
):
    """
    Get historical locations and distance for a driver.
    """
    if not date:
        date = datetime.utcnow().date().isoformat()
    
    target_driver_id = driver_id or current_driver.driver_id
    
    # Permission check: drivers can only see their own unless they are admin/manager
    if target_driver_id != current_driver.driver_id and not authz.can_view_all_logs(current_driver.role):
        raise HTTPException(status_code=403, detail="Not authorized to view this driver's history")
        
    start_dt = datetime.fromisoformat(date)
    end_dt = start_dt + timedelta(days=1)
    
    locations = db.query(models.DriverLocation).filter(
        models.DriverLocation.driver_id == target_driver_id,
        models.DriverLocation.timestamp >= start_dt,
        models.DriverLocation.timestamp < end_dt
    ).order_by(models.DriverLocation.timestamp.asc()).all()
    
    coords = [(loc.latitude, loc.longitude) for loc in locations]
    dist = routing_service.calculate_path_distance(coords)
    
    history_entry = {
        "driver_id": target_driver_id,
        "date": date,
        "locations": [{"latitude": l.latitude, "longitude": l.longitude} for l in locations],
        "total_distance_km": dist
    }
    
    return [history_entry]

@app.get("/")
async def read_index():
    return FileResponse(os.path.join(REPO_ROOT, "preview.html"))

@app.get("/preview.html")
async def read_preview_html():
    return FileResponse(os.path.join(REPO_ROOT, "preview.html"))

@app.get("/logo.png")
async def read_logo():
    return FileResponse(os.path.join(REPO_ROOT, "logo.png"))

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
