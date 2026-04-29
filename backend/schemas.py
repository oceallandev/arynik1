from pydantic import BaseModel
from typing import Optional, List, Any, Dict
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
    vehicle_type_code: Optional[str] = None
    vehicle_has_lift: Optional[bool] = None
    max_volume_m3: Optional[float] = None
    target_volume_m3: Optional[float] = None
    max_weight_kg: Optional[float] = None
    target_weight_kg: Optional[float] = None
    warehouse_id: Optional[int] = None
    store_id: Optional[int] = None

class DriverCreate(DriverBase):
    password: str

class Driver(DriverBase):
    id: int
    last_login: Optional[datetime] = None

    class Config:
        from_attributes = True


class FleetAccountCredentialSchema(BaseModel):
    driver_id: str
    name: str
    username: str
    password: str
    role: str
    truck_plate: Optional[str] = None
    phone: Optional[str] = None
    vehicle_type: Optional[str] = None

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
    vehicle_type_code: Optional[str] = None
    vehicle_has_lift: Optional[bool] = None
    max_volume_m3: Optional[float] = None
    target_volume_m3: Optional[float] = None
    max_weight_kg: Optional[float] = None
    target_weight_kg: Optional[float] = None
    warehouse_id: Optional[int] = None
    store_id: Optional[int] = None


class UserDeleteResponse(BaseModel):
    driver_id: str
    hard_deleted: bool = False
    deactivated: bool = False
    previous_role: Optional[str] = None
    previous_username: Optional[str] = None
    message: Optional[str] = None

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
    recipient_instructions: Optional[str] = None
    driver_id: Optional[str] = None
    geocode_source: Optional[str] = None
    geocoded_at: Optional[datetime] = None
    location_granularity: Optional[str] = None
    has_precise_address: Optional[bool] = None
    requires_location_confirmation: Optional[bool] = None
    last_updated: Optional[datetime] = None
    created_date: Optional[datetime] = None
    awb_status_date: Optional[datetime] = None
    shipment_reference: Optional[str] = None
    client_order_id: Optional[str] = None
    postis_order_id: Optional[str] = None
    source_channel: Optional[str] = None
    send_type: Optional[str] = None
    sender_shop_name: Optional[str] = None
    warehouse_id: Optional[int] = None
    warehouse_name: Optional[str] = None
    store_id: Optional[int] = None
    store_name: Optional[str] = None
    processing_status: Optional[str] = None
    local_awb_shipment: Optional[bool] = None
    local_shipment: Optional[bool] = None
    shipment_label_available: Optional[bool] = None
    return_confirmed_at: Optional[datetime] = None
    return_confirmed_by: Optional[str] = None
    # Extra data for tracking
    tracking_history: Optional[List[dict]] = None
    delivery_logs: Optional[List[dict]] = None
    raw_data: Optional[Any] = None 
    recipient_pin: Optional[Any] = None

    class Config:
        from_attributes = True


class ShipmentAllocateRequest(BaseModel):
    driver_id: str


class ShipmentManualCreateRequest(BaseModel):
    awb: str
    recipient_name: str
    delivery_address: str
    locality: str
    recipient_phone: Optional[str] = None
    recipient_email: Optional[str] = None
    county: Optional[str] = None
    cod_amount: Optional[float] = 0.0
    weight: Optional[float] = 0.0
    volumetric_weight: Optional[float] = 0.0
    dimensions: Optional[str] = None
    content_description: Optional[str] = None
    declared_value: Optional[float] = 0.0
    number_of_parcels: Optional[int] = 1
    sender_shop_name: Optional[str] = None
    warehouse_id: Optional[int] = None
    store_id: Optional[int] = None
    carrier_code: Optional[str] = None
    carrier_name: Optional[str] = None
    carrier_priority: Optional[str] = "balanced"
    carrier_distance_km: Optional[float] = None
    carrier_estimated_cost: Optional[float] = None
    carrier_estimated_eta_hours: Optional[float] = None
    destination_latitude: Optional[float] = None
    destination_longitude: Optional[float] = None
    delivery_instructions: Optional[str] = None
    recipient_instructions: Optional[str] = None
    status: Optional[str] = "Intrare in depozit"


