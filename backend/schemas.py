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

class DriverUpdate(BaseModel):
    name: Optional[str] = None
    username: Optional[str] = None
    role: Optional[str] = None
    active: Optional[bool] = None
    password: Optional[str] = None

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
    recipient_phone: Optional[str] = None
    recipient_email: Optional[str] = None
    delivery_address: Optional[str] = None
    locality: Optional[str] = None
    latitude: Optional[float] = None
    longitude: Optional[float] = None
    weight: Optional[float] = None
    volumetric_weight: Optional[float] = None
    dimensions: Optional[str] = None
    content_description: Optional[str] = None
    cod_amount: Optional[float] = 0.0
    delivery_instructions: Optional[str] = None
    driver_id: Optional[str] = None
    last_updated: Optional[datetime] = None
    # Extra data for tracking
    tracking_history: Optional[List[dict]] = None
    raw_data: Optional[Any] = None 

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

class RoleInfoSchema(BaseModel):
    role: str
    description: Optional[str] = None
    permissions: List[str]
    aliases: Optional[List[str]] = None

# [NEW] Location & Routing Schemas
class LocationUpdate(BaseModel):
    latitude: float
    longitude: float

class RouteRequest(BaseModel):
    current_location: LocationUpdate
    shipments: List[str] # List of AWBs to include in route

class DriverHistorySchema(BaseModel):
    driver_id: str
    date: str
    locations: List[LocationUpdate]
    total_distance_km: float

class MeSchema(BaseModel):
    driver_id: str
    name: str
    username: str
    role: str
    active: bool
    last_login: Optional[datetime] = None
    permissions: List[str]
