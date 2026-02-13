from sqlalchemy.orm import Session
from backend.database import SessionLocal, engine
from backend.models import Base, Driver, StatusOption
import hashlib

def get_password_hash(password: str):
    return hashlib.sha256(password.encode()).hexdigest()

def seed():
    Base.metadata.create_all(bind=engine)
    db = SessionLocal()
    
    # Add a test driver
    if not db.query(Driver).filter(Driver.username == "admin").first():
        admin = Driver(
            driver_id="D001",
            name="Test Admin",
            username="admin",
            password_hash=get_password_hash("admin"),
            role="Admin",
            active=True
        )
        db.add(admin)
        print("Driver added")
    
    # Status options are seeded in main.py startup, but let's be sure
    db.commit()
    db.close()

if __name__ == "__main__":
    seed()
