from pydantic import BaseModel
from typing import Optional, List, Any
from datetime import datetime

class DriverBase(BaseModel):
    driver_id: str
    name: str
    username: str
    role: str
    active: bool
    truck_plate: Optional[str] = None
    phone_number: Optional[str] = None
    phone_norm: Optional[str] = None
    helper_name: Optional[str] = None

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


class RecipientSignupRequest(BaseModel):
    awb: str
    phone: str
    password: str
    name: Optional[str] = None

class DriverUpdate(BaseModel):
    name: Optional[str] = None
    username: Optional[str] = None
    role: Optional[str] = None
    active: Optional[bool] = None
    password: Optional[str] = None
    truck_plate: Optional[str] = None
    phone_number: Optional[str] = None
    helper_name: Optional[str] = None

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
    county: Optional[str] = None
    latitude: Optional[float] = None
    longitude: Optional[float] = None
    weight: Optional[float] = None
    volumetric_weight: Optional[float] = None
    dimensions: Optional[str] = None
    content_description: Optional[str] = None
    cod_amount: Optional[float] = 0.0
    declared_value: Optional[float] = None
    number_of_parcels: Optional[int] = None
    shipping_cost: Optional[float] = None
    estimated_shipping_cost: Optional[float] = None
    currency: Optional[str] = None
    payment_amount: Optional[float] = None
    delivery_instructions: Optional[str] = None
    driver_id: Optional[str] = None
    last_updated: Optional[datetime] = None
    created_date: Optional[datetime] = None
    awb_status_date: Optional[datetime] = None
    shipment_reference: Optional[str] = None
    client_order_id: Optional[str] = None
    postis_order_id: Optional[str] = None
    source_channel: Optional[str] = None
    send_type: Optional[str] = None
    sender_shop_name: Optional[str] = None
    processing_status: Optional[str] = None
    # Extra data for tracking
    tracking_history: Optional[List[dict]] = None
    raw_data: Optional[Any] = None 
    recipient_pin: Optional[Any] = None

    class Config:
        from_attributes = True


class ShipmentAllocateRequest(BaseModel):
    driver_id: str


class NotificationSchema(BaseModel):
    id: int
    user_id: str
    created_at: datetime
    read_at: Optional[datetime] = None
    title: str
    body: str
    awb: Optional[str] = None
    data: Optional[Any] = None

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
    payload: Optional[Any] = None

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
    truck_plate: Optional[str] = None
    truck_phone: Optional[str] = None
    helper_name: Optional[str] = None
    last_login: Optional[datetime] = None
    permissions: List[str]


# [NEW] Live Tracking Schemas
class TrackingRequestCreate(BaseModel):
    awb: Optional[str] = None
    driver_id: Optional[str] = None
    duration_sec: Optional[int] = 900


class TrackingRequestSchema(BaseModel):
    id: int
    created_at: datetime
    created_by_user_id: str
    created_by_role: Optional[str] = None
    target_driver_id: str
    awb: Optional[str] = None
    status: str
    duration_sec: int
    expires_at: Optional[datetime] = None
    accepted_at: Optional[datetime] = None
    denied_at: Optional[datetime] = None
    stopped_at: Optional[datetime] = None
    last_location_at: Optional[datetime] = None

    class Config:
        from_attributes = True


class TrackingRequestDetailSchema(TrackingRequestSchema):
    target_driver_name: Optional[str] = None
    target_truck_plate: Optional[str] = None
    target_truck_phone: Optional[str] = None


class TrackingLocationSchema(BaseModel):
    request_id: int
    driver_id: str
    latitude: float
    longitude: float
    timestamp: datetime


# [NEW] In-app Chat Schemas
class ChatThreadCreate(BaseModel):
    awb: str


class ChatThreadSchema(BaseModel):
    id: int
    created_at: datetime
    awb: Optional[str] = None
    subject: Optional[str] = None
    last_message_at: Optional[datetime] = None
    last_message_preview: Optional[str] = None
    unread_count: int = 0

    class Config:
        from_attributes = True


class ChatMessageCreate(BaseModel):
    message_type: str = "text"
    text: Optional[str] = None
    data: Optional[Any] = None


class ChatMessageSchema(BaseModel):
    id: int
    thread_id: int
    created_at: datetime
    sender_user_id: str
    sender_role: Optional[str] = None
    message_type: str
    text: Optional[str] = None
    data: Optional[Any] = None

    class Config:
        from_attributes = True


class ChatReadRequest(BaseModel):
    last_read_message_id: Optional[int] = None
