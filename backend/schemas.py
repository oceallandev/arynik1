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


# [NEW] Postis Manual Sync Schemas
class PostisSyncStatsSchema(BaseModel):
    started_at: datetime
    finished_at: datetime
    list_items: int
    unique_awbs: int
    new_awbs: int
    changed_awbs: int
    fetched_details: int
    upserted_list: int
    upserted_details: int
    fetch_errors: int
    upsert_errors_list: int
    upsert_errors_details: int


class PostisSyncStatusSchema(BaseModel):
    running: bool
    running_since: Optional[datetime] = None
    last_trigger: Optional[str] = None
    last_error: Optional[str] = None
    last_stats: Optional[PostisSyncStatsSchema] = None


class PostisSyncTriggerResponseSchema(PostisSyncStatusSchema):
    started: bool


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


# [NEW] Contact Attempts
class ContactAttemptCreate(BaseModel):
    awb: Optional[str] = None
    channel: str = "call"  # call | whatsapp | sms
    to_phone: Optional[str] = None
    outcome: Optional[str] = None
    notes: Optional[str] = None
    data: Optional[Any] = None


class ContactAttemptSchema(BaseModel):
    id: int
    created_at: datetime
    created_by_user_id: str
    created_by_role: Optional[str] = None
    awb: Optional[str] = None
    channel: str
    to_phone: Optional[str] = None
    outcome: Optional[str] = None
    notes: Optional[str] = None
    data: Optional[Any] = None

    class Config:
        from_attributes = True


# [NEW] Manifests (load-out / return scanning)
class ManifestCreate(BaseModel):
    truck_plate: Optional[str] = None
    date: Optional[str] = None  # YYYY-MM-DD
    kind: Optional[str] = "loadout"  # loadout | return
    notes: Optional[str] = None


class ManifestScanRequest(BaseModel):
    identifier: str
    parcels_total: Optional[int] = None
    data: Optional[Any] = None


class ManifestItemSchema(BaseModel):
    id: int
    manifest_id: int
    awb: str
    parcels_total: Optional[int] = None
    scanned_identifiers: Optional[Any] = None
    scanned_parcel_indexes: Optional[Any] = None
    scan_count: int
    last_scanned_at: Optional[datetime] = None
    last_scanned_by: Optional[str] = None
    data: Optional[Any] = None

    class Config:
        from_attributes = True


class ManifestSchema(BaseModel):
    id: int
    created_at: datetime
    created_by_user_id: str
    created_by_role: Optional[str] = None
    truck_plate: Optional[str] = None
    date: Optional[str] = None
    kind: str
    status: str
    notes: Optional[str] = None
    items: Optional[List[ManifestItemSchema]] = None

    class Config:
        from_attributes = True


# [NEW] Route Runs (execution tracking)
class RouteRunStartRequest(BaseModel):
    route_id: Optional[str] = None
    route_name: Optional[str] = None
    awbs: List[str]
    truck_plate: Optional[str] = None
    helper_name: Optional[str] = None
    data: Optional[Any] = None


class RouteRunStopUpdate(BaseModel):
    latitude: Optional[float] = None
    longitude: Optional[float] = None
    notes: Optional[str] = None
    data: Optional[Any] = None
    completion_event_id: Optional[str] = None


class RouteRunStopSchema(BaseModel):
    id: int
    run_id: int
    awb: str
    seq: Optional[int] = None
    state: str
    arrived_at: Optional[datetime] = None
    completed_at: Optional[datetime] = None
    completion_event_id: Optional[str] = None
    last_latitude: Optional[float] = None
    last_longitude: Optional[float] = None
    notes: Optional[str] = None
    data: Optional[Any] = None

    class Config:
        from_attributes = True


class RouteRunSchema(BaseModel):
    id: int
    created_at: datetime
    started_at: Optional[datetime] = None
    ended_at: Optional[datetime] = None
    status: str
    route_id: Optional[str] = None
    route_name: Optional[str] = None
    driver_id: str
    truck_plate: Optional[str] = None
    helper_name: Optional[str] = None
    data: Optional[Any] = None
    stops: Optional[List[RouteRunStopSchema]] = None

    class Config:
        from_attributes = True


# [NEW] Recipient self-service
class ShipmentInstructionsUpdate(BaseModel):
    instructions: Optional[str] = None


class ShipmentRescheduleRequest(BaseModel):
    desired_at: Optional[str] = None  # ISO string
    reason_code: Optional[str] = None
    note: Optional[str] = None
