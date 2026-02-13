from fastapi import FastAPI, Depends, HTTPException, status, APIRouter, Response
from fastapi.responses import StreamingResponse, FileResponse
from fastapi.security import OAuth2PasswordBearer, OAuth2PasswordRequestForm
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy.orm import Session
from datetime import datetime, timedelta
import jwt
import os
import logging
from typing import List
from dotenv import load_dotenv

# Load environment variables from the backend directory
env_path = os.path.join(os.path.dirname(__file__), '.env')
load_dotenv(dotenv_path=env_path, override=True)

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

@app.get("/stats")
async def get_stats(db: Session = Depends(database.get_db), current_driver: models.Driver = Depends(get_current_driver)):
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
    current_driver: models.Driver = Depends(role_required(["Admin", "Manager", "Driver"]))
):
    query = db.query(models.LogEntry)
    
    # Non-admins can only see their own logs
    if current_driver.role != "Admin":
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
async def get_shipments(current_driver: models.Driver = Depends(role_required(["Manager", "Admin"]))):
    try:
        results = []
        import asyncio
        
        # Try fetching from PostisGate first for "Real Data"
        postis_shipments = await p_client.get_shipments(limit=50)
        
        sheet_url = os.getenv("GOOGLE_SHEETS_URL")
        sheet_shipments = []
        if sheet_url:
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
                    history = tracking_data.get('tracking', [])
                    if history:
                        last_event = history[-1]
                        status = last_event.get('eventDescription', 'No Status')
                    
                    weight = tracking_data.get('brutWeight', 0.0)
                    recipient_info = tracking_data.get('recipientLocation', {})
                    
                    courier = tracking_data.get('courier', {})
                    carrier_info = f"{courier.get('id', '')} {courier.get('name', '')}".strip()
                    return_awb = tracking_data.get('returnAwb')
                    created_by = tracking_data.get('createdBy')
                    sales_channel = tracking_data.get('sourceChannel')
                    delivery_method = tracking_data.get('productCategory', {}).get('name')
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
                    dimensions=dims
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
                
                history = data.get('tracking', [])
                status = "Unknown"
                if history:
                    status = history[-1].get('eventDescription', 'No Status')
                
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

@app.get("/shipments/{awb}/label")
async def get_shipment_label(awb: str, current_driver: models.Driver = Depends(get_current_driver)):
    label_bytes = await p_client.get_shipment_label(awb)
    if not label_bytes:
        raise HTTPException(status_code=404, detail="Label not found")
    return Response(content=label_bytes, media_type="application/pdf")

@app.post("/shipments/update-status")
async def update_shipment_status(
    request: schemas.AWBUpdateRequest,
    current_driver: models.Driver = Depends(get_current_driver)
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
async def sync_drivers(db: Session = Depends(database.get_db), current_driver: models.Driver = Depends(role_required(["Admin"]))):
    sheet_url = os.getenv("GOOGLE_SHEETS_URL")
    if not sheet_url:
        raise HTTPException(status_code=400, detail="GOOGLE_SHEETS_URL not configured")
    logger.info(f"Syncing drivers from: {sheet_url}")
    manager = driver_manager.DriverManager(sheet_url)
    manager.sync_drivers(db)
    return {"status": "synced"}

@app.get("/")
async def read_index():
    return FileResponse("../preview.html")

@app.get("/preview.html")
async def read_preview_html():
    return FileResponse("../preview.html")

@app.get("/logo.png")
async def read_logo():
    return FileResponse("../logo.png")

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