class ShipmentReturnConfirmRequest(BaseModel):
    notes: Optional[str] = None


class ShipmentLabelsBatchRequest(BaseModel):
    awbs: List[str]


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

class ActivityLogCreate(BaseModel):
    action_type: Optional[str] = None
    path: Optional[str] = None
    method: Optional[str] = None
    details: Optional[str] = None
    payload: Optional[Any] = None

class ActivityLogSchema(ActivityLogCreate):
    id: int
    user_id: Optional[str] = None
    user_name: Optional[str] = None
    timestamp: Optional[datetime] = None
    latitude: Optional[float] = None
    longitude: Optional[float] = None

    class Config:
        from_attributes = True

class RoleInfoSchema(BaseModel):
    role: str
    description: Optional[str] = None
    permissions: List[str]
    aliases: Optional[List[str]] = None


class WarehouseBase(BaseModel):
    code: str
    name: str
    address: Optional[str] = None
    latitude: Optional[float] = None
    longitude: Optional[float] = None
    active: bool = True


class WarehouseCreate(WarehouseBase):
    pass


class WarehouseUpdate(BaseModel):
    code: Optional[str] = None
    name: Optional[str] = None
    address: Optional[str] = None
    latitude: Optional[float] = None
    longitude: Optional[float] = None
    active: Optional[bool] = None


class WarehouseSchema(WarehouseBase):
    id: int
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True


class StoreBase(BaseModel):
    code: str
    name: str
    warehouse_id: Optional[int] = None
    address: Optional[str] = None
    latitude: Optional[float] = None
    longitude: Optional[float] = None
    active: bool = True


class StoreCreate(StoreBase):
    pass


class StoreUpdate(BaseModel):
    code: Optional[str] = None
    name: Optional[str] = None
    warehouse_id: Optional[int] = None
    address: Optional[str] = None
    latitude: Optional[float] = None
    longitude: Optional[float] = None
    active: Optional[bool] = None


class StoreSchema(StoreBase):
    id: int
    warehouse_name: Optional[str] = None
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True


class CarrierPartnerBase(BaseModel):
    code: str
    name: str
    integration_mode: Optional[str] = None
    base_fee: float = 0.0
    cost_per_km: float = 0.0
    cost_per_kg: float = 0.0
    cod_fee_percent: float = 0.0
    avg_speed_kmph: float = 45.0
    base_eta_hours: float = 12.0
    service_radius_km: Optional[float] = None
    priority_bonus: float = 0.0
    active: bool = True
    notes: Optional[str] = None


class CarrierPartnerCreate(CarrierPartnerBase):
    pass


class CarrierPartnerUpdate(BaseModel):
    code: Optional[str] = None
    name: Optional[str] = None
    integration_mode: Optional[str] = None
    base_fee: Optional[float] = None
    cost_per_km: Optional[float] = None
    cost_per_kg: Optional[float] = None
    cod_fee_percent: Optional[float] = None
    avg_speed_kmph: Optional[float] = None
    base_eta_hours: Optional[float] = None
    service_radius_km: Optional[float] = None
    priority_bonus: Optional[float] = None
    active: Optional[bool] = None
    notes: Optional[str] = None


class CarrierPartnerSchema(CarrierPartnerBase):
    id: int
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True


class CarrierRecommendationRequest(BaseModel):
    warehouse_id: Optional[int] = None
    store_id: Optional[int] = None
    delivery_address: Optional[str] = None
    locality: Optional[str] = None
    county: Optional[str] = None
    distance_km: Optional[float] = None
    destination_latitude: Optional[float] = None
    destination_longitude: Optional[float] = None
    weight: Optional[float] = 0.0
    cod_amount: Optional[float] = 0.0
    priority: Optional[str] = "balanced"  # balanced | cost | speed | distance
    carrier_codes: Optional[List[str]] = None


class CarrierRecommendationOption(BaseModel):
    code: str
    name: str
    integration_mode: Optional[str] = None
    distance_km: float
    estimated_cost: float
    estimated_eta_hours: float
    coverage_score: float
    cost_score: float
    speed_score: float
    distance_score: float
    total_score: float
    recommended: bool = False
    reason: Optional[str] = None


