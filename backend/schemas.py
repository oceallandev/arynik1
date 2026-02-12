from pydantic import BaseModel
from typing import Optional, List, Any
from datetime import datetime

class DriverBase(BaseModel):
    driver_id: str
    name: str
    username: str
    role: str
    active: bool

class DriverCreate(DriverBase):
    password: str

class Driver(DriverBase):
    id: int
    last_login: Optional[datetime] = None

    class Config:
        from_attributes = True

class LoginRequest(BaseModel):
    username: str
    password: str

class Token(BaseModel):
    access_token: str
    token_type: str
    role: str

class StatusOptionSchema(BaseModel):
    event_id: str
    label: str
    description: str
    requirements: Optional[List[str]] = None

    class Config:
        from_attributes = True

class AWBUpdateRequest(BaseModel):
    awb: str
    event_id: str
    timestamp: Optional[datetime] = None
    payload: Optional[dict] = None

class ShipmentSchema(BaseModel):
    awb: str
    status: Optional[str] = None
    recipient_name: Optional[str] = None
    delivery_address: Optional[str] = None
    created_at: Optional[datetime] = None
    # Extended info
    weight: Optional[float] = None
    delivery_local_time: Optional[str] = None
    tracking_history: Optional[List[dict]] = None
    recipient_phone: Optional[str] = None

    class Config:
        from_attributes = True

class LogEntrySchema(BaseModel):
    id: int
    driver_id: str
    timestamp: datetime
    awb: str
    event_id: str
    outcome: str
    error_message: Optional[str] = None
    postis_reference: Optional[str] = None

    class Config:
        from_attributes = True
