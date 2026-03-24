from sqlalchemy import Column, Integer, String, Float, Boolean, ForeignKey, DateTime, Enum, JSON, UniqueConstraint
from sqlalchemy.orm import relationship, deferred
from datetime import datetime
try:
    from .database import Base
except ImportError:  # pragma: no cover
    from database import Base

class Warehouse(Base):
    __tablename__ = "warehouses"
    __table_args__ = (
        UniqueConstraint("code", name="uq_warehouse_code"),
    )

    id = Column(Integer, primary_key=True, index=True)
    code = Column(String, nullable=False, index=True)
    name = Column(String, nullable=False)
    address = Column(String, nullable=True)
    latitude = Column(Float, nullable=True)
    longitude = Column(Float, nullable=True)
    active = Column(Boolean, default=True)
    created_at = Column(DateTime, default=datetime.utcnow, index=True)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, index=True)


class Store(Base):
    __tablename__ = "stores"
    __table_args__ = (
        UniqueConstraint("code", name="uq_store_code"),
    )

    id = Column(Integer, primary_key=True, index=True)
    code = Column(String, nullable=False, index=True)
    name = Column(String, nullable=False, index=True)
    warehouse_id = Column(Integer, ForeignKey("warehouses.id"), nullable=True, index=True)
    address = Column(String, nullable=True)
    latitude = Column(Float, nullable=True)
    longitude = Column(Float, nullable=True)
    active = Column(Boolean, default=True)
    created_at = Column(DateTime, default=datetime.utcnow, index=True)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, index=True)


class CarrierPartner(Base):
    __tablename__ = "carrier_partners"
    __table_args__ = (
        UniqueConstraint("code", name="uq_carrier_partner_code"),
    )

    id = Column(Integer, primary_key=True, index=True)
    code = Column(String, nullable=False, index=True)
    name = Column(String, nullable=False, index=True)
    integration_mode = Column(String, nullable=True)  # e.g. postis_allocated, arynik_direct, partner_api
    base_fee = Column(Float, nullable=False, default=0.0)
    cost_per_km = Column(Float, nullable=False, default=0.0)
    cost_per_kg = Column(Float, nullable=False, default=0.0)
    cod_fee_percent = Column(Float, nullable=False, default=0.0)
    avg_speed_kmph = Column(Float, nullable=False, default=45.0)
    base_eta_hours = Column(Float, nullable=False, default=12.0)
    service_radius_km = Column(Float, nullable=True)
    priority_bonus = Column(Float, nullable=False, default=0.0)
    active = Column(Boolean, default=True)
    notes = Column(String, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow, index=True)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, index=True)


class Driver(Base):
    __tablename__ = "drivers"

    id = Column(Integer, primary_key=True, index=True)
    driver_id = Column(String, unique=True, index=True)
    name = Column(String)
    username = Column(String, unique=True, index=True)
    password_hash = Column(String)
    role = Column(String)
    active = Column(Boolean, default=True)
    last_login = Column(DateTime, nullable=True)

    truck_plate = Column(String, nullable=True)
    phone_number = Column(String, nullable=True)
    phone_norm = Column(String, nullable=True)
    helper_name = Column(String, nullable=True)
    vehicle_type_code = Column(String, nullable=True)
    vehicle_has_lift = Column(Boolean, nullable=True)
    max_volume_m3 = Column(Float, nullable=True)
    target_volume_m3 = Column(Float, nullable=True)
    max_weight_kg = Column(Float, nullable=True)
    target_weight_kg = Column(Float, nullable=True)
    warehouse_id = Column(Integer, ForeignKey("warehouses.id"), nullable=True, index=True)
    store_id = Column(Integer, ForeignKey("stores.id"), nullable=True, index=True)

