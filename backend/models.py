from sqlalchemy import Column, Integer, String, Float, Boolean, ForeignKey, DateTime, Enum, JSON, UniqueConstraint
from sqlalchemy.orm import relationship, deferred
from datetime import datetime
try:
    from .database import Base
except ImportError:  # pragma: no cover
    from database import Base

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
    delivery_instructions = Column(String, nullable=True)
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
