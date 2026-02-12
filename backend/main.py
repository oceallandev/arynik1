from fastapi import FastAPI, Depends, HTTPException, status, APIRouter
from fastapi.security import OAuth2PasswordBearer, OAuth2PasswordRequestForm
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy.orm import Session
from datetime import datetime, timedelta
import jwt
import os
import logging
from typing import List

from . import models, schemas, database, postis_client, driver_manager

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
    allow_credentials=True,
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
        if current_driver.role not in allowed_roles:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Not enough permissions"
            )
        return current_driver
    return role_checker

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
    
    access_token = create_access_token(data={
        "sub": driver.username, 
        "driver_id": driver.driver_id,
        "role": driver.role
    })
    driver.last_login = datetime.utcnow()
    db.commit()
    return {"access_token": access_token, "token_type": "bearer", "role": driver.role}

@app.get("/status-options", response_model=List[schemas.StatusOptionSchema])
async def get_status_options(db: Session = Depends(database.get_db), current_driver: models.Driver = Depends(get_current_driver)):
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
async def update_awb(request: schemas.AWBUpdateRequest, db: Session = Depends(database.get_db), current_driver: models.Driver = Depends(get_current_driver)):
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

@app.get("/logs", response_model=List[schemas.LogEntrySchema])
async def get_logs(awb: str = None, driver_id: str = None, db: Session = Depends(database.get_db), current_driver: models.Driver = Depends(role_required(["Admin"]))):
    # Basic admin check could be added here if roles were more developed
    query = db.query(models.LogEntry)
    if awb:
        query = query.filter(models.LogEntry.awb == awb)
    if driver_id:
        query = query.filter(models.LogEntry.driver_id == driver_id)
    return query.order_by(models.LogEntry.timestamp.desc()).limit(100).all()

@app.get("/shipments", response_model=List[schemas.ShipmentSchema])
async def get_shipments(current_driver: models.Driver = Depends(role_required(["Manager", "Admin"]))):
    sheet_url = os.getenv("GOOGLE_SHEETS_URL")
    if not sheet_url:
        return []
    
    from .shipment_manager import ShipmentManager
    manager = ShipmentManager(sheet_url)
    sheet_shipments = manager.fetch_shipments_from_sheet()
    
    results = []
    # Fetch statuses in parallel for better performance
    import asyncio
    
    async def fetch_status(s):
        tracking_data = await p_client.get_shipment_tracking(s['awb_code'])
        status = "Unknown"
        history = []
        weight = 0.0
        recipient_info = {}
        
        if tracking_data:
            # Extract tracking history
            history = tracking_data.get('tracking', [])
            if history:
                last_event = history[-1]
                status = last_event.get('eventDescription', 'No Status')
            
            # Extract shipment details if present at top level
            # Postis API responses often include these:
            weight = tracking_data.get('weight', 0.0)
            recipient_info = tracking_data.get('recipient', {})
            
        return schemas.ShipmentSchema(
            awb=s['awb'],
            status=status,
            recipient_name=recipient_info.get('name') or s.get('description') or 'Individual Recipient',
            delivery_address=recipient_info.get('address') or "Pending Delivery",
            created_at=datetime.utcnow(),
            weight=weight,
            tracking_history=history,
            recipient_phone=recipient_info.get('phone')
        )

    tasks = [fetch_status(s) for s in sheet_shipments[:100]] # Increased limit to 100
    results = await asyncio.gather(*tasks)
    
    return results

@app.post("/sync-drivers")
async def sync_drivers(db: Session = Depends(database.get_db), current_driver: models.Driver = Depends(role_required(["Admin"]))):
    sheet_url = os.getenv("GOOGLE_SHEETS_URL")
    if not sheet_url:
        raise HTTPException(status_code=400, detail="GOOGLE_SHEETS_URL not configured")
    manager = driver_manager.DriverManager(sheet_url)
    manager.sync_drivers(db)
    return {"status": "synced"}
