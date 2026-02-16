from fastapi import FastAPI, Depends, HTTPException, status, APIRouter, Response
from fastapi.responses import StreamingResponse, FileResponse
from fastapi.security import OAuth2PasswordBearer, OAuth2PasswordRequestForm
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy.orm import Session
from datetime import datetime, timedelta
from dataclasses import replace
import jwt
import os
import logging
import secrets
import sys
from typing import List, Set, Optional
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
        notifications_service,
        whatsapp_service,
        phone_service,
        tracking_service,
        chat_service,
        postis_sync_service,
        manifests_service,
        contacts_service,
        route_runs_service,
        cod_service,
    )
except ImportError:  # pragma: no cover
    import models, schemas, database, postis_client, driver_manager, authz, postis_statuses
    from services import (
        routing_service,
        ro_localities_service,
        shipments_service,
        drivers_service,
        notifications_service,
        whatsapp_service,
        phone_service,
        tracking_service,
        chat_service,
        postis_sync_service,
        manifests_service,
        contacts_service,
        route_runs_service,
        cod_service,
    )

# Setup logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Config
SECRET_KEY = os.getenv("JWT_SECRET", "supersecretkey")
ALGORITHM = "HS256"
ACCESS_TOKEN_EXPIRE_MINUTES = 60 * 24 # 1 day

POSTIS_BASE_URL = os.getenv("POSTIS_BASE_URL", "https://shipments.postisgate.com")
POSTIS_USER = os.getenv("POSTIS_USERNAME")
POSTIS_PASS = os.getenv("POSTIS_PASSWORD")

# Create tables
# models.Base.metadata.create_all(bind=database.engine)

