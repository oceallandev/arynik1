import os
from fastapi.testclient import TestClient
from main import app
from database import SessionLocal
import models
import authz
from driver_manager import get_password_hash

client = TestClient(app)

def test_delete_user():
    db = SessionLocal()
    
    # 1. Create a fake admin token or override dependency?
    # Better: just mock the db or manually hit the function.
    # No, we can just login as an admin? Who is admin?
    
    # Let's find an active admin.
    admin = db.query(models.Driver).filter(models.Driver.role == "Admin").first()
    if not admin:
        print("No admin found.")
        return
        
    print(f"Testing the fallback logic directly...")
    
    # Find a user to delete
    target = db.query(models.Driver).filter(models.Driver.username == "testlivrare").first()
    if not target:
        print("testlivrare not found.")
        return
        
    target_id = target.driver_id
    print(f"Trying to delete {target_id}")
    
    # What does delete_user actually do?
    from main import delete_user
    import asyncio
    
    try:
        response = asyncio.run(delete_user(
            driver_id=target_id,
            db=db,
            current_driver=admin
        ))
        print("Response:", response)
    except Exception as e:
        print("Error during delete:", type(e), e)
        
if __name__ == "__main__":
    test_delete_user()