class Shipment(Base):
    __tablename__ = 'shipments'
    
    id = Column(Integer, primary_key=True, index=True)
    awb = Column(String, unique=True, index=True)
    status = Column(String)
    recipient_name = Column(String)
    recipient_phone = Column(String, nullable=True)
    recipient_phone_norm = Column(String, nullable=True)
    recipient_email = Column(String, nullable=True)
    delivery_address = Column(String)
    locality = Column(String) # For grouping/routing
    latitude = Column(Float, nullable=True) 
    longitude = Column(Float, nullable=True)
    # Persistent geocoding metadata (used by background sync).
    geocode_key = Column(String, nullable=True, index=True)
    geocode_query = Column(String, nullable=True)
    geocoded_at = Column(DateTime, nullable=True)
    geocode_source = Column(String, nullable=True)
    weight = Column(Float)
    volumetric_weight = Column(Float, nullable=True)
    dimensions = Column(String, nullable=True) # e.g. "10x20x30"
    content_description = Column(String, nullable=True)
    cod_amount = Column(Float, default=0.0)
    # Pricing/cost details (from Postis, when available).
    # NOTE: These columns may not exist in older DBs; migrations are handled at runtime.
    shipping_cost = Column(Float, nullable=True)
    estimated_shipping_cost = Column(Float, nullable=True)
    currency = Column(String, nullable=True)
    # Read-only instructions synced from Postis payload.
    delivery_instructions = Column(String, nullable=True)
    # Recipient-provided extra instructions (kept separate from Postis instructions).
    recipient_instructions = Column(String, nullable=True)
    driver_id = Column(String, ForeignKey("drivers.driver_id"), nullable=True) # Explicitly store driver assignment
    last_updated = Column(DateTime, default=datetime.utcnow)

    # [NEW] Extended Postis Data Fields
    shipment_reference = Column(String, nullable=True)
    client_order_id = Column(String, nullable=True)
    postis_order_id = Column(String, nullable=True)
    
    # JSON Data (Store full objects for flexibility)
    client_data = Column(JSON, nullable=True)
    courier_data = Column(JSON, nullable=True)
    sender_location = Column(JSON, nullable=True)
    recipient_location = Column(JSON, nullable=True)
    # Recipient-provided delivery pin (set from in-app chat/location picker).
    # Kept separate from Postis recipient_location so refresh/upserts don't wipe it.
    recipient_pin = Column(JSON, nullable=True)
    product_category_data = Column(JSON, nullable=True)
    client_shipment_status_data = Column(JSON, nullable=True)
    additional_services = Column(JSON, nullable=True)

    # Store the full Postis payload (v1 by-AWB). Deferred to avoid bloating list queries.
    # NOTE: In older DBs this column may not exist yet; keep it deferred so reads still work
    # until migrations/scripts add it.
    raw_data = deferred(Column(JSON, nullable=True))
    
    # Dates and Flags
    created_date = Column(DateTime, nullable=True)
    awb_status_date = Column(DateTime, nullable=True)
    
    local_awb_shipment = Column(Boolean, default=False)
    local_shipment = Column(Boolean, default=False)
    shipment_label_available = Column(Boolean, default=False)
    has_borderou = Column(Boolean, default=False)
    pallet_package = Column(Boolean, default=False)
    warehouse_id = Column(Integer, ForeignKey("warehouses.id"), nullable=True, index=True)
    store_id = Column(Integer, ForeignKey("stores.id"), nullable=True, index=True)
    return_confirmed_at = Column(DateTime, nullable=True)
    return_confirmed_by = Column(String, ForeignKey("drivers.driver_id"), nullable=True)
    
    source_channel = Column(String, nullable=True)
    send_type = Column(String, nullable=True)
    sender_shop_name = Column(String, nullable=True)
    processing_status = Column(String, nullable=True)
    
    number_of_parcels = Column(Integer, default=1)
    declared_value = Column(Float, default=0.0)
    
    # Relationship to events
    events = relationship("ShipmentEvent", back_populates="shipment", cascade="all, delete-orphan")

class ShipmentEvent(Base):
    __tablename__ = 'shipment_events'
    
    id = Column(Integer, primary_key=True, index=True)
    shipment_id = Column(Integer, ForeignKey('shipments.id'))
    event_description = Column(String)
    event_date = Column(DateTime)
    locality_name = Column(String)
    
    shipment = relationship("Shipment", back_populates="events")

