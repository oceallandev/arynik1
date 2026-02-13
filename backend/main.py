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

# Load environment variables from the backend directory
env_path = os.path.join(os.path.dirname(__file__), '.env')
load_dotenv(dotenv_path=env_path, override=True)

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))

from . import models, schemas, database, postis_client, driver_manager, authz

# Setup logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Config
SECRET_KEY = os.getenv("JWT_SECRET", "supersecretkey")
ALGORITHM = "HS256"
ACCESS_TOKEN_EXPIRE_MINUTES = 60 * 24 # 1 day

POSTIS_BASE_URL = os.getenv("POSTIS_BASE_URL", "https://api.postisgate.com")
POSTIS_USER = os.getenv("POSTIS_USERNAME")
POSTIS_PASS = os.getenv("POSTIS_PASSWORD")

# Create tables
models.Base.metadata.create_all(bind=database.engine)

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
    options = db.query(models.StatusOption).all()
    # Seed default options if empty for demo
    if not options:
        defaults = [
            {"event_id": "DELIVERED", "label": "Delivered", "description": "Package has been delivered to recipient"},
            {"event_id": "REFUSED", "label": "Refused", "description": "Recipient refused the package"},
            {"event_id": "NOT_HOME", "label": "Not Home", "description": "Recipient was not at home"},
            {"event_id": "WRONG_ADDRESS", "label": "Wrong Address", "description": "Address is incorrect or incomplete"}
        ]
        for opt in defaults:
            db_opt = models.StatusOption(**opt)
            db.add(db_opt)
        db.commit()
        options = db.query(models.StatusOption).all()
    return options

@app.on_event("startup")
async def startup_event():
    # Automatic update to bring fresh data every time the app is used/started
    logger.info("Starting automatic data sync on app startup...")
    db = database.SessionLocal()
    try:
        sheet_url = os.getenv("GOOGLE_SHEETS_URL")
        logger.info(f"Startup sync using URL: {sheet_url}")
        if sheet_url:
            manager = driver_manager.DriverManager(sheet_url)
            manager.sync_drivers(db)
            logger.info("Drivers synced successfully on startup")
        else:
            logger.warning("GOOGLE_SHEETS_URL not set, skipping driver sync")
            
        # Seed or refresh status options if needed
        await get_status_options(db, None) # None for driver as we just want the seeding logic
    except Exception as e:
        logger.error(f"Startup sync failed: {str(e)}")
    finally:
        db.close()

