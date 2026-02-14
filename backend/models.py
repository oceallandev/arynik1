from sqlalchemy import Column, Integer, String, Float, Boolean, ForeignKey, DateTime, Enum, JSON
from sqlalchemy.orm import relationship
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
    helper_name = Column(String, nullable=True)

class Shipment(Base):
    __tablename__ = 'shipments'
    
    id = Column(Integer, primary_key=True, index=True)
    awb = Column(String, unique=True, index=True)
    status = Column(String)
    recipient_name = Column(String)
    recipient_phone = Column(String, nullable=True)
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
    product_category_data = Column(JSON, nullable=True)
    client_shipment_status_data = Column(JSON, nullable=True)
    additional_services = Column(JSON, nullable=True)
    
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