class DriverLocation(Base): # [NEW] Track driver history
    __tablename__ = 'driver_locations'
    
    id = Column(Integer, primary_key=True, index=True)
    driver_id = Column(String, index=True)
    latitude = Column(Float)
    longitude = Column(Float)
    timestamp = Column(DateTime, default=datetime.utcnow)

class ActivityLog(Base):
    __tablename__ = 'activity_logs'

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(String, ForeignKey("drivers.driver_id"), index=True)
    timestamp = Column(DateTime, default=datetime.utcnow, index=True)
    
    action_type = Column(String)  # VIEW | MODIFY
    path = Column(String)         # The URL or route
    method = Column(String, nullable=True) # GET, POST, etc
    details = Column(String, nullable=True) 
    payload = Column(JSON, nullable=True)   

    latitude = Column(Float, nullable=True)
    longitude = Column(Float, nullable=True)

class LogEntry(Base):
    __tablename__ = "log_entries"

    id = Column(Integer, primary_key=True, index=True)
    driver_id = Column(String, ForeignKey("drivers.driver_id"))
    timestamp = Column(DateTime, default=datetime.utcnow)
    awb = Column(String, index=True)
    event_id = Column(String)
    outcome = Column(String) # SUCCESS, FAILED
    error_message = Column(String, nullable=True)
    postis_reference = Column(String, nullable=True)
    payload = Column(JSON, nullable=True)
    idempotency_key = Column(String, unique=True, index=True)

class StatusOption(Base):
    __tablename__ = "status_options"

    id = Column(Integer, primary_key=True, index=True)
    event_id = Column(String, unique=True)
    label = Column(String)
    description = Column(String)
    requirements = Column(JSON, nullable=True) # e.g., ["photo", "signature"]

class Todo(Base):
    __tablename__ = "todos"

    id = Column(Integer, primary_key=True, index=True)
    task = Column(String)
    status = Column(String, default='Not Started') # 'Not Started', 'In Progress', 'Completed'
    user_id = Column(String, ForeignKey("drivers.driver_id")) # Linked to Driver
    inserted_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)


