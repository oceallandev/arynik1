from backend.database import SessionLocal
from backend.models import Driver

try:
    db = SessionLocal()
    drivers = db.query(Driver).all()
    print(f"Drivers found: {len(drivers)}")
    for d in drivers:
        print(f"- {d.username} (ID: {d.driver_id})")
    db.close()
except Exception as e:
    print(f"Error: {e}")
