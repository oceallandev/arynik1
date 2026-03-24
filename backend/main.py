import warnings

# macOS system Python can ship LibreSSL; ignore urllib3's compatibility warning noise in logs.
warnings.filterwarnings("ignore", message="urllib3 v2 only supports OpenSSL 1.1.1+.*")

import io
import json
import csv
import re
from fastapi import FastAPI, Depends, HTTPException, status, APIRouter, Response, Request, UploadFile, File, Form
from fastapi.responses import StreamingResponse, FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.security import OAuth2PasswordBearer, OAuth2PasswordRequestForm
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import and_, false, or_, func, cast, String, text
from sqlalchemy.orm import Session, defer
from sqlalchemy.exc import OperationalError, IntegrityError
from datetime import datetime, timedelta, timezone
from dataclasses import replace
import jwt
import os
import logging
import secrets
import hashlib
import sys
import unicodedata
import math
import httpx
from collections import defaultdict
from typing import Any, List, Set, Optional, Dict, Tuple
from urllib.parse import parse_qs, urlparse
from zoneinfo import ZoneInfo
from dotenv import load_dotenv, set_key, unset_key
import asyncio

# Load environment variables from the backend directory
env_path = os.path.join(os.path.dirname(__file__), '.env')
load_dotenv(dotenv_path=env_path, override=False)
_SERVER_ENV_FILE_PATH = env_path

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
FRONTEND_DIST_DIR = os.path.join(REPO_ROOT, "dist")
FRONTEND_INDEX_PATH = os.path.join(FRONTEND_DIST_DIR, "index.html")

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
        route_aviz_service,
        cod_service,
        geocoding_service,
        label_service,
        assistant_service,
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
        route_aviz_service,
        cod_service,
        geocoding_service,
        label_service,
        assistant_service,
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
    Supports comma/newline separated values and JSON arrays.
    """
    raw = str(os.getenv("CORS_ALLOWED_ORIGINS", "") or "").strip()
    defaults: List[str] = []
    if not raw:
        return defaults

    values: List[str] = []
    if raw.startswith("[") and raw.endswith("]"):
        try:
            parsed = json.loads(raw)
            if isinstance(parsed, list):
                values = [str(v or "").strip() for v in parsed]
        except Exception:
            values = []
    if not values:
        normalized_raw = raw.replace("\n", ",").replace(";", ",")
        values = [o.strip() for o in normalized_raw.split(",") if o.strip()]

    origins: List[str] = []
    for value in values:
        v = value.strip().strip("\"'").rstrip("/")
        if not v:
            continue
        if v == "*":
            return ["*"]
        if v not in origins:
            origins.append(v)
    return origins or defaults


def _cors_origin_regex_from_env() -> str:
    """
    Optional regex-based CORS allowlist.
    Useful when frontend domain can change across subdomains (for example *.anunta.eu).
    """
    raw = str(os.getenv("CORS_ALLOWED_ORIGIN_REGEX", "") or "").strip().strip("\"'")
    if raw:
        return raw

    # Safe project default for current deployment topology.
    return (
        r"^https://([a-z0-9-]+\.)*curieru\.com$"
        r"|^https://([a-z0-9-]+\.)*anunta\.eu$"
        r"|^https://[a-z0-9-]+\.onrender\.com$"
        r"|^http://localhost(?::\d+)?$"
        r"|^http://127\.0\.0\.1(?::\d+)?$"
        r"|^capacitor://localhost$"
        r"|^ionic://localhost$"
    )

# Create tables
# models.Base.metadata.create_all(bind=database.engine)

app = FastAPI(title="Postis Shipment Update API")

_CORS_ORIGINS = _cors_origins_from_env()
_CORS_IS_WILDCARD = len(_CORS_ORIGINS) == 1 and _CORS_ORIGINS[0] == "*"
_CORS_ORIGIN_REGEX = _cors_origin_regex_from_env()
logger.info(
    "CORS configured: origins=%s, regex=%s, allow_credentials=%s",
    _CORS_ORIGINS,
    (_CORS_ORIGIN_REGEX or None),
    (not _CORS_IS_WILDCARD),
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=_CORS_ORIGINS,
    allow_origin_regex=_CORS_ORIGIN_REGEX if _CORS_ORIGIN_REGEX else None,
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


def _fold_text(value: Any) -> str:
    return (
        unicodedata.normalize("NFD", str(value or ""))
        .encode("ascii", "ignore")
        .decode("ascii")
        .strip()
        .casefold()
    )


def _mask_secret_value(value: Optional[str]) -> Optional[str]:
    text = str(value or "").strip()
    if not text:
        return None
    if len(text) <= 8:
        return "*" * len(text)
    return f"{text[:4]}...{text[-4:]}"


def _provider_secret_status(env_name: str) -> schemas.ProviderSecretStatus:
    raw = str(os.getenv(env_name) or "").strip()
    return schemas.ProviderSecretStatus(
        configured=bool(raw),
        masked=_mask_secret_value(raw),
    )


def _provider_secrets_status_response() -> schemas.ProviderSecretsStatusResponse:
    return schemas.ProviderSecretsStatusResponse(
        openai_api_key=_provider_secret_status("OPENAI_API_KEY"),
        elevenlabs_api_key=_provider_secret_status("ELEVENLABS_API_KEY"),
    )


def _persist_env_secret(name: str, value: Optional[str], *, persist_to_env: bool = True) -> None:
    normalized = str(value or "").strip()

    if normalized:
        os.environ[name] = normalized
        if persist_to_env:
            try:
                os.makedirs(os.path.dirname(_SERVER_ENV_FILE_PATH), exist_ok=True)
                if not os.path.exists(_SERVER_ENV_FILE_PATH):
                    with open(_SERVER_ENV_FILE_PATH, "a", encoding="utf-8"):
                        pass
                set_key(_SERVER_ENV_FILE_PATH, name, normalized)
            except Exception as exc:
                logger.warning("Could not persist %s in env file: %s", name, str(exc))
        return

    os.environ.pop(name, None)
    if persist_to_env:
        try:
            if os.path.exists(_SERVER_ENV_FILE_PATH):
                unset_key(_SERVER_ENV_FILE_PATH, name, quote_mode="auto")
        except Exception as exc:
            logger.warning("Could not remove %s from env file: %s", name, str(exc))


def _ensure_maps_provider_schema() -> bool:
    try:
        models.MapsProviderConfig.__table__.create(bind=database.engine, checkfirst=True)
        models.MapsProviderUsage.__table__.create(bind=database.engine, checkfirst=True)
        return True
    except Exception as exc:
        logger.warning("Maps provider schema unavailable: %s", str(exc))
        return False


def _maps_platform_price_per_1000() -> float:
    raw = str(
        os.getenv("MAPS_PLATFORM_PRICE_PER_1000_RON")
        or os.getenv("MAPS_PLATFORM_PRICE_PER_1000")
        or "35"
    ).strip()
    try:
        value = float(raw)
    except Exception:
        value = 35.0
    return max(0.0, float(value))


def _maps_platform_price_per_request() -> float:
    return float(_maps_platform_price_per_1000()) / 1000.0


def _maps_platform_enforce_credit() -> bool:
    raw = str(os.getenv("MAPS_PLATFORM_ENFORCE_CREDIT", "0") or "0").strip().lower()
    return raw in {"1", "true", "yes", "on"}


def _maps_normalize_mode(value: Any) -> str:
    mode = str(value or "platform").strip().lower()
    if mode not in {"own", "platform"}:
        return "platform"
    return mode


def _maps_get_or_create_config(db: Session, owner_user_id: str) -> Optional[models.MapsProviderConfig]:
    user_id = str(owner_user_id or "").strip().upper()
    if not user_id:
        return None
    row = (
        db.query(models.MapsProviderConfig)
        .filter(models.MapsProviderConfig.owner_user_id == user_id)
        .first()
    )
    if row:
        return row
    row = models.MapsProviderConfig(
        owner_user_id=user_id,
        maps_mode="platform",
        own_maps_api_key=None,
        platform_credit_balance=0.0,
        platform_usage_requests=0,
        platform_usage_cost=0.0,
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


def _maps_select_config_for_user(db: Session, current_driver: models.Driver) -> Optional[models.MapsProviderConfig]:
    role = authz.normalize_role(current_driver.role)
    if role == authz.ROLE_ADMIN:
        return _maps_get_or_create_config(db, str(current_driver.driver_id or "").strip().upper())

    row = (
        db.query(models.MapsProviderConfig)
        .order_by(models.MapsProviderConfig.updated_at.desc(), models.MapsProviderConfig.id.desc())
        .first()
    )
    return row


def _maps_resolve_access(db: Session, current_driver: models.Driver) -> Dict[str, Any]:
    cfg = _maps_select_config_for_user(db, current_driver) if _ensure_maps_provider_schema() else None
    mode = _maps_normalize_mode(getattr(cfg, "maps_mode", "platform") if cfg else "platform")
    own_key = str(getattr(cfg, "own_maps_api_key", "") or "").strip()
    platform_key = geocoding_service.get_google_maps_api_key()

    api_key = ""
    if mode == "own":
        api_key = own_key
    else:
        api_key = platform_key

    owner_user_id = str(getattr(cfg, "owner_user_id", "") or "").strip().upper() or None
    return {
        "config_row": cfg,
        "owner_user_id": owner_user_id,
        "mode": mode,
        "api_key": api_key,
        "own_key_configured": bool(own_key),
        "platform_key_configured": bool(platform_key),
    }


def _maps_check_platform_credit(access: Dict[str, Any], *, requests_count: int = 1) -> None:
    if str(access.get("mode") or "") != "platform":
        return
    if not str(access.get("api_key") or "").strip():
        return
    if not _maps_platform_enforce_credit():
        return
    cfg = access.get("config_row")
    if not isinstance(cfg, models.MapsProviderConfig):
        return
    request_n = max(1, int(requests_count or 1))
    next_cost = float(_maps_platform_price_per_request()) * float(request_n)
    balance = float(getattr(cfg, "platform_credit_balance", 0.0) or 0.0)
    if (balance - next_cost) < 0:
        raise HTTPException(
            status_code=402,
            detail="Platform maps credit depleted. Please top up balance in Settings.",
        )


def _maps_record_usage(
    db: Session,
    *,
    current_driver: models.Driver,
    access: Dict[str, Any],
    action: str,
    requests_count: int = 1,
    meta: Optional[Dict[str, Any]] = None,
) -> None:
    if not _ensure_maps_provider_schema():
        return

    req_n = max(1, int(requests_count or 1))
    mode = _maps_normalize_mode(access.get("mode"))
    estimated_cost = 0.0
    owner_user_id = str(access.get("owner_user_id") or "").strip().upper()
    cfg = access.get("config_row")

    if isinstance(cfg, models.MapsProviderConfig):
        owner_user_id = str(getattr(cfg, "owner_user_id", "") or "").strip().upper() or owner_user_id
    if not owner_user_id:
        owner_user_id = str(getattr(current_driver, "driver_id", "") or "").strip().upper()

    if mode == "platform":
        estimated_cost = float(_maps_platform_price_per_request()) * float(req_n)
        if isinstance(cfg, models.MapsProviderConfig):
            cfg.platform_usage_requests = int(getattr(cfg, "platform_usage_requests", 0) or 0) + req_n
            cfg.platform_usage_cost = float(getattr(cfg, "platform_usage_cost", 0.0) or 0.0) + float(estimated_cost)
            cfg.platform_credit_balance = float(getattr(cfg, "platform_credit_balance", 0.0) or 0.0) - float(estimated_cost)
            cfg.last_platform_usage_at = datetime.utcnow()
            cfg.updated_at = datetime.utcnow()

    usage = models.MapsProviderUsage(
        owner_user_id=owner_user_id or None,
        provider="google_maps",
        mode=mode,
        action=str(action or "").strip() or "unknown",
        requests_count=req_n,
        estimated_cost=float(estimated_cost),
        meta=meta if isinstance(meta, dict) else None,
    )
    db.add(usage)
    try:
        db.commit()
    except Exception:
        db.rollback()
        logger.warning("Could not persist maps usage event", exc_info=True)


def _maps_config_response_for_admin(db: Session, admin_user_id: str) -> schemas.MapsProviderConfigResponse:
    if not _ensure_maps_provider_schema():
        raise HTTPException(status_code=503, detail="Maps provider settings unavailable.")

    owner_id = str(admin_user_id or "").strip().upper()
    cfg = _maps_get_or_create_config(db, owner_id)
    if not cfg:
        raise HTTPException(status_code=503, detail="Maps provider settings unavailable.")

    price_1k = float(_maps_platform_price_per_1000())
    price_req = float(_maps_platform_price_per_request())
    balance = float(getattr(cfg, "platform_credit_balance", 0.0) or 0.0)
    usage_requests = int(getattr(cfg, "platform_usage_requests", 0) or 0)
    usage_cost = float(getattr(cfg, "platform_usage_cost", 0.0) or 0.0)

    remaining_estimate: Optional[int] = None
    if price_req > 0:
        remaining_estimate = max(0, int(balance / price_req))

    usage_rows = (
        db.query(models.MapsProviderUsage)
        .filter(models.MapsProviderUsage.owner_user_id == owner_id)
        .order_by(models.MapsProviderUsage.created_at.desc(), models.MapsProviderUsage.id.desc())
        .limit(60)
        .all()
    )
    recent_usage = [
        schemas.MapsProviderUsageItem(
            created_at=row.created_at,
            action=str(row.action or "").strip() or "unknown",
            mode=_maps_normalize_mode(row.mode),
            requests_count=int(row.requests_count or 1),
            estimated_cost=float(row.estimated_cost or 0.0),
        )
        for row in usage_rows
        if isinstance(row, models.MapsProviderUsage)
    ]

    return schemas.MapsProviderConfigResponse(
        owner_user_id=owner_id,
        maps_mode=_maps_normalize_mode(getattr(cfg, "maps_mode", "platform")),
        own_maps_api_key=schemas.ProviderSecretStatus(
            configured=bool(str(getattr(cfg, "own_maps_api_key", "") or "").strip()),
            masked=_mask_secret_value(getattr(cfg, "own_maps_api_key", None)),
        ),
        platform_google_maps_api_key=_provider_secret_status("GOOGLE_MAPS_API_KEY"),
        pricing_per_1000=price_1k,
        pricing_per_request=price_req,
        platform_credit_balance=balance,
        platform_usage_requests=usage_requests,
        platform_usage_cost=usage_cost,
        platform_remaining_estimated_requests=remaining_estimate,
        recent_usage=recent_usage,
    )


def _resolve_depot_status_option(db: Session) -> Tuple[str, str]:
    options = _ensure_status_options(db)
    if not options:
        return "6", "Intrare in depozit"

    for opt in options:
        event_id = str(getattr(opt, "event_id", "") or "").strip()
        label = str(getattr(opt, "label", "") or "").strip()
        description = str(getattr(opt, "description", "") or "").strip()
        haystack = f"{_fold_text(label)} {_fold_text(description)}".strip()
        if (
            "intrare in depozit" in haystack
            or "in depozit" in haystack
            or "in depot" in haystack
        ):
            return event_id or "6", label or description or "Intrare in depozit"

    for opt in options:
        if str(getattr(opt, "event_id", "") or "").strip() == "6":
            label = str(getattr(opt, "label", "") or "").strip()
            description = str(getattr(opt, "description", "") or "").strip()
            return "6", label or description or "Intrare in depozit"

    return "6", "Intrare in depozit"


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

RESCHEDULE_SLOT_WINDOWS: Dict[str, Dict[str, Any]] = {
    "morning_09_12": {"period": "morning", "start_hour": 9, "end_hour": 12, "label": "09:00-12:00"},
    "morning_12_15": {"period": "morning", "start_hour": 12, "end_hour": 15, "label": "12:00-15:00"},
    "afternoon_15_18": {"period": "afternoon", "start_hour": 15, "end_hour": 18, "label": "15:00-18:00"},
    "afternoon_18_21": {"period": "afternoon", "start_hour": 18, "end_hour": 21, "label": "18:00-21:00"},
}


def _ops_timezone() -> ZoneInfo:
    tz_name = str(os.getenv("OPS_TIMEZONE", "Europe/Bucharest") or "").strip() or "Europe/Bucharest"
    try:
        return ZoneInfo(tz_name)
    except Exception:
        return ZoneInfo("UTC")


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


def _shipment_status_signals_for_logic(ship: Optional[models.Shipment]) -> List[str]:
    if not ship:
        return []
    raw = getattr(ship, "raw_data", None)
    if not isinstance(raw, dict):
        raw = {}
    client_status = raw.get("clientShipmentStatus") if isinstance(raw.get("clientShipmentStatus"), dict) else {}
    signals = [
        getattr(ship, "status", None),
        getattr(ship, "processing_status", None),
        raw.get("statusDescription"),
        raw.get("eventDescription"),
        raw.get("lastEventDescription"),
        client_status.get("clientShipmentStatusDescription"),
        client_status.get("statusDescription"),
        client_status.get("defaultClientStatus"),
        client_status.get("processingStatus"),
        client_status.get("description"),
    ]
    out: List[str] = []
    for sig in signals:
        txt = str(sig or "").strip()
        if txt:
            out.append(txt)
    return out


def _shipment_is_refused_for_return_flow(ship: Optional[models.Shipment]) -> bool:
    signals = _shipment_status_signals_for_logic(ship)
    if not signals:
        return False

    folded = [_fold_text(x) for x in signals]
    if any("returnata" in s or "returned" in s for s in folded):
        return False
    return any("refuz" in s or "refused" in s for s in folded)


def _extract_reason_payload(payload: Optional[dict]) -> Tuple[Optional[str], Optional[str]]:
    if not isinstance(payload, dict):
        return None, None
    ndr = payload.get("ndr")
    if not isinstance(ndr, dict):
        ndr = {}
    reason_code = str(ndr.get("reason_code") or payload.get("reason_code") or "").strip() or None
    reason_note = str(ndr.get("note") or payload.get("reason_note") or payload.get("reason") or "").strip() or None
    return reason_code, reason_note


def _extract_refusal_action_payload(payload: Optional[dict]) -> Tuple[Optional[str], Optional[Dict[str, Any]]]:
    if not isinstance(payload, dict):
        return None, None
    ndr = payload.get("ndr")
    if not isinstance(ndr, dict):
        ndr = {}

    action_code = str(
        ndr.get("action_code")
        or ndr.get("actionCode")
        or payload.get("action_code")
        or payload.get("actionCode")
        or ""
    ).strip().upper() or None

    candidate = ndr.get("new_recipient")
    if not isinstance(candidate, dict):
        candidate = payload.get("new_recipient")
    if not isinstance(candidate, dict):
        return action_code, None

    out = {
        "type": str(candidate.get("type") or "").strip().lower() or None,
        "id": str(candidate.get("id") or "").strip() or None,
        "location_id": str(candidate.get("location_id") or candidate.get("locationId") or "").strip() or None,
        "name": str(candidate.get("name") or "").strip() or None,
        "phone": str(candidate.get("phone") or candidate.get("phone_number") or "").strip() or None,
        "locality": str(candidate.get("locality") or "").strip() or None,
        "county": str(candidate.get("county") or "").strip() or None,
        "address": str(candidate.get("address") or candidate.get("address_text") or "").strip() or None,
        "source": str(candidate.get("source") or "").strip() or None,
    }
    has_minimum = bool(out.get("name") or out.get("locality") or out.get("address"))
    return action_code, (out if has_minimum else None)


_NDR_ACTION_LABELS: Dict[str, str] = {
    "RETURN_TO_SENDER": "Return to sender",
    "REDIRECT_TO_FLANCO": "Redirect to Flanco store",
    "REDIRECT_TO_NEW_RECIPIENT": "Redirect to new recipient",
    "RESCHEDULE_DELIVERY": "Reschedule delivery",
}


def _merge_reason_with_refusal_action(
    *,
    reason_note: Optional[str],
    action_code: Optional[str],
    new_recipient: Optional[Dict[str, Any]],
) -> Optional[str]:
    parts: List[str] = []
    if reason_note:
        parts.append(str(reason_note).strip())

    code = str(action_code or "").strip().upper()
    if code:
        label = _NDR_ACTION_LABELS.get(code, code)
        dest_bits = []
        if isinstance(new_recipient, dict):
            for field in ("name", "locality", "address"):
                value = str(new_recipient.get(field) or "").strip()
                if value:
                    dest_bits.append(value)
        if dest_bits:
            parts.append(f"Action: {label} ({' / '.join(dest_bits)})")
        else:
            parts.append(f"Action: {label}")

    out = " | ".join([p for p in parts if p]).strip()
    return out or None


def _extract_reschedule_at_payload(payload: Optional[dict]) -> Optional[str]:
    if not isinstance(payload, dict):
        return None
    ndr = payload.get("ndr")
    if not isinstance(ndr, dict):
        ndr = {}
    candidate = (
        ndr.get("reschedule_at")
        or ndr.get("rescheduleAt")
        or payload.get("reschedule_at")
        or payload.get("rescheduleAt")
    )
    text = str(candidate or "").strip()
    return text or None


def _extract_return_proof_photo(payload: Optional[dict]) -> str:
    if not isinstance(payload, dict):
        return ""
    for key_path in (
        ("return_proof", "photo"),
        ("return", "photo"),
        ("buy_back", "photo"),
        ("pod", "photo"),
    ):
        candidate = _extract_payload_image(payload, *key_path)
        if candidate.startswith("data:image/"):
            return candidate
    return ""


def _persist_reschedule_meta_on_shipment(ship: Optional[models.Shipment], *, reschedule_at: Optional[str]) -> None:
    if not ship or not reschedule_at:
        return
    raw = getattr(ship, "raw_data", None)
    if not isinstance(raw, dict):
        raw = {}
    routing = raw.get("routing")
    if not isinstance(routing, dict):
        routing = {}
    routing["reschedule_at"] = str(reschedule_at).strip()
    raw["routing"] = routing
    ship.raw_data = raw


def _persist_refusal_meta_on_shipment(
    ship: Optional[models.Shipment],
    *,
    action_code: Optional[str],
    reason_code: Optional[str],
    reason_note: Optional[str],
    new_recipient: Optional[Dict[str, Any]],
) -> None:
    if not ship:
        return

    raw = getattr(ship, "raw_data", None)
    if not isinstance(raw, dict):
        raw = {}

    ndr = raw.get("ndr")
    if not isinstance(ndr, dict):
        ndr = {}
    ndr["last_action_code"] = str(action_code or "").strip() or None
    ndr["last_reason_code"] = str(reason_code or "").strip() or None
    ndr["last_reason_note"] = str(reason_note or "").strip() or None
    ndr["updated_at"] = datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S")
    if isinstance(new_recipient, dict):
        ndr["new_recipient"] = dict(new_recipient)
    raw["ndr"] = ndr
    ship.raw_data = raw

    code = str(action_code or "").strip().upper()
    if code in {"REDIRECT_TO_FLANCO", "REDIRECT_TO_NEW_RECIPIENT"} and isinstance(new_recipient, dict):
        name = str(new_recipient.get("name") or "").strip()
        phone = str(new_recipient.get("phone") or "").strip()
        locality = str(new_recipient.get("locality") or "").strip()
        address = str(new_recipient.get("address") or "").strip()
        if name:
            ship.recipient_name = name
        if phone:
            ship.recipient_phone = phone
            try:
                ship.recipient_phone_norm = phone_service.normalize_phone(phone) or None
            except Exception:
                pass
        if locality:
            ship.locality = locality
        if address:
            ship.delivery_address = address


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



_RO_LAT_MIN = 43.3
_RO_LAT_MAX = 48.5
_RO_LON_MIN = 20.0
_RO_LON_MAX = 30.0


def _float_or_none(value: Any) -> Optional[float]:
    if value is None:
        return None
    try:
        if isinstance(value, str):
            txt = value.strip().replace(",", ".")
            if not txt:
                return None
            num = float(txt)
        else:
            num = float(value)
        if num != num:  # NaN
            return None
        return float(num)
    except Exception:
        return None


def _is_ro_coord(lat: Any, lon: Any) -> bool:
    la = _float_or_none(lat)
    lo = _float_or_none(lon)
    if la is None or lo is None:
        return False
    return (_RO_LAT_MIN <= la <= _RO_LAT_MAX) and (_RO_LON_MIN <= lo <= _RO_LON_MAX)


def _normalize_ro_coord_pair(lat_raw: Any, lon_raw: Any) -> Optional[Tuple[float, float]]:
    la = _float_or_none(lat_raw)
    lo = _float_or_none(lon_raw)
    if la is None or lo is None:
        return None
    if _is_ro_coord(la, lo):
        return float(la), float(lo)
    # Recover from swapped order when the flipped pair is valid in Romania.
    if _is_ro_coord(lo, la):
        return float(lo), float(la)
    return None


def _haversine_m(lat1: Any, lon1: Any, lat2: Any, lon2: Any) -> float:
    la1 = _safe_float(lat1)
    lo1 = _safe_float(lon1)
    la2 = _safe_float(lat2)
    lo2 = _safe_float(lon2)
    if abs(la1) < 0.00001 and abs(lo1) < 0.00001 and abs(la2) < 0.00001 and abs(lo2) < 0.00001:
        return 0.0

    r = 6371000.0
    p1 = math.radians(la1)
    p2 = math.radians(la2)
    dlat = math.radians(la2 - la1)
    dlon = math.radians(lo2 - lo1)
    a = (math.sin(dlat / 2.0) ** 2) + math.cos(p1) * math.cos(p2) * (math.sin(dlon / 2.0) ** 2)
    c = 2.0 * math.atan2(math.sqrt(a), math.sqrt(max(0.0, 1.0 - a)))
    return float(r * c)


def _bearing_deg(lat1: Any, lon1: Any, lat2: Any, lon2: Any) -> Optional[float]:
    la1 = _safe_float(lat1)
    lo1 = _safe_float(lon1)
    la2 = _safe_float(lat2)
    lo2 = _safe_float(lon2)
    if abs(la1 - la2) < 0.000001 and abs(lo1 - lo2) < 0.000001:
        return None

    p1 = math.radians(la1)
    p2 = math.radians(la2)
    dlon = math.radians(lo2 - lo1)

    y = math.sin(dlon) * math.cos(p2)
    x = math.cos(p1) * math.sin(p2) - math.sin(p1) * math.cos(p2) * math.cos(dlon)
    brng = (math.degrees(math.atan2(y, x)) + 360.0) % 360.0
    return float(round(brng, 1))


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


async def _google_route_metrics(
    points: List[schemas.RouteMetricPoint],
    *,
    api_key: Optional[str] = None,
) -> Optional[Dict[str, Any]]:
    key = str(api_key or "").strip() or geocoding_service.get_google_maps_api_key()
    api_key = key
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


async def _google_optimize_route(
    *,
    origin: schemas.RouteMetricPoint,
    stops: List[schemas.RouteMetricPoint],
    return_to_origin: bool = True,
    api_key: Optional[str] = None,
) -> Optional[Dict[str, Any]]:
    """
    Optimize stop order with Google Directions `optimize:true` and return
    traffic-aware geometry/metrics for the optimized route.
    """
    key = str(api_key or "").strip() or geocoding_service.get_google_maps_api_key()
    api_key = key
    if not api_key:
        return None

    stop_points = list(stops or [])
    if len(stop_points) == 0:
        return {
            "optimized_order": [],
            "geometry": None,
            "distance_m": 0.0,
            "duration_s": 0.0,
            "duration_no_traffic_s": 0.0,
            "delay_s": 0.0,
            "provider": "google_traffic",
        }
    if len(stop_points) == 1:
        return {
            "optimized_order": [0],
            "geometry": None,
            "distance_m": 0.0,
            "duration_s": 0.0,
            "duration_no_traffic_s": 0.0,
            "delay_s": 0.0,
            "provider": "google_traffic",
        }

    indexed_waypoints: List[Tuple[int, schemas.RouteMetricPoint]] = []
    fixed_tail: List[int] = []

    if bool(return_to_origin):
        destination = origin
        indexed_waypoints = list(enumerate(stop_points))
    else:
        destination = stop_points[-1]
        indexed_waypoints = list(enumerate(stop_points[:-1]))
        fixed_tail = [len(stop_points) - 1]

    # Directions optimize:true supports at most 23 waypoints.
    if len(indexed_waypoints) > 23:
        return None

    origin_str = f"{float(origin.lat)},{float(origin.lon)}"
    destination_str = f"{float(destination.lat)},{float(destination.lon)}"
    traffic_model = str(os.getenv("GOOGLE_ROUTE_TRAFFIC_MODEL", "best_guess") or "best_guess").strip().lower()
    if traffic_model not in {"best_guess", "optimistic", "pessimistic"}:
        traffic_model = "best_guess"

    params: Dict[str, Any] = {
        "key": api_key,
        "origin": origin_str,
        "destination": destination_str,
        "mode": "driving",
        "departure_time": "now",
        "traffic_model": traffic_model,
    }

    if indexed_waypoints:
        wp = "|".join([f"{float(p.lat)},{float(p.lon)}" for _, p in indexed_waypoints])
        params["waypoints"] = f"optimize:true|{wp}"

    try:
        async with httpx.AsyncClient(timeout=20.0) as client:
            res = await client.get("https://maps.googleapis.com/maps/api/directions/json", params=params)
    except Exception:
        return None

    if res.status_code != 200:
        return None

    payload = res.json() if callable(getattr(res, "json", None)) else {}
    if str(payload.get("status") or "").strip().upper() != "OK":
        return None

    routes = payload.get("routes") if isinstance(payload, dict) else None
    route = routes[0] if isinstance(routes, list) and routes else None
    if not isinstance(route, dict):
        return None

    raw_order = route.get("waypoint_order")
    waypoint_order: List[int] = []
    if isinstance(raw_order, list):
        for item in raw_order:
            try:
                idx = int(item)
            except Exception:
                continue
            if idx < 0 or idx >= len(indexed_waypoints):
                continue
            waypoint_order.append(idx)

    if len(waypoint_order) != len(indexed_waypoints):
        waypoint_order = list(range(len(indexed_waypoints)))

    optimized_order = [indexed_waypoints[i][0] for i in waypoint_order]
    if fixed_tail:
        optimized_order.extend(fixed_tail)

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
        duration_s += _safe_float(duration_traffic) if duration_traffic is not None else normal_s

    delay_s = max(0.0, float(duration_s) - float(duration_no_traffic_s))

    return {
        "optimized_order": optimized_order,
        "geometry": geometry,
        "distance_m": float(distance_m),
        "duration_s": float(duration_s),
        "duration_no_traffic_s": float(duration_no_traffic_s),
        "delay_s": float(delay_s),
        "provider": "google_traffic",
    }


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
    default_status = "In Progress"
    try:
        models.AdminNote.__table__.create(bind=db.get_bind(), checkfirst=True)
    except Exception:
        return False

    try:
        dialect = db.bind.dialect.name  # type: ignore[union-attr]
    except Exception:
        dialect = ""

    try:
        if dialect == "postgresql":
            db.execute(text("ALTER TABLE admin_notes ADD COLUMN IF NOT EXISTS status TEXT"))
            db.execute(
                text("UPDATE admin_notes SET status = :status WHERE status IS NULL OR BTRIM(status) = ''"),
                {"status": default_status},
            )
            db.commit()
            return True

        if dialect == "sqlite":
            exists = db.execute(
                text("SELECT name FROM sqlite_master WHERE type='table' AND name='admin_notes' LIMIT 1")
            ).fetchone()
            if not exists:
                return False

            existing = [row[1] for row in db.execute(text("PRAGMA table_info(admin_notes)")).fetchall()]
            if "status" not in existing:
                db.execute(text("ALTER TABLE admin_notes ADD COLUMN status TEXT"))
            db.execute(
                text("UPDATE admin_notes SET status = :status WHERE status IS NULL OR TRIM(status) = ''"),
                {"status": default_status},
            )
            db.commit()
            return True
    except Exception:
        db.rollback()
        return False

    return True


_ADMIN_NOTE_STATUS_DEFAULT = "In Progress"
_ADMIN_NOTE_STATUS_LABELS = {
    "not_started": "Not Started",
    "in_progress": "In Progress",
    "resolved": "Resolved",
}
_ADMIN_NOTE_STATUS_ALIASES = {
    "not started": "Not Started",
    "new": "Not Started",
    "todo": "Not Started",
    "to do": "Not Started",
    "pending": "Not Started",
    "in progress": "In Progress",
    "inprogress": "In Progress",
    "working": "In Progress",
    "in lucru": "In Progress",
    "wip": "In Progress",
    "resolved": "Resolved",
    "done": "Resolved",
    "completed": "Resolved",
    "complete": "Resolved",
    "fixed": "Resolved",
    "rezolvat": "Resolved",
    "rezolvata": "Resolved",
}


def _normalize_admin_note_status(value: Any, *, default: str = _ADMIN_NOTE_STATUS_DEFAULT) -> str:
    raw = str(value or "").strip()
    if not raw:
        return default
    folded = _fold_text(raw)
    mapped = _ADMIN_NOTE_STATUS_ALIASES.get(folded)
    if mapped:
        return mapped
    for label in _ADMIN_NOTE_STATUS_LABELS.values():
        if folded == _fold_text(label):
            return label
    return default


def _ensure_tenant_schema(db: Session) -> bool:
    """
    Runtime-safe schema bootstrap for multi-warehouse and store scoping.
    """
    try:
        models.Warehouse.__table__.create(bind=db.get_bind(), checkfirst=True)
        models.Store.__table__.create(bind=db.get_bind(), checkfirst=True)
        models.CarrierPartner.__table__.create(bind=db.get_bind(), checkfirst=True)
    except Exception:
        return False

    try:
        dialect = db.bind.dialect.name  # type: ignore[union-attr]
    except Exception:
        dialect = ""

    def _ensure_columns(table_name: str, columns: List[Tuple[str, str, str]]) -> None:
        if dialect == "postgresql":
            try:
                exists = db.execute(
                    text(f"SELECT 1 FROM information_schema.tables WHERE table_name = '{table_name}' LIMIT 1")
                ).fetchone()
            except Exception:
                exists = None
            if not exists:
                return
            for name, pg_type, _sqlite_type in columns:
                db.execute(text(f"ALTER TABLE {table_name} ADD COLUMN IF NOT EXISTS {name} {pg_type}"))
            db.commit()
            return

        if dialect == "sqlite":
            try:
                exists = db.execute(
                    text(f"SELECT name FROM sqlite_master WHERE type='table' AND name='{table_name}' LIMIT 1")
                ).fetchone()
            except Exception:
                exists = None
            if not exists:
                return
            existing = [row[1] for row in db.execute(text(f"PRAGMA table_info({table_name})")).fetchall()]
            for name, _pg_type, sqlite_type in columns:
                if name in existing:
                    continue
                db.execute(text(f"ALTER TABLE {table_name} ADD COLUMN {name} {sqlite_type}"))
                db.commit()

    _ensure_columns(
        "drivers",
        [
            ("warehouse_id", "INTEGER", "INTEGER"),
            ("store_id", "INTEGER", "INTEGER"),
        ],
    )
    _ensure_columns(
        "shipments",
        [
            ("warehouse_id", "INTEGER", "INTEGER"),
            ("store_id", "INTEGER", "INTEGER"),
            ("return_confirmed_at", "TIMESTAMP", "DATETIME"),
            ("return_confirmed_by", "TEXT", "TEXT"),
        ],
    )
    return True


def _scope_key(value: Any) -> str:
    folded = _fold_text(value)
    return re.sub(r"[^a-z0-9]+", "", folded)


def _store_by_id(db: Session, store_id: Optional[int]) -> Optional[models.Store]:
    try:
        sid = int(store_id) if store_id is not None else 0
    except Exception:
        sid = 0
    if sid <= 0:
        return None
    # Per-request cache to avoid N+1 lookups when evaluating shipment visibility.
    try:
        cache = db.info.setdefault("_arynik_store_by_id_cache", {})
    except Exception:
        cache = {}
    if sid in cache:
        return cache.get(sid)
    row = db.query(models.Store).filter(models.Store.id == sid).first()
    try:
        cache[sid] = row
    except Exception:
        pass
    return row


def _shipment_matches_store_scope(db: Session, ship: models.Shipment, store: Optional[models.Store]) -> bool:
    if not store:
        return False

    try:
        ship_store_id = int(getattr(ship, "store_id", 0) or 0)
    except Exception:
        ship_store_id = 0
    if ship_store_id and ship_store_id == int(store.id):
        return True

    sender_location = getattr(ship, "sender_location", None) if isinstance(getattr(ship, "sender_location", None), dict) else {}
    client_data = getattr(ship, "client_data", None) if isinstance(getattr(ship, "client_data", None), dict) else {}
    candidates = [
        getattr(ship, "sender_shop_name", None),
        sender_location.get("name") if isinstance(sender_location, dict) else None,
        sender_location.get("shopName") if isinstance(sender_location, dict) else None,
        client_data.get("name") if isinstance(client_data, dict) else None,
        client_data.get("clientName") if isinstance(client_data, dict) else None,
    ]
    store_name_key = _scope_key(getattr(store, "name", None))
    store_code_key = _scope_key(getattr(store, "code", None))
    if not store_name_key and not store_code_key:
        return False

    for cand in candidates:
        key = _scope_key(cand)
        if not key:
            continue
        if store_code_key and key == store_code_key:
            return True
        if store_name_key and (key == store_name_key or store_name_key in key or key in store_name_key):
            return True
    return False


def _shipment_matches_warehouse_scope(db: Session, ship: models.Shipment, warehouse_id: Optional[int]) -> bool:
    try:
        wid = int(warehouse_id) if warehouse_id is not None else 0
    except Exception:
        wid = 0
    if wid <= 0:
        return True

    try:
        ship_wid = int(getattr(ship, "warehouse_id", 0) or 0)
    except Exception:
        ship_wid = 0
    if ship_wid and ship_wid == wid:
        return True

    try:
        ship_store_id = int(getattr(ship, "store_id", 0) or 0)
    except Exception:
        ship_store_id = 0
    if ship_store_id > 0:
        store = _store_by_id(db, ship_store_id)
        if store and int(getattr(store, "warehouse_id", 0) or 0) == wid:
            return True

    return False


def _shipment_visible_to_user(
    db: Session,
    *,
    current_driver: models.Driver,
    ship: models.Shipment,
    include_driver_pool: bool = False,
) -> bool:
    role = authz.normalize_role(current_driver.role)
    if role == authz.ROLE_RECIPIENT:
        return _shipment_recipient_authorized(db, current_driver=current_driver, ship=ship)

    if role == authz.ROLE_DRIVER:
        my_driver_id = str(current_driver.driver_id or "").strip().upper()
        ship_driver_id = str(getattr(ship, "driver_id", "") or "").strip().upper()
        if ship_driver_id and ship_driver_id == my_driver_id:
            return True
        if include_driver_pool and not ship_driver_id and _is_driver_pool_status(getattr(ship, "status", None), getattr(ship, "processing_status", None)):
            return True
        return False

    if role == authz.ROLE_STORE:
        cache_key = "_arynik_scope_store_obj"
        store = getattr(current_driver, cache_key, None)
        if store is None:
            store = _store_by_id(db, getattr(current_driver, "store_id", None))
            try:
                setattr(current_driver, cache_key, store)
            except Exception:
                pass
        return _shipment_matches_store_scope(db, ship, store)

    if role == authz.ROLE_WAREHOUSE:
        return _shipment_matches_warehouse_scope(db, ship, getattr(current_driver, "warehouse_id", None))

    return True


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


def _normalize_manual_awb(value: Any) -> str:
    raw = str(value or "").strip().upper()
    if not raw:
        return ""
    compact = "".join(ch for ch in raw if ch.isalnum())
    return compact


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

@app.api_route("/health", methods=["GET", "HEAD"])
async def health(request: Request):
    if request.method == "HEAD":
        return Response(status_code=200)
    return {
        "ok": True,
        "time": datetime.utcnow().isoformat() + "Z",
        "postis_base_url": POSTIS_BASE_URL,
        "postis_configured": bool(POSTIS_USER and POSTIS_PASS),
        "google_maps_configured": bool(geocoding_service.get_google_maps_api_key()),
    }


@app.get("/admin/provider-secrets", response_model=schemas.ProviderSecretsStatusResponse)
async def get_provider_secrets_status(
    current_driver: models.Driver = Depends(permission_required(authz.PERM_USERS_WRITE)),
):
    role = authz.normalize_role(current_driver.role)
    if role != authz.ROLE_ADMIN:
        raise HTTPException(status_code=403, detail="Only admins can view provider secrets status.")
    return _provider_secrets_status_response()


@app.post("/admin/provider-secrets", response_model=schemas.ProviderSecretsUpdateResponse)
async def update_provider_secrets(
    request: schemas.ProviderSecretsUpdateRequest,
    current_driver: models.Driver = Depends(permission_required(authz.PERM_USERS_WRITE)),
):
    role = authz.normalize_role(current_driver.role)
    if role != authz.ROLE_ADMIN:
        raise HTTPException(status_code=403, detail="Only admins can update provider secrets.")

    persist = bool(request.persist_to_env)
    if request.openai_api_key is not None:
        _persist_env_secret("OPENAI_API_KEY", request.openai_api_key, persist_to_env=persist)
    if request.elevenlabs_api_key is not None:
        _persist_env_secret("ELEVENLABS_API_KEY", request.elevenlabs_api_key, persist_to_env=persist)

    status_payload = _provider_secrets_status_response()
    return schemas.ProviderSecretsUpdateResponse(
        ok=True,
        saved_to_env=persist,
        openai_api_key=status_payload.openai_api_key,
        elevenlabs_api_key=status_payload.elevenlabs_api_key,
    )


@app.get("/admin/maps-provider-config", response_model=schemas.MapsProviderConfigResponse)
async def get_maps_provider_config(
    db: Session = Depends(database.get_db),
    current_driver: models.Driver = Depends(permission_required(authz.PERM_USERS_WRITE)),
):
    role = authz.normalize_role(current_driver.role)
    if role != authz.ROLE_ADMIN:
        raise HTTPException(status_code=403, detail="Only admins can view maps provider config.")
    owner_user_id = str(current_driver.driver_id or "").strip().upper()
    return _maps_config_response_for_admin(db, owner_user_id)


@app.post("/admin/maps-provider-config", response_model=schemas.MapsProviderConfigResponse)
async def update_maps_provider_config(
    request: schemas.MapsProviderConfigUpdateRequest,
    db: Session = Depends(database.get_db),
    current_driver: models.Driver = Depends(permission_required(authz.PERM_USERS_WRITE)),
):
    role = authz.normalize_role(current_driver.role)
    if role != authz.ROLE_ADMIN:
        raise HTTPException(status_code=403, detail="Only admins can update maps provider config.")
    if not _ensure_maps_provider_schema():
        raise HTTPException(status_code=503, detail="Maps provider settings unavailable.")

    owner_user_id = str(current_driver.driver_id or "").strip().upper()
    row = _maps_get_or_create_config(db, owner_user_id)
    if not row:
        raise HTTPException(status_code=503, detail="Maps provider settings unavailable.")

    if request.maps_mode is not None:
        mode = _maps_normalize_mode(request.maps_mode)
        row.maps_mode = mode

    if request.own_maps_api_key is not None:
        own_key = str(request.own_maps_api_key or "").strip()
        row.own_maps_api_key = own_key or None

    if request.platform_google_maps_api_key is not None:
        _persist_env_secret("GOOGLE_MAPS_API_KEY", request.platform_google_maps_api_key, persist_to_env=bool(request.persist_to_env))

    row.updated_at = datetime.utcnow()
    db.commit()

    return _maps_config_response_for_admin(db, owner_user_id)


@app.post("/admin/maps-provider-credit", response_model=schemas.MapsProviderCreditTopupResponse)
async def topup_maps_provider_credit(
    request: schemas.MapsProviderCreditTopupRequest,
    db: Session = Depends(database.get_db),
    current_driver: models.Driver = Depends(permission_required(authz.PERM_USERS_WRITE)),
):
    role = authz.normalize_role(current_driver.role)
    if role != authz.ROLE_ADMIN:
        raise HTTPException(status_code=403, detail="Only admins can top up maps provider credit.")
    if not _ensure_maps_provider_schema():
        raise HTTPException(status_code=503, detail="Maps provider settings unavailable.")

    amount = float(request.amount or 0.0)
    if amount <= 0:
        raise HTTPException(status_code=400, detail="amount must be greater than 0")

    owner_user_id = str(current_driver.driver_id or "").strip().upper()
    row = _maps_get_or_create_config(db, owner_user_id)
    if not row:
        raise HTTPException(status_code=503, detail="Maps provider settings unavailable.")

    row.platform_credit_balance = float(getattr(row, "platform_credit_balance", 0.0) or 0.0) + float(amount)
    row.updated_at = datetime.utcnow()
    usage_event = models.MapsProviderUsage(
        owner_user_id=owner_user_id,
        provider="google_maps",
        mode="platform",
        action="credit_topup",
        requests_count=0,
        estimated_cost=-float(amount),
        meta={"note": str(request.note or "").strip() or None},
    )
    db.add(usage_event)
    db.commit()

    return schemas.MapsProviderCreditTopupResponse(
        ok=True,
        owner_user_id=owner_user_id,
        amount_added=float(amount),
        platform_credit_balance=float(getattr(row, "platform_credit_balance", 0.0) or 0.0),
        platform_usage_requests=int(getattr(row, "platform_usage_requests", 0) or 0),
        platform_usage_cost=float(getattr(row, "platform_usage_cost", 0.0) or 0.0),
    )


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
async def get_me(
    db: Session = Depends(database.get_db),
    current_driver: models.Driver = Depends(get_current_driver),
):
    _ensure_tenant_schema(db)
    role = authz.normalize_role(current_driver.role)
    warehouse_name = None
    store_name = None
    try:
        wid = int(getattr(current_driver, "warehouse_id", 0) or 0)
    except Exception:
        wid = 0
    if wid > 0:
        wh = db.query(models.Warehouse).filter(models.Warehouse.id == wid).first()
        warehouse_name = str(getattr(wh, "name", "") or "").strip() or None

    try:
        sid = int(getattr(current_driver, "store_id", 0) or 0)
    except Exception:
        sid = 0
    if sid > 0:
        st = db.query(models.Store).filter(models.Store.id == sid).first()
        store_name = str(getattr(st, "name", "") or "").strip() or None

    # Prefer explicit fleet assignment metadata over legacy driver profile fields.
    resolved_truck_plate = None
    resolved_truck_phone = None
    resolved_helper_name = str(getattr(current_driver, "helper_name", "") or "").strip() or None
    try:
        if fleet_service.ensure_fleet_schema(db):
            active_asg = fleet_service.get_active_assignment(
                db,
                driver_id=str(getattr(current_driver, "driver_id", "") or "").strip(),
                phone_label=None,
            )
            if active_asg:
                vehicle = db.query(models.FleetVehicle).filter(
                    models.FleetVehicle.id == int(getattr(active_asg, "vehicle_id", 0) or 0)
                ).first()
                resolved_truck_plate = (
                    str(getattr(vehicle, "plate", "") or "").strip().upper()
                    or str(getattr(active_asg, "vehicle_plate", "") or "").strip().upper()
                    or resolved_truck_plate
                )
                resolved_truck_phone = (
                    str(getattr(vehicle, "assigned_phone", "") or "").strip()
                    or str(getattr(active_asg, "phone_label", "") or "").strip()
                    or resolved_truck_phone
                )
                resolved_helper_name = (
                    str(getattr(vehicle, "helper_name", "") or "").strip()
                    or resolved_helper_name
                )
    except Exception:
        pass

    return {
        "driver_id": current_driver.driver_id,
        "name": current_driver.name,
        "username": current_driver.username,
        "role": role,
        "active": current_driver.active,
        "truck_plate": resolved_truck_plate,
        "truck_phone": resolved_truck_phone,
        "helper_name": resolved_helper_name,
        "warehouse_id": getattr(current_driver, "warehouse_id", None),
        "warehouse_name": warehouse_name,
        "store_id": getattr(current_driver, "store_id", None),
        "store_name": store_name,
        "vehicle_type_code": current_driver.vehicle_type_code,
        "vehicle_has_lift": current_driver.vehicle_has_lift,
        "max_volume_m3": current_driver.max_volume_m3,
        "target_volume_m3": current_driver.target_volume_m3,
        "max_weight_kg": current_driver.max_weight_kg,
        "target_weight_kg": current_driver.target_weight_kg,
        "last_login": current_driver.last_login,
        "permissions": _permissions_for_role(role),
    }


@app.post("/me/device-phone", response_model=schemas.MeDevicePhoneSyncResponse)
async def sync_me_device_phone(
    request: schemas.MeDevicePhoneSyncRequest,
    db: Session = Depends(database.get_db),
    current_driver: models.Driver = Depends(get_current_driver),
):
    _ensure_tenant_schema(db)
    role = authz.normalize_role(getattr(current_driver, "role", None))
    if role != authz.ROLE_DRIVER:
        raise HTTPException(status_code=403, detail="Only drivers can sync device phone.")

    raw_phone = str(request.phone_number or "").strip()
    if not raw_phone:
        raise HTTPException(status_code=400, detail="phone_number is required")

    phone_norm = phone_service.normalize_phone(raw_phone or "")
    if not phone_norm:
        raise HTTPException(status_code=400, detail="Invalid phone number")

    phone_e164 = phone_service.to_e164(phone_norm) or raw_phone
    changed = False
    try:
        if fleet_service.ensure_fleet_schema(db):
            phone_row = (
                db.query(models.FleetPhoneNumber)
                .filter(models.FleetPhoneNumber.phone_norm == str(phone_norm).strip())
                .first()
            )
            if not phone_row:
                phone_row = fleet_service.create_phone_number(
                    db,
                    phone_number=phone_e164,
                    label=f"Device {str(getattr(current_driver, 'driver_id', '') or '').strip().upper()}",
                    active=True,
                    notes="Synced from mobile app",
                )
                changed = True
            else:
                if str(getattr(phone_row, "phone_number", "") or "").strip() != str(phone_e164).strip():
                    phone_row.phone_number = str(phone_e164).strip()
                    changed = True
                if getattr(phone_row, "active", True) is False:
                    phone_row.active = True
                    changed = True
            phone_row.last_seen_at = datetime.utcnow()
            changed = True
    except Exception:
        pass

    if changed:
        db.commit()

    return schemas.MeDevicePhoneSyncResponse(
        driver_id=str(getattr(current_driver, "driver_id", "") or ""),
        truck_phone=str(phone_e164 or "").strip() or None,
        phone_norm=str(phone_norm or "").strip() or None,
        updated=bool(changed),
        source=str(request.source or "").strip() or None,
    )

@app.get("/notifications", response_model=List[schemas.NotificationSchema])
async def list_notifications(
    limit: int = 50,
    unread_only: bool = False,
    scope: str = "mine",
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

    role = authz.normalize_role(current_driver.role)
    scope_norm = str(scope or "mine").strip().lower()
    if scope_norm not in {"mine", "company"}:
        scope_norm = "mine"

    allow_company_scope = role in {
        authz.ROLE_ADMIN,
        authz.ROLE_MANAGER,
        authz.ROLE_DISPATCHER,
        authz.ROLE_SUPPORT,
        authz.ROLE_WAREHOUSE,
        authz.ROLE_FINANCE,
    }

    if scope_norm == "company" and allow_company_scope:
        q = db.query(models.Notification)
    else:
        scope_norm = "mine"
        q = db.query(models.Notification).filter(models.Notification.user_id == current_driver.driver_id)
    if unread_only:
        q = q.filter(models.Notification.read_at.is_(None))

    rows = q.order_by(models.Notification.created_at.desc()).limit(limit_n).all()
    if scope_norm != "company":
        return rows

    # Enrich with target user info in `data` so frontend can classify internal/external comms.
    target_ids = sorted(
        {
            str(getattr(n, "user_id", "") or "").strip().upper()
            for n in rows
            if str(getattr(n, "user_id", "") or "").strip()
        }
    )
    target_role_by_id: Dict[str, str] = {}
    target_name_by_id: Dict[str, str] = {}
    if target_ids:
        drivers_service.ensure_drivers_schema(db)
        users = (
            db.query(models.Driver.driver_id, models.Driver.role, models.Driver.name, models.Driver.username)
            .filter(models.Driver.driver_id.in_(target_ids))
            .all()
        )
        for driver_id, role_raw, name, username in users:
            key = str(driver_id or "").strip().upper()
            if not key:
                continue
            target_role_by_id[key] = authz.normalize_role(role_raw)
            display = str(name or "").strip() or str(username or "").strip()
            if display:
                target_name_by_id[key] = display

    out: List[Dict[str, Any]] = []
    for n in rows:
        uid = str(getattr(n, "user_id", "") or "").strip().upper()
        data_raw = n.data if isinstance(n.data, dict) else {}
        data = dict(data_raw)
        data.setdefault("target_user_id", uid or None)
        data.setdefault("target_role", target_role_by_id.get(uid))
        data.setdefault("target_name", target_name_by_id.get(uid))
        out.append(
            {
                "id": n.id,
                "user_id": n.user_id,
                "created_at": n.created_at,
                "read_at": n.read_at,
                "title": n.title,
                "body": n.body,
                "awb": n.awb,
                "data": data or None,
            }
        )
    return out


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
    status_value = _normalize_admin_note_status(request.status, default=_ADMIN_NOTE_STATUS_DEFAULT)

    note = models.AdminNote(
        created_at=datetime.utcnow(),
        created_by_user_id=current_driver.driver_id,
        created_by_name=(str(current_driver.name or current_driver.username or "").strip() or None),
        text=text[:4000],
        status=status_value,
    )
    db.add(note)
    db.commit()
    db.refresh(note)
    return note


@app.patch("/admin/notes/{note_id}", response_model=schemas.AdminNoteSchema)
async def update_admin_note(
    note_id: int,
    request: schemas.AdminNoteUpdate,
    db: Session = Depends(database.get_db),
    current_driver: models.Driver = Depends(permission_required(authz.PERM_USERS_WRITE)),
):
    role = authz.normalize_role(current_driver.role)
    if role != authz.ROLE_ADMIN:
        raise HTTPException(status_code=403, detail="Only admins can update improvement notes")
    if not _ensure_admin_notes_schema(db):
        raise HTTPException(status_code=503, detail="Notes unavailable")

    note = db.query(models.AdminNote).filter(models.AdminNote.id == note_id).first()
    if not note:
        raise HTTPException(status_code=404, detail="Note not found")

    note.status = _normalize_admin_note_status(request.status, default=str(getattr(note, "status", "") or _ADMIN_NOTE_STATUS_DEFAULT))
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
        normalized = _normalize_ro_coord_pair(lat_raw, lon_raw)
        if not normalized:
            raise HTTPException(status_code=400, detail="Location must be inside Romania bounds.")
        lat, lon = normalized
        data = dict(data)
        data["latitude"] = float(lat)
        data["longitude"] = float(lon)

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
            normalized_pin = _normalize_ro_coord_pair(lat_raw, lon_raw)
            if normalized_pin:
                lat = float(normalized_pin[0])
                lon = float(normalized_pin[1])
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


def _assistant_awb_candidates(question: str, explicit_awb: Optional[str] = None) -> List[str]:
    out: List[str] = []

    def _add(value: Optional[str]) -> None:
        candidate = postis_client.normalize_shipment_identifier(value or "")
        candidate = str(candidate or "").strip().upper()
        if not candidate or len(candidate) < 6:
            return
        if candidate in out:
            return
        out.append(candidate)

    _add(explicit_awb)

    text = str(question or "").strip()
    if text:
        for token in re.findall(r"[A-Za-z0-9]{6,28}", text):
            normalized = postis_client.normalize_shipment_identifier(token)
            normalized = str(normalized or "").strip().upper()
            if not normalized:
                continue
            # Keep probable shipment-like values (mixed or numeric identifiers that include digits).
            if not any(ch.isdigit() for ch in normalized):
                continue
            _add(normalized)

    return out[:8]


def _assistant_shipment_summary(ship: models.Shipment) -> Dict[str, Any]:
    return {
        "awb": str(getattr(ship, "awb", "") or "").strip().upper() or None,
        "status": str(getattr(ship, "status", "") or "").strip() or None,
        "recipient_name": str(getattr(ship, "recipient_name", "") or "").strip() or None,
        "recipient_phone": str(getattr(ship, "recipient_phone", "") or "").strip() or None,
        "delivery_address": str(getattr(ship, "delivery_address", "") or "").strip() or None,
        "locality": str(getattr(ship, "locality", "") or "").strip() or None,
        "county": str(getattr(ship, "county", "") or "").strip() or None,
        "cod_amount": float(getattr(ship, "cod_amount", 0.0) or 0.0),
        "driver_id": str(getattr(ship, "driver_id", "") or "").strip().upper() or None,
        "awb_status_date": (getattr(ship, "awb_status_date", None).isoformat() if getattr(ship, "awb_status_date", None) else None),
    }


@app.post("/assistant/ask", response_model=schemas.AssistantAskResponse)
async def assistant_ask(
    request: schemas.AssistantAskRequest,
    db: Session = Depends(database.get_db),
    current_driver: models.Driver = Depends(permission_required(authz.PERM_CHAT_READ)),
):
    question = str(request.question or "").strip()
    if not question:
        raise HTTPException(status_code=400, detail="question is required")

    role = authz.normalize_role(current_driver.role)
    shipments_service.ensure_shipments_schema(db)

    candidates = _assistant_awb_candidates(question, request.awb)
    shipment_rows: List[Dict[str, Any]] = []
    matched_awbs: List[str] = []
    for candidate in candidates:
        ship = _find_shipment_by_awb(db, candidate)
        if not ship:
            continue
        summary = _assistant_shipment_summary(ship)
        awb = str(summary.get("awb") or "").strip().upper()
        if not awb or awb in matched_awbs:
            continue
        matched_awbs.append(awb)
        shipment_rows.append(summary)
        if len(shipment_rows) >= 5:
            break

    context_payload: Dict[str, Any] = {
        "user": {
            "driver_id": str(current_driver.driver_id or "").strip().upper() or None,
            "name": str(current_driver.name or "").strip() or None,
            "role": role,
            "truck_plate": str(getattr(current_driver, "truck_plate", "") or "").strip().upper() or None,
            "helper_name": str(getattr(current_driver, "helper_name", "") or "").strip() or None,
        },
        "app_features": [
            "shipments_awb_tracking",
            "routes_planning_and_execution",
            "manifests_unload_load",
            "notifications_and_chat",
            "cod_finance_reporting",
            "users_and_fleet_management",
        ],
        "shipments": shipment_rows,
        "thread_id": int(request.thread_id) if isinstance(request.thread_id, int) else None,
        "client_context": request.context if isinstance(request.context, dict) else None,
    }

    result = await assistant_service.answer_question(
        question=question,
        role=role,
        context=context_payload,
    )

    return schemas.AssistantAskResponse(
        answer=str(result.get("answer") or "").strip() or "Nu am putut genera un raspuns.",
        suggestions=result.get("suggestions") if isinstance(result.get("suggestions"), list) else [],
        provider=str(result.get("provider") or "local_fallback"),
        model=str(result.get("model") or "").strip() or None,
        context_awbs=matched_awbs or None,
    )


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


def _active_recipient_users_for_shipment(db: Session, ship: Optional[models.Shipment]) -> Tuple[List[models.Driver], Optional[str]]:
    if not ship:
        return [], None
    phone_norm = str(getattr(ship, "recipient_phone_norm", "") or "").strip() or phone_service.normalize_phone(
        getattr(ship, "recipient_phone", "") or ""
    )
    if not phone_norm:
        return [], None
    rows = (
        db.query(models.Driver)
        .filter(models.Driver.active.is_(True))
        .filter(models.Driver.phone_norm == phone_norm)
        .all()
    )
    out = [u for u in (rows or []) if authz.normalize_role(getattr(u, "role", None)) == authz.ROLE_RECIPIENT]
    return out, phone_norm


def _find_active_helper_user(db: Session, helper_name: Optional[str]) -> Optional[models.Driver]:
    helper = str(helper_name or "").strip()
    if not helper:
        return None
    helper_upper = helper.upper()

    exact = (
        db.query(models.Driver)
        .filter(models.Driver.active.is_(True))
        .filter(
            or_(
                func.upper(models.Driver.driver_id) == helper_upper,
                func.upper(models.Driver.username) == helper_upper,
            )
        )
        .first()
    )
    if exact:
        return exact

    by_name = (
        db.query(models.Driver)
        .filter(models.Driver.active.is_(True))
        .filter(func.lower(models.Driver.name) == helper.lower())
        .all()
    )
    if not by_name:
        return None

    # Prefer non-recipient users for helper assignment notifications.
    by_name.sort(key=lambda x: 1 if authz.normalize_role(getattr(x, "role", None)) == authz.ROLE_RECIPIENT else 0)
    return by_name[0]


def _parse_plan_date_local(plan_date: Optional[str]) -> datetime:
    tz = _ops_timezone()
    txt = str(plan_date or "").strip()
    if txt:
        try:
            d = datetime.strptime(txt, "%Y-%m-%d")
            return datetime(d.year, d.month, d.day, 0, 0, 0, tzinfo=tz)
        except Exception:
            pass
    return datetime.now(tz=tz).replace(hour=0, minute=0, second=0, microsecond=0)


def _route_eta_window_for_stop(plan_date: Optional[str], stop_index: int) -> Dict[str, Optional[str]]:
    base_day = _parse_plan_date_local(plan_date)
    try:
        start_hour_raw = int(str(os.getenv("ROUTE_ESTIMATE_START_HOUR", "9")).strip() or 9)
    except Exception:
        start_hour_raw = 9
    try:
        stop_step_min_raw = int(str(os.getenv("ROUTE_ESTIMATE_STEP_MINUTES", "20")).strip() or 20)
    except Exception:
        stop_step_min_raw = 20
    try:
        slot_window_min_raw = int(str(os.getenv("ROUTE_ESTIMATE_WINDOW_MINUTES", "60")).strip() or 60)
    except Exception:
        slot_window_min_raw = 60
    start_hour = _clamp_int(
        start_hour_raw,
        default=9,
        min_v=5,
        max_v=20,
    )
    stop_step_min = _clamp_int(
        stop_step_min_raw,
        default=20,
        min_v=5,
        max_v=240,
    )
    slot_window_min = _clamp_int(
        slot_window_min_raw,
        default=60,
        min_v=30,
        max_v=300,
    )

    idx = max(0, int(stop_index or 0))
    start_local = base_day.replace(hour=start_hour, minute=0, second=0, microsecond=0) + timedelta(minutes=idx * stop_step_min)
    end_local = start_local + timedelta(minutes=slot_window_min)
    return {
        "eta_from": start_local.isoformat(),
        "eta_to": end_local.isoformat(),
        "eta_label": f"{start_local.strftime('%H:%M')}-{end_local.strftime('%H:%M')}",
        "eta_date_label": start_local.strftime("%d.%m.%Y"),
    }


def _route_assignment_summary(*, plan: models.RoutePlan, shipments_by_awb: Dict[str, models.Shipment]) -> Dict[str, Any]:
    awbs = [str(x or "").strip().upper() for x in (plan.awbs or []) if str(x or "").strip()]
    cod_total = 0.0
    bib_count = 0
    parcels_total = 0

    for awb in awbs:
        ship = shipments_by_awb.get(awb)
        if not ship:
            continue
        cod_total += max(0.0, _safe_float(getattr(ship, "cod_amount", 0.0)))
        parcels_total += max(1, int(getattr(ship, "number_of_parcels", 1) or 1))
        if _shipment_requires_buy_back_photo(ship):
            bib_count += 1

    return {
        "awb_count": len(awbs),
        "cod_total": round(cod_total, 2),
        "bib_count": int(bib_count),
        "parcels_total": int(parcels_total),
    }


def _public_app_base_url() -> str:
    candidates = (
        os.getenv("APP_PUBLIC_URL"),
        os.getenv("PUBLIC_APP_URL"),
        os.getenv("FRONTEND_PUBLIC_URL"),
    )
    for c in candidates:
        value = str(c or "").strip().rstrip("/")
        if value:
            return value
    return ""


def _public_signup_link(awb: Optional[str] = None) -> Optional[str]:
    base = _public_app_base_url()
    if not base:
        return None
    if awb:
        return f"{base}/#/signup?awb={str(awb).strip().upper()}"
    return f"{base}/#/signup"


def _external_delivery_assignment_message(
    *,
    ship: models.Shipment,
    route_name: str,
    eta_label: str,
    eta_date_label: str,
    signup_url: Optional[str],
) -> str:
    awb = str(getattr(ship, "awb", "") or "").strip().upper()
    base = (
        f"AWB {awb} a fost alocat pe ruta {route_name}. "
        f"Estimare livrare: {eta_date_label} {eta_label}."
    )
    base += " Vei putea vedea live camionul cand soferul marcheaza plecarea spre adresa ta."
    base += " Daca nu esti acasa, te rugam sa reprogramezi din timp livrarea (dimineata/dupa-amiaza, sloturi de 3 ore)."
    if signup_url:
        base += f" Creeaza cont: {signup_url}"
    return base


def _notify_route_assignment(
    db: Session,
    *,
    plan: models.RoutePlan,
    assigned_by_user_id: Optional[str],
) -> None:
    notifications_service.ensure_notifications_schema(db)
    contacts_service.ensure_contacts_schema(db)
    shipments_service.ensure_shipments_schema(db)

    awbs = [str(x or "").strip().upper() for x in (plan.awbs or []) if str(x or "").strip()]
    if not awbs:
        return

    shipment_rows = db.query(models.Shipment).filter(models.Shipment.awb.in_(awbs)).all()
    shipments_by_awb = {
        str(getattr(s, "awb", "") or "").strip().upper(): s
        for s in (shipment_rows or [])
        if str(getattr(s, "awb", "") or "").strip()
    }
    summary = _route_assignment_summary(plan=plan, shipments_by_awb=shipments_by_awb)
    route_name = str(getattr(plan, "name", "") or "").strip() or f"{str(getattr(plan, 'county', '') or '').strip()} #{int(getattr(plan, 'route_index', 1) or 1)}"

    cod_txt = f"{float(summary.get('cod_total') or 0.0):.2f} RON"
    driver_title = "Ruta aprobata si alocata"
    driver_body = (
        f"Ruta {route_name} ti-a fost atribuita. "
        f"AWB: {int(summary.get('awb_count') or 0)} | COD: {cod_txt} | "
        f"BIB: {int(summary.get('bib_count') or 0)} | Obiecte/colete: {int(summary.get('parcels_total') or 0)}."
    )

    assigned_driver_id = str(getattr(plan, "assigned_driver_id", "") or "").strip().upper()
    if assigned_driver_id:
        notifications_service.create_notification(
            db,
            user_id=assigned_driver_id,
            title=driver_title,
            body=driver_body,
            data={
                "type": "route_assignment",
                "route_plan_id": int(getattr(plan, "id", 0) or 0),
                "route_name": route_name,
                "plan_date": getattr(plan, "plan_date", None),
                "awb_count": int(summary.get("awb_count") or 0),
                "cod_total": float(summary.get("cod_total") or 0.0),
                "bib_count": int(summary.get("bib_count") or 0),
                "parcels_total": int(summary.get("parcels_total") or 0),
                "vehicle_plate": str(getattr(plan, "assigned_vehicle_plate", "") or "").strip().upper() or None,
                "helper_name": str(getattr(plan, "assigned_helper_name", "") or "").strip() or None,
                "assigned_by_user_id": str(assigned_by_user_id or "").strip().upper() or None,
            },
        )

    helper_user = _find_active_helper_user(db, getattr(plan, "assigned_helper_name", None))
    if helper_user and str(helper_user.driver_id or "").strip().upper() != assigned_driver_id:
        notifications_service.create_notification(
            db,
            user_id=helper_user.driver_id,
            title=driver_title,
            body=driver_body,
            data={
                "type": "route_assignment_helper",
                "route_plan_id": int(getattr(plan, "id", 0) or 0),
                "route_name": route_name,
                "plan_date": getattr(plan, "plan_date", None),
                "assigned_driver_id": assigned_driver_id or None,
                "vehicle_plate": str(getattr(plan, "assigned_vehicle_plate", "") or "").strip().upper() or None,
                "assigned_by_user_id": str(assigned_by_user_id or "").strip().upper() or None,
            },
        )

    signup_url = _public_signup_link()
    for idx, awb in enumerate(awbs):
        ship = shipments_by_awb.get(awb)
        if not ship:
            continue

        eta = _route_eta_window_for_stop(getattr(plan, "plan_date", None), idx)
        eta_label = str(eta.get("eta_label") or "").strip() or "N/A"
        eta_date_label = str(eta.get("eta_date_label") or "").strip() or ""
        rec_title = "AWB alocat la ruta de livrare"
        rec_body = (
            f"AWB {awb} a fost alocat pe ruta {route_name}. "
            f"Estimare livrare: {eta_date_label} {eta_label}. "
            "Daca nu esti acasa, te rugam sa reprogramezi din timp livrarea."
        ).strip()
        rec_data = {
            "type": "route_awb_assigned",
            "awb": awb,
            "route_plan_id": int(getattr(plan, "id", 0) or 0),
            "route_name": route_name,
            "plan_date": getattr(plan, "plan_date", None),
            "eta_from": eta.get("eta_from"),
            "eta_to": eta.get("eta_to"),
            "eta_label": eta_label,
            "reschedule_periods": ["morning", "afternoon"],
            "reschedule_slot_minutes": 180,
        }

        recipients, _phone_norm = _active_recipient_users_for_shipment(db, ship)
        if recipients:
            for rec in recipients:
                notifications_service.create_notification(
                    db,
                    user_id=rec.driver_id,
                    title=rec_title,
                    body=rec_body,
                    awb=awb,
                    data=rec_data,
                )
            continue

        msg = _external_delivery_assignment_message(
            ship=ship,
            route_name=route_name,
            eta_label=eta_label,
            eta_date_label=eta_date_label,
            signup_url=_public_signup_link(awb),
        )

        phone = str(getattr(ship, "recipient_phone", "") or "").strip()
        email = str(getattr(ship, "recipient_email", "") or "").strip()
        whatsapp_ok = False
        if phone:
            whatsapp_ok = bool(whatsapp_service.send_whatsapp_message(phone, msg))
            contacts_service.log_contact_attempt(
                db,
                created_by_user_id=assigned_by_user_id or assigned_driver_id or "SYSTEM",
                created_by_role="system",
                awb=awb,
                channel="whatsapp",
                to_phone=phone,
                outcome="sent" if whatsapp_ok else "failed",
                notes="Route assignment customer notification",
                data={
                    "type": "route_awb_assigned_external",
                    "eta_label": eta_label,
                    "route_plan_id": int(getattr(plan, "id", 0) or 0),
                },
            )
        if (not whatsapp_ok) and phone:
            contacts_service.log_contact_attempt(
                db,
                created_by_user_id=assigned_by_user_id or assigned_driver_id or "SYSTEM",
                created_by_role="system",
                awb=awb,
                channel="sms",
                to_phone=phone,
                outcome="not_configured",
                notes="SMS provider not configured in repo.",
                data={
                    "type": "route_awb_assigned_external",
                    "eta_label": eta_label,
                    "route_plan_id": int(getattr(plan, "id", 0) or 0),
                },
            )
        if (not whatsapp_ok) and email:
            contacts_service.log_contact_attempt(
                db,
                created_by_user_id=assigned_by_user_id or assigned_driver_id or "SYSTEM",
                created_by_role="system",
                awb=awb,
                channel="email",
                to_phone=None,
                outcome="not_configured",
                notes=f"Email provider not configured in repo. Target email: {email}",
                data={
                    "type": "route_awb_assigned_external",
                    "eta_label": eta_label,
                    "route_plan_id": int(getattr(plan, "id", 0) or 0),
                    "recipient_email": email,
                    "signup_url": signup_url,
                },
            )


def _route_stop_allows_recipient_tracking(db: Session, *, awb: str, driver_id: Optional[str]) -> bool:
    if not awb:
        return False
    if not route_runs_service.ensure_route_runs_schema(db):
        return False
    key_awb = str(awb or "").strip().upper()
    key_driver = str(driver_id or "").strip().upper()

    q = (
        db.query(models.RouteRunStop, models.RouteRun)
        .join(models.RouteRun, models.RouteRun.id == models.RouteRunStop.run_id)
        .filter(models.RouteRunStop.awb == key_awb)
        .filter(models.RouteRun.status == "Active")
    )
    if key_driver:
        q = q.filter(func.upper(models.RouteRun.driver_id) == key_driver)
    rows = q.order_by(models.RouteRun.started_at.desc().nullslast(), models.RouteRun.id.desc()).all()
    if not rows:
        return False

    for stop, _run in rows:
        state = str(getattr(stop, "state", "") or "").strip().lower()
        if state in {"ontheway", "on_the_way", "enroute", "en_route", "arrived", "done"}:
            return True
        data = getattr(stop, "data", None)
        if isinstance(data, dict):
            if bool(data.get("tracking_visible")) or bool(data.get("on_the_way")) or bool(data.get("allow_recipient_tracking")):
                return True
    return False


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
            if not _route_stop_allows_recipient_tracking(
                db,
                awb=awb,
                driver_id=str(getattr(ship, "driver_id", "") or "").strip().upper() or None,
            ):
                raise HTTPException(
                    status_code=409,
                    detail="Live tracking becomes available after the driver marks departure towards your address.",
                )
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

    role = authz.normalize_role(current_driver.role)
    if role == authz.ROLE_RECIPIENT and req.awb:
        ship = _find_shipment_by_awb(db, req.awb)
        target_driver = str(getattr(ship, "driver_id", "") or "").strip().upper() if ship else None
        if not _route_stop_allows_recipient_tracking(db, awb=req.awb, driver_id=target_driver):
            raise HTTPException(
                status_code=409,
                detail="Live tracking becomes available after the driver marks departure towards your address.",
            )

    now = datetime.utcnow()
    if _auto_activate_tracking_request(db, req, now=now):
        db.commit()
        db.refresh(req)

    if not tracking_service.is_request_active(req, now=now):
        raise HTTPException(status_code=409, detail="Tracking is not active")

    loc_rows = (
        db.query(models.DriverLocation)
        .filter(models.DriverLocation.driver_id == req.target_driver_id)
        .order_by(models.DriverLocation.timestamp.desc(), models.DriverLocation.id.desc())
        .limit(50)
        .all()
    )
    picked_loc = None
    picked_coords = None
    for row in (loc_rows or []):
        if req.accepted_at and row.timestamp and row.timestamp < req.accepted_at:
            continue
        normalized = _normalize_ro_coord_pair(getattr(row, "latitude", None), getattr(row, "longitude", None))
        if not normalized:
            continue
        picked_loc = row
        picked_coords = normalized
        break

    if not picked_loc or not picked_coords:
        raise HTTPException(status_code=404, detail="No location yet")

    return {
        "request_id": req.id,
        "driver_id": req.target_driver_id,
        "latitude": float(picked_coords[0]),
        "longitude": float(picked_coords[1]),
        "timestamp": picked_loc.timestamp,
    }


@app.get("/roles", response_model=List[schemas.RoleInfoSchema])
async def list_roles(current_driver: models.Driver = Depends(get_current_driver)):
    role_descriptions = {
        authz.ROLE_ADMIN: "Full access (users, drivers, shipments, labels, logs).",
        authz.ROLE_MANAGER: "Operations manager (shipments, labels, updates, read users, all logs).",
        authz.ROLE_DISPATCHER: "Dispatcher (shipments, labels, updates, all logs).",
        authz.ROLE_WAREHOUSE: "Warehouse (shipments, labels, updates, own logs).",
        authz.ROLE_STORE: "Store account (sees only store-linked shipments; can create/operate AWBs for own store).",
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


def _fleet_phone_or_404(db: Session, phone_id: int) -> models.FleetPhoneNumber:
    row = db.query(models.FleetPhoneNumber).filter(models.FleetPhoneNumber.id == int(phone_id)).first()
    if not row:
        raise HTTPException(status_code=404, detail="Fleet phone not found")
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
    fleet_service.refresh_compliance_statuses(db)
    return fleet_service.fleet_overview(db, days=days, include_inactive=include_inactive)


@app.get("/fleet/vehicles", response_model=List[schemas.FleetVehicleSchema])
async def list_fleet_vehicles(
    include_inactive: bool = False,
    sync_from_drivers: bool = False,
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


@app.get("/fleet/assignments/active", response_model=List[schemas.FleetVehicleAssignmentSchema])
async def list_active_fleet_assignments(
    driver_id: Optional[str] = None,
    vehicle_id: Optional[int] = None,
    phone_id: Optional[int] = None,
    limit: int = 100,
    db: Session = Depends(database.get_db),
    current_driver: models.Driver = Depends(permission_required(authz.PERM_SHIPMENTS_READ)),
):
    _ = current_driver
    if not fleet_service.ensure_fleet_schema(db):
        raise HTTPException(status_code=503, detail="Fleet unavailable")
    return fleet_service.active_assignments(
        db,
        driver_id=driver_id,
        vehicle_id=vehicle_id,
        phone_id=phone_id,
        limit=limit,
    )


@app.get("/fleet/phones", response_model=List[schemas.FleetPhoneNumberSchema])
async def list_fleet_phones(
    include_inactive: bool = False,
    db: Session = Depends(database.get_db),
    current_driver: models.Driver = Depends(permission_required(authz.PERM_SHIPMENTS_READ)),
):
    _ = current_driver
    if not fleet_service.ensure_fleet_schema(db):
        raise HTTPException(status_code=503, detail="Fleet unavailable")
    return fleet_service.list_phone_numbers(db, include_inactive=include_inactive)


@app.post("/fleet/phones", response_model=schemas.FleetPhoneNumberSchema, status_code=201)
async def create_fleet_phone(
    request: schemas.FleetPhoneNumberCreate,
    db: Session = Depends(database.get_db),
    current_driver: models.Driver = Depends(permission_required(authz.PERM_USERS_WRITE)),
):
    _ = current_driver
    if not fleet_service.ensure_fleet_schema(db):
        raise HTTPException(status_code=503, detail="Fleet unavailable")
    try:
        row = fleet_service.create_phone_number(
            db,
            phone_number=request.phone_number,
            label=request.label,
            active=bool(request.active) if request.active is not None else True,
            notes=request.notes,
        )
        db.commit()
        db.refresh(row)
        return row
    except ValueError as e:
        raise HTTPException(status_code=409, detail=str(e))


@app.patch("/fleet/phones/{phone_id}", response_model=schemas.FleetPhoneNumberSchema)
async def update_fleet_phone(
    phone_id: int,
    request: schemas.FleetPhoneNumberUpdate,
    db: Session = Depends(database.get_db),
    current_driver: models.Driver = Depends(permission_required(authz.PERM_USERS_WRITE)),
):
    _ = current_driver
    if not fleet_service.ensure_fleet_schema(db):
        raise HTTPException(status_code=503, detail="Fleet unavailable")
    row = _fleet_phone_or_404(db, phone_id)
    patch = _schema_dump_exclude_unset(request)
    try:
        fleet_service.update_phone_number(
            db,
            row=row,
            phone_number=patch.get("phone_number"),
            label=patch.get("label"),
            active=patch.get("active"),
            notes=patch.get("notes"),
            patch_fields=set(patch.keys()),
        )
        db.commit()
        db.refresh(row)
        return row
    except ValueError as e:
        raise HTTPException(status_code=409, detail=str(e))


@app.post("/fleet/assignments", response_model=schemas.FleetVehicleAssignmentSchema, status_code=201)
async def assign_vehicle_to_driver(
    request: schemas.FleetVehicleAssignmentCreate,
    db: Session = Depends(database.get_db),
    current_driver: models.Driver = Depends(permission_required(authz.PERM_USERS_WRITE)),
):
    if not fleet_service.ensure_fleet_schema(db):
        raise HTTPException(status_code=503, detail="Fleet unavailable")
    drivers_service.ensure_drivers_schema(db)

    did = _fleet_resolve_driver_id_or_raise(db, request.driver_id)
    if not did:
        raise HTTPException(status_code=400, detail="driver_id is required")

    vehicle = None
    if request.vehicle_id is not None:
        vehicle = _fleet_vehicle_or_404(db, int(request.vehicle_id))
    else:
        plate = _fleet_clean_plate(request.vehicle_plate)
        if plate:
            vehicle = db.query(models.FleetVehicle).filter(models.FleetVehicle.plate == plate).first()
        if not vehicle:
            raise HTTPException(status_code=400, detail="vehicle_id or vehicle_plate is required")

    assignment = fleet_service.activate_assignment(
        db,
        driver_id=did,
        vehicle=vehicle,
        phone_id=request.phone_id,
        phone_label=request.phone_label,
        assigned_by_user_id=current_driver.driver_id,
        source=request.source or "fleet_manual_assignment",
        notes=request.notes,
        assigned_at=datetime.utcnow(),
    )

    # Keep vehicle card aligned with assignment (driver and phone currently active).
    driver_obj = db.query(models.Driver).filter(models.Driver.driver_id == did).first()
    vehicle.assigned_driver_id = did
    vehicle.assigned_driver_name = (
        str(getattr(driver_obj, "name", "") or "").strip()
        or str(vehicle.assigned_driver_name or "").strip()
        or None
    )
    selected_phone = None
    try:
        req_phone_id = int(request.phone_id) if request.phone_id is not None else 0
    except Exception:
        req_phone_id = 0
    if req_phone_id > 0:
        selected_phone = _fleet_phone_or_404(db, int(req_phone_id))
    if selected_phone is not None:
        vehicle.assigned_phone = str(getattr(selected_phone, "phone_number", "") or "").strip() or vehicle.assigned_phone
    elif request.phone_label:
        vehicle.assigned_phone = str(request.phone_label).strip()

    # Detach same driver from any other vehicle card to keep one active mapping.
    others = (
        db.query(models.FleetVehicle)
        .filter(models.FleetVehicle.id != int(vehicle.id), models.FleetVehicle.assigned_driver_id == did)
        .all()
    )
    for row in others:
        row.assigned_driver_id = None
        row.assigned_driver_name = None
        if request.phone_label and str(row.assigned_phone or "").strip() == str(request.phone_label).strip():
            row.assigned_phone = None

    db.commit()
    db.refresh(assignment)
    return assignment


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
    db.flush()
    if row.assigned_driver_id:
        fleet_service.activate_assignment(
            db,
            driver_id=str(row.assigned_driver_id),
            vehicle=row,
            phone_label=row.assigned_phone,
            assigned_by_user_id=current_driver.driver_id,
            source="fleet_vehicle_create",
            notes="Manual assignment from fleet vehicle create form",
        )
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

    volume_fields_touched = ("max_volume_m3" in patch) or ("target_volume_m3" in patch)
    weight_fields_touched = ("max_weight_kg" in patch) or ("target_weight_kg" in patch)
    if volume_fields_touched:
        _validate_vehicle_capacity_pair(
            max_value=row.max_volume_m3,
            target_value=row.target_volume_m3,
            max_field="max_volume_m3",
            target_field="target_volume_m3",
        )
    if weight_fields_touched:
        _validate_vehicle_capacity_pair(
            max_value=row.max_weight_kg,
            target_value=row.target_weight_kg,
            max_field="max_weight_kg",
            target_field="target_weight_kg",
        )

    if row.assigned_driver_id:
        fleet_service.activate_assignment(
            db,
            driver_id=str(row.assigned_driver_id),
            vehicle=row,
            phone_label=row.assigned_phone,
            assigned_by_user_id=current_driver.driver_id,
            source="fleet_vehicle_update",
            notes="Manual assignment from fleet vehicle update form",
        )
    else:
        fleet_service.deactivate_assignments(
            db,
            vehicle_id=int(row.id),
            now=datetime.utcnow(),
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


def _tenant_clean_code(value: Any, *, field_name: str) -> str:
    text_val = str(value or "").strip().upper()
    text_val = re.sub(r"[^A-Z0-9_-]+", "_", text_val)
    text_val = re.sub(r"_+", "_", text_val).strip("_")
    if not text_val:
        raise HTTPException(status_code=400, detail=f"{field_name} is required")
    if len(text_val) > 80:
        raise HTTPException(status_code=400, detail=f"{field_name} is too long")
    return text_val


_CARRIER_PRIORITY_WEIGHTS: Dict[str, Dict[str, float]] = {
    "balanced": {"cost": 0.40, "speed": 0.35, "distance": 0.25},
    "cost": {"cost": 0.70, "speed": 0.15, "distance": 0.15},
    "speed": {"cost": 0.15, "speed": 0.70, "distance": 0.15},
    "distance": {"cost": 0.20, "speed": 0.20, "distance": 0.60},
}


def _carrier_clean_code(value: Any) -> str:
    return _tenant_clean_code(value, field_name="carrier code")


def _safe_float(value: Any, default: Optional[float] = 0.0) -> Optional[float]:
    try:
        if value is None or value == "":
            return default
        if isinstance(value, str):
            txt = value.strip().replace(",", ".")
            if not txt:
                return default
            num = float(txt)
        else:
            num = float(value)
            
        if num != num:  # Check for NaN locally
            return default
        return num
    except Exception:
        return default


def _safe_positive_float(value: Any, *, default: float = 0.0, min_value: float = 0.0) -> float:
    v = _safe_float(value, default)
    if v is None:
        return default
    return max(float(min_value), float(v))


def _clamp01(value: float) -> float:
    return max(0.0, min(1.0, float(value)))


def _normalize_carrier_priority(value: Any) -> str:
    key = str(value or "").strip().lower()
    if key not in _CARRIER_PRIORITY_WEIGHTS:
        return "balanced"
    return key


def _default_carrier_specs() -> List[Dict[str, Any]]:
    return [
        {
            "code": "ARYNIK_DIRECT",
            "name": "Arynik Direct Fleet",
            "integration_mode": "arynik_direct",
            "base_fee": 10.0,
            "cost_per_km": 1.55,
            "cost_per_kg": 0.35,
            "cod_fee_percent": 0.5,
            "avg_speed_kmph": 52.0,
            "base_eta_hours": 10.0,
            "service_radius_km": 220.0,
            "priority_bonus": 0.08,
            "active": True,
            "notes": "Operare proprie Arynik pentru livrari regionale/expres.",
        },
        {
            "code": "POSTIS_NETWORK",
            "name": "Postis Network",
            "integration_mode": "postis_allocated",
            "base_fee": 13.5,
            "cost_per_km": 1.85,
            "cost_per_kg": 0.42,
            "cod_fee_percent": 0.9,
            "avg_speed_kmph": 45.0,
            "base_eta_hours": 14.0,
            "service_radius_km": None,
            "priority_bonus": 0.04,
            "active": True,
            "notes": "Flux agregat Postis, cu acoperire nationala.",
        },
        {
            "code": "REGIONAL_FLANCO",
            "name": "Regional Flanco Partner",
            "integration_mode": "partner_api",
            "base_fee": 9.0,
            "cost_per_km": 1.30,
            "cost_per_kg": 0.30,
            "cod_fee_percent": 0.6,
            "avg_speed_kmph": 41.0,
            "base_eta_hours": 11.0,
            "service_radius_km": 140.0,
            "priority_bonus": 0.02,
            "active": True,
            "notes": "Partener regional eficient pe distante scurte/medii.",
        },
    ]


def _ensure_default_carriers(db: Session) -> None:
    rows = db.query(models.CarrierPartner).all()
    existing = {
        str(getattr(r, "code", "") or "").strip().upper()
        for r in (rows or [])
        if str(getattr(r, "code", "") or "").strip()
    }
    changed = False
    for spec in _default_carrier_specs():
        code = str(spec.get("code") or "").strip().upper()
        if not code or code in existing:
            continue
        db.add(models.CarrierPartner(**spec))
        changed = True
    if changed:
        db.commit()


def _default_flanco_warehouse_specs() -> List[Dict[str, Any]]:
    return [
        {
            "code": "WH-BACAU",
            "name": "Depozit Bacau",
            "address": "Bacau, Romania",
            "latitude": 46.5667,
            "longitude": 26.9167,
            "active": True,
        },
        {
            "code": "WH-IASI",
            "name": "Depozit Iasi",
            "address": "Iasi, Romania",
            "latitude": 47.1585,
            "longitude": 27.6014,
            "active": True,
        },
        {
            "code": "WH-SUCEAVA",
            "name": "Depozit Suceava",
            "address": "Suceava, Romania",
            "latitude": 47.6514,
            "longitude": 26.2556,
            "active": True,
        },
    ]


def _default_flanco_store_specs() -> List[Dict[str, Any]]:
    return [
        {
            "code": "FLN-BC-SUPERNOVA",
            "name": "Flanco Smart Discounter Bacau Supernova",
            "warehouse_code": "WH-BACAU",
            "address": "Calea Republicii 181, Bacau",
            "latitude": 46.5710,
            "longitude": 26.9200,
            "active": True,
        },
        {
            "code": "FLN-IS-KA-NICOLINA",
            "name": "Flanco Iasi Kaufland Nicolina",
            "warehouse_code": "WH-IASI",
            "address": "Soseaua Nicolina 57, Iasi",
            "latitude": 47.1383,
            "longitude": 27.5928,
            "active": True,
        },
        {
            "code": "FLN-SV-CARREFOUR",
            "name": "Flanco Suceava Carrefour",
            "warehouse_code": "WH-SUCEAVA",
            "address": "Calea Unirii 27B, Suceava",
            "latitude": 47.6488,
            "longitude": 26.2525,
            "active": True,
        },
    ]


def _default_flanco_store_user_specs() -> List[Dict[str, str]]:
    return [
        {
            "store_code": "FLN-BC-SUPERNOVA",
            "driver_id": "SFLBC001",
            "username": "flanco.bacau.supernova",
            "name": "Flanco Bacau Supernova",
        },
        {
            "store_code": "FLN-IS-KA-NICOLINA",
            "driver_id": "SFLIS001",
            "username": "flanco.iasi.nicolina",
            "name": "Flanco Iasi Nicolina",
        },
        {
            "store_code": "FLN-SV-CARREFOUR",
            "driver_id": "SFLSV001",
            "username": "flanco.suceava.carrefour",
            "name": "Flanco Suceava Carrefour",
        },
    ]


def _slug_login(value: Any, *, separator: str = ".") -> str:
    raw = unicodedata.normalize("NFKD", str(value or ""))
    ascii_text = raw.encode("ascii", "ignore").decode("ascii")
    cleaned = re.sub(r"[^a-z0-9]+", separator, ascii_text.lower())
    cleaned = cleaned.strip(separator)
    return cleaned or "store"


def _unique_username(db: Session, base: str, *, current_driver_id: Optional[str] = None) -> str:
    seed = _slug_login(base)
    candidate = seed
    idx = 2
    while True:
        row = db.query(models.Driver).filter(func.lower(models.Driver.username) == candidate.lower()).first()
        if not row:
            return candidate
        if current_driver_id and str(getattr(row, "driver_id", "") or "").strip().upper() == str(current_driver_id).strip().upper():
            return candidate
        candidate = f"{seed}{idx}"
        idx += 1


def _ensure_default_warehouses_and_stores(db: Session) -> Dict[str, int]:
    if not _ensure_tenant_schema(db):
        return {"warehouses_created": 0, "stores_created": 0}

    warehouses_created = 0
    stores_created = 0
    changed = False

    warehouses_by_code: Dict[str, models.Warehouse] = {}
    for spec in _default_flanco_warehouse_specs():
        code = _tenant_clean_code(spec.get("code"), field_name="warehouse code")
        row = db.query(models.Warehouse).filter(func.upper(models.Warehouse.code) == code).first()
        if not row:
            row = models.Warehouse(
                code=code,
                name=str(spec.get("name") or "").strip() or code,
                address=str(spec.get("address") or "").strip() or None,
                latitude=_safe_float(spec.get("latitude"), None),
                longitude=_safe_float(spec.get("longitude"), None),
                active=bool(spec.get("active", True)),
            )
            db.add(row)
            db.flush()
            warehouses_created += 1
            changed = True
        else:
            next_name = str(spec.get("name") or "").strip() or row.name
            next_address = str(spec.get("address") or "").strip() or None
            next_lat = _safe_float(spec.get("latitude"), getattr(row, "latitude", None))
            next_lon = _safe_float(spec.get("longitude"), getattr(row, "longitude", None))
            next_active = bool(spec.get("active", True))
            if (
                str(getattr(row, "name", "") or "") != next_name
                or str(getattr(row, "address", "") or "") != str(next_address or "")
                or _safe_float(getattr(row, "latitude", None), None) != next_lat
                or _safe_float(getattr(row, "longitude", None), None) != next_lon
                or bool(getattr(row, "active", True)) != next_active
            ):
                row.name = next_name
                row.address = next_address
                row.latitude = next_lat
                row.longitude = next_lon
                row.active = next_active
                changed = True
        warehouses_by_code[code] = row

    stores_by_code: Dict[str, models.Store] = {}
    for spec in _default_flanco_store_specs():
        code = _tenant_clean_code(spec.get("code"), field_name="store code")
        warehouse_code = _tenant_clean_code(spec.get("warehouse_code"), field_name="warehouse_code")
        warehouse = warehouses_by_code.get(warehouse_code)
        if not warehouse:
            warehouse = db.query(models.Warehouse).filter(func.upper(models.Warehouse.code) == warehouse_code).first()
        if not warehouse:
            continue

        row = db.query(models.Store).filter(func.upper(models.Store.code) == code).first()
        if not row:
            row = models.Store(
                code=code,
                name=str(spec.get("name") or "").strip() or code,
                warehouse_id=int(getattr(warehouse, "id", 0) or 0) or None,
                address=str(spec.get("address") or "").strip() or None,
                latitude=_safe_float(spec.get("latitude"), None),
                longitude=_safe_float(spec.get("longitude"), None),
                active=bool(spec.get("active", True)),
            )
            db.add(row)
            db.flush()
            stores_created += 1
            changed = True
        else:
            next_name = str(spec.get("name") or "").strip() or row.name
            next_address = str(spec.get("address") or "").strip() or None
            next_lat = _safe_float(spec.get("latitude"), getattr(row, "latitude", None))
            next_lon = _safe_float(spec.get("longitude"), getattr(row, "longitude", None))
            next_active = bool(spec.get("active", True))
            next_wid = int(getattr(warehouse, "id", 0) or 0) or None
            if (
                str(getattr(row, "name", "") or "") != next_name
                or str(getattr(row, "address", "") or "") != str(next_address or "")
                or _safe_float(getattr(row, "latitude", None), None) != next_lat
                or _safe_float(getattr(row, "longitude", None), None) != next_lon
                or bool(getattr(row, "active", True)) != next_active
                or (int(getattr(row, "warehouse_id", 0) or 0) or None) != next_wid
            ):
                row.name = next_name
                row.address = next_address
                row.latitude = next_lat
                row.longitude = next_lon
                row.active = next_active
                row.warehouse_id = next_wid
                changed = True
        stores_by_code[code] = row

    if changed:
        db.commit()
    return {"warehouses_created": warehouses_created, "stores_created": stores_created}


def _seed_flanco_store_accounts(
    db: Session,
    *,
    reset_passwords: bool = False,
    include_passwords: bool = False,
) -> List[Dict[str, str]]:
    if not _ensure_tenant_schema(db):
        return []
    drivers_service.ensure_drivers_schema(db)
    _ensure_default_warehouses_and_stores(db)

    default_password = str(os.getenv("FLANCO_STORE_DEFAULT_PASSWORD", "FlancoStore123!") or "FlancoStore123!").strip()
    if len(default_password) < 8:
        default_password = "FlancoStore123!"

    stores_by_code: Dict[str, models.Store] = {}
    for row in db.query(models.Store).all():
        code = str(getattr(row, "code", "") or "").strip().upper()
        if code:
            stores_by_code[code] = row

    changed = False
    out_rows: List[Dict[str, str]] = []
    for spec in _default_flanco_store_user_specs():
        store_code = _tenant_clean_code(spec.get("store_code"), field_name="store_code")
        store = stores_by_code.get(store_code)
        if not store:
            continue

        preferred_username = str(spec.get("username") or "").strip().lower() or _slug_login(
            f"flanco-{getattr(store, 'code', '')}",
            separator=".",
        )
        preferred_driver_id = str(spec.get("driver_id") or "").strip().upper() or f"S{store_code}"
        display_name = str(spec.get("name") or getattr(store, "name", "") or "").strip() or preferred_username

        existing = db.query(models.Driver).filter(func.lower(models.Driver.username) == preferred_username.lower()).first()
        if not existing:
            existing = (
                db.query(models.Driver)
                .filter(
                    models.Driver.store_id == int(getattr(store, "id", 0) or 0),
                    func.lower(models.Driver.role) == "store",
                )
                .first()
            )
        if not existing:
            existing = db.query(models.Driver).filter(models.Driver.driver_id == preferred_driver_id).first()

        if existing:
            current_driver_id = str(getattr(existing, "driver_id", "") or "").strip().upper() or preferred_driver_id
            desired_username = _unique_username(db, preferred_username, current_driver_id=current_driver_id)
            if str(getattr(existing, "name", "") or "").strip() != display_name:
                existing.name = display_name
                changed = True
            if str(getattr(existing, "role", "") or "").strip() != authz.ROLE_STORE:
                existing.role = authz.ROLE_STORE
                changed = True
            if not bool(getattr(existing, "active", False)):
                existing.active = True
                changed = True
            if (int(getattr(existing, "warehouse_id", 0) or 0) or None) != (int(getattr(store, "warehouse_id", 0) or 0) or None):
                existing.warehouse_id = int(getattr(store, "warehouse_id", 0) or 0) or None
                changed = True
            if (int(getattr(existing, "store_id", 0) or 0) or None) != (int(getattr(store, "id", 0) or 0) or None):
                existing.store_id = int(getattr(store, "id", 0) or 0) or None
                changed = True
            if str(getattr(existing, "username", "") or "").strip().lower() != desired_username.lower():
                existing.username = desired_username
                changed = True

            if reset_passwords:
                existing.password_hash = driver_manager.get_password_hash(default_password)
                changed = True

            out_rows.append(
                {
                    "driver_id": str(getattr(existing, "driver_id", "") or "").strip() or preferred_driver_id,
                    "name": str(getattr(existing, "name", "") or "").strip() or display_name,
                    "username": str(getattr(existing, "username", "") or "").strip() or preferred_username,
                    "password": default_password if include_passwords else "hidden",
                    "role": authz.ROLE_STORE,
                }
            )
            continue

        username = _unique_username(db, preferred_username)
        driver_id = _unique_driver_id(db, preferred_driver_id)
        created = models.Driver(
            driver_id=driver_id,
            name=display_name,
            username=username,
            password_hash=driver_manager.get_password_hash(default_password),
            role=authz.ROLE_STORE,
            active=True,
            warehouse_id=int(getattr(store, "warehouse_id", 0) or 0) or None,
            store_id=int(getattr(store, "id", 0) or 0) or None,
        )
        db.add(created)
        changed = True
        out_rows.append(
            {
                "driver_id": driver_id,
                "name": display_name,
                "username": username,
                "password": default_password if include_passwords else "hidden",
                "role": authz.ROLE_STORE,
            }
        )

    if changed:
        db.commit()
    return out_rows


def _coord_pair(lat: Any, lon: Any) -> Optional[Tuple[float, float]]:
    la = _safe_float(lat, None)
    lo = _safe_float(lon, None)
    if la is None or lo is None:
        return None
    if not (-90 <= la <= 90 and -180 <= lo <= 180):
        return None
    return (float(la), float(lo))


def _haversine_km(a: Tuple[float, float], b: Tuple[float, float]) -> float:
    lat1, lon1 = a
    lat2, lon2 = b
    r = 6371.0
    p1 = math.radians(lat1)
    p2 = math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * (math.sin(dl / 2) ** 2)
    return max(0.1, 2 * r * math.asin(math.sqrt(h)))


def _resolve_recommendation_origin(db: Session, *, warehouse_id: Optional[int], store_id: Optional[int]) -> Dict[str, Any]:
    wid: Optional[int] = int(warehouse_id or 0) or None
    sid: Optional[int] = int(store_id or 0) or None

    store = None
    if sid is not None:
        store = db.query(models.Store).filter(models.Store.id == sid).first()
        if not store:
            raise HTTPException(status_code=400, detail="store_id not found")
        store_wid = int(getattr(store, "warehouse_id", 0) or 0) or None
        if wid is not None and store_wid is not None and store_wid != wid:
            raise HTTPException(status_code=400, detail="store_id does not belong to warehouse_id")
        if wid is None:
            wid = store_wid

    warehouse = None
    if wid is not None:
        warehouse = db.query(models.Warehouse).filter(models.Warehouse.id == wid).first()
        if not warehouse:
            raise HTTPException(status_code=400, detail="warehouse_id not found")

    label_parts: List[str] = []
    if store:
        label_parts.append(str(getattr(store, "name", "") or "").strip())
    if warehouse:
        label_parts.append(str(getattr(warehouse, "name", "") or "").strip())
    label = " / ".join([p for p in label_parts if p]) or None
    address = (
        (str(getattr(store, "address", "") or "").strip() if store else "")
        or (str(getattr(warehouse, "address", "") or "").strip() if warehouse else "")
        or None
    )

    coords = None
    if store:
        coords = _coord_pair(getattr(store, "latitude", None), getattr(store, "longitude", None))
    if coords is None and warehouse:
        coords = _coord_pair(getattr(warehouse, "latitude", None), getattr(warehouse, "longitude", None))

    return {
        "warehouse_id": wid,
        "store_id": sid,
        "label": label,
        "address": address,
        "coords": coords,
    }


def _estimate_delivery_distance_km(
    *,
    origin: Dict[str, Any],
    distance_km: Optional[float],
    destination_latitude: Optional[float],
    destination_longitude: Optional[float],
    locality: Optional[str],
    county: Optional[str],
) -> float:
    explicit_distance = _safe_float(distance_km, None)
    if explicit_distance is not None and explicit_distance > 0:
        return max(0.3, min(3000.0, float(explicit_distance)))

    origin_coords = origin.get("coords")
    dest_coords = _coord_pair(destination_latitude, destination_longitude)
    if origin_coords and dest_coords:
        return max(0.3, min(3000.0, _haversine_km(origin_coords, dest_coords)))

    locality_key = _scope_key(locality)
    county_key = _scope_key(county)
    origin_blob = f"{origin.get('label') or ''} {origin.get('address') or ''}"
    origin_key = _scope_key(origin_blob)
    same_locality = bool(locality_key and origin_key and locality_key in origin_key)
    same_county = bool(county_key and origin_key and county_key in origin_key)

    if same_locality:
        return 8.0
    if same_county:
        return 28.0
    if locality_key:
        return 42.0
    return 25.0


def _inverse_normalized(values: List[float], *, fallback: float = 1.0) -> List[float]:
    if not values:
        return []
    lo = min(values)
    hi = max(values)
    if abs(hi - lo) < 1e-9:
        return [float(fallback) for _ in values]
    den = hi - lo
    return [max(0.0, min(1.0, (hi - v) / den)) for v in values]


def _recommend_carriers(
    db: Session,
    *,
    warehouse_id: Optional[int],
    store_id: Optional[int],
    delivery_address: Optional[str],
    locality: Optional[str],
    county: Optional[str],
    distance_km: Optional[float],
    destination_latitude: Optional[float],
    destination_longitude: Optional[float],
    weight: Optional[float],
    cod_amount: Optional[float],
    priority: Optional[str],
    carrier_codes: Optional[List[str]] = None,
) -> Dict[str, Any]:
    origin = _resolve_recommendation_origin(db, warehouse_id=warehouse_id, store_id=store_id)
    dist_km = _estimate_delivery_distance_km(
        origin=origin,
        distance_km=distance_km,
        destination_latitude=destination_latitude,
        destination_longitude=destination_longitude,
        locality=locality,
        county=county,
    )
    priority_key = _normalize_carrier_priority(priority)
    weights = _CARRIER_PRIORITY_WEIGHTS.get(priority_key, _CARRIER_PRIORITY_WEIGHTS["balanced"])

    query = db.query(models.CarrierPartner).filter(models.CarrierPartner.active == True)  # noqa: E712
    if carrier_codes:
        normalized_codes = sorted(
            {
                str(code or "").strip().upper()
                for code in (carrier_codes or [])
                if str(code or "").strip()
            }
        )
        if normalized_codes:
            query = query.filter(func.upper(models.CarrierPartner.code).in_(normalized_codes))
    carriers = query.order_by(models.CarrierPartner.name.asc()).all()
    if not carriers:
        raise HTTPException(status_code=404, detail="No active carriers configured")

    weight_kg = max(0.0, float(_safe_float(weight, 0.0) or 0.0))
    cod = max(0.0, float(_safe_float(cod_amount, 0.0) or 0.0))

    calc_rows: List[Dict[str, Any]] = []
    for row in carriers:
        base_fee = _safe_positive_float(getattr(row, "base_fee", 0.0), default=0.0)
        per_km = _safe_positive_float(getattr(row, "cost_per_km", 0.0), default=0.0)
        per_kg = _safe_positive_float(getattr(row, "cost_per_kg", 0.0), default=0.0)
        cod_fee_pct = _safe_positive_float(getattr(row, "cod_fee_percent", 0.0), default=0.0)
        speed = max(8.0, _safe_positive_float(getattr(row, "avg_speed_kmph", 45.0), default=45.0))
        eta_base = _safe_positive_float(getattr(row, "base_eta_hours", 12.0), default=12.0)
        radius = _safe_float(getattr(row, "service_radius_km", None), None)
        bonus = _safe_float(getattr(row, "priority_bonus", 0.0), 0.0) or 0.0

        estimated_cost = base_fee + (dist_km * per_km) + (weight_kg * per_kg) + (cod * (cod_fee_pct / 100.0))
        estimated_eta = eta_base + (dist_km / speed)
        if radius is None or radius <= 0:
            coverage = 1.0
        elif dist_km <= radius:
            coverage = 1.0
        else:
            over = dist_km - radius
            coverage = max(0.05, 1.0 - (over / max(60.0, radius)))

        calc_rows.append(
            {
                "row": row,
                "estimated_cost": max(0.0, estimated_cost),
                "estimated_eta_hours": max(0.5, estimated_eta),
                "coverage_score": _clamp01(coverage),
                "priority_bonus": bonus,
            }
        )

    cost_scores = _inverse_normalized([x["estimated_cost"] for x in calc_rows], fallback=1.0)
    speed_scores = _inverse_normalized([x["estimated_eta_hours"] for x in calc_rows], fallback=1.0)

    for idx, item in enumerate(calc_rows):
        item["cost_score"] = cost_scores[idx]
        item["speed_score"] = speed_scores[idx]
        item["distance_score"] = item["coverage_score"]
        total = (
            weights["cost"] * item["cost_score"]
            + weights["speed"] * item["speed_score"]
            + weights["distance"] * item["distance_score"]
            + float(item.get("priority_bonus") or 0.0)
        )
        item["total_score"] = _clamp01(total)

    calc_rows.sort(
        key=lambda item: (
            -(float(item.get("total_score") or 0.0)),
            float(item.get("estimated_eta_hours") or 0.0),
            float(item.get("estimated_cost") or 0.0),
            str(getattr(item.get("row"), "code", "") or ""),
        )
    )

    options: List[Dict[str, Any]] = []
    for idx, item in enumerate(calc_rows):
        row = item["row"]
        main_reason = {
            "cost": "Best estimated cost for this order.",
            "speed": "Fastest estimated delivery time.",
            "distance": "Best coverage for this delivery distance.",
            "balanced": "Best combined score (cost + speed + coverage).",
        }.get(priority_key, "Best combined score.")
        if idx > 0:
            if item["coverage_score"] < 0.5:
                main_reason = "Limited coverage on this route distance."
            elif priority_key == "cost":
                main_reason = "Alternative with higher estimated cost."
            elif priority_key == "speed":
                main_reason = "Alternative with slower estimated ETA."
            elif priority_key == "distance":
                main_reason = "Alternative with lower distance coverage score."
            else:
                main_reason = "Alternative option for this shipment."

        options.append(
            {
                "code": str(getattr(row, "code", "") or "").strip().upper(),
                "name": str(getattr(row, "name", "") or "").strip(),
                "integration_mode": str(getattr(row, "integration_mode", "") or "").strip() or None,
                "distance_km": round(dist_km, 2),
                "estimated_cost": round(float(item["estimated_cost"]), 2),
                "estimated_eta_hours": round(float(item["estimated_eta_hours"]), 2),
                "coverage_score": round(float(item["coverage_score"]), 4),
                "cost_score": round(float(item["cost_score"]), 4),
                "speed_score": round(float(item["speed_score"]), 4),
                "distance_score": round(float(item["distance_score"]), 4),
                "total_score": round(float(item["total_score"]), 4),
                "recommended": idx == 0,
                "reason": main_reason,
            }
        )

    return {
        "priority": priority_key,
        "origin_label": str(origin.get("label") or "").strip() or None,
        "distance_km": round(dist_km, 2),
        "recommended_code": str(options[0]["code"]) if options else None,
        "options": options,
    }


def _carrier_from_code(db: Session, code: str) -> Optional[models.CarrierPartner]:
    key = str(code or "").strip().upper()
    if not key:
        return None
    return (
        db.query(models.CarrierPartner)
        .filter(func.upper(models.CarrierPartner.code) == key)
        .first()
    )


def _scoped_recommendation_request_for_user(
    current_driver: models.Driver,
    request: schemas.CarrierRecommendationRequest,
) -> schemas.CarrierRecommendationRequest:
    role = authz.normalize_role(current_driver.role)
    payload = request

    try:
        user_warehouse_id = int(getattr(current_driver, "warehouse_id", 0) or 0) or None
    except Exception:
        user_warehouse_id = None
    try:
        user_store_id = int(getattr(current_driver, "store_id", 0) or 0) or None
    except Exception:
        user_store_id = None

    if role == authz.ROLE_STORE:
        if user_store_id is None:
            raise HTTPException(status_code=403, detail="Store account is missing store_id mapping")
        payload.store_id = user_store_id
        if user_warehouse_id is not None:
            payload.warehouse_id = user_warehouse_id
    elif role == authz.ROLE_WAREHOUSE:
        if user_warehouse_id is None:
            raise HTTPException(status_code=403, detail="Warehouse account is missing warehouse_id mapping")
        payload.warehouse_id = user_warehouse_id
        payload.store_id = None
    else:
        if user_store_id is not None and payload.store_id is not None and int(payload.store_id or 0) != user_store_id:
            raise HTTPException(status_code=403, detail="Not enough permissions for this store scope")
        if user_warehouse_id is not None and payload.warehouse_id is not None and int(payload.warehouse_id or 0) != user_warehouse_id:
            raise HTTPException(status_code=403, detail="Not enough permissions for this warehouse scope")

    return payload


@app.get("/carriers", response_model=List[schemas.CarrierPartnerSchema])
async def list_carriers(
    include_inactive: bool = False,
    db: Session = Depends(database.get_db),
    current_driver: models.Driver = Depends(permission_required(authz.PERM_SHIPMENTS_READ)),
):
    _ = current_driver
    if not _ensure_tenant_schema(db):
        return []
    _ensure_default_carriers(db)

    q = db.query(models.CarrierPartner)
    if not include_inactive:
        q = q.filter(models.CarrierPartner.active == True)  # noqa: E712
    return q.order_by(models.CarrierPartner.active.desc(), models.CarrierPartner.name.asc()).all()


@app.post("/carriers", response_model=schemas.CarrierPartnerSchema, status_code=201)
async def create_carrier(
    request: schemas.CarrierPartnerCreate,
    db: Session = Depends(database.get_db),
    current_driver: models.Driver = Depends(permission_required(authz.PERM_USERS_WRITE)),
):
    if not _ensure_tenant_schema(db):
        raise HTTPException(status_code=503, detail="Carrier registry unavailable")

    role = authz.normalize_role(current_driver.role)
    if role not in {authz.ROLE_ADMIN, authz.ROLE_MANAGER, authz.ROLE_DISPATCHER}:
        raise HTTPException(status_code=403, detail="Only admin/manager/dispatcher can create carriers")

    code = _carrier_clean_code(request.code)
    name = str(request.name or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="name is required")
    exists = _carrier_from_code(db, code)
    if exists:
        raise HTTPException(status_code=409, detail="Carrier code already exists")

    row = models.CarrierPartner(
        code=code,
        name=name,
        integration_mode=str(request.integration_mode or "").strip() or None,
        base_fee=_safe_positive_float(request.base_fee, default=0.0),
        cost_per_km=_safe_positive_float(request.cost_per_km, default=0.0),
        cost_per_kg=_safe_positive_float(request.cost_per_kg, default=0.0),
        cod_fee_percent=_safe_positive_float(request.cod_fee_percent, default=0.0),
        avg_speed_kmph=max(1.0, _safe_positive_float(request.avg_speed_kmph, default=45.0)),
        base_eta_hours=max(0.0, _safe_positive_float(request.base_eta_hours, default=12.0)),
        service_radius_km=_safe_float(request.service_radius_km, None),
        priority_bonus=_safe_float(request.priority_bonus, 0.0) or 0.0,
        active=bool(request.active),
        notes=str(request.notes or "").strip() or None,
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


@app.patch("/carriers/{carrier_id}", response_model=schemas.CarrierPartnerSchema)
async def update_carrier(
    carrier_id: int,
    request: schemas.CarrierPartnerUpdate,
    db: Session = Depends(database.get_db),
    current_driver: models.Driver = Depends(permission_required(authz.PERM_USERS_WRITE)),
):
    if not _ensure_tenant_schema(db):
        raise HTTPException(status_code=503, detail="Carrier registry unavailable")

    role = authz.normalize_role(current_driver.role)
    if role not in {authz.ROLE_ADMIN, authz.ROLE_MANAGER, authz.ROLE_DISPATCHER}:
        raise HTTPException(status_code=403, detail="Only admin/manager/dispatcher can update carriers")

    row = db.query(models.CarrierPartner).filter(models.CarrierPartner.id == int(carrier_id)).first()
    if not row:
        raise HTTPException(status_code=404, detail="Carrier not found")

    try:
        patch = request.model_dump(exclude_unset=True)
    except Exception:
        patch = request.dict(exclude_unset=True)

    if "code" in patch:
        next_code = _carrier_clean_code(patch.get("code"))
        conflict = (
            db.query(models.CarrierPartner)
            .filter(func.upper(models.CarrierPartner.code) == next_code, models.CarrierPartner.id != row.id)
            .first()
        )
        if conflict:
            raise HTTPException(status_code=409, detail="Carrier code already exists")
        row.code = next_code
    if "name" in patch:
        next_name = str(patch.get("name") or "").strip()
        if not next_name:
            raise HTTPException(status_code=400, detail="name is required")
        row.name = next_name
    if "integration_mode" in patch:
        row.integration_mode = str(patch.get("integration_mode") or "").strip() or None
    if "base_fee" in patch:
        row.base_fee = _safe_positive_float(patch.get("base_fee"), default=0.0)
    if "cost_per_km" in patch:
        row.cost_per_km = _safe_positive_float(patch.get("cost_per_km"), default=0.0)
    if "cost_per_kg" in patch:
        row.cost_per_kg = _safe_positive_float(patch.get("cost_per_kg"), default=0.0)
    if "cod_fee_percent" in patch:
        row.cod_fee_percent = _safe_positive_float(patch.get("cod_fee_percent"), default=0.0)
    if "avg_speed_kmph" in patch:
        row.avg_speed_kmph = max(1.0, _safe_positive_float(patch.get("avg_speed_kmph"), default=45.0))
    if "base_eta_hours" in patch:
        row.base_eta_hours = max(0.0, _safe_positive_float(patch.get("base_eta_hours"), default=12.0))
    if "service_radius_km" in patch:
        row.service_radius_km = _safe_float(patch.get("service_radius_km"), None)
    if "priority_bonus" in patch:
        row.priority_bonus = _safe_float(patch.get("priority_bonus"), 0.0) or 0.0
    if "active" in patch:
        row.active = bool(patch.get("active"))
    if "notes" in patch:
        row.notes = str(patch.get("notes") or "").strip() or None

    db.commit()
    db.refresh(row)
    return row


@app.post("/carriers/recommendation", response_model=schemas.CarrierRecommendationResponse)
async def recommend_carrier(
    request: schemas.CarrierRecommendationRequest,
    db: Session = Depends(database.get_db),
    current_driver: models.Driver = Depends(permission_required(authz.PERM_SHIPMENTS_READ)),
):
    if not _ensure_tenant_schema(db):
        raise HTTPException(status_code=503, detail="Carrier registry unavailable")
    _ensure_default_carriers(db)

    scoped_request = _scoped_recommendation_request_for_user(current_driver, request)
    return _recommend_carriers(
        db,
        warehouse_id=scoped_request.warehouse_id,
        store_id=scoped_request.store_id,
        delivery_address=scoped_request.delivery_address,
        locality=scoped_request.locality,
        county=scoped_request.county,
        distance_km=scoped_request.distance_km,
        destination_latitude=scoped_request.destination_latitude,
        destination_longitude=scoped_request.destination_longitude,
        weight=scoped_request.weight,
        cod_amount=scoped_request.cod_amount,
        priority=scoped_request.priority,
        carrier_codes=scoped_request.carrier_codes,
    )


@app.get("/warehouses", response_model=List[schemas.WarehouseSchema])
async def list_warehouses(
    db: Session = Depends(database.get_db),
    current_driver: models.Driver = Depends(permission_required(authz.PERM_USERS_READ)),
):
    if not _ensure_tenant_schema(db):
        return []
    return db.query(models.Warehouse).order_by(models.Warehouse.active.desc(), models.Warehouse.name.asc()).all()


@app.post("/warehouses", response_model=schemas.WarehouseSchema, status_code=201)
async def create_warehouse(
    request: schemas.WarehouseCreate,
    db: Session = Depends(database.get_db),
    current_driver: models.Driver = Depends(permission_required(authz.PERM_USERS_WRITE)),
):
    if not _ensure_tenant_schema(db):
        raise HTTPException(status_code=503, detail="Warehouse registry unavailable")

    role = authz.normalize_role(current_driver.role)
    if role not in {authz.ROLE_ADMIN, authz.ROLE_MANAGER, authz.ROLE_DISPATCHER}:
        raise HTTPException(status_code=403, detail="Only admin/manager/dispatcher can create warehouses")

    code = _tenant_clean_code(request.code, field_name="code")
    name = str(request.name or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="name is required")

    exists = db.query(models.Warehouse).filter(func.upper(models.Warehouse.code) == code).first()
    if exists:
        raise HTTPException(status_code=409, detail="Warehouse code already exists")

    row = models.Warehouse(
        code=code,
        name=name,
        address=str(request.address or "").strip() or None,
        latitude=request.latitude,
        longitude=request.longitude,
        active=bool(request.active),
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


@app.patch("/warehouses/{warehouse_id}", response_model=schemas.WarehouseSchema)
async def update_warehouse(
    warehouse_id: int,
    request: schemas.WarehouseUpdate,
    db: Session = Depends(database.get_db),
    current_driver: models.Driver = Depends(permission_required(authz.PERM_USERS_WRITE)),
):
    if not _ensure_tenant_schema(db):
        raise HTTPException(status_code=503, detail="Warehouse registry unavailable")

    role = authz.normalize_role(current_driver.role)
    if role not in {authz.ROLE_ADMIN, authz.ROLE_MANAGER, authz.ROLE_DISPATCHER}:
        raise HTTPException(status_code=403, detail="Only admin/manager/dispatcher can update warehouses")

    row = db.query(models.Warehouse).filter(models.Warehouse.id == int(warehouse_id)).first()
    if not row:
        raise HTTPException(status_code=404, detail="Warehouse not found")

    try:
        patch = request.model_dump(exclude_unset=True)
    except Exception:
        patch = request.dict(exclude_unset=True)

    if "code" in patch:
        code = _tenant_clean_code(patch.get("code"), field_name="code")
        conflict = (
            db.query(models.Warehouse)
            .filter(func.upper(models.Warehouse.code) == code, models.Warehouse.id != row.id)
            .first()
        )
        if conflict:
            raise HTTPException(status_code=409, detail="Warehouse code already exists")
        row.code = code
    if "name" in patch:
        name = str(patch.get("name") or "").strip()
        if not name:
            raise HTTPException(status_code=400, detail="name is required")
        row.name = name
    if "address" in patch:
        row.address = str(patch.get("address") or "").strip() or None
    if "latitude" in patch:
        row.latitude = patch.get("latitude")
    if "longitude" in patch:
        row.longitude = patch.get("longitude")
    if "active" in patch:
        row.active = bool(patch.get("active"))

    db.commit()
    db.refresh(row)
    return row


@app.get("/stores", response_model=List[schemas.StoreSchema])
async def list_stores(
    warehouse_id: Optional[int] = None,
    db: Session = Depends(database.get_db),
    current_driver: models.Driver = Depends(permission_required(authz.PERM_USERS_READ)),
):
    if not _ensure_tenant_schema(db):
        return []

    q = db.query(models.Store)
    if warehouse_id is not None:
        q = q.filter(models.Store.warehouse_id == int(warehouse_id))
    rows = q.order_by(models.Store.active.desc(), models.Store.name.asc()).all()

    warehouse_name_by_id: Dict[int, str] = {}
    warehouse_ids = sorted({int(getattr(r, "warehouse_id", 0) or 0) for r in rows if int(getattr(r, "warehouse_id", 0) or 0) > 0})
    if warehouse_ids:
        wh_rows = db.query(models.Warehouse).filter(models.Warehouse.id.in_(warehouse_ids)).all()
        warehouse_name_by_id = {
            int(getattr(w, "id", 0) or 0): str(getattr(w, "name", "") or "").strip()
            for w in (wh_rows or [])
            if int(getattr(w, "id", 0) or 0) > 0
        }

    out: List[Dict[str, Any]] = []
    for row in rows:
        payload = {
            "id": int(getattr(row, "id", 0) or 0),
            "code": str(getattr(row, "code", "") or "").strip(),
            "name": str(getattr(row, "name", "") or "").strip(),
            "warehouse_id": int(getattr(row, "warehouse_id", 0) or 0) or None,
            "address": str(getattr(row, "address", "") or "").strip() or None,
            "latitude": getattr(row, "latitude", None),
            "longitude": getattr(row, "longitude", None),
            "active": bool(getattr(row, "active", True)),
            "created_at": getattr(row, "created_at", None),
            "updated_at": getattr(row, "updated_at", None),
        }
        wid = int(payload.get("warehouse_id") or 0)
        payload["warehouse_name"] = warehouse_name_by_id.get(wid) if wid > 0 else None
        out.append(payload)
    return out


@app.post("/stores", response_model=schemas.StoreSchema, status_code=201)
async def create_store(
    request: schemas.StoreCreate,
    db: Session = Depends(database.get_db),
    current_driver: models.Driver = Depends(permission_required(authz.PERM_USERS_WRITE)),
):
    if not _ensure_tenant_schema(db):
        raise HTTPException(status_code=503, detail="Store registry unavailable")

    role = authz.normalize_role(current_driver.role)
    if role not in {authz.ROLE_ADMIN, authz.ROLE_MANAGER, authz.ROLE_DISPATCHER}:
        raise HTTPException(status_code=403, detail="Only admin/manager/dispatcher can create stores")

    code = _tenant_clean_code(request.code, field_name="code")
    name = str(request.name or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="name is required")

    exists = db.query(models.Store).filter(func.upper(models.Store.code) == code).first()
    if exists:
        raise HTTPException(status_code=409, detail="Store code already exists")

    wid = int(request.warehouse_id or 0) or None
    if wid is not None:
        wh = db.query(models.Warehouse).filter(models.Warehouse.id == wid).first()
        if not wh:
            raise HTTPException(status_code=400, detail="warehouse_id not found")

    row = models.Store(
        code=code,
        name=name,
        warehouse_id=wid,
        address=str(request.address or "").strip() or None,
        latitude=request.latitude,
        longitude=request.longitude,
        active=bool(request.active),
    )
    db.add(row)
    db.commit()
    db.refresh(row)

    payload = {
        "id": int(getattr(row, "id", 0) or 0),
        "code": str(getattr(row, "code", "") or "").strip(),
        "name": str(getattr(row, "name", "") or "").strip(),
        "warehouse_id": int(getattr(row, "warehouse_id", 0) or 0) or None,
        "address": str(getattr(row, "address", "") or "").strip() or None,
        "latitude": getattr(row, "latitude", None),
        "longitude": getattr(row, "longitude", None),
        "active": bool(getattr(row, "active", True)),
        "created_at": getattr(row, "created_at", None),
        "updated_at": getattr(row, "updated_at", None),
    }
    if row.warehouse_id:
        wh = db.query(models.Warehouse).filter(models.Warehouse.id == row.warehouse_id).first()
        payload["warehouse_name"] = str(getattr(wh, "name", "") or "").strip() or None
    else:
        payload["warehouse_name"] = None
    return payload


@app.patch("/stores/{store_id}", response_model=schemas.StoreSchema)
async def update_store(
    store_id: int,
    request: schemas.StoreUpdate,
    db: Session = Depends(database.get_db),
    current_driver: models.Driver = Depends(permission_required(authz.PERM_USERS_WRITE)),
):
    if not _ensure_tenant_schema(db):
        raise HTTPException(status_code=503, detail="Store registry unavailable")

    role = authz.normalize_role(current_driver.role)
    if role not in {authz.ROLE_ADMIN, authz.ROLE_MANAGER, authz.ROLE_DISPATCHER}:
        raise HTTPException(status_code=403, detail="Only admin/manager/dispatcher can update stores")

    row = db.query(models.Store).filter(models.Store.id == int(store_id)).first()
    if not row:
        raise HTTPException(status_code=404, detail="Store not found")

    try:
        patch = request.model_dump(exclude_unset=True)
    except Exception:
        patch = request.dict(exclude_unset=True)

    if "code" in patch:
        code = _tenant_clean_code(patch.get("code"), field_name="code")
        conflict = (
            db.query(models.Store)
            .filter(func.upper(models.Store.code) == code, models.Store.id != row.id)
            .first()
        )
        if conflict:
            raise HTTPException(status_code=409, detail="Store code already exists")
        row.code = code
    if "name" in patch:
        name = str(patch.get("name") or "").strip()
        if not name:
            raise HTTPException(status_code=400, detail="name is required")
        row.name = name
    if "warehouse_id" in patch:
        wid = int(patch.get("warehouse_id") or 0) or None
        if wid is not None:
            wh = db.query(models.Warehouse).filter(models.Warehouse.id == wid).first()
            if not wh:
                raise HTTPException(status_code=400, detail="warehouse_id not found")
        row.warehouse_id = wid
    if "address" in patch:
        row.address = str(patch.get("address") or "").strip() or None
    if "latitude" in patch:
        row.latitude = patch.get("latitude")
    if "longitude" in patch:
        row.longitude = patch.get("longitude")
    if "active" in patch:
        row.active = bool(patch.get("active"))

    db.commit()
    db.refresh(row)

    payload = {
        "id": int(getattr(row, "id", 0) or 0),
        "code": str(getattr(row, "code", "") or "").strip(),
        "name": str(getattr(row, "name", "") or "").strip(),
        "warehouse_id": int(getattr(row, "warehouse_id", 0) or 0) or None,
        "address": str(getattr(row, "address", "") or "").strip() or None,
        "latitude": getattr(row, "latitude", None),
        "longitude": getattr(row, "longitude", None),
        "active": bool(getattr(row, "active", True)),
        "created_at": getattr(row, "created_at", None),
        "updated_at": getattr(row, "updated_at", None),
    }
    if row.warehouse_id:
        wh = db.query(models.Warehouse).filter(models.Warehouse.id == row.warehouse_id).first()
        payload["warehouse_name"] = str(getattr(wh, "name", "") or "").strip() or None
    else:
        payload["warehouse_name"] = None
    return payload


@app.get("/users", response_model=List[schemas.Driver])
async def list_users(
    db: Session = Depends(database.get_db),
    current_driver: models.Driver = Depends(permission_required(authz.PERM_USERS_READ)),
):
    _ensure_tenant_schema(db)
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


@app.post("/users/seed-flanco-store-accounts", response_model=List[schemas.FleetAccountCredentialSchema])
async def seed_flanco_store_accounts(
    reset_passwords: bool = True,
    db: Session = Depends(database.get_db),
    current_driver: models.Driver = Depends(permission_required(authz.PERM_USERS_WRITE)),
):
    _ = current_driver
    try:
        rows = _seed_flanco_store_accounts(
            db,
            reset_passwords=bool(reset_passwords),
            include_passwords=True,
        )
        return rows
    except Exception as exc:
        db.rollback()
        raise HTTPException(status_code=500, detail=f"Failed to seed Flanco store accounts: {str(exc)}")


@app.post("/users", response_model=schemas.Driver, status_code=201)
async def create_user(
    request: schemas.DriverCreate,
    db: Session = Depends(database.get_db),
    current_driver: models.Driver = Depends(permission_required(authz.PERM_USERS_WRITE)),
):
    drivers_service.ensure_drivers_schema(db)
    _ensure_tenant_schema(db)

    role = authz.normalize_role(request.role)
    if role not in authz.VALID_ROLES:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid role. Valid roles: {', '.join(sorted(authz.VALID_ROLES))}",
        )

    try:
        requested_warehouse_id = int(request.warehouse_id or 0) or None
    except Exception:
        raise HTTPException(status_code=400, detail="warehouse_id must be numeric")
    try:
        requested_store_id = int(request.store_id or 0) or None
    except Exception:
        raise HTTPException(status_code=400, detail="store_id must be numeric")

    if requested_warehouse_id is not None:
        warehouse_exists = db.query(models.Warehouse).filter(models.Warehouse.id == requested_warehouse_id).first()
        if not warehouse_exists:
            raise HTTPException(status_code=400, detail="warehouse_id not found")

    store_obj = None
    if requested_store_id is not None:
        store_obj = db.query(models.Store).filter(models.Store.id == requested_store_id).first()
        if not store_obj:
            raise HTTPException(status_code=400, detail="store_id not found")
        store_wid = int(getattr(store_obj, "warehouse_id", 0) or 0) or None
        if requested_warehouse_id is not None and store_wid is not None and store_wid != requested_warehouse_id:
            raise HTTPException(status_code=400, detail="store_id does not belong to warehouse_id")
        if requested_warehouse_id is None:
            requested_warehouse_id = store_wid

    if role == authz.ROLE_STORE and requested_store_id is None:
        raise HTTPException(status_code=400, detail="Store users require store_id")
    if role == authz.ROLE_WAREHOUSE and requested_warehouse_id is None:
        raise HTTPException(status_code=400, detail="Warehouse users require warehouse_id")

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
        warehouse_id=requested_warehouse_id,
        store_id=requested_store_id,
    )

    # Maintain normalization used for recipient RBAC / WhatsApp routing.
    try:
        phone_norm = phone_service.normalize_phone(driver.phone_number or "")
        driver.phone_norm = phone_norm or None
    except Exception:
        driver.phone_norm = None

    db.add(driver)
    try:
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        detail = "Cannot save user due to a unique constraint conflict."
        msg = str(getattr(exc, "orig", exc) or "").lower()
        if "driver_id" in msg:
            detail = "driver_id already exists"
        elif "username" in msg:
            detail = "username already exists"
        raise HTTPException(status_code=409, detail=detail)
    except OperationalError:
        db.rollback()
        raise HTTPException(status_code=503, detail="Database temporarily unavailable")
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
    _ensure_tenant_schema(db)
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

    try:
        next_warehouse_id = int(getattr(driver, "warehouse_id", 0) or 0) or None
    except Exception:
        next_warehouse_id = None
    try:
        next_store_id = int(getattr(driver, "store_id", 0) or 0) or None
    except Exception:
        next_store_id = None

    if "warehouse_id" in patch_fields:
        try:
            next_warehouse_id = int(patch_fields.get("warehouse_id") or 0) or None
        except Exception:
            raise HTTPException(status_code=400, detail="warehouse_id must be numeric")
        if next_warehouse_id is not None:
            wh = db.query(models.Warehouse).filter(models.Warehouse.id == next_warehouse_id).first()
            if not wh:
                raise HTTPException(status_code=400, detail="warehouse_id not found")

    if "store_id" in patch_fields:
        try:
            next_store_id = int(patch_fields.get("store_id") or 0) or None
        except Exception:
            raise HTTPException(status_code=400, detail="store_id must be numeric")
        if next_store_id is not None:
            st = db.query(models.Store).filter(models.Store.id == next_store_id).first()
            if not st:
                raise HTTPException(status_code=400, detail="store_id not found")
            st_wid = int(getattr(st, "warehouse_id", 0) or 0) or None
            if next_warehouse_id is not None and st_wid is not None and st_wid != next_warehouse_id:
                raise HTTPException(status_code=400, detail="store_id does not belong to warehouse_id")
            if next_warehouse_id is None:
                next_warehouse_id = st_wid

    next_role = authz.normalize_role(getattr(driver, "role", None))
    if next_role == authz.ROLE_STORE and next_store_id is None:
        raise HTTPException(status_code=400, detail="Store users require store_id")
    if next_role == authz.ROLE_WAREHOUSE and next_warehouse_id is None:
        raise HTTPException(status_code=400, detail="Warehouse users require warehouse_id")

    driver.warehouse_id = next_warehouse_id
    driver.store_id = next_store_id

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

    try:
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        detail = "Cannot update user due to a unique constraint conflict."
        msg = str(getattr(exc, "orig", exc) or "").lower()
        if "driver_id" in msg:
            detail = "driver_id already exists"
        elif "username" in msg:
            detail = "username already exists"
        raise HTTPException(status_code=409, detail=detail)
    except OperationalError:
        db.rollback()
        raise HTTPException(status_code=503, detail="Database temporarily unavailable")
    db.refresh(driver)
    return driver


@app.delete("/users/{driver_id}", response_model=schemas.UserDeleteResponse)
async def delete_user(
    driver_id: str,
    db: Session = Depends(database.get_db),
    current_driver: models.Driver = Depends(permission_required(authz.PERM_USERS_WRITE)),
):
    drivers_service.ensure_drivers_schema(db)
    _ensure_tenant_schema(db)

    # Product requirement: only Admin can delete users.
    if authz.normalize_role(getattr(current_driver, "role", None)) != authz.ROLE_ADMIN:
        raise HTTPException(status_code=403, detail="Only admin users can delete accounts.")

    target_id = str(driver_id or "").strip()
    if not target_id:
        raise HTTPException(status_code=400, detail="driver_id is required")

    current_id = str(getattr(current_driver, "driver_id", "") or "").strip().upper()
    if current_id and target_id.strip().upper() == current_id:
        raise HTTPException(status_code=400, detail="Cannot delete your own account.")

    row = db.query(models.Driver).filter(models.Driver.driver_id == target_id).first()
    if not row:
        raise HTTPException(status_code=404, detail="User not found")

    previous_role = authz.normalize_role(getattr(row, "role", None))
    previous_username = str(getattr(row, "username", "") or "").strip() or None
    target_active = bool(getattr(row, "active", False))

    if previous_role == authz.ROLE_ADMIN and target_active:
        from sqlalchemy import func
        active_admins = (
            db.query(models.Driver)
            .filter(func.lower(models.Driver.role) == authz.ROLE_ADMIN.lower(), models.Driver.active.is_(True))
            .count()
        )
        if int(active_admins or 0) <= 1:
            raise HTTPException(status_code=400, detail="Cannot delete the last active admin account.")

    # Try hard delete first. If blocked by FK constraints, fallback to safe deactivation.
    try:
        db.delete(row)
        db.commit()
        return schemas.UserDeleteResponse(
            driver_id=target_id,
            hard_deleted=True,
            deactivated=False,
            previous_role=previous_role,
            previous_username=previous_username,
            message="User permanently deleted.",
        )
    except IntegrityError:
        db.rollback()

    row = db.query(models.Driver).filter(models.Driver.driver_id == target_id).first()
    if not row:
        return schemas.UserDeleteResponse(
            driver_id=target_id,
            hard_deleted=True,
            deactivated=False,
            previous_role=previous_role,
            previous_username=previous_username,
            message="User permanently deleted.",
        )

    base = previous_username or target_id
    slug = re.sub(r"[^a-z0-9]+", "", str(base).strip().lower())[:24] or "user"
    stamp = datetime.utcnow().strftime("%Y%m%d%H%M%S")
    candidate = f"deleted_{slug}_{stamp}"
    for idx in range(1, 50):
        exists = (
            db.query(models.Driver)
            .filter(models.Driver.username == candidate, models.Driver.driver_id != target_id)
            .first()
        )
        if not exists:
            break
        candidate = f"deleted_{slug}_{stamp}_{idx}"

    row.active = False
    row.username = candidate
    row.password_hash = driver_manager.get_password_hash(secrets.token_urlsafe(32))
    row.last_login = None
    row.truck_plate = None
    row.phone_number = None
    row.phone_norm = None
    row.helper_name = None
    row.vehicle_type_code = None
    row.vehicle_has_lift = None
    row.max_volume_m3 = None
    row.target_volume_m3 = None
    row.max_weight_kg = None
    row.target_weight_kg = None
    row.warehouse_id = None
    row.store_id = None

    db.commit()
    return schemas.UserDeleteResponse(
        driver_id=target_id,
        hard_deleted=False,
        deactivated=True,
        previous_role=previous_role,
        previous_username=previous_username,
        message="User had linked history and was deactivated instead of hard deleted.",
    )

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


_NDR_REFUSAL_ACTIONS = [
    {"code": "RETURN_TO_SENDER", "label": "Return to sender", "kind": "return"},
    {"code": "REDIRECT_TO_FLANCO", "label": "Redirect to Flanco store", "kind": "redirect"},
    {"code": "REDIRECT_TO_NEW_RECIPIENT", "label": "Redirect to new recipient", "kind": "redirect"},
    {"code": "RESCHEDULE_DELIVERY", "label": "Reschedule delivery", "kind": "reschedule"},
]


def _coerce_json_object(value: Any) -> Dict[str, Any]:
    if isinstance(value, dict):
        return dict(value)
    if isinstance(value, str):
        raw = value.strip()
        if not raw:
            return {}
        try:
            parsed = json.loads(raw)
            if isinstance(parsed, dict):
                return parsed
        except Exception:
            return {}
    return {}


def _collect_flanco_destinations(db: Session, *, max_rows: int = 5000, max_items: int = 120) -> List[Dict[str, Any]]:
    rows = (
        db.query(models.Shipment.sender_shop_name, models.Shipment.sender_location)
        .filter(
            or_(
                func.lower(func.coalesce(models.Shipment.sender_shop_name, "")).like("%flanco%"),
                func.lower(cast(models.Shipment.sender_location, String)).like("%flanco%"),
            )
        )
        .limit(max(100, int(max_rows or 5000)))
        .all()
    )

    buckets: Dict[str, Dict[str, Any]] = {}
    for sender_shop_name, sender_location in rows:
        shop = str(sender_shop_name or "").strip()
        location = _coerce_json_object(sender_location)

        loc_name = str(location.get("name") or "").strip()
        name = shop or loc_name
        if not name:
            continue

        if "flanco" not in _fold_text(name):
            continue

        loc_id = str(location.get("locationId") or location.get("location_id") or "").strip()
        key = (loc_id or _fold_text(name) or _fold_text(shop))[:160]
        if not key:
            continue

        address = str(location.get("addressText") or "").strip()
        if not address:
            street = str(location.get("streetName") or "").strip()
            building = str(location.get("buildingNumber") or "").strip()
            address = f"{street} {building}".strip()

        item = buckets.get(key)
        if not item:
            item = {
                "id": key,
                "location_id": loc_id or None,
                "name": name,
                "shop_name": shop or None,
                "locality": str(location.get("locality") or "").strip() or None,
                "county": str(location.get("county") or "").strip() or None,
                "address": address or None,
                "phone": str(location.get("phoneNumber") or "").strip() or None,
                "source_count": 0,
            }
            buckets[key] = item

        item["source_count"] = int(item.get("source_count") or 0) + 1

        # Keep best-known textual values.
        if (not item.get("address")) and address:
            item["address"] = address
        if (not item.get("locality")) and str(location.get("locality") or "").strip():
            item["locality"] = str(location.get("locality") or "").strip()
        if (not item.get("county")) and str(location.get("county") or "").strip():
            item["county"] = str(location.get("county") or "").strip()
        if (not item.get("phone")) and str(location.get("phoneNumber") or "").strip():
            item["phone"] = str(location.get("phoneNumber") or "").strip()

    out = sorted(
        buckets.values(),
        key=lambda row: (-(int(row.get("source_count") or 0)), str(row.get("name") or "").lower()),
    )
    return out[: max(10, int(max_items or 120))]


@app.get("/ndr/reasons")
async def list_ndr_reasons(
    current_driver: models.Driver = Depends(get_current_driver),
    db: Session = Depends(database.get_db),
):
    _ = current_driver
    return {
        "reasons": _NDR_REASONS,
        "actions": _NDR_REFUSAL_ACTIONS,
        "flanco_destinations": _collect_flanco_destinations(db),
    }


def _run_startup_bootstrap() -> None:
    # Keep bootstrap robust. Drivers are managed in DB (no external sheet sync).
    db = database.SessionLocal()
    try:
        auto_seed_fleet_accounts = str(os.getenv("AUTO_SEED_FLEET_ACCOUNTS", "1") or "").strip().lower() not in {
            "0",
            "false",
            "no",
            "off",
        }
        drivers_service.ensure_drivers_schema(db)
        _ensure_tenant_schema(db)
        _ensure_default_carriers(db)
        _ensure_default_warehouses_and_stores(db)
        _seed_flanco_store_accounts(db, reset_passwords=False, include_passwords=False)
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


@app.on_event("startup")
async def startup_event():
    # Run schema/bootstrap work in background so health endpoint becomes available quickly.
    try:
        existing_bootstrap = getattr(app.state, "startup_bootstrap_task", None)
        if not existing_bootstrap or existing_bootstrap.done():
            app.state.startup_bootstrap_task = asyncio.create_task(asyncio.to_thread(_run_startup_bootstrap))
            logger.info("Started background startup bootstrap task")
    except Exception as e:
        logger.error(f"Failed to schedule startup bootstrap task: {str(e)}", exc_info=True)

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

    ship_for_flow = _find_shipment_by_awb(db, identifier)
    effective_event_id = str(request.event_id or "").strip()
    auto_mapped_to_return = False
    if effective_event_id == "2" and _shipment_is_refused_for_return_flow(ship_for_flow):
        # Refused shipments are returned to store/depot: send Postis event 4.
        effective_event_id = "4"
        auto_mapped_to_return = True

    timestamp = request.timestamp or datetime.utcnow()
    idempotency_key = f"{identifier}:{effective_event_id}:{current_driver.driver_id}:{timestamp.isoformat()}"

    log_entry = models.LogEntry(
        driver_id=current_driver.driver_id,
        timestamp=timestamp,
        awb=identifier,
        event_id=effective_event_id,
        payload=request.payload,
        idempotency_key=idempotency_key,
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

        opt = db.query(models.StatusOption).filter(models.StatusOption.event_id == effective_event_id).first()
        requirements = list(opt.requirements or []) if (opt and isinstance(opt.requirements, list)) else []
        requires_signature = str(effective_event_id) == "2" or ("signature" in requirements)
        if requires_signature and not _has_valid_signature_payload(request.payload):
            raise HTTPException(status_code=400, detail="Client signature is required for delivered status")

        # Extra delivery safeguards:
        # - COD delivery: require receipt photo proof.
        # - Buy-back shipments: require recovered item photo proof.
        if str(effective_event_id) == "2":
            ship = ship_for_flow or _find_shipment_by_awb(db, identifier)
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

        if str(effective_event_id) == "7":
            # Server-side guard even if client validation is bypassed.
            if not _extract_reschedule_at_payload(request.payload):
                raise HTTPException(status_code=400, detail="Reschedule date/time is required.")

        if str(effective_event_id) == "4":
            # Mandatory proof for returned products (refused-return flow).
            if not _extract_return_proof_photo(request.payload).startswith("data:image/"):
                raise HTTPException(status_code=400, detail="Return product photo is required for Expeditie returnata.")

        event_description = None
        if request.payload and request.payload.get("eventDescription"):
            event_description = str(request.payload.get("eventDescription"))
        elif opt and opt.label:
            # Use the stored label as the Postis-facing eventDescription (can be configured to match Postis codes).
            event_description = opt.label
        else:
            event_description = f"Status update ({effective_event_id})"

        # Prepare metadata for Postis per verified spec
        details = {
            "eventDate": timestamp.strftime("%Y-%m-%d %H:%M:%S"),
            "eventDescription": event_description,
            "localityName": request.payload.get("locality", "Unknown") if request.payload else "Unknown",
            "driverName": current_driver.name,
            "driverPhoneNumber": current_driver.phone_number or "",
            "truckNumber": current_driver.truck_plate or "",
        }

        reason_code, reason_note = _extract_reason_payload(request.payload)
        action_code, new_recipient = _extract_refusal_action_payload(request.payload)
        reason_note_with_action = _merge_reason_with_refusal_action(
            reason_note=reason_note,
            action_code=action_code,
            new_recipient=new_recipient,
        )
        if str(effective_event_id) == "3":
            if reason_code:
                details["reasonCode"] = reason_code
            if reason_note_with_action:
                details["reason"] = reason_note_with_action
        elif str(effective_event_id) == "4":
            details["eventDescription"] = (opt.label if opt and opt.label else "Expeditie returnata")
            details["returnReasonCode"] = reason_code or "RETURN_TO_STORE"
            details["returnReason"] = reason_note_with_action or "Return to store after refused delivery"
        elif str(effective_event_id) == "7":
            reschedule_at = _extract_reschedule_at_payload(request.payload)
            if reschedule_at:
                details["rescheduleAt"] = reschedule_at
            if reason_code:
                details["reasonCode"] = reason_code
            if reason_note_with_action:
                details["reason"] = reason_note_with_action

        response = await p_client.update_status_by_awb_or_client_order_id(identifier, effective_event_id, details)
        log_entry.outcome = "SUCCESS"
        log_entry.postis_reference = str(response.get("reference") or response.get("id") or "")

        # Best-effort: keep our local DB in sync for dashboards/reconciliation.
        try:
            shipments_service.ensure_shipments_schema(db)
            ship = db.query(models.Shipment).filter(models.Shipment.awb == identifier).first()
            if ship:
                next_status = _EVENT_TO_STATUS.get(str(effective_event_id))
                if not next_status:
                    next_status = postis_statuses.normalize_shipment_status(ship.status or event_description)
                ship.status = next_status
                ship.awb_status_date = timestamp
                ship.last_updated = datetime.utcnow()
                if str(effective_event_id) == "7":
                    _persist_reschedule_meta_on_shipment(
                        ship,
                        reschedule_at=_extract_reschedule_at_payload(request.payload),
                    )
                if str(effective_event_id) in {"3", "4"}:
                    _persist_refusal_meta_on_shipment(
                        ship,
                        action_code=action_code,
                        reason_code=reason_code,
                        reason_note=reason_note_with_action,
                        new_recipient=new_recipient,
                    )
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
        out: Dict[str, Any] = {"status": "ok", "outcome": "SUCCESS", "reference": log_entry.postis_reference}
        if auto_mapped_to_return:
            out["effective_event_id"] = "4"
            out["effective_event_description"] = "Expeditie returnata"
        return out
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

        cod_val = _safe_float(cod_amount, 0.0) or 0.0
        ship_val = _safe_float(shipping_cost, 0.0) or 0.0
        est_val = _safe_float(estimated_shipping_cost, 0.0) or 0.0
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
        entry["cod_total"] = (_safe_float(entry.get("cod_total"), 0.0) or 0.0) + cod_val
        entry["payment_total"] = (_safe_float(entry.get("payment_total"), 0.0) or 0.0) + pay_val

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
        perf["km_total"] = (_safe_float(perf.get("km_total"), 0.0) or 0.0) + km

    drivers_out = list(driver_perf.values())
    for d in drivers_out:
        d["cod_total"] = round(_safe_float(d.get("cod_total"), 0.0) or 0.0, 2)
        d["payment_total"] = round(_safe_float(d.get("payment_total"), 0.0) or 0.0, 2)
        d["km_total"] = round(_safe_float(d.get("km_total"), 0.0) or 0.0, 2)
    drivers_out.sort(
        key=lambda d: (
            -int(d.get("deliveries") or 0),
            -(_safe_float(d.get("km_total"), 0.0) or 0.0),
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


@app.post("/activity-log", response_model=schemas.ActivityLogSchema)
async def create_activity_log(
    req: schemas.ActivityLogCreate,
    db: Session = Depends(database.get_db),
    current_driver: models.Driver = Depends(authz.get_current_active_driver)
):
    now = datetime.utcnow()
    
    # Look up the latest location for this user
    latest_loc = db.query(models.DriverLocation).filter(
        models.DriverLocation.driver_id == current_driver.driver_id
    ).order_by(models.DriverLocation.timestamp.desc()).first()

    act_log = models.ActivityLog(
        user_id=current_driver.driver_id,
        timestamp=now,
        action_type=req.action_type,
        path=req.path,
        method=req.method,
        details=req.details,
        payload=req.payload,
        latitude=latest_loc.latitude if latest_loc else None,
        longitude=latest_loc.longitude if latest_loc else None
    )
    db.add(act_log)
    db.commit()
    db.refresh(act_log)
    return act_log

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
        _ensure_tenant_schema(db)
        # RBAC: Filter by driver_id if rule is Driver
        role = authz.normalize_role(current_driver.role)
        query = db.query(models.Shipment)
        if role != authz.ROLE_STORE:
            # `client_data` can contain large brand/preferences payloads that list views never need.
            query = query.options(defer(models.Shipment.client_data))
        
        if role == authz.ROLE_DRIVER:
            candidate_shipments = query.all()
            shipments = [
                ship
                for ship in (candidate_shipments or [])
                if _shipment_visible_to_user(db, current_driver=current_driver, ship=ship, include_driver_pool=True)
            ]
        elif role == authz.ROLE_RECIPIENT:
            # Recipients can only see shipments where they are the recipient (phone match).
            phone_norm = _resolve_user_phone_norm(db, current_driver)

            if phone_norm:
                query = query.filter(models.Shipment.recipient_phone_norm == phone_norm)
            else:
                query = query.filter(models.Shipment.id == -1)
            shipments = query.all()
        elif role in {authz.ROLE_STORE, authz.ROLE_WAREHOUSE}:
            candidate_shipments = query.all()
            shipments = [
                ship
                for ship in (candidate_shipments or [])
                if _shipment_visible_to_user(db, current_driver=current_driver, ship=ship)
            ]
        else:
            shipments = query.all()
        
        results = []
        for ship in shipments:
            base = shipments_service.shipment_to_dict(ship, include_raw_data=False, include_events=False, db=db)
            base["raw_data"] = shipments_service.shipment_list_raw_data(ship)
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
        _ensure_tenant_schema(db)

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
            if not _shipment_visible_to_user(db, current_driver=current_driver, ship=ship):
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
            if not _shipment_visible_to_user(db, current_driver=current_driver, ship=ship):
                raise HTTPException(status_code=403, detail="Not enough permissions")
            return shipments_service.shipment_to_dict(ship, include_raw_data=True, include_events=True, db=db)

        if not data:
            raise HTTPException(status_code=404, detail="Shipment not found")

        ship = shipments_service.upsert_shipment_and_events(db, data)
        db.commit()
        if not _shipment_visible_to_user(db, current_driver=current_driver, ship=ship):
            raise HTTPException(status_code=403, detail="Not enough permissions")
        return shipments_service.shipment_to_dict(ship, include_raw_data=True, include_events=True, db=db)
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error in get_shipment({awb}): {str(e)}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/shipments/manual", response_model=schemas.ShipmentSchema)
async def create_manual_shipment(
    request: schemas.ShipmentManualCreateRequest,
    db: Session = Depends(database.get_db),
    current_driver: models.Driver = Depends(permission_required(authz.PERM_SHIPMENTS_READ)),
):
    shipments_service.ensure_shipments_schema(db)
    _ensure_tenant_schema(db)
    _ensure_default_carriers(db)

    role = authz.normalize_role(current_driver.role)
    if role not in {authz.ROLE_ADMIN, authz.ROLE_WAREHOUSE, authz.ROLE_STORE}:
        raise HTTPException(status_code=403, detail="Only admin/warehouse/store users can create manual AWBs")

    try:
        requested_warehouse_id = int(request.warehouse_id or 0) or None
    except Exception:
        raise HTTPException(status_code=400, detail="warehouse_id must be numeric")
    try:
        requested_store_id = int(request.store_id or 0) or None
    except Exception:
        raise HTTPException(status_code=400, detail="store_id must be numeric")

    try:
        user_warehouse_id = int(getattr(current_driver, "warehouse_id", 0) or 0) or None
    except Exception:
        user_warehouse_id = None
    try:
        user_store_id = int(getattr(current_driver, "store_id", 0) or 0) or None
    except Exception:
        user_store_id = None

    if role == authz.ROLE_STORE:
        if user_store_id is None:
            raise HTTPException(status_code=403, detail="Store account is missing store_id mapping")
        requested_store_id = user_store_id
        if user_warehouse_id is not None:
            requested_warehouse_id = user_warehouse_id

    if role == authz.ROLE_WAREHOUSE:
        if user_warehouse_id is None:
            raise HTTPException(status_code=403, detail="Warehouse account is missing warehouse_id mapping")
        requested_warehouse_id = user_warehouse_id

    warehouse_obj = None
    if requested_warehouse_id is not None:
        warehouse_obj = db.query(models.Warehouse).filter(models.Warehouse.id == requested_warehouse_id).first()
        if not warehouse_obj:
            raise HTTPException(status_code=400, detail="warehouse_id not found")

    store_obj = None
    if requested_store_id is not None:
        store_obj = db.query(models.Store).filter(models.Store.id == requested_store_id).first()
        if not store_obj:
            raise HTTPException(status_code=400, detail="store_id not found")
        store_wid = int(getattr(store_obj, "warehouse_id", 0) or 0) or None
        if requested_warehouse_id is not None and store_wid is not None and requested_warehouse_id != store_wid:
            raise HTTPException(status_code=400, detail="store_id does not belong to warehouse_id")
        if requested_warehouse_id is None:
            requested_warehouse_id = store_wid
            if requested_warehouse_id is not None:
                warehouse_obj = db.query(models.Warehouse).filter(models.Warehouse.id == requested_warehouse_id).first()

    if role == authz.ROLE_WAREHOUSE and requested_warehouse_id != user_warehouse_id:
        raise HTTPException(status_code=403, detail="Warehouse user can only create AWBs for own warehouse")
    if role == authz.ROLE_STORE and requested_store_id != user_store_id:
        raise HTTPException(status_code=403, detail="Store user can only create AWBs for own store")

    awb = _normalize_manual_awb(request.awb)
    if not awb or len(awb) < 6:
        raise HTTPException(status_code=400, detail="awb is required (min 6 alphanumeric chars)")

    existing = _find_shipment_by_awb(db, awb)
    if existing:
        raise HTTPException(status_code=409, detail="Shipment already exists")

    recipient_name = str(request.recipient_name or "").strip()
    delivery_address = str(request.delivery_address or "").strip()
    locality = str(request.locality or "").strip()
    if not recipient_name:
        raise HTTPException(status_code=400, detail="recipient_name is required")
    if not delivery_address:
        raise HTTPException(status_code=400, detail="delivery_address is required")
    if not locality:
        raise HTTPException(status_code=400, detail="locality is required")

    try:
        cod_amount = max(0.0, float(request.cod_amount or 0.0))
        weight = max(0.0, float(request.weight or 0.0))
        volumetric_weight = max(0.0, float(request.volumetric_weight or 0.0))
        declared_value = max(0.0, float(request.declared_value or 0.0))
        number_of_parcels = max(1, int(request.number_of_parcels or 1))
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid numeric fields in payload")

    recipient_phone = str(request.recipient_phone or "").strip() or None
    recipient_email = str(request.recipient_email or "").strip() or None
    county = str(request.county or "").strip() or None
    now = datetime.utcnow()
    base_status = str(request.status or "Intrare in depozit").strip() or "Intrare in depozit"

    recipient_location = {
        "addressText": delivery_address,
        "localityName": locality,
    }
    if county:
        recipient_location["countyName"] = county

    creator_name = str(current_driver.name or current_driver.username or current_driver.driver_id or "").strip() or "Admin"

    selected_carrier_code = str(request.carrier_code or "").strip().upper() or None
    if selected_carrier_code:
        selected_carrier = _carrier_from_code(db, selected_carrier_code)
        if not selected_carrier:
            raise HTTPException(status_code=400, detail="carrier_code not found")
        if not bool(getattr(selected_carrier, "active", False)):
            raise HTTPException(status_code=400, detail="carrier_code is inactive")

    carrier_priority = _normalize_carrier_priority(request.carrier_priority)
    carrier_plan = _recommend_carriers(
        db,
        warehouse_id=requested_warehouse_id,
        store_id=requested_store_id,
        delivery_address=delivery_address,
        locality=locality,
        county=county,
        distance_km=request.carrier_distance_km,
        destination_latitude=request.destination_latitude,
        destination_longitude=request.destination_longitude,
        weight=weight,
        cod_amount=cod_amount,
        priority=carrier_priority,
        carrier_codes=[selected_carrier_code] if selected_carrier_code else None,
    )
    selected_option = None
    for option in (carrier_plan.get("options") or []):
        if option.get("recommended"):
            selected_option = option
            break
    if selected_option is None and carrier_plan.get("options"):
        selected_option = carrier_plan["options"][0]

    carrier_code_out = str((selected_option or {}).get("code") or "").strip().upper() or None
    carrier_name_out = str((selected_option or {}).get("name") or request.carrier_name or "").strip() or None
    carrier_mode_out = str((selected_option or {}).get("integration_mode") or "").strip() or None
    carrier_estimated_cost = _safe_float(request.carrier_estimated_cost, (selected_option or {}).get("estimated_cost"))
    carrier_estimated_eta = _safe_float(request.carrier_estimated_eta_hours, (selected_option or {}).get("estimated_eta_hours"))
    carrier_distance_out = _safe_float(request.carrier_distance_km, (selected_option or {}).get("distance_km"))

    courier_data: Dict[str, Any] = {}
    if carrier_code_out or carrier_name_out:
        courier_data = {
            "courierId": carrier_code_out,
            "courierName": carrier_name_out,
            "carrierId": carrier_code_out,
            "carrierName": carrier_name_out,
            "carrierCode": carrier_code_out,
            "integrationMode": carrier_mode_out,
            "selectionMethod": "manual" if selected_carrier_code else "auto",
            "selectionPriority": carrier_priority,
            "distanceKm": round(float(carrier_distance_out or 0.0), 2) if carrier_distance_out is not None else None,
            "estimatedCost": round(float(carrier_estimated_cost or 0.0), 2) if carrier_estimated_cost is not None else None,
            "estimatedEtaHours": round(float(carrier_estimated_eta or 0.0), 2) if carrier_estimated_eta is not None else None,
            "score": (selected_option or {}).get("total_score"),
        }

    raw_payload = {
        "source": "arynik_manual",
        "labelProvider": "arynik_local",
        "createdByUserId": current_driver.driver_id,
        "createdByName": creator_name,
        "createdAt": now.isoformat(),
        "carrierSelectionPriority": carrier_priority,
        "carrierRecommendation": carrier_plan,
        "courier": courier_data or None,
    }

    ship = models.Shipment(
        awb=awb,
        status=postis_statuses.normalize_shipment_status(base_status),
        recipient_name=recipient_name,
        recipient_phone=recipient_phone,
        recipient_phone_norm=phone_service.normalize_phone(recipient_phone or "") or None,
        recipient_email=recipient_email,
        delivery_address=delivery_address,
        locality=locality,
        weight=weight,
        volumetric_weight=volumetric_weight,
        dimensions=(str(request.dimensions or "").strip() or None),
        content_description=(str(request.content_description or "").strip() or "General parcel"),
        cod_amount=cod_amount,
        shipping_cost=(float(carrier_estimated_cost) if carrier_estimated_cost is not None else None),
        estimated_shipping_cost=(float(carrier_estimated_cost) if carrier_estimated_cost is not None else None),
        currency="RON",
        declared_value=declared_value,
        number_of_parcels=number_of_parcels,
        delivery_instructions=(str(request.delivery_instructions or "").strip() or None),
        recipient_instructions=(str(request.recipient_instructions or "").strip() or None),
        created_date=now,
        awb_status_date=now,
        source_channel="ARYNIK_LOCAL",
        send_type="Manual",
        sender_shop_name=(str(request.sender_shop_name or "").strip() or str(getattr(store_obj, "name", "") or "").strip() or "Arynik"),
        processing_status="Manual entry",
        local_awb_shipment=True,
        local_shipment=True,
        shipment_label_available=True,
        courier_data=courier_data or None,
        recipient_location=recipient_location,
        warehouse_id=requested_warehouse_id,
        store_id=requested_store_id,
        raw_data=raw_payload,
        last_updated=now,
    )
    db.add(ship)
    db.flush()

    db.add(
        models.ShipmentEvent(
            shipment_id=ship.id,
            event_description=(
                f"AWB created manually in Arynik"
                f"{f' • carrier {carrier_name_out} ({carrier_code_out})' if (carrier_name_out or carrier_code_out) else ''}"
            )[:500],
            event_date=now,
            locality_name=locality,
        )
    )

    db.commit()
    db.refresh(ship)
    return shipments_service.shipment_to_dict(ship, include_raw_data=True, include_events=True, db=db)


@app.post("/shipments/{awb}/confirm-return", response_model=schemas.ShipmentSchema)
async def confirm_shipment_return(
    awb: str,
    request: schemas.ShipmentReturnConfirmRequest,
    db: Session = Depends(database.get_db),
    current_driver: models.Driver = Depends(permission_required(authz.PERM_SHIPMENTS_READ)),
):
    shipments_service.ensure_shipments_schema(db)
    _ensure_tenant_schema(db)

    role = authz.normalize_role(current_driver.role)
    if role not in {authz.ROLE_ADMIN, authz.ROLE_WAREHOUSE, authz.ROLE_STORE}:
        raise HTTPException(status_code=403, detail="Only admin/warehouse/store can confirm returned shipments")

    identifier = postis_client.normalize_shipment_identifier(awb) or str(awb or "").strip().upper()
    ship = _find_shipment_by_awb(db, identifier)
    if not ship:
        raise HTTPException(status_code=404, detail="Shipment not found")

    if not _shipment_visible_to_user(db, current_driver=current_driver, ship=ship):
        raise HTTPException(status_code=403, detail="Not enough permissions")

    now = datetime.utcnow()
    ship.return_confirmed_at = now
    ship.return_confirmed_by = current_driver.driver_id
    ship.last_updated = now

    # If a scoped user confirms return, backfill missing ownership metadata for future filtering.
    try:
        current_store_id = int(getattr(current_driver, "store_id", 0) or 0) or None
    except Exception:
        current_store_id = None
    try:
        current_warehouse_id = int(getattr(current_driver, "warehouse_id", 0) or 0) or None
    except Exception:
        current_warehouse_id = None

    if role == authz.ROLE_STORE and current_store_id and not getattr(ship, "store_id", None):
        ship.store_id = current_store_id
    if role in {authz.ROLE_STORE, authz.ROLE_WAREHOUSE} and current_warehouse_id and not getattr(ship, "warehouse_id", None):
        ship.warehouse_id = current_warehouse_id

    reason = str(request.notes or "").strip()
    event_desc = "Return confirmed at store/warehouse"
    if reason:
        event_desc = f"{event_desc}: {reason}"
    db.add(
        models.ShipmentEvent(
            shipment_id=ship.id,
            event_description=event_desc[:500],
            event_date=now,
            locality_name=str(getattr(ship, "locality", "") or "").strip(),
        )
    )

    db.commit()
    db.refresh(ship)
    return shipments_service.shipment_to_dict(ship, include_raw_data=True, include_events=True, db=db)


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

        # Spontaneous chat thread generation removed to save resources.
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
    db: Session = Depends(database.get_db),
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

    shipments_service.ensure_shipments_schema(db)

    candidate_map: Dict[str, List[str]] = {}
    all_candidates: Set[str] = set()
    for awb in awbs:
        candidates = postis_client.candidates_with_optional_parcel_suffix_stripped(awb)
        if not candidates:
            fallback = postis_client.normalize_shipment_identifier(awb) or awb
            if fallback:
                candidates = [fallback]
        candidate_map[awb] = candidates
        for cand in candidates:
            all_candidates.add(cand)

    local_shipments_by_awb: Dict[str, models.Shipment] = {}
    if all_candidates:
        local_rows = db.query(models.Shipment).filter(models.Shipment.awb.in_(list(all_candidates))).all()
        for row in local_rows:
            local_shipments_by_awb[str(row.awb or "").strip().upper()] = row

    semaphore = asyncio.Semaphore(8)

    async def _fetch_label_for_awb(awb_key: str):
        async with semaphore:
            candidates = candidate_map.get(awb_key) or []

            for cand in candidates:
                local_ship = local_shipments_by_awb.get(str(cand or "").strip().upper())
                if local_ship and label_service.is_local_shipment(local_ship):
                    try:
                        label_bytes = label_service.generate_label_for_shipment(local_ship)
                        return awb_key, cand, label_bytes
                    except Exception:
                        logger.error("Failed to generate local label for %s", cand, exc_info=True)
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
    db: Session = Depends(database.get_db),
    current_driver: models.Driver = Depends(permission_required(authz.PERM_LABEL_READ)),
):
    candidates = postis_client.candidates_with_optional_parcel_suffix_stripped(awb)
    if not candidates:
        fallback = postis_client.normalize_shipment_identifier(awb) or str(awb or "").strip().upper()
        if fallback:
            candidates = [fallback]

    shipments_service.ensure_shipments_schema(db)
    _ensure_tenant_schema(db)
    role = authz.normalize_role(current_driver.role)
    restricted_scope = role in {authz.ROLE_DRIVER, authz.ROLE_RECIPIENT, authz.ROLE_WAREHOUSE, authz.ROLE_STORE}
    found_local_ship = False

    # Prefer locally generated Arynik label for manual/local shipments.
    for cand in candidates:
        ship = db.query(models.Shipment).filter(models.Shipment.awb == cand).first()
        if not ship:
            continue
        found_local_ship = True
        if not _shipment_visible_to_user(db, current_driver=current_driver, ship=ship):
            raise HTTPException(status_code=403, detail="Not enough permissions")
        if label_service.is_local_shipment(ship):
            try:
                label_bytes = label_service.generate_label_for_shipment(ship)
                return Response(
                    content=label_bytes,
                    media_type="application/pdf",
                    headers={
                        "Content-Disposition": f'inline; filename="label_{cand}_ARYNIK.pdf"'
                    },
                )
            except Exception:
                logger.error("Failed to generate local label for %s", cand, exc_info=True)
                break

    if restricted_scope and not found_local_ship:
        raise HTTPException(status_code=404, detail="Label not found")

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

    shipments_service.ensure_shipments_schema(db)
    _ensure_tenant_schema(db)
    role = authz.normalize_role(current_driver.role)
    restricted_scope = role in {authz.ROLE_DRIVER, authz.ROLE_RECIPIENT, authz.ROLE_WAREHOUSE, authz.ROLE_STORE}
    found_local_ship = None
    for cand in candidates:
        row = db.query(models.Shipment).filter(models.Shipment.awb == cand).first()
        if row:
            found_local_ship = row
            break
    if restricted_scope:
        if not found_local_ship:
            raise HTTPException(status_code=404, detail="Shipment not found")
        if not _shipment_visible_to_user(db, current_driver=current_driver, ship=found_local_ship):
            raise HTTPException(status_code=403, detail="Not enough permissions")

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
    desired_date = str(request.desired_date or "").strip() or None
    period = str(request.period or "").strip().lower() or None
    slot_code = str(request.slot_code or "").strip().lower() or None
    reason_code = str(request.reason_code or "").strip() or None
    note = str(request.note or "").strip() or None

    if period and period not in {"morning", "afternoon"}:
        raise HTTPException(status_code=400, detail="period must be one of: morning | afternoon")
    if slot_code and slot_code not in RESCHEDULE_SLOT_WINDOWS:
        raise HTTPException(
            status_code=400,
            detail="slot_code must be one of: morning_09_12 | morning_12_15 | afternoon_15_18 | afternoon_18_21",
        )

    slot_meta = RESCHEDULE_SLOT_WINDOWS.get(slot_code) if slot_code else None
    if slot_meta and period and period != str(slot_meta.get("period") or "").strip().lower():
        raise HTTPException(status_code=400, detail="period and slot_code do not match")
    if period and not slot_code:
        raise HTTPException(status_code=400, detail="slot_code is required when period is provided")
    if slot_meta and not period:
        period = str(slot_meta.get("period") or "").strip().lower() or None

    requested_window_start = None
    requested_window_end = None
    requested_window_label = None
    if slot_meta:
        if not desired_date:
            raise HTTPException(status_code=400, detail="desired_date is required when slot_code is provided")
        try:
            d = datetime.strptime(desired_date, "%Y-%m-%d")
        except Exception:
            raise HTTPException(status_code=400, detail="desired_date must be YYYY-MM-DD")
        tz = _ops_timezone()
        start_hour = int(slot_meta.get("start_hour") or 0)
        end_hour = int(slot_meta.get("end_hour") or 0)
        start_local = datetime(d.year, d.month, d.day, start_hour, 0, 0, tzinfo=tz)
        end_local = datetime(d.year, d.month, d.day, end_hour, 0, 0, tzinfo=tz)
        desired_at = start_local.isoformat()
        requested_window_start = start_local.isoformat()
        requested_window_end = end_local.isoformat()
        requested_window_label = f"{desired_date} {str(slot_meta.get('label') or '').strip()}".strip()

    if desired_date and not slot_meta:
        try:
            _ = datetime.strptime(desired_date, "%Y-%m-%d")
        except Exception:
            raise HTTPException(status_code=400, detail="desired_date must be YYYY-MM-DD")

    title = "Reschedule requested"
    who = current_driver.name or current_driver.username or current_driver.driver_id
    body = f"AWB {ship.awb}: {who} requested reschedule."
    if requested_window_label:
        body += f" Desired window: {requested_window_label}."
    elif desired_at:
        body += f" Desired: {desired_at}."
    if reason_code:
        body += f" Reason: {reason_code}."
    if note:
        body += f" Note: {note[:120]}."

    _persist_reschedule_meta_on_shipment(ship, reschedule_at=desired_at)
    ship.last_updated = datetime.utcnow()

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
                    "desired_date": desired_date,
                    "period": period,
                    "slot_code": slot_code,
                    "requested_window_start": requested_window_start,
                    "requested_window_end": requested_window_end,
                    "requested_window_label": requested_window_label,
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
                "desired_date": desired_date,
                "period": period,
                "slot_code": slot_code,
            }
        )

    # Spontaneous chat system message generation removed to save resources.

    db.commit()
    return {
        "status": "ok",
        "awb": ship.awb,
        "desired_at": desired_at,
        "desired_date": desired_date,
        "period": period,
        "slot_code": slot_code,
        "requested_window_start": requested_window_start,
        "requested_window_end": requested_window_end,
        "requested_window_label": requested_window_label,
    }


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


_MANIFEST_IMPORT_HEADER_KEYS = {
    "awb",
    "awbnumber",
    "tracking",
    "trackingnumber",
    "trackingid",
    "barcode",
    "shipment",
    "shipmentid",
    "shipmentawb",
    "clientorderid",
    "ordernumber",
}
_MANIFEST_IMPORT_TOKEN_RE = re.compile(r"[A-Z0-9][A-Z0-9._/\-]{5,}")


def _manifest_import_coerce_text(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, float) and math.isnan(value):
        return ""
    txt = str(value).strip()
    if not txt:
        return ""
    if txt.lower() in {"nan", "none", "null"}:
        return ""
    return txt


def _manifest_import_header_key(value: Any) -> str:
    txt = _manifest_import_coerce_text(value).lower()
    if not txt:
        return ""
    return re.sub(r"[^a-z0-9]+", "", txt)


def _manifest_import_find_awb_columns(header_row: List[Any]) -> List[int]:
    indexes: List[int] = []
    for idx, col in enumerate(header_row or []):
        if _manifest_import_header_key(col) in _MANIFEST_IMPORT_HEADER_KEYS:
            indexes.append(idx)
    return indexes


def _manifest_import_values_from_rows(rows: List[List[Any]]) -> Tuple[List[str], int]:
    cleaned_rows = [list(row or []) for row in (rows or []) if any(_manifest_import_coerce_text(cell) for cell in (row or []))]
    if not cleaned_rows:
        return [], 0

    header_indexes = _manifest_import_find_awb_columns(cleaned_rows[0])
    values: List[str] = []
    if header_indexes and len(cleaned_rows) > 1:
        for row in cleaned_rows[1:]:
            for idx in header_indexes:
                if idx < len(row):
                    text = _manifest_import_coerce_text(row[idx])
                    if text:
                        values.append(text)
        return values, max(0, len(cleaned_rows) - 1)

    for row in cleaned_rows:
        for cell in row:
            text = _manifest_import_coerce_text(cell)
            if text:
                values.append(text)
    return values, len(cleaned_rows)


def _manifest_import_parse_csv_text(text: str) -> Tuple[List[str], int]:
    raw = str(text or "")
    if not raw.strip():
        return [], 0
    sample = raw[:4096]
    try:
        dialect = csv.Sniffer().sniff(sample)
    except Exception:
        dialect = csv.excel
    reader = csv.reader(io.StringIO(raw), dialect=dialect)
    rows = [list(row or []) for row in reader]
    return _manifest_import_values_from_rows(rows)


def _manifest_import_decode_bytes(content: bytes) -> str:
    payload = content or b""
    for encoding in ("utf-8-sig", "utf-8", "latin-1"):
        try:
            return payload.decode(encoding)
        except Exception:
            continue
    return payload.decode("utf-8", errors="ignore")


def _manifest_import_parse_upload(filename: str, content: bytes) -> Tuple[List[str], int]:
    name = str(filename or "").strip()
    ext = os.path.splitext(name.lower())[1]
    data = content or b""
    if not data:
        return [], 0

    if ext in {".csv"}:
        return _manifest_import_parse_csv_text(_manifest_import_decode_bytes(data))

    if ext in {".txt"}:
        lines = [
            _manifest_import_coerce_text(line)
            for line in _manifest_import_decode_bytes(data).splitlines()
        ]
        values = [line for line in lines if line]
        return values, len(values)

    if ext in {".xlsx", ".xls"}:
        try:
            import pandas as pd  # type: ignore
        except Exception:
            raise HTTPException(
                status_code=400,
                detail="Excel import requires pandas/openpyxl on the backend.",
            )

        try:
            frame = pd.read_excel(io.BytesIO(data), dtype=str)
        except Exception as exc:
            raise HTTPException(status_code=400, detail=f"Failed to parse Excel file: {str(exc)}")

        if frame is None:
            return [], 0

        headers = list(frame.columns)
        header_indexes = _manifest_import_find_awb_columns(headers)
        values: List[str] = []
        row_count = int(len(frame.index))

        if header_indexes:
            for idx in header_indexes:
                try:
                    col = frame.iloc[:, idx].tolist()
                except Exception:
                    col = []
                for val in col:
                    txt = _manifest_import_coerce_text(val)
                    if txt:
                        values.append(txt)
            return values, row_count

        for row in frame.itertuples(index=False, name=None):
            for cell in (row or ()):
                txt = _manifest_import_coerce_text(cell)
                if txt:
                    values.append(txt)
        return values, row_count

    raise HTTPException(
        status_code=400,
        detail="Unsupported file type. Allowed: .csv, .txt, .xlsx, .xls",
    )


def _manifest_import_google_csv_url(value: str) -> str:
    raw_url = str(value or "").strip()
    if not raw_url:
        return ""

    parsed = urlparse(raw_url)
    host = str(parsed.netloc or "").lower()
    path = str(parsed.path or "")
    if "docs.google.com" not in host or "/spreadsheets/d/" not in path:
        return raw_url

    match = re.search(r"/spreadsheets/d/([a-zA-Z0-9-_]+)", path)
    if not match:
        return raw_url

    sheet_id = str(match.group(1) or "").strip()
    if not sheet_id:
        return raw_url

    q = parse_qs(parsed.query or "")
    gid = (q.get("gid") or [None])[0]
    if not gid and parsed.fragment:
        fragment_q = parse_qs(parsed.fragment.lstrip("#"))
        gid = (fragment_q.get("gid") or [None])[0]

    export = f"https://docs.google.com/spreadsheets/d/{sheet_id}/export?format=csv"
    if gid is not None and str(gid).strip():
        export = f"{export}&gid={str(gid).strip()}"
    return export


async def _manifest_import_parse_google_sheet(raw_url: str) -> Tuple[List[str], int, str]:
    export_url = _manifest_import_google_csv_url(raw_url)
    if not export_url:
        raise HTTPException(status_code=400, detail="google_sheet_url is required")

    try:
        async with httpx.AsyncClient(timeout=60.0, follow_redirects=True) as client:
            resp = await client.get(export_url, headers={"accept": "text/csv,*/*"})
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Failed to fetch Google Sheet: {str(exc)}")

    if int(resp.status_code) >= 400:
        raise HTTPException(status_code=400, detail=f"Google Sheet download failed ({resp.status_code})")
        
    content_type = str(resp.headers.get("Content-Type", "")).lower()
    text_preview = str(resp.text or "").strip()[:250].lower()
    if "text/html" in content_type or "<!doctype html>" in text_preview or "<html" in text_preview:
        raise HTTPException(
            status_code=400,
            detail="Eroare: Fisierul Google Sheet este privat. Setati permisiunea pe 'Anyone with the link can view' (Oricine are linkul poate vizualiza) pentru a fi importat."
        )

    values, rows = _manifest_import_parse_csv_text(resp.text or "")
    return values, rows, export_url


def _manifest_import_extract_tokens(values: List[str]) -> List[str]:
    out: List[str] = []
    for raw in values or []:
        text = _manifest_import_coerce_text(raw).upper()
        if not text:
            continue
        matches = _MANIFEST_IMPORT_TOKEN_RE.findall(text)
        if matches:
            out.extend(matches)
            continue

        norm = postis_client.normalize_shipment_identifier(text)
        if len(norm) >= 6:
            out.append(norm)
    return out


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


@app.post("/manifests/{manifest_id}/import-awbs", response_model=schemas.ManifestImportAwbsResponse)
async def import_manifest_awbs(
    manifest_id: int,
    file: Optional[UploadFile] = File(None),
    google_sheet_url: Optional[str] = Form(None),
    db: Session = Depends(database.get_db),
    current_driver: models.Driver = Depends(permission_required(authz.PERM_MANIFESTS_WRITE)),
):
    role = authz.normalize_role(current_driver.role)
    if role != authz.ROLE_ADMIN:
        raise HTTPException(status_code=403, detail="Only admin users can import AWBs.")

    if not manifests_service.ensure_manifests_schema(db):
        raise HTTPException(status_code=503, detail="Manifests unavailable")

    m = manifests_service.get_manifest(db, manifest_id)
    if not m:
        raise HTTPException(status_code=404, detail="Manifest not found")

    if str(m.status or "").strip().lower() != "open":
        raise HTTPException(status_code=400, detail="Manifest is not open")

    file_name = str(getattr(file, "filename", "") or "").strip() or None
    sheet_url = str(google_sheet_url or "").strip()
    if not file and not sheet_url:
        raise HTTPException(status_code=400, detail="Provide a file upload or google_sheet_url.")
    if file and sheet_url:
        raise HTTPException(status_code=400, detail="Use either file upload or google_sheet_url, not both.")

    source = "file" if file else "google_sheet"
    values: List[str] = []
    total_rows = 0

    if file:
        content = await file.read()
        values, total_rows = _manifest_import_parse_upload(file_name or "", content)
    else:
        values, total_rows, _resolved_url = await _manifest_import_parse_google_sheet(sheet_url)

    tokens = _manifest_import_extract_tokens(values)

    existing_awbs = {
        postis_client.normalize_shipment_identifier(getattr(item, "awb", ""))
        for item in (m.items or [])
        if postis_client.normalize_shipment_identifier(getattr(item, "awb", ""))
    }
    seen_in_import: Set[str] = set()
    imported_awbs: List[str] = []
    duplicate_awbs: List[str] = []
    invalid_values: List[str] = []
    results: List[schemas.ManifestImportAwbResult] = []

    for raw in tokens:
        token = postis_client.normalize_shipment_identifier(raw)
        core, _parcel_idx, _scanned, _source = manifests_service.resolve_scanned_awb(
            db,
            identifier=token,
            manifest_id=int(getattr(m, "id", 0) or 0) or None,
        )
        if not core:
            invalid_values.append(str(raw))
            results.append(
                schemas.ManifestImportAwbResult(
                    raw=str(raw),
                    awb=None,
                    ok=False,
                    reason="invalid",
                    detail="Could not parse AWB",
                )
            )
            continue

        if core in seen_in_import:
            duplicate_awbs.append(core)
            results.append(
                schemas.ManifestImportAwbResult(
                    raw=str(raw),
                    awb=core,
                    ok=False,
                    reason="duplicate_in_file",
                    detail="Duplicate AWB in uploaded data",
                )
            )
            continue
        seen_in_import.add(core)

        if core in existing_awbs:
            duplicate_awbs.append(core)
            results.append(
                schemas.ManifestImportAwbResult(
                    raw=str(raw),
                    awb=core,
                    ok=False,
                    reason="already_in_manifest",
                    detail="AWB already exists in manifest",
                )
            )
            continue

        item = manifests_service.scan_into_manifest(
            db,
            manifest=m,
            identifier=token,
            scanned_by_user_id=current_driver.driver_id,
            data={
                "source": "admin_bulk_import",
                "filename": file_name,
                "uploaded_by": current_driver.driver_id,
            },
        )
        if not item:
            invalid_values.append(str(raw))
            results.append(
                schemas.ManifestImportAwbResult(
                    raw=str(raw),
                    awb=core,
                    ok=False,
                    reason="invalid",
                    detail="Could not add AWB to manifest",
                )
            )
            continue

        existing_awbs.add(core)
        imported_awbs.append(core)
        results.append(
            schemas.ManifestImportAwbResult(
                raw=str(raw),
                awb=core,
                ok=True,
                reason="imported",
                detail=None,
            )
        )

    try:
        db.commit()
    except Exception as exc:
        db.rollback()
        raise HTTPException(status_code=500, detail=f"Failed to import AWBs: {str(exc)}")

    db.refresh(m)
    _ = m.items

    return schemas.ManifestImportAwbsResponse(
        manifest=m,
        source=source,
        filename=file_name,
        total_rows=int(total_rows),
        detected_tokens=int(len(tokens)),
        processed_count=int(len(results)),
        imported_count=int(len(imported_awbs)),
        duplicate_count=int(len(duplicate_awbs)),
        invalid_count=int(len(invalid_values)),
        imported_awbs=imported_awbs[:250],
        duplicate_awbs=duplicate_awbs[:250],
        invalid_values=invalid_values[:250],
        results=results,
    )


@app.post("/manifests/{manifest_id}/approve-unload", response_model=schemas.ManifestApproveUnloadResponse)
async def approve_manifest_unload(
    manifest_id: int,
    request: schemas.ManifestApproveUnloadRequest = None,
    db: Session = Depends(database.get_db),
    current_driver: models.Driver = Depends(permission_required(authz.PERM_MANIFESTS_WRITE)),
):
    if not manifests_service.ensure_manifests_schema(db):
        raise HTTPException(status_code=503, detail="Manifests unavailable")

    m = manifests_service.get_manifest(db, manifest_id)
    if not m:
        raise HTTPException(status_code=404, detail="Manifest not found")

    items = list(m.items or [])
    if not items:
        raise HTTPException(status_code=400, detail="Manifest has no scanned AWBs")

    event_id, event_description = _resolve_depot_status_option(db)
    now_utc = datetime.utcnow()
    results: List[schemas.ManifestApproveUnloadItemResult] = []
    success_count = 0
    failed_count = 0

    for item in items:
        awb = postis_client.normalize_shipment_identifier(getattr(item, "awb", None))
        if not awb:
            failed_count += 1
            results.append(
                schemas.ManifestApproveUnloadItemResult(
                    awb=str(getattr(item, "awb", "") or ""),
                    ok=False,
                    detail="Invalid AWB in manifest",
                    reference=None,
                )
            )
            continue

        idempotency_key = f"manifest:{int(m.id)}:approve-unload:{event_id}:{awb}"
        existing_log = db.query(models.LogEntry).filter(models.LogEntry.idempotency_key == idempotency_key).first()
        if existing_log and str(existing_log.outcome or "").upper() == "SUCCESS":
            success_count += 1
            results.append(
                schemas.ManifestApproveUnloadItemResult(
                    awb=awb,
                    ok=True,
                    detail="Already synced",
                    reference=str(existing_log.postis_reference or "") or None,
                )
            )
            continue

        payload_data = {
            "source": "manifest_unload_approve",
            "manifest_id": int(m.id),
            "manifest_kind": str(m.kind or "").strip().lower() or None,
            "truck_plate": str(m.truck_plate or "").strip().upper() or None,
            "requested_status": "Intrare in depozit",
            "event_description": event_description,
            "approved_by": str(current_driver.driver_id or "").strip() or None,
        }
        details = {
            "eventDate": now_utc.strftime("%Y-%m-%d %H:%M:%S"),
            "eventDescription": event_description,
            "localityName": "Depozit",
            "driverName": current_driver.name,
            "driverPhoneNumber": current_driver.phone_number or "",
            "truckNumber": (str(m.truck_plate or "").strip().upper() or current_driver.truck_plate or ""),
        }

        try:
            postis_response = await p_client.update_status_by_awb_or_client_order_id(awb, event_id, details)
            reference = str(postis_response.get("reference") or postis_response.get("id") or "") or None

            try:
                shipments_service.ensure_shipments_schema(db)
                refreshed = await p_client.get_shipment_tracking_by_awb_or_client_order_id(awb)
                if refreshed:
                    shipments_service.upsert_shipment_and_events(db, refreshed)
                else:
                    ship = _find_shipment_by_awb(db, awb)
                    next_status = _EVENT_TO_STATUS.get(str(event_id)) or postis_statuses.normalize_shipment_status(event_description)
                    if not ship:
                        ship = models.Shipment(
                            awb=awb,
                            status=next_status,
                            processing_status="NEW",
                            locality=str(details.get("localityName") or "").strip() or "Depozit",
                            delivery_address=str(details.get("localityName") or "").strip() or "Depozit",
                            recipient_name="Manifest import",
                            cod_amount=0.0,
                            weight=0.0,
                            local_shipment=False,
                            local_awb_shipment=False,
                            last_updated=datetime.utcnow(),
                            awb_status_date=now_utc,
                            created_date=now_utc,
                        )
                        db.add(ship)
                        db.flush()
                    else:
                        ship.status = next_status
                        ship.processing_status = "NEW"
                        ship.awb_status_date = now_utc
                        ship.last_updated = datetime.utcnow()
                    db.add(
                        models.ShipmentEvent(
                            shipment_id=ship.id,
                            event_description=event_description,
                            event_date=now_utc,
                            locality_name=details.get("localityName") or "",
                        )
                    )
            except Exception as local_exc:
                logger.warning("Manifest local shipment sync skipped for %s: %s", awb, str(local_exc))

            if existing_log:
                existing_log.driver_id = current_driver.driver_id
                existing_log.timestamp = now_utc
                existing_log.awb = awb
                existing_log.event_id = event_id
                existing_log.payload = payload_data
                existing_log.outcome = "SUCCESS"
                existing_log.error_message = None
                existing_log.postis_reference = reference
            else:
                db.add(
                    models.LogEntry(
                        driver_id=current_driver.driver_id,
                        timestamp=now_utc,
                        awb=awb,
                        event_id=event_id,
                        outcome="SUCCESS",
                        error_message=None,
                        postis_reference=reference,
                        payload=payload_data,
                        idempotency_key=idempotency_key,
                    )
                )

            success_count += 1
            results.append(
                schemas.ManifestApproveUnloadItemResult(
                    awb=awb,
                    ok=True,
                    detail=None,
                    reference=reference,
                )
            )
        except Exception as exc:
            err_txt = str(exc)
            if existing_log:
                existing_log.driver_id = current_driver.driver_id
                existing_log.timestamp = now_utc
                existing_log.awb = awb
                existing_log.event_id = event_id
                existing_log.payload = payload_data
                existing_log.outcome = "FAILED"
                existing_log.error_message = err_txt
            else:
                db.add(
                    models.LogEntry(
                        driver_id=current_driver.driver_id,
                        timestamp=now_utc,
                        awb=awb,
                        event_id=event_id,
                        outcome="FAILED",
                        error_message=err_txt,
                        postis_reference=None,
                        payload=payload_data,
                        idempotency_key=idempotency_key,
                    )
                )

            failed_count += 1
            results.append(
                schemas.ManifestApproveUnloadItemResult(
                    awb=awb,
                    ok=False,
                    detail=err_txt,
                    reference=None,
                )
            )

    close_on_success = True if request is None else bool(request.close_on_success)
    if failed_count == 0 and close_on_success:
        m.status = "Approved"
    else:
        m.status = "Open"

    note_parts: List[str] = []
    existing_note = str(m.notes or "").strip()
    if existing_note:
        note_parts.append(existing_note)
    base_note = str(request.notes or "").strip() if request else ""
    if base_note:
        note_parts.append(base_note)
    note_parts.append(
        f"[Unload approve {now_utc.strftime('%Y-%m-%d %H:%M:%S')} by {current_driver.driver_id}: ok={success_count} fail={failed_count}]"
    )
    merged_note = " | ".join([part for part in note_parts if part]).strip()
    if merged_note:
        m.notes = merged_note

    try:
        db.commit()
    except Exception as exc:
        db.rollback()
        raise HTTPException(status_code=500, detail=f"Failed to finalize unload approval: {str(exc)}")

    # Best-effort: regenerate daily routes so newly unloaded AWBs move into planning immediately.
    try:
        if int(success_count) > 0 and route_planning_service.ensure_route_plans_schema(db):
            plan_date = datetime.now(_ops_timezone()).date().isoformat()
            route_planning_service.generate_daily_route_plans(
                db,
                plan_date=plan_date,
                generated_by_user_id=current_driver.driver_id,
                trigger="manifest_unload_approve",
            )
    except Exception as regen_exc:
        logger.warning("Manifest unload auto route regeneration failed: %s", str(regen_exc), exc_info=True)

    db.refresh(m)
    _ = m.items
    return schemas.ManifestApproveUnloadResponse(
        manifest=m,
        event_id=event_id,
        total_awbs=len(items),
        success_count=int(success_count),
        failed_count=int(failed_count),
        results=results,
    )


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

        ship_for_flow = _find_shipment_by_awb(db, identifier)
        effective_event_id = str(request.event_id or "").strip()
        if effective_event_id == "2" and _shipment_is_refused_for_return_flow(ship_for_flow):
            effective_event_id = "4"

        if str(effective_event_id) == "2":
            if not _has_valid_signature_payload(request.payload):
                raise HTTPException(status_code=400, detail="Client signature is required for delivered status")
            ship = ship_for_flow or _find_shipment_by_awb(db, identifier)
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

        if str(effective_event_id) == "7":
            if not _extract_reschedule_at_payload(request.payload):
                raise HTTPException(status_code=400, detail="Reschedule date/time is required.")

        if str(effective_event_id) == "4":
            if not _extract_return_proof_photo(request.payload).startswith("data:image/"):
                raise HTTPException(status_code=400, detail="Return product photo is required for Expeditie returnata.")

        # Standard locality for driver app updates
        details = {
            "localityName": "Driver App Location",
            "driverName": current_driver.name,
            "eventDate": datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S"),
        }
        
        # Merge extra payload if provided
        if request.payload:
            details.update(request.payload)

        reason_code, reason_note = _extract_reason_payload(request.payload)
        action_code, new_recipient = _extract_refusal_action_payload(request.payload)
        reason_note_with_action = _merge_reason_with_refusal_action(
            reason_note=reason_note,
            action_code=action_code,
            new_recipient=new_recipient,
        )

        if str(effective_event_id) == "3":
            if reason_code:
                details["reasonCode"] = reason_code
            if reason_note_with_action:
                details["reason"] = reason_note_with_action
        elif str(effective_event_id) == "4":
            details["eventDescription"] = "Expeditie returnata"
            details["returnReasonCode"] = reason_code or "RETURN_TO_STORE"
            details["returnReason"] = reason_note_with_action or "Return to store after refused delivery"
        elif str(effective_event_id) == "7":
            reschedule_at = _extract_reschedule_at_payload(request.payload)
            if reschedule_at:
                details["rescheduleAt"] = reschedule_at
            if reason_code:
                details["reasonCode"] = reason_code
            if reason_note_with_action:
                details["reason"] = reason_note_with_action

        result = await p_client.update_status_by_awb_or_client_order_id(identifier, effective_event_id, details)
        if str(effective_event_id) in {"3", "4", "7"}:
            try:
                shipments_service.ensure_shipments_schema(db)
                ship = ship_for_flow or _find_shipment_by_awb(db, identifier)
                if ship:
                    if str(effective_event_id) == "7":
                        _persist_reschedule_meta_on_shipment(
                            ship,
                            reschedule_at=_extract_reschedule_at_payload(request.payload),
                        )
                    if str(effective_event_id) in {"3", "4"}:
                        _persist_refusal_meta_on_shipment(
                            ship,
                            action_code=action_code,
                            reason_code=reason_code,
                            reason_note=reason_note_with_action,
                            new_recipient=new_recipient,
                        )
                    ship.status = _EVENT_TO_STATUS.get(str(effective_event_id)) or ship.status
                    ship.awb_status_date = datetime.utcnow()
                    ship.last_updated = datetime.utcnow()
                    db.commit()
            except Exception:
                try:
                    db.rollback()
                except Exception:
                    pass
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
    def _collect_user_counts() -> Dict[str, int]:
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
            "users_total": int(users_total or 0),
            "users_active": int(users_active or 0),
            "drivers_total": int(drivers_total or 0),
            "drivers_active": int(drivers_active or 0),
            "recipients_total": int(recipients_total or 0),
            "recipients_active": int(recipients_active or 0),
        }

    counts = _collect_user_counts()
    auto_seeded = 0

    # Self-heal: if no driver accounts exist, restore standard fleet accounts.
    if int(counts.get("drivers_total") or 0) == 0:
        try:
            try:
                from .scripts import import_fleet_accounts as fleet_accounts_seed
            except ImportError:  # pragma: no cover
                from scripts import import_fleet_accounts as fleet_accounts_seed
            seeded_rows = fleet_accounts_seed.upsert_standard_fleet_accounts(db, reset_passwords=False)
            db.commit()
            auto_seeded = len(seeded_rows or [])
            counts = _collect_user_counts()
        except Exception as seed_exc:
            db.rollback()
            logger.warning("sync-drivers auto-seed skipped/failed: %s", str(seed_exc))

    return {
        "status": "ok",
        "source": "database",
        "message": "Users/drivers are managed directly in database.",
        "users_total": int(counts.get("users_total") or 0),
        "users_active": int(counts.get("users_active") or 0),
        "drivers_total": int(counts.get("drivers_total") or 0),
        "drivers_active": int(counts.get("drivers_active") or 0),
        "recipients_total": int(counts.get("recipients_total") or 0),
        "recipients_active": int(counts.get("recipients_active") or 0),
        "phone_norm_backfilled": int(backfilled_phone_norm or 0),
        "auto_seeded_accounts": int(auto_seeded or 0),
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


def _enforce_driver_route_plan_access_or_403(current_driver: models.Driver, row: models.RoutePlan) -> None:
    role = authz.normalize_role(current_driver.role)
    if role != authz.ROLE_DRIVER:
        return

    my_id = str(current_driver.driver_id or "").strip().upper()
    is_assigned = str(getattr(row, "status", "") or "") in {
        route_planning_service.STATUS_ASSIGNED,
        route_planning_service.STATUS_APPROVED,
    }
    assigned_to_me = str(getattr(row, "assigned_driver_id", "") or "").strip().upper() == my_id
    if not (is_assigned and assigned_to_me):
        raise HTTPException(status_code=403, detail="Route is not assigned to this driver")


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

    all_awbs: List[str] = []
    for r in rows:
        for awb in (getattr(r, "awbs", None) or []):
            key = str(awb or "").strip().upper()
            if key:
                all_awbs.append(key)
    ts_map = _route_awb_status_timestamp_map(db, all_awbs)

    out: List[Dict[str, Any]] = []
    for r in rows:
        payload = route_planning_service.route_plan_to_dict(r)
        payload = _ensure_route_plan_stop_hints_payload(db, payload)
        payload = _attach_route_plan_staleness(payload, awb_status_ts=ts_map)
        out.append(payload)
    return out


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

    _enforce_driver_route_plan_access_or_403(current_driver, row)

    payload = route_planning_service.route_plan_to_dict(row)
    payload = _ensure_route_plan_stop_hints_payload(db, payload)
    payload = _attach_route_plan_staleness(payload, awb_status_ts=_route_awb_status_timestamp_map(db, payload.get("awbs") or []))
    return payload


@app.delete("/routes/plans/{plan_id}", response_model=schemas.RoutePlanDeleteResponse)
async def delete_route_plan(
    plan_id: int,
    db: Session = Depends(database.get_db),
    current_driver: models.Driver = Depends(permission_required(authz.PERM_ROUTE_PLANS_WRITE)),
):
    if not route_planning_service.ensure_route_plans_schema(db):
        raise HTTPException(status_code=503, detail="Route plans unavailable")

    role = authz.normalize_role(current_driver.role)
    if role not in {authz.ROLE_ADMIN, authz.ROLE_MANAGER, authz.ROLE_DISPATCHER}:
        raise HTTPException(status_code=403, detail="Only admin/manager/dispatcher can delete route plans")

    try:
        payload = route_planning_service.delete_route_plan_and_replan_county(
            db,
            plan_id=plan_id,
            deleted_by_user_id=current_driver.driver_id,
        )
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except RuntimeError as e:
        raise HTTPException(status_code=503, detail=str(e))
    except Exception as e:
        logger.error("Delete route plan failed: %s", str(e), exc_info=True)
        raise HTTPException(status_code=500, detail="Failed to delete route plan")

    return payload


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

    try:
        _notify_route_assignment(
            db,
            plan=row,
            assigned_by_user_id=current_driver.driver_id,
        )
    except Exception as notify_err:
        logger.warning("Route assignment notifications failed: %s", str(notify_err), exc_info=True)

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


@app.post("/routes/plans/{plan_id}/truck-loaded", status_code=200)
async def mark_truck_loaded(
    plan_id: int,
    db: Session = Depends(database.get_db),
    current_driver: models.Driver = Depends(get_current_driver),
):
    if not route_planning_service.ensure_route_plans_schema(db):
        raise HTTPException(status_code=503, detail="Route plans unavailable")

    row = route_planning_service.get_route_plan(db, plan_id)
    if not row:
        raise HTTPException(status_code=404, detail="Route plan not found")

    driver_id = str(getattr(row, "assigned_driver_id", "") or "").strip()
    route_name = str(getattr(row, "name", "") or f"ID {plan_id}").strip()

    notify_target_ids = set()
    if driver_id:
        notify_target_ids.add(driver_id)
    
    admins = db.query(models.Driver).filter(
        models.Driver.role.in_([authz.ROLE_ADMIN, authz.ROLE_MANAGER, authz.ROLE_DISPATCHER])
    ).all()
    for a in admins:
        if a.driver_id:
            notify_target_ids.add(a.driver_id)

    for target_id in notify_target_ids:
        try:
            notifications_service.create_notification(
                db,
                user_id=target_id,
                title="Camion Incarcat",
                body=f"Incarcarea a fost finalizata cu succes pentru ruta {route_name}. LIFO strict activat.",
                data={"route_plan_id": plan_id, "type": "TRUCK_LOADED"}
            )
        except Exception as e:
            logger.error("Failed to notify user %s truck loaded: %s", target_id, str(e))
            
    db.commit()
    return {"message": "Notification broadcasted successfully."}



@app.post("/routes/plans/{plan_id}/avize", response_model=schemas.RouteAvizSchema, status_code=201)
async def issue_route_aviz(
    plan_id: int,
    db: Session = Depends(database.get_db),
    current_driver: models.Driver = Depends(permission_required(authz.PERM_ROUTE_PLANS_WRITE)),
):
    if not route_planning_service.ensure_route_plans_schema(db):
        raise HTTPException(status_code=503, detail="Route plans unavailable")
    if not route_aviz_service.ensure_route_avize_schema(db):
        raise HTTPException(status_code=503, detail="Route avize unavailable")

    role = authz.normalize_role(current_driver.role)
    if role not in {authz.ROLE_ADMIN, authz.ROLE_MANAGER, authz.ROLE_DISPATCHER}:
        raise HTTPException(status_code=403, detail="Only admin/manager/dispatcher can issue avize")

    row = route_planning_service.get_route_plan(db, plan_id)
    if not row:
        raise HTTPException(status_code=404, detail="Route plan not found")

    if str(getattr(row, "status", "") or "") != route_planning_service.STATUS_ASSIGNED:
        raise HTTPException(status_code=409, detail="Route must be assigned before issuing an aviz")
    if not str(getattr(row, "assigned_vehicle_plate", "") or "").strip():
        raise HTTPException(status_code=409, detail="Assigned route must have a vehicle plate")
    if not str(getattr(row, "assigned_driver_id", "") or "").strip():
        raise HTTPException(status_code=409, detail="Assigned route must have a driver")

    try:
        doc = route_aviz_service.issue_route_aviz(
            db,
            plan=row,
            created_by_user_id=current_driver.driver_id,
        )
    except RuntimeError as e:
        raise HTTPException(status_code=503, detail=str(e))
    except Exception as e:
        logger.error("Issue route aviz failed: %s", str(e), exc_info=True)
        raise HTTPException(status_code=500, detail="Failed to issue route aviz")

    db.commit()
    db.refresh(doc)
    return route_aviz_service.route_aviz_to_dict(doc)


@app.get("/routes/plans/{plan_id}/avize", response_model=List[schemas.RouteAvizSchema])
async def list_route_plan_avize(
    plan_id: int,
    limit: int = 100,
    db: Session = Depends(database.get_db),
    current_driver: models.Driver = Depends(permission_required(authz.PERM_ROUTE_PLANS_READ)),
):
    if not route_planning_service.ensure_route_plans_schema(db):
        raise HTTPException(status_code=503, detail="Route plans unavailable")
    if not route_aviz_service.ensure_route_avize_schema(db):
        return []

    row = route_planning_service.get_route_plan(db, plan_id)
    if not row:
        raise HTTPException(status_code=404, detail="Route plan not found")
    _enforce_driver_route_plan_access_or_403(current_driver, row)

    avize_rows = route_aviz_service.list_route_avize_for_plan(db, plan_id=plan_id, limit=limit)
    return [route_aviz_service.route_aviz_to_dict(x) for x in avize_rows]


@app.get("/avize", response_model=List[schemas.RouteAvizSchema])
async def list_avize(
    route_plan_id: Optional[int] = None,
    limit: int = 100,
    db: Session = Depends(database.get_db),
    current_driver: models.Driver = Depends(permission_required(authz.PERM_ROUTE_PLANS_READ)),
):
    if not route_aviz_service.ensure_route_avize_schema(db):
        return []

    rows = route_aviz_service.list_route_avize(db, plan_id=route_plan_id, limit=limit)

    role = authz.normalize_role(current_driver.role)
    if role == authz.ROLE_DRIVER:
        my_id = str(current_driver.driver_id or "").strip().upper()
        rows = [
            r
            for r in rows
            if str(getattr(r, "driver_id", "") or "").strip().upper() == my_id
        ]
    return [route_aviz_service.route_aviz_to_dict(x) for x in rows]


@app.get("/avize/{aviz_id}", response_model=schemas.RouteAvizSchema)
async def get_route_aviz(
    aviz_id: int,
    db: Session = Depends(database.get_db),
    current_driver: models.Driver = Depends(permission_required(authz.PERM_ROUTE_PLANS_READ)),
):
    if not route_planning_service.ensure_route_plans_schema(db):
        raise HTTPException(status_code=503, detail="Route plans unavailable")
    if not route_aviz_service.ensure_route_avize_schema(db):
        raise HTTPException(status_code=503, detail="Route avize unavailable")

    doc = route_aviz_service.get_route_aviz(db, aviz_id)
    if not doc:
        raise HTTPException(status_code=404, detail="Aviz not found")

    plan = route_planning_service.get_route_plan(db, int(getattr(doc, "route_plan_id", 0) or 0))
    if not plan:
        raise HTTPException(status_code=404, detail="Route plan not found for this aviz")
    _enforce_driver_route_plan_access_or_403(current_driver, plan)

    return route_aviz_service.route_aviz_to_dict(doc)


@app.get("/avize/{aviz_id}/pdf")
async def get_route_aviz_pdf(
    aviz_id: int,
    download: bool = False,
    db: Session = Depends(database.get_db),
    current_driver: models.Driver = Depends(permission_required(authz.PERM_ROUTE_PLANS_READ)),
):
    if not route_planning_service.ensure_route_plans_schema(db):
        raise HTTPException(status_code=503, detail="Route plans unavailable")
    if not route_aviz_service.ensure_route_avize_schema(db):
        raise HTTPException(status_code=503, detail="Route avize unavailable")

    doc = route_aviz_service.get_route_aviz(db, aviz_id)
    if not doc:
        raise HTTPException(status_code=404, detail="Aviz not found")

    plan = route_planning_service.get_route_plan(db, int(getattr(doc, "route_plan_id", 0) or 0))
    if not plan:
        raise HTTPException(status_code=404, detail="Route plan not found for this aviz")
    _enforce_driver_route_plan_access_or_403(current_driver, plan)

    try:
        pdf_bytes = route_aviz_service.build_route_aviz_pdf(doc)
    except Exception as e:
        logger.error("Build aviz PDF failed: %s", str(e), exc_info=True)
        raise HTTPException(status_code=500, detail="Failed to build aviz PDF")

    aviz_number = str(getattr(doc, "aviz_number", "") or f"aviz_{aviz_id}").strip().replace("/", "-")
    filename = f"{aviz_number}.pdf"
    disposition = "attachment" if bool(download) else "inline"
    return Response(
        content=pdf_bytes,
        media_type="application/pdf",
        headers={"Content-Disposition": f'{disposition}; filename="{filename}"'},
    )

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

    normalized = _normalize_ro_coord_pair(location.latitude, location.longitude)
    if not normalized:
        raise HTTPException(status_code=400, detail="Location must be inside Romania bounds.")
    lat, lon = normalized

    # Create history entry
    loc_entry = models.DriverLocation(
        driver_id=current_driver.driver_id,
        latitude=lat,
        longitude=lon,
        timestamp=now
    )
    db.add(loc_entry)

    vehicle_meta = fleet_service.apply_location_to_vehicle(
        db,
        driver_id=str(current_driver.driver_id or "").strip(),
        latitude=lat,
        longitude=lon,
        now=now,
        vehicle_id=location.vehicle_id,
        vehicle_plate=location.vehicle_plate,
        phone_id=location.phone_id,
        phone_label=location.phone_label,
        assigned_by_user_id=current_driver.driver_id,
        source="driver_app_location",
    )

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
    return {
        "status": "updated",
        "timestamp": loc_entry.timestamp,
        "vehicle_id": vehicle_meta.get("vehicle_id"),
        "vehicle_plate": vehicle_meta.get("vehicle_plate"),
        "assignment_id": vehicle_meta.get("assignment_id"),
        "delta_km": float(vehicle_meta.get("delta_km") or 0.0),
        "vehicle_odometer_km": vehicle_meta.get("vehicle_odometer_km"),
    }


# [NEW] Live ops: latest driver locations (dispatcher dashboard)
@app.get("/live/drivers")
async def live_drivers(
    limit: int = 100,
    only_drivers: bool = True,
    trail_points: int = 8,
    trail_minutes: int = 120,
    db: Session = Depends(database.get_db),
    current_driver: models.Driver = Depends(permission_required(authz.PERM_LIVEOPS_READ)),
):
    drivers_service.ensure_drivers_schema(db)
    try:
        limit_n = int(limit or 100)
    except Exception:
        limit_n = 100
    limit_n = max(1, min(limit_n, 500))
    trail_n = _clamp_int(trail_points, default=8, min_v=0, max_v=30)
    trail_window_min = _clamp_int(trail_minutes, default=120, min_v=5, max_v=24 * 60)

    # For SQLite portability, compute latest location in Python.
    now = datetime.utcnow()
    q = db.query(models.Driver).filter(models.Driver.active.is_(True))
    raw_rows = q.order_by(models.Driver.driver_id.asc()).limit(limit_n * 3).all()
    if only_drivers:
        drivers = [d for d in raw_rows if authz.normalize_role(getattr(d, "role", None)) == authz.ROLE_DRIVER][:limit_n]
    else:
        drivers = raw_rows[:limit_n]

    driver_ids = [
        str(getattr(d, "driver_id", "") or "").strip()
        for d in drivers
        if str(getattr(d, "driver_id", "") or "").strip()
    ]

    def _coord_from_shipment_for_live(ship: Optional[models.Shipment]) -> Optional[Tuple[float, float]]:
        if not ship:
            return None
        normalized = _normalize_ro_coord_pair(getattr(ship, "latitude", None), getattr(ship, "longitude", None))
        if normalized:
            return float(normalized[0]), float(normalized[1])

        pin = getattr(ship, "recipient_pin", None) if isinstance(getattr(ship, "recipient_pin", None), dict) else {}
        loc = getattr(ship, "recipient_location", None) if isinstance(getattr(ship, "recipient_location", None), dict) else {}
        pin_norm = _normalize_ro_coord_pair(
            (pin.get("latitude") if isinstance(pin, dict) else None) or (pin.get("lat") if isinstance(pin, dict) else None),
            (pin.get("longitude") if isinstance(pin, dict) else None) or (pin.get("lon") if isinstance(pin, dict) else None) or (pin.get("lng") if isinstance(pin, dict) else None),
        )
        if pin_norm:
            return float(pin_norm[0]), float(pin_norm[1])

        loc_norm = _normalize_ro_coord_pair(
            (loc.get("latitude") if isinstance(loc, dict) else None) or (loc.get("lat") if isinstance(loc, dict) else None),
            (loc.get("longitude") if isinstance(loc, dict) else None) or (loc.get("lon") if isinstance(loc, dict) else None) or (loc.get("lng") if isinstance(loc, dict) else None),
        )
        if loc_norm:
            return float(loc_norm[0]), float(loc_norm[1])
        return None

    active_run_by_driver: Dict[str, models.RouteRun] = {}
    next_stop_by_driver: Dict[str, Dict[str, Any]] = {}
    if driver_ids and route_runs_service.ensure_route_runs_schema(db):
        try:
            active_runs = (
                db.query(models.RouteRun)
                .filter(models.RouteRun.status == "Active")
                .filter(models.RouteRun.driver_id.in_(driver_ids))
                .order_by(models.RouteRun.started_at.desc().nullslast(), models.RouteRun.created_at.desc())
                .all()
            )
            for run in active_runs:
                did = str(getattr(run, "driver_id", "") or "").strip()
                if not did or did in active_run_by_driver:
                    continue
                active_run_by_driver[did] = run

                stops = sorted(
                    list(getattr(run, "stops", []) or []),
                    key=lambda s: (999999 if getattr(s, "seq", None) is None else int(getattr(s, "seq", 0)), int(getattr(s, "id", 0) or 0)),
                )
                next_stop = None
                for stop in stops:
                    state = str(getattr(stop, "state", "") or "").strip().lower()
                    if state in {"done", "skipped"}:
                        continue
                    next_stop = stop
                    break
                if next_stop:
                    next_stop_by_driver[did] = {
                        "run_id": int(getattr(run, "id", 0) or 0),
                        "route_name": str(getattr(run, "route_name", "") or "").strip() or None,
                        "next_awb": str(getattr(next_stop, "awb", "") or "").strip().upper() or None,
                        "next_seq": int(getattr(next_stop, "seq", 0) or 0) or None,
                        "next_state": str(getattr(next_stop, "state", "") or "").strip() or None,
                    }
        except Exception:
            active_run_by_driver = {}
            next_stop_by_driver = {}

    next_stop_awbs = sorted({
        str((meta or {}).get("next_awb") or "").strip().upper()
        for meta in (next_stop_by_driver.values() or [])
        if str((meta or {}).get("next_awb") or "").strip()
    })
    shipment_by_awb: Dict[str, models.Shipment] = {}
    if next_stop_awbs:
        try:
            shipments_service.ensure_shipments_schema(db)
            rows = db.query(models.Shipment).filter(models.Shipment.awb.in_(next_stop_awbs)).all()
            shipment_by_awb = {
                str(getattr(row, "awb", "") or "").strip().upper(): row
                for row in (rows or [])
                if str(getattr(row, "awb", "") or "").strip()
            }
        except Exception:
            shipment_by_awb = {}

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

    trail_by_driver: Dict[str, List[Dict[str, Any]]] = {}
    if trail_n > 1 and driver_ids:
        try:
            since = now - timedelta(minutes=trail_window_min)
            max_rows = max(limit_n * trail_n * 8, limit_n * trail_n)
            history_rows = (
                db.query(models.DriverLocation)
                .filter(models.DriverLocation.driver_id.in_(driver_ids))
                .filter(models.DriverLocation.timestamp.isnot(None), models.DriverLocation.timestamp >= since)
                .order_by(models.DriverLocation.timestamp.desc(), models.DriverLocation.id.desc())
                .limit(max_rows)
                .all()
            )
            for loc in history_rows:
                did = str(getattr(loc, "driver_id", "") or "").strip()
                if not did:
                    continue
                arr = trail_by_driver.setdefault(did, [])
                if len(arr) >= trail_n:
                    continue
                lat = getattr(loc, "latitude", None)
                lon = getattr(loc, "longitude", None)
                ts = getattr(loc, "timestamp", None)
                if lat is None or lon is None or ts is None:
                    continue
                normalized_point = _normalize_ro_coord_pair(lat, lon)
                if not normalized_point:
                    continue
                arr.append(
                    {
                        "latitude": float(normalized_point[0]),
                        "longitude": float(normalized_point[1]),
                        "timestamp": ts.isoformat() + "Z",
                    }
                )
        except Exception:
            trail_by_driver = {}

    active_assignment_by_driver: Dict[str, models.FleetVehicleAssignment] = {}
    vehicles_by_id: Dict[int, models.FleetVehicle] = {}
    if driver_ids and fleet_service.ensure_fleet_schema(db):
        try:
            did_keys = [str(x or "").strip().upper() for x in driver_ids if str(x or "").strip()]
            if did_keys:
                asg_rows = (
                    db.query(models.FleetVehicleAssignment)
                    .filter(models.FleetVehicleAssignment.active.is_(True))
                    .filter(func.upper(models.FleetVehicleAssignment.driver_id).in_(did_keys))
                    .order_by(models.FleetVehicleAssignment.assigned_at.desc(), models.FleetVehicleAssignment.id.desc())
                    .all()
                )
                for row in asg_rows:
                    did_key = str(getattr(row, "driver_id", "") or "").strip().upper()
                    if not did_key or did_key in active_assignment_by_driver:
                        continue
                    active_assignment_by_driver[did_key] = row

                vehicle_ids = sorted({
                    int(getattr(row, "vehicle_id", 0) or 0)
                    for row in active_assignment_by_driver.values()
                    if int(getattr(row, "vehicle_id", 0) or 0) > 0
                })
                if vehicle_ids:
                    for vv in db.query(models.FleetVehicle).filter(models.FleetVehicle.id.in_(vehicle_ids)).all():
                        vid = int(getattr(vv, "id", 0) or 0)
                        if vid > 0:
                            vehicles_by_id[vid] = vv
        except Exception:
            active_assignment_by_driver = {}
            vehicles_by_id = {}

    out = []
    for d in drivers:
        did = str(d.driver_id or "").strip()
        if not did:
            continue
        did_key = did.upper()
        loc = latest_by_driver.get(did)
        active_asg = active_assignment_by_driver.get(did_key)
        active_vehicle = None
        if active_asg is not None:
            try:
                active_vehicle = vehicles_by_id.get(int(getattr(active_asg, "vehicle_id", 0) or 0))
            except Exception:
                active_vehicle = None

        trail_desc = list(trail_by_driver.get(did) or [])
        trail = list(reversed(trail_desc))
        speed_kmh = None
        heading_deg = None
        if len(trail_desc) >= 2:
            try:
                newest = trail_desc[0]
                older = trail_desc[1]
                t1 = datetime.fromisoformat(str(newest.get("timestamp") or "").replace("Z", ""))
                t0 = datetime.fromisoformat(str(older.get("timestamp") or "").replace("Z", ""))
                dt_s = (t1 - t0).total_seconds()
                if dt_s > 0:
                    dist_m = _haversine_m(
                        newest.get("latitude"),
                        newest.get("longitude"),
                        older.get("latitude"),
                        older.get("longitude"),
                    )
                    speed_kmh = round((dist_m / dt_s) * 3.6, 1)
                    heading_deg = _bearing_deg(
                        older.get("latitude"),
                        older.get("longitude"),
                        newest.get("latitude"),
                        newest.get("longitude"),
                    )
            except Exception:
                speed_kmh = None
                heading_deg = None

        last_lat = getattr(loc, "latitude", None) if loc else None
        last_lon = getattr(loc, "longitude", None) if loc else None
        normalized_last = _normalize_ro_coord_pair(last_lat, last_lon)
        ts = getattr(loc, "timestamp", None) if loc else None
        if not normalized_last and trail_desc:
            first_valid = trail_desc[0]
            normalized_last = _normalize_ro_coord_pair(first_valid.get("latitude"), first_valid.get("longitude"))
            if not ts:
                raw_ts = str(first_valid.get("timestamp") or "").strip()
                if raw_ts:
                    try:
                        ts = datetime.fromisoformat(raw_ts.replace("Z", ""))
                    except Exception:
                        ts = None

        age_sec = None
        if ts:
            try:
                age_sec = int((now - ts).total_seconds())
            except Exception:
                age_sec = None

        location_status = "unknown"
        location_status_hint = ""
        if age_sec is None:
            location_status = "unknown"
            location_status_hint = "No GPS update received yet."
        elif age_sec <= 60:
            location_status = "live"
            location_status_hint = "Live GPS updates active."
        elif age_sec <= 5 * 60:
            location_status = "stale"
            location_status_hint = "GPS updates are delayed."
        else:
            location_status = "offline"
            location_status_hint = "No fresh GPS from phone. Driver app may be closed or phone has no signal."

        out.append(
            {
                "driver_id": did,
                "name": d.name,
                "role": authz.normalize_role(d.role),
                "truck_plate": (
                    str(getattr(active_vehicle, "plate", "") or "").strip().upper()
                    or str(getattr(active_asg, "vehicle_plate", "") or "").strip().upper()
                    or None
                ),
                "truck_phone": (
                    str(getattr(active_vehicle, "assigned_phone", "") or "").strip()
                    or str(getattr(active_asg, "phone_label", "") or "").strip()
                    or None
                ),
                "helper_name": (
                    str(getattr(active_vehicle, "helper_name", "") or "").strip()
                    or (str(d.helper_name or "").strip() or None)
                ),
                "latitude": normalized_last[0] if normalized_last else None,
                "longitude": normalized_last[1] if normalized_last else None,
                "timestamp": ts.isoformat() if ts else None,
                "age_sec": age_sec,
                "is_live": bool(age_sec is not None and age_sec <= 60),
                "location_status": location_status,
                "location_status_hint": location_status_hint,
                "speed_kmh": speed_kmh,
                "heading_deg": heading_deg,
                "trail": trail,
                "active_run_id": int(getattr(active_run_by_driver.get(did), "id", 0) or 0) or None,
                "active_route_name": str(getattr(active_run_by_driver.get(did), "route_name", "") or "").strip() or None,
                "active_route_status": str(getattr(active_run_by_driver.get(did), "status", "") or "").strip() or None,
            }
        )
        next_meta = next_stop_by_driver.get(did) or {}
        next_awb = str(next_meta.get("next_awb") or "").strip().upper()
        if next_awb:
            ship = shipment_by_awb.get(next_awb)
            next_coords = _coord_from_shipment_for_live(ship)
            recipient_name = str(getattr(ship, "recipient_name", "") or "").strip() if ship else ""
            locality = str(getattr(ship, "locality", "") or "").strip() if ship else ""
            delivery_address = str(getattr(ship, "delivery_address", "") or "").strip() if ship else ""
            distance_to_next_m = None
            if next_coords and normalized_last:
                try:
                    distance_to_next_m = float(_haversine_m(
                        normalized_last[0],
                        normalized_last[1],
                        next_coords[0],
                        next_coords[1],
                    ))
                except Exception:
                    distance_to_next_m = None
            out[-1]["next_stop_awb"] = next_awb
            out[-1]["next_stop_seq"] = next_meta.get("next_seq")
            out[-1]["next_stop_state"] = next_meta.get("next_state")
            out[-1]["next_stop_recipient_name"] = recipient_name or None
            out[-1]["next_stop_locality"] = locality or None
            out[-1]["next_stop_address"] = delivery_address or None
            out[-1]["next_stop_latitude"] = float(next_coords[0]) if next_coords else None
            out[-1]["next_stop_longitude"] = float(next_coords[1]) if next_coords else None
            out[-1]["next_stop_distance_km"] = (round(distance_to_next_m / 1000.0, 2) if distance_to_next_m is not None else None)
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

    resolved_truck_plate = str(request.truck_plate or "").strip().upper() or None
    resolved_helper_name = str(request.helper_name or "").strip() or None
    try:
        if fleet_service.ensure_fleet_schema(db):
            asg = fleet_service.get_active_assignment(
                db,
                driver_id=str(getattr(current_driver, "driver_id", "") or "").strip(),
                phone_label=None,
            )
            if asg:
                vehicle = db.query(models.FleetVehicle).filter(
                    models.FleetVehicle.id == int(getattr(asg, "vehicle_id", 0) or 0)
                ).first()
                if not resolved_truck_plate:
                    resolved_truck_plate = (
                        str(getattr(vehicle, "plate", "") or "").strip().upper()
                        or str(getattr(asg, "vehicle_plate", "") or "").strip().upper()
                        or None
                    )
                if not resolved_helper_name:
                    resolved_helper_name = str(getattr(vehicle, "helper_name", "") or "").strip() or None
    except Exception:
        pass

    if not resolved_helper_name:
        resolved_helper_name = str(getattr(current_driver, "helper_name", "") or "").strip() or None

    run = route_runs_service.start_run(
        db,
        route_id=request.route_id,
        route_name=request.route_name,
        awbs=request.awbs,
        driver_id=current_driver.driver_id,
        truck_plate=resolved_truck_plate,
        helper_name=resolved_helper_name,
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


@app.post("/route-runs/{run_id}/stops/{awb}/depart", response_model=schemas.RouteRunStopSchema)
async def route_run_depart_to_stop(
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

    stop = route_runs_service.mark_on_the_way(
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
    db: Session = Depends(database.get_db),
    current_driver: models.Driver = Depends(get_current_driver),
):
    points = list(request.points or [])
    if len(points) < 2:
        raise HTTPException(status_code=400, detail="At least 2 points are required.")

    access = _maps_resolve_access(db, current_driver)
    api_key = str(access.get("api_key") or "").strip()
    if not api_key:
        if str(access.get("mode") or "") == "own":
            raise HTTPException(status_code=400, detail="Own Google Maps key not configured.")
        raise HTTPException(status_code=503, detail="Platform Google Maps key not configured.")

    _maps_check_platform_credit(access, requests_count=1)

    metrics = await _google_route_metrics(points, api_key=api_key)
    if not metrics:
        raise HTTPException(status_code=503, detail="Traffic-aware route metrics unavailable.")

    _maps_record_usage(
        db,
        current_driver=current_driver,
        access=access,
        action="route_metrics",
        requests_count=1,
        meta={"points": len(points)},
    )
    return metrics


@app.post("/maps/route-optimize", response_model=schemas.RouteOptimizeResponse)
async def maps_route_optimize(
    request: schemas.RouteOptimizeRequest,
    db: Session = Depends(database.get_db),
    current_driver: models.Driver = Depends(get_current_driver),
):
    stops = list(request.stops or [])
    if len(stops) < 2:
        raise HTTPException(status_code=400, detail="At least 2 stops are required.")

    access = _maps_resolve_access(db, current_driver)
    api_key = str(access.get("api_key") or "").strip()
    if not api_key:
        if str(access.get("mode") or "") == "own":
            raise HTTPException(status_code=400, detail="Own Google Maps key not configured.")
        raise HTTPException(status_code=503, detail="Platform Google Maps key not configured.")

    _maps_check_platform_credit(access, requests_count=1)

    optimized = await _google_optimize_route(
        origin=request.origin,
        stops=stops,
        return_to_origin=bool(request.return_to_origin),
        api_key=api_key,
    )
    if not optimized:
        raise HTTPException(status_code=503, detail="Google route optimization unavailable.")

    _maps_record_usage(
        db,
        current_driver=current_driver,
        access=access,
        action="route_optimize",
        requests_count=1,
        meta={"stops": len(stops)},
    )
    return optimized


@app.post("/maps/geocode", response_model=schemas.GeocodeResponse)
async def maps_geocode(
    request: schemas.GeocodeRequest,
    db: Session = Depends(database.get_db),
    current_driver: models.Driver = Depends(get_current_driver),
):
    query_text = str(request.query or "").strip()
    if not query_text:
        raise HTTPException(status_code=400, detail="query is required")

    access = _maps_resolve_access(db, current_driver)
    api_key = str(access.get("api_key") or "").strip() or None
    if str(access.get("mode") or "") == "own" and not api_key:
        raise HTTPException(status_code=400, detail="Own Google Maps key not configured.")
    _maps_check_platform_credit(access, requests_count=1)

    payload = await asyncio.to_thread(
        geocoding_service.geocode_query_live,
        query_text,
        expected_locality=request.expected_locality,
        expected_county=request.expected_county,
        google_api_key=api_key,
    )

    if not payload:
        lat, lon, source = geocoding_service.fallback_coords_for_query(
            query_text,
            expected_locality=request.expected_locality,
            expected_county=request.expected_county,
        )
        result = {
            "found": True,
            "lat": float(lat),
            "lon": float(lon),
            "formatted_address": query_text,
            "provider": source,
        }
        if api_key:
            _maps_record_usage(
                db,
                current_driver=current_driver,
                access=access,
                action="geocode",
                requests_count=1,
                meta={"provider": source},
            )
        return result

    lat = float(payload.get("lat")) if payload.get("lat") is not None else None
    lon = float(payload.get("lon")) if payload.get("lon") is not None else None
    if lat is None or lon is None:
        fb_lat, fb_lon, fb_source = geocoding_service.fallback_coords_for_query(
            query_text,
            expected_locality=request.expected_locality,
            expected_county=request.expected_county,
        )
        result = {
            "found": True,
            "lat": float(fb_lat),
            "lon": float(fb_lon),
            "formatted_address": str(payload.get("display_name") or query_text),
            "provider": str(payload.get("provider") or "") or fb_source,
        }
        if api_key:
            _maps_record_usage(
                db,
                current_driver=current_driver,
                access=access,
                action="geocode",
                requests_count=1,
                meta={"provider": str(payload.get("provider") or "") or fb_source},
            )
        return result

    result = {
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
    if api_key:
        _maps_record_usage(
            db,
            current_driver=current_driver,
            access=access,
            action="geocode",
            requests_count=1,
            meta={"provider": str(payload.get("provider") or "") or None},
        )
    return result


def _maps_valid_coord(lat: Any, lon: Any) -> bool:
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


def _maps_extract_shipment_coord(ship: Optional[models.Shipment]) -> Tuple[Optional[float], Optional[float], Optional[str]]:
    if not ship:
        return None, None, None

    normalized_db = _normalize_ro_coord_pair(getattr(ship, "latitude", None), getattr(ship, "longitude", None))
    if normalized_db:
        source = str(getattr(ship, "geocode_source", "") or "").strip() or "shipment"
        return float(normalized_db[0]), float(normalized_db[1]), source

    recipient_pin = getattr(ship, "recipient_pin", None) if isinstance(getattr(ship, "recipient_pin", None), dict) else {}
    recipient_loc = getattr(ship, "recipient_location", None) if isinstance(getattr(ship, "recipient_location", None), dict) else {}

    pin_lat = _safe_float(
        ((recipient_pin or {}).get("latitude") if isinstance(recipient_pin, dict) else None)
        or ((recipient_pin or {}).get("lat") if isinstance(recipient_pin, dict) else None)
    )
    pin_lon = _safe_float(
        ((recipient_pin or {}).get("longitude") if isinstance(recipient_pin, dict) else None)
        or ((recipient_pin or {}).get("lon") if isinstance(recipient_pin, dict) else None)
        or ((recipient_pin or {}).get("lng") if isinstance(recipient_pin, dict) else None)
    )
    normalized_pin = _normalize_ro_coord_pair(pin_lat, pin_lon)
    if normalized_pin:
        return float(normalized_pin[0]), float(normalized_pin[1]), "postis-pin"

    loc_lat = _safe_float(
        ((recipient_loc or {}).get("latitude") if isinstance(recipient_loc, dict) else None)
        or ((recipient_loc or {}).get("lat") if isinstance(recipient_loc, dict) else None)
    )
    loc_lon = _safe_float(
        ((recipient_loc or {}).get("longitude") if isinstance(recipient_loc, dict) else None)
        or ((recipient_loc or {}).get("lon") if isinstance(recipient_loc, dict) else None)
        or ((recipient_loc or {}).get("lng") if isinstance(recipient_loc, dict) else None)
    )
    normalized_loc = _normalize_ro_coord_pair(loc_lat, loc_lon)
    if normalized_loc:
        return float(normalized_loc[0]), float(normalized_loc[1]), "postis-location"

    return None, None, None


def _route_plan_stop_hint_from_shipment(ship: Optional[models.Shipment], *, fallback_awb: Optional[str] = None, county_hint: Optional[str] = None) -> Dict[str, Any]:
    awb = str(getattr(ship, "awb", "") or fallback_awb or "").strip().upper()
    recipient_loc = getattr(ship, "recipient_location", None) if isinstance(getattr(ship, "recipient_location", None), dict) else {}
    recipient_pin = getattr(ship, "recipient_pin", None) if isinstance(getattr(ship, "recipient_pin", None), dict) else {}

    lat, lon, _source = _maps_extract_shipment_coord(ship)

    locality = ""
    for value in (
        getattr(ship, "locality", None),
        recipient_loc.get("localityName") if isinstance(recipient_loc, dict) else None,
        recipient_loc.get("locality") if isinstance(recipient_loc, dict) else None,
        recipient_loc.get("cityName") if isinstance(recipient_loc, dict) else None,
        recipient_loc.get("city") if isinstance(recipient_loc, dict) else None,
        recipient_pin.get("localityName") if isinstance(recipient_pin, dict) else None,
        recipient_pin.get("locality") if isinstance(recipient_pin, dict) else None,
        recipient_pin.get("cityName") if isinstance(recipient_pin, dict) else None,
        recipient_pin.get("city") if isinstance(recipient_pin, dict) else None,
    ):
        text = str(value or "").strip()
        if text:
            locality = text
            break

    county = ""
    for value in (
        county_hint,
        recipient_loc.get("county") if isinstance(recipient_loc, dict) else None,
        recipient_loc.get("countyName") if isinstance(recipient_loc, dict) else None,
        recipient_loc.get("region") if isinstance(recipient_loc, dict) else None,
        recipient_loc.get("regionName") if isinstance(recipient_loc, dict) else None,
        recipient_pin.get("county") if isinstance(recipient_pin, dict) else None,
        recipient_pin.get("countyName") if isinstance(recipient_pin, dict) else None,
        recipient_pin.get("region") if isinstance(recipient_pin, dict) else None,
        recipient_pin.get("regionName") if isinstance(recipient_pin, dict) else None,
    ):
        text = str(value or "").strip()
        if text:
            county = text
            break

    return {
        "awb": awb,
        "recipient_name": str(getattr(ship, "recipient_name", "") or "").strip() or None,
        "delivery_address": str(getattr(ship, "delivery_address", "") or "").strip() or None,
        "locality": locality or None,
        "county": county or None,
        "latitude": float(lat) if lat is not None else None,
        "longitude": float(lon) if lon is not None else None,
        "status": str(getattr(ship, "status", "") or "").strip() or None,
    }


def _ensure_route_plan_stop_hints_payload(db: Session, payload: Dict[str, Any]) -> Dict[str, Any]:
    out = dict(payload or {})
    data = out.get("data")
    if not isinstance(data, dict):
        data = {}
    stops_existing = data.get("stops")
    if isinstance(stops_existing, list) and stops_existing:
        out["data"] = data
        return out

    awbs = [str(x or "").strip().upper() for x in (out.get("awbs") or []) if str(x or "").strip()]
    if not awbs:
        out["data"] = data
        return out

    rows = db.query(models.Shipment).filter(models.Shipment.awb.in_(awbs)).all()
    by_awb: Dict[str, models.Shipment] = {
        str(getattr(s, "awb", "") or "").strip().upper(): s
        for s in rows
        if str(getattr(s, "awb", "") or "").strip()
    }

    stop_payload: List[Dict[str, Any]] = []
    county_hint = str(out.get("county") or "").strip() or None
    for awb in awbs:
        ship = by_awb.get(awb)
        if ship:
            stop_payload.append(_route_plan_stop_hint_from_shipment(ship, fallback_awb=awb, county_hint=county_hint))
        else:
            stop_payload.append({"awb": awb, "county": county_hint})

    data["stops"] = stop_payload
    out["data"] = data
    return out


def _route_awb_status_timestamp_map(db: Session, awbs: List[str]) -> Dict[str, Optional[datetime]]:
    keys: List[str] = []
    seen: Set[str] = set()
    for raw in awbs or []:
        key = str(raw or "").strip().upper()
        if not key or key in seen:
            continue
        seen.add(key)
        keys.append(key)
    if not keys:
        return {}

    rows = (
        db.query(models.Shipment.awb, models.Shipment.awb_status_date, models.Shipment.last_updated)
        .filter(models.Shipment.awb.in_(keys))
        .all()
    )
    out: Dict[str, Optional[datetime]] = {}
    for awb, awb_status_date, last_updated in rows:
        key = str(awb or "").strip().upper()
        if not key:
            continue
        ts = awb_status_date or last_updated
        out[key] = _as_utc_naive(ts) if isinstance(ts, datetime) else None
    return out


def _attach_route_plan_staleness(payload: Dict[str, Any], *, awb_status_ts: Dict[str, Optional[datetime]]) -> Dict[str, Any]:
    out = dict(payload or {})
    data = out.get("data")
    if not isinstance(data, dict):
        data = {}

    stale_days = 4
    try:
        stale_days = max(1, int(str(os.getenv("ROUTE_URGENT_STALE_DAYS", "4") or "4").strip()))
    except Exception:
        stale_days = 4
    cutoff = datetime.utcnow() - timedelta(days=stale_days)
    awbs = [str(x or "").strip().upper() for x in (out.get("awbs") or []) if str(x or "").strip()]
    stale_count = 0
    stale_awbs: List[str] = []
    unknown_count = 0

    for awb in awbs:
        ts = awb_status_ts.get(awb)
        if not isinstance(ts, datetime):
            unknown_count += 1
            continue
        if ts <= cutoff:
            stale_count += 1
            stale_awbs.append(awb)

    data["stale_awb_threshold_days"] = stale_days
    data["stale_awb_count"] = int(stale_count)
    data["stale_awbs"] = stale_awbs
    data["unknown_status_date_count"] = int(unknown_count)
    out["data"] = data
    return out


async def _maps_fetch_postis_details_for_awbs(awbs: List[str], *, concurrency: int = 6, limit: int = 180) -> List[Dict[str, Any]]:
    normalized: List[str] = []
    seen: set[str] = set()
    for raw in awbs or []:
        key = postis_client.normalize_shipment_identifier(raw)
        if not key or key in seen:
            continue
        seen.add(key)
        normalized.append(key)
        if len(normalized) >= max(1, int(limit)):
            break
    if not normalized:
        return []

    sem = asyncio.Semaphore(max(1, int(concurrency)))

    async def _one(awb: str) -> Dict[str, Any]:
        async with sem:
            try:
                payload = await p_client.get_shipment_tracking_by_awb_or_client_order_id(awb)
                return payload if isinstance(payload, dict) else {}
            except Exception:
                return {}

    rows = await asyncio.gather(*[_one(a) for a in normalized], return_exceptions=True)
    out: List[Dict[str, Any]] = []
    for row in rows:
        if isinstance(row, Exception):
            continue
        if isinstance(row, dict) and row:
            out.append(row)
    return out


@app.post("/maps/geocode-shipments", response_model=schemas.GeocodeShipmentsResponse)
async def maps_geocode_shipments(
    request: schemas.GeocodeShipmentsRequest,
    db: Session = Depends(database.get_db),
    current_driver: models.Driver = Depends(get_current_driver),
):
    access = _maps_resolve_access(db, current_driver)
    maps_api_key = str(access.get("api_key") or "").strip() or None
    if str(access.get("mode") or "") == "own" and not maps_api_key:
        raise HTTPException(status_code=400, detail="Own Google Maps key not configured.")

    shipments_service.ensure_shipments_schema(db)

    requested_awbs: List[str] = []
    seen_awbs: set[str] = set()
    for raw in (request.awbs or []):
        awb = postis_client.normalize_shipment_identifier(raw)
        if not awb or awb in seen_awbs:
            continue
        seen_awbs.add(awb)
        requested_awbs.append(awb)
        if len(requested_awbs) >= 400:
            break

    if not requested_awbs:
        return {
            "total": 0,
            "found": 0,
            "refreshed": False,
            "refresh_stats": None,
            "points": [],
        }

    _maps_check_platform_credit(access, requests_count=len(requested_awbs))

    awb_candidates_by_requested: Dict[str, List[str]] = {}
    query_awbs: List[str] = []
    query_seen: set[str] = set()
    for awb in requested_awbs:
        candidates = postis_client.candidates_with_optional_parcel_suffix_stripped(awb) or [awb]
        normalized_candidates: List[str] = []
        for cand in candidates:
            key = postis_client.normalize_shipment_identifier(cand)
            if not key or key in normalized_candidates:
                continue
            normalized_candidates.append(key)
            if key not in query_seen:
                query_seen.add(key)
                query_awbs.append(key)
        awb_candidates_by_requested[awb] = normalized_candidates or [awb]

    rows = db.query(models.Shipment).filter(models.Shipment.awb.in_(query_awbs)).all()
    by_awb: Dict[str, models.Shipment] = {
        str(getattr(s, "awb", "") or "").strip().upper(): s
        for s in rows
        if str(getattr(s, "awb", "") or "").strip()
    }

    points: List[Dict[str, Any]] = []
    missing_awbs: List[str] = []
    for awb in requested_awbs:
        ship = None
        for cand in (awb_candidates_by_requested.get(awb) or [awb]):
            ship = by_awb.get(str(cand or "").strip().upper())
            if ship:
                break
        lat, lon, source = _maps_extract_shipment_coord(ship)
        if lat is None or lon is None:
            missing_awbs.append(awb)
        points.append({
            "awb": awb,
            "lat": lat,
            "lon": lon,
            "source": source,
        })

    refresh_stats: Optional[Dict[str, int]] = None
    refreshed = False
    if request.refresh_missing and missing_awbs:
        # First pull missing shipment details from Postis to ensure we have full addresses for geocoding.
        try:
            enriched_payloads = await _maps_fetch_postis_details_for_awbs(missing_awbs, concurrency=6, limit=len(missing_awbs))
            if enriched_payloads:
                updated = 0
                for payload in enriched_payloads:
                    try:
                        shipments_service.upsert_shipment_and_events(db, payload, store_raw_data=True)
                        db.commit()
                        updated += 1
                    except Exception:
                        logger.warning("maps/geocode-shipments upsert failed for one payload", exc_info=True)
                        db.rollback()
                if updated > 0:
                    rows_after_enrich = db.query(models.Shipment).filter(models.Shipment.awb.in_(query_awbs)).all()
                    by_awb = {
                        str(getattr(s, "awb", "") or "").strip().upper(): s
                        for s in rows_after_enrich
                        if str(getattr(s, "awb", "") or "").strip()
                    }
                    refreshed_points: List[Dict[str, Any]] = []
                    new_missing_awbs: List[str] = []
                    for item in points:
                        awb = str(item.get("awb") or "").strip().upper()
                        ship = None
                        for cand in (awb_candidates_by_requested.get(awb) or [awb]):
                            ship = by_awb.get(str(cand or "").strip().upper())
                            if ship:
                                break
                        lat, lon, source = _maps_extract_shipment_coord(ship)
                        item["lat"] = lat
                        item["lon"] = lon
                        item["source"] = source
                        refreshed_points.append(item)
                        if lat is None or lon is None:
                            new_missing_awbs.append(awb)
                    points = refreshed_points
                    missing_awbs = new_missing_awbs
        except Exception:
            logger.warning("maps/geocode-shipments Postis enrichment failed", exc_info=True)

    if request.refresh_missing and missing_awbs:
        refresh_awbs: List[str] = []
        refresh_seen: set[str] = set()
        for awb in missing_awbs:
            for cand in (awb_candidates_by_requested.get(awb) or [awb]):
                key = str(cand or "").strip().upper()
                if not key or key in refresh_seen:
                    continue
                refresh_seen.add(key)
                refresh_awbs.append(key)
        try:
            refresh_stats = geocoding_service.refresh_shipments_geocoding(
                db,
                awbs=refresh_awbs,
                limit=len(refresh_awbs),
                force_retry=True,
                fast_mode=True,
                google_api_key=maps_api_key,
            )
            refreshed = True
        except Exception:
            logger.warning("maps/geocode-shipments refresh failed", exc_info=True)
            refresh_stats = None

        if refreshed:
            rows_after = db.query(models.Shipment).filter(models.Shipment.awb.in_(refresh_awbs)).all()
            by_awb_after: Dict[str, models.Shipment] = {
                str(getattr(s, "awb", "") or "").strip().upper(): s
                for s in rows_after
                if str(getattr(s, "awb", "") or "").strip()
            }
            for item in points:
                if item.get("lat") is not None and item.get("lon") is not None:
                    continue
                awb = str(item.get("awb") or "").strip().upper()
                ship = by_awb_after.get(awb)
                lat, lon, source = _maps_extract_shipment_coord(ship)
                item["lat"] = lat
                item["lon"] = lon
                item["source"] = source

    # Final safety net: never return missing coordinates.
    # When a shipment is available in DB, persist the fallback so future route renders are instant.
    final_rows = db.query(models.Shipment).filter(models.Shipment.awb.in_(query_awbs)).all()
    by_awb_final: Dict[str, models.Shipment] = {
        str(getattr(s, "awb", "") or "").strip().upper(): s
        for s in final_rows
        if str(getattr(s, "awb", "") or "").strip()
    }

    persisted_fallbacks = 0
    persisted_locality_geocodes = 0
    for item in points:
        if _maps_valid_coord(item.get("lat"), item.get("lon")):
            continue
        awb = str(item.get("awb") or "").strip().upper()
        ship = None
        for cand in (awb_candidates_by_requested.get(awb) or [awb]):
            ship = by_awb_final.get(str(cand or "").strip().upper())
            if ship:
                break

        locality_hint = ""
        county_hint = ""
        if ship is not None:
            recipient_loc = getattr(ship, "recipient_location", None) if isinstance(getattr(ship, "recipient_location", None), dict) else {}
            recipient_pin = getattr(ship, "recipient_pin", None) if isinstance(getattr(ship, "recipient_pin", None), dict) else {}

            for value in (
                getattr(ship, "locality", None),
                recipient_loc.get("localityName") if isinstance(recipient_loc, dict) else None,
                recipient_loc.get("locality") if isinstance(recipient_loc, dict) else None,
                recipient_loc.get("cityName") if isinstance(recipient_loc, dict) else None,
                recipient_loc.get("city") if isinstance(recipient_loc, dict) else None,
                recipient_pin.get("localityName") if isinstance(recipient_pin, dict) else None,
                recipient_pin.get("locality") if isinstance(recipient_pin, dict) else None,
                recipient_pin.get("cityName") if isinstance(recipient_pin, dict) else None,
                recipient_pin.get("city") if isinstance(recipient_pin, dict) else None,
            ):
                text = str(value or "").strip()
                if text:
                    locality_hint = text
                    break

            for value in (
                getattr(ship, "county", None),
                recipient_loc.get("countyName") if isinstance(recipient_loc, dict) else None,
                recipient_loc.get("county") if isinstance(recipient_loc, dict) else None,
                recipient_loc.get("regionName") if isinstance(recipient_loc, dict) else None,
                recipient_loc.get("region") if isinstance(recipient_loc, dict) else None,
                recipient_pin.get("countyName") if isinstance(recipient_pin, dict) else None,
                recipient_pin.get("county") if isinstance(recipient_pin, dict) else None,
                recipient_pin.get("regionName") if isinstance(recipient_pin, dict) else None,
                recipient_pin.get("region") if isinstance(recipient_pin, dict) else None,
            ):
                text = str(value or "").strip()
                if text:
                    county_hint = text
                    break

        locality_query_parts = [locality_hint, county_hint, "Romania"]
        locality_query = ", ".join([p for p in locality_query_parts if str(p or "").strip()])
        if locality_hint and locality_query.strip().lower() != "romania":
            try:
                live_payload = await asyncio.to_thread(
                    geocoding_service.geocode_query_live,
                    locality_query,
                    expected_locality=locality_hint or None,
                    expected_county=county_hint or None,
                    google_api_key=maps_api_key,
                )
                if live_payload:
                    normalized_live = _normalize_ro_coord_pair(
                        live_payload.get("lat") if isinstance(live_payload, dict) else None,
                        live_payload.get("lon") if isinstance(live_payload, dict) else None,
                    )
                    if normalized_live:
                        live_source = str((live_payload.get("provider") if isinstance(live_payload, dict) else None) or "").strip() or "locality-geocode"
                        if live_source in {"google_geocoding", "nominatim"}:
                            live_source = f"{live_source}-locality-center"
                        item["lat"] = float(normalized_live[0])
                        item["lon"] = float(normalized_live[1])
                        item["source"] = live_source

                        if ship is not None and not _maps_valid_coord(getattr(ship, "latitude", None), getattr(ship, "longitude", None)):
                            ship.latitude = float(normalized_live[0])
                            ship.longitude = float(normalized_live[1])
                            ship.geocoded_at = datetime.utcnow()
                            ship.geocode_source = live_source
                            persisted_locality_geocodes += 1
                        continue
            except Exception:
                logger.warning("maps/geocode-shipments locality geocode fallback failed for %s", awb, exc_info=True)

        lat, lon, source = geocoding_service.fallback_coords_for_shipment(
            ship,
            awb_hint=awb,
        )
        item["lat"] = float(lat)
        item["lon"] = float(lon)
        item["source"] = source

        if ship is not None and not _maps_valid_coord(getattr(ship, "latitude", None), getattr(ship, "longitude", None)):
            ship.latitude = float(lat)
            ship.longitude = float(lon)
            ship.geocoded_at = datetime.utcnow()
            ship.geocode_source = source
            persisted_fallbacks += 1

    if (persisted_fallbacks + persisted_locality_geocodes) > 0:
        try:
            db.commit()
        except Exception:
            db.rollback()
            logger.warning("maps/geocode-shipments fallback persist failed", exc_info=True)

    found = 0
    for item in points:
        if _maps_valid_coord(item.get("lat"), item.get("lon")):
            found += 1

    result = {
        "total": len(requested_awbs),
        "found": found,
        "refreshed": refreshed,
        "refresh_stats": refresh_stats,
        "points": points,
    }
    if maps_api_key:
        _maps_record_usage(
            db,
            current_driver=current_driver,
            access=access,
            action="geocode_shipments",
            requests_count=max(1, len(requested_awbs)),
            meta={"total": len(requested_awbs), "found": int(found), "refreshed": bool(refreshed)},
        )
    return result


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


@app.get("/preview.html")
async def read_preview_html():
    preview_path = os.path.join(REPO_ROOT, "preview.html")
    if os.path.isfile(preview_path):
        return FileResponse(preview_path)
    if os.path.isfile(FRONTEND_INDEX_PATH):
        return FileResponse(FRONTEND_INDEX_PATH)
    raise HTTPException(status_code=404, detail="Preview not available")

# Serve static files from the dist directory if it exists
if os.path.isdir(FRONTEND_DIST_DIR):
    app.mount("/assets", StaticFiles(directory=os.path.join(FRONTEND_DIST_DIR, "assets")), name="assets")
    app.mount("/data", StaticFiles(directory=os.path.join(FRONTEND_DIST_DIR, "data")), name="data")

@app.get("/{full_path:path}")
async def catch_all(full_path: str):
    # 1. Try to serve exact file from dist root (logo.png, favicon, sw.js, etc.)
    if os.path.isdir(FRONTEND_DIST_DIR):
        candidate = os.path.join(FRONTEND_DIST_DIR, full_path.lstrip("/"))
        if os.path.isfile(candidate):
            return FileResponse(candidate)
    
    # 2. Try the root logo/preview if explicitly requested and missing from dist
    if full_path == "logo.png":
        root_logo = os.path.join(REPO_ROOT, "logo.png")
        if os.path.isfile(root_logo):
            return FileResponse(root_logo)
            
    # 3. Fallback to index.html for SPA routing (this handles /dashboard, /history, etc.)
    if os.path.isfile(FRONTEND_INDEX_PATH):
        return FileResponse(FRONTEND_INDEX_PATH)
        
    raise HTTPException(status_code=404, detail="Not found")

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