class Notification(Base):
    __tablename__ = "notifications"

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(String, ForeignKey("drivers.driver_id"), index=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    read_at = Column(DateTime, nullable=True)

    title = Column(String)
    body = Column(String)

    awb = Column(String, nullable=True, index=True)
    data = Column(JSON, nullable=True)


class TrackingRequest(Base):
    """
    A time-bounded request to share a driver's live location.

    The location history itself is stored in `driver_locations`. This table tracks
    who requested sharing, who is being tracked, and the request lifecycle.
    """

    __tablename__ = "tracking_requests"

    id = Column(Integer, primary_key=True, index=True)
    created_at = Column(DateTime, default=datetime.utcnow)

    created_by_user_id = Column(String, index=True)
    created_by_role = Column(String, nullable=True)

    target_driver_id = Column(String, index=True)
    awb = Column(String, nullable=True, index=True)

    status = Column(String, default="Pending")  # Pending, Accepted, Denied, Stopped
    duration_sec = Column(Integer, default=900)

    expires_at = Column(DateTime, nullable=True)
    accepted_at = Column(DateTime, nullable=True)
    denied_at = Column(DateTime, nullable=True)
    stopped_at = Column(DateTime, nullable=True)

    last_location_at = Column(DateTime, nullable=True)


class ChatThread(Base):
    """
    In-app chat thread.

    Today we create one thread per AWB (shipment conversation), but AWB is nullable
    to allow future direct/group chats.
    """

    __tablename__ = "chat_threads"

    id = Column(Integer, primary_key=True, index=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    created_by_user_id = Column(String, nullable=True, index=True)
    created_by_role = Column(String, nullable=True)

    # Shipment-linked thread.
    awb = Column(String, unique=True, nullable=True, index=True)
    subject = Column(String, nullable=True)

    last_message_at = Column(DateTime, nullable=True, index=True)


class ChatParticipant(Base):
    __tablename__ = "chat_participants"
    __table_args__ = (
        UniqueConstraint("thread_id", "user_id", name="uq_chat_participant_thread_user"),
    )

    id = Column(Integer, primary_key=True, index=True)
    thread_id = Column(Integer, ForeignKey("chat_threads.id"), index=True)
    user_id = Column(String, ForeignKey("drivers.driver_id"), index=True)
    role = Column(String, nullable=True)
    joined_at = Column(DateTime, default=datetime.utcnow)

    # Highest chat_messages.id the user has read in this thread.
    last_read_message_id = Column(Integer, nullable=True)


class ChatMessage(Base):
    __tablename__ = "chat_messages"

    id = Column(Integer, primary_key=True, index=True)
    thread_id = Column(Integer, ForeignKey("chat_threads.id"), index=True)
    created_at = Column(DateTime, default=datetime.utcnow, index=True)

    sender_user_id = Column(String, ForeignKey("drivers.driver_id"), index=True)
    sender_role = Column(String, nullable=True)

    # text | location | system
    message_type = Column(String, default="text")
    text = Column(String, nullable=True)
    data = Column(JSON, nullable=True)


class ContactAttempt(Base):
    """
    Lightweight logging for contact attempts/outcomes (call/WhatsApp/SMS).

    This helps dispatch/support understand why deliveries failed without
    relying on free-form chat messages.
    """

    __tablename__ = "contact_attempts"

    id = Column(Integer, primary_key=True, index=True)
    created_at = Column(DateTime, default=datetime.utcnow, index=True)

    created_by_user_id = Column(String, ForeignKey("drivers.driver_id"), index=True)
    created_by_role = Column(String, nullable=True)

    awb = Column(String, nullable=True, index=True)
    channel = Column(String)  # call | whatsapp | sms
    to_phone = Column(String, nullable=True)

    outcome = Column(String, nullable=True)  # initiated | answered | no_answer | wrong_number | rescheduled | other
    notes = Column(String, nullable=True)
    data = Column(JSON, nullable=True)


class Manifest(Base):
    """
    Warehouse load-out / return scan manifest.

    The main goal is to detect missing/extra parcels *before* leaving or after return.
    """

    __tablename__ = "manifests"

    id = Column(Integer, primary_key=True, index=True)
    created_at = Column(DateTime, default=datetime.utcnow, index=True)

    created_by_user_id = Column(String, ForeignKey("drivers.driver_id"), index=True)
    created_by_role = Column(String, nullable=True)

    truck_plate = Column(String, nullable=True, index=True)
    date = Column(String, nullable=True, index=True)  # YYYY-MM-DD (local ops date)
    kind = Column(String, default="loadout")  # loadout | return
    status = Column(String, default="Open")  # Open | Closed
    notes = Column(String, nullable=True)

    items = relationship("ManifestItem", back_populates="manifest", cascade="all, delete-orphan")


class ManifestItem(Base):
    __tablename__ = "manifest_items"
    __table_args__ = (
        UniqueConstraint("manifest_id", "awb", name="uq_manifest_item_manifest_awb"),
    )

    id = Column(Integer, primary_key=True, index=True)
    manifest_id = Column(Integer, ForeignKey("manifests.id"), index=True)

    awb = Column(String, index=True)
    parcels_total = Column(Integer, nullable=True)

    # We keep both the raw scanned identifiers (can include parcel suffixes)
    # and the parsed parcel indexes so we can do multi-parcel completeness checks.
    scanned_identifiers = Column(JSON, nullable=True)  # list[str]
    scanned_parcel_indexes = Column(JSON, nullable=True)  # list[int]
    scan_count = Column(Integer, default=0)
    last_scanned_at = Column(DateTime, nullable=True)
    last_scanned_by = Column(String, nullable=True)
    data = Column(JSON, nullable=True)

    manifest = relationship("Manifest", back_populates="items")


class ManifestScanCache(Base):
    """
    Cache scanned manifest identifiers -> resolved core AWB.

    Helps with scanners that emit parcel-level suffixes (e.g. ...001 or ...654001).
    """

    __tablename__ = "manifest_scan_cache"
    __table_args__ = (
        UniqueConstraint("normalized_identifier", name="uq_manifest_scan_cache_norm"),
    )

    id = Column(Integer, primary_key=True, index=True)
    created_at = Column(DateTime, default=datetime.utcnow, index=True)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, index=True)

    manifest_id = Column(Integer, ForeignKey("manifests.id"), nullable=True, index=True)
    scanned_identifier = Column(String, nullable=False, index=True)
    normalized_identifier = Column(String, nullable=False, index=True)
    resolved_awb = Column(String, nullable=True, index=True)
    resolution_source = Column(String, nullable=True)  # cache_hit | exact | suffix3 | suffix6 | fallback
    data = Column(JSON, nullable=True)


class RouteRun(Base):
    """
    Backend representation of a route in execution (progress tracking).

    Note: routes are stored locally on the device today (routesStore.js). The app
    posts a snapshot of the route when starting a run so dispatch can see progress.
    """

    __tablename__ = "route_runs"

    id = Column(Integer, primary_key=True, index=True)
    created_at = Column(DateTime, default=datetime.utcnow, index=True)
    started_at = Column(DateTime, nullable=True, index=True)
    ended_at = Column(DateTime, nullable=True, index=True)

    status = Column(String, default="Active")  # Active | Finished | Cancelled

    route_id = Column(String, nullable=True, index=True)
    route_name = Column(String, nullable=True)

    driver_id = Column(String, ForeignKey("drivers.driver_id"), index=True)
    truck_plate = Column(String, nullable=True, index=True)
    helper_name = Column(String, nullable=True)

    data = Column(JSON, nullable=True)

    stops = relationship("RouteRunStop", back_populates="run", cascade="all, delete-orphan")


class RouteRunStop(Base):
    __tablename__ = "route_run_stops"
    __table_args__ = (
        UniqueConstraint("run_id", "awb", name="uq_route_run_stop_run_awb"),
    )

    id = Column(Integer, primary_key=True, index=True)
    run_id = Column(Integer, ForeignKey("route_runs.id"), index=True)
    awb = Column(String, index=True)
    seq = Column(Integer, nullable=True)

    state = Column(String, default="Pending")  # Pending | OnTheWay | Arrived | Done | Skipped
    arrived_at = Column(DateTime, nullable=True)
    completed_at = Column(DateTime, nullable=True)
    completion_event_id = Column(String, nullable=True)

    last_latitude = Column(Float, nullable=True)
    last_longitude = Column(Float, nullable=True)

    notes = Column(String, nullable=True)
    data = Column(JSON, nullable=True)

    run = relationship("RouteRun", back_populates="stops")


class RoutePlan(Base):
    """
    Daily backend route planning snapshot.

    Workflow:
    - Draft: generated automatically/manually based on eligible shipments.
    - Approved: dispatcher/admin approved the route proposal.
    - Assigned: route was assigned to a concrete truck/driver.
    """

    __tablename__ = "route_plans"
    __table_args__ = (
        UniqueConstraint("plan_date", "county", "route_index", name="uq_route_plans_date_county_idx"),
    )

    id = Column(Integer, primary_key=True, index=True)
    created_at = Column(DateTime, default=datetime.utcnow, index=True)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, index=True)

    plan_date = Column(String, index=True)  # YYYY-MM-DD (ops local date)
    county = Column(String, nullable=True, index=True)
    route_index = Column(Integer, default=1, index=True)
    name = Column(String, nullable=True)
    status = Column(String, default="Draft", index=True)  # Draft | Approved | Assigned

    generated_at = Column(DateTime, nullable=True, index=True)
    generated_by_user_id = Column(String, nullable=True, index=True)
    generated_trigger = Column(String, nullable=True)

    approved_at = Column(DateTime, nullable=True, index=True)
    approved_by_user_id = Column(String, nullable=True, index=True)

    assigned_at = Column(DateTime, nullable=True, index=True)
    assigned_by_user_id = Column(String, nullable=True, index=True)
    assigned_vehicle_plate = Column(String, nullable=True, index=True)
    assigned_driver_id = Column(String, ForeignKey("drivers.driver_id"), nullable=True, index=True)
    assigned_driver_name = Column(String, nullable=True)
    assigned_helper_name = Column(String, nullable=True)
    assigned_phone = Column(String, nullable=True)

    vehicle_type_code = Column(String, nullable=True)
    vehicle_has_lift = Column(Boolean, nullable=True)
    max_volume_m3 = Column(Float, nullable=True)
    target_volume_m3 = Column(Float, nullable=True)
    max_weight_kg = Column(Float, nullable=True)
    target_weight_kg = Column(Float, nullable=True)

    awb_count = Column(Integer, default=0)
    awbs = Column(JSON, nullable=True)  # list[str]
    over_capacity_awbs = Column(JSON, nullable=True)  # list[str]
    issues = Column(JSON, nullable=True)

    load_volume_m3 = Column(Float, nullable=True)
    load_weight_kg = Column(Float, nullable=True)
    utilization_volume_pct = Column(Float, nullable=True)
    utilization_weight_pct = Column(Float, nullable=True)

    data = Column(JSON, nullable=True)


