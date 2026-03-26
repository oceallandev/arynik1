import sys
import os

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "backend"))

from backend.database import SessionLocal
from backend.models import Driver
from backend.authz import ROLE_ADMIN

import asyncio

async def test_logs():
    db = SessionLocal()
    from backend.main import get_activity_logs, list_users
    try:
        try:
            current_driver = Driver(role=ROLE_ADMIN, name="Test Admin", driver_id="ADMIN")
            print("\n--- Testing Activity Logs ---")
            logs = await get_activity_logs(limit=10, db=db, current_driver=current_driver)
            print("Activity logs success! Count:", len(logs))
        except Exception as e:
            import traceback
            traceback.print_exc()

        try:
            print("\n--- Testing Users List ---")
            users = await list_users(db=db, current_driver=current_driver)
            print("Users success! Count:", len(users))
        except Exception as e:
            import traceback
            traceback.print_exc()
            
    finally:
        db.close()

asyncio.run(test_logs())