@app.post("/update-awb")
async def update_awb(
    request: schemas.AWBUpdateRequest,
    db: Session = Depends(database.get_db),
    current_driver: models.Driver = Depends(permission_required(authz.PERM_AWB_UPDATE)),
):
    # Idempotency check: awb + eventId + driver + timestamp
    timestamp = request.timestamp or datetime.utcnow()
    idempotency_key = f"{request.awb}:{request.event_id}:{current_driver.driver_id}:{timestamp.isoformat()}"
    
    existing_log = db.query(models.LogEntry).filter(models.LogEntry.idempotency_key == idempotency_key).first()
    if existing_log:
        return {"status": "already_processed", "outcome": existing_log.outcome, "reference": existing_log.postis_reference}

    log_entry = models.LogEntry(
        driver_id=current_driver.driver_id,
        timestamp=timestamp,
        awb=request.awb,
        event_id=request.event_id,
        payload=request.payload,
        idempotency_key=idempotency_key
    )

    try:
        # Prepare metadata for Postis per verified spec
        details = {
            "eventDate": timestamp.strftime("%Y-%m-%d %H:%M:%S"),
            "eventDescription": f"Status updated to {request.event_id} by {current_driver.name}",
            "localityName": request.payload.get("locality", "Unknown") if request.payload else "Unknown",
            "driverName": current_driver.name,
            "driverPhoneNumber": "", # Could be added to Driver model
            "truckNumber": "" # Could be added to Driver model
        }
        
        response = await p_client.update_awb_status(request.awb, request.event_id, details)
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
async def get_shipments(current_driver: models.Driver = Depends(permission_required(authz.PERM_SHIPMENTS_READ))):
    try:
        results = []
        import asyncio
        
        # Try fetching from PostisGate first for "Real Data"
        postis_shipments = await p_client.get_shipments(limit=50)
        
        # Optional: keep sheet support behind a feature flag. For production/live Postis data,
        # we default to Postis as the source of truth.
        use_sheet_shipments = os.getenv("USE_SHEET_SHIPMENTS", "").lower() in ("1", "true", "yes")
        sheet_url = os.getenv("GOOGLE_SHEETS_URL")
        sheet_shipments = []
        if use_sheet_shipments and sheet_url:
            from .shipment_manager import ShipmentManager
            manager = ShipmentManager(sheet_url)
            sheet_shipments = manager.fetch_shipments_from_sheet()
            # Merge logic: prioritize sheet as master list but enrich with Postis info
            # Or if sheet empty, use Postis list
        
        # If we have sheet shipments, we use them as the master list
        if sheet_shipments:
            async def fetch_status(s):
                tracking_data = await p_client.get_shipment_tracking(s['awb_code'])
                status = "Unknown"
                history = []
                weight = 0.0
                recipient_info = {}
                
                # Additional fields from detailed tracking data
                carrier_info = ""
                return_awb = None
                created_by = None
                sales_channel = None
                delivery_method = None
                shipment_type = None
                cod = 0.0
                est_cost = 0.0
                carrier_cost = 0.0
                instr = None
                pay_type = None
                p_date = None
                lm_date = None
                lm_by = None
                pk_list = None
                proc_status = None
                opts = None
                payer = None
                p_id = None
                pin = None
                vol_weight = 0.0
                dims = ""

                if tracking_data:
                    trace = tracking_data.get('shipmentTrace') or tracking_data.get('traceHistory') or []
                    history = trace if isinstance(trace, list) else []
                    history = sorted(
                        history,
                        key=lambda ev: (ev.get('eventDate') or ev.get('createdDate') or ""),
                        reverse=True
                    )
                    if history:
                        status = (
                            history[0].get('eventDescription')
                            or (history[0].get('courierShipmentStatus') or {}).get('statusDescription')
                            or 'No Status'
                        )

                    weight = tracking_data.get('brutWeight', 0.0)
                    recipient_info = tracking_data.get('recipientLocation', {})

                    courier = tracking_data.get('courier', {})
                    carrier_info = f"{courier.get('id', '')} {courier.get('name', '')}".strip()
                    return_awb = tracking_data.get('returnAwb')
                    created_by = tracking_data.get('createdBy')
                    sales_channel = tracking_data.get('sourceChannel')
                    product_category = tracking_data.get('productCategory')
                    delivery_method = product_category.get('name') if isinstance(product_category, dict) else product_category
                    shipment_type = tracking_data.get('sendType')
                    cod = tracking_data.get('cashOnDelivery', 0.0)
                    est_cost = tracking_data.get('estimatedShippingCost', 0.0)
                    carrier_cost = tracking_data.get('shippingCost', 0.0)
                    instr = tracking_data.get('shippingInstruction')
                    pay_type = tracking_data.get('paymentType')
                    p_date = tracking_data.get('pickupDate')
                    lm_date = tracking_data.get('lastModifiedDate')
                    lm_by = tracking_data.get('lastModifiedBy')
                    pk_list = tracking_data.get('packingList')
                    proc_status = tracking_data.get('processingStatus')
                    opts = tracking_data.get('options')
                    payer = tracking_data.get('shipmentPayer')
                    p_id = tracking_data.get('courierOrderPickupId')
                    pin = tracking_data.get('deliveryPinCode')
                    
                    # Extract dimensions and volumetric weight
                    vol_weight = tracking_data.get('volumetricWeight')
                    if not vol_weight:
                        # Fallback calculation if dimensions are present
                        l = tracking_data.get('length', 0)
                        w = tracking_data.get('width', 0)
                        h = tracking_data.get('height', 0)
                        if l and w and h:
                            vol_weight = (l * w * h) / 5000.0
                            dims = f"{l}x{w}x{h} cm"
                        else:
                            # Check if explicitly in 'dimensions' field if it exists in raw
                            dims = tracking_data.get('dimensions', "")
                
                return schemas.ShipmentSchema(
                    awb=s['awb'],
                    status=status,
                    recipient_name=recipient_info.get('name') or s.get('description') or 'Individual Recipient',
                    delivery_address=recipient_info.get('addressText') or "Pending Delivery",
                    created_at=datetime.utcnow(),
                    weight=weight,
                    tracking_history=history,
                    recipient_phone=recipient_info.get('phoneNumber'),
                    carrier=carrier_info,
                    return_awb=return_awb,
                    created_by=created_by,
                    sales_channel=sales_channel,
                    delivery_method=delivery_method,
                    shipment_type=shipment_type,
                    cash_on_delivery=cod,
                    estimated_shipping_cost=est_cost,
                    carrier_shipping_cost=carrier_cost,
                    shipping_instruction=instr,
                    payment_type=pay_type,
                    pickup_date=p_date,
                    last_modified_date=lm_date,
                    last_modified_by=lm_by,
                    packing_list=pk_list,
                    processing_status=proc_status,
                    options=opts,
                    shipment_payer=payer,
                    courier_pickup_id=p_id,
                    pin_code=pin,
                    volumetric_weight=vol_weight,
                    dimensions=dims,
                    raw_data=tracking_data
                )

            tasks = [fetch_status(s) for s in sheet_shipments[:100]]
            results = await asyncio.gather(*tasks)
        elif postis_shipments:
            # No sheet, use PostisGate list directly
            async def fetch_full_and_map(ps):
                awb = ps.get('awb') or ps.get('clientOrderId')
                full_data = await p_client.get_shipment_tracking(awb)
                
                # Map full_data or ps as fallback
                data = full_data if full_data else ps
                
                trace = data.get('shipmentTrace') or data.get('traceHistory') or data.get('tracking') or []
                history = trace if isinstance(trace, list) else []
                history = sorted(
                    history,
                    key=lambda ev: (ev.get('eventDate') or ev.get('createdDate') or ""),
                    reverse=True
                )
                status = "Unknown"
                if history:
                    status = (
                        history[0].get('eventDescription')
                        or (history[0].get('courierShipmentStatus') or {}).get('statusDescription')
                        or 'No Status'
                    )
                
                recipient_info = data.get('recipientLocation') or data.get('recipient', {})
                courier = data.get('courier', {})
                carrier_info = f"{courier.get('id', '')} {courier.get('name', '')}".strip() or data.get('courierName')

                # Extract dimensions and volumetric weight
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
                    awb=awb or 'N/A',
                    status=status,
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
                    raw_data=data
                )

            tasks = [fetch_full_and_map(ps) for ps in postis_shipments[:50]]
            results = await asyncio.gather(*tasks)
        
        return results

    except Exception as e:
        logger.error(f"Error in get_shipments: {str(e)}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/shipments/{awb}", response_model=schemas.ShipmentSchema)
async def get_shipment(
    awb: str,
    current_driver: models.Driver = Depends(permission_required(authz.PERM_SHIPMENT_READ)),
):
    try:
        data = await p_client.get_shipment_tracking(awb)
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
            
        result = await p_client.update_awb_status(request.awb, request.event_id, details)
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