class CarrierRecommendationResponse(BaseModel):
    priority: str
    origin_label: Optional[str] = None
    distance_km: float
    recommended_code: Optional[str] = None
    options: List[CarrierRecommendationOption]


class VehicleTypeSchema(BaseModel):
    code: str
    label: str
    description: Optional[str] = None
    supports_liftgate: bool = False
    max_volume_m3: Optional[float] = None
    target_volume_m3: Optional[float] = None
    max_weight_kg: Optional[float] = None
    target_weight_kg: Optional[float] = None


class FleetVehicleBase(BaseModel):
    plate: Optional[str] = None
    label: Optional[str] = None
    active: Optional[bool] = True
    assigned_driver_id: Optional[str] = None
    assigned_driver_name: Optional[str] = None
    assigned_phone: Optional[str] = None
    helper_name: Optional[str] = None
    vehicle_type_code: Optional[str] = None
    vehicle_has_lift: Optional[bool] = None
    max_volume_m3: Optional[float] = None
    target_volume_m3: Optional[float] = None
    max_weight_kg: Optional[float] = None
    target_weight_kg: Optional[float] = None
    odometer_km: Optional[float] = None
    purchase_date: Optional[datetime] = None
    notes: Optional[str] = None
    admin_data: Optional[Any] = None


class FleetVehicleCreate(FleetVehicleBase):
    pass


class FleetVehicleUpdate(FleetVehicleBase):
    pass


class FleetVehicleSchema(FleetVehicleBase):
    id: int
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True


class FleetPhoneNumberBase(BaseModel):
    phone_number: str
    label: Optional[str] = None
    active: Optional[bool] = True
    notes: Optional[str] = None


class FleetPhoneNumberCreate(FleetPhoneNumberBase):
    pass


class FleetPhoneNumberUpdate(BaseModel):
    phone_number: Optional[str] = None
    label: Optional[str] = None
    active: Optional[bool] = None
    notes: Optional[str] = None


class FleetPhoneNumberSchema(FleetPhoneNumberBase):
    id: int
    phone_norm: Optional[str] = None
    assigned_driver_id: Optional[str] = None
    assigned_vehicle_id: Optional[int] = None
    last_seen_at: Optional[datetime] = None
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True


class FleetVehicleAssignmentBase(BaseModel):
    driver_id: str
    vehicle_id: Optional[int] = None
    vehicle_plate: Optional[str] = None
    phone_id: Optional[int] = None
    phone_label: Optional[str] = None
    source: Optional[str] = None
    notes: Optional[str] = None


class FleetVehicleAssignmentCreate(FleetVehicleAssignmentBase):
    pass


class FleetVehicleAssignmentSchema(FleetVehicleAssignmentBase):
    id: int
    active: bool = True
    assigned_at: Optional[datetime] = None
    unassigned_at: Optional[datetime] = None
    assigned_by_user_id: Optional[str] = None
    last_location_at: Optional[datetime] = None
    km_total: Optional[float] = None
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True


class FleetDocumentBase(BaseModel):
    category: Optional[str] = None
    title: str
    issuer: Optional[str] = None
    status: Optional[str] = None
    issue_date: Optional[datetime] = None
    expiry_date: Optional[datetime] = None
    reminder_days_before: Optional[int] = 30
    file_url: Optional[str] = None
    notes: Optional[str] = None
    data: Optional[Any] = None


class FleetDocumentCreate(FleetDocumentBase):
    pass


class FleetDocumentUpdate(BaseModel):
    category: Optional[str] = None
    title: Optional[str] = None
    issuer: Optional[str] = None
    status: Optional[str] = None
    issue_date: Optional[datetime] = None
    expiry_date: Optional[datetime] = None
    reminder_days_before: Optional[int] = None
    file_url: Optional[str] = None
    notes: Optional[str] = None
    data: Optional[Any] = None


class FleetDocumentSchema(FleetDocumentBase):
    id: int
    vehicle_id: int
    remind_at: Optional[datetime] = None
    last_reminder_at: Optional[datetime] = None
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True


