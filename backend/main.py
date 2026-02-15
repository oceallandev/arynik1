from fastapi import FastAPI, Depends, HTTPException, status, APIRouter, Response
from fastapi.responses import StreamingResponse, FileResponse
from fastapi.security import OAuth2PasswordBearer, OAuth2PasswordRequestForm
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy.orm import Session
from datetime import datetime, timedelta
import jwt
import os
import logging
from typing import List, Set
from dotenv import load_dotenv
import asyncio

# Load environment variables from the backend directory
env_path = os.path.join(os.path.dirname(__file__), '.env')
load_dotenv(dotenv_path=env_path, override=True)

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))

# Support running as a package (`uvicorn backend.main:app` from repo root)
# and as a module file (`uvicorn main:app` from within `backend/`).
try:
    from . import models, schemas, database, postis_client, driver_manager, authz
    from .services import routing_service, ro_localities_service # [NEW]
except ImportError:  # pragma: no cover
    import models, schemas, database, postis_client, driver_manager, authz
    from services import routing_service, ro_localities_service # [NEW]

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

def _ensure_status_options(db: Session):
    # Postis status options as provided by the user (eventId -> eventDescription).
    desired = [
        {"event_id": "1", "label": "Expediere preluata de Curier", "description": "Expediere preluata de Curier"},
        {"event_id": "2", "label": "Expeditie Livrata", "description": "Expeditie Livrata"},
        {"event_id": "3", "label": "Refuzare colet", "description": "Refuzare colet"},
        {"event_id": "4", "label": "Expeditie returnata", "description": "Expeditie returnata"},
        {"event_id": "5", "label": "Expeditie anulata", "description": "Expeditie anulata"},
        {"event_id": "6", "label": "Intrare in depozit", "description": "Intrare in depozit"},
        {"event_id": "7", "label": "Livrare reprogramata", "description": "Livrare reprogramata"},
        {"event_id": "R3", "label": "Ramburs transferat", "description": "Ramburs transferat"},
    ]

    desired_ids = {opt["event_id"] for opt in desired}
    existing = {opt.event_id: opt for opt in db.query(models.StatusOption).all()}

    changed = False
    for spec in desired:
        event_id = spec["event_id"]
        opt = existing.get(event_id)
        if opt:
            if opt.label != spec["label"] or opt.description != spec["description"]:
                opt.label = spec["label"]
                opt.description = spec["description"]
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
    driver = db.query(models.Driver).filter(models.Driver.username == form_data.username).first()
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
        "last_login": current_driver.last_login,
        "permissions": _permissions_for_role(role),
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
    )
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

    db.commit()
    db.refresh(driver)
    return driver

@app.get("/status-options", response_model=List[schemas.StatusOptionSchema])
async def get_status_options(
    db: Session = Depends(database.get_db),
    current_driver: models.Driver = Depends(permission_required(authz.PERM_STATUS_OPTIONS_READ)),
):
    return _ensure_status_options(db)

@app.on_event("startup")
async def startup_event():
    # Keep startup fast and robust. Driver sync can be slow / network-dependent.
    db = database.SessionLocal()
    try:
        _ensure_status_options(db)
    except Exception as e:
        logger.error(f"Status options seed failed on startup: {str(e)}")
    finally:
        db.close()

    auto_sync = os.getenv("AUTO_SYNC_DRIVERS_ON_STARTUP", "").strip().lower() in ("1", "true", "yes", "on")
    if not auto_sync:
        logger.info("AUTO_SYNC_DRIVERS_ON_STARTUP not enabled; skipping driver sync on startup")
        return

    sheet_url = os.getenv("GOOGLE_SHEETS_URL")
    if not sheet_url:
        logger.warning("GOOGLE_SHEETS_URL not set; cannot sync drivers on startup")
        return

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