class RouteAviz(Base):
    """
    Transport document (Aviz de insotire a marfii) issued for an assigned route plan.
    """

    __tablename__ = "route_avize"

    id = Column(Integer, primary_key=True, index=True)
    created_at = Column(DateTime, default=datetime.utcnow, index=True)
    created_by_user_id = Column(String, ForeignKey("drivers.driver_id"), nullable=True, index=True)

    route_plan_id = Column(Integer, ForeignKey("route_plans.id"), index=True)
    aviz_number = Column(String, unique=True, index=True)

    plan_date = Column(String, nullable=True, index=True)
    route_name = Column(String, nullable=True)
    county = Column(String, nullable=True)

    vehicle_plate = Column(String, nullable=True, index=True)
    driver_id = Column(String, nullable=True, index=True)
    driver_name = Column(String, nullable=True)
    helper_name = Column(String, nullable=True)

    awb_count = Column(Integer, default=0)
    total_weight_kg = Column(Float, nullable=True)
    total_volume_m3 = Column(Float, nullable=True)
    data = Column(JSON, nullable=True)


class AdminNote(Base):
    """
    Product/backlog notes created from the admin home screen.
    """

    __tablename__ = "admin_notes"

    id = Column(Integer, primary_key=True, index=True)
    created_at = Column(DateTime, default=datetime.utcnow, index=True)

    created_by_user_id = Column(String, ForeignKey("drivers.driver_id"), index=True)
    created_by_name = Column(String, nullable=True)

    text = Column(String, nullable=False)
    status = Column(String, default="In Progress", nullable=False, index=True)


