import os
from pathlib import Path

from dotenv import load_dotenv
from sqlalchemy.orm import Session
import hashlib

# Ensure we seed the same DB config the API uses (backend/.env).
_env_path = Path(__file__).resolve().parent / "backend" / ".env"
if _env_path.exists():
    load_dotenv(dotenv_path=str(_env_path), override=True)

from backend.database import SessionLocal, engine
from backend.models import Base, Driver, StatusOption

def get_password_hash(password: str):
    return hashlib.sha256(password.encode()).hexdigest()

def seed():
    Base.metadata.create_all(bind=engine)
    db = SessionLocal()
    
    # Add a test driver
    admin = db.query(Driver).filter(Driver.username == "admin").first()
    if not admin:
        admin = Driver(
            driver_id="D001",
            name="Test Admin",
            username="admin",
            password_hash=get_password_hash("admin"),
            role="Admin",
            active=True,
        )
        db.add(admin)
        print("Admin driver added")
    else:
        # Keep dev environments predictable.
        admin.password_hash = get_password_hash("admin")
        admin.active = True
        admin.role = "Admin"
        print("Admin driver password updated")

    demo = db.query(Driver).filter(Driver.username == "demo").first()
    if not demo:
        demo = Driver(
            driver_id="D002",
            name="Demo Driver",
            username="demo",
            password_hash=get_password_hash("demo"),
            role="Driver",
            active=True
        )
        db.add(demo)
        print("Demo Driver added")
    else:
        demo.password_hash = get_password_hash("demo")
        print("Demo Driver password updated")
    
    # Status options are seeded in main.py startup, but let's be sure
    db.commit()
    db.close()

if __name__ == "__main__":
    seed()
