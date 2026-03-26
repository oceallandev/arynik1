import sys
import os
sys.path.append(os.path.join(os.path.dirname(__file__), "backend"))

from database import SessionLocal
from main import get_activity_logs, get_all_users
from models import Driver
from schemas import ActivityLogSchema
from authz import ROLE_ADMIN

import asyncio

async def test_all():
    db = SessionLocal()
    try:
        current_driver = Driver(role=ROLE_ADMIN, name="Test Admin")
        print("\n--- Testing Activity Logs ---")
        try:
            logs = await get_activity_logs(limit=10, db=db, current_driver=current_driver)
            print("Activity logs success! Count:", len(logs))
        except Exception as e:
            import traceback
            traceback.print_exc()

        print("\n--- Testing Users List (Should trigger same error if it exists) ---")
        try:
            # list_users doesn't take limit
            from main import list_users
            users = await list_users(db=db, current_driver=current_driver)
            print("Users success! Count:", len(users))
        except Exception as e:
            import traceback
            traceback.print_exc()
        
    finally:
        db.close()

asyncio.run(test_all())
