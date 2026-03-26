import sys
import os
sys.path.insert(0, os.path.abspath("backend"))

from database import SessionLocal
import models
from sqlalchemy import text

db = SessionLocal()
target_id = "SOME_EXISTING_DRIVER_ID"

# let's just create a dummy driver to delete
dummy = models.Driver(driver_id="DUMMY999", name="Dummy", username="dummy999", password_hash="x", role="Driver")
db.add(dummy)
db.commit()

try:
    # Try the exact block from main.py
    # Set route runs driver_id to null
    db.execute(text("UPDATE route_runs SET driver_id = NULL WHERE driver_id = :d"), {"d": "DUMMY999"})
    db.commit()
    print("Success")
except Exception as e:
    import traceback
    traceback.print_exc()