app = FastAPI(title="Postis Shipment Update API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

oauth2_scheme = OAuth2PasswordBearer(tokenUrl="login")
p_client = postis_client.PostisClient(POSTIS_BASE_URL, POSTIS_USER, POSTIS_PASS)

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
    # Keep deterministic ordering: 1..7 then R3.
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
    driver.last_login = datetime.utcnow()
    db.commit()
    return {"access_token": access_token, "token_type": "bearer", "role": driver.role}


def _find_shipment_by_awb(db: Session, awb: str) -> Optional[models.Shipment]:
    candidates = postis_client.candidates_with_optional_parcel_suffix_stripped(awb)
    for cand in candidates:
        ship = db.query(models.Shipment).filter(models.Shipment.awb == cand).first()
        if ship:
            return ship
    return None


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

    # Recipients see only their conversations.
    if role == authz.ROLE_RECIPIENT:
        q = (
            q.join(models.ChatParticipant, models.ChatParticipant.thread_id == models.ChatThread.id)
            .filter(models.ChatParticipant.user_id == current_driver.driver_id)
        )

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
        last_msg = (
            db.query(models.ChatMessage)
            .filter(models.ChatMessage.thread_id == t.id)
            .order_by(models.ChatMessage.id.desc())
            .first()
        )
        part = (
            db.query(models.ChatParticipant)
            .filter(models.ChatParticipant.thread_id == t.id, models.ChatParticipant.user_id == current_driver.driver_id)
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
    return items


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
    phone_norm = current_driver.phone_norm or phone_service.normalize_phone(current_driver.phone_number or "")
    ship_phone_norm = ship.recipient_phone_norm or phone_service.normalize_phone(ship.recipient_phone or "")
    if phone_norm and current_driver.phone_norm != phone_norm:
        current_driver.phone_norm = phone_norm
        db.commit()
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
        status="Pending",
        duration_sec=duration_sec,
        expires_at=now + timedelta(seconds=duration_sec),
        accepted_at=None,
        denied_at=None,
        stopped_at=None,
        last_location_at=None,
    )
    db.add(req)
    db.commit()
    db.refresh(req)

    # Best-effort in-app notification for the driver.
    who = str(current_driver.name or current_driver.username or current_driver.driver_id or "Admin").strip()
    title = "Location request"
    body = f"{who} requested your live location"
    if awb:
        body += f" (AWB {awb})."
    else:
        body += "."
    notifications_service.create_notification(
        db,
        user_id=target.driver_id,
        title=title,
        body=body,
        awb=awb,
        data={
            "type": "tracking_request",
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
    return (
        db.query(models.TrackingRequest)
        .filter(models.TrackingRequest.target_driver_id == current_driver.driver_id)
        .filter(models.TrackingRequest.status == "Accepted")
        .filter(models.TrackingRequest.stopped_at.is_(None))
        .filter(models.TrackingRequest.expires_at.isnot(None), models.TrackingRequest.expires_at > now)
        .order_by(models.TrackingRequest.accepted_at.desc())
        .limit(limit_n)
        .all()
    )


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
        authz.ROLE_ADMIN: "Full access (users, drivers sync, shipments, labels, logs).",
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


@app.get("/users", response_model=List[schemas.Driver])
async def list_users(
    db: Session = Depends(database.get_db),
    current_driver: models.Driver = Depends(permission_required(authz.PERM_USERS_READ)),
):
    return db.query(models.Driver).order_by(models.Driver.driver_id.asc()).all()


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

    driver = db.query(models.Driver).filter(models.Driver.driver_id == driver_id).first()
    if not driver:
        raise HTTPException(status_code=404, detail="User not found")

    if request.name is not None:
        driver.name = request.name

    if request.username is not None:
        existing = (
            db.query(models.Driver)
            .filter(models.Driver.username == request.username, models.Driver.driver_id != driver_id)
            .first()
        )
        if existing:
            raise HTTPException(status_code=409, detail="username already exists")
        driver.username = request.username

    if request.password is not None:
        driver.password_hash = driver_manager.get_password_hash(request.password)

    if request.role is not None:
        role = authz.normalize_role(request.role)
        if role not in authz.VALID_ROLES:
            raise HTTPException(
                status_code=400,
                detail=f"Invalid role. Valid roles: {', '.join(sorted(authz.VALID_ROLES))}",
            )
        driver.role = role

    if request.active is not None:
        driver.active = request.active

    if request.truck_plate is not None:
        truck_plate = str(request.truck_plate or "").strip().upper()
        driver.truck_plate = truck_plate or None

    if request.phone_number is not None:
        phone_number = str(request.phone_number or "").strip()
        driver.phone_number = phone_number or None
        try:
            phone_norm = phone_service.normalize_phone(phone_number)
            driver.phone_norm = phone_norm or None
        except Exception:
            driver.phone_norm = None

    if request.helper_name is not None:
        helper_name = str(request.helper_name or "").strip()
        driver.helper_name = helper_name or None

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
    # Keep startup fast and robust. Driver sync can be slow / network-dependent.
    db = database.SessionLocal()
    try:
        drivers_service.ensure_drivers_schema(db)
        shipments_service.ensure_shipments_schema(db)
        notifications_service.ensure_notifications_schema(db)
        contacts_service.ensure_contacts_schema(db)
        manifests_service.ensure_manifests_schema(db)
        route_runs_service.ensure_route_runs_schema(db)
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

    auto_sync = os.getenv("AUTO_SYNC_DRIVERS_ON_STARTUP", "").strip().lower() in ("1", "true", "yes", "on")
    if not auto_sync:
        logger.info("AUTO_SYNC_DRIVERS_ON_STARTUP not enabled; skipping driver sync on startup")
    else:
        sheet_url = os.getenv("GOOGLE_SHEETS_URL")
        if not sheet_url:
            logger.warning("GOOGLE_SHEETS_URL not set; cannot sync drivers on startup")
        else:
            logger.info(f"Starting driver sync on startup from: {sheet_url}")

            def _sync_drivers_in_thread():
                db2 = database.SessionLocal()
                try:
                    manager = driver_manager.DriverManager(sheet_url)
                    manager.sync_drivers(db2)
                finally:
                    db2.close()

            try:
                await asyncio.to_thread(_sync_drivers_in_thread)
                logger.info("Drivers synced successfully on startup")
            except Exception as e:
                logger.error(f"Driver sync failed on startup: {str(e)}")

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


@app.on_event("shutdown")
async def shutdown_event():
    task = getattr(app.state, "postis_sync_task", None)
    if not task:
        return
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

    # Idempotency check: awb + eventId + driver + timestamp
    timestamp = request.timestamp or datetime.utcnow()
    idempotency_key = f"{identifier}:{request.event_id}:{current_driver.driver_id}:{timestamp.isoformat()}"
    
    existing_log = db.query(models.LogEntry).filter(models.LogEntry.idempotency_key == idempotency_key).first()
    if existing_log:
        return {"status": "already_processed", "outcome": existing_log.outcome, "reference": existing_log.postis_reference}

    log_entry = models.LogEntry(
        driver_id=current_driver.driver_id,
        timestamp=timestamp,
        awb=identifier,
        event_id=request.event_id,
        payload=request.payload,
        idempotency_key=idempotency_key
    )

    try:
        opt = db.query(models.StatusOption).filter(models.StatusOption.event_id == request.event_id).first()
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
                ship.status = _EVENT_TO_STATUS.get(str(request.event_id), ship.status or event_description)
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

        db.add(log_entry)
        db.commit()
        return {"status": "ok", "outcome": "SUCCESS", "reference": log_entry.postis_reference}
    except Exception as e:
        log_entry.outcome = "FAILED"
        log_entry.error_message = str(e)
        db.add(log_entry)
        db.commit()
        raise HTTPException(status_code=500, detail=f"Postis update failed: {str(e)}")

@app.get("/stats")
async def get_stats(
    db: Session = Depends(database.get_db),
    current_driver: models.Driver = Depends(permission_required(authz.PERM_STATS_READ)),
):
    today = datetime.utcnow().date()
    # Today's successful syncs
    today_syncs = db.query(models.LogEntry).filter(
        models.LogEntry.driver_id == current_driver.driver_id,
        models.LogEntry.outcome == "SUCCESS",
        models.LogEntry.timestamp >= datetime.combine(today, datetime.min.time())
    ).count()
    
    # Total successful syncs
    total_syncs = db.query(models.LogEntry).filter(
        models.LogEntry.driver_id == current_driver.driver_id,
        models.LogEntry.outcome == "SUCCESS"
    ).count()
    
    return {
        "today_count": today_syncs,
        "total_count": total_syncs,
        "driver_name": current_driver.name,
        "last_sync": datetime.utcnow()
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

        status_txt = str(status or "").strip() or "Unknown"
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
            query = query.filter(models.Shipment.driver_id == current_driver.driver_id)
        elif role == authz.ROLE_RECIPIENT:
            # Recipients can only see shipments where they are the recipient (phone match).
            phone_norm = current_driver.phone_norm or phone_service.normalize_phone(current_driver.phone_number or "")
            if phone_norm and current_driver.phone_norm != phone_norm:
                current_driver.phone_norm = phone_norm
                db.commit()

            if phone_norm:
                query = query.filter(models.Shipment.recipient_phone_norm == phone_norm)
            else:
                query = query.filter(models.Shipment.id == -1)
            
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
        ship = None
        for cand in candidates:
            ship = db.query(models.Shipment).filter(models.Shipment.awb == cand).first()
            if ship:
                break

        if ship and not refresh:
            if role == authz.ROLE_RECIPIENT:
                phone_norm = current_driver.phone_norm or phone_service.normalize_phone(current_driver.phone_number or "")
                ship_phone_norm = ship.recipient_phone_norm or phone_service.normalize_phone(ship.recipient_phone or "")
                if not phone_norm or not ship_phone_norm or ship_phone_norm != phone_norm:
                    raise HTTPException(status_code=403, detail="Not enough permissions")
            return shipments_service.shipment_to_dict(ship, include_raw_data=True, include_events=True, db=db)

        data = await p_client.get_shipment_tracking_by_awb_or_client_order_id(awb)
        if not data:
            raise HTTPException(status_code=404, detail="Shipment not found")

        ship = shipments_service.upsert_shipment_and_events(db, data)
        db.commit()
        if role == authz.ROLE_RECIPIENT:
            phone_norm = current_driver.phone_norm or phone_service.normalize_phone(current_driver.phone_number or "")
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

@app.get("/shipments/{awb}/label")
async def get_shipment_label(
    awb: str,
    current_driver: models.Driver = Depends(permission_required(authz.PERM_LABEL_READ)),
):
    label_bytes = await p_client.get_shipment_label(awb)
    if not label_bytes:
        raise HTTPException(status_code=404, detail="Label not found")
    return Response(
        content=label_bytes,
        media_type="application/pdf",
        headers={
            "Content-Disposition": f'inline; filename="label_{awb}.pdf"'
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
    identifier = postis_client.normalize_shipment_identifier(awb) or awb
    key = str(identifier or "").strip().upper()
    if not key:
        raise HTTPException(status_code=400, detail="awb is required")

    q = (
        db.query(models.LogEntry)
        .filter(models.LogEntry.awb == key, models.LogEntry.event_id == "2", models.LogEntry.outcome == "SUCCESS")
        .order_by(models.LogEntry.timestamp.desc())
    )
    log = q.first()
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
        ship.delivery_instructions = None
    else:
        ship.delivery_instructions = instructions[:2000]
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

    return {"status": "ok", "awb": ship.awb, "delivery_instructions": ship.delivery_instructions}


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
    current_driver: models.Driver = Depends(permission_required(authz.PERM_AWB_UPDATE))
):
    try:
        # Standard locality for driver app updates
        details = {
            "localityName": "Driver App Location",
            "driverName": current_driver.name,
            "eventDate": datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S")
        }
        
        # Merge extra payload if provided
        if request.payload:
            details.update(request.payload)
            
        identifier = postis_client.normalize_shipment_identifier(request.awb)
        result = await p_client.update_status_by_awb_or_client_order_id(identifier, request.event_id, details)
        return {"status": "success", "postis_response": result}
    except Exception as e:
        logger.error(f"Status update failed for {request.awb}: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/sync-drivers")
async def sync_drivers(
    db: Session = Depends(database.get_db),
    current_driver: models.Driver = Depends(permission_required(authz.PERM_DRIVERS_SYNC)),
):
    sheet_url = os.getenv("GOOGLE_SHEETS_URL")
    if not sheet_url:
        raise HTTPException(status_code=400, detail="GOOGLE_SHEETS_URL not configured")
    logger.info(f"Syncing drivers from: {sheet_url}")
    drivers_service.ensure_drivers_schema(db)
    manager = driver_manager.DriverManager(sheet_url)
    try:
        manager.sync_drivers(db)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Driver sync failed: {str(e)}")
    return {"status": "synced"}


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

    out = []
    for d in drivers:
        did = str(d.driver_id or "").strip()
        if not did:
            continue
        loc = (
            db.query(models.DriverLocation)
            .filter(models.DriverLocation.driver_id == did)
            .order_by(models.DriverLocation.timestamp.desc())
            .first()
        )
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