@app.get("/logs", response_model=List[schemas.LogEntrySchema])
async def get_logs(
    awb: str = None, 
    start_date: str = None, 
    end_date: str = None, 
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
            
    return query.order_by(models.LogEntry.timestamp.desc()).limit(100).all()

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
        # RBAC: Filter by driver_id if rule is Driver
        role = authz.normalize_role(current_driver.role)
        query = db.query(models.Shipment)
        
        if role == authz.ROLE_DRIVER:
            query = query.filter(models.Shipment.driver_id == current_driver.driver_id)
            
        shipments = query.all()
        
        results = []
        for ship in shipments:
            results.append({
                "awb": ship.awb,
                "status": ship.status or "pending",
                "recipient_name": ship.recipient_name or "Unknown",
                "recipient_phone": ship.recipient_phone,
                "recipient_email": ship.recipient_email,
                "delivery_address": ship.delivery_address or "",
                "locality": ship.locality or "",
                "latitude": ship.latitude,
                "longitude": ship.longitude,
                "weight": ship.weight or 0.0,
                "volumetric_weight": ship.volumetric_weight or 0.0,
                "dimensions": ship.dimensions or "",
                "content_description": ship.content_description or "",
                "cod_amount": ship.cod_amount or 0.0,
                "delivery_instructions": ship.delivery_instructions or "",
                "driver_id": ship.driver_id,
                "last_updated": ship.last_updated.isoformat() if ship.last_updated else None,
                "tracking_history": [],  # Can be populated from events if needed
                # Keep list payload light, but include enough nested data for map fallbacks.
                "raw_data": {
                    "recipientLocation": ship.recipient_location,
                    "senderLocation": ship.sender_location,
                    "courier": ship.courier_data,
                    "additionalServices": ship.additional_services,
                    "productCategory": ship.product_category_data,
                    "clientShipmentStatus": ship.client_shipment_status_data,
                }
            })
        
        logger.info(f"Returning {len(results)} shipments from database")
        return results
    
    except Exception as e:
        logger.error(f"Error fetching shipments from database: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Failed to fetch shipments: {str(e)}")

@app.get("/shipments/{awb}", response_model=schemas.ShipmentSchema)
async def get_shipment(
    awb: str,
    current_driver: models.Driver = Depends(permission_required(authz.PERM_SHIPMENT_READ)),
):
    try:
        data = await p_client.get_shipment_tracking_by_awb_or_client_order_id(awb)
        if not data:
            raise HTTPException(status_code=404, detail="Shipment not found")

        trace = data.get('shipmentTrace') or data.get('traceHistory') or data.get('tracking') or []
        history = trace if isinstance(trace, list) else []
        history = sorted(
            history,
            key=lambda ev: (ev.get('eventDate') or ev.get('createdDate') or ""),
            reverse=True
        )
        status_text = "Unknown"
        if history:
            status_text = (
                history[0].get('eventDescription')
                or (history[0].get('courierShipmentStatus') or {}).get('statusDescription')
                or 'No Status'
            )

        recipient_info = data.get('recipientLocation') or data.get('recipient', {})
        courier = data.get('courier', {})
        carrier_info = f"{courier.get('id', '')} {courier.get('name', '')}".strip() or data.get('courierName')

        vol_weight = data.get('volumetricWeight')
        dims = ""
        if not vol_weight:
            l = data.get('length', 0)
            w = data.get('width', 0)
            h = data.get('height', 0)
            if l and w and h:
                vol_weight = (l * w * h) / 5000.0
                dims = f"{l}x{w}x{h} cm"
            else:
                dims = data.get('dimensions', "")

        return schemas.ShipmentSchema(
            awb=awb,
            status=status_text,
            recipient_name=recipient_info.get('name', 'Recipient'),
            delivery_address=recipient_info.get('addressText') or recipient_info.get('address', 'N/A'),
            created_at=data.get('createdDate') or datetime.utcnow(),
            weight=data.get('brutWeight', 0.0),
            tracking_history=history,
            recipient_phone=recipient_info.get('phoneNumber') or recipient_info.get('phone'),
            carrier=carrier_info,
            return_awb=data.get('returnAwb'),
            created_by=data.get('createdBy'),
            sales_channel=data.get('sourceChannel'),
            delivery_method=data.get('productCategory', {}).get('name') if isinstance(data.get('productCategory'), dict) else data.get('productCategory'),
            shipment_type=data.get('sendType'),
            cash_on_delivery=data.get('cashOnDelivery', 0.0),
            estimated_shipping_cost=data.get('estimatedShippingCost', 0.0),
            carrier_shipping_cost=data.get('shippingCost', 0.0),
            shipping_instruction=data.get('shippingInstruction'),
            payment_type=data.get('paymentType'),
            pickup_date=data.get('pickupDate'),
            last_modified_date=data.get('lastModifiedDate'),
            last_modified_by=data.get('lastModifiedBy'),
            packing_list=data.get('packingList'),
            processing_status=data.get('processingStatus'),
            options=data.get('options'),
            shipment_payer=data.get('shipmentPayer'),
            courier_pickup_id=data.get('courierOrderPickupId'),
            pin_code=data.get('deliveryPinCode'),
            volumetric_weight=vol_weight,
            dimensions=dims,
            raw_data=data,
        )
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error in get_shipment({awb}): {str(e)}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))

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
    manager = driver_manager.DriverManager(sheet_url)
    manager.sync_drivers(db)
    return {"status": "synced"}

@app.post("/update-location")
async def update_location(
    location: schemas.LocationUpdate,
    db: Session = Depends(database.get_db),
    current_driver: models.Driver = Depends(get_current_driver)
):
    """
    Update driver's current location and save to history.
    """
    # Create history entry
    loc_entry = models.DriverLocation(
        driver_id=current_driver.driver_id,
        latitude=location.latitude,
        longitude=location.longitude,
        timestamp=datetime.utcnow()
    )
    db.add(loc_entry)
    db.commit()
    return {"status": "updated", "timestamp": loc_entry.timestamp}

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