class FleetVehicle(Base):
    __tablename__ = "fleet_vehicles"

    id = Column(Integer, primary_key=True, index=True)
    created_at = Column(DateTime, default=datetime.utcnow, index=True)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, index=True)

    plate = Column(String, unique=True, index=True, nullable=True)
    label = Column(String, nullable=True)
    active = Column(Boolean, default=True)

    assigned_driver_id = Column(String, ForeignKey("drivers.driver_id"), nullable=True, index=True)
    assigned_driver_name = Column(String, nullable=True)
    assigned_phone = Column(String, nullable=True)
    helper_name = Column(String, nullable=True)

    vehicle_type_code = Column(String, nullable=True)
    vehicle_has_lift = Column(Boolean, nullable=True)
    max_volume_m3 = Column(Float, nullable=True)
    target_volume_m3 = Column(Float, nullable=True)
    max_weight_kg = Column(Float, nullable=True)
    target_weight_kg = Column(Float, nullable=True)

    odometer_km = Column(Float, nullable=True)
    purchase_date = Column(DateTime, nullable=True)
    notes = Column(String, nullable=True)
    admin_data = Column(JSON, nullable=True)

    documents = relationship("FleetDocument", back_populates="vehicle", cascade="all, delete-orphan")
    services = relationship("FleetServiceRecord", back_populates="vehicle", cascade="all, delete-orphan")
    insurances = relationship("FleetInsurancePolicy", back_populates="vehicle", cascade="all, delete-orphan")


