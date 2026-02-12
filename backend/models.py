from sqlalchemy import Column, Integer, String, Boolean, DateTime, ForeignKey, JSON
from sqlalchemy.orm import relationship
from datetime import datetime
from .database import Base

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
