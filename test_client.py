import sys
import os
sys.path.insert(0, os.path.abspath("backend"))

from fastapi.testclient import TestClient
from main import app
from database import SessionLocal
import models
import authz

client = TestClient(app)

# Override the authz dependency to bypass login
def override_get_current_admin_user():
    db = SessionLocal()
    driver = db.query(models.Driver).filter(models.Driver.role == authz.ROLE_ADMIN).first()
    db.close()
    return driver

app.dependency_overrides[authz.get_current_admin_user] = override_get_current_admin_user

def run():
    db = SessionLocal()
    driver = db.query(models.Driver).filter(models.Driver.role != authz.ROLE_ADMIN).first()
    if not driver:
        print("No deletable driver found")
        return
    print(f"Attempting to delete {driver.driver_id} ({driver.username})")
    try:
        res = client.delete(f"/users/{driver.driver_id}")
        print("Status Code:", res.status_code)
        print("Response:", res.json())
    except Exception as e:
        print("EXCEPTION RAISED:")
        import traceback
        traceback.print_exc()

run()