class FleetServiceBase(BaseModel):
    service_type: Optional[str] = None
    title: str
    provider: Optional[str] = None
    status: Optional[str] = None
    performed_at: Optional[datetime] = None
    due_date: Optional[datetime] = None
    odometer_km: Optional[float] = None
    due_km: Optional[float] = None
    next_due_km: Optional[float] = None
    estimated_cost: Optional[float] = None
    actual_cost: Optional[float] = None
    currency: Optional[str] = None
    reminder_days_before: Optional[int] = 14
    notes: Optional[str] = None
    data: Optional[Any] = None


class FleetServiceCreate(FleetServiceBase):
    pass


class FleetServiceUpdate(BaseModel):
    service_type: Optional[str] = None
    title: Optional[str] = None
    provider: Optional[str] = None
    status: Optional[str] = None
    performed_at: Optional[datetime] = None
    due_date: Optional[datetime] = None
    odometer_km: Optional[float] = None
    due_km: Optional[float] = None
    next_due_km: Optional[float] = None
    estimated_cost: Optional[float] = None
    actual_cost: Optional[float] = None
    currency: Optional[str] = None
    reminder_days_before: Optional[int] = None
    notes: Optional[str] = None
    data: Optional[Any] = None


class FleetServiceSchema(FleetServiceBase):
    id: int
    vehicle_id: int
    remind_at: Optional[datetime] = None
    last_reminder_at: Optional[datetime] = None
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True


class FleetInsuranceBase(BaseModel):
    insurance_type: Optional[str] = None
    provider: Optional[str] = None
    policy_number: Optional[str] = None
    status: Optional[str] = None
    start_date: Optional[datetime] = None
    expiry_date: Optional[datetime] = None
    premium_amount: Optional[float] = None
    currency: Optional[str] = None
    deductible: Optional[float] = None
    reminder_days_before: Optional[int] = 30
    notes: Optional[str] = None
    data: Optional[Any] = None


class FleetInsuranceCreate(FleetInsuranceBase):
    pass


class FleetInsuranceUpdate(BaseModel):
    insurance_type: Optional[str] = None
    provider: Optional[str] = None
    policy_number: Optional[str] = None
    status: Optional[str] = None
    start_date: Optional[datetime] = None
    expiry_date: Optional[datetime] = None
    premium_amount: Optional[float] = None
    currency: Optional[str] = None
    deductible: Optional[float] = None
    reminder_days_before: Optional[int] = None
    notes: Optional[str] = None
    data: Optional[Any] = None


class FleetInsuranceSchema(FleetInsuranceBase):
    id: int
    vehicle_id: int
    remind_at: Optional[datetime] = None
    last_reminder_at: Optional[datetime] = None
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True


class FleetReminderSchema(BaseModel):
    kind: str
    id: int
    vehicle_id: int
    plate: Optional[str] = None
    title: Optional[str] = None
    status: Optional[str] = None
    due_at: Optional[datetime] = None
    days_left: Optional[int] = None


class FleetOverviewSchema(BaseModel):
    vehicles_total: int
    vehicles_with_lift: int
    target_volume_m3_total: float
    target_weight_kg_total: float
    by_vehicle_type: Dict[str, int]
    reminders_total: int
    reminders_due_soon: int
    reminders_overdue: int
    reminders: List[FleetReminderSchema]

# [NEW] Location & Routing Schemas
class LocationUpdate(BaseModel):
    latitude: float
    longitude: float
    vehicle_id: Optional[int] = None
    vehicle_plate: Optional[str] = None
    phone_id: Optional[int] = None
    phone_label: Optional[str] = None

class RouteRequest(BaseModel):
    current_location: LocationUpdate
    shipments: List[str] # List of AWBs to include in route

class RouteMetricPoint(BaseModel):
    lat: float
    lon: float

class RouteMetricsRequest(BaseModel):
    points: List[RouteMetricPoint]

class RouteMetricsResponse(BaseModel):
    geometry: Optional[Dict[str, Any]] = None
    distance_m: float = 0.0
    duration_s: float = 0.0
    duration_no_traffic_s: float = 0.0
    delay_s: float = 0.0
    provider: str = "osrm"


