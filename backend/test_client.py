import sys
import os
from fastapi.testclient import TestClient
from main import app
from database import SessionLocal
import models
import authz

client = TestClient(app)

def override_auth(current_user=None):
    db = SessionLocal()
    driver = db.query(models.Driver).filter(models.Driver.role == "Admin").first()
    db.close()
    return driver

app.dependency_overrides[authz.get_current_admin_user] = override_auth

def run():
    db = SessionLocal()
    target = db.query(models.Driver).filter(models.Driver.role != "Admin").first()
    if not target:
        print("No non-admin driver found")
        return
    
    print(f"Testing deletion of {target.driver_id}")
    try:
        # We need to pass the same user token, but since we override get_current_admin_user, it should work.
        # But wait! delete_user depends on permission_required(authz.PERM_USERS_WRITE).
        # We must override that generator or just call the function directly!
        pass
    except Exception as e:
        pass

    # Let's just call the function directly
    from main import delete_user
    import asyncio
    
    async def try_delete():
        # Get DB session
        db_dev = SessionLocal()
        try:
            admin = db.query(models.Driver).filter(models.Driver.role == "Admin").first()
            res = await delete_user(driver_id=target.driver_id, db=db_dev, current_driver=admin)
            print("Response:", res)
        except Exception as e:
            print("EXCEPTION:")
            import traceback
            traceback.print_exc()
        finally:
            db_dev.close()
            
    asyncio.run(try_delete())

if __name__ == "__main__":
    run()
