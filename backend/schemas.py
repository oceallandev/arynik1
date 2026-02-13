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
    delivery_address: Optional[str] = None
    created_at: Optional[datetime] = None
    # Extended info
    weight: Optional[float] = None
    delivery_local_time: Optional[str] = None
    tracking_history: Optional[List[dict]] = None
    recipient_phone: Optional[str] = None
    # Newly requested fields
    carrier: Optional[str] = None
    return_awb: Optional[str] = None
    created_by: Optional[str] = None
    sales_channel: Optional[str] = None
    delivery_method: Optional[str] = None
    shipment_type: Optional[str] = None
    cash_on_delivery: Optional[float] = None
    estimated_shipping_cost: Optional[float] = None
    carrier_shipping_cost: Optional[float] = None
    shipping_instruction: Optional[str] = None
    payment_type: Optional[Any] = None
    pickup_date: Optional[str] = None
    last_modified_date: Optional[str] = None
    last_modified_by: Optional[str] = None
    packing_list: Optional[Any] = None
    processing_status: Optional[Any] = None
    options: Optional[Any] = None
    shipment_payer: Optional[Any] = None
    courier_pickup_id: Optional[str] = None
    pin_code: Optional[str] = None
    volumetric_weight: Optional[float] = None
    dimensions: Optional[str] = None
    raw_data: Optional[Any] = None # For debugging and flexible JS access

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

class MeSchema(BaseModel):
    driver_id: str
    name: str
    username: str
    role: str
    active: bool
    last_login: Optional[datetime] = None
    permissions: List[str]