class FleetVehicleAssignment(Base):
    __tablename__ = "fleet_vehicle_assignments"

    id = Column(Integer, primary_key=True, index=True)
    created_at = Column(DateTime, default=datetime.utcnow, index=True)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, index=True)

    driver_id = Column(String, ForeignKey("drivers.driver_id"), nullable=False, index=True)
    vehicle_id = Column(Integer, ForeignKey("fleet_vehicles.id"), nullable=False, index=True)
    vehicle_plate = Column(String, nullable=True, index=True)
    phone_id = Column(Integer, ForeignKey("fleet_phone_numbers.id"), nullable=True, index=True)
    phone_label = Column(String, nullable=True, index=True)

    active = Column(Boolean, default=True, index=True)
    assigned_at = Column(DateTime, default=datetime.utcnow, index=True)
    unassigned_at = Column(DateTime, nullable=True, index=True)
    assigned_by_user_id = Column(String, ForeignKey("drivers.driver_id"), nullable=True, index=True)
    source = Column(String, nullable=True)
    notes = Column(String, nullable=True)

    last_latitude = Column(Float, nullable=True)
    last_longitude = Column(Float, nullable=True)
    last_location_at = Column(DateTime, nullable=True)
    km_total = Column(Float, nullable=True)


class FleetPhoneNumber(Base):
    __tablename__ = "fleet_phone_numbers"
    __table_args__ = (
        UniqueConstraint("phone_norm", name="uq_fleet_phone_norm"),
    )

    id = Column(Integer, primary_key=True, index=True)
    created_at = Column(DateTime, default=datetime.utcnow, index=True)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, index=True)

    phone_number = Column(String, nullable=False, index=True)
    phone_norm = Column(String, nullable=False, index=True)
    label = Column(String, nullable=True, index=True)
    active = Column(Boolean, default=True, index=True)
    notes = Column(String, nullable=True)

    assigned_driver_id = Column(String, ForeignKey("drivers.driver_id"), nullable=True, index=True)
    assigned_vehicle_id = Column(Integer, ForeignKey("fleet_vehicles.id"), nullable=True, index=True)
    last_seen_at = Column(DateTime, nullable=True, index=True)


class FleetDocument(Base):
    __tablename__ = "fleet_documents"

    id = Column(Integer, primary_key=True, index=True)
    vehicle_id = Column(Integer, ForeignKey("fleet_vehicles.id"), index=True)
    created_at = Column(DateTime, default=datetime.utcnow, index=True)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, index=True)

    category = Column(String, nullable=True)  # itp | rovinieta | talon | license | custom
    title = Column(String, nullable=False)
    issuer = Column(String, nullable=True)
    status = Column(String, default="Valid")  # Valid | ExpiringSoon | Expired | Missing
    issue_date = Column(DateTime, nullable=True)
    expiry_date = Column(DateTime, nullable=True, index=True)

    reminder_days_before = Column(Integer, default=30)
    remind_at = Column(DateTime, nullable=True, index=True)
    last_reminder_at = Column(DateTime, nullable=True)

    file_url = Column(String, nullable=True)
    notes = Column(String, nullable=True)
    data = Column(JSON, nullable=True)

    vehicle = relationship("FleetVehicle", back_populates="documents")