class RouteOptimizeRequest(BaseModel):
    origin: RouteMetricPoint
    stops: List[RouteMetricPoint]
    return_to_origin: bool = True


class RouteOptimizeResponse(BaseModel):
    optimized_order: List[int] = []
    geometry: Optional[Dict[str, Any]] = None
    distance_m: float = 0.0
    duration_s: float = 0.0
    duration_no_traffic_s: float = 0.0
    delay_s: float = 0.0
    provider: str = "google_traffic"


class GeocodeRequest(BaseModel):
    query: str
    expected_locality: Optional[str] = None
    expected_county: Optional[str] = None


class GeocodeResponse(BaseModel):
    found: bool = False
    lat: Optional[float] = None
    lon: Optional[float] = None
    formatted_address: Optional[str] = None
    provider: Optional[str] = None
    accuracy: Optional[str] = None
    partial_match: Optional[bool] = None
    matched_locality: Optional[bool] = None
    matched_county: Optional[bool] = None


class GeocodeShipmentsRequest(BaseModel):
    awbs: List[str] = []
    refresh_missing: bool = True


class GeocodeShipmentPoint(BaseModel):
    awb: str
    lat: Optional[float] = None
    lon: Optional[float] = None
    source: Optional[str] = None


class GeocodeShipmentsResponse(BaseModel):
    total: int = 0
    found: int = 0
    refreshed: bool = False
    refresh_stats: Optional[Dict[str, int]] = None
    points: List[GeocodeShipmentPoint] = []


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
    warehouse_id: Optional[int] = None
    warehouse_name: Optional[str] = None
    store_id: Optional[int] = None
    store_name: Optional[str] = None
    vehicle_type_code: Optional[str] = None
    vehicle_has_lift: Optional[bool] = None
    max_volume_m3: Optional[float] = None
    target_volume_m3: Optional[float] = None
    max_weight_kg: Optional[float] = None
    target_weight_kg: Optional[float] = None
    last_login: Optional[datetime] = None
    permissions: List[str]


class MeDevicePhoneSyncRequest(BaseModel):
    phone_number: str
    source: Optional[str] = None


class MeDevicePhoneSyncResponse(BaseModel):
    driver_id: str
    truck_phone: Optional[str] = None
    phone_norm: Optional[str] = None
    updated: bool = False
    source: Optional[str] = None


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
    geocode_scanned: int = 0
    geocode_pending: int = 0
    geocode_reused: int = 0
    geocode_updated: int = 0
    geocode_failed: int = 0


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
    sender_name: Optional[str] = None
    message_type: str
    text: Optional[str] = None
    data: Optional[Any] = None

    class Config:
        from_attributes = True


class ChatReadRequest(BaseModel):
    last_read_message_id: Optional[int] = None


class AssistantAskRequest(BaseModel):
    question: str
    awb: Optional[str] = None
    thread_id: Optional[int] = None
    context: Optional[Any] = None


class AssistantAskResponse(BaseModel):
    answer: str
    suggestions: Optional[List[str]] = None
    provider: str = "local_fallback"
    model: Optional[str] = None
    context_awbs: Optional[List[str]] = None


class ProviderSecretStatus(BaseModel):
    configured: bool = False
    masked: Optional[str] = None


class ProviderSecretsStatusResponse(BaseModel):
    openai_api_key: ProviderSecretStatus
    elevenlabs_api_key: ProviderSecretStatus


class ProviderSecretsUpdateRequest(BaseModel):
    openai_api_key: Optional[str] = None
    elevenlabs_api_key: Optional[str] = None
    persist_to_env: bool = True


class ProviderSecretsUpdateResponse(BaseModel):
    ok: bool = True
    saved_to_env: bool = True
    openai_api_key: ProviderSecretStatus
    elevenlabs_api_key: ProviderSecretStatus


class MapsProviderUsageItem(BaseModel):
    created_at: datetime
    action: str
    mode: str
    requests_count: int = 1
    estimated_cost: float = 0.0


