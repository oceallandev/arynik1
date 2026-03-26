import sys
import os
import asyncio
sys.path.insert(0, os.path.abspath("backend"))

from database import SessionLocal
import models
from main import delete_user

async def main():
    db = SessionLocal()
    # Find any driver to simulate deletion
    driver = db.query(models.Driver).first()
    if not driver:
        print("No drivers found")
        return
        
    print(f"Testing deletion for {driver.driver_id}")
    try:
        res = await delete_user(driver_id=driver.driver_id, db=db, current_user="TEST", role="Admin")
        print("RESULT:")
        print(res)
    except Exception as e:
        print("ERROR:")
        import traceback
        traceback.print_exc()

if __name__ == "__main__":
    asyncio.run(main())
