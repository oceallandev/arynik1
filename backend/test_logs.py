import sys
import os
sys.path.append(os.getcwd())
from backend.database import SessionLocal
from backend import models

db = SessionLocal()
logs = db.query(models.LogEntry).limit(5).all()
for l in logs:
    print(l.awb, l.outcome, l.timestamp)
    print("Payload:", l.payload)