class MapsProviderConfigResponse(BaseModel):
    owner_user_id: Optional[str] = None
    maps_mode: str = "platform"
    own_maps_api_key: ProviderSecretStatus
    platform_google_maps_api_key: ProviderSecretStatus
    pricing_per_1000: float = 0.0
    pricing_per_request: float = 0.0
    platform_credit_balance: float = 0.0
    platform_usage_requests: int = 0
    platform_usage_cost: float = 0.0
    platform_remaining_estimated_requests: Optional[int] = None
    recent_usage: Optional[List[MapsProviderUsageItem]] = None


class MapsProviderConfigUpdateRequest(BaseModel):
    maps_mode: Optional[str] = None  # own | platform
    own_maps_api_key: Optional[str] = None
    platform_google_maps_api_key: Optional[str] = None
    persist_to_env: bool = True


class MapsProviderCreditTopupRequest(BaseModel):
    amount: float
    note: Optional[str] = None


class MapsProviderCreditTopupResponse(BaseModel):
    ok: bool = True
    owner_user_id: Optional[str] = None
    amount_added: float = 0.0
    platform_credit_balance: float = 0.0
    platform_usage_requests: int = 0
    platform_usage_cost: float = 0.0


# [NEW] Admin Improvement Notes
class AdminNoteCreate(BaseModel):
    text: str
    status: Optional[str] = None


class AdminNoteUpdate(BaseModel):
    status: str


class AdminNoteSchema(BaseModel):
    id: int
    created_at: datetime
    created_by_user_id: str
    created_by_name: Optional[str] = None
    text: str
    status: str

    class Config:
        from_attributes = True


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


class ManifestApproveUnloadRequest(BaseModel):
    notes: Optional[str] = None
    close_on_success: bool = True


class ManifestApproveUnloadItemResult(BaseModel):
    awb: str
    ok: bool
    detail: Optional[str] = None
    reference: Optional[str] = None


class ManifestApproveUnloadResponse(BaseModel):
    manifest: ManifestSchema
    event_id: str
    total_awbs: int
    success_count: int
    failed_count: int
    results: List[ManifestApproveUnloadItemResult]


class ManifestImportAwbResult(BaseModel):
    raw: Optional[str] = None
    awb: Optional[str] = None
    ok: bool
    reason: str
    detail: Optional[str] = None


class ManifestImportAwbsResponse(BaseModel):
    manifest: ManifestSchema
    source: str
    filename: Optional[str] = None
    total_rows: int
    detected_tokens: int
    processed_count: int
    imported_count: int
    duplicate_count: int
    invalid_count: int
    imported_awbs: Optional[List[str]] = None
    duplicate_awbs: Optional[List[str]] = None
    invalid_values: Optional[List[str]] = None
    results: List[ManifestImportAwbResult]


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


class DeliveryLogResponse(BaseModel):
    id: int
    run_id: Optional[int] = None
    awb: str
    state: str
    completed_at: Optional[datetime] = None
    arrived_at: Optional[datetime] = None
    last_latitude: Optional[float] = None
    last_longitude: Optional[float] = None
    notes: Optional[str] = None
    data: Optional[Any] = None
    
    driver_id: Optional[str] = None
    driver_name: Optional[str] = None
    truck_plate: Optional[str] = None
    
    recipient_name: Optional[str] = None
    locality: Optional[str] = None
    county: Optional[str] = None
    delivery_address: Optional[str] = None
    shipment_status: Optional[str] = None
    shipment_latitude: Optional[float] = None
    shipment_longitude: Optional[float] = None
    delivery_instructions: Optional[str] = None

    class Config:
        from_attributes = True


class RouteHistoryEvent(BaseModel):
    timestamp: datetime
    type: str
    actor_id: Optional[str] = None
    actor_name: Optional[str] = None
    description: Optional[str] = None
    run_id: Optional[int] = None
    awb: Optional[str] = None
    status: Optional[str] = None

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