class FleetServiceRecord(Base):
    __tablename__ = "fleet_services"

    id = Column(Integer, primary_key=True, index=True)
    vehicle_id = Column(Integer, ForeignKey("fleet_vehicles.id"), index=True)
    created_at = Column(DateTime, default=datetime.utcnow, index=True)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, index=True)

    service_type = Column(String, nullable=True)  # revision | oil | tires | brakes | repairs | custom
    title = Column(String, nullable=False)
    provider = Column(String, nullable=True)
    status = Column(String, default="Planned")  # Planned | DueSoon | Overdue | Done

    performed_at = Column(DateTime, nullable=True)
    due_date = Column(DateTime, nullable=True, index=True)
    odometer_km = Column(Float, nullable=True)
    due_km = Column(Float, nullable=True, index=True)
    next_due_km = Column(Float, nullable=True)

    estimated_cost = Column(Float, nullable=True)
    actual_cost = Column(Float, nullable=True)
    currency = Column(String, nullable=True)

    reminder_days_before = Column(Integer, default=14)
    remind_at = Column(DateTime, nullable=True, index=True)
    last_reminder_at = Column(DateTime, nullable=True)

    notes = Column(String, nullable=True)
    data = Column(JSON, nullable=True)

    vehicle = relationship("FleetVehicle", back_populates="services")


class FleetInsurancePolicy(Base):
    __tablename__ = "fleet_insurances"

    id = Column(Integer, primary_key=True, index=True)
    vehicle_id = Column(Integer, ForeignKey("fleet_vehicles.id"), index=True)
    created_at = Column(DateTime, default=datetime.utcnow, index=True)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, index=True)

    insurance_type = Column(String, nullable=True)  # rca | casco | cargo | custom
    provider = Column(String, nullable=True)
    policy_number = Column(String, nullable=True, index=True)
    status = Column(String, default="Active")  # Active | ExpiringSoon | Expired | Cancelled

    start_date = Column(DateTime, nullable=True)
    expiry_date = Column(DateTime, nullable=True, index=True)
    premium_amount = Column(Float, nullable=True)
    currency = Column(String, nullable=True)
    deductible = Column(Float, nullable=True)

    reminder_days_before = Column(Integer, default=30)
    remind_at = Column(DateTime, nullable=True, index=True)
    last_reminder_at = Column(DateTime, nullable=True)

    notes = Column(String, nullable=True)
    data = Column(JSON, nullable=True)

    vehicle = relationship("FleetVehicle", back_populates="insurances")


class MapsProviderConfig(Base):
    """
    Maps API/Billing configuration managed by an admin.

    One row per owner_user_id (typically warehouse/company admin account).
    """

    __tablename__ = "maps_provider_configs"
    __table_args__ = (
        UniqueConstraint("owner_user_id", name="uq_maps_provider_owner"),
    )

    id = Column(Integer, primary_key=True, index=True)
    owner_user_id = Column(String, ForeignKey("drivers.driver_id"), index=True)

    created_at = Column(DateTime, default=datetime.utcnow, index=True)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, index=True)

    # own | platform
    maps_mode = Column(String, default="platform", nullable=False)
    own_maps_api_key = Column(String, nullable=True)

    # Internal billing counters for platform-key usage.
    platform_credit_balance = Column(Float, default=0.0, nullable=False)
    platform_usage_requests = Column(Integer, default=0, nullable=False)
    platform_usage_cost = Column(Float, default=0.0, nullable=False)
    last_platform_usage_at = Column(DateTime, nullable=True)


class MapsProviderUsage(Base):
    __tablename__ = "maps_provider_usage"

    id = Column(Integer, primary_key=True, index=True)
    owner_user_id = Column(String, index=True)
    created_at = Column(DateTime, default=datetime.utcnow, index=True)

    provider = Column(String, nullable=False)   # google_maps
    mode = Column(String, nullable=False)       # own | platform
    action = Column(String, nullable=False)     # geocode | geocode_shipments | route_metrics | route_optimize
    requests_count = Column(Integer, default=1, nullable=False)
    estimated_cost = Column(Float, default=0.0, nullable=False)
    meta = Column(JSON, nullable=True)