class RoutePlanSchema(BaseModel):
    id: int
    plan_date: str
    county: Optional[str] = None
    route_index: int = 1
    name: Optional[str] = None
    status: str

    generated_at: Optional[datetime] = None
    generated_by_user_id: Optional[str] = None
    generated_trigger: Optional[str] = None

    approved_at: Optional[datetime] = None
    approved_by_user_id: Optional[str] = None

    assigned_at: Optional[datetime] = None
    assigned_by_user_id: Optional[str] = None
    assigned_vehicle_plate: Optional[str] = None
    assigned_driver_id: Optional[str] = None
    assigned_driver_name: Optional[str] = None
    assigned_helper_name: Optional[str] = None
    assigned_phone: Optional[str] = None

    vehicle_type_code: Optional[str] = None
    vehicle_has_lift: Optional[bool] = None
    max_volume_m3: Optional[float] = None
    target_volume_m3: Optional[float] = None
    max_weight_kg: Optional[float] = None
    target_weight_kg: Optional[float] = None

    awb_count: int = 0
    awbs: Optional[List[str]] = None
    over_capacity_awbs: Optional[List[str]] = None
    issues: Optional[Any] = None

    load_volume_m3: Optional[float] = None
    load_weight_kg: Optional[float] = None
    utilization_volume_pct: Optional[float] = None
    utilization_weight_pct: Optional[float] = None

    data: Optional[Any] = None
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True


class RoutePlanGenerateRequest(BaseModel):
    plan_date: Optional[str] = None
    sync_postis: bool = True


class RoutePlanManualCreateRequest(BaseModel):
    plan_date: Optional[str] = None
    county: Optional[str] = None
    route_index: Optional[int] = None
    name: Optional[str] = None
    awbs: List[str] = []

    assigned_driver_id: Optional[str] = None
    assigned_driver_name: Optional[str] = None
    assigned_helper_name: Optional[str] = None
    assigned_phone: Optional[str] = None
    assigned_vehicle_plate: Optional[str] = None

    vehicle_type_code: Optional[str] = None
    vehicle_has_lift: Optional[bool] = None
    max_volume_m3: Optional[float] = None
    target_volume_m3: Optional[float] = None
    max_weight_kg: Optional[float] = None
    target_weight_kg: Optional[float] = None
    data: Optional[Any] = None


class RoutePlanAssignRequest(BaseModel):
    vehicle_plate: Optional[str] = None
    driver_id: Optional[str] = None
    helper_name: Optional[str] = None


class RoutePlanAddAwbRequest(BaseModel):
    awb: str


class RoutePlanUpdateAwbsRequest(BaseModel):
    awbs: List[str]


class RoutePlanAssignResponse(BaseModel):
    plan: RoutePlanSchema
    allocated_awbs: int
    missing_awbs: List[str]
    assigned_driver_id: Optional[str] = None
    assigned_vehicle_plate: Optional[str] = None
    assigned_helper_name: Optional[str] = None


class RoutePlanDeleteResponse(BaseModel):
    deleted_plan_id: int
    deleted_plan_status: Optional[str] = None
    deleted_plan_date: Optional[str] = None
    deleted_county: Optional[str] = None
    deleted_awbs: List[str] = []
    reset_assignment_count: int = 0
    replanned_summary: Optional[Any] = None


class RouteAvizSchema(BaseModel):
    id: int
    created_at: datetime
    created_by_user_id: Optional[str] = None
    route_plan_id: int
    aviz_number: str
    plan_date: Optional[str] = None
    route_name: Optional[str] = None
    county: Optional[str] = None
    vehicle_plate: Optional[str] = None
    driver_id: Optional[str] = None
    driver_name: Optional[str] = None
    helper_name: Optional[str] = None
    awb_count: int = 0
    total_weight_kg: Optional[float] = None
    total_volume_m3: Optional[float] = None
    data: Optional[Any] = None

    class Config:
        from_attributes = True


# [NEW] Recipient self-service
class ShipmentInstructionsUpdate(BaseModel):
    instructions: Optional[str] = None


class ShipmentRescheduleRequest(BaseModel):
    desired_at: Optional[str] = None  # ISO string
    desired_date: Optional[str] = None  # YYYY-MM-DD (local ops date)
    period: Optional[str] = None  # morning | afternoon
    slot_code: Optional[str] = None  # morning_09_12 | morning_12_15 | afternoon_15_18 | afternoon_18_21
    reason_code: Optional[str] = None
    note: Optional[str] = None
